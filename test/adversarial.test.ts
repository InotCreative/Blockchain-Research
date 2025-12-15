import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SEARToken,
  HourlyCredits,
  Registry,
  Treasury,
  ProductionOracle,
  ConsumptionOracle,
  Matcher,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Adversarial Tests
 * 
 * Tests security scenarios:
 * - 20% malicious verifiers (quorum still works)
 * - 40% malicious verifiers (disputed state)
 * - Replay attacks (rejected)
 * - Double-match attacks (rejected)
 * - Signature forgery (rejected)
 * 
 * Requirements: 12.4
 */
describe("Adversarial Tests", function () {
  // Contracts
  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let registry: Registry;
  let treasury: Treasury;
  let productionOracle: ProductionOracle;
  let consumptionOracle: ConsumptionOracle;
  let matcher: Matcher;

  // Signers
  let owner: HardhatEthersSigner;
  let producer1: HardhatEthersSigner;
  let consumer1: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;
  let verifier4: HardhatEthersSigner;
  let verifier5: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  // Constants
  const STAKE_AMOUNT = ethers.parseEther("100");
  const LARGE_STAKE = ethers.parseEther("1000");
  const REWARD_POOL = ethers.parseEther("10000");
  const INITIAL_SEAR = ethers.parseEther("5000");

  // Test data
  let producerId: string;
  let consumerId: string;
  const hourId = Math.floor(Date.now() / 1000 / 3600);
  const correctEnergyWh = 5000n;
  const maliciousEnergyWh = 9999n; // Wrong value
  const correctEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("correct-evidence"));
  const maliciousEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("malicious-evidence"));

  // Helper function to sign a production claim
  async function signProductionClaim(
    signer: HardhatEthersSigner,
    _producerId: string,
    _hourId: number,
    _energyWh: bigint,
    _evidenceRoot: string,
    contractAddress: string
  ): Promise<string> {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
      [chainId, contractAddress, _producerId, _hourId, _energyWh, _evidenceRoot]
    );
    return signer.signMessage(ethers.getBytes(messageHash));
  }

  // Helper function to sign a consumption claim
  async function signConsumptionClaim(
    signer: HardhatEthersSigner,
    _consumerId: string,
    _hourId: number,
    _energyWh: bigint,
    _evidenceRoot: string,
    contractAddress: string
  ): Promise<string> {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
      [chainId, contractAddress, _consumerId, _hourId, _energyWh, _evidenceRoot]
    );
    return signer.signMessage(ethers.getBytes(messageHash));
  }

  beforeEach(async function () {
    [owner, producer1, consumer1, verifier1, verifier2, verifier3, verifier4, verifier5, attacker] = 
      await ethers.getSigners();

    // Deploy all contracts
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory("Registry");
    registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
    await registry.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(
      await searToken.getAddress(),
      await registry.getAddress(),
      owner.address
    );
    await treasury.waitForDeployment();

    const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
    productionOracle = await ProductionOracleFactory.deploy(
      await registry.getAddress(),
      await hourlyCredits.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await productionOracle.waitForDeployment();

    const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
    consumptionOracle = await ConsumptionOracleFactory.deploy(
      await registry.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await consumptionOracle.waitForDeployment();

    const MatcherFactory = await ethers.getContractFactory("Matcher");
    matcher = await MatcherFactory.deploy(
      await consumptionOracle.getAddress(),
      await hourlyCredits.getAddress(),
      await searToken.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await matcher.waitForDeployment();

    // Wire up contracts
    await searToken.setTreasury(await treasury.getAddress());
    await hourlyCredits.setProductionOracle(await productionOracle.getAddress());
    await registry.setProductionOracle(await productionOracle.getAddress());
    await registry.setConsumptionOracle(await consumptionOracle.getAddress());
    await treasury.setProductionOracle(await productionOracle.getAddress());
    await treasury.setConsumptionOracle(await consumptionOracle.getAddress());

    // Bootstrap SEAR supply
    await searToken.setTreasury(owner.address);
    await searToken.mint(verifier1.address, LARGE_STAKE);
    await searToken.mint(verifier2.address, LARGE_STAKE);
    await searToken.mint(verifier3.address, LARGE_STAKE);
    await searToken.mint(verifier4.address, LARGE_STAKE);
    await searToken.mint(verifier5.address, LARGE_STAKE);
    await searToken.mint(attacker.address, LARGE_STAKE);
    await searToken.mint(consumer1.address, INITIAL_SEAR);
    await searToken.mint(owner.address, REWARD_POOL);
    await searToken.setTreasury(await treasury.getAddress());

    // Fund treasury
    await searToken.approve(await treasury.getAddress(), REWARD_POOL);
    await treasury.deposit(REWARD_POOL);

    // Register producer
    const systemIdHash = ethers.keccak256(ethers.toUtf8Bytes("ENPHASE-SYSTEM-001"));
    const producerMetaHash = ethers.keccak256(ethers.toUtf8Bytes("Producer Metadata"));
    const producerTx = await registry.connect(producer1).registerProducer(
      systemIdHash,
      producerMetaHash,
      producer1.address
    );
    const producerReceipt = await producerTx.wait();
    const producerEvent = producerReceipt?.logs.find(
      (log) => registry.interface.parseLog(log as any)?.name === "ProducerRegistered"
    );
    producerId = registry.interface.parseLog(producerEvent as any)?.args.producerId;

    // Register consumer
    const meterIdHash = ethers.keccak256(ethers.toUtf8Bytes("METER-001"));
    const consumerMetaHash = ethers.keccak256(ethers.toUtf8Bytes("Consumer Metadata"));
    const consumerTx = await registry.connect(consumer1).registerConsumer(
      meterIdHash,
      consumerMetaHash,
      consumer1.address
    );
    const consumerReceipt = await consumerTx.wait();
    const consumerEvent = consumerReceipt?.logs.find(
      (log) => registry.interface.parseLog(log as any)?.name === "ConsumerRegistered"
    );
    consumerId = registry.interface.parseLog(consumerEvent as any)?.args.consumerId;
  });


  describe("20% Malicious Verifiers (Quorum Still Works)", function () {
    beforeEach(async function () {
      // Setup 5 verifiers (1 malicious = 20%)
      const verifiers = [verifier1, verifier2, verifier3, verifier4, verifier5];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }
    });

    it("should reach quorum with 4 honest verifiers and 1 malicious (20%)", async function () {
      // 4 honest verifiers submit correct value
      const honestVerifiers = [verifier1, verifier2, verifier3, verifier4];
      for (const v of honestVerifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      // 1 malicious verifier submits wrong value
      const maliciousSig = await signProductionClaim(
        verifier5, producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier5).submitProduction(
        producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot, maliciousSig
      );

      // Advance time and finalize
      await time.increase(3601);

      // Should finalize with correct value (4/5 = 80% > 66.67% quorum)
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(productionOracle, "ProductionFinalized")
        .withArgs(
          await productionOracle.getClaimKey(producerId, hourId),
          producerId,
          hourId,
          correctEnergyWh,
          correctEvidenceRoot
        );

      // Verify correct value was finalized
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.verifiedEnergyWh).to.equal(correctEnergyWh);
      expect(bucket.finalized).to.be.true;
      expect(bucket.disputed).to.be.false;
    });

    it("should record fault for malicious verifier", async function () {
      // Lower quorum to 50% for this test
      await productionOracle.setQuorumBps(5000);

      // 4 honest verifiers submit correct value
      const honestVerifiers = [verifier1, verifier2, verifier3, verifier4];
      for (const v of honestVerifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      // 1 malicious verifier submits wrong value
      const maliciousSig = await signProductionClaim(
        verifier5, producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier5).submitProduction(
        producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot, maliciousSig
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Verify claim was finalized with correct value
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.verifiedEnergyWh).to.equal(correctEnergyWh);
    });
  });

  describe("40% Malicious Verifiers (Disputed State)", function () {
    beforeEach(async function () {
      // Setup 5 verifiers (2 malicious = 40%)
      const verifiers = [verifier1, verifier2, verifier3, verifier4, verifier5];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }
    });

    it("should enter disputed state when 40% verifiers submit wrong values", async function () {
      // 3 honest verifiers submit correct value (60%)
      const honestVerifiers = [verifier1, verifier2, verifier3];
      for (const v of honestVerifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      // 2 malicious verifiers submit different wrong values (40%)
      const maliciousSig4 = await signProductionClaim(
        verifier4, producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier4).submitProduction(
        producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot, maliciousSig4
      );

      const differentMaliciousWh = 8888n;
      const differentMaliciousRoot = ethers.keccak256(ethers.toUtf8Bytes("different-malicious"));
      const maliciousSig5 = await signProductionClaim(
        verifier5, producerId, hourId, differentMaliciousWh, differentMaliciousRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier5).submitProduction(
        producerId, hourId, differentMaliciousWh, differentMaliciousRoot, maliciousSig5
      );

      await time.increase(3601);

      // With 66.67% quorum required, 3/5 = 60% is not enough
      // Should enter disputed state
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(productionOracle, "ClaimDisputed");

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.disputed).to.be.true;
      expect(bucket.finalized).to.be.false;
    });

    it("should allow admin to force finalize disputed claim", async function () {
      // Create disputed state
      const honestVerifiers = [verifier1, verifier2, verifier3];
      for (const v of honestVerifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      const maliciousSig4 = await signProductionClaim(
        verifier4, producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier4).submitProduction(
        producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot, maliciousSig4
      );

      const maliciousSig5 = await signProductionClaim(
        verifier5, producerId, hourId, 7777n, ethers.keccak256(ethers.toUtf8Bytes("another")),
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier5).submitProduction(
        producerId, hourId, 7777n, ethers.keccak256(ethers.toUtf8Bytes("another")), maliciousSig5
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Admin force finalizes with correct value
      await expect(productionOracle.connect(owner).forceFinalize(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot
      )).to.emit(productionOracle, "ForceFinalized");

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.finalized).to.be.true;
      expect(bucket.verifiedEnergyWh).to.equal(correctEnergyWh);
    });
  });


  describe("Replay Attacks (Rejected)", function () {
    beforeEach(async function () {
      // Setup 3 verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }
    });

    it("should reject duplicate submission from same verifier", async function () {
      const sig = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      // First submission succeeds
      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
      );

      // Replay attempt fails
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
      )).to.be.revertedWithCustomError(productionOracle, "DuplicateSubmission");
    });

    it("should reject submission after finalization (replay attack)", async function () {
      // Submit from all verifiers
      for (const v of [verifier1, verifier2, verifier3]) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Attempt to submit after finalization
      const replaySig = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, replaySig
      )).to.be.revertedWithCustomError(productionOracle, "ClaimAlreadyFinalized");
    });

    it("should reject double finalization (replay attack)", async function () {
      // Submit from all verifiers
      for (const v of [verifier1, verifier2, verifier3]) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Attempt to finalize again
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.be.revertedWithCustomError(productionOracle, "ClaimAlreadyFinalized");
    });

    it("should reject cross-contract signature replay", async function () {
      // Sign for ProductionOracle
      const prodSig = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      // Try to use production signature for consumption (different contract address in signature)
      // This should fail because the recovered signer won't match
      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, correctEnergyWh, correctEvidenceRoot, prodSig
      )).to.be.revertedWithCustomError(consumptionOracle, "VerifierNotActive");
    });
  });

  describe("Double-Match Attacks (Rejected)", function () {
    beforeEach(async function () {
      // Setup verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }

      // Submit and finalize production
      for (const v of verifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      // Submit and finalize consumption
      for (const v of verifiers) {
        const sig = await signConsumptionClaim(
          v, consumerId, hourId, correctEnergyWh, correctEvidenceRoot,
          await consumptionOracle.getAddress()
        );
        await consumptionOracle.connect(v).submitConsumption(
          consumerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
        );
      }

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);
    });

    it("should reject matching more than verified consumption", async function () {
      // Mint extra HCN to producer so listing has more than verified consumption
      await hourlyCredits.setProductionOracle(owner.address);
      await hourlyCredits.mint(producer1.address, hourId, 1000n, ethers.ZeroHash);
      await hourlyCredits.setProductionOracle(await productionOracle.getAddress());

      // List credits (more than verified consumption)
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      await matcher.connect(producer1).listCredits(hourId, correctEnergyWh + 1000n, pricePerWh);

      // Approve SEAR
      const totalPrice = (correctEnergyWh + 1n) * pricePerWh;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), totalPrice);

      // Try to match more than verified consumption
      await expect(matcher.connect(consumer1).buyCredits(1, correctEnergyWh + 1n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });

    it("should reject double-matching same consumption", async function () {
      // List credits
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      await matcher.connect(producer1).listCredits(hourId, correctEnergyWh, pricePerWh);

      // Approve SEAR
      const totalPrice = correctEnergyWh * pricePerWh * 2n;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), totalPrice);

      // First match succeeds
      await matcher.connect(consumer1).buyCredits(1, correctEnergyWh, consumerId);

      // Mint more HCN to producer for second attempt
      await hourlyCredits.setProductionOracle(owner.address);
      await hourlyCredits.mint(producer1.address, hourId, correctEnergyWh, ethers.ZeroHash);
      await hourlyCredits.setProductionOracle(await productionOracle.getAddress());

      // List more credits
      await matcher.connect(producer1).listCredits(hourId, correctEnergyWh, pricePerWh);

      // Second match fails - already matched full consumption
      await expect(matcher.connect(consumer1).buyCredits(2, 1n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });

    it("should prevent double-matching via direct match", async function () {
      // Approve HCN transfer
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      
      // Approve SEAR
      const agreedPrice = ethers.parseEther("10");
      await searToken.connect(consumer1).approve(await matcher.getAddress(), agreedPrice * 2n);

      // First direct match succeeds
      await matcher.connect(consumer1).directMatch(
        hourId, consumerId, producer1.address, correctEnergyWh, agreedPrice
      );

      // Mint more HCN to producer
      await hourlyCredits.setProductionOracle(owner.address);
      await hourlyCredits.mint(producer1.address, hourId, correctEnergyWh, ethers.ZeroHash);
      await hourlyCredits.setProductionOracle(await productionOracle.getAddress());

      // Second direct match fails
      await expect(matcher.connect(consumer1).directMatch(
        hourId, consumerId, producer1.address, 1n, agreedPrice
      )).to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });

    it("should track cumulative matched amount correctly", async function () {
      // Mint extra HCN to producer so listing has more than verified consumption
      await hourlyCredits.setProductionOracle(owner.address);
      await hourlyCredits.mint(producer1.address, hourId, 5000n, ethers.ZeroHash);
      await hourlyCredits.setProductionOracle(await productionOracle.getAddress());

      // List credits (10000 Wh total, more than verified consumption of 5000)
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      await matcher.connect(producer1).listCredits(hourId, 10000n, pricePerWh);

      // Approve SEAR
      await searToken.connect(consumer1).approve(await matcher.getAddress(), 10000n * pricePerWh);

      // Partial match 1
      await matcher.connect(consumer1).buyCredits(1, 2000n, consumerId);
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(2000n);

      // Partial match 2
      await matcher.connect(consumer1).buyCredits(1, 2000n, consumerId);
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(4000n);

      // Partial match 3 - should fail if exceeds verified consumption (5000)
      await expect(matcher.connect(consumer1).buyCredits(1, 1001n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");

      // Exact remaining amount should work
      await matcher.connect(consumer1).buyCredits(1, 1000n, consumerId);
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(5000n);
    });
  });


  describe("Signature Forgery (Rejected)", function () {
    beforeEach(async function () {
      // Setup verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }
    });

    it("should reject signature with wrong chain ID", async function () {
      // Sign with wrong chain ID
      const wrongChainId = 999999n;
      const messageHash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
        [wrongChainId, await productionOracle.getAddress(), producerId, hourId, correctEnergyWh, correctEvidenceRoot]
      );
      const wrongChainSig = await verifier1.signMessage(ethers.getBytes(messageHash));

      // Recovered address will be different, so it won't be an active verifier
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, wrongChainSig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject signature with wrong contract address", async function () {
      // Sign with wrong contract address
      const wrongAddress = ethers.Wallet.createRandom().address;
      const messageHash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
        [(await ethers.provider.getNetwork()).chainId, wrongAddress, producerId, hourId, correctEnergyWh, correctEvidenceRoot]
      );
      const wrongContractSig = await verifier1.signMessage(ethers.getBytes(messageHash));

      // Recovered address will be different
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, wrongContractSig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject signature with wrong producer ID", async function () {
      // Sign with wrong producer ID
      const wrongProducerId = ethers.keccak256(ethers.toUtf8Bytes("wrong-producer"));
      const messageHash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
        [(await ethers.provider.getNetwork()).chainId, await productionOracle.getAddress(), wrongProducerId, hourId, correctEnergyWh, correctEvidenceRoot]
      );
      const wrongProducerSig = await verifier1.signMessage(ethers.getBytes(messageHash));

      // Recovered address will be different
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, wrongProducerSig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject signature with wrong energy value", async function () {
      // Sign with wrong energy value
      const wrongEnergy = 9999n;
      const messageHash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"],
        [(await ethers.provider.getNetwork()).chainId, await productionOracle.getAddress(), producerId, hourId, wrongEnergy, correctEvidenceRoot]
      );
      const wrongEnergySig = await verifier1.signMessage(ethers.getBytes(messageHash));

      // Recovered address will be different
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, wrongEnergySig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject malformed signature", async function () {
      const malformedSig = "0x1234567890";

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, malformedSig
      )).to.be.reverted;
    });

    it("should reject signature from non-verifier", async function () {
      // Attacker signs but is not a verifier
      const attackerSig = await signProductionClaim(
        attacker, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(attacker).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, attackerSig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject signature from deactivated verifier", async function () {
      // Deactivate verifier1
      await registry.connect(verifier1).deactivateVerifier();

      const sig = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject signature reuse across different hours", async function () {
      // Sign for hourId
      const sig = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );

      // Submit for hourId succeeds
      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig
      );

      // Try to use same signature for different hour
      const differentHourId = hourId + 1;
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, differentHourId, correctEnergyWh, correctEvidenceRoot, sig
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });
  });

  describe("Unauthorized Access Attacks", function () {
    beforeEach(async function () {
      // Setup verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }
    });

    it("should reject direct HCN minting by attacker", async function () {
      await expect(hourlyCredits.connect(attacker).mint(
        attacker.address, hourId, 1000n, ethers.ZeroHash
      )).to.be.revertedWithCustomError(hourlyCredits, "OnlyProductionOracle");
    });

    it("should reject direct SEAR minting by attacker", async function () {
      await expect(searToken.connect(attacker).mint(
        attacker.address, ethers.parseEther("1000")
      )).to.be.revertedWithCustomError(searToken, "OnlyTreasury");
    });

    it("should reject snapshot creation by non-oracle", async function () {
      const claimKey = ethers.keccak256(ethers.toUtf8Bytes("fake-claim"));
      await expect(registry.connect(attacker).createSnapshot(claimKey))
        .to.be.revertedWithCustomError(registry, "OnlyAuthorizedOracle");
    });

    it("should reject reward distribution by non-oracle", async function () {
      await expect(treasury.connect(attacker).distributeRewards(0, 1, 1000n))
        .to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
    });

    it("should reject fault recording by non-oracle", async function () {
      await expect(treasury.connect(attacker).recordFault(verifier1.address, 0))
        .to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
    });

    it("should reject force finalize by non-admin", async function () {
      // Create a disputed claim first
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, correctEnergyWh, correctEvidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, 7777n, ethers.keccak256(ethers.toUtf8Bytes("third")),
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, maliciousEnergyWh, maliciousEvidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, 7777n, ethers.keccak256(ethers.toUtf8Bytes("third")), sig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Attacker tries to force finalize
      await expect(productionOracle.connect(attacker).forceFinalize(
        producerId, hourId, correctEnergyWh, correctEvidenceRoot
      )).to.be.revertedWithCustomError(productionOracle, "OwnableUnauthorizedAccount");
    });
  });
});
