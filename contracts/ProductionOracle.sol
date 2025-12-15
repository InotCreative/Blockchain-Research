// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ProductionOracle
 * @dev Handles verifier claim submission and consensus finalization for energy production.
 * Verifiers submit signed claims for hourly production data, and the contract
 * aggregates submissions to reach consensus via quorum.
 */
contract ProductionOracle is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Structs ============

    struct ClaimBucket {
        uint256 deadline;
        uint256 snapshotId;
        uint32 submissionCount;
        bool finalized;
        bool disputed;
        uint64 verifiedEnergyWh;
        uint64 maxSubmittedEnergyWh;
        bytes32 winningValueHash;
        bytes32 evidenceRoot;
        uint16 allSubmittersBitmap;
        uint16 winningVerifierBitmap;
    }

    struct ValueSubmission {
        uint32 count;
        uint16 verifierBitmap;
        bytes32 evidenceRoot;
        uint64 energyWh;
    }

    // ============ State Variables ============

    /// @notice Registry contract for verifier and producer data
    IRegistry public registry;

    /// @notice HourlyCredits contract for minting HCN tokens
    IHourlyCredits public hourlyCredits;

    /// @notice Treasury contract for reward distribution and fault recording
    ITreasury public treasury;

    /// @notice Claim window duration in seconds
    uint256 public claimWindow;

    /// @notice Quorum threshold in basis points (e.g., 6667 = 66.67%)
    uint256 public quorumBps;

    /// @notice Baseline mode flag (single verifier can finalize immediately)
    bool public baselineMode;

    /// @notice Single verifier override address for baseline mode
    address public singleVerifierOverride;

    /// @notice Mapping of claimKey to ClaimBucket
    mapping(bytes32 => ClaimBucket) private _claimBuckets;

    /// @notice Mapping of claimKey => valueHash => ValueSubmission
    mapping(bytes32 => mapping(bytes32 => ValueSubmission)) private _valueSubmissions;

    /// @notice Mapping of claimKey => verifier => hasSubmitted
    mapping(bytes32 => mapping(address => bool)) private _hasSubmitted;

    /// @notice Mapping of claimKey => evidenceRoot => exists (for forceFinalize validation)
    mapping(bytes32 => mapping(bytes32 => bool)) private _submittedEvidenceRoots;

    /// @notice Array to track all valueHashes for a claimKey (for iteration)
    mapping(bytes32 => bytes32[]) private _claimValueHashes;

    // ============ Events ============

    /// @notice Emitted when a production claim is submitted
    event ProductionSubmitted(
        bytes32 indexed claimKey,
        address indexed verifier,
        uint64 energyWh,
        bytes32 valueHash
    );

    /// @notice Emitted when production is finalized
    event ProductionFinalized(
        bytes32 indexed claimKey,
        bytes32 indexed producerId,
        uint256 hourId,
        uint64 energyWh,
        bytes32 evidenceRoot
    );

    /// @notice Emitted when a claim enters disputed state
    event ClaimDisputed(
        bytes32 indexed claimKey,
        bytes32 indexed producerId,
        uint256 hourId,
        string reason
    );

    /// @notice Emitted when admin force-finalizes a disputed claim
    event ForceFinalized(
        bytes32 indexed claimKey,
        address indexed admin,
        uint64 energyWh
    );

    // ============ Errors ============

    error ZeroAddress();
    error ClaimAlreadyFinalized(bytes32 claimKey);
    error ClaimDeadlineNotReached(bytes32 claimKey, uint256 deadline);
    error ClaimDeadlinePassed(bytes32 claimKey);
    error DuplicateSubmission(bytes32 claimKey, address verifier);
    error InvalidSignature(address recovered, address expected);
    error ChainIdMismatch(uint256 expected, uint256 actual);
    error ContractAddressMismatch(address expected, address actual);
    error ProducerNotRegistered(bytes32 producerId);
    error VerifierNotActive(address verifier);
    error VerifierNotInSnapshot(address verifier, uint256 snapshotId);
    error ClaimNotDisputed(bytes32 claimKey);
    error EnergyExceedsMaxSubmitted(uint64 energyWh, uint64 maxSubmitted);
    error EvidenceRootNotSubmitted(bytes32 evidenceRoot);
    error QuorumNotReached(bytes32 claimKey, uint256 required, uint256 actual);

    // ============ Constructor ============

    /**
     * @dev Constructor sets the contract dependencies
     * @param _registry The Registry contract address
     * @param _hourlyCredits The HourlyCredits contract address
     * @param _treasury The Treasury contract address
     * @param initialOwner The address that will own the contract
     */
    constructor(
        address _registry,
        address _hourlyCredits,
        address _treasury,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_registry == address(0)) revert ZeroAddress();
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        registry = IRegistry(_registry);
        hourlyCredits = IHourlyCredits(_hourlyCredits);
        treasury = ITreasury(_treasury);

        // Initialize with Registry defaults
        claimWindow = registry.claimWindow();
        quorumBps = registry.quorumBps();
    }


    // ============ Claim Submission Functions ============

    /**
     * @notice Submit a production claim for verification
     * @dev Creates snapshot on first submission, validates signature, aggregates by valueHash
     * @param producerId The producer identifier
     * @param hourId The hour identifier (floor(unix_timestamp / 3600))
     * @param energyWh The energy production in Wh
     * @param evidenceRoot The evidence root hash
     * @param signature The verifier's signature over the claim data
     */
    function submitProduction(
        bytes32 producerId,
        uint256 hourId,
        uint64 energyWh,
        bytes32 evidenceRoot,
        bytes calldata signature
    ) external {
        // Derive claim key
        bytes32 claimKey = getClaimKey(producerId, hourId);
        ClaimBucket storage bucket = _claimBuckets[claimKey];

        // Check if already finalized
        if (bucket.finalized) {
            revert ClaimAlreadyFinalized(claimKey);
        }

        // Check producer is registered
        if (!_isProducerRegistered(producerId)) {
            revert ProducerNotRegistered(producerId);
        }

        // Validate signature and get verifier address
        address verifier = _validateSignature(producerId, hourId, energyWh, evidenceRoot, signature);

        // Check verifier is active
        if (!registry.getVerifier(verifier).active) {
            revert VerifierNotActive(verifier);
        }

        // First submission creates snapshot and sets deadline
        if (bucket.snapshotId == 0) {
            bucket.snapshotId = registry.createSnapshot(claimKey);
            bucket.deadline = block.timestamp + claimWindow;
        }

        // Check deadline hasn't passed
        if (block.timestamp > bucket.deadline) {
            // Record late submission fault
            treasury.recordFault(verifier, ITreasury.FaultType.LateSubmission);
            revert ClaimDeadlinePassed(claimKey);
        }

        // Check verifier is in snapshot
        try registry.getVerifierIndex(bucket.snapshotId, verifier) returns (uint8 verifierIndex) {
            // Check for duplicate submission
            if (_hasSubmitted[claimKey][verifier]) {
                treasury.recordFault(verifier, ITreasury.FaultType.DuplicateSubmission);
                revert DuplicateSubmission(claimKey, verifier);
            }

            // Mark as submitted
            _hasSubmitted[claimKey][verifier] = true;

            // Update allSubmittersBitmap
            bucket.allSubmittersBitmap |= uint16(1 << verifierIndex);

            // Calculate valueHash for aggregation
            bytes32 valueHash = keccak256(abi.encodePacked(energyWh, evidenceRoot));

            // Get or create value submission
            ValueSubmission storage valueSub = _valueSubmissions[claimKey][valueHash];
            
            // Track new valueHash
            if (valueSub.count == 0) {
                _claimValueHashes[claimKey].push(valueHash);
                valueSub.energyWh = energyWh;
                valueSub.evidenceRoot = evidenceRoot;
            }

            // Update value submission
            valueSub.count++;
            valueSub.verifierBitmap |= uint16(1 << verifierIndex);

            // Track submitted evidence roots for forceFinalize validation
            _submittedEvidenceRoots[claimKey][evidenceRoot] = true;

            // Update max submitted energy
            if (energyWh > bucket.maxSubmittedEnergyWh) {
                bucket.maxSubmittedEnergyWh = energyWh;
            }

            // Increment submission count
            bucket.submissionCount++;

            emit ProductionSubmitted(claimKey, verifier, energyWh, valueHash);

            // In baseline mode with single verifier, finalize immediately
            if (baselineMode && singleVerifierOverride != address(0) && verifier == singleVerifierOverride) {
                _finalizeWithValue(claimKey, producerId, hourId, energyWh, evidenceRoot, valueSub.verifierBitmap);
            }
        } catch {
            revert VerifierNotInSnapshot(verifier, bucket.snapshotId);
        }
    }

    /**
     * @notice Validate signature and recover verifier address
     * @dev Uses domain separation with chainId and contract address
     */
    function _validateSignature(
        bytes32 producerId,
        uint256 hourId,
        uint64 energyWh,
        bytes32 evidenceRoot,
        bytes calldata signature
    ) internal view returns (address) {
        // Build message hash with domain separation
        bytes32 messageHash = keccak256(abi.encodePacked(
            block.chainid,
            address(this),
            producerId,
            hourId,
            energyWh,
            evidenceRoot
        ));

        // Convert to Ethereum signed message hash
        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();

        // Recover signer
        address recovered = ethSignedHash.recover(signature);

        if (recovered == address(0)) {
            revert InvalidSignature(recovered, address(0));
        }

        return recovered;
    }

    /**
     * @notice Check if a producer is registered
     */
    function _isProducerRegistered(bytes32 producerId) internal view returns (bool) {
        try registry.getProducer(producerId) returns (IRegistry.Producer memory) {
            return true;
        } catch {
            return false;
        }
    }


    // ============ Finalization Functions ============

    /**
     * @notice Finalize production claim after deadline
     * @dev Anyone can call after deadline. Calculates quorum and determines winner.
     * @param producerId The producer identifier
     * @param hourId The hour identifier
     */
    function finalizeProduction(bytes32 producerId, uint256 hourId) external {
        bytes32 claimKey = getClaimKey(producerId, hourId);
        ClaimBucket storage bucket = _claimBuckets[claimKey];

        // Check not already finalized
        if (bucket.finalized) {
            revert ClaimAlreadyFinalized(claimKey);
        }

        // Check deadline has passed
        if (bucket.deadline == 0 || block.timestamp <= bucket.deadline) {
            revert ClaimDeadlineNotReached(claimKey, bucket.deadline);
        }

        // Get snapshot count for quorum calculation
        uint256 snapshotCount = registry.getSnapshotCount(bucket.snapshotId);
        uint256 quorumRequired = (snapshotCount * quorumBps + 9999) / 10000; // Round up

        // Find winning value (highest count that meets quorum)
        bytes32 winningValueHash;
        uint32 maxCount = 0;
        bool quorumReached = false;

        bytes32[] storage valueHashes = _claimValueHashes[claimKey];
        for (uint256 i = 0; i < valueHashes.length; i++) {
            ValueSubmission storage valueSub = _valueSubmissions[claimKey][valueHashes[i]];
            if (valueSub.count > maxCount) {
                maxCount = valueSub.count;
                winningValueHash = valueHashes[i];
            }
        }

        // Check if quorum reached
        if (maxCount >= quorumRequired) {
            quorumReached = true;
        }

        if (!quorumReached) {
            // No quorum - enter disputed state
            bucket.disputed = true;
            bucket.finalized = false;
            emit ClaimDisputed(claimKey, producerId, hourId, "No quorum reached");
            return;
        }

        // Get winning value details
        ValueSubmission storage winningSub = _valueSubmissions[claimKey][winningValueHash];

        // Finalize with winning value
        _finalizeWithValue(
            claimKey,
            producerId,
            hourId,
            winningSub.energyWh,
            winningSub.evidenceRoot,
            winningSub.verifierBitmap
        );

        // Record faults for non-winners who submitted
        // loserBitmap = allSubmittersBitmap XOR winningVerifierBitmap
        uint16 loserBitmap = bucket.allSubmittersBitmap ^ winningSub.verifierBitmap;
        // Only include those who actually submitted (AND with allSubmittersBitmap)
        loserBitmap = loserBitmap & bucket.allSubmittersBitmap;
        
        if (loserBitmap != 0) {
            treasury.recordFaults(loserBitmap, bucket.snapshotId, ITreasury.FaultType.WrongValue);
        }
    }

    /**
     * @notice Internal function to finalize with a specific value
     */
    function _finalizeWithValue(
        bytes32 claimKey,
        bytes32 producerId,
        uint256 hourId,
        uint64 energyWh,
        bytes32 evidenceRoot,
        uint16 winnerBitmap
    ) internal {
        ClaimBucket storage bucket = _claimBuckets[claimKey];

        // Mark as finalized
        bucket.finalized = true;
        bucket.disputed = false;
        bucket.verifiedEnergyWh = energyWh;
        bucket.evidenceRoot = evidenceRoot;
        bucket.winningValueHash = keccak256(abi.encodePacked(energyWh, evidenceRoot));
        bucket.winningVerifierBitmap = winnerBitmap;

        // Get producer payout address
        IRegistry.Producer memory producer = registry.getProducer(producerId);

        // Mint HCN tokens to producer
        hourlyCredits.mint(producer.payoutAddr, hourId, energyWh, claimKey);

        // Distribute rewards to winners
        treasury.distributeRewards(winnerBitmap, bucket.snapshotId, energyWh);

        emit ProductionFinalized(claimKey, producerId, hourId, energyWh, evidenceRoot);
    }

    /**
     * @notice Admin emergency finalization for disputed claims
     * @dev Can only be called if claim is disputed and deadline passed
     * @param producerId The producer identifier
     * @param hourId The hour identifier
     * @param energyWh The energy value to finalize with (must be <= maxSubmittedEnergyWh)
     * @param evidenceRoot The evidence root (must have been submitted)
     */
    function forceFinalize(
        bytes32 producerId,
        uint256 hourId,
        uint64 energyWh,
        bytes32 evidenceRoot
    ) external onlyOwner {
        bytes32 claimKey = getClaimKey(producerId, hourId);
        ClaimBucket storage bucket = _claimBuckets[claimKey];

        // Check claim is disputed
        if (!bucket.disputed) {
            revert ClaimNotDisputed(claimKey);
        }

        // Check deadline has passed
        if (block.timestamp <= bucket.deadline) {
            revert ClaimDeadlineNotReached(claimKey, bucket.deadline);
        }

        // Validate energyWh <= maxSubmittedEnergyWh
        if (energyWh > bucket.maxSubmittedEnergyWh) {
            revert EnergyExceedsMaxSubmitted(energyWh, bucket.maxSubmittedEnergyWh);
        }

        // Validate evidenceRoot was submitted
        if (!_submittedEvidenceRoots[claimKey][evidenceRoot]) {
            revert EvidenceRootNotSubmitted(evidenceRoot);
        }

        // Mark as finalized (no rewards/faults for force finalize)
        bucket.finalized = true;
        bucket.disputed = false;
        bucket.verifiedEnergyWh = energyWh;
        bucket.evidenceRoot = evidenceRoot;
        bucket.winningVerifierBitmap = 0; // No winners for force finalize

        // Get producer payout address
        IRegistry.Producer memory producer = registry.getProducer(producerId);

        // Mint HCN tokens to producer (no rewards distributed)
        hourlyCredits.mint(producer.payoutAddr, hourId, energyWh, claimKey);

        emit ForceFinalized(claimKey, msg.sender, energyWh);
        emit ProductionFinalized(claimKey, producerId, hourId, energyWh, evidenceRoot);
    }


    // ============ View Functions ============

    /**
     * @notice Get the claim key for a producer and hour
     * @param producerId The producer identifier
     * @param hourId The hour identifier
     * @return The claim key
     */
    function getClaimKey(bytes32 producerId, uint256 hourId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            bytes1(0x01), // ClaimType.Production
            address(this),
            producerId,
            hourId
        ));
    }

    /**
     * @notice Get claim bucket details
     * @param claimKey The claim key
     * @return The claim bucket
     */
    function getClaimBucket(bytes32 claimKey) external view returns (ClaimBucket memory) {
        return _claimBuckets[claimKey];
    }

    /**
     * @notice Check if a verifier has submitted for a claim
     * @param claimKey The claim key
     * @param verifier The verifier address
     * @return True if submitted
     */
    function hasSubmitted(bytes32 claimKey, address verifier) external view returns (bool) {
        return _hasSubmitted[claimKey][verifier];
    }

    /**
     * @notice Check if a claim is finalized
     * @param claimKey The claim key
     * @return True if finalized
     */
    function isFinalized(bytes32 claimKey) external view returns (bool) {
        return _claimBuckets[claimKey].finalized;
    }

    /**
     * @notice Get value submission details
     * @param claimKey The claim key
     * @param valueHash The value hash
     * @return The value submission
     */
    function getValueSubmissions(bytes32 claimKey, bytes32 valueHash) external view returns (ValueSubmission memory) {
        return _valueSubmissions[claimKey][valueHash];
    }

    /**
     * @notice Check if an evidence root was submitted for a claim
     * @param claimKey The claim key
     * @param evidenceRoot The evidence root to check
     * @return True if submitted
     */
    function isEvidenceRootSubmitted(bytes32 claimKey, bytes32 evidenceRoot) external view returns (bool) {
        return _submittedEvidenceRoots[claimKey][evidenceRoot];
    }

    /**
     * @notice Check if baseline mode is enabled
     * @return True if baseline mode is enabled
     */
    function isBaselineMode() external view returns (bool) {
        return baselineMode;
    }

    // ============ Configuration Functions ============

    /**
     * @notice Set baseline mode
     * @param enabled True to enable baseline mode
     */
    function setBaselineMode(bool enabled) external onlyOwner {
        baselineMode = enabled;
    }

    /**
     * @notice Set single verifier override for baseline mode
     * @param verifier The verifier address
     */
    function setSingleVerifierOverride(address verifier) external onlyOwner {
        singleVerifierOverride = verifier;
    }

    /**
     * @notice Set the claim window duration
     * @param seconds_ The claim window in seconds
     */
    function setClaimWindow(uint256 seconds_) external onlyOwner {
        claimWindow = seconds_;
    }

    /**
     * @notice Set the quorum threshold
     * @param bps The quorum in basis points
     */
    function setQuorumBps(uint256 bps) external onlyOwner {
        quorumBps = bps;
    }

    /**
     * @notice Set the Registry contract address
     * @param _registry The Registry contract address
     */
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        registry = IRegistry(_registry);
    }

    /**
     * @notice Set the HourlyCredits contract address
     * @param _hourlyCredits The HourlyCredits contract address
     */
    function setHourlyCredits(address _hourlyCredits) external onlyOwner {
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        hourlyCredits = IHourlyCredits(_hourlyCredits);
    }

    /**
     * @notice Set the Treasury contract address
     * @param _treasury The Treasury contract address
     */
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = ITreasury(_treasury);
    }
}

// ============ Interfaces ============

interface IRegistry {
    struct Producer {
        bytes32 producerId;
        bytes32 systemIdHash;
        bytes32 metaHash;
        address payoutAddr;
        address owner;
        bool active;
    }

    struct Verifier {
        uint256 stake;
        uint256 faults;
        bool active;
        bool allowlisted;
    }

    function getProducer(bytes32 producerId) external view returns (Producer memory);
    function getVerifier(address verifier) external view returns (Verifier memory);
    function createSnapshot(bytes32 claimKey) external returns (uint256 snapshotId);
    function getSnapshotId(bytes32 claimKey) external view returns (uint256);
    function getSnapshotCount(uint256 snapshotId) external view returns (uint256);
    function getSnapshotVerifiers(uint256 snapshotId) external view returns (address[] memory);
    function getVerifierIndex(uint256 snapshotId, address verifier) external view returns (uint8);
    function claimWindow() external view returns (uint256);
    function quorumBps() external view returns (uint256);
}

interface IHourlyCredits {
    function mint(address to, uint256 hourId, uint256 amountWh, bytes32 claimKey) external;
}

interface ITreasury {
    enum FaultType {
        WrongValue,
        InvalidSignature,
        DuplicateSubmission,
        LateSubmission,
        MalformedClaim
    }

    function distributeRewards(uint16 winnerBitmap, uint256 snapshotId, uint64 energyWh) external;
    function recordFault(address verifier, FaultType faultType) external;
    function recordFaults(uint16 loserBitmap, uint256 snapshotId, FaultType faultType) external;
}
