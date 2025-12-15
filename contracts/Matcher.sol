// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/**
 * @title Matcher
 * @dev Handles 24/7 hourly matching between production credits (HCN) and consumption.
 * Producers can list their HCN credits for sale, and consumers can buy them
 * after their consumption has been verified by the ConsumptionOracle.
 */
contract Matcher is Ownable, ERC1155Holder {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct Listing {
        address seller;
        uint256 hourId;
        uint64 amountWh;
        uint256 pricePerWh;    // Price in SEAR wei per Wh
        bool active;
    }

    // ============ State Variables ============

    /// @notice ConsumptionOracle contract for verifying consumption
    IConsumptionOracle public consumptionOracle;

    /// @notice HourlyCredits (HCN) ERC-1155 contract
    IERC1155 public hourlyCredits;

    /// @notice SEAR token for payments
    IERC20 public searToken;

    /// @notice Treasury contract for protocol fees
    address public treasury;

    /// @notice Protocol fee in basis points (e.g., 100 = 1%)
    uint256 public protocolFeeBps;

    /// @notice Counter for listing IDs
    uint256 public nextListingId = 1;

    /// @notice Mapping of listingId to Listing
    mapping(uint256 => Listing) private _listings;

    /// @notice Mapping of consumerId => hourId => matched amount
    mapping(bytes32 => mapping(uint256 => uint64)) private _matchedAmount;


    // ============ Events ============

    /// @notice Emitted when credits are listed for sale
    event CreditListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 hourId,
        uint64 amountWh,
        uint256 pricePerWh
    );

    /// @notice Emitted when a listing is cancelled
    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    /// @notice Emitted when credits are matched (bought)
    event Matched(
        uint256 indexed hourId,
        bytes32 indexed consumerId,
        address indexed producer,
        uint64 amountWh,
        uint256 totalPrice
    );

    /// @notice Emitted when protocol fee is collected
    event ProtocolFeeCollected(uint256 indexed listingId, uint256 feeAmount);

    // ============ Errors ============

    /// @notice Error when address is zero
    error ZeroAddress();

    /// @notice Error when amount is zero
    error ZeroAmount();

    /// @notice Error when listing is not active
    error ListingNotActive(uint256 listingId);

    /// @notice Error when caller is not the listing seller
    error NotListingSeller(uint256 listingId, address caller, address seller);

    /// @notice Error when insufficient credits in listing
    error InsufficientCredits(uint256 listingId, uint64 requested, uint64 available);

    /// @notice Error when consumption is not verified
    error ConsumptionNotVerified(bytes32 consumerId, uint256 hourId);

    /// @notice Error when match would exceed verified consumption
    error MatchExceedsConsumption(bytes32 consumerId, uint256 hourId, uint64 matched, uint64 verified);

    /// @notice Error when seller has insufficient HCN balance
    error InsufficientSellerBalance(address seller, uint256 hourId, uint64 required, uint256 available);

    // ============ Constructor ============

    /**
     * @dev Constructor sets the contract dependencies
     * @param _consumptionOracle The ConsumptionOracle contract address
     * @param _hourlyCredits The HourlyCredits (HCN) contract address
     * @param _searToken The SEAR token contract address
     * @param _treasury The Treasury contract address
     * @param initialOwner The address that will own the contract
     */
    constructor(
        address _consumptionOracle,
        address _hourlyCredits,
        address _searToken,
        address _treasury,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_consumptionOracle == address(0)) revert ZeroAddress();
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        if (_searToken == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        consumptionOracle = IConsumptionOracle(_consumptionOracle);
        hourlyCredits = IERC1155(_hourlyCredits);
        searToken = IERC20(_searToken);
        treasury = _treasury;
    }

    // ============ Listing Functions ============

    /**
     * @notice List HCN credits for sale
     * @dev Seller must have approved this contract for HCN transfers
     * @param hourId The hour identifier for the credits
     * @param amountWh The amount of credits in Wh to list
     * @param pricePerWh The price per Wh in SEAR wei
     * @return listingId The ID of the created listing
     */
    function listCredits(uint256 hourId, uint64 amountWh, uint256 pricePerWh) external returns (uint256 listingId) {
        if (amountWh == 0) revert ZeroAmount();

        // Check seller has sufficient balance
        uint256 balance = hourlyCredits.balanceOf(msg.sender, hourId);
        if (balance < amountWh) {
            revert InsufficientSellerBalance(msg.sender, hourId, amountWh, balance);
        }

        // Transfer HCN to this contract (escrow)
        hourlyCredits.safeTransferFrom(msg.sender, address(this), hourId, amountWh, "");

        // Create listing
        listingId = nextListingId++;
        _listings[listingId] = Listing({
            seller: msg.sender,
            hourId: hourId,
            amountWh: amountWh,
            pricePerWh: pricePerWh,
            active: true
        });

        emit CreditListed(listingId, msg.sender, hourId, amountWh, pricePerWh);
    }

    /**
     * @notice Cancel a listing and return credits to seller
     * @param listingId The ID of the listing to cancel
     */
    function cancelListing(uint256 listingId) external {
        Listing storage listing = _listings[listingId];

        if (!listing.active) {
            revert ListingNotActive(listingId);
        }

        if (listing.seller != msg.sender) {
            revert NotListingSeller(listingId, msg.sender, listing.seller);
        }

        // Mark as inactive
        listing.active = false;

        // Return HCN to seller
        hourlyCredits.safeTransferFrom(address(this), listing.seller, listing.hourId, listing.amountWh, "");

        emit ListingCancelled(listingId, msg.sender);
    }


    // ============ Buying/Matching Functions ============

    /**
     * @notice Buy credits from a listing
     * @dev Buyer must have approved this contract for SEAR transfers.
     *      Buyer must have verified consumption for the hour.
     * @param listingId The ID of the listing to buy from
     * @param amountWh The amount of credits in Wh to buy
     * @param consumerId The consumer identifier for consumption verification
     */
    function buyCredits(uint256 listingId, uint64 amountWh, bytes32 consumerId) external {
        if (amountWh == 0) revert ZeroAmount();

        Listing storage listing = _listings[listingId];

        if (!listing.active) {
            revert ListingNotActive(listingId);
        }

        if (amountWh > listing.amountWh) {
            revert InsufficientCredits(listingId, amountWh, listing.amountWh);
        }

        // Verify consumption
        uint64 verifiedConsumption = consumptionOracle.getVerifiedConsumption(consumerId, listing.hourId);
        if (verifiedConsumption == 0) {
            revert ConsumptionNotVerified(consumerId, listing.hourId);
        }

        // Check match doesn't exceed verified consumption
        uint64 alreadyMatched = _matchedAmount[consumerId][listing.hourId];
        if (alreadyMatched + amountWh > verifiedConsumption) {
            revert MatchExceedsConsumption(consumerId, listing.hourId, alreadyMatched + amountWh, verifiedConsumption);
        }

        // Calculate payment
        uint256 totalPrice = uint256(amountWh) * listing.pricePerWh;
        uint256 protocolFee = (totalPrice * protocolFeeBps) / 10000;
        uint256 sellerPayment = totalPrice - protocolFee;

        // Update matched amount
        _matchedAmount[consumerId][listing.hourId] = alreadyMatched + amountWh;

        // Update listing
        listing.amountWh -= amountWh;
        if (listing.amountWh == 0) {
            listing.active = false;
        }

        // Transfer SEAR from buyer to seller
        if (sellerPayment > 0) {
            searToken.safeTransferFrom(msg.sender, listing.seller, sellerPayment);
        }

        // Transfer protocol fee to treasury
        if (protocolFee > 0) {
            searToken.safeTransferFrom(msg.sender, treasury, protocolFee);
            emit ProtocolFeeCollected(listingId, protocolFee);
        }

        // Transfer HCN from escrow to buyer
        hourlyCredits.safeTransferFrom(address(this), msg.sender, listing.hourId, amountWh, "");

        emit Matched(listing.hourId, consumerId, listing.seller, amountWh, totalPrice);
    }

    /**
     * @notice Direct match between producer and consumer (off-market)
     * @dev Producer must have approved this contract for HCN transfers.
     *      Buyer must have approved this contract for SEAR transfers.
     * @param hourId The hour identifier
     * @param consumerId The consumer identifier for consumption verification
     * @param producer The producer address to buy from
     * @param amountWh The amount of credits in Wh to match
     * @param agreedPrice The agreed total price in SEAR wei
     */
    function directMatch(
        uint256 hourId,
        bytes32 consumerId,
        address producer,
        uint64 amountWh,
        uint256 agreedPrice
    ) external {
        if (amountWh == 0) revert ZeroAmount();
        if (producer == address(0)) revert ZeroAddress();

        // Verify consumption
        uint64 verifiedConsumption = consumptionOracle.getVerifiedConsumption(consumerId, hourId);
        if (verifiedConsumption == 0) {
            revert ConsumptionNotVerified(consumerId, hourId);
        }

        // Check match doesn't exceed verified consumption
        uint64 alreadyMatched = _matchedAmount[consumerId][hourId];
        if (alreadyMatched + amountWh > verifiedConsumption) {
            revert MatchExceedsConsumption(consumerId, hourId, alreadyMatched + amountWh, verifiedConsumption);
        }

        // Check producer has sufficient balance
        uint256 balance = hourlyCredits.balanceOf(producer, hourId);
        if (balance < amountWh) {
            revert InsufficientSellerBalance(producer, hourId, amountWh, balance);
        }

        // Calculate protocol fee
        uint256 protocolFee = (agreedPrice * protocolFeeBps) / 10000;
        uint256 sellerPayment = agreedPrice - protocolFee;

        // Update matched amount
        _matchedAmount[consumerId][hourId] = alreadyMatched + amountWh;

        // Transfer SEAR from buyer to producer
        if (sellerPayment > 0) {
            searToken.safeTransferFrom(msg.sender, producer, sellerPayment);
        }

        // Transfer protocol fee to treasury
        if (protocolFee > 0) {
            searToken.safeTransferFrom(msg.sender, treasury, protocolFee);
            emit ProtocolFeeCollected(0, protocolFee); // listingId = 0 for direct match
        }

        // Transfer HCN from producer to buyer
        hourlyCredits.safeTransferFrom(producer, msg.sender, hourId, amountWh, "");

        emit Matched(hourId, consumerId, producer, amountWh, agreedPrice);
    }


    // ============ View Functions ============

    /**
     * @notice Get listing details
     * @param listingId The listing ID
     * @return The listing struct
     */
    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    /**
     * @notice Get matched amount for a consumer and hour
     * @param consumerId The consumer identifier
     * @param hourId The hour identifier
     * @return The matched amount in Wh
     */
    function getMatchedAmount(bytes32 consumerId, uint256 hourId) external view returns (uint64) {
        return _matchedAmount[consumerId][hourId];
    }

    /**
     * @notice Get remaining consumption that can be matched
     * @param consumerId The consumer identifier
     * @param hourId The hour identifier
     * @return The remaining consumption in Wh (0 if not verified)
     */
    function getRemainingConsumption(bytes32 consumerId, uint256 hourId) external view returns (uint64) {
        uint64 verified = consumptionOracle.getVerifiedConsumption(consumerId, hourId);
        uint64 matched = _matchedAmount[consumerId][hourId];
        
        if (verified <= matched) {
            return 0;
        }
        return verified - matched;
    }

    /**
     * @notice Get the protocol fee in basis points
     * @return The protocol fee in basis points
     */
    function getProtocolFeeBps() external view returns (uint256) {
        return protocolFeeBps;
    }

    // ============ Configuration Functions ============

    /**
     * @notice Set the protocol fee in basis points
     * @param feeBps The new protocol fee (e.g., 100 = 1%)
     */
    function setProtocolFeeBps(uint256 feeBps) external onlyOwner {
        protocolFeeBps = feeBps;
    }

    /**
     * @notice Set the ConsumptionOracle contract address
     * @param _consumptionOracle The new ConsumptionOracle address
     */
    function setConsumptionOracle(address _consumptionOracle) external onlyOwner {
        if (_consumptionOracle == address(0)) revert ZeroAddress();
        consumptionOracle = IConsumptionOracle(_consumptionOracle);
    }

    /**
     * @notice Set the HourlyCredits contract address
     * @param _hourlyCredits The new HourlyCredits address
     */
    function setHourlyCredits(address _hourlyCredits) external onlyOwner {
        if (_hourlyCredits == address(0)) revert ZeroAddress();
        hourlyCredits = IERC1155(_hourlyCredits);
    }

    /**
     * @notice Set the SEAR token contract address
     * @param _searToken The new SEAR token address
     */
    function setSearToken(address _searToken) external onlyOwner {
        if (_searToken == address(0)) revert ZeroAddress();
        searToken = IERC20(_searToken);
    }

    /**
     * @notice Set the Treasury contract address
     * @param _treasury The new Treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }
}

// ============ Interface for ConsumptionOracle ============

interface IConsumptionOracle {
    function getVerifiedConsumption(bytes32 consumerId, uint256 hourId) external view returns (uint64);
}
