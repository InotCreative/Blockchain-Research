import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SEARToken,
  HourlyCredits,
  Registry,
  Treasury,
  ProductionOracle,
  ConsumptionOracle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Baseline Comparison Tests
 * 
 * Tests for research comparison:
 * - Single-verifier mode (baseline mode)
 * - No-slashing mode
 * - Gas cost measurements for comparison
 * 
 * Requirements: 13.6, 13.7, 13.8, 13.9
 */
describe("Baseline Comparison Tests", function () {
  // Contracts
  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let registry: Registry;
  let treasury: Treasury;
  let productionOracle: ProductionOracle;
  let consumptionOracle: ConsumptionOracle;

  // Signers
  let owner: HardhatEthersSigner;
  let producer1: HardhatEthersSigner;
  let consumer1: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;

  // Constants
  const STAKE_AMOUNT = ethers.parseEther("100");
  const LARGE_STAKE = ethers.parseEther("1000");
  const REWARD_POOL = ethers.parseEther("10000");

  // Test data
  let producerId: string;
  let consumerId: string;
  const hourId = Math.floor(Date.now() / 1000 / 3600);
  const energyWh = 5000n;
  const evidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("evidence-root"));

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
    [owner, producer1, consumer1, verifier1, verifier2, verifier3] = 
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


  describe("Single-Verifier Mode (Baseline)", function () {
    beforeEach(async function () {
      // Setup single verifier
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();

      // Enable baseline mode
      await productionOracle.setBaselineMode(true);
      await productionOracle.setSingleVerifierOverride(verifier1.address);
    });

    it("should enable baseline mode", async function () {
      expect(await productionOracle.isBaselineMode()).to.be.true;
    });

    it("should finalize immediately with single verifier submission in baseline mode", async function () {
      const sig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // Single submission should finalize immediately
      const tx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig
      );

      // Check events - should have both ProductionSubmitted and ProductionFinalized
      await expect(tx)
        .to.emit(productionOracle, "ProductionSubmitted")
        .to.emit(productionOracle, "ProductionFinalized");

      // Verify claim is finalized
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.be.true;

      // Verify HCN minted
      expect(await hourlyCredits.balanceOf(producer1.address, hourId)).to.equal(energyWh);
    });

    it("should not require waiting for claim window in baseline mode", async function () {
      const sig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // Submit and finalize immediately (no time.increase needed)
      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig
      );

      // Verify finalized without waiting
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.be.true;
    });

    it("should measure gas cost for single-verifier submission", async function () {
      const sig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      const tx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig
      );
      const receipt = await tx.wait();

      // Log gas used for research comparison
      console.log(`    [Baseline Mode] Single-verifier submission + finalization gas: ${receipt?.gasUsed}`);
      
      // Verify transaction succeeded
      expect(receipt?.status).to.equal(1);
    });

    it("should not finalize for non-override verifier in baseline mode", async function () {
      // Setup another verifier
      await searToken.connect(verifier2).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier2).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier2.address);
      await registry.connect(verifier2).activateVerifier();

      const sig = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // Submission from non-override verifier should not auto-finalize
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig
      );

      // Verify NOT finalized
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.be.false;
    });
  });

  describe("No-Slashing Mode (Baseline)", function () {
    beforeEach(async function () {
      // Setup verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }

      // Disable slashing
      await treasury.setDisableSlashing(true);
    });

    it("should disable slashing", async function () {
      expect(await treasury.isSlashingDisabled()).to.be.true;
    });

    it("should record faults but not slash when slashing is disabled", async function () {
      // Submit different values to create faults
      const wrongEnergyWh = 9999n;
      const wrongEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong"));

      // Honest verifiers
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // Malicious verifier
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, wrongEnergyWh, wrongEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, wrongEnergyWh, wrongEvidenceRoot, sig3
      );

      // Lower quorum for this test
      await productionOracle.setQuorumBps(5000);

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Verify verifier3 is NOT slashed (slashing disabled)
      expect(await treasury.isSlashed(verifier3.address)).to.be.false;

      // Verify stake is preserved
      const verifier3Data = await registry.getVerifier(verifier3.address);
      expect(verifier3Data.stake).to.equal(STAKE_AMOUNT);
    });

    it("should still distribute rewards when slashing is disabled", async function () {
      // All verifiers submit correct value
      for (const v of [verifier1, verifier2, verifier3]) {
        const sig = await signProductionClaim(
          v, producerId, hourId, energyWh, evidenceRoot,
          await productionOracle.getAddress()
        );
        await productionOracle.connect(v).submitProduction(
          producerId, hourId, energyWh, evidenceRoot, sig
        );
      }

      await time.increase(3601);

      // Finalize should distribute rewards
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(treasury, "RewardsDistributed");
    });
  });


  describe("Gas Cost Comparison", function () {
    // Gas metrics storage for comparison
    const gasMetrics: {
      baseline: { submission: bigint; finalization: bigint; total: bigint };
      decentralized: { submission: bigint; finalization: bigint; total: bigint };
    } = {
      baseline: { submission: 0n, finalization: 0n, total: 0n },
      decentralized: { submission: 0n, finalization: 0n, total: 0n }
    };

    it("should measure baseline mode gas costs (single verifier)", async function () {
      // Setup single verifier
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();

      // Enable baseline mode
      await productionOracle.setBaselineMode(true);
      await productionOracle.setSingleVerifierOverride(verifier1.address);

      const sig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // In baseline mode, submission includes finalization
      const tx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig
      );
      const receipt = await tx.wait();

      gasMetrics.baseline.submission = receipt?.gasUsed || 0n;
      gasMetrics.baseline.finalization = 0n; // Included in submission
      gasMetrics.baseline.total = gasMetrics.baseline.submission;

      console.log(`    [Baseline] Total gas (submission + finalization): ${gasMetrics.baseline.total}`);
    });

    it("should measure decentralized mode gas costs (3 verifiers)", async function () {
      // Setup 3 verifiers
      const verifiers = [verifier1, verifier2, verifier3];
      for (const v of verifiers) {
        await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
        await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
        await registry.addToAllowlist(v.address);
        await registry.connect(v).activateVerifier();
      }

      // Ensure baseline mode is disabled
      await productionOracle.setBaselineMode(false);

      let totalSubmissionGas = 0n;

      // Submit from all verifiers
      for (const v of verifiers) {
        const sig = await signProductionClaim(
          v, producerId, hourId, energyWh, evidenceRoot,
          await productionOracle.getAddress()
        );
        const tx = await productionOracle.connect(v).submitProduction(
          producerId, hourId, energyWh, evidenceRoot, sig
        );
        const receipt = await tx.wait();
        totalSubmissionGas += receipt?.gasUsed || 0n;
      }

      gasMetrics.decentralized.submission = totalSubmissionGas;

      // Wait for claim window
      await time.increase(3601);

      // Finalize
      const finalizeTx = await productionOracle.finalizeProduction(producerId, hourId);
      const finalizeReceipt = await finalizeTx.wait();

      gasMetrics.decentralized.finalization = finalizeReceipt?.gasUsed || 0n;
      gasMetrics.decentralized.total = gasMetrics.decentralized.submission + gasMetrics.decentralized.finalization;

      console.log(`    [Decentralized] Submission gas (3 verifiers): ${gasMetrics.decentralized.submission}`);
      console.log(`    [Decentralized] Finalization gas: ${gasMetrics.decentralized.finalization}`);
      console.log(`    [Decentralized] Total gas: ${gasMetrics.decentralized.total}`);
    });

    it("should compare gas costs between modes", async function () {
      // This test runs after the previous two to compare results
      // Re-run baseline measurement
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();

      await productionOracle.setBaselineMode(true);
      await productionOracle.setSingleVerifierOverride(verifier1.address);

      const baselineSig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const baselineTx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, baselineSig
      );
      const baselineReceipt = await baselineTx.wait();
      const baselineGas = baselineReceipt?.gasUsed || 0n;

      // Run decentralized measurement with new hourId
      const hourId2 = hourId + 1;
      await productionOracle.setBaselineMode(false);

      // Setup additional verifiers
      await searToken.connect(verifier2).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier2).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier2.address);
      await registry.connect(verifier2).activateVerifier();

      await searToken.connect(verifier3).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier3).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier3.address);
      await registry.connect(verifier3).activateVerifier();

      let decentralizedSubmissionGas = 0n;
      for (const v of [verifier1, verifier2, verifier3]) {
        const sig = await signProductionClaim(
          v, producerId, hourId2, energyWh, evidenceRoot,
          await productionOracle.getAddress()
        );
        const tx = await productionOracle.connect(v).submitProduction(
          producerId, hourId2, energyWh, evidenceRoot, sig
        );
        const receipt = await tx.wait();
        decentralizedSubmissionGas += receipt?.gasUsed || 0n;
      }

      await time.increase(3601);
      const finalizeTx = await productionOracle.finalizeProduction(producerId, hourId2);
      const finalizeReceipt = await finalizeTx.wait();
      const decentralizedTotalGas = decentralizedSubmissionGas + (finalizeReceipt?.gasUsed || 0n);

      // Calculate overhead
      const overhead = decentralizedTotalGas - baselineGas;
      const overheadPercent = Number(overhead * 100n / baselineGas);

      console.log("\n    ========== GAS COST COMPARISON ==========");
      console.log(`    Baseline (single verifier):     ${baselineGas} gas`);
      console.log(`    Decentralized (3 verifiers):    ${decentralizedTotalGas} gas`);
      console.log(`    Overhead:                       ${overhead} gas (${overheadPercent}%)`);
      console.log(`    Gas per kWh (baseline):         ${Number(baselineGas) / (Number(energyWh) / 1000)} gas/kWh`);
      console.log(`    Gas per kWh (decentralized):    ${Number(decentralizedTotalGas) / (Number(energyWh) / 1000)} gas/kWh`);
      console.log("    ==========================================\n");

      // Verify both modes work
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(producerId, hourId))).to.be.true;
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(producerId, hourId2))).to.be.true;
    });
  });

  describe("Consumption Oracle Baseline Mode", function () {
    beforeEach(async function () {
      // Setup single verifier
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();

      // Enable baseline mode on consumption oracle
      await consumptionOracle.setBaselineMode(true);
      await consumptionOracle.setSingleVerifierOverride(verifier1.address);
    });

    it("should finalize consumption immediately in baseline mode", async function () {
      const sig = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      const tx = await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig
      );

      await expect(tx)
        .to.emit(consumptionOracle, "ConsumptionSubmitted")
        .to.emit(consumptionOracle, "ConsumptionFinalized");

      // Verify consumption is recorded
      expect(await consumptionOracle.getVerifiedConsumption(consumerId, hourId)).to.equal(energyWh);
    });

    it("should measure consumption oracle baseline gas", async function () {
      const sig = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      const tx = await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig
      );
      const receipt = await tx.wait();

      console.log(`    [Consumption Baseline] Single-verifier submission + finalization gas: ${receipt?.gasUsed}`);
      expect(receipt?.status).to.equal(1);
    });
  });

  describe("Research Metrics Summary", function () {
    it("should output research metrics summary", async function () {
      // Setup verifiers
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier1.address);
      await registry.connect(verifier1).activateVerifier();

      await searToken.connect(verifier2).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier2).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier2.address);
      await registry.connect(verifier2).activateVerifier();

      await searToken.connect(verifier3).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier3).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(verifier3.address);
      await registry.connect(verifier3).activateVerifier();

      // Measure baseline mode
      await productionOracle.setBaselineMode(true);
      await productionOracle.setSingleVerifierOverride(verifier1.address);

      const baselineSig = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const baselineTx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, baselineSig
      );
      const baselineReceipt = await baselineTx.wait();

      // Measure decentralized mode
      const hourId2 = hourId + 1;
      await productionOracle.setBaselineMode(false);

      let decentralizedGas = 0n;
      for (const v of [verifier1, verifier2, verifier3]) {
        const sig = await signProductionClaim(
          v, producerId, hourId2, energyWh, evidenceRoot,
          await productionOracle.getAddress()
        );
        const tx = await productionOracle.connect(v).submitProduction(
          producerId, hourId2, energyWh, evidenceRoot, sig
        );
        const receipt = await tx.wait();
        decentralizedGas += receipt?.gasUsed || 0n;
      }

      await time.increase(3601);
      const finalizeTx = await productionOracle.finalizeProduction(producerId, hourId2);
      const finalizeReceipt = await finalizeTx.wait();
      decentralizedGas += finalizeReceipt?.gasUsed || 0n;

      // Output research metrics
      console.log("\n    ============ RESEARCH METRICS SUMMARY ============");
      console.log("    Configuration:");
      console.log(`      - Energy verified: ${energyWh} Wh (${Number(energyWh) / 1000} kWh)`);
      console.log(`      - Verifier count: 3`);
      console.log(`      - Quorum: 66.67% (2/3)`);
      console.log("");
      console.log("    Baseline Mode (Single Verifier, No Consensus):");
      console.log(`      - Total gas: ${baselineReceipt?.gasUsed}`);
      console.log(`      - Gas per kWh: ${Number(baselineReceipt?.gasUsed || 0n) / (Number(energyWh) / 1000)}`);
      console.log("");
      console.log("    Decentralized Mode (3 Verifiers, 2/3 Quorum):");
      console.log(`      - Total gas: ${decentralizedGas}`);
      console.log(`      - Gas per kWh: ${Number(decentralizedGas) / (Number(energyWh) / 1000)}`);
      console.log("");
      console.log("    Overhead Analysis:");
      const overhead = decentralizedGas - (baselineReceipt?.gasUsed || 0n);
      const overheadPercent = Number(overhead * 100n / (baselineReceipt?.gasUsed || 1n));
      console.log(`      - Additional gas: ${overhead}`);
      console.log(`      - Overhead percentage: ${overheadPercent}%`);
      console.log("");
      console.log("    Research Question: Is the benefit lost in the validation stage?");
      console.log(`      - Validation overhead: ${overheadPercent}% additional gas cost`);
      console.log(`      - Trade-off: Decentralized trust vs. gas efficiency`);
      console.log("    ==================================================\n");

      // Verify tests passed
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(producerId, hourId))).to.be.true;
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(producerId, hourId2))).to.be.true;
    });
  });
});
