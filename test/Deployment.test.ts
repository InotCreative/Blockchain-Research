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

/**
 * Deployment Integration Tests
 * 
 * Tests the full deployment and wiring of all SEARChain contracts.
 * Verifies all contract dependencies are set correctly.
 */
describe("Deployment Integration", function () {
  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let registry: Registry;
  let treasury: Treasury;
  let productionOracle: ProductionOracle;
  let consumptionOracle: ConsumptionOracle;
  let matcher: Matcher;
  let retirement: Retirement;

  let owner: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let producer1: HardhatEthersSigner;
  let consumer1: HardhatEthersSigner;

  // Default configuration (matching deploy.ts)
  const DEFAULT_CONFIG = {
    quorumBps: 6667,
    claimWindow: 3600,
    rewardPerWhWei: BigInt(1e12),
    slashBps: 1000,
    faultThreshold: 3,
    minStake: ethers.parseEther("100"),
    protocolFeeBps: 0,
  };

  before(async function () {
    [owner, verifier1, verifier2, producer1, consumer1] = await ethers.getSigners();
  });

  describe("Full Deployment", function () {
    it("should deploy all contracts in correct order", async function () {
      // 1. Deploy SEARToken
      const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
      searToken = await SEARTokenFactory.deploy(owner.address);
      await searToken.waitForDeployment();
      expect(await searToken.getAddress()).to.be.properAddress;

      // 2. Deploy HourlyCredits
      const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
      hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
      await hourlyCredits.waitForDeployment();
      expect(await hourlyCredits.getAddress()).to.be.properAddress;

      // 3. Deploy Registry
      const RegistryFactory = await ethers.getContractFactory("Registry");
      registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
      await registry.waitForDeployment();
      expect(await registry.getAddress()).to.be.properAddress;

      // 4. Deploy Treasury
      const TreasuryFactory = await ethers.getContractFactory("Treasury");
      treasury = await TreasuryFactory.deploy(
        await searToken.getAddress(),
        await registry.getAddress(),
        owner.address
      );
      await treasury.waitForDeployment();
      expect(await treasury.getAddress()).to.be.properAddress;

      // 5. Deploy ProductionOracle
      const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
      productionOracle = await ProductionOracleFactory.deploy(
        await registry.getAddress(),
        await hourlyCredits.getAddress(),
        await treasury.getAddress(),
        owner.address
      );
      await productionOracle.waitForDeployment();
      expect(await productionOracle.getAddress()).to.be.properAddress;

      // 6. Deploy ConsumptionOracle
      const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
      consumptionOracle = await ConsumptionOracleFactory.deploy(
        await registry.getAddress(),
        await treasury.getAddress(),
        owner.address
      );
      await consumptionOracle.waitForDeployment();
      expect(await consumptionOracle.getAddress()).to.be.properAddress;


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
      expect(await matcher.getAddress()).to.be.properAddress;

      // 8. Deploy Retirement
      const RetirementFactory = await ethers.getContractFactory("Retirement");
      retirement = await RetirementFactory.deploy(
        await hourlyCredits.getAddress(),
        await productionOracle.getAddress(),
        await registry.getAddress(),
        owner.address
      );
      await retirement.waitForDeployment();
      expect(await retirement.getAddress()).to.be.properAddress;
    });

    it("should wire SEARToken dependencies correctly", async function () {
      // Set Treasury as minter
      await searToken.setTreasury(await treasury.getAddress());
      expect(await searToken.treasury()).to.equal(await treasury.getAddress());
    });

    it("should wire HourlyCredits dependencies correctly", async function () {
      // Set ProductionOracle as minter
      await hourlyCredits.setProductionOracle(await productionOracle.getAddress());
      expect(await hourlyCredits.productionOracle()).to.equal(await productionOracle.getAddress());

      // Set Retirement as burner
      await hourlyCredits.setRetirement(await retirement.getAddress());
      expect(await hourlyCredits.retirement()).to.equal(await retirement.getAddress());
    });

    it("should wire Registry dependencies correctly", async function () {
      // Set ProductionOracle
      await registry.setProductionOracle(await productionOracle.getAddress());
      expect(await registry.productionOracle()).to.equal(await productionOracle.getAddress());

      // Set ConsumptionOracle
      await registry.setConsumptionOracle(await consumptionOracle.getAddress());
      expect(await registry.consumptionOracle()).to.equal(await consumptionOracle.getAddress());

      // Verify oracle authorization
      expect(await registry.isAuthorizedOracle(await productionOracle.getAddress())).to.be.true;
      expect(await registry.isAuthorizedOracle(await consumptionOracle.getAddress())).to.be.true;
      expect(await registry.isAuthorizedOracle(owner.address)).to.be.false;
    });

    it("should wire Treasury dependencies correctly", async function () {
      // Set ProductionOracle
      await treasury.setProductionOracle(await productionOracle.getAddress());
      expect(await treasury.productionOracle()).to.equal(await productionOracle.getAddress());

      // Set ConsumptionOracle
      await treasury.setConsumptionOracle(await consumptionOracle.getAddress());
      expect(await treasury.consumptionOracle()).to.equal(await consumptionOracle.getAddress());
    });

    it("should set Registry parameters correctly", async function () {
      await registry.setQuorumBps(DEFAULT_CONFIG.quorumBps);
      expect(await registry.quorumBps()).to.equal(DEFAULT_CONFIG.quorumBps);

      await registry.setClaimWindow(DEFAULT_CONFIG.claimWindow);
      expect(await registry.claimWindow()).to.equal(DEFAULT_CONFIG.claimWindow);

      await registry.setRewardPerWhWei(DEFAULT_CONFIG.rewardPerWhWei);
      expect(await registry.rewardPerWhWei()).to.equal(DEFAULT_CONFIG.rewardPerWhWei);

      await registry.setSlashBps(DEFAULT_CONFIG.slashBps);
      expect(await registry.slashBps()).to.equal(DEFAULT_CONFIG.slashBps);

      await registry.setFaultThreshold(DEFAULT_CONFIG.faultThreshold);
      expect(await registry.faultThreshold()).to.equal(DEFAULT_CONFIG.faultThreshold);

      await registry.setMinStake(DEFAULT_CONFIG.minStake);
      expect(await registry.minStake()).to.equal(DEFAULT_CONFIG.minStake);
    });

    it("should set Matcher protocol fee correctly", async function () {
      await matcher.setProtocolFeeBps(DEFAULT_CONFIG.protocolFeeBps);
      expect(await matcher.getProtocolFeeBps()).to.equal(DEFAULT_CONFIG.protocolFeeBps);
    });
  });


  describe("Contract Ownership", function () {
    it("should set correct owner for all contracts", async function () {
      expect(await searToken.owner()).to.equal(owner.address);
      expect(await hourlyCredits.owner()).to.equal(owner.address);
      expect(await registry.owner()).to.equal(owner.address);
      expect(await treasury.owner()).to.equal(owner.address);
      expect(await productionOracle.owner()).to.equal(owner.address);
      expect(await consumptionOracle.owner()).to.equal(owner.address);
      expect(await matcher.owner()).to.equal(owner.address);
      expect(await retirement.owner()).to.equal(owner.address);
    });
  });

  describe("Cross-Contract References", function () {
    it("should have ProductionOracle correctly reference Registry", async function () {
      expect(await productionOracle.registry()).to.equal(await registry.getAddress());
    });

    it("should have ProductionOracle correctly reference HourlyCredits", async function () {
      expect(await productionOracle.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should have ProductionOracle correctly reference Treasury", async function () {
      expect(await productionOracle.treasury()).to.equal(await treasury.getAddress());
    });

    it("should have ConsumptionOracle correctly reference Registry", async function () {
      expect(await consumptionOracle.registry()).to.equal(await registry.getAddress());
    });

    it("should have ConsumptionOracle correctly reference Treasury", async function () {
      expect(await consumptionOracle.treasury()).to.equal(await treasury.getAddress());
    });

    it("should have Matcher correctly reference ConsumptionOracle", async function () {
      expect(await matcher.consumptionOracle()).to.equal(await consumptionOracle.getAddress());
    });

    it("should have Matcher correctly reference HourlyCredits", async function () {
      expect(await matcher.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should have Matcher correctly reference SEARToken", async function () {
      expect(await matcher.searToken()).to.equal(await searToken.getAddress());
    });

    it("should have Matcher correctly reference Treasury", async function () {
      expect(await matcher.treasury()).to.equal(await treasury.getAddress());
    });

    it("should have Retirement correctly reference HourlyCredits", async function () {
      expect(await retirement.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should have Retirement correctly reference ProductionOracle", async function () {
      expect(await retirement.productionOracle()).to.equal(await productionOracle.getAddress());
    });

    it("should have Retirement correctly reference Registry", async function () {
      expect(await retirement.registry()).to.equal(await registry.getAddress());
    });

    it("should have Treasury correctly reference SEARToken", async function () {
      expect(await treasury.searToken()).to.equal(await searToken.getAddress());
    });

    it("should have Treasury correctly reference Registry", async function () {
      expect(await treasury.registry()).to.equal(await registry.getAddress());
    });

    it("should have Registry correctly reference SEARToken", async function () {
      expect(await registry.searToken()).to.equal(await searToken.getAddress());
    });
  });

  describe("Access Control Verification", function () {
    it("should only allow Treasury to mint SEAR tokens", async function () {
      // Non-treasury should fail
      await expect(
        searToken.connect(owner).mint(owner.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(searToken, "OnlyTreasury");
    });

    it("should only allow ProductionOracle to mint HCN tokens", async function () {
      // Non-oracle should fail
      await expect(
        hourlyCredits.connect(owner).mint(owner.address, 1, 1000, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(hourlyCredits, "OnlyProductionOracle");
    });

    it("should only allow Retirement to burn HCN tokens", async function () {
      // Non-retirement should fail
      await expect(
        hourlyCredits.connect(owner).burn(owner.address, 1, 1000)
      ).to.be.revertedWithCustomError(hourlyCredits, "OnlyRetirement");
    });

    it("should only allow authorized oracles to create snapshots", async function () {
      const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim"));
      
      // Non-oracle should fail
      await expect(
        registry.connect(owner).createSnapshot(claimKey)
      ).to.be.revertedWithCustomError(registry, "OnlyAuthorizedOracle");
    });

    it("should only allow authorized oracles to distribute rewards", async function () {
      // Non-oracle should fail
      await expect(
        treasury.connect(owner).distributeRewards(0, 1, 1000)
      ).to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
    });

    it("should only allow authorized oracles to record faults", async function () {
      // Non-oracle should fail
      await expect(
        treasury.connect(owner).recordFault(verifier1.address, 0)
      ).to.be.revertedWithCustomError(treasury, "OnlyAuthorizedOracle");
    });
  });


  describe("End-to-End Wiring Test", function () {
    const STAKE_AMOUNT = ethers.parseEther("100");
    const INITIAL_SUPPLY = ethers.parseEther("10000");

    it("should allow complete verifier registration flow", async function () {
      // Bootstrap SEAR supply (temporarily set owner as treasury)
      await searToken.setTreasury(owner.address);
      await searToken.mint(verifier1.address, INITIAL_SUPPLY);
      await searToken.setTreasury(await treasury.getAddress());

      // Add verifier to allowlist
      await registry.addToAllowlist(verifier1.address);
      expect(await registry.isAllowlisted(verifier1.address)).to.be.true;

      // Approve and stake
      await searToken.connect(verifier1).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(verifier1).stakeAsVerifier(STAKE_AMOUNT);

      // Verify stake
      const verifierData = await registry.getVerifier(verifier1.address);
      expect(verifierData.stake).to.equal(STAKE_AMOUNT);

      // Activate verifier
      await registry.connect(verifier1).activateVerifier();
      
      // Verify active
      const activeVerifiers = await registry.getActiveVerifiers();
      expect(activeVerifiers).to.include(verifier1.address);
    });

    it("should allow complete producer registration flow", async function () {
      const systemIdHash = ethers.keccak256(ethers.toUtf8Bytes("ENPHASE-001"));
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("Test Producer"));

      const tx = await registry.connect(producer1).registerProducer(
        systemIdHash,
        metaHash,
        producer1.address
      );

      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);

      // Verify system is registered
      expect(await registry.isSystemRegistered(systemIdHash)).to.be.true;
    });

    it("should allow complete consumer registration flow", async function () {
      const meterIdHash = ethers.keccak256(ethers.toUtf8Bytes("METER-001"));
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("Test Consumer"));

      const tx = await registry.connect(consumer1).registerConsumer(
        meterIdHash,
        metaHash,
        consumer1.address
      );

      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });

    it("should allow Treasury funding flow", async function () {
      // Bootstrap SEAR supply
      await searToken.setTreasury(owner.address);
      await searToken.mint(owner.address, INITIAL_SUPPLY);
      await searToken.setTreasury(await treasury.getAddress());

      // Approve and deposit
      const depositAmount = ethers.parseEther("1000");
      await searToken.approve(await treasury.getAddress(), depositAmount);
      await treasury.deposit(depositAmount);

      // Verify pool balance
      expect(await treasury.getRewardPool()).to.equal(depositAmount);
    });
  });

  describe("Configuration Validation", function () {
    it("should reject invalid quorum (0)", async function () {
      await expect(
        registry.setQuorumBps(0)
      ).to.be.revertedWithCustomError(registry, "InvalidQuorumBps");
    });

    it("should reject invalid quorum (> 10000)", async function () {
      await expect(
        registry.setQuorumBps(10001)
      ).to.be.revertedWithCustomError(registry, "InvalidQuorumBps");
    });

    it("should accept valid quorum values", async function () {
      await registry.setQuorumBps(5000); // 50%
      expect(await registry.quorumBps()).to.equal(5000);

      await registry.setQuorumBps(10000); // 100%
      expect(await registry.quorumBps()).to.equal(10000);
    });
  });

  describe("Deployment Failure Cases", function () {
    it("should fail Treasury deployment with zero SEAR address", async function () {
      const TreasuryFactory = await ethers.getContractFactory("Treasury");
      await expect(
        TreasuryFactory.deploy(ethers.ZeroAddress, await registry.getAddress(), owner.address)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("should fail Treasury deployment with zero Registry address", async function () {
      const TreasuryFactory = await ethers.getContractFactory("Treasury");
      await expect(
        TreasuryFactory.deploy(await searToken.getAddress(), ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("should fail ProductionOracle deployment with zero Registry address", async function () {
      const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
      await expect(
        ProductionOracleFactory.deploy(
          ethers.ZeroAddress,
          await hourlyCredits.getAddress(),
          await treasury.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });

    it("should fail Matcher deployment with zero ConsumptionOracle address", async function () {
      const MatcherFactory = await ethers.getContractFactory("Matcher");
      await expect(
        MatcherFactory.deploy(
          ethers.ZeroAddress,
          await hourlyCredits.getAddress(),
          await searToken.getAddress(),
          await treasury.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(matcher, "ZeroAddress");
    });

    it("should fail Retirement deployment with zero HourlyCredits address", async function () {
      const RetirementFactory = await ethers.getContractFactory("Retirement");
      await expect(
        RetirementFactory.deploy(
          ethers.ZeroAddress,
          await productionOracle.getAddress(),
          await registry.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });
  });
});
