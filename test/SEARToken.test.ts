import { expect } from "chai";
import { ethers } from "hardhat";
import { SEARToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SEARToken", function () {
  let searToken: SEARToken;
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, treasury, user1, user2] = await ethers.getSigners();
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set the correct name and symbol", async function () {
      expect(await searToken.name()).to.equal("SEAR Token");
      expect(await searToken.symbol()).to.equal("SEAR");
    });

    it("should set the correct owner", async function () {
      expect(await searToken.owner()).to.equal(owner.address);
    });

    it("should have zero initial supply", async function () {
      expect(await searToken.totalSupply()).to.equal(0);
    });

    it("should have treasury as zero address initially", async function () {
      expect(await searToken.treasury()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("setTreasury", function () {
    it("should allow owner to set treasury", async function () {
      await expect(searToken.connect(owner).setTreasury(treasury.address))
        .to.emit(searToken, "TreasuryUpdated")
        .withArgs(ethers.ZeroAddress, treasury.address);
      expect(await searToken.treasury()).to.equal(treasury.address);
    });

    it("should revert if non-owner tries to set treasury", async function () {
      await expect(searToken.connect(user1).setTreasury(treasury.address))
        .to.be.revertedWithCustomError(searToken, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting treasury to zero address", async function () {
      await expect(searToken.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(searToken, "ZeroAddress");
    });
  });


  describe("mint", function () {
    beforeEach(async function () {
      await searToken.connect(owner).setTreasury(treasury.address);
    });

    it("should allow treasury to mint tokens", async function () {
      const mintAmount = ethers.parseEther("1000");
      await searToken.connect(treasury).mint(user1.address, mintAmount);
      expect(await searToken.balanceOf(user1.address)).to.equal(mintAmount);
      expect(await searToken.totalSupply()).to.equal(mintAmount);
    });

    it("should revert if non-treasury tries to mint", async function () {
      const mintAmount = ethers.parseEther("1000");
      await expect(searToken.connect(owner).mint(user1.address, mintAmount))
        .to.be.revertedWithCustomError(searToken, "OnlyTreasury");
    });

    it("should revert if user tries to mint", async function () {
      const mintAmount = ethers.parseEther("1000");
      await expect(searToken.connect(user1).mint(user1.address, mintAmount))
        .to.be.revertedWithCustomError(searToken, "OnlyTreasury");
    });
  });

  describe("burnFrom", function () {
    const initialBalance = ethers.parseEther("1000");

    beforeEach(async function () {
      await searToken.connect(owner).setTreasury(treasury.address);
      await searToken.connect(treasury).mint(user1.address, initialBalance);
    });

    it("should allow burning with approval", async function () {
      const burnAmount = ethers.parseEther("100");
      await searToken.connect(user1).approve(user2.address, burnAmount);
      await searToken.connect(user2).burnFrom(user1.address, burnAmount);
      expect(await searToken.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
    });

    it("should revert if burning without approval", async function () {
      const burnAmount = ethers.parseEther("100");
      await expect(searToken.connect(user2).burnFrom(user1.address, burnAmount))
        .to.be.revertedWithCustomError(searToken, "InsufficientAllowance");
    });

    it("should revert if burning more than allowance", async function () {
      const approveAmount = ethers.parseEther("50");
      const burnAmount = ethers.parseEther("100");
      await searToken.connect(user1).approve(user2.address, approveAmount);
      await expect(searToken.connect(user2).burnFrom(user1.address, burnAmount))
        .to.be.revertedWithCustomError(searToken, "InsufficientAllowance");
    });
  });

  describe("ERC-20 Compliance", function () {
    const initialBalance = ethers.parseEther("1000");

    beforeEach(async function () {
      await searToken.connect(owner).setTreasury(treasury.address);
      await searToken.connect(treasury).mint(user1.address, initialBalance);
    });

    it("should transfer tokens correctly", async function () {
      const transferAmount = ethers.parseEther("100");
      await searToken.connect(user1).transfer(user2.address, transferAmount);
      expect(await searToken.balanceOf(user1.address)).to.equal(initialBalance - transferAmount);
      expect(await searToken.balanceOf(user2.address)).to.equal(transferAmount);
    });

    it("should approve and transferFrom correctly", async function () {
      const approveAmount = ethers.parseEther("200");
      const transferAmount = ethers.parseEther("150");
      
      await searToken.connect(user1).approve(user2.address, approveAmount);
      expect(await searToken.allowance(user1.address, user2.address)).to.equal(approveAmount);
      
      await searToken.connect(user2).transferFrom(user1.address, user2.address, transferAmount);
      expect(await searToken.balanceOf(user2.address)).to.equal(transferAmount);
      expect(await searToken.allowance(user1.address, user2.address)).to.equal(approveAmount - transferAmount);
    });

    it("should emit Transfer event on transfer", async function () {
      const transferAmount = ethers.parseEther("100");
      await expect(searToken.connect(user1).transfer(user2.address, transferAmount))
        .to.emit(searToken, "Transfer")
        .withArgs(user1.address, user2.address, transferAmount);
    });

    it("should emit Approval event on approve", async function () {
      const approveAmount = ethers.parseEther("200");
      await expect(searToken.connect(user1).approve(user2.address, approveAmount))
        .to.emit(searToken, "Approval")
        .withArgs(user1.address, user2.address, approveAmount);
    });
  });
});
