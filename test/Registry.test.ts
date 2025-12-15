import { expect } from "chai";
import { ethers } from "hardhat";
import { Registry, SEARToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Registry", function () {
  let registry: Registry;
  let searToken: SEARToken;
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let productionOracle: HardhatEthersSigner;
  let consumptionOracle: HardhatEthersSigner;
  let producer1: HardhatEthersSigner;
  let consumer1: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;

  const STAKE_AMOUNT = ethers.parseEther("100");
  const LARGE_STAKE = ethers.parseEther("1000");

  beforeEach(async function () {
    [owner, treasury, productionOracle, consumptionOracle, producer1, consumer1, verifier1, verifier2, verifier3] = 
      await ethers.getSigners();

    // Deploy SEARToken
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    // Deploy Registry
    const RegistryFactory = await ethers.getContractFactory("Registry");
    registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
    await registry.waitForDeployment();

    // Setup SEARToken treasury and mint tokens for testing
    await searToken.connect(owner).setTreasury(treasury.address);
    await searToken.connect(treasury).mint(verifier1.address, LARGE_STAKE);
    await searToken.connect(treasury).mint(verifier2.address, LARGE_STAKE);
    await searToken.connect(treasury).mint(verifier3.address, LARGE_STAKE);

    // Set oracles
    await registry.connect(owner).setProductionOracle(productionOracle.address);
    await registry.connect(owner).setConsumptionOracle(consumptionOracle.address);
  });

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("should set the correct SEAR token", async function () {
      expect(await registry.searToken()).to.equal(await searToken.getAddress());
    });

    it("should have default configuration values", async function () {
      expect(await registry.quorumBps()).to.equal(6667);
      expect(await registry.claimWindow()).to.equal(3600);
      expect(await registry.faultThreshold()).to.equal(3);
      expect(await registry.permissionedMode()).to.equal(true);
    });

    it("should revert if deployed with zero address token", async function () {
      const RegistryFactory = await ethers.getContractFactory("Registry");
      await expect(RegistryFactory.deploy(ethers.ZeroAddress, owner.address))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });


  describe("Producer Registration", function () {
    const systemIdHash = ethers.keccak256(ethers.toUtf8Bytes("system-123"));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes("metadata"));

    it("should register a producer successfully", async function () {
      const tx = await registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log) => registry.interface.parseLog(log as any)?.name === "ProducerRegistered"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = registry.interface.parseLog(event as any);
      const producerId = parsedEvent?.args.producerId;

      const producer = await registry.getProducer(producerId);
      expect(producer.systemIdHash).to.equal(systemIdHash);
      expect(producer.metaHash).to.equal(metaHash);
      expect(producer.payoutAddr).to.equal(producer1.address);
      expect(producer.owner).to.equal(producer1.address);
      expect(producer.active).to.equal(true);
    });

    it("should emit ProducerRegistered event", async function () {
      await expect(registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      )).to.emit(registry, "ProducerRegistered");
    });

    it("should mark systemIdHash as registered", async function () {
      await registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      );
      expect(await registry.isSystemRegistered(systemIdHash)).to.equal(true);
    });

    it("should revert if systemIdHash is already registered", async function () {
      await registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      );

      await expect(registry.connect(consumer1).registerProducer(
        systemIdHash,
        metaHash,
        consumer1.address
      )).to.be.revertedWithCustomError(registry, "SystemAlreadyRegistered");
    });

    it("should revert if payout address is zero", async function () {
      await expect(registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        ethers.ZeroAddress
      )).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should allow different producers with different systemIdHashes", async function () {
      const systemIdHash2 = ethers.keccak256(ethers.toUtf8Bytes("system-456"));

      await registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      );

      await expect(registry.connect(consumer1).registerProducer(
        systemIdHash2,
        metaHash,
        consumer1.address
      )).to.emit(registry, "ProducerRegistered");
    });

    it("should revert when getting non-existent producer", async function () {
      const fakeProducerId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(registry.getProducer(fakeProducerId))
        .to.be.revertedWithCustomError(registry, "ProducerNotFound");
    });
  });

  describe("Consumer Registration", function () {
    const meterIdHash = ethers.keccak256(ethers.toUtf8Bytes("meter-123"));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes("metadata"));

    it("should register a consumer successfully", async function () {
      const tx = await registry.connect(consumer1).registerConsumer(
        meterIdHash,
        metaHash,
        consumer1.address
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log) => registry.interface.parseLog(log as any)?.name === "ConsumerRegistered"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = registry.interface.parseLog(event as any);
      const consumerId = parsedEvent?.args.consumerId;

      const consumer = await registry.getConsumer(consumerId);
      expect(consumer.meterIdHash).to.equal(meterIdHash);
      expect(consumer.metaHash).to.equal(metaHash);
      expect(consumer.payoutAddr).to.equal(consumer1.address);
      expect(consumer.owner).to.equal(consumer1.address);
      expect(consumer.active).to.equal(true);
    });

    it("should emit ConsumerRegistered event", async function () {
      await expect(registry.connect(consumer1).registerConsumer(
        meterIdHash,
        metaHash,
        consumer1.address
      )).to.emit(registry, "ConsumerRegistered");
    });

    it("should revert if payout address is zero", async function () {
      await expect(registry.connect(consumer1).registerConsumer(
        meterIdHash,
        metaHash,
        ethers.ZeroAddress
      )).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should revert when getting non-existent consumer", async function () {
      const fakeConsumerId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(registry.getConsumer(fakeConsumerId))
        .to.be.revertedWithCustomError(registry, "ConsumerNotFound");
    });
  });


  describe("Verifier Staking", function () {
    beforeEach(async function () {
      // Approve registry to spend tokens
      await searToken.connect(verifier1).approve(await registry.getAddress(), LARGE_STAKE);
      await searToken.connect(verifier2).approve(await registry.getAddress(), LARGE_STAKE);
    });

    it("should allow staking tokens", async function () {
      await expect(registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT))
        .to.emit(registry, "VerifierStaked")
        .withArgs(verifier1.address, STAKE_AMOUNT, STAKE_AMOUNT);

      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(STAKE_AMOUNT);
    });

    it("should transfer tokens to registry on stake", async function () {
      const balanceBefore = await searToken.balanceOf(verifier1.address);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      const balanceAfter = await searToken.balanceOf(verifier1.address);

      expect(balanceBefore - balanceAfter).to.equal(STAKE_AMOUNT);
      expect(await searToken.balanceOf(await registry.getAddress())).to.equal(STAKE_AMOUNT);
    });

    it("should accumulate stakes on multiple stake calls", async function () {
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);

      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(STAKE_AMOUNT * 2n);
    });

    it("should revert if staking zero amount", async function () {
      await expect(registry.connect(verifier1).stakeAsVerifier(0))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("should allow unstaking when not active", async function () {
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      
      await expect(registry.connect(verifier1).unstake(STAKE_AMOUNT))
        .to.emit(registry, "VerifierUnstaked")
        .withArgs(verifier1.address, STAKE_AMOUNT, 0);

      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(0);
    });

    it("should return tokens on unstake", async function () {
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      const balanceBefore = await searToken.balanceOf(verifier1.address);
      
      await registry.connect(verifier1).unstake(STAKE_AMOUNT);
      const balanceAfter = await searToken.balanceOf(verifier1.address);

      expect(balanceAfter - balanceBefore).to.equal(STAKE_AMOUNT);
    });

    it("should revert if unstaking zero amount", async function () {
      await expect(registry.connect(verifier1).unstake(0))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("should revert if unstaking more than staked", async function () {
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      
      await expect(registry.connect(verifier1).unstake(STAKE_AMOUNT * 2n))
        .to.be.revertedWithCustomError(registry, "InsufficientStakeBalance");
    });
  });

  describe("Verifier Activation/Deactivation", function () {
    beforeEach(async function () {
      await searToken.connect(verifier1).approve(await registry.getAddress(), LARGE_STAKE);
      await searToken.connect(verifier2).approve(await registry.getAddress(), LARGE_STAKE);
      await searToken.connect(verifier3).approve(await registry.getAddress(), LARGE_STAKE);
      
      // Stake tokens
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(verifier2).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(verifier3).stakeAsVerifier(STAKE_AMOUNT);
      
      // Add to allowlist
      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(owner).addToAllowlist(verifier2.address);
      await registry.connect(owner).addToAllowlist(verifier3.address);
    });

    it("should allow activation when allowlisted and staked", async function () {
      await expect(registry.connect(verifier1).activateVerifier())
        .to.emit(registry, "VerifierActivated")
        .withArgs(verifier1.address);

      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.active).to.equal(true);
    });

    it("should add to active verifiers list on activation", async function () {
      await registry.connect(verifier1).activateVerifier();
      
      const activeVerifiers = await registry.getActiveVerifiers();
      expect(activeVerifiers).to.include(verifier1.address);
      expect(await registry.getActiveVerifierCount()).to.equal(1);
    });

    it("should revert activation if not allowlisted in permissioned mode", async function () {
      await registry.connect(owner).removeFromAllowlist(verifier1.address);
      
      await expect(registry.connect(verifier1).activateVerifier())
        .to.be.revertedWithCustomError(registry, "VerifierNotAllowlisted");
    });

    it("should revert activation if insufficient stake", async function () {
      // Create new verifier with insufficient stake
      const [, , , , , , , , , newVerifier] = await ethers.getSigners();
      await searToken.connect(treasury).mint(newVerifier.address, ethers.parseEther("50"));
      await searToken.connect(newVerifier).approve(await registry.getAddress(), ethers.parseEther("50"));
      await registry.connect(newVerifier).stakeAsVerifier(ethers.parseEther("50"));
      await registry.connect(owner).addToAllowlist(newVerifier.address);
      
      await expect(registry.connect(newVerifier).activateVerifier())
        .to.be.revertedWithCustomError(registry, "InsufficientStake");
    });

    it("should revert if already active", async function () {
      await registry.connect(verifier1).activateVerifier();
      
      await expect(registry.connect(verifier1).activateVerifier())
        .to.be.revertedWithCustomError(registry, "VerifierAlreadyActive");
    });

    it("should allow deactivation", async function () {
      await registry.connect(verifier1).activateVerifier();
      
      await expect(registry.connect(verifier1).deactivateVerifier())
        .to.emit(registry, "VerifierDeactivated")
        .withArgs(verifier1.address);

      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.active).to.equal(false);
    });

    it("should remove from active verifiers list on deactivation", async function () {
      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier2).activateVerifier();
      
      await registry.connect(verifier1).deactivateVerifier();
      
      const activeVerifiers = await registry.getActiveVerifiers();
      expect(activeVerifiers).to.not.include(verifier1.address);
      expect(activeVerifiers).to.include(verifier2.address);
      expect(await registry.getActiveVerifierCount()).to.equal(1);
    });

    it("should revert deactivation if not active", async function () {
      await expect(registry.connect(verifier1).deactivateVerifier())
        .to.be.revertedWithCustomError(registry, "VerifierNotActive");
    });

    it("should not allow unstaking while active", async function () {
      await registry.connect(verifier1).activateVerifier();
      
      await expect(registry.connect(verifier1).unstake(STAKE_AMOUNT))
        .to.be.revertedWithCustomError(registry, "VerifierAlreadyActive");
    });

    it("should preserve stake on deactivation", async function () {
      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier1).deactivateVerifier();
      
      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(STAKE_AMOUNT);
    });
  });


  describe("Allowlist Functionality", function () {
    it("should allow owner to add to allowlist", async function () {
      await expect(registry.connect(owner).addToAllowlist(verifier1.address))
        .to.emit(registry, "VerifierAllowlisted")
        .withArgs(verifier1.address);

      expect(await registry.isAllowlisted(verifier1.address)).to.equal(true);
    });

    it("should allow owner to remove from allowlist", async function () {
      await registry.connect(owner).addToAllowlist(verifier1.address);
      
      await expect(registry.connect(owner).removeFromAllowlist(verifier1.address))
        .to.emit(registry, "VerifierRemovedFromAllowlist")
        .withArgs(verifier1.address);

      expect(await registry.isAllowlisted(verifier1.address)).to.equal(false);
    });

    it("should revert if non-owner tries to add to allowlist", async function () {
      await expect(registry.connect(verifier1).addToAllowlist(verifier2.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("should revert if non-owner tries to remove from allowlist", async function () {
      await registry.connect(owner).addToAllowlist(verifier1.address);
      
      await expect(registry.connect(verifier1).removeFromAllowlist(verifier1.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("should revert if adding zero address to allowlist", async function () {
      await expect(registry.connect(owner).addToAllowlist(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should allow activation without allowlist when permissioned mode is off", async function () {
      await registry.connect(owner).setPermissionedMode(false);
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      
      await expect(registry.connect(verifier1).activateVerifier())
        .to.emit(registry, "VerifierActivated");
    });
  });

  describe("Snapshot Functionality", function () {
    const claimKey = ethers.keccak256(ethers.toUtf8Bytes("claim-1"));
    const claimKey2 = ethers.keccak256(ethers.toUtf8Bytes("claim-2"));

    beforeEach(async function () {
      // Setup verifiers
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await searToken.connect(verifier2).approve(await registry.getAddress(), STAKE_AMOUNT);
      await searToken.connect(verifier3).approve(await registry.getAddress(), STAKE_AMOUNT);
      
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(verifier2).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(verifier3).stakeAsVerifier(STAKE_AMOUNT);
      
      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(owner).addToAllowlist(verifier2.address);
      await registry.connect(owner).addToAllowlist(verifier3.address);
      
      await registry.connect(verifier1).activateVerifier();
      await registry.connect(verifier2).activateVerifier();
      await registry.connect(verifier3).activateVerifier();
    });

    it("should create snapshot with sorted verifiers", async function () {
      await expect(registry.connect(productionOracle).createSnapshot(claimKey))
        .to.emit(registry, "SnapshotCreated");

      const snapshotId = await registry.getSnapshotId(claimKey);
      expect(snapshotId).to.be.gt(0);

      const verifiers = await registry.getSnapshotVerifiers(snapshotId);
      expect(verifiers.length).to.equal(3);

      // Verify sorting (addresses should be in ascending order)
      for (let i = 0; i < verifiers.length - 1; i++) {
        expect(BigInt(verifiers[i])).to.be.lt(BigInt(verifiers[i + 1]));
      }
    });

    it("should return correct snapshot count", async function () {
      await registry.connect(productionOracle).createSnapshot(claimKey);
      const snapshotId = await registry.getSnapshotId(claimKey);
      
      expect(await registry.getSnapshotCount(snapshotId)).to.equal(3);
    });

    it("should return correct verifier index", async function () {
      await registry.connect(productionOracle).createSnapshot(claimKey);
      const snapshotId = await registry.getSnapshotId(claimKey);
      const verifiers = await registry.getSnapshotVerifiers(snapshotId);

      for (let i = 0; i < verifiers.length; i++) {
        const index = await registry.getVerifierIndex(snapshotId, verifiers[i]);
        expect(index).to.equal(i);
      }
    });

    it("should revert getVerifierIndex for non-snapshot verifier", async function () {
      await registry.connect(productionOracle).createSnapshot(claimKey);
      const snapshotId = await registry.getSnapshotId(claimKey);
      
      await expect(registry.getVerifierIndex(snapshotId, owner.address))
        .to.be.revertedWithCustomError(registry, "VerifierNotInSnapshot");
    });

    it("should revert if snapshot already exists for claimKey", async function () {
      await registry.connect(productionOracle).createSnapshot(claimKey);
      
      await expect(registry.connect(productionOracle).createSnapshot(claimKey))
        .to.be.revertedWithCustomError(registry, "SnapshotAlreadyExists");
    });

    it("should revert if no active verifiers", async function () {
      // Deactivate all verifiers
      await registry.connect(verifier1).deactivateVerifier();
      await registry.connect(verifier2).deactivateVerifier();
      await registry.connect(verifier3).deactivateVerifier();
      
      await expect(registry.connect(productionOracle).createSnapshot(claimKey))
        .to.be.revertedWithCustomError(registry, "NoActiveVerifiers");
    });

    it("should only allow authorized oracles to create snapshots", async function () {
      await expect(registry.connect(owner).createSnapshot(claimKey))
        .to.be.revertedWithCustomError(registry, "OnlyAuthorizedOracle");
    });

    it("should allow consumption oracle to create snapshots", async function () {
      await expect(registry.connect(consumptionOracle).createSnapshot(claimKey))
        .to.emit(registry, "SnapshotCreated");
    });

    it("should create independent snapshots for different claimKeys", async function () {
      await registry.connect(productionOracle).createSnapshot(claimKey);
      await registry.connect(productionOracle).createSnapshot(claimKey2);
      
      const snapshotId1 = await registry.getSnapshotId(claimKey);
      const snapshotId2 = await registry.getSnapshotId(claimKey2);
      
      expect(snapshotId1).to.not.equal(snapshotId2);
    });
  });


  describe("Configuration Parameters", function () {
    it("should allow owner to set quorumBps", async function () {
      await expect(registry.connect(owner).setQuorumBps(5000))
        .to.emit(registry, "QuorumBpsUpdated")
        .withArgs(6667, 5000);

      expect(await registry.quorumBps()).to.equal(5000);
    });

    it("should revert if quorumBps is zero", async function () {
      await expect(registry.connect(owner).setQuorumBps(0))
        .to.be.revertedWithCustomError(registry, "InvalidQuorumBps");
    });

    it("should revert if quorumBps exceeds 10000", async function () {
      await expect(registry.connect(owner).setQuorumBps(10001))
        .to.be.revertedWithCustomError(registry, "InvalidQuorumBps");
    });

    it("should allow owner to set claimWindow", async function () {
      await expect(registry.connect(owner).setClaimWindow(7200))
        .to.emit(registry, "ClaimWindowUpdated")
        .withArgs(3600, 7200);

      expect(await registry.claimWindow()).to.equal(7200);
    });

    it("should allow owner to set rewardPerWhWei", async function () {
      const newReward = ethers.parseEther("0.001");
      await expect(registry.connect(owner).setRewardPerWhWei(newReward))
        .to.emit(registry, "RewardPerWhWeiUpdated");

      expect(await registry.rewardPerWhWei()).to.equal(newReward);
    });

    it("should allow owner to set slashBps", async function () {
      await expect(registry.connect(owner).setSlashBps(2000))
        .to.emit(registry, "SlashBpsUpdated")
        .withArgs(1000, 2000);

      expect(await registry.slashBps()).to.equal(2000);
    });

    it("should allow owner to set faultThreshold", async function () {
      await expect(registry.connect(owner).setFaultThreshold(5))
        .to.emit(registry, "FaultThresholdUpdated")
        .withArgs(3, 5);

      expect(await registry.faultThreshold()).to.equal(5);
    });

    it("should allow owner to set minStake", async function () {
      const newMinStake = ethers.parseEther("200");
      await registry.connect(owner).setMinStake(newMinStake);
      expect(await registry.minStake()).to.equal(newMinStake);
    });

    it("should revert if non-owner tries to set parameters", async function () {
      await expect(registry.connect(verifier1).setQuorumBps(5000))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      
      await expect(registry.connect(verifier1).setClaimWindow(7200))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      
      await expect(registry.connect(verifier1).setSlashBps(2000))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      
      await expect(registry.connect(verifier1).setFaultThreshold(5))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Oracle Authorization", function () {
    it("should allow owner to set production oracle", async function () {
      const newOracle = verifier1.address;
      await expect(registry.connect(owner).setProductionOracle(newOracle))
        .to.emit(registry, "ProductionOracleUpdated")
        .withArgs(productionOracle.address, newOracle);

      expect(await registry.productionOracle()).to.equal(newOracle);
    });

    it("should allow owner to set consumption oracle", async function () {
      const newOracle = verifier1.address;
      await expect(registry.connect(owner).setConsumptionOracle(newOracle))
        .to.emit(registry, "ConsumptionOracleUpdated")
        .withArgs(consumptionOracle.address, newOracle);

      expect(await registry.consumptionOracle()).to.equal(newOracle);
    });

    it("should correctly identify authorized oracles", async function () {
      expect(await registry.isAuthorizedOracle(productionOracle.address)).to.equal(true);
      expect(await registry.isAuthorizedOracle(consumptionOracle.address)).to.equal(true);
      expect(await registry.isAuthorizedOracle(owner.address)).to.equal(false);
      expect(await registry.isAuthorizedOracle(verifier1.address)).to.equal(false);
    });

    it("should revert if non-owner tries to set oracles", async function () {
      await expect(registry.connect(verifier1).setProductionOracle(verifier1.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      
      await expect(registry.connect(verifier1).setConsumptionOracle(verifier1.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Verifier Fault Management", function () {
    beforeEach(async function () {
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(owner).addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();
    });

    it("should increment faults", async function () {
      await registry.incrementFaults(verifier1.address);
      
      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.faults).to.equal(1);
    });

    it("should reduce stake", async function () {
      const reduceAmount = ethers.parseEther("50");
      await registry.reduceStake(verifier1.address, reduceAmount);
      
      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(STAKE_AMOUNT - reduceAmount);
    });

    it("should not reduce stake below zero", async function () {
      const reduceAmount = STAKE_AMOUNT * 2n;
      await registry.reduceStake(verifier1.address, reduceAmount);
      
      const verifier = await registry.getVerifier(verifier1.address);
      expect(verifier.stake).to.equal(0);
    });
  });
});
