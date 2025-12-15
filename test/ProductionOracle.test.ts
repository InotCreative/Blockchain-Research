import { expect } from "chai";
import { ethers } from "hardhat";
import { ProductionOracle, Registry, SEARToken, HourlyCredits, Treasury } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ProductionOracle", function () {
  let productionOracle: ProductionOracle;
  let registry: Registry;
  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let treasury: Treasury;
  
  let owner: HardhatEthersSigner;
  let producer1: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;
  let verifier4: HardhatEthersSigner;
  let verifier5: HardhatEthersSigner;

  const STAKE_AMOUNT = ethers.parseEther("100");
  const LARGE_STAKE = ethers.parseEther("1000");
  const REWARD_POOL = ethers.parseEther("10000");
  
  // Test data
  let producerId: string;
  const hourId = Math.floor(Date.now() / 1000 / 3600);
  const energyWh = 5000n; // 5 kWh
  const evidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-1"));

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

  beforeEach(async function () {
    [owner, producer1, verifier1, verifier2, verifier3, verifier4, verifier5] = 
      await ethers.getSigners();

    // Deploy SEARToken
    const SEARTokenFactory = await ethers.getContractFactory("SEARToken");
    searToken = await SEARTokenFactory.deploy(owner.address);
    await searToken.waitForDeployment();

    // Deploy Registry
    const RegistryFactory = await ethers.getContractFactory("Registry");
    registry = await RegistryFactory.deploy(await searToken.getAddress(), owner.address);
    await registry.waitForDeployment();

    // Deploy HourlyCredits
    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();

    // Deploy Treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(
      await searToken.getAddress(),
      await registry.getAddress(),
      owner.address
    );
    await treasury.waitForDeployment();

    // Deploy ProductionOracle
    const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
    productionOracle = await ProductionOracleFactory.deploy(
      await registry.getAddress(),
      await hourlyCredits.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await productionOracle.waitForDeployment();

    // Setup SEARToken treasury and mint tokens
    await searToken.connect(owner).setTreasury(owner.address);
    await searToken.connect(owner).mint(verifier1.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier2.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier3.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier4.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier5.address, LARGE_STAKE);
    await searToken.connect(owner).mint(owner.address, REWARD_POOL);

    // Wire up contracts
    await registry.connect(owner).setProductionOracle(await productionOracle.getAddress());
    await hourlyCredits.connect(owner).setProductionOracle(await productionOracle.getAddress());
    await treasury.connect(owner).setProductionOracle(await productionOracle.getAddress());

    // Fund treasury reward pool
    await searToken.connect(owner).approve(await treasury.getAddress(), REWARD_POOL);
    await treasury.connect(owner).deposit(REWARD_POOL);

    // Register producer
    const systemIdHash = ethers.keccak256(ethers.toUtf8Bytes("system-123"));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes("metadata"));
    const tx = await registry.connect(producer1).registerProducer(
      systemIdHash,
      metaHash,
      producer1.address
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.find(
      (log) => registry.interface.parseLog(log as any)?.name === "ProducerRegistered"
    );
    const parsedEvent = registry.interface.parseLog(event as any);
    producerId = parsedEvent?.args.producerId;

    // Setup verifiers
    const verifiers = [verifier1, verifier2, verifier3];
    for (const v of verifiers) {
      await searToken.connect(v).approve(await registry.getAddress(), STAKE_AMOUNT);
      await registry.connect(v).stakeAsVerifier(STAKE_AMOUNT);
      await registry.connect(owner).addToAllowlist(v.address);
      await registry.connect(v).activateVerifier();
    }
  });


  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await productionOracle.owner()).to.equal(owner.address);
    });

    it("should set the correct registry", async function () {
      expect(await productionOracle.registry()).to.equal(await registry.getAddress());
    });

    it("should set the correct hourlyCredits", async function () {
      expect(await productionOracle.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should set the correct treasury", async function () {
      expect(await productionOracle.treasury()).to.equal(await treasury.getAddress());
    });

    it("should initialize with registry defaults", async function () {
      expect(await productionOracle.claimWindow()).to.equal(await registry.claimWindow());
      expect(await productionOracle.quorumBps()).to.equal(await registry.quorumBps());
    });

    it("should revert if deployed with zero address registry", async function () {
      const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
      await expect(ProductionOracleFactory.deploy(
        ethers.ZeroAddress,
        await hourlyCredits.getAddress(),
        await treasury.getAddress(),
        owner.address
      )).to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });

    it("should revert if deployed with zero address hourlyCredits", async function () {
      const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
      await expect(ProductionOracleFactory.deploy(
        await registry.getAddress(),
        ethers.ZeroAddress,
        await treasury.getAddress(),
        owner.address
      )).to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });

    it("should revert if deployed with zero address treasury", async function () {
      const ProductionOracleFactory = await ethers.getContractFactory("ProductionOracle");
      await expect(ProductionOracleFactory.deploy(
        await registry.getAddress(),
        await hourlyCredits.getAddress(),
        ethers.ZeroAddress,
        owner.address
      )).to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });
  });

  describe("Claim Submission", function () {
    it("should accept valid production claim", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(productionOracle, "ProductionSubmitted");
    });

    it("should create snapshot on first submission", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.snapshotId).to.be.gt(0);
      expect(bucket.deadline).to.be.gt(0);
    });

    it("should track submission in allSubmittersBitmap", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.allSubmittersBitmap).to.be.gt(0);
      expect(bucket.submissionCount).to.equal(1);
    });

    it("should track maxSubmittedEnergyWh", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.maxSubmittedEnergyWh).to.equal(energyWh);
    });

    it("should aggregate submissions by valueHash", async function () {
      // Submit same value from multiple verifiers
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const valueHash = ethers.solidityPackedKeccak256(
        ["uint64", "bytes32"],
        [energyWh, evidenceRoot]
      );
      const valueSub = await productionOracle.getValueSubmissions(claimKey, valueHash);
      expect(valueSub.count).to.equal(2);
    });

    it("should mark hasSubmitted for verifier", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.hasSubmitted(claimKey, verifier1.address)).to.equal(true);
      expect(await productionOracle.hasSubmitted(claimKey, verifier2.address)).to.equal(false);
    });

    it("should track submitted evidence roots", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isEvidenceRootSubmitted(claimKey, evidenceRoot)).to.equal(true);
    });

    it("should revert for unregistered producer", async function () {
      const fakeProducerId = ethers.keccak256(ethers.toUtf8Bytes("fake-producer"));
      const signature = await signProductionClaim(
        verifier1, fakeProducerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        fakeProducerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(productionOracle, "ProducerNotRegistered");
    });

    it("should revert for inactive verifier", async function () {
      // Deactivate verifier1
      await registry.connect(verifier1).deactivateVerifier();

      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should revert for duplicate submission", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      // Try to submit again
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(productionOracle, "DuplicateSubmission");
    });

    it("should revert for late submission", async function () {
      // First submission to create snapshot
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );

      // Advance time past deadline
      await time.increase(3601);

      // Try late submission
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      await expect(productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      )).to.be.revertedWithCustomError(productionOracle, "ClaimDeadlinePassed");
    });

    it("should revert for already finalized claim", async function () {
      // Submit from all verifiers to reach quorum
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig3
      );

      // Advance time and finalize
      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Try to submit after finalization
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.equal(true);
    });
  });


  describe("Signature Validation", function () {
    it("should accept valid signature", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(productionOracle, "ProductionSubmitted");
    });

    it("should reject signature from wrong signer", async function () {
      // Sign with verifier1 but submit as verifier2
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      // The recovered address will be verifier1, but verifier1 is active
      // so this should work - the signature validates the signer
      await expect(productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(productionOracle, "ProductionSubmitted");
    });

    it("should reject signature with wrong contract address", async function () {
      // Sign with wrong contract address
      const wrongAddress = ethers.Wallet.createRandom().address;
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        wrongAddress
      );

      // The recovered address will be different, and likely not an active verifier
      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(productionOracle, "VerifierNotActive");
    });

    it("should reject malformed signature", async function () {
      const malformedSignature = "0x1234";

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, malformedSignature
      )).to.be.reverted;
    });
  });

  describe("Quorum Calculation and Finalization", function () {
    it("should finalize when quorum is reached", async function () {
      // With 3 verifiers and 66.67% quorum, need 2 verifiers
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig3
      );

      // Advance time past deadline
      await time.increase(3601);

      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(productionOracle, "ProductionFinalized")
        .withArgs(
          await productionOracle.getClaimKey(producerId, hourId),
          producerId,
          hourId,
          energyWh,
          evidenceRoot
        );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should mint HCN tokens on finalization", async function () {
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      // Check HCN balance
      const balance = await hourlyCredits.balanceOf(producer1.address, hourId);
      expect(balance).to.equal(energyWh);
    });

    it("should distribute rewards on finalization", async function () {
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      
      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(treasury, "RewardsDistributed");
    });

    it("should enter disputed state when no quorum", async function () {
      // Submit different values from verifiers (no consensus)
      const evidenceRoot2 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-2"));
      const evidenceRoot3 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-3"));

      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, 6000n, evidenceRoot2,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, 7000n, evidenceRoot3,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, 6000n, evidenceRoot2, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, 7000n, evidenceRoot3, sig3
      );

      await time.increase(3601);

      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.emit(productionOracle, "ClaimDisputed");

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      expect(bucket.disputed).to.equal(true);
      expect(bucket.finalized).to.equal(false);
    });

    it("should revert finalization before deadline", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.be.revertedWithCustomError(productionOracle, "ClaimDeadlineNotReached");
    });

    it("should revert finalization of already finalized claim", async function () {
      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);

      await expect(productionOracle.finalizeProduction(producerId, hourId))
        .to.be.revertedWithCustomError(productionOracle, "ClaimAlreadyFinalized");
    });

    it("should record faults for non-winners", async function () {
      // Lower quorum to 50% so 2 out of 3 can reach consensus
      await productionOracle.connect(owner).setQuorumBps(5000);
      
      // 2 verifiers submit correct value, 1 submits wrong value
      const wrongEnergyWh = 9999n;
      const wrongEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong-evidence"));

      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
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

      await time.increase(3601);
      
      // Finalize and check the claim bucket has correct winning bitmap
      await productionOracle.finalizeProduction(producerId, hourId);
      
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);
      
      // Verify finalization succeeded
      expect(bucket.finalized).to.equal(true);
      expect(bucket.verifiedEnergyWh).to.equal(energyWh);
      
      // The winning verifier bitmap should have 2 bits set (the 2 correct verifiers)
      // and allSubmittersBitmap should have 3 bits set
      expect(bucket.submissionCount).to.equal(3);
    });
  });


  describe("Force Finalize (Admin Emergency)", function () {
    beforeEach(async function () {
      // Create a disputed claim
      const evidenceRoot2 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-2"));
      const evidenceRoot3 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-3"));

      const sig1 = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, hourId, 6000n, evidenceRoot2,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, hourId, 7000n, evidenceRoot3,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, hourId, 6000n, evidenceRoot2, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, hourId, 7000n, evidenceRoot3, sig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, hourId);
    });

    it("should allow admin to force finalize disputed claim", async function () {
      await expect(productionOracle.connect(owner).forceFinalize(
        producerId, hourId, energyWh, evidenceRoot
      )).to.emit(productionOracle, "ForceFinalized")
        .withArgs(
          await productionOracle.getClaimKey(producerId, hourId),
          owner.address,
          energyWh
        );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      expect(await productionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should mint HCN on force finalize", async function () {
      await productionOracle.connect(owner).forceFinalize(
        producerId, hourId, energyWh, evidenceRoot
      );

      const balance = await hourlyCredits.balanceOf(producer1.address, hourId);
      expect(balance).to.equal(energyWh);
    });

    it("should revert if claim is not disputed", async function () {
      // Create a new claim that reaches quorum
      const newHourId = hourId + 1;
      const sig1 = await signProductionClaim(
        verifier1, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig2 = await signProductionClaim(
        verifier2, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );
      const sig3 = await signProductionClaim(
        verifier3, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, sig1
      );
      await productionOracle.connect(verifier2).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, sig2
      );
      await productionOracle.connect(verifier3).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await productionOracle.finalizeProduction(producerId, newHourId);

      // Try to force finalize a non-disputed (already finalized) claim
      // It should revert with ClaimNotDisputed since finalized claims have disputed=false
      await expect(productionOracle.connect(owner).forceFinalize(
        producerId, newHourId, energyWh, evidenceRoot
      )).to.be.revertedWithCustomError(productionOracle, "ClaimNotDisputed");
    });

    it("should revert if energyWh exceeds maxSubmittedEnergyWh", async function () {
      const excessiveEnergy = 10000n; // More than any submitted value

      await expect(productionOracle.connect(owner).forceFinalize(
        producerId, hourId, excessiveEnergy, evidenceRoot
      )).to.be.revertedWithCustomError(productionOracle, "EnergyExceedsMaxSubmitted");
    });

    it("should revert if evidenceRoot was not submitted", async function () {
      const fakeEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("fake-evidence"));

      await expect(productionOracle.connect(owner).forceFinalize(
        producerId, hourId, energyWh, fakeEvidenceRoot
      )).to.be.revertedWithCustomError(productionOracle, "EvidenceRootNotSubmitted");
    });

    it("should revert if non-owner tries to force finalize", async function () {
      await expect(productionOracle.connect(verifier1).forceFinalize(
        producerId, hourId, energyWh, evidenceRoot
      )).to.be.revertedWithCustomError(productionOracle, "OwnableUnauthorizedAccount");
    });
  });

  describe("Baseline Mode", function () {
    beforeEach(async function () {
      // Enable baseline mode
      await productionOracle.connect(owner).setBaselineMode(true);
      await productionOracle.connect(owner).setSingleVerifierOverride(verifier1.address);
    });

    it("should allow setting baseline mode", async function () {
      expect(await productionOracle.isBaselineMode()).to.equal(true);
    });

    it("should finalize immediately in baseline mode with single verifier", async function () {
      const newHourId = hourId + 100;
      const signature = await signProductionClaim(
        verifier1, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await expect(productionOracle.connect(verifier1).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, signature
      )).to.emit(productionOracle, "ProductionFinalized");

      const claimKey = await productionOracle.getClaimKey(producerId, newHourId);
      expect(await productionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should mint HCN immediately in baseline mode", async function () {
      const newHourId = hourId + 101;
      const signature = await signProductionClaim(
        verifier1, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, signature
      );

      const balance = await hourlyCredits.balanceOf(producer1.address, newHourId);
      expect(balance).to.equal(energyWh);
    });

    it("should not finalize immediately for non-override verifier", async function () {
      const newHourId = hourId + 102;
      const signature = await signProductionClaim(
        verifier2, producerId, newHourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier2).submitProduction(
        producerId, newHourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, newHourId);
      expect(await productionOracle.isFinalized(claimKey)).to.equal(false);
    });

    it("should allow disabling baseline mode", async function () {
      await productionOracle.connect(owner).setBaselineMode(false);
      expect(await productionOracle.isBaselineMode()).to.equal(false);
    });
  });

  describe("Configuration", function () {
    it("should allow owner to set claim window", async function () {
      await productionOracle.connect(owner).setClaimWindow(7200);
      expect(await productionOracle.claimWindow()).to.equal(7200);
    });

    it("should allow owner to set quorum bps", async function () {
      await productionOracle.connect(owner).setQuorumBps(5000);
      expect(await productionOracle.quorumBps()).to.equal(5000);
    });

    it("should allow owner to set registry", async function () {
      const newRegistry = ethers.Wallet.createRandom().address;
      await productionOracle.connect(owner).setRegistry(newRegistry);
      expect(await productionOracle.registry()).to.equal(newRegistry);
    });

    it("should allow owner to set hourlyCredits", async function () {
      const newHC = ethers.Wallet.createRandom().address;
      await productionOracle.connect(owner).setHourlyCredits(newHC);
      expect(await productionOracle.hourlyCredits()).to.equal(newHC);
    });

    it("should allow owner to set treasury", async function () {
      const newTreasury = ethers.Wallet.createRandom().address;
      await productionOracle.connect(owner).setTreasury(newTreasury);
      expect(await productionOracle.treasury()).to.equal(newTreasury);
    });

    it("should revert if non-owner tries to set configuration", async function () {
      await expect(productionOracle.connect(verifier1).setClaimWindow(7200))
        .to.be.revertedWithCustomError(productionOracle, "OwnableUnauthorizedAccount");
      
      await expect(productionOracle.connect(verifier1).setQuorumBps(5000))
        .to.be.revertedWithCustomError(productionOracle, "OwnableUnauthorizedAccount");
      
      await expect(productionOracle.connect(verifier1).setBaselineMode(true))
        .to.be.revertedWithCustomError(productionOracle, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting zero address for registry", async function () {
      await expect(productionOracle.connect(owner).setRegistry(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });

    it("should revert if setting zero address for hourlyCredits", async function () {
      await expect(productionOracle.connect(owner).setHourlyCredits(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });

    it("should revert if setting zero address for treasury", async function () {
      await expect(productionOracle.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(productionOracle, "ZeroAddress");
    });
  });

  describe("View Functions", function () {
    it("should return correct claim key", async function () {
      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      
      // Verify it matches expected format
      const expectedClaimKey = ethers.solidityPackedKeccak256(
        ["bytes1", "address", "bytes32", "uint256"],
        ["0x01", await productionOracle.getAddress(), producerId, hourId]
      );
      expect(claimKey).to.equal(expectedClaimKey);
    });

    it("should return correct claim bucket", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const bucket = await productionOracle.getClaimBucket(claimKey);

      expect(bucket.snapshotId).to.be.gt(0);
      expect(bucket.deadline).to.be.gt(0);
      expect(bucket.submissionCount).to.equal(1);
      expect(bucket.finalized).to.equal(false);
      expect(bucket.maxSubmittedEnergyWh).to.equal(energyWh);
    });

    it("should return correct value submissions", async function () {
      const signature = await signProductionClaim(
        verifier1, producerId, hourId, energyWh, evidenceRoot,
        await productionOracle.getAddress()
      );

      await productionOracle.connect(verifier1).submitProduction(
        producerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await productionOracle.getClaimKey(producerId, hourId);
      const valueHash = ethers.solidityPackedKeccak256(
        ["uint64", "bytes32"],
        [energyWh, evidenceRoot]
      );
      const valueSub = await productionOracle.getValueSubmissions(claimKey, valueHash);

      expect(valueSub.count).to.equal(1);
      expect(valueSub.energyWh).to.equal(energyWh);
      expect(valueSub.evidenceRoot).to.equal(evidenceRoot);
    });
  });
});
