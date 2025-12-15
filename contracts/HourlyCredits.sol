// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HourlyCredits
 * @dev ERC-1155 token representing verified energy production.
 * tokenId = hourId, where hourId = floor(unix_timestamp / 3600)
 * 1 token unit = 1 Wh of verified energy production
 * 
 * Only ProductionOracle can mint (after verification consensus)
 * Only Retirement contract can burn (for credit retirement)
 */
contract HourlyCredits is ERC1155, Ownable {
    /// @notice Address of the ProductionOracle contract authorized to mint tokens
    address public productionOracle;

    /// @notice Address of the Retirement contract authorized to burn tokens
    address public retirement;

    /// @notice Emitted when HCN tokens are minted with provenance tracking
    /// @param hourId The hour identifier (tokenId)
    /// @param to The recipient address
    /// @param amountWh The amount in Wh
    /// @param claimKey The claim key for audit traceability
    event HCNMinted(uint256 indexed hourId, address indexed to, uint256 amountWh, bytes32 indexed claimKey);

    /// @notice Emitted when the ProductionOracle address is updated
    event ProductionOracleUpdated(address indexed oldOracle, address indexed newOracle);

    /// @notice Emitted when the Retirement address is updated
    event RetirementUpdated(address indexed oldRetirement, address indexed newRetirement);

    /// @notice Error when caller is not the ProductionOracle
    error OnlyProductionOracle(address caller, address productionOracle);

    /// @notice Error when caller is not the Retirement contract
    error OnlyRetirement(address caller, address retirement);

    /// @notice Error when address is zero
    error ZeroAddress();

    /**
     * @dev Constructor sets the token URI and initial owner
     * @param initialOwner The address that will own the contract
     */
    constructor(address initialOwner) ERC1155("") Ownable(initialOwner) {}


    /**
     * @dev Modifier to restrict function access to ProductionOracle only
     */
    modifier onlyProductionOracle() {
        if (msg.sender != productionOracle) {
            revert OnlyProductionOracle(msg.sender, productionOracle);
        }
        _;
    }

    /**
     * @dev Modifier to restrict function access to Retirement contract only
     */
    modifier onlyRetirement() {
        if (msg.sender != retirement) {
            revert OnlyRetirement(msg.sender, retirement);
        }
        _;
    }

    /**
     * @notice Set the ProductionOracle address that can mint tokens
     * @param _productionOracle The new ProductionOracle address
     */
    function setProductionOracle(address _productionOracle) external onlyOwner {
        if (_productionOracle == address(0)) {
            revert ZeroAddress();
        }
        address oldOracle = productionOracle;
        productionOracle = _productionOracle;
        emit ProductionOracleUpdated(oldOracle, _productionOracle);
    }

    /**
     * @notice Set the Retirement address that can burn tokens
     * @param _retirement The new Retirement address
     */
    function setRetirement(address _retirement) external onlyOwner {
        if (_retirement == address(0)) {
            revert ZeroAddress();
        }
        address oldRetirement = retirement;
        retirement = _retirement;
        emit RetirementUpdated(oldRetirement, _retirement);
    }

    /**
     * @notice Mint HCN tokens for verified energy production
     * @dev Only callable by ProductionOracle after consensus finalization
     * @param to The address to receive the minted tokens (producer's payout address)
     * @param hourId The hour identifier (tokenId = floor(unix_timestamp / 3600))
     * @param amountWh The amount of energy in Wh to mint
     * @param claimKey The claim key for audit traceability
     */
    function mint(address to, uint256 hourId, uint256 amountWh, bytes32 claimKey) external onlyProductionOracle {
        _mint(to, hourId, amountWh, "");
        emit HCNMinted(hourId, to, amountWh, claimKey);
    }

    /**
     * @notice Burn HCN tokens for retirement
     * @dev Only callable by Retirement contract
     * @param from The address to burn tokens from
     * @param hourId The hour identifier (tokenId)
     * @param amountWh The amount of energy in Wh to burn
     */
    function burn(address from, uint256 hourId, uint256 amountWh) external onlyRetirement {
        _burn(from, hourId, amountWh);
    }
}
