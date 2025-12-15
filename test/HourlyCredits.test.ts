import { expect } from "chai";
import { ethers } from "hardhat";
import { HourlyCredits } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("HourlyCredits", function () {
  let hourlyCredits: HourlyCredits;
  let owner: HardhatEthersSigner;
  let productionOracle: HardhatEthersSigner;
  let retirement: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Sample test data
  const hourId = 500000; // Example hourId
  const amountWh = 5000n; // 5 kWh
  const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

  beforeEach(async function () {
    [owner, productionOracle, retirement, user1, user2] = await ethers.getSigners();
    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await hourlyCredits.owner()).to.equal(owner.address);
    });

    it("should have productionOracle as zero address initially", async function () {
      expect(await hourlyCredits.productionOracle()).to.equal(ethers.ZeroAddress);
    });

    it("should have retirement as zero address initially", async function () {
      expect(await hourlyCredits.retirement()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("setProductionOracle", function () {
    it("should allow owner to set productionOracle", async function () {
      await expect(hourlyCredits.connect(owner).setProductionOracle(productionOracle.address))
        .to.emit(hourlyCredits, "ProductionOracleUpdated")
        .withArgs(ethers.ZeroAddress, productionOracle.address);
      expect(await hourlyCredits.productionOracle()).to.equal(productionOracle.address);
    });

    it("should revert if non-owner tries to set productionOracle", async function () {
      await expect(hourlyCredits.connect(user1).setProductionOracle(productionOracle.address))
        .to.be.revertedWithCustomError(hourlyCredits, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting productionOracle to zero address", async function () {
      await expect(hourlyCredits.connect(owner).setProductionOracle(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(hourlyCredits, "ZeroAddress");
    });
  });


  describe("setRetirement", function () {
    it("should allow owner to set retirement", async function () {
      await expect(hourlyCredits.connect(owner).setRetirement(retirement.address))
        .to.emit(hourlyCredits, "RetirementUpdated")
        .withArgs(ethers.ZeroAddress, retirement.address);
      expect(await hourlyCredits.retirement()).to.equal(retirement.address);
    });

    it("should revert if non-owner tries to set retirement", async function () {
      await expect(hourlyCredits.connect(user1).setRetirement(retirement.address))
        .to.be.revertedWithCustomError(hourlyCredits, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting retirement to zero address", async function () {
      await expect(hourlyCredits.connect(owner).setRetirement(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(hourlyCredits, "ZeroAddress");
    });
  });

  describe("mint", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(owner).setProductionOracle(productionOracle.address);
    });

    it("should allow productionOracle to mint tokens", async function () {
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh);
    });

    it("should emit HCNMinted event with claimKey", async function () {
      await expect(hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey))
        .to.emit(hourlyCredits, "HCNMinted")
        .withArgs(hourId, user1.address, amountWh, claimKey);
    });

    it("should revert if non-productionOracle tries to mint", async function () {
      await expect(hourlyCredits.connect(owner).mint(user1.address, hourId, amountWh, claimKey))
        .to.be.revertedWithCustomError(hourlyCredits, "OnlyProductionOracle");
    });

    it("should revert if user tries to mint", async function () {
      await expect(hourlyCredits.connect(user1).mint(user1.address, hourId, amountWh, claimKey))
        .to.be.revertedWithCustomError(hourlyCredits, "OnlyProductionOracle");
    });

    it("should allow minting to different hourIds", async function () {
      const hourId2 = hourId + 1;
      const claimKey2 = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key-2"));
      
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, amountWh * 2n, claimKey2);
      
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh);
      expect(await hourlyCredits.balanceOf(user1.address, hourId2)).to.equal(amountWh * 2n);
    });

    it("should accumulate balance when minting same hourId multiple times", async function () {
      const claimKey2 = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key-2"));
      
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey2);
      
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh * 2n);
    });
  });


  describe("burn", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(owner).setProductionOracle(productionOracle.address);
      await hourlyCredits.connect(owner).setRetirement(retirement.address);
      // Mint some tokens first
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
    });

    it("should allow retirement to burn tokens", async function () {
      const burnAmount = 2000n;
      await hourlyCredits.connect(retirement).burn(user1.address, hourId, burnAmount);
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh - burnAmount);
    });

    it("should allow retirement to burn all tokens", async function () {
      await hourlyCredits.connect(retirement).burn(user1.address, hourId, amountWh);
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(0);
    });

    it("should revert if non-retirement tries to burn", async function () {
      await expect(hourlyCredits.connect(owner).burn(user1.address, hourId, amountWh))
        .to.be.revertedWithCustomError(hourlyCredits, "OnlyRetirement");
    });

    it("should revert if user tries to burn", async function () {
      await expect(hourlyCredits.connect(user1).burn(user1.address, hourId, amountWh))
        .to.be.revertedWithCustomError(hourlyCredits, "OnlyRetirement");
    });

    it("should revert if burning more than balance", async function () {
      await expect(hourlyCredits.connect(retirement).burn(user1.address, hourId, amountWh + 1n))
        .to.be.revertedWithCustomError(hourlyCredits, "ERC1155InsufficientBalance");
    });
  });

  describe("ERC-1155 Compliance", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(owner).setProductionOracle(productionOracle.address);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
    });

    it("should return correct balanceOf", async function () {
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh);
      expect(await hourlyCredits.balanceOf(user2.address, hourId)).to.equal(0);
    });

    it("should transfer tokens via safeTransferFrom", async function () {
      const transferAmount = 2000n;
      await hourlyCredits.connect(user1).safeTransferFrom(user1.address, user2.address, hourId, transferAmount, "0x");
      
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh - transferAmount);
      expect(await hourlyCredits.balanceOf(user2.address, hourId)).to.equal(transferAmount);
    });

    it("should emit TransferSingle event on transfer", async function () {
      const transferAmount = 2000n;
      await expect(hourlyCredits.connect(user1).safeTransferFrom(user1.address, user2.address, hourId, transferAmount, "0x"))
        .to.emit(hourlyCredits, "TransferSingle")
        .withArgs(user1.address, user1.address, user2.address, hourId, transferAmount);
    });

    it("should allow approved operator to transfer", async function () {
      await hourlyCredits.connect(user1).setApprovalForAll(user2.address, true);
      expect(await hourlyCredits.isApprovedForAll(user1.address, user2.address)).to.be.true;
      
      const transferAmount = 2000n;
      await hourlyCredits.connect(user2).safeTransferFrom(user1.address, user2.address, hourId, transferAmount, "0x");
      
      expect(await hourlyCredits.balanceOf(user2.address, hourId)).to.equal(transferAmount);
    });

    it("should revert transfer without approval", async function () {
      const transferAmount = 2000n;
      await expect(hourlyCredits.connect(user2).safeTransferFrom(user1.address, user2.address, hourId, transferAmount, "0x"))
        .to.be.revertedWithCustomError(hourlyCredits, "ERC1155MissingApprovalForAll");
    });

    it("should revert transfer if insufficient balance", async function () {
      const transferAmount = amountWh + 1n;
      await expect(hourlyCredits.connect(user1).safeTransferFrom(user1.address, user2.address, hourId, transferAmount, "0x"))
        .to.be.revertedWithCustomError(hourlyCredits, "ERC1155InsufficientBalance");
    });

    it("should support batch balance queries", async function () {
      const hourId2 = hourId + 1;
      const claimKey2 = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key-2"));
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, amountWh * 2n, claimKey2);
      
      const balances = await hourlyCredits.balanceOfBatch(
        [user1.address, user1.address],
        [hourId, hourId2]
      );
      
      expect(balances[0]).to.equal(amountWh);
      expect(balances[1]).to.equal(amountWh * 2n);
    });

    it("should support batch transfers", async function () {
      const hourId2 = hourId + 1;
      const claimKey2 = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key-2"));
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, amountWh * 2n, claimKey2);
      
      await hourlyCredits.connect(user1).safeBatchTransferFrom(
        user1.address,
        user2.address,
        [hourId, hourId2],
        [1000n, 2000n],
        "0x"
      );
      
      expect(await hourlyCredits.balanceOf(user2.address, hourId)).to.equal(1000n);
      expect(await hourlyCredits.balanceOf(user2.address, hourId2)).to.equal(2000n);
    });
  });
});
