import { expect } from "chai";
import { ethers } from "hardhat";
import { Matcher, HourlyCredits, SEARToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Matcher", function () {
  let matcher: Matcher;
  let hourlyCredits: HourlyCredits;
  let searToken: SEARToken;
  let mockConsumptionOracle: MockConsumptionOracle;
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let producer: HardhatEthersSigner;
  let consumer: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  // Sample test data
  const hourId = 500000n;
  const amountWh = 5000n; // 5 kWh
  const pricePerWh = ethers.parseEther("0.001"); // 0.001 SEAR per Wh
  const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));
  const consumerId = ethers.keccak256(ethers.toUtf8Bytes("consumer-1"));

  // Mock ConsumptionOracle contract
  let MockConsumptionOracleFactory: any;

  beforeEach(async function () {
    [owner, treasury, producer, consumer, user1] = await ethers.getSigners();

    // Deploy mock ConsumptionOracle
    MockConsumptionOracleFactory = await ethers.getContractFactory("MockConsumptionOracle");
    mockConsumptionOracle = await MockConsumptionOracleFactory.deploy();
    await mockConsumptionOracle.waitForDeployment();

    // Deploy HourlyCredits
    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();

    // Deploy SEARToken
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    // Deploy Matcher
    const MatcherFactory = await ethers.getContractFactory("Matcher");
    matcher = await MatcherFactory.deploy(
      await mockConsumptionOracle.getAddress(),
      await hourlyCredits.getAddress(),
      await searToken.getAddress(),
      treasury.address,
      owner.address
    );
    await matcher.waitForDeployment();

    // Setup: Set matcher as production oracle to mint HCN for testing
    await hourlyCredits.connect(owner).setProductionOracle(owner.address);
    
    // Mint HCN to producer
    await hourlyCredits.connect(owner).mint(producer.address, hourId, amountWh, claimKey);

    // Setup: Set treasury as SEAR minter and mint tokens to consumer
    await searToken.connect(owner).setTreasury(owner.address);
    await searToken.connect(owner).mint(consumer.address, ethers.parseEther("1000"));
  });


  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await matcher.owner()).to.equal(owner.address);
    });

    it("should set the correct consumptionOracle", async function () {
      expect(await matcher.consumptionOracle()).to.equal(await mockConsumptionOracle.getAddress());
    });

    it("should set the correct hourlyCredits", async function () {
      expect(await matcher.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should set the correct searToken", async function () {
      expect(await matcher.searToken()).to.equal(await searToken.getAddress());
    });

    it("should set the correct treasury", async function () {
      expect(await matcher.treasury()).to.equal(treasury.address);
    });

    it("should have zero protocol fee initially", async function () {
      expect(await matcher.getProtocolFeeBps()).to.equal(0);
    });

    it("should start with listing ID 1", async function () {
      expect(await matcher.nextListingId()).to.equal(1);
    });
  });

  describe("Listing Creation", function () {
    beforeEach(async function () {
      // Approve matcher to transfer HCN
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
    });

    it("should create a listing successfully", async function () {
      await expect(matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh))
        .to.emit(matcher, "CreditListed")
        .withArgs(1, producer.address, hourId, amountWh, pricePerWh);

      const listing = await matcher.getListing(1);
      expect(listing.seller).to.equal(producer.address);
      expect(listing.hourId).to.equal(hourId);
      expect(listing.amountWh).to.equal(amountWh);
      expect(listing.pricePerWh).to.equal(pricePerWh);
      expect(listing.active).to.be.true;
    });

    it("should transfer HCN to matcher (escrow)", async function () {
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
      
      expect(await hourlyCredits.balanceOf(producer.address, hourId)).to.equal(0);
      expect(await hourlyCredits.balanceOf(await matcher.getAddress(), hourId)).to.equal(amountWh);
    });

    it("should increment listing ID", async function () {
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
      expect(await matcher.nextListingId()).to.equal(2);
    });

    it("should revert if amount is zero", async function () {
      await expect(matcher.connect(producer).listCredits(hourId, 0, pricePerWh))
        .to.be.revertedWithCustomError(matcher, "ZeroAmount");
    });

    it("should revert if seller has insufficient balance", async function () {
      await expect(matcher.connect(producer).listCredits(hourId, amountWh + 1n, pricePerWh))
        .to.be.revertedWithCustomError(matcher, "InsufficientSellerBalance");
    });

    it("should allow multiple listings from same seller", async function () {
      // Mint more HCN
      await hourlyCredits.connect(owner).mint(producer.address, hourId + 1n, amountWh, claimKey);
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);

      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
      await matcher.connect(producer).listCredits(hourId + 1n, amountWh, pricePerWh);

      expect(await matcher.nextListingId()).to.equal(3);
    });
  });

  describe("Listing Cancellation", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
    });

    it("should cancel listing and return HCN to seller", async function () {
      await expect(matcher.connect(producer).cancelListing(1))
        .to.emit(matcher, "ListingCancelled")
        .withArgs(1, producer.address);

      const listing = await matcher.getListing(1);
      expect(listing.active).to.be.false;
      expect(await hourlyCredits.balanceOf(producer.address, hourId)).to.equal(amountWh);
    });

    it("should revert if listing is not active", async function () {
      await matcher.connect(producer).cancelListing(1);
      await expect(matcher.connect(producer).cancelListing(1))
        .to.be.revertedWithCustomError(matcher, "ListingNotActive");
    });

    it("should revert if caller is not the seller", async function () {
      await expect(matcher.connect(consumer).cancelListing(1))
        .to.be.revertedWithCustomError(matcher, "NotListingSeller");
    });
  });


  describe("Buying Credits", function () {
    beforeEach(async function () {
      // Setup listing
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);

      // Setup verified consumption
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, hourId, amountWh);

      // Approve SEAR spending
      await searToken.connect(consumer).approve(await matcher.getAddress(), ethers.parseEther("1000"));
    });

    it("should buy credits successfully", async function () {
      const buyAmount = 2000n;
      const totalPrice = buyAmount * pricePerWh;

      const producerBalanceBefore = await searToken.balanceOf(producer.address);

      await expect(matcher.connect(consumer).buyCredits(1, buyAmount, consumerId))
        .to.emit(matcher, "Matched")
        .withArgs(hourId, consumerId, producer.address, buyAmount, totalPrice);

      // Check HCN transferred to consumer
      expect(await hourlyCredits.balanceOf(consumer.address, hourId)).to.equal(buyAmount);

      // Check SEAR transferred to producer
      expect(await searToken.balanceOf(producer.address)).to.equal(producerBalanceBefore + totalPrice);

      // Check listing updated
      const listing = await matcher.getListing(1);
      expect(listing.amountWh).to.equal(amountWh - buyAmount);
      expect(listing.active).to.be.true;
    });

    it("should deactivate listing when fully bought", async function () {
      await matcher.connect(consumer).buyCredits(1, amountWh, consumerId);

      const listing = await matcher.getListing(1);
      expect(listing.amountWh).to.equal(0);
      expect(listing.active).to.be.false;
    });

    it("should track matched amount", async function () {
      const buyAmount = 2000n;
      await matcher.connect(consumer).buyCredits(1, buyAmount, consumerId);

      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(buyAmount);
    });

    it("should revert if amount is zero", async function () {
      await expect(matcher.connect(consumer).buyCredits(1, 0, consumerId))
        .to.be.revertedWithCustomError(matcher, "ZeroAmount");
    });

    it("should revert if listing is not active", async function () {
      await matcher.connect(producer).cancelListing(1);
      await expect(matcher.connect(consumer).buyCredits(1, 1000n, consumerId))
        .to.be.revertedWithCustomError(matcher, "ListingNotActive");
    });

    it("should revert if requesting more than available", async function () {
      await expect(matcher.connect(consumer).buyCredits(1, amountWh + 1n, consumerId))
        .to.be.revertedWithCustomError(matcher, "InsufficientCredits");
    });

    it("should revert if consumption not verified", async function () {
      const unverifiedConsumerId = ethers.keccak256(ethers.toUtf8Bytes("unverified"));
      await expect(matcher.connect(consumer).buyCredits(1, 1000n, unverifiedConsumerId))
        .to.be.revertedWithCustomError(matcher, "ConsumptionNotVerified");
    });

    it("should revert if match exceeds verified consumption", async function () {
      // Set lower verified consumption
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, hourId, 1000n);

      await expect(matcher.connect(consumer).buyCredits(1, 2000n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });
  });

  describe("Double-Match Prevention", function () {
    beforeEach(async function () {
      // Mint more HCN to producer for this test (10000 Wh total)
      await hourlyCredits.connect(owner).mint(producer.address, hourId, 5000n, claimKey);
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      // List 10000 Wh (original 5000 + additional 5000)
      await matcher.connect(producer).listCredits(hourId, 10000n, pricePerWh);
      // Set verified consumption to 5000 Wh
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, hourId, 5000n);
      await searToken.connect(consumer).approve(await matcher.getAddress(), ethers.parseEther("1000"));
    });

    it("should prevent matching more than verified consumption across multiple buys", async function () {
      // First buy - 3000 Wh
      await matcher.connect(consumer).buyCredits(1, 3000n, consumerId);
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(3000n);

      // Second buy - should fail as it would exceed 5000 Wh verified (3000 + 2001 > 5000)
      await expect(matcher.connect(consumer).buyCredits(1, 2001n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });

    it("should allow matching up to exact verified consumption", async function () {
      await matcher.connect(consumer).buyCredits(1, 3000n, consumerId);
      await matcher.connect(consumer).buyCredits(1, 2000n, consumerId);

      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(5000n);
    });

    it("should track remaining consumption correctly", async function () {
      expect(await matcher.getRemainingConsumption(consumerId, hourId)).to.equal(5000n);

      await matcher.connect(consumer).buyCredits(1, 2000n, consumerId);
      expect(await matcher.getRemainingConsumption(consumerId, hourId)).to.equal(3000n);

      await matcher.connect(consumer).buyCredits(1, 3000n, consumerId);
      expect(await matcher.getRemainingConsumption(consumerId, hourId)).to.equal(0);
    });
  });


  describe("Direct Matching", function () {
    beforeEach(async function () {
      // Producer approves matcher for HCN transfers
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      
      // Setup verified consumption
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, hourId, amountWh);

      // Consumer approves SEAR spending
      await searToken.connect(consumer).approve(await matcher.getAddress(), ethers.parseEther("1000"));
    });

    it("should execute direct match successfully", async function () {
      const matchAmount = 2000n;
      const agreedPrice = ethers.parseEther("5"); // Total price

      const producerBalanceBefore = await searToken.balanceOf(producer.address);

      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, matchAmount, agreedPrice))
        .to.emit(matcher, "Matched")
        .withArgs(hourId, consumerId, producer.address, matchAmount, agreedPrice);

      // Check HCN transferred
      expect(await hourlyCredits.balanceOf(consumer.address, hourId)).to.equal(matchAmount);
      expect(await hourlyCredits.balanceOf(producer.address, hourId)).to.equal(amountWh - matchAmount);

      // Check SEAR transferred
      expect(await searToken.balanceOf(producer.address)).to.equal(producerBalanceBefore + agreedPrice);
    });

    it("should track matched amount for direct match", async function () {
      await matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, 2000n, ethers.parseEther("5"));
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(2000n);
    });

    it("should revert if amount is zero", async function () {
      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, 0, ethers.parseEther("5")))
        .to.be.revertedWithCustomError(matcher, "ZeroAmount");
    });

    it("should revert if producer is zero address", async function () {
      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, ethers.ZeroAddress, 1000n, ethers.parseEther("5")))
        .to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should revert if consumption not verified", async function () {
      const unverifiedConsumerId = ethers.keccak256(ethers.toUtf8Bytes("unverified"));
      await expect(matcher.connect(consumer).directMatch(hourId, unverifiedConsumerId, producer.address, 1000n, ethers.parseEther("5")))
        .to.be.revertedWithCustomError(matcher, "ConsumptionNotVerified");
    });

    it("should revert if match exceeds verified consumption", async function () {
      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, amountWh + 1n, ethers.parseEther("10")))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });

    it("should revert if producer has insufficient balance", async function () {
      // Try to match more than producer has
      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, user1.address, 1000n, ethers.parseEther("5")))
        .to.be.revertedWithCustomError(matcher, "InsufficientSellerBalance");
    });

    it("should prevent double-matching via direct match", async function () {
      await matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, 3000n, ethers.parseEther("5"));
      
      await expect(matcher.connect(consumer).directMatch(hourId, consumerId, producer.address, 2001n, ethers.parseEther("5")))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });
  });

  describe("Protocol Fee", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, hourId, amountWh);
      await searToken.connect(consumer).approve(await matcher.getAddress(), ethers.parseEther("1000"));
    });

    it("should allow owner to set protocol fee", async function () {
      await matcher.connect(owner).setProtocolFeeBps(100); // 1%
      expect(await matcher.getProtocolFeeBps()).to.equal(100);
    });

    it("should revert if non-owner tries to set protocol fee", async function () {
      await expect(matcher.connect(consumer).setProtocolFeeBps(100))
        .to.be.revertedWithCustomError(matcher, "OwnableUnauthorizedAccount");
    });

    it("should deduct protocol fee from payment", async function () {
      await matcher.connect(owner).setProtocolFeeBps(100); // 1%

      const buyAmount = 1000n;
      const totalPrice = buyAmount * pricePerWh;
      const expectedFee = totalPrice / 100n; // 1%
      const expectedSellerPayment = totalPrice - expectedFee;

      const producerBalanceBefore = await searToken.balanceOf(producer.address);
      const treasuryBalanceBefore = await searToken.balanceOf(treasury.address);

      await expect(matcher.connect(consumer).buyCredits(1, buyAmount, consumerId))
        .to.emit(matcher, "ProtocolFeeCollected")
        .withArgs(1, expectedFee);

      expect(await searToken.balanceOf(producer.address)).to.equal(producerBalanceBefore + expectedSellerPayment);
      expect(await searToken.balanceOf(treasury.address)).to.equal(treasuryBalanceBefore + expectedFee);
    });

    it("should apply protocol fee to direct match", async function () {
      await matcher.connect(owner).setProtocolFeeBps(200); // 2%
      
      // Mint fresh HCN to producer for direct match (listing already took the original HCN)
      const directMatchHourId = hourId + 1n;
      await hourlyCredits.connect(owner).mint(producer.address, directMatchHourId, 5000n, claimKey);
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      
      // Set verified consumption for the new hourId
      await mockConsumptionOracle.setVerifiedConsumption(consumerId, directMatchHourId, 5000n);

      const agreedPrice = ethers.parseEther("10");
      const expectedFee = agreedPrice / 50n; // 2%
      const expectedSellerPayment = agreedPrice - expectedFee;

      const producerBalanceBefore = await searToken.balanceOf(producer.address);
      const treasuryBalanceBefore = await searToken.balanceOf(treasury.address);

      await expect(matcher.connect(consumer).directMatch(directMatchHourId, consumerId, producer.address, 1000n, agreedPrice))
        .to.emit(matcher, "ProtocolFeeCollected")
        .withArgs(0, expectedFee); // listingId = 0 for direct match

      expect(await searToken.balanceOf(producer.address)).to.equal(producerBalanceBefore + expectedSellerPayment);
      expect(await searToken.balanceOf(treasury.address)).to.equal(treasuryBalanceBefore + expectedFee);
    });

    it("should handle zero protocol fee", async function () {
      // Fee is 0 by default
      const buyAmount = 1000n;
      const totalPrice = buyAmount * pricePerWh;

      const producerBalanceBefore = await searToken.balanceOf(producer.address);
      const treasuryBalanceBefore = await searToken.balanceOf(treasury.address);

      await matcher.connect(consumer).buyCredits(1, buyAmount, consumerId);

      expect(await searToken.balanceOf(producer.address)).to.equal(producerBalanceBefore + totalPrice);
      expect(await searToken.balanceOf(treasury.address)).to.equal(treasuryBalanceBefore); // No fee
    });
  });


  describe("Configuration Functions", function () {
    it("should allow owner to set consumptionOracle", async function () {
      const newOracle = user1.address;
      await matcher.connect(owner).setConsumptionOracle(newOracle);
      expect(await matcher.consumptionOracle()).to.equal(newOracle);
    });

    it("should revert if setting consumptionOracle to zero address", async function () {
      await expect(matcher.connect(owner).setConsumptionOracle(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should allow owner to set hourlyCredits", async function () {
      const newHCN = user1.address;
      await matcher.connect(owner).setHourlyCredits(newHCN);
      expect(await matcher.hourlyCredits()).to.equal(newHCN);
    });

    it("should revert if setting hourlyCredits to zero address", async function () {
      await expect(matcher.connect(owner).setHourlyCredits(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should allow owner to set searToken", async function () {
      const newToken = user1.address;
      await matcher.connect(owner).setSearToken(newToken);
      expect(await matcher.searToken()).to.equal(newToken);
    });

    it("should revert if setting searToken to zero address", async function () {
      await expect(matcher.connect(owner).setSearToken(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should allow owner to set treasury", async function () {
      const newTreasury = user1.address;
      await matcher.connect(owner).setTreasury(newTreasury);
      expect(await matcher.treasury()).to.equal(newTreasury);
    });

    it("should revert if setting treasury to zero address", async function () {
      await expect(matcher.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should revert if non-owner tries to set configuration", async function () {
      await expect(matcher.connect(consumer).setConsumptionOracle(user1.address))
        .to.be.revertedWithCustomError(matcher, "OwnableUnauthorizedAccount");
      await expect(matcher.connect(consumer).setHourlyCredits(user1.address))
        .to.be.revertedWithCustomError(matcher, "OwnableUnauthorizedAccount");
      await expect(matcher.connect(consumer).setSearToken(user1.address))
        .to.be.revertedWithCustomError(matcher, "OwnableUnauthorizedAccount");
      await expect(matcher.connect(consumer).setTreasury(user1.address))
        .to.be.revertedWithCustomError(matcher, "OwnableUnauthorizedAccount");
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(producer).setApprovalForAll(await matcher.getAddress(), true);
      await matcher.connect(producer).listCredits(hourId, amountWh, pricePerWh);
    });

    it("should return correct listing details", async function () {
      const listing = await matcher.getListing(1);
      expect(listing.seller).to.equal(producer.address);
      expect(listing.hourId).to.equal(hourId);
      expect(listing.amountWh).to.equal(amountWh);
      expect(listing.pricePerWh).to.equal(pricePerWh);
      expect(listing.active).to.be.true;
    });

    it("should return zero for non-existent listing", async function () {
      const listing = await matcher.getListing(999);
      expect(listing.seller).to.equal(ethers.ZeroAddress);
      expect(listing.amountWh).to.equal(0);
      expect(listing.active).to.be.false;
    });

    it("should return zero matched amount for unmatched consumer/hour", async function () {
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(0);
    });

    it("should return zero remaining consumption for unverified consumer", async function () {
      const unverifiedConsumerId = ethers.keccak256(ethers.toUtf8Bytes("unverified"));
      expect(await matcher.getRemainingConsumption(unverifiedConsumerId, hourId)).to.equal(0);
    });
  });
});

// Mock ConsumptionOracle interface for TypeScript
interface MockConsumptionOracle {
  getAddress(): Promise<string>;
  setVerifiedConsumption(consumerId: string, hourId: bigint, energyWh: bigint): Promise<any>;
  getVerifiedConsumption(consumerId: string, hourId: bigint): Promise<bigint>;
}
