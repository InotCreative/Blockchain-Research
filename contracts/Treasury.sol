// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Treasury
 * @dev Manages reward pool, reward distribution, and slashing for SEARChain.
 * Handles verifier rewards for correct verification and penalties for misbehavior.
 */
contract Treasury is Ownable {
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum FaultType {
        WrongValue,
        InvalidSignature,
        DuplicateSubmission,
        LateSubmission,
        MalformedClaim
    }

    // ============ State Variables ============

    /// @notice SEAR token for rewards and slashing
    IERC20 public searToken;

    /// @notice Registry contract for verifier data
    address public registry;

    /// @notice Production oracle address (authorized to call reward/fault functions)
    address public productionOracle;

    /// @notice Consumption oracle address (authorized to call reward/fault functions)
    address public consumptionOracle;

    /// @notice Reward pool balance (SEAR tokens held for distribution)
    uint256 public rewardPool;

    /// @notice Reward per Wh in wei (SEAR token units)
    uint256 public rewardPerWhWei = 1e12;

    /// @notice Slash percentage in basis points (e.g., 1000 = 10%)
    uint256 public slashBps = 1000;

    /// @notice Fault threshold before slashing
    uint256 public faultThreshold = 3;

    /// @notice Flag to disable slashing (for baseline mode)
    bool public slashingDisabled;

    /// @notice Mapping of verifier address to fault count
    mapping(address => uint256) public verifierFaults;

    /// @notice Mapping of verifier address to pending rewards
    mapping(address => uint256) public pendingRewards;

    /// @notice Mapping of verifier address to slashed status
    mapping(address => bool) public isSlashed;


    // ============ Events ============

    /// @notice Emitted when rewards are distributed to winning verifiers
    event RewardsDistributed(uint16 winnerBitmap, uint256 snapshotId, uint256 totalReward);

    /// @notice Emitted when a fault is recorded for a verifier
    event FaultRecorded(address indexed verifier, FaultType faultType, uint256 totalFaults);

    /// @notice Emitted when a verifier is slashed
    event Slashed(address indexed verifier, uint256 amount);

    /// @notice Emitted when tokens are deposited to the reward pool
    event Deposited(address indexed depositor, uint256 amount);

    /// @notice Emitted when tokens are withdrawn from the reward pool
    event Withdrawn(address indexed recipient, uint256 amount);

    /// @notice Emitted when slashing is enabled/disabled
    event SlashingDisabledUpdated(bool disabled);

    /// @notice Emitted when reward per Wh is updated
    event RewardPerWhWeiUpdated(uint256 oldValue, uint256 newValue);

    /// @notice Emitted when slash bps is updated
    event SlashBpsUpdated(uint256 oldValue, uint256 newValue);

    /// @notice Emitted when fault threshold is updated
    event FaultThresholdUpdated(uint256 oldValue, uint256 newValue);

    // ============ Errors ============

    /// @notice Error when caller is not an authorized oracle
    error OnlyAuthorizedOracle(address caller);

    /// @notice Error when address is zero
    error ZeroAddress();

    /// @notice Error when amount is zero
    error ZeroAmount();

    /// @notice Error when insufficient reward pool balance
    error InsufficientRewardPool(uint256 required, uint256 available);

    /// @notice Error when fault threshold not reached for slashing
    error FaultThresholdNotReached(address verifier, uint256 faults, uint256 threshold);

    /// @notice Error when verifier already slashed
    error AlreadySlashed(address verifier);

    /// @notice Error when withdrawal amount exceeds pool balance
    error InsufficientPoolBalance(uint256 requested, uint256 available);

    // ============ Constructor ============

    /**
     * @dev Constructor sets the SEAR token and initial owner
     * @param _searToken The SEAR token contract address
     * @param _registry The Registry contract address
     * @param initialOwner The address that will own the contract
     */
    constructor(address _searToken, address _registry, address initialOwner) Ownable(initialOwner) {
        if (_searToken == address(0)) revert ZeroAddress();
        if (_registry == address(0)) revert ZeroAddress();
        searToken = IERC20(_searToken);
        registry = _registry;
    }

    // ============ Modifiers ============

    modifier onlyAuthorizedOracle() {
        if (msg.sender != productionOracle && msg.sender != consumptionOracle) {
            revert OnlyAuthorizedOracle(msg.sender);
        }
        _;
    }


    // ============ Reward Distribution Functions ============

    /**
     * @notice Distribute rewards to winning verifiers
     * @dev Called by oracles after claim finalization
     * @param winnerBitmap Bitmap where bit i = 1 if verifier at snapshot index i won
     * @param snapshotId The snapshot ID to resolve verifier addresses
     * @param energyWh The energy amount in Wh for reward calculation
     */
    function distributeRewards(uint16 winnerBitmap, uint256 snapshotId, uint64 energyWh) external onlyAuthorizedOracle {
        // Count winners from bitmap
        uint256 winnerCount = _popcount(winnerBitmap);
        
        // Skip if no winners
        if (winnerCount == 0) {
            emit RewardsDistributed(winnerBitmap, snapshotId, 0);
            return;
        }
        
        // Calculate total reward
        uint256 totalReward = uint256(energyWh) * rewardPerWhWei;
        
        // Skip if no reward to distribute
        if (totalReward == 0) {
            emit RewardsDistributed(winnerBitmap, snapshotId, 0);
            return;
        }
        
        // Check reward pool has sufficient balance
        if (rewardPool < totalReward) {
            revert InsufficientRewardPool(totalReward, rewardPool);
        }
        
        // Calculate reward per winner
        uint256 rewardPerWinner = totalReward / winnerCount;
        
        // Get snapshot verifiers from Registry
        address[] memory verifiers = IRegistry(registry).getSnapshotVerifiers(snapshotId);
        
        // Distribute rewards to winners
        uint256 distributed = 0;
        for (uint256 i = 0; i < verifiers.length && i < 16; i++) {
            if ((winnerBitmap & (1 << i)) != 0) {
                pendingRewards[verifiers[i]] += rewardPerWinner;
                distributed += rewardPerWinner;
            }
        }
        
        // Deduct from reward pool
        rewardPool -= distributed;
        
        emit RewardsDistributed(winnerBitmap, snapshotId, distributed);
    }

    /**
     * @notice Claim pending rewards
     * @dev Transfers accumulated rewards to the caller
     */
    function claimRewards() external {
        uint256 amount = pendingRewards[msg.sender];
        if (amount == 0) revert ZeroAmount();
        
        pendingRewards[msg.sender] = 0;
        searToken.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Get pending rewards for a verifier
     * @param verifier The verifier address
     * @return The pending reward amount
     */
    function getPendingRewards(address verifier) external view returns (uint256) {
        return pendingRewards[verifier];
    }


    // ============ Fault Recording and Slashing Functions ============

    /**
     * @notice Record a single fault for a verifier
     * @dev Called by oracles for signature errors, late submissions, etc.
     * @param verifier The verifier address
     * @param faultType The type of fault
     */
    function recordFault(address verifier, FaultType faultType) external onlyAuthorizedOracle {
        verifierFaults[verifier]++;
        emit FaultRecorded(verifier, faultType, verifierFaults[verifier]);
        
        // Auto-slash if threshold reached and slashing is enabled
        if (!slashingDisabled && verifierFaults[verifier] >= faultThreshold && !isSlashed[verifier]) {
            _slash(verifier);
        }
    }

    /**
     * @notice Record faults for multiple verifiers (batch)
     * @dev Called by oracles after finalization for non-winners
     * @param loserBitmap Bitmap where bit i = 1 if verifier at snapshot index i lost
     * @param snapshotId The snapshot ID to resolve verifier addresses
     * @param faultType The type of fault
     */
    function recordFaults(uint16 loserBitmap, uint256 snapshotId, FaultType faultType) external onlyAuthorizedOracle {
        // Skip if no losers
        if (loserBitmap == 0) {
            return;
        }
        
        // Get snapshot verifiers from Registry
        address[] memory verifiers = IRegistry(registry).getSnapshotVerifiers(snapshotId);
        
        // Record faults for losers
        for (uint256 i = 0; i < verifiers.length && i < 16; i++) {
            if ((loserBitmap & (1 << i)) != 0) {
                address verifier = verifiers[i];
                verifierFaults[verifier]++;
                emit FaultRecorded(verifier, faultType, verifierFaults[verifier]);
                
                // Auto-slash if threshold reached and slashing is enabled
                if (!slashingDisabled && verifierFaults[verifier] >= faultThreshold && !isSlashed[verifier]) {
                    _slash(verifier);
                }
            }
        }
    }

    /**
     * @notice Manually slash a verifier
     * @dev Can be called by owner or when fault threshold is reached
     * @param verifier The verifier address to slash
     */
    function slash(address verifier) external {
        // Check fault threshold is reached
        if (verifierFaults[verifier] < faultThreshold) {
            revert FaultThresholdNotReached(verifier, verifierFaults[verifier], faultThreshold);
        }
        
        // Check not already slashed
        if (isSlashed[verifier]) {
            revert AlreadySlashed(verifier);
        }
        
        // Check slashing is enabled
        if (slashingDisabled) {
            return;
        }
        
        _slash(verifier);
    }

    /**
     * @dev Internal function to perform slashing
     * @param verifier The verifier address to slash
     */
    function _slash(address verifier) internal {
        // Mark as slashed
        isSlashed[verifier] = true;
        
        // Get verifier stake from Registry
        IRegistry reg = IRegistry(registry);
        uint256 stake = reg.getVerifier(verifier).stake;
        
        // Calculate slash amount
        uint256 slashAmount = (stake * slashBps) / 10000;
        
        if (slashAmount > 0) {
            // Reduce stake in Registry
            reg.reduceStake(verifier, slashAmount);
            
            // Add slashed amount to reward pool
            rewardPool += slashAmount;
        }
        
        emit Slashed(verifier, slashAmount);
    }

    /**
     * @notice Get fault count for a verifier
     * @param verifier The verifier address
     * @return The fault count
     */
    function getFaults(address verifier) external view returns (uint256) {
        return verifierFaults[verifier];
    }


    // ============ Pool Management Functions ============

    /**
     * @notice Deposit SEAR tokens to the reward pool
     * @param amount The amount to deposit
     */
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        
        searToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardPool += amount;
        
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw SEAR tokens from the reward pool
     * @dev Only owner can withdraw
     * @param amount The amount to withdraw
     */
    function withdraw(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (amount > rewardPool) {
            revert InsufficientPoolBalance(amount, rewardPool);
        }
        
        rewardPool -= amount;
        searToken.safeTransfer(msg.sender, amount);
        
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Get the current reward pool balance
     * @return The reward pool balance
     */
    function getRewardPool() external view returns (uint256) {
        return rewardPool;
    }

    // ============ Configuration Functions ============

    /**
     * @notice Set the production oracle address
     * @param oracle The production oracle contract address
     */
    function setProductionOracle(address oracle) external onlyOwner {
        productionOracle = oracle;
    }

    /**
     * @notice Set the consumption oracle address
     * @param oracle The consumption oracle contract address
     */
    function setConsumptionOracle(address oracle) external onlyOwner {
        consumptionOracle = oracle;
    }

    /**
     * @notice Enable or disable slashing (for baseline mode)
     * @param disabled True to disable slashing
     */
    function setDisableSlashing(bool disabled) external onlyOwner {
        slashingDisabled = disabled;
        emit SlashingDisabledUpdated(disabled);
    }

    /**
     * @notice Check if slashing is disabled
     * @return True if slashing is disabled
     */
    function isSlashingDisabled() external view returns (bool) {
        return slashingDisabled;
    }

    /**
     * @notice Set the reward per Wh in wei
     * @param weiPerWh The new reward rate
     */
    function setRewardPerWhWei(uint256 weiPerWh) external onlyOwner {
        uint256 oldValue = rewardPerWhWei;
        rewardPerWhWei = weiPerWh;
        emit RewardPerWhWeiUpdated(oldValue, weiPerWh);
    }

    /**
     * @notice Set the slash percentage in basis points
     * @param bps The new slash percentage
     */
    function setSlashBps(uint256 bps) external onlyOwner {
        uint256 oldValue = slashBps;
        slashBps = bps;
        emit SlashBpsUpdated(oldValue, bps);
    }

    /**
     * @notice Set the fault threshold
     * @param threshold The new fault threshold
     */
    function setFaultThreshold(uint256 threshold) external onlyOwner {
        uint256 oldValue = faultThreshold;
        faultThreshold = threshold;
        emit FaultThresholdUpdated(oldValue, threshold);
    }

    // ============ Internal Helper Functions ============

    /**
     * @dev Count the number of set bits in a uint16 (population count)
     * @param bitmap The bitmap to count
     * @return count The number of set bits
     */
    function _popcount(uint16 bitmap) internal pure returns (uint256 count) {
        while (bitmap != 0) {
            count += bitmap & 1;
            bitmap >>= 1;
        }
    }
}

// ============ Interface for Registry ============

interface IRegistry {
    struct Verifier {
        uint256 stake;
        uint256 faults;
        bool active;
        bool allowlisted;
    }
    
    function getSnapshotVerifiers(uint256 snapshotId) external view returns (address[] memory);
    function getVerifier(address verifier) external view returns (Verifier memory);
    function reduceStake(address verifier, uint256 amount) external;
    function incrementFaults(address verifier) external;
}
