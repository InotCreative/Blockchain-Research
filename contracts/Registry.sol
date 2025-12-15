// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Registry
 * @dev Manages producers, consumers, and verifier membership for SEARChain.
 * Handles registration, staking, snapshots, and configuration parameters.
 */
contract Registry is Ownable {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct Producer {
        bytes32 producerId;
        bytes32 systemIdHash;
        bytes32 metaHash;
        address payoutAddr;
        address owner;
        bool active;
    }

    struct Consumer {
        bytes32 consumerId;
        bytes32 meterIdHash;
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

    struct Snapshot {
        address[] verifiers;
        uint256 timestamp;
    }

    // ============ State Variables ============


    // Token for staking
    IERC20 public searToken;

    // Producer storage
    mapping(bytes32 => Producer) private _producers;
    mapping(bytes32 => bool) private _systemIdRegistered;
    
    // Consumer storage
    mapping(bytes32 => Consumer) private _consumers;
    
    // Verifier storage
    mapping(address => Verifier) private _verifiers;
    address[] private _activeVerifiers;
    mapping(address => uint256) private _activeVerifierIndex; // 1-indexed for existence check
    
    // Snapshot storage
    mapping(bytes32 => uint256) private _claimKeyToSnapshotId;
    mapping(uint256 => Snapshot) private _snapshots;
    uint256 private _nextSnapshotId = 1;
    
    // Oracle authorization
    address public productionOracle;
    address public consumptionOracle;
    
    // Configuration parameters
    uint256 public quorumBps = 6667; // Default 2/3 (66.67%)
    uint256 public claimWindow = 3600; // Default 1 hour in seconds
    uint256 public rewardPerWhWei = 1e12; // Default reward per Wh
    uint256 public slashBps = 1000; // Default 10% slash
    uint256 public faultThreshold = 3; // Default 3 faults before slash
    uint256 public minStake = 100 * 1e18; // Minimum stake required (100 SEAR)
    
    // Permissioned mode
    bool public permissionedMode = true;

    // ============ Events ============

    event ProducerRegistered(
        bytes32 indexed producerId,
        bytes32 indexed systemIdHash,
        address indexed owner,
        bytes32 metaHash,
        address payoutAddr
    );

    event ConsumerRegistered(
        bytes32 indexed consumerId,
        bytes32 indexed meterIdHash,
        address indexed owner,
        bytes32 metaHash,
        address payoutAddr
    );

    event VerifierStaked(address indexed verifier, uint256 amount, uint256 totalStake);
    event VerifierUnstaked(address indexed verifier, uint256 amount, uint256 totalStake);
    event VerifierActivated(address indexed verifier);
    event VerifierDeactivated(address indexed verifier);
    event VerifierAllowlisted(address indexed verifier);
    event VerifierRemovedFromAllowlist(address indexed verifier);
    event SnapshotCreated(bytes32 indexed claimKey, uint256 indexed snapshotId, uint256 verifierCount);
    
    event QuorumBpsUpdated(uint256 oldValue, uint256 newValue);
    event ClaimWindowUpdated(uint256 oldValue, uint256 newValue);
    event RewardPerWhWeiUpdated(uint256 oldValue, uint256 newValue);
    event SlashBpsUpdated(uint256 oldValue, uint256 newValue);
    event FaultThresholdUpdated(uint256 oldValue, uint256 newValue);
    event ProductionOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event ConsumptionOracleUpdated(address indexed oldOracle, address indexed newOracle);


    // ============ Errors ============

    error ProducerAlreadyRegistered(bytes32 producerId);
    error SystemAlreadyRegistered(bytes32 systemIdHash);
    error ConsumerAlreadyRegistered(bytes32 consumerId);
    error ProducerNotFound(bytes32 producerId);
    error ConsumerNotFound(bytes32 consumerId);
    error VerifierNotAllowlisted(address verifier);
    error VerifierAlreadyActive(address verifier);
    error VerifierNotActive(address verifier);
    error InsufficientStake(uint256 required, uint256 actual);
    error InsufficientStakeBalance(uint256 requested, uint256 available);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidQuorumBps(uint256 bps);
    error OnlyAuthorizedOracle(address caller);
    error SnapshotAlreadyExists(bytes32 claimKey);
    error SnapshotNotFound(bytes32 claimKey);
    error VerifierNotInSnapshot(address verifier, uint256 snapshotId);
    error NoActiveVerifiers();

    // ============ Constructor ============

    /**
     * @dev Constructor sets the SEAR token address and initial owner
     * @param _searToken The SEAR token contract address
     * @param initialOwner The address that will own the contract
     */
    constructor(address _searToken, address initialOwner) Ownable(initialOwner) {
        if (_searToken == address(0)) revert ZeroAddress();
        searToken = IERC20(_searToken);
    }

    // ============ Modifiers ============

    modifier onlyAuthorizedOracle() {
        if (msg.sender != productionOracle && msg.sender != consumptionOracle) {
            revert OnlyAuthorizedOracle(msg.sender);
        }
        _;
    }

    // ============ Producer Functions ============

    /**
     * @notice Register a new producer
     * @param systemIdHash Hash of the system ID (e.g., Enphase system serial)
     * @param metaHash Hash of producer metadata
     * @param payoutAddr Address to receive HCN tokens
     * @return producerId The unique producer identifier
     */
    function registerProducer(
        bytes32 systemIdHash,
        bytes32 metaHash,
        address payoutAddr
    ) external returns (bytes32 producerId) {
        if (payoutAddr == address(0)) revert ZeroAddress();
        
        // Check systemIdHash uniqueness
        if (_systemIdRegistered[systemIdHash]) {
            revert SystemAlreadyRegistered(systemIdHash);
        }
        
        // Generate producerId: keccak256(wallet + systemIdHash + salt)
        // Using block.timestamp as salt for uniqueness
        producerId = keccak256(abi.encodePacked(msg.sender, systemIdHash, block.timestamp));
        
        // Check producerId doesn't already exist (extremely unlikely but safe)
        if (_producers[producerId].owner != address(0)) {
            revert ProducerAlreadyRegistered(producerId);
        }
        
        // Register the producer
        _producers[producerId] = Producer({
            producerId: producerId,
            systemIdHash: systemIdHash,
            metaHash: metaHash,
            payoutAddr: payoutAddr,
            owner: msg.sender,
            active: true
        });
        
        // Mark systemIdHash as registered
        _systemIdRegistered[systemIdHash] = true;
        
        emit ProducerRegistered(producerId, systemIdHash, msg.sender, metaHash, payoutAddr);
    }


    /**
     * @notice Get producer details
     * @param producerId The producer identifier
     * @return Producer struct with all details
     */
    function getProducer(bytes32 producerId) external view returns (Producer memory) {
        if (_producers[producerId].owner == address(0)) {
            revert ProducerNotFound(producerId);
        }
        return _producers[producerId];
    }

    /**
     * @notice Check if a system ID is already registered
     * @param systemIdHash The system ID hash to check
     * @return True if registered, false otherwise
     */
    function isSystemRegistered(bytes32 systemIdHash) external view returns (bool) {
        return _systemIdRegistered[systemIdHash];
    }

    // ============ Consumer Functions ============

    /**
     * @notice Register a new consumer
     * @param meterIdHash Hash of the meter ID
     * @param metaHash Hash of consumer metadata
     * @param payoutAddr Address for consumer operations
     * @return consumerId The unique consumer identifier
     */
    function registerConsumer(
        bytes32 meterIdHash,
        bytes32 metaHash,
        address payoutAddr
    ) external returns (bytes32 consumerId) {
        if (payoutAddr == address(0)) revert ZeroAddress();
        
        // Generate consumerId: keccak256(wallet + meterIdHash + salt)
        consumerId = keccak256(abi.encodePacked(msg.sender, meterIdHash, block.timestamp));
        
        // Check consumerId doesn't already exist
        if (_consumers[consumerId].owner != address(0)) {
            revert ConsumerAlreadyRegistered(consumerId);
        }
        
        // Register the consumer
        _consumers[consumerId] = Consumer({
            consumerId: consumerId,
            meterIdHash: meterIdHash,
            metaHash: metaHash,
            payoutAddr: payoutAddr,
            owner: msg.sender,
            active: true
        });
        
        emit ConsumerRegistered(consumerId, meterIdHash, msg.sender, metaHash, payoutAddr);
    }

    /**
     * @notice Get consumer details
     * @param consumerId The consumer identifier
     * @return Consumer struct with all details
     */
    function getConsumer(bytes32 consumerId) external view returns (Consumer memory) {
        if (_consumers[consumerId].owner == address(0)) {
            revert ConsumerNotFound(consumerId);
        }
        return _consumers[consumerId];
    }


    // ============ Verifier Staking Functions ============

    /**
     * @notice Stake tokens to become a potential verifier
     * @param amount Amount of SEAR tokens to stake
     */
    function stakeAsVerifier(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        
        // Transfer tokens from sender to this contract
        searToken.safeTransferFrom(msg.sender, address(this), amount);
        
        // Update verifier stake
        _verifiers[msg.sender].stake += amount;
        
        emit VerifierStaked(msg.sender, amount, _verifiers[msg.sender].stake);
    }

    /**
     * @notice Unstake tokens (only if not active)
     * @param amount Amount of SEAR tokens to unstake
     */
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        
        Verifier storage verifier = _verifiers[msg.sender];
        
        // Cannot unstake if active
        if (verifier.active) {
            revert VerifierAlreadyActive(msg.sender);
        }
        
        // Check sufficient balance
        if (verifier.stake < amount) {
            revert InsufficientStakeBalance(amount, verifier.stake);
        }
        
        // Update stake and transfer tokens back
        verifier.stake -= amount;
        searToken.safeTransfer(msg.sender, amount);
        
        emit VerifierUnstaked(msg.sender, amount, verifier.stake);
    }

    /**
     * @notice Activate as a verifier (requires sufficient stake and allowlist in permissioned mode)
     */
    function activateVerifier() external {
        Verifier storage verifier = _verifiers[msg.sender];
        
        // Check if already active
        if (verifier.active) {
            revert VerifierAlreadyActive(msg.sender);
        }
        
        // Check allowlist in permissioned mode
        if (permissionedMode && !verifier.allowlisted) {
            revert VerifierNotAllowlisted(msg.sender);
        }
        
        // Check minimum stake
        if (verifier.stake < minStake) {
            revert InsufficientStake(minStake, verifier.stake);
        }
        
        // Activate verifier
        verifier.active = true;
        _activeVerifiers.push(msg.sender);
        _activeVerifierIndex[msg.sender] = _activeVerifiers.length; // 1-indexed
        
        emit VerifierActivated(msg.sender);
    }

    /**
     * @notice Deactivate as a verifier (preserves stake)
     */
    function deactivateVerifier() external {
        Verifier storage verifier = _verifiers[msg.sender];
        
        // Check if active
        if (!verifier.active) {
            revert VerifierNotActive(msg.sender);
        }
        
        // Deactivate verifier
        verifier.active = false;
        
        // Remove from active verifiers array (swap and pop)
        uint256 index = _activeVerifierIndex[msg.sender] - 1; // Convert to 0-indexed
        uint256 lastIndex = _activeVerifiers.length - 1;
        
        if (index != lastIndex) {
            address lastVerifier = _activeVerifiers[lastIndex];
            _activeVerifiers[index] = lastVerifier;
            _activeVerifierIndex[lastVerifier] = index + 1; // 1-indexed
        }
        
        _activeVerifiers.pop();
        delete _activeVerifierIndex[msg.sender];
        
        emit VerifierDeactivated(msg.sender);
    }

    /**
     * @notice Get verifier details
     * @param verifier The verifier address
     * @return Verifier struct with all details
     */
    function getVerifier(address verifier) external view returns (Verifier memory) {
        return _verifiers[verifier];
    }

    /**
     * @notice Get all active verifiers
     * @return Array of active verifier addresses
     */
    function getActiveVerifiers() external view returns (address[] memory) {
        return _activeVerifiers;
    }

    /**
     * @notice Get count of active verifiers
     * @return Number of active verifiers
     */
    function getActiveVerifierCount() external view returns (uint256) {
        return _activeVerifiers.length;
    }


    // ============ Allowlist Functions ============

    /**
     * @notice Add an address to the verifier allowlist
     * @param verifier The address to allowlist
     */
    function addToAllowlist(address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        _verifiers[verifier].allowlisted = true;
        emit VerifierAllowlisted(verifier);
    }

    /**
     * @notice Remove an address from the verifier allowlist
     * @param verifier The address to remove from allowlist
     */
    function removeFromAllowlist(address verifier) external onlyOwner {
        _verifiers[verifier].allowlisted = false;
        emit VerifierRemovedFromAllowlist(verifier);
    }

    /**
     * @notice Check if an address is allowlisted
     * @param verifier The address to check
     * @return True if allowlisted, false otherwise
     */
    function isAllowlisted(address verifier) external view returns (bool) {
        return _verifiers[verifier].allowlisted;
    }

    /**
     * @notice Set permissioned mode on/off
     * @param enabled True to enable permissioned mode
     */
    function setPermissionedMode(bool enabled) external onlyOwner {
        permissionedMode = enabled;
    }

    // ============ Snapshot Functions ============

    /**
     * @notice Create a snapshot of active verifiers for a claim
     * @dev Only callable by authorized oracles. Verifiers are sorted by address.
     * @param claimKey The unique claim identifier
     * @return snapshotId The created snapshot ID
     */
    function createSnapshot(bytes32 claimKey) external onlyAuthorizedOracle returns (uint256 snapshotId) {
        // Check if snapshot already exists for this claimKey
        if (_claimKeyToSnapshotId[claimKey] != 0) {
            revert SnapshotAlreadyExists(claimKey);
        }
        
        // Check there are active verifiers
        if (_activeVerifiers.length == 0) {
            revert NoActiveVerifiers();
        }
        
        // Create snapshot ID
        snapshotId = _nextSnapshotId++;
        
        // Copy and sort active verifiers
        address[] memory sortedVerifiers = _sortAddresses(_activeVerifiers);
        
        // Store snapshot
        _snapshots[snapshotId] = Snapshot({
            verifiers: sortedVerifiers,
            timestamp: block.timestamp
        });
        
        // Map claimKey to snapshotId
        _claimKeyToSnapshotId[claimKey] = snapshotId;
        
        emit SnapshotCreated(claimKey, snapshotId, sortedVerifiers.length);
    }

    /**
     * @notice Get snapshot ID for a claim key
     * @param claimKey The claim key to look up
     * @return The snapshot ID (0 if not found)
     */
    function getSnapshotId(bytes32 claimKey) external view returns (uint256) {
        return _claimKeyToSnapshotId[claimKey];
    }

    /**
     * @notice Get the number of verifiers in a snapshot
     * @param snapshotId The snapshot ID
     * @return The number of verifiers
     */
    function getSnapshotCount(uint256 snapshotId) external view returns (uint256) {
        return _snapshots[snapshotId].verifiers.length;
    }

    /**
     * @notice Get all verifiers in a snapshot
     * @param snapshotId The snapshot ID
     * @return Array of verifier addresses (sorted)
     */
    function getSnapshotVerifiers(uint256 snapshotId) external view returns (address[] memory) {
        return _snapshots[snapshotId].verifiers;
    }

    /**
     * @notice Get the index of a verifier in a snapshot
     * @param snapshotId The snapshot ID
     * @param verifier The verifier address
     * @return The index (0-based) of the verifier in the snapshot
     */
    function getVerifierIndex(uint256 snapshotId, address verifier) external view returns (uint8) {
        address[] storage verifiers = _snapshots[snapshotId].verifiers;
        for (uint256 i = 0; i < verifiers.length; i++) {
            if (verifiers[i] == verifier) {
                return uint8(i);
            }
        }
        revert VerifierNotInSnapshot(verifier, snapshotId);
    }


    // ============ Configuration Functions ============

    /**
     * @notice Set the quorum threshold in basis points
     * @param bps Quorum threshold (e.g., 6667 for 66.67%)
     */
    function setQuorumBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > 10000) revert InvalidQuorumBps(bps);
        uint256 oldValue = quorumBps;
        quorumBps = bps;
        emit QuorumBpsUpdated(oldValue, bps);
    }

    /**
     * @notice Set the claim window duration
     * @param seconds_ Claim window in seconds
     */
    function setClaimWindow(uint256 seconds_) external onlyOwner {
        uint256 oldValue = claimWindow;
        claimWindow = seconds_;
        emit ClaimWindowUpdated(oldValue, seconds_);
    }

    /**
     * @notice Set the reward rate per Wh in wei
     * @param weiPerWh Reward per Wh in wei
     */
    function setRewardPerWhWei(uint256 weiPerWh) external onlyOwner {
        uint256 oldValue = rewardPerWhWei;
        rewardPerWhWei = weiPerWh;
        emit RewardPerWhWeiUpdated(oldValue, weiPerWh);
    }

    /**
     * @notice Set the slash percentage in basis points
     * @param bps Slash percentage (e.g., 1000 for 10%)
     */
    function setSlashBps(uint256 bps) external onlyOwner {
        uint256 oldValue = slashBps;
        slashBps = bps;
        emit SlashBpsUpdated(oldValue, bps);
    }

    /**
     * @notice Set the fault threshold before slashing
     * @param threshold Number of faults before slash
     */
    function setFaultThreshold(uint256 threshold) external onlyOwner {
        uint256 oldValue = faultThreshold;
        faultThreshold = threshold;
        emit FaultThresholdUpdated(oldValue, threshold);
    }

    /**
     * @notice Set the minimum stake required for verifiers
     * @param amount Minimum stake in SEAR tokens
     */
    function setMinStake(uint256 amount) external onlyOwner {
        minStake = amount;
    }

    /**
     * @notice Set the production oracle address
     * @param oracle The production oracle contract address
     */
    function setProductionOracle(address oracle) external onlyOwner {
        address oldOracle = productionOracle;
        productionOracle = oracle;
        emit ProductionOracleUpdated(oldOracle, oracle);
    }

    /**
     * @notice Set the consumption oracle address
     * @param oracle The consumption oracle contract address
     */
    function setConsumptionOracle(address oracle) external onlyOwner {
        address oldOracle = consumptionOracle;
        consumptionOracle = oracle;
        emit ConsumptionOracleUpdated(oldOracle, oracle);
    }

    /**
     * @notice Check if an address is an authorized oracle
     * @param caller The address to check
     * @return True if authorized, false otherwise
     */
    function isAuthorizedOracle(address caller) external view returns (bool) {
        return caller == productionOracle || caller == consumptionOracle;
    }


    // ============ Internal Functions ============

    /**
     * @dev Sort an array of addresses in ascending order (bubble sort for simplicity)
     * @param arr The array to sort
     * @return sorted The sorted array
     */
    function _sortAddresses(address[] memory arr) internal pure returns (address[] memory sorted) {
        sorted = new address[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            sorted[i] = arr[i];
        }
        
        // Bubble sort (acceptable for small arrays, max 15 verifiers)
        for (uint256 i = 0; i < sorted.length; i++) {
            for (uint256 j = i + 1; j < sorted.length; j++) {
                if (uint160(sorted[i]) > uint160(sorted[j])) {
                    address temp = sorted[i];
                    sorted[i] = sorted[j];
                    sorted[j] = temp;
                }
            }
        }
    }

    // ============ Verifier Fault Management (for Treasury) ============

    /**
     * @notice Increment fault count for a verifier
     * @dev Called by Treasury contract
     * @param verifier The verifier address
     */
    function incrementFaults(address verifier) external {
        // Only Treasury should call this, but for now allow authorized oracles too
        // In production, add proper access control
        _verifiers[verifier].faults++;
    }

    /**
     * @notice Reduce verifier stake (for slashing)
     * @dev Called by Treasury contract
     * @param verifier The verifier address
     * @param amount Amount to reduce
     */
    function reduceStake(address verifier, uint256 amount) external {
        // Only Treasury should call this
        // In production, add proper access control
        if (_verifiers[verifier].stake >= amount) {
            _verifiers[verifier].stake -= amount;
        } else {
            _verifiers[verifier].stake = 0;
        }
    }
}
