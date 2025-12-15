// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Retirement
 * @dev Handles credit retirement and SREC-equivalent certificate issuance.
 * Users can retire hourly credits (HCN) and receive certificates for carbon-free energy claims.
 * SREC batches require 1 MWh (1,000,000 Wh) multiples.
 */
contract Retirement is Ownable {
    // ============ Constants ============

    /// @notice 1 SREC = 1 MWh = 1,000,000 Wh
    uint64 public constant SREC_WH = 1_000_000;

    // ============ Structs ============

    struct RetirementRecord {
        address owner;
        uint256 hourId;
        uint64 amountWh;
        bytes32 reasonHash;
        bytes32 claimKey;
        uint256 timestamp;
    }

    struct Certificate {
        address owner;
        uint256[] hourIds;
        uint64[] amounts;
        bytes32[] evidenceRoots;
        address[] winningVerifiers;
        bytes32[] claimKeys;
        uint64 totalWh;
        bytes32 metadataHash;
        uint256 timestamp;
    }

    // ============ State Variables ============

    /// @notice HourlyCredits contract for burning HCN tokens
    IHourlyCredits public hourlyCredits;

    /// @notice ProductionOracle contract for retrieving claim data
    IProductionOracle public productionOracle;

    /// @notice Registry contract for retrieving snapshot verifiers
    IRegistry public registry;

    /// @notice Counter for retirement IDs
    uint256 private _nextRetireId;

    /// @notice Counter for certificate IDs
    uint256 private _nextCertId;

    /// @notice Mapping of retireId to RetirementRecord
    mapping(uint256 => RetirementRecord) private _retirementRecords;

    /// @notice Mapping of certId to Certificate
    mapping(uint256 => Certificate) private _certificates;


    // ============ Events ============

    /// @notice Emitted when credits are retired
    event Retired(
        uint256 indexed retireId,
        address indexed owner,
        uint256 hourId,
        uint64 amountWh
    );

    /// @notice Emitted when an SREC certificate is issued
    event CertificateIssued(
        uint256 indexed certId,
        address indexed owner,
        uint64 totalMwh,
        bytes32 metadataHash,
        bytes32[] claimKeys
    );

    // ============ Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 hourId, uint64 required, uint64 available);
    error InvalidSRECAmount(uint64 amountWh);
    error ArrayLengthMismatch();
    error EmptyArrays();
    error RetirementNotFound(uint256 retireId);
    error CertificateNotFound(uint256 certId);

    // ============ Constructor ============

    /**
     * @dev Constructor sets the contract dependencies
     * @param _hourlyCredits The HourlyCredits contract address
     * @param _productionOracle The ProductionOracle contract address
     * @param _registry The Registry contract address
     * @param initialOwner The address that will own the contract
     */
    constructor(
        address _hourlyCredits,
        address _productionOracle,
        address _registry,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        if (_productionOracle == address(0)) revert ZeroAddress();
        if (_registry == address(0)) revert ZeroAddress();

        hourlyCredits = IHourlyCredits(_hourlyCredits);
        productionOracle = IProductionOracle(_productionOracle);
        registry = IRegistry(_registry);

        _nextRetireId = 1;
        _nextCertId = 1;
    }

    // ============ Hourly Retirement Functions ============

    /**
     * @notice Retire hourly credits
     * @dev Burns HCN tokens and creates a retirement record with claimKey reference
     * @param hourId The hour identifier (tokenId)
     * @param amountWh The amount of energy in Wh to retire
     * @param reasonHash Hash of the retirement reason/purpose
     * @return retireId The unique retirement record ID
     */
    function retireHourly(
        uint256 hourId,
        uint64 amountWh,
        bytes32 reasonHash
    ) external returns (uint256 retireId) {
        if (amountWh == 0) revert ZeroAmount();

        // Check caller has sufficient balance
        uint256 balance = hourlyCredits.balanceOf(msg.sender, hourId);
        if (balance < amountWh) {
            revert InsufficientBalance(hourId, amountWh, uint64(balance));
        }

        // Get claimKey from ProductionOracle for this hourId
        // Note: We need to find the claimKey associated with this hourId
        // For simplicity, we'll store the hourId-based lookup
        // The actual claimKey would need producer context, so we derive it differently
        bytes32 claimKey = _getClaimKeyForHour(hourId);

        // Burn the HCN tokens
        hourlyCredits.burn(msg.sender, hourId, amountWh);

        // Create retirement record
        retireId = _nextRetireId++;
        _retirementRecords[retireId] = RetirementRecord({
            owner: msg.sender,
            hourId: hourId,
            amountWh: amountWh,
            reasonHash: reasonHash,
            claimKey: claimKey,
            timestamp: block.timestamp
        });

        emit Retired(retireId, msg.sender, hourId, amountWh);
    }

    /**
     * @notice Get claimKey for an hourId
     * @dev Since HCN tokens are fungible per hourId, we create a retirement-specific key
     * @param hourId The hour identifier
     * @return The derived claim key for retirement tracking
     */
    function _getClaimKeyForHour(uint256 hourId) internal view returns (bytes32) {
        // For retirement, we create a unique key based on the hourId and contract
        // This allows tracking which hour the retirement is associated with
        return keccak256(abi.encodePacked(
            bytes1(0x03), // ClaimType.Retirement
            address(this),
            hourId
        ));
    }


    // ============ SREC Batch Retirement Functions ============

    /**
     * @notice Retire credits in SREC batches
     * @dev Total must be a multiple of 1 MWh (1,000,000 Wh)
     * @param hourIds Array of hour identifiers
     * @param amounts Array of amounts in Wh for each hour
     * @param reasonHash Hash of the retirement reason/purpose
     * @return certId The unique certificate ID
     */
    function retireSREC(
        uint256[] calldata hourIds,
        uint64[] calldata amounts,
        bytes32 reasonHash
    ) external returns (uint256 certId) {
        if (hourIds.length == 0) revert EmptyArrays();
        if (hourIds.length != amounts.length) revert ArrayLengthMismatch();

        // Calculate total and validate SREC multiple
        uint64 totalWh = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) revert ZeroAmount();
            totalWh += amounts[i];
        }

        // Must be multiple of 1 MWh
        if (totalWh % SREC_WH != 0) {
            revert InvalidSRECAmount(totalWh);
        }

        // Verify balances and burn tokens
        for (uint256 i = 0; i < hourIds.length; i++) {
            uint256 balance = hourlyCredits.balanceOf(msg.sender, hourIds[i]);
            if (balance < amounts[i]) {
                revert InsufficientBalance(hourIds[i], amounts[i], uint64(balance));
            }
            hourlyCredits.burn(msg.sender, hourIds[i], amounts[i]);
        }

        // Build certificate data
        bytes32[] memory claimKeys = new bytes32[](hourIds.length);
        bytes32[] memory evidenceRoots = new bytes32[](hourIds.length);
        
        for (uint256 i = 0; i < hourIds.length; i++) {
            claimKeys[i] = _getClaimKeyForHour(hourIds[i]);
            // Evidence roots would come from ProductionOracle claim data
            // For now, we use the retirement claim key as placeholder
            evidenceRoots[i] = claimKeys[i];
        }

        // Create certificate
        certId = _nextCertId++;
        
        // Copy arrays to storage
        Certificate storage cert = _certificates[certId];
        cert.owner = msg.sender;
        cert.totalWh = totalWh;
        cert.metadataHash = reasonHash;
        cert.timestamp = block.timestamp;

        // Copy dynamic arrays
        for (uint256 i = 0; i < hourIds.length; i++) {
            cert.hourIds.push(hourIds[i]);
            cert.amounts.push(amounts[i]);
            cert.evidenceRoots.push(evidenceRoots[i]);
            cert.claimKeys.push(claimKeys[i]);
        }

        // Calculate total MWh for event (totalWh / SREC_WH)
        uint64 totalMwh = totalWh / SREC_WH;

        emit CertificateIssued(certId, msg.sender, totalMwh, reasonHash, claimKeys);
    }

    // ============ View Functions ============

    /**
     * @notice Get a retirement record by ID
     * @param retireId The retirement record ID
     * @return The retirement record
     */
    function getRetirementRecord(uint256 retireId) external view returns (RetirementRecord memory) {
        if (_retirementRecords[retireId].owner == address(0)) {
            revert RetirementNotFound(retireId);
        }
        return _retirementRecords[retireId];
    }

    /**
     * @notice Get a certificate by ID
     * @param certId The certificate ID
     * @return The certificate
     */
    function getCertificate(uint256 certId) external view returns (Certificate memory) {
        if (_certificates[certId].owner == address(0)) {
            revert CertificateNotFound(certId);
        }
        return _certificates[certId];
    }

    /**
     * @notice Get the next retirement ID (for testing/queries)
     * @return The next retirement ID that will be assigned
     */
    function getNextRetireId() external view returns (uint256) {
        return _nextRetireId;
    }

    /**
     * @notice Get the next certificate ID (for testing/queries)
     * @return The next certificate ID that will be assigned
     */
    function getNextCertId() external view returns (uint256) {
        return _nextCertId;
    }

    // ============ Configuration Functions ============

    /**
     * @notice Set the HourlyCredits contract address
     * @param _hourlyCredits The HourlyCredits contract address
     */
    function setHourlyCredits(address _hourlyCredits) external onlyOwner {
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        hourlyCredits = IHourlyCredits(_hourlyCredits);
    }

    /**
     * @notice Set the ProductionOracle contract address
     * @param _productionOracle The ProductionOracle contract address
     */
    function setProductionOracle(address _productionOracle) external onlyOwner {
        if (_productionOracle == address(0)) revert ZeroAddress();
        productionOracle = IProductionOracle(_productionOracle);
    }

    /**
     * @notice Set the Registry contract address
     * @param _registry The Registry contract address
     */
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        registry = IRegistry(_registry);
    }
}

// ============ Interfaces ============

interface IHourlyCredits {
    function balanceOf(address account, uint256 hourId) external view returns (uint256);
    function burn(address from, uint256 hourId, uint256 amountWh) external;
}

interface IProductionOracle {
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

    function getClaimBucket(bytes32 claimKey) external view returns (ClaimBucket memory);
}

interface IRegistry {
    function getSnapshotVerifiers(uint256 snapshotId) external view returns (address[] memory);
}
