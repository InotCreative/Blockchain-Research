// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SEARToken
 * @dev ERC-20 token for SEARChain economic functions: staking, rewards, payments.
 * Only the Treasury contract can mint new tokens.
 * Supports burnFrom for slashing operations.
 */
contract SEARToken is ERC20, Ownable {
    /// @notice Address of the Treasury contract authorized to mint tokens
    address public treasury;

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Error when caller is not the treasury
    error OnlyTreasury(address caller, address treasury);

    /// @notice Error when treasury address is zero
    error ZeroAddress();

    /// @notice Error when burn amount exceeds allowance
    error InsufficientAllowance(uint256 required, uint256 actual);

    /**
     * @dev Constructor sets the token name and symbol
     * @param initialOwner The address that will own the contract
     */
    constructor(address initialOwner) ERC20("SEAR Token", "SEAR") Ownable(initialOwner) {}

    /**
     * @dev Modifier to restrict function access to treasury only
     */
    modifier onlyTreasury() {
        if (msg.sender != treasury) {
            revert OnlyTreasury(msg.sender, treasury);
        }
        _;
    }

    /**
     * @notice Set the treasury address that can mint tokens
     * @param _treasury The new treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) {
            revert ZeroAddress();
        }
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /**
     * @notice Mint new tokens (restricted to Treasury)
     * @param to The address to receive the minted tokens
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) external onlyTreasury {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from an account (for slashing)
     * @dev Requires allowance from the token holder
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burnFrom(address from, uint256 amount) external {
        uint256 currentAllowance = allowance(from, msg.sender);
        if (currentAllowance < amount) {
            revert InsufficientAllowance(amount, currentAllowance);
        }
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}
