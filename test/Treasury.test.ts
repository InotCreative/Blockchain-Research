import { expect } from "chai";
import { ethers } from "hardhat";
import { Treasury, SEARToken, Registry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Treasury", function () {
  let treasury: Treasury;
  let searToken: SEARToken;
  let registry: Registry;
  let owner: HardhatEthersSigner;
  let productionOracle: HardhatEthersSigner;
  let consumptionOracle: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  const INITIAL_POOL = ethers.parseEther("10000");
  const MIN_STAKE = ethers.parseEther("100");

  beforeEach(async function () {
    [owner, productionOracle, consumptionOracle, verifier1, verifier2, verifier3, user1] = await ethers.getSigners();

    // Deploy SEARToken
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    // Deploy Registry
    const RegistryFactory = await ethers.getContractFactory("Registry");
    registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
    await registry.waitForDeployment();

    // Deploy Treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(
      await searToken.getAddress(),
      await registry.getAddress(),
      owner.address
    );
    await treasury.waitForDeployment();

    // Set Treasury as the minter for SEARToken
    await searToken.connect(owner).setTreasury(await treasury.getAddress());

    // Set oracles in Treasury
    await treasury.connect(owner).setProductionOracle(productionOracle.address);
    await treasury.connect(owner).setConsumptionOracle(consumptionOracle.address);

    // Set oracles in Registry for snapshot creation
    await registry.connect(owner).setProductionOracle(productionOracle.address);
    await registry.connect(owner).setConsumptionOracle(consumptionOracle.address);
  });

  describe("Deployment", function () {
    it("should set the correct SEAR token address", async function () {
      expect(await treasury.searToken()).to.equal(await searToken.getAddress());
    });

    it("should set the correct registry address", async function () {
      expect(await treasury.registry()).to.equal(await registry.getAddress());
    });

    it("should set the correct owner", async function () {
      expect(await treasury.owner()).to.equal(owner.address);
    });

    it("should have zero initial reward pool", async function () {
      expect(await treasury.getRewardPool()).to.equal(0);
    });

    it("should have default reward per Wh", async function () {
      expect(await treasury.rewardPerWhWei()).to.equal(BigInt(1e12));
    });

    it("should have default slash bps", async function () {
      expect(await treasury.slashBps()).to.equal(1000);
    });

    it("should have default fault threshold", async function () {
      expect(await treasury.faultThreshold()).to.equal(3);
    });

    it("should have slashing enabled by default", async function () {
      expect(await treasury.isSlashingDisabled()).to.equal(false);
    });
  });


  describe("Pool Management", function () {
    beforeEach(async function () {
      // Mint tokens to owner for depositing
      // First, temporarily set owner as treasury to mint
      const tempTreasury = await treasury.getAddress();
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(owner.address, INITIAL_POOL);
      await searToken.connect(owner).setTreasury(tempTreasury);
      
      // Approve treasury to spend tokens
      await searToken.connect(owner).approve(await treasury.getAddress(), INITIAL_POOL);
    });

    describe("deposit", function () {
      it("should allow depositing tokens to reward pool", async function () {
        const depositAmount = ethers.parseEther("1000");
        await expect(treasury.connect(owner).deposit(depositAmount))
          .to.emit(treasury, "Deposited")
          .withArgs(owner.address, depositAmount);
        
        expect(await treasury.getRewardPool()).to.equal(depositAmount);
      });

      it("should revert if depositing zero amount", async function () {
        await expect(treasury.connect(owner).deposit(0))
          .to.be.revertedWithCustomError(treasury, "ZeroAmount");
      });

      it("should allow multiple deposits", async function () {
        const deposit1 = ethers.parseEther("500");
        const deposit2 = ethers.parseEther("300");
        
        await treasury.connect(owner).deposit(deposit1);
        await treasury.connect(owner).deposit(deposit2);
        
        expect(await treasury.getRewardPool()).to.equal(deposit1 + deposit2);
      });
    });

    describe("withdraw", function () {
      beforeEach(async function () {
        await treasury.connect(owner).deposit(INITIAL_POOL);
      });

      it("should allow owner to withdraw from reward pool", async function () {
        const withdrawAmount = ethers.parseEther("500");
        const initialBalance = await searToken.balanceOf(owner.address);
        
        await expect(treasury.connect(owner).withdraw(withdrawAmount))
          .to.emit(treasury, "Withdrawn")
          .withArgs(owner.address, withdrawAmount);
        
        expect(await treasury.getRewardPool()).to.equal(INITIAL_POOL - withdrawAmount);
        expect(await searToken.balanceOf(owner.address)).to.equal(initialBalance + withdrawAmount);
      });

      it("should revert if non-owner tries to withdraw", async function () {
        await expect(treasury.connect(user1).withdraw(ethers.parseEther("100")))
          .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      });

      it("should revert if withdrawing zero amount", async function () {
        await expect(treasury.connect(owner).withdraw(0))
          .to.be.revertedWithCustomError(treasury, "ZeroAmount");
      });

      it("should revert if withdrawing more than pool balance", async function () {
        const excessAmount = INITIAL_POOL + ethers.parseEther("1");
        await expect(treasury.connect(owner).withdraw(excessAmount))
          .to.be.revertedWithCustomError(treasury, "InsufficientPoolBalance");
      });
    });
  });


  describe("Reward Distribution", function () {
    let snapshotId: bigint;
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

    beforeEach(async function () {
      // Setup: Fund treasury pool
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(owner.address, INITIAL_POOL);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());
      await searToken.connect(owner).approve(await treasury.getAddress(), INITIAL_POOL);
      await treasury.connect(owner).deposit(INITIAL_POOL);

      // Setup verifiers with stake
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(verifier1.address, MIN_STAKE);
      await searToken.connect(owner).mint(verifier2.address, MIN_STAKE);
      await searToken.connect(owner).mint(verifier3.address, MIN_STAKE);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());

      // Stake and activate verifiers
      await searToken.connect(verifier1).approve(await registry.getAddress(), MIN_STAKE);
      await searToken.connect(verifier2).approve(await registry.getAddress(), MIN_STAKE);
      await searToken.connect(verifier3).approve(await registry.getAddress(), MIN_STAKE);

      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(owner).addToAllowlist(verifier2.address);
      await registry.connect(owner).addToAllowlist(verifier3.address);

      await registry.connect(verifier1).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier2).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier3).stakeAsVerifier(MIN_STAKE);

      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier2).activateVerifier();
      await registry.connect(verifier3).activateVerifier();

      // Create snapshot
      const tx = await registry.connect(productionOracle).createSnapshot(claimKey);
      const receipt = await tx.wait();
      snapshotId = BigInt(1); // First snapshot
    });

    it("should distribute rewards to winning verifiers", async function () {
      const energyWh = BigInt(1000); // 1000 Wh
      const rewardPerWh = await treasury.rewardPerWhWei();
      const totalReward = energyWh * rewardPerWh;
      
      // Winner bitmap: verifier1 (bit 0) and verifier2 (bit 1) won
      // Verifiers are sorted by address, so we need to check the order
      const snapshotVerifiers = await registry.getSnapshotVerifiers(snapshotId);
      
      // Create bitmap for first two verifiers in snapshot
      const winnerBitmap = 0b011; // bits 0 and 1 set
      
      const poolBefore = await treasury.getRewardPool();
      
      await expect(treasury.connect(productionOracle).distributeRewards(winnerBitmap, snapshotId, energyWh))
        .to.emit(treasury, "RewardsDistributed");
      
      const poolAfter = await treasury.getRewardPool();
      expect(poolBefore - poolAfter).to.equal(totalReward);
      
      // Each winner gets half
      const rewardPerWinner = totalReward / BigInt(2);
      expect(await treasury.getPendingRewards(snapshotVerifiers[0])).to.equal(rewardPerWinner);
      expect(await treasury.getPendingRewards(snapshotVerifiers[1])).to.equal(rewardPerWinner);
    });

    it("should handle winnerCount == 0 case (skip rewards)", async function () {
      const energyWh = BigInt(1000);
      const winnerBitmap = 0; // No winners
      
      const poolBefore = await treasury.getRewardPool();
      
      await expect(treasury.connect(productionOracle).distributeRewards(winnerBitmap, snapshotId, energyWh))
        .to.emit(treasury, "RewardsDistributed")
        .withArgs(0, snapshotId, 0);
      
      // Pool should remain unchanged
      expect(await treasury.getRewardPool()).to.equal(poolBefore);
    });

    it("should handle zero energy (no rewards)", async function () {
      const energyWh = BigInt(0);
      const winnerBitmap = 0b011;
      
      const poolBefore = await treasury.getRewardPool();
      
      await treasury.connect(productionOracle).distributeRewards(winnerBitmap, snapshotId, energyWh);
      
      expect(await treasury.getRewardPool()).to.equal(poolBefore);
    });

    it("should revert if non-oracle tries to distribute rewards", async function () {
      await expect(treasury.connect(user1).distributeRewards(0b011, snapshotId, 1000))
        .to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
    });

    it("should revert if insufficient reward pool", async function () {
      // Withdraw most of the pool
      await treasury.connect(owner).withdraw(INITIAL_POOL - ethers.parseEther("1"));
      
      // Try to distribute more than available
      const largeEnergy = BigInt(1e18); // Very large energy amount
      await expect(treasury.connect(productionOracle).distributeRewards(0b001, snapshotId, largeEnergy))
        .to.be.revertedWithCustomError(treasury, "InsufficientRewardPool");
    });

    it("should allow consumption oracle to distribute rewards", async function () {
      const energyWh = BigInt(500);
      const winnerBitmap = 0b001;
      
      await expect(treasury.connect(consumptionOracle).distributeRewards(winnerBitmap, snapshotId, energyWh))
        .to.emit(treasury, "RewardsDistributed");
    });
  });


  describe("Fault Recording", function () {
    let snapshotId: bigint;
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

    beforeEach(async function () {
      // Setup verifiers with stake
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(verifier1.address, MIN_STAKE);
      await searToken.connect(owner).mint(verifier2.address, MIN_STAKE);
      await searToken.connect(owner).mint(verifier3.address, MIN_STAKE);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());

      // Stake and activate verifiers
      await searToken.connect(verifier1).approve(await registry.getAddress(), MIN_STAKE);
      await searToken.connect(verifier2).approve(await registry.getAddress(), MIN_STAKE);
      await searToken.connect(verifier3).approve(await registry.getAddress(), MIN_STAKE);

      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(owner).addToAllowlist(verifier2.address);
      await registry.connect(owner).addToAllowlist(verifier3.address);

      await registry.connect(verifier1).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier2).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier3).stakeAsVerifier(MIN_STAKE);

      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier2).activateVerifier();
      await registry.connect(verifier3).activateVerifier();

      // Create snapshot
      await registry.connect(productionOracle).createSnapshot(claimKey);
      snapshotId = BigInt(1);
    });

    describe("recordFault (single)", function () {
      it("should record a single fault for a verifier", async function () {
        await expect(treasury.connect(productionOracle).recordFault(verifier1.address, 0)) // WrongValue
          .to.emit(treasury, "FaultRecorded")
          .withArgs(verifier1.address, 0, 1);
        
        expect(await treasury.getFaults(verifier1.address)).to.equal(1);
      });

      it("should increment fault count on multiple faults", async function () {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
        await treasury.connect(productionOracle).recordFault(verifier1.address, 1); // InvalidSignature
        
        expect(await treasury.getFaults(verifier1.address)).to.equal(2);
      });

      it("should record different fault types", async function () {
        // Test all fault types
        await expect(treasury.connect(productionOracle).recordFault(verifier1.address, 0))
          .to.emit(treasury, "FaultRecorded").withArgs(verifier1.address, 0, 1); // WrongValue
        
        await expect(treasury.connect(productionOracle).recordFault(verifier1.address, 1))
          .to.emit(treasury, "FaultRecorded").withArgs(verifier1.address, 1, 2); // InvalidSignature
        
        await expect(treasury.connect(productionOracle).recordFault(verifier1.address, 2))
          .to.emit(treasury, "FaultRecorded").withArgs(verifier1.address, 2, 3); // DuplicateSubmission
      });

      it("should revert if non-oracle tries to record fault", async function () {
        await expect(treasury.connect(user1).recordFault(verifier1.address, 0))
          .to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
      });
    });

    describe("recordFaults (batch)", function () {
      it("should record faults for multiple verifiers", async function () {
        const snapshotVerifiers = await registry.getSnapshotVerifiers(snapshotId);
        
        // Loser bitmap: verifiers at index 0 and 2
        const loserBitmap = 0b101;
        
        await treasury.connect(productionOracle).recordFaults(loserBitmap, snapshotId, 0);
        
        expect(await treasury.getFaults(snapshotVerifiers[0])).to.equal(1);
        expect(await treasury.getFaults(snapshotVerifiers[1])).to.equal(0); // Not in loser bitmap
        expect(await treasury.getFaults(snapshotVerifiers[2])).to.equal(1);
      });

      it("should skip if loser bitmap is zero", async function () {
        const snapshotVerifiers = await registry.getSnapshotVerifiers(snapshotId);
        
        await treasury.connect(productionOracle).recordFaults(0, snapshotId, 0);
        
        // No faults should be recorded
        expect(await treasury.getFaults(snapshotVerifiers[0])).to.equal(0);
        expect(await treasury.getFaults(snapshotVerifiers[1])).to.equal(0);
        expect(await treasury.getFaults(snapshotVerifiers[2])).to.equal(0);
      });

      it("should revert if non-oracle tries to record batch faults", async function () {
        await expect(treasury.connect(user1).recordFaults(0b011, snapshotId, 0))
          .to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
      });
    });
  });


  describe("Slashing", function () {
    let snapshotId: bigint;
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

    beforeEach(async function () {
      // Setup verifiers with stake
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(verifier1.address, MIN_STAKE);
      await searToken.connect(owner).mint(verifier2.address, MIN_STAKE);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());

      // Stake and activate verifiers
      await searToken.connect(verifier1).approve(await registry.getAddress(), MIN_STAKE);
      await searToken.connect(verifier2).approve(await registry.getAddress(), MIN_STAKE);

      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(owner).addToAllowlist(verifier2.address);

      await registry.connect(verifier1).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier2).stakeAsVerifier(MIN_STAKE);

      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier2).activateVerifier();

      // Create snapshot
      await registry.connect(productionOracle).createSnapshot(claimKey);
      snapshotId = BigInt(1);
    });

    it("should auto-slash when fault threshold is reached", async function () {
      const faultThreshold = await treasury.faultThreshold();
      const slashBps = await treasury.slashBps();
      const expectedSlash = (MIN_STAKE * slashBps) / BigInt(10000);
      
      // Record faults up to threshold
      for (let i = 0; i < Number(faultThreshold); i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Verifier should be slashed
      expect(await treasury.isSlashed(verifier1.address)).to.equal(true);
      
      // Stake should be reduced
      const verifierData = await registry.getVerifier(verifier1.address);
      expect(verifierData.stake).to.equal(MIN_STAKE - expectedSlash);
      
      // Slashed amount should be added to reward pool
      expect(await treasury.getRewardPool()).to.equal(expectedSlash);
    });

    it("should emit Slashed event when slashing", async function () {
      const faultThreshold = await treasury.faultThreshold();
      const slashBps = await treasury.slashBps();
      const expectedSlash = (MIN_STAKE * slashBps) / BigInt(10000);
      
      // Record faults up to threshold - 1
      for (let i = 0; i < Number(faultThreshold) - 1; i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Last fault should trigger slash
      await expect(treasury.connect(productionOracle).recordFault(verifier1.address, 0))
        .to.emit(treasury, "Slashed")
        .withArgs(verifier1.address, expectedSlash);
    });

    it("should allow manual slash when threshold reached", async function () {
      const faultThreshold = await treasury.faultThreshold();
      
      // Disable auto-slash temporarily
      await treasury.connect(owner).setDisableSlashing(true);
      
      // Record faults up to threshold
      for (let i = 0; i < Number(faultThreshold); i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Re-enable slashing
      await treasury.connect(owner).setDisableSlashing(false);
      
      // Manual slash should work
      await expect(treasury.slash(verifier1.address))
        .to.emit(treasury, "Slashed");
      
      expect(await treasury.isSlashed(verifier1.address)).to.equal(true);
    });

    it("should revert manual slash if threshold not reached", async function () {
      await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      
      await expect(treasury.slash(verifier1.address))
        .to.be.revertedWithCustomError(treasury, "FaultThresholdNotReached");
    });

    it("should revert if already slashed", async function () {
      const faultThreshold = await treasury.faultThreshold();
      
      // Record faults to trigger auto-slash
      for (let i = 0; i < Number(faultThreshold); i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Try to slash again
      await expect(treasury.slash(verifier1.address))
        .to.be.revertedWithCustomError(treasury, "AlreadySlashed");
    });

    it("should not slash twice via auto-slash", async function () {
      const faultThreshold = await treasury.faultThreshold();
      const slashBps = await treasury.slashBps();
      const expectedSlash = (MIN_STAKE * slashBps) / BigInt(10000);
      
      // Record faults beyond threshold
      for (let i = 0; i < Number(faultThreshold) + 2; i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Should only be slashed once
      const verifierData = await registry.getVerifier(verifier1.address);
      expect(verifierData.stake).to.equal(MIN_STAKE - expectedSlash);
    });
  });


  describe("Disable Slashing (Baseline Mode)", function () {
    let snapshotId: bigint;
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

    beforeEach(async function () {
      // Setup verifiers with stake
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(verifier1.address, MIN_STAKE);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());

      await searToken.connect(verifier1).approve(await registry.getAddress(), MIN_STAKE);
      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(verifier1).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier1).activateVerifier();

      await registry.connect(productionOracle).createSnapshot(claimKey);
      snapshotId = BigInt(1);
    });

    it("should allow owner to disable slashing", async function () {
      await expect(treasury.connect(owner).setDisableSlashing(true))
        .to.emit(treasury, "SlashingDisabledUpdated")
        .withArgs(true);
      
      expect(await treasury.isSlashingDisabled()).to.equal(true);
    });

    it("should not auto-slash when slashing is disabled", async function () {
      await treasury.connect(owner).setDisableSlashing(true);
      
      const faultThreshold = await treasury.faultThreshold();
      
      // Record faults beyond threshold
      for (let i = 0; i < Number(faultThreshold) + 1; i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Should NOT be slashed
      expect(await treasury.isSlashed(verifier1.address)).to.equal(false);
      
      // Stake should remain unchanged
      const verifierData = await registry.getVerifier(verifier1.address);
      expect(verifierData.stake).to.equal(MIN_STAKE);
    });

    it("should skip manual slash when slashing is disabled", async function () {
      await treasury.connect(owner).setDisableSlashing(true);
      
      const faultThreshold = await treasury.faultThreshold();
      
      // Record faults to reach threshold
      for (let i = 0; i < Number(faultThreshold); i++) {
        await treasury.connect(productionOracle).recordFault(verifier1.address, 0);
      }
      
      // Manual slash should do nothing (not revert, just skip)
      await treasury.slash(verifier1.address);
      
      // Should NOT be slashed
      expect(await treasury.isSlashed(verifier1.address)).to.equal(false);
    });

    it("should allow re-enabling slashing", async function () {
      await treasury.connect(owner).setDisableSlashing(true);
      await treasury.connect(owner).setDisableSlashing(false);
      
      expect(await treasury.isSlashingDisabled()).to.equal(false);
    });

    it("should revert if non-owner tries to disable slashing", async function () {
      await expect(treasury.connect(user1).setDisableSlashing(true))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  describe("Configuration", function () {
    it("should allow owner to set reward per Wh", async function () {
      const newReward = BigInt(2e12);
      await expect(treasury.connect(owner).setRewardPerWhWei(newReward))
        .to.emit(treasury, "RewardPerWhWeiUpdated");
      
      expect(await treasury.rewardPerWhWei()).to.equal(newReward);
    });

    it("should allow owner to set slash bps", async function () {
      const newSlashBps = 2000; // 20%
      await expect(treasury.connect(owner).setSlashBps(newSlashBps))
        .to.emit(treasury, "SlashBpsUpdated");
      
      expect(await treasury.slashBps()).to.equal(newSlashBps);
    });

    it("should allow owner to set fault threshold", async function () {
      const newThreshold = 5;
      await expect(treasury.connect(owner).setFaultThreshold(newThreshold))
        .to.emit(treasury, "FaultThresholdUpdated");
      
      expect(await treasury.faultThreshold()).to.equal(newThreshold);
    });

    it("should allow owner to set production oracle", async function () {
      const newOracle = user1.address;
      await treasury.connect(owner).setProductionOracle(newOracle);
      expect(await treasury.productionOracle()).to.equal(newOracle);
    });

    it("should allow owner to set consumption oracle", async function () {
      const newOracle = user1.address;
      await treasury.connect(owner).setConsumptionOracle(newOracle);
      expect(await treasury.consumptionOracle()).to.equal(newOracle);
    });

    it("should revert if non-owner tries to set configuration", async function () {
      await expect(treasury.connect(user1).setRewardPerWhWei(1))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      
      await expect(treasury.connect(user1).setSlashBps(1))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      
      await expect(treasury.connect(user1).setFaultThreshold(1))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  describe("Division by Zero Safety", function () {
    let snapshotId: bigint;
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));

    beforeEach(async function () {
      // Setup: Fund treasury pool
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(owner.address, INITIAL_POOL);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());
      await searToken.connect(owner).approve(await treasury.getAddress(), INITIAL_POOL);
      await treasury.connect(owner).deposit(INITIAL_POOL);

      // Setup single verifier
      await searToken.connect(owner).setTreasury(owner.address);
      await searToken.connect(owner).mint(verifier1.address, MIN_STAKE);
      await searToken.connect(owner).setTreasury(await treasury.getAddress());

      await searToken.connect(verifier1).approve(await registry.getAddress(), MIN_STAKE);
      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(verifier1).stakeAsVerifier(MIN_STAKE);
      await registry.connect(verifier1).activateVerifier();

      await registry.connect(productionOracle).createSnapshot(claimKey);
      snapshotId = BigInt(1);
    });

    it("should handle zero winners without division by zero", async function () {
      // winnerBitmap = 0 means no winners, should not divide
      await expect(treasury.connect(productionOracle).distributeRewards(0, snapshotId, 1000))
        .to.not.be.reverted;
    });

    it("should handle zero energy without issues", async function () {
      await expect(treasury.connect(productionOracle).distributeRewards(0b001, snapshotId, 0))
        .to.not.be.reverted;
    });

    it("should handle zero reward per Wh", async function () {
      await treasury.connect(owner).setRewardPerWhWei(0);
      
      await expect(treasury.connect(productionOracle).distributeRewards(0b001, snapshotId, 1000))
        .to.not.be.reverted;
    });
  });
});
