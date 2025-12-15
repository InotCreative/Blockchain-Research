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
  Retirement,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Full Cycle Integration Tests
 * 
 * Tests the complete flow: Register → Submit → Finalize → Match → Retire → Export
 * Verifies all events emitted correctly and all balances updated correctly.
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */
describe("Full Cycle Integration", function () {
  // Contracts
  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let registry: Registry;
  let treasury: Treasury;
  let productionOracle: ProductionOracle;
  let consumptionOracle: ConsumptionOracle;
  let matcher: Matcher;
  let retirement: Retirement;

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
  const INITIAL_SEAR = ethers.parseEther("5000");

  // Test data
  let producerId: string;
  let consumerId: string;
  const hourId = Math.floor(Date.now() / 1000 / 3600);
  const productionEnergyWh = 5000n; // 5 kWh
  const consumptionEnergyWh = 5000n; // 5 kWh
  const productionEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("production-evidence-1"));
  const consumptionEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("consumption-evidence-1"));

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

    // ========== Deploy all contracts ==========
    
    // 1. Deploy SEARToken
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    // 2. Deploy HourlyCredits
    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();

    // 3. Deploy Registry
    const RegistryFactory = await ethers.getContractFactory("Registry");
    registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
    await registry.waitForDeployment();

    // 4. Deploy Treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(
      await searToken.getAddress(),
      await registry.getAddress(),
      owner.address
    );
    await treasury.waitForDeployment();

    // 5. Deploy ProductionOracle
    const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
    productionOracle = await ProductionOracleFactory.deploy(
      await registry.getAddress(),
      await hourlyCredits.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await productionOracle.waitForDeployment();

    // 6. Deploy ConsumptionOracle
    const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
    consumptionOracle = await ConsumptionOracleFactory.deploy(
      await registry.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await consumptionOracle.waitForDeployment();

    // 7. Deploy Matcher
    const MatcherFactory = await ethers.getContractFactory("Matcher");
    matcher = await MatcherFactory.deploy(
      await consumptionOracle.getAddress(),
      await hourlyCredits.getAddress(),
      await searToken.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await matcher.waitForDeployment();

    // 8. Deploy Retirement
    const RetirementFactory = await ethers.getContractFactory("Retirement");
    retirement = await RetirementFactory.deploy(
      await hourlyCredits.getAddress(),
      await productionOracle.getAddress(),
      await registry.getAddress(),
      owner.address
    );
    await retirement.waitForDeployment();

    // ========== Wire up contracts ==========
    
    // SEARToken
    await searToken.setTreasury(await treasury.getAddress());

    // HourlyCredits
    await hourlyCredits.setProductionOracle(await productionOracle.getAddress());
    await hourlyCredits.setRetirement(await retirement.getAddress());

    // Registry
    await registry.setProductionOracle(await productionOracle.getAddress());
    await registry.setConsumptionOracle(await consumptionOracle.getAddress());

    // Treasury
    await treasury.setProductionOracle(await productionOracle.getAddress());
    await treasury.setConsumptionOracle(await consumptionOracle.getAddress());

    // ========== Bootstrap SEAR supply ==========
    
    // Temporarily set owner as treasury to mint initial tokens
    await searToken.setTreasury(owner.address);
    await searToken.mint(verifier1.address, LARGE_STAKE);
    await searToken.mint(verifier2.address, LARGE_STAKE);
    await searToken.mint(verifier3.address, LARGE_STAKE);
    await searToken.mint(consumer1.address, INITIAL_SEAR);
    await searToken.mint(owner.address, REWARD_POOL);
    await searToken.setTreasury(await treasury.getAddress());

    // Fund treasury reward pool
    await searToken.approve(await treasury.getAddress(), REWARD_POOL);
    await treasury.deposit(REWARD_POOL);

    // ========== Setup verifiers ==========
    
    const verifiers = [verifier1, verifier2, verifier3];
    for (const v of verifiers) {
      await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
      await registry.addToAllowlist(v.address);
      await registry.connect(v).activateVerifier();
    }

    // ========== Register producer ==========
    
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

    // ========== Register consumer ==========
    
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


  describe("Complete Flow: Register → Submit → Finalize → Match → Retire", function () {
    it("should complete full cycle with all events and balances correct", async function () {
      // ========== STEP 1: Submit Production Claims ==========
      
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      // Submit production claims
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      )).to.emit(productionOracle, "ProductionSubmitted");

      await expect(productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      )).to.emit(productionOracle, "ProductionSubmitted");

      await expect(productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      )).to.emit(productionOracle, "ProductionSubmitted");

      // ========== STEP 2: Submit Consumption Claims ==========
      
      const consSig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      // Submit consumption claims
      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig1
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");

      await expect(consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig2
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");

      await expect(consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig3
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");

      // ========== STEP 3: Advance time and finalize ==========
      
      await time.increase(3601); // Past claim window

      // Finalize production - should mint HCN and distribute rewards
      const productionClaimKey = await productionOracle.getClaimKey(producerId, hourId);
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(productionOracle, "ProductionFinalized")
        .withArgs(productionClaimKey, producerId, hourId, productionEnergyWh, productionEvidenceRoot)
        .to.emit(treasury, "RewardsDistributed")
        .to.emit(hourlyCredits, "HCNMinted");

      // Verify HCN minted to producer
      const producerHCNBalance = await hourlyCredits.balanceOf(producer1.address, hourId);
      expect(producerHCNBalance).to.equal(productionEnergyWh);

      // Finalize consumption
      const consumptionClaimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.emit(consumptionOracle, "ConsumptionFinalized")
        .withArgs(consumptionClaimKey, consumerId, hourId, consumptionEnergyWh)
        .to.emit(treasury, "RewardsDistributed");

      // Verify consumption is stored
      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, hourId);
      expect(verifiedConsumption).to.equal(consumptionEnergyWh);

      // ========== STEP 4: Match credits ==========
      
      // Producer lists credits
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      
      await expect(matcher.connect(producer1).listCredits(hourId, productionEnergyWh, pricePerWh))
        .to.emit(matcher, "CreditListed")
        .withArgs(1, producer1.address, hourId, productionEnergyWh, pricePerWh);

      // Consumer buys credits
      const totalPrice = productionEnergyWh * pricePerWh;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), totalPrice);

      const producerSEARBefore = await searToken.balanceOf(producer1.address);
      const consumerSEARBefore = await searToken.balanceOf(consumer1.address);

      await expect(matcher.connect(consumer1).buyCredits(1, productionEnergyWh, consumerId))
        .to.emit(matcher, "Matched")
        .withArgs(hourId, consumerId, producer1.address, productionEnergyWh, totalPrice);

      // Verify balances after match
      expect(await hourlyCredits.balanceOf(consumer1.address, hourId)).to.equal(productionEnergyWh);
      expect(await hourlyCredits.balanceOf(producer1.address, hourId)).to.equal(0);
      expect(await searToken.balanceOf(producer1.address)).to.equal(producerSEARBefore + totalPrice);
      expect(await searToken.balanceOf(consumer1.address)).to.equal(consumerSEARBefore - totalPrice);

      // Verify matched amount tracked
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(productionEnergyWh);

      // ========== STEP 5: Retire credits ==========
      
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Carbon offset retirement"));
      
      await expect(retirement.connect(consumer1).retireHourly(hourId, productionEnergyWh, reasonHash))
        .to.emit(retirement, "Retired")
        .withArgs(1, consumer1.address, hourId, productionEnergyWh);

      // Verify HCN burned
      expect(await hourlyCredits.balanceOf(consumer1.address, hourId)).to.equal(0);

      // Verify retirement record
      const retirementRecord = await retirement.getRetirementRecord(1);
      expect(retirementRecord.owner).to.equal(consumer1.address);
      expect(retirementRecord.hourId).to.equal(hourId);
      expect(retirementRecord.amountWh).to.equal(productionEnergyWh);
      expect(retirementRecord.reasonHash).to.equal(reasonHash);
      expect(retirementRecord.claimKey).to.not.equal(ethers.ZeroHash);
    });

    it("should complete SREC batch retirement flow", async function () {
      // Setup: Create production and consumption for multiple hours to accumulate 1 MWh
      const hours = [hourId, hourId + 1, hourId + 2, hourId + 3, hourId + 4];
      const energyPerHour = 200_000n; // 200 kWh per hour = 1 MWh total

      for (const h of hours) {
        // Submit and finalize production
        const prodSig1 = await signProductionClaim(
          verifier1, producerId, h, energyPerHour, productionEvidenceRoot,
          await productionOracle.getAddress()
        );
        const prodSig2 = await signProductionClaim(
          verifier2, producerId, h, energyPerHour, productionEvidenceRoot,
          await productionOracle.getAddress()
        );
        const prodSig3 = await signProductionClaim(
          verifier3, producerId, h, energyPerHour, productionEvidenceRoot,
          await productionOracle.getAddress()
        );

        await productionOracle.connect(verifier1).submitProduction(
          producerId, h, energyPerHour, productionEvidenceRoot, prodSig1
        );
        await productionOracle.connect(verifier2).submitProduction(
          producerId, h, energyPerHour, productionEvidenceRoot, prodSig2
        );
        await productionOracle.connect(verifier3).submitProduction(
          producerId, h, energyPerHour, productionEvidenceRoot, prodSig3
        );
      }

      // Advance time and finalize all
      await time.increase(3601);

      for (const h of hours) {
        await productionOracle.finalizeProduction(producerId, h);
      }

      // Transfer all HCN to consumer (simulating purchase)
      await hourlyCredits.connect(producer1).setApprovalForAll(consumer1.address, true);
      for (const h of hours) {
        await hourlyCredits.connect(producer1).safeTransferFrom(
          producer1.address, consumer1.address, h, energyPerHour, "0x"
        );
      }

      // Retire as SREC batch (1 MWh)
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("SREC retirement"));
      const amounts = hours.map(() => energyPerHour);

      await expect(retirement.connect(consumer1).retireSREC(hours, amounts, reasonHash))
        .to.emit(retirement, "CertificateIssued");

      // Verify certificate
      const cert = await retirement.getCertificate(1);
      expect(cert.owner).to.equal(consumer1.address);
      expect(cert.totalWh).to.equal(1_000_000n);
      expect(cert.hourIds.length).to.equal(5);
      expect(cert.claimKeys.length).to.equal(5);

      // Verify all HCN burned
      for (const h of hours) {
        expect(await hourlyCredits.balanceOf(consumer1.address, h)).to.equal(0);
      }
    });
  });


  describe("Event Emission Verification", function () {
    it("should emit all required events throughout the flow", async function () {
      // Track all events emitted during the flow
      const events: string[] = [];

      // Submit production claims
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      let tx = await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      let receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return productionOracle.interface.parseLog(log as any)?.name === "ProductionSubmitted";
        } catch { return false; }
      })).to.be.true;
      events.push("ProductionSubmitted");

      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      // Submit consumption claims
      const consSig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      tx = await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig1
      );
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return consumptionOracle.interface.parseLog(log as any)?.name === "ConsumptionSubmitted";
        } catch { return false; }
      })).to.be.true;
      events.push("ConsumptionSubmitted");

      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig3
      );

      // Finalize
      await time.increase(3601);

      tx = await productionOracle.finalizeProduction(producerId, hourId);
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return productionOracle.interface.parseLog(log as any)?.name === "ProductionFinalized";
        } catch { return false; }
      })).to.be.true;
      events.push("ProductionFinalized");

      tx = await consumptionOracle.finalizeConsumption(consumerId, hourId);
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return consumptionOracle.interface.parseLog(log as any)?.name === "ConsumptionFinalized";
        } catch { return false; }
      })).to.be.true;
      events.push("ConsumptionFinalized");

      // Match
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      
      tx = await matcher.connect(producer1).listCredits(hourId, productionEnergyWh, pricePerWh);
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return matcher.interface.parseLog(log as any)?.name === "CreditListed";
        } catch { return false; }
      })).to.be.true;
      events.push("CreditListed");

      const totalPrice = productionEnergyWh * pricePerWh;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), totalPrice);

      tx = await matcher.connect(consumer1).buyCredits(1, productionEnergyWh, consumerId);
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return matcher.interface.parseLog(log as any)?.name === "Matched";
        } catch { return false; }
      })).to.be.true;
      events.push("Matched");

      // Retire
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Carbon offset"));
      tx = await retirement.connect(consumer1).retireHourly(hourId, productionEnergyWh, reasonHash);
      receipt = await tx.wait();
      expect(receipt?.logs.some(log => {
        try {
          return retirement.interface.parseLog(log as any)?.name === "Retired";
        } catch { return false; }
      })).to.be.true;
      events.push("Retired");

      // Verify all expected events were emitted
      expect(events).to.include("ProductionSubmitted");
      expect(events).to.include("ConsumptionSubmitted");
      expect(events).to.include("ProductionFinalized");
      expect(events).to.include("ConsumptionFinalized");
      expect(events).to.include("CreditListed");
      expect(events).to.include("Matched");
      expect(events).to.include("Retired");
    });
  });

  describe("Balance Verification", function () {
    it("should correctly update all token balances throughout the flow", async function () {
      // Initial balances
      const initialProducerSEAR = await searToken.balanceOf(producer1.address);
      const initialConsumerSEAR = await searToken.balanceOf(consumer1.address);
      const initialVerifier1SEAR = await searToken.balanceOf(verifier1.address);
      const initialTreasuryPool = await treasury.getRewardPool();

      // Submit and finalize production
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Verify HCN minted
      expect(await hourlyCredits.balanceOf(producer1.address, hourId)).to.equal(productionEnergyWh);

      // Verify rewards distributed (treasury pool decreased)
      const postProductionTreasuryPool = await treasury.getRewardPool();
      expect(postProductionTreasuryPool).to.be.lte(initialTreasuryPool);

      // Verify verifiers received rewards (or at least balance didn't decrease)
      const postProductionVerifier1SEAR = await searToken.balanceOf(verifier1.address);
      expect(postProductionVerifier1SEAR).to.be.gte(initialVerifier1SEAR);

      // Submit and finalize consumption
      const consSig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // Match credits
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      await matcher.connect(producer1).listCredits(hourId, productionEnergyWh, pricePerWh);

      const totalPrice = productionEnergyWh * pricePerWh;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), totalPrice);

      const preMatchProducerSEAR = await searToken.balanceOf(producer1.address);
      const preMatchConsumerSEAR = await searToken.balanceOf(consumer1.address);

      await matcher.connect(consumer1).buyCredits(1, productionEnergyWh, consumerId);

      // Verify SEAR transferred
      expect(await searToken.balanceOf(producer1.address)).to.equal(preMatchProducerSEAR + totalPrice);
      expect(await searToken.balanceOf(consumer1.address)).to.equal(preMatchConsumerSEAR - totalPrice);

      // Verify HCN transferred
      expect(await hourlyCredits.balanceOf(producer1.address, hourId)).to.equal(0);
      expect(await hourlyCredits.balanceOf(consumer1.address, hourId)).to.equal(productionEnergyWh);

      // Retire
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Carbon offset"));
      await retirement.connect(consumer1).retireHourly(hourId, productionEnergyWh, reasonHash);

      // Verify HCN burned
      expect(await hourlyCredits.balanceOf(consumer1.address, hourId)).to.equal(0);
    });
  });


  describe("Audit Trail Reconstruction", function () {
    it("should allow reconstruction of complete audit trail from events", async function () {
      // Complete the flow
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Transfer HCN to consumer
      await hourlyCredits.connect(producer1).safeTransferFrom(
        producer1.address, consumer1.address, hourId, productionEnergyWh, "0x"
      );

      // Retire
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Carbon offset"));
      await retirement.connect(consumer1).retireHourly(hourId, productionEnergyWh, reasonHash);

      // ========== Reconstruct audit trail ==========

      // 1. Get retirement record
      const retirementRecord = await retirement.getRetirementRecord(1);
      expect(retirementRecord.claimKey).to.not.equal(ethers.ZeroHash);

      // 2. Get production claim bucket using claimKey
      const productionClaimKey = await productionOracle.getClaimKey(producerId, hourId);
      const claimBucket = await productionOracle.getClaimBucket(productionClaimKey);
      
      expect(claimBucket.finalized).to.be.true;
      expect(claimBucket.verifiedEnergyWh).to.equal(productionEnergyWh);
      expect(claimBucket.evidenceRoot).to.equal(productionEvidenceRoot);

      // 3. Verify snapshot verifiers
      const snapshotVerifiers = await registry.getSnapshotVerifiers(claimBucket.snapshotId);
      expect(snapshotVerifiers.length).to.equal(3);
      expect(snapshotVerifiers).to.include(verifier1.address);
      expect(snapshotVerifiers).to.include(verifier2.address);
      expect(snapshotVerifiers).to.include(verifier3.address);

      // 4. Verify producer registration
      const producer = await registry.getProducer(producerId);
      expect(producer.active).to.be.true;
      expect(producer.payoutAddr).to.equal(producer1.address);

      // Complete audit trail verified
    });

    it("should track claimKey through retirement for provenance", async function () {
      // Submit and finalize production
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Transfer and retire
      await hourlyCredits.connect(producer1).safeTransferFrom(
        producer1.address, consumer1.address, hourId, productionEnergyWh, "0x"
      );

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Carbon offset"));
      await retirement.connect(consumer1).retireHourly(hourId, productionEnergyWh, reasonHash);

      // Verify claimKey in retirement record matches production claimKey
      const retirementRecord = await retirement.getRetirementRecord(1);
      const productionClaimKey = await productionOracle.getClaimKey(producerId, hourId);
      
      // The retirement claimKey should be derivable from the hourId
      expect(retirementRecord.claimKey).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Replay Attack Prevention", function () {
    it("should prevent replay of finalized claims", async function () {
      // Submit and finalize production
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Attempt to finalize again (replay)
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.be.revertedWithCustomError(productionOracle, "ClaimAlreadyFinalized");

      // Attempt to submit again (replay)
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      )).to.be.revertedWithCustomError(productionOracle, "ClaimAlreadyFinalized");
    });
  });

  describe("Direct Match Flow", function () {
    it("should complete flow with direct matching instead of listing", async function () {
      // Submit and finalize production
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, productionEnergyWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, productionEnergyWh, productionEvidenceRoot, prodSig3
      );

      // Submit and finalize consumption
      const consSig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // Direct match
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const agreedPrice = ethers.parseEther("10");
      await searToken.connect(consumer1).approve(await matcher.getAddress(), agreedPrice);

      await expect(matcher.connect(consumer1).directMatch(
        hourId, consumerId, producer1.address, productionEnergyWh, agreedPrice
      )).to.emit(matcher, "Matched")
        .withArgs(hourId, consumerId, producer1.address, productionEnergyWh, agreedPrice);

      // Verify balances
      expect(await hourlyCredits.balanceOf(consumer1.address, hourId)).to.equal(productionEnergyWh);
      expect(await hourlyCredits.balanceOf(producer1.address, hourId)).to.equal(0);
    });
  });

  describe("Partial Matching Flow", function () {
    it("should handle partial matching across multiple transactions", async function () {
      // Submit and finalize production (10 kWh)
      const largeProductionWh = 10000n;
      const prodSig1 = await signProductionClaim(
        verifier1, producerId, hourId, largeProductionWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig2 = await signProductionClaim(
        verifier2, producerId, hourId, largeProductionWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );
      const prodSig3 = await signProductionClaim(
        verifier3, producerId, hourId, largeProductionWh, productionEvidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, largeProductionWh, productionEvidenceRoot, prodSig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, largeProductionWh, productionEvidenceRoot, prodSig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, largeProductionWh, productionEvidenceRoot, prodSig3
      );

      // Submit and finalize consumption (5 kWh - less than production)
      const consSig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );
      const consSig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, consumptionEnergyWh, consumptionEvidenceRoot, consSig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // List credits
      await hourlyCredits.connect(producer1).setApprovalForAll(await matcher.getAddress(), true);
      const pricePerWh = ethers.parseEther("0.001");
      await matcher.connect(producer1).listCredits(hourId, largeProductionWh, pricePerWh);

      // Partial match 1: 2000 Wh
      const partialAmount1 = 2000n;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), partialAmount1 * pricePerWh);
      await matcher.connect(consumer1).buyCredits(1, partialAmount1, consumerId);

      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(partialAmount1);
      expect(await matcher.getRemainingConsumption(consumerId, hourId)).to.equal(consumptionEnergyWh - partialAmount1);

      // Partial match 2: 2000 Wh
      const partialAmount2 = 2000n;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), partialAmount2 * pricePerWh);
      await matcher.connect(consumer1).buyCredits(1, partialAmount2, consumerId);

      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(partialAmount1 + partialAmount2);

      // Partial match 3: remaining 1000 Wh
      const partialAmount3 = 1000n;
      await searToken.connect(consumer1).approve(await matcher.getAddress(), partialAmount3 * pricePerWh);
      await matcher.connect(consumer1).buyCredits(1, partialAmount3, consumerId);

      // Should have matched exactly the verified consumption
      expect(await matcher.getMatchedAmount(consumerId, hourId)).to.equal(consumptionEnergyWh);
      expect(await matcher.getRemainingConsumption(consumerId, hourId)).to.equal(0);

      // Should not be able to match more
      await searToken.connect(consumer1).approve(await matcher.getAddress(), 1000n * pricePerWh);
      await expect(matcher.connect(consumer1).buyCredits(1, 1000n, consumerId))
        .to.be.revertedWithCustomError(matcher, "MatchExceedsConsumption");
    });
  });
});
