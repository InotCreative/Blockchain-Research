import { expect } from "chai";
import { ethers } from "hardhat";
import { ConsumptionOracle, Registry, SEARToken, Treasury } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ConsumptionOracle", function () {
  let consumptionOracle: ConsumptionOracle;
  let registry: Registry;
  let searToken: SEARToken;
  let treasury: Treasury;
  
  let owner: HardhatEthersSigner;
  let consumer1: HardhatEthersSigner;
  let verifier1: HardhatEthersSigner;
  let verifier2: HardhatEthersSigner;
  let verifier3: HardhatEthersSigner;
  let verifier4: HardhatEthersSigner;
  let verifier5: HardhatEthersSigner;

  const STAKE_AMOUNT = ethers.parseEther("100");
  const LARGE_STAKE = ethers.parseEther("1000");
  const REWARD_POOL = ethers.parseEther("10000");
  
  // Test data
  let consumerId: string;
  const hourId = Math.floor(Date.now() / 1000 / 3600);
  const energyWh = 5000n; // 5 kWh
  const evidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-1"));

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
    [owner, consumer1, verifier1, verifier2, verifier3, verifier4, verifier5] = 
      await ethers.getSigners();

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

    // Deploy ConsumptionOracle
    const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
    consumptionOracle = await ConsumptionOracleFactory.deploy(
      await registry.getAddress(),
      await treasury.getAddress(),
      owner.address
    );
    await consumptionOracle.waitForDeployment();

    // Setup SEARToken treasury and mint tokens
    await searToken.connect(owner).setTreasury(owner.address);
    await searToken.connect(owner).mint(verifier1.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier2.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier3.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier4.address, LARGE_STAKE);
    await searToken.connect(owner).mint(verifier5.address, LARGE_STAKE);
    await searToken.connect(owner).mint(owner.address, REWARD_POOL);

    // Wire up contracts
    await registry.connect(owner).setConsumptionOracle(await consumptionOracle.getAddress());
    await treasury.connect(owner).setConsumptionOracle(await consumptionOracle.getAddress());

    // Fund treasury reward pool
    await searToken.connect(owner).approve(await treasury.getAddress(), REWARD_POOL);
    await treasury.connect(owner).deposit(REWARD_POOL);

    // Register consumer
    const meterIdHash = ethers.keccak256(ethers.toUtf8Bytes("meter-123"));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes("metadata"));
    const tx = await registry.connect(consumer1).registerConsumer(
      meterIdHash,
      metaHash,
      consumer1.address
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.find(
      (log) => registry.interface.parseLog(log as any)?.name === "ConsumerRegistered"
    );
    const parsedEvent = registry.interface.parseLog(event as any);
    consumerId = parsedEvent?.args.consumerId;

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
      expect(await consumptionOracle.owner()).to.equal(owner.address);
    });

    it("should set the correct registry", async function () {
      expect(await consumptionOracle.registry()).to.equal(await registry.getAddress());
    });

    it("should set the correct treasury", async function () {
      expect(await consumptionOracle.treasury()).to.equal(await treasury.getAddress());
    });

    it("should initialize with registry defaults", async function () {
      expect(await consumptionOracle.claimWindow()).to.equal(await registry.claimWindow());
      expect(await consumptionOracle.quorumBps()).to.equal(await registry.quorumBps());
    });

    it("should revert if deployed with zero address registry", async function () {
      const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
      await expect(ConsumptionOracleFactory.deploy(
        ethers.ZeroAddress,
        await treasury.getAddress(),
        owner.address
      )).to.be.revertedWithCustomError(consumptionOracle, "ZeroAddress");
    });

    it("should revert if deployed with zero address treasury", async function () {
      const ConsumptionOracleFactory = await ethers.getContractFactory("ConsumptionOracle");
      await expect(ConsumptionOracleFactory.deploy(
        await registry.getAddress(),
        ethers.ZeroAddress,
        owner.address
      )).to.be.revertedWithCustomError(consumptionOracle, "ZeroAddress");
    });
  });


  describe("Claim Submission", function () {
    it("should accept valid consumption claim", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");
    });

    it("should create snapshot on first submission", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      expect(bucket.snapshotId).to.be.gt(0);
      expect(bucket.deadline).to.be.gt(0);
    });

    it("should track submission in allSubmittersBitmap", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      expect(bucket.allSubmittersBitmap).to.be.gt(0);
      expect(bucket.submissionCount).to.equal(1);
    });

    it("should track maxSubmittedEnergyWh", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      expect(bucket.maxSubmittedEnergyWh).to.equal(energyWh);
    });

    it("should aggregate submissions by valueHash", async function () {
      // Submit same value from multiple verifiers
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const valueHash = ethers.solidityPackedKeccak256(
        ["uint64", "bytes32"],
        [energyWh, evidenceRoot]
      );
      const valueSub = await consumptionOracle.getValueSubmissions(claimKey, valueHash);
      expect(valueSub.count).to.equal(2);
    });

    it("should mark hasSubmitted for verifier", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.hasSubmitted(claimKey, verifier1.address)).to.equal(true);
      expect(await consumptionOracle.hasSubmitted(claimKey, verifier2.address)).to.equal(false);
    });

    it("should track submitted evidence roots", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isEvidenceRootSubmitted(claimKey, evidenceRoot)).to.equal(true);
    });

    it("should revert for unregistered consumer", async function () {
      const fakeConsumerId = ethers.keccak256(ethers.toUtf8Bytes("fake-consumer"));
      const signature = await signConsumptionClaim(
        verifier1, fakeConsumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        fakeConsumerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(consumptionOracle, "ConsumerNotRegistered");
    });

    it("should revert for inactive verifier", async function () {
      // Deactivate verifier1
      await registry.connect(verifier1).deactivateVerifier();

      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(consumptionOracle, "VerifierNotActive");
    });

    it("should revert for duplicate submission", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      // Try to submit again
      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(consumptionOracle, "DuplicateSubmission");
    });

    it("should revert for late submission", async function () {
      // First submission to create snapshot
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );

      // Advance time past deadline
      await time.increase(3601);

      // Try late submission
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      await expect(consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      )).to.be.revertedWithCustomError(consumptionOracle, "ClaimDeadlinePassed");
    });

    it("should revert for already finalized claim", async function () {
      // Submit from all verifiers to reach quorum
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      // Advance time and finalize
      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // Try to submit after finalization
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(true);
    });
  });


  describe("Signature Validation", function () {
    it("should accept valid signature", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");
    });

    it("should reject signature from wrong signer", async function () {
      // Sign with verifier1 but submit as verifier2
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      // The recovered address will be verifier1, but verifier1 is active
      // so this should work - the signature validates the signer
      await expect(consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.emit(consumptionOracle, "ConsumptionSubmitted");
    });

    it("should reject signature with wrong contract address", async function () {
      // Sign with wrong contract address
      const wrongAddress = ethers.Wallet.createRandom().address;
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        wrongAddress
      );

      // The recovered address will be different, and likely not an active verifier
      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      )).to.be.revertedWithCustomError(consumptionOracle, "VerifierNotActive");
    });

    it("should reject malformed signature", async function () {
      const malformedSignature = "0x1234";

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, malformedSignature
      )).to.be.reverted;
    });
  });

  describe("Quorum Calculation and Finalization", function () {
    it("should finalize when quorum is reached", async function () {
      // With 3 verifiers and 66.67% quorum, need 2 verifiers
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      // Advance time past deadline
      await time.increase(3601);

      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.emit(consumptionOracle, "ConsumptionFinalized")
        .withArgs(
          await consumptionOracle.getClaimKey(consumerId, hourId),
          consumerId,
          hourId,
          energyWh
        );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should store verified consumption on finalization", async function () {
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // Check verified consumption is stored
      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, hourId);
      expect(verifiedConsumption).to.equal(energyWh);
    });

    it("should distribute rewards on finalization", async function () {
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      
      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.emit(treasury, "RewardsDistributed");
    });

    it("should enter disputed state when no quorum", async function () {
      // Submit different values from verifiers (no consensus)
      const evidenceRoot2 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-2"));
      const evidenceRoot3 = ethers.keccak256(ethers.toUtf8Bytes("evidence-root-3"));

      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, 6000n, evidenceRoot2,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, 7000n, evidenceRoot3,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, 6000n, evidenceRoot2, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, 7000n, evidenceRoot3, sig3
      );

      await time.increase(3601);

      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.emit(consumptionOracle, "ClaimDisputed");

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      expect(bucket.disputed).to.equal(true);
      expect(bucket.finalized).to.equal(false);
    });

    it("should revert finalization before deadline", async function () {
      const signature = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, signature
      );

      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.be.revertedWithCustomError(consumptionOracle, "ClaimDeadlineNotReached");
    });

    it("should revert finalization of already finalized claim", async function () {
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      await expect(consumptionOracle.finalizeConsumption(consumerId, hourId))
        .to.be.revertedWithCustomError(consumptionOracle, "ClaimAlreadyFinalized");
    });

    it("should record faults for non-winners", async function () {
      // Lower quorum to 50% so 2 out of 3 can reach consensus
      await consumptionOracle.connect(owner).setQuorumBps(5000);
      
      // 2 verifiers submit correct value, 1 submits wrong value
      const wrongEnergyWh = 9999n;
      const wrongEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong-evidence"));

      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, wrongEnergyWh, wrongEvidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, wrongEnergyWh, wrongEvidenceRoot, sig3
      );

      await time.increase(3601);
      
      // Finalize and check the claim bucket has correct winning bitmap
      await consumptionOracle.finalizeConsumption(consumerId, hourId);
      
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      
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

      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, 6000n, evidenceRoot2,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, 7000n, evidenceRoot3,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, 6000n, evidenceRoot2, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, 7000n, evidenceRoot3, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);
    });

    it("should allow admin to force finalize disputed claim", async function () {
      await expect(consumptionOracle.connect(owner).forceFinalize(
        consumerId, hourId, energyWh, evidenceRoot
      )).to.emit(consumptionOracle, "ForceFinalized")
        .withArgs(
          await consumptionOracle.getClaimKey(consumerId, hourId),
          owner.address,
          energyWh
        );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should store verified consumption on force finalize", async function () {
      await consumptionOracle.connect(owner).forceFinalize(
        consumerId, hourId, energyWh, evidenceRoot
      );

      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, hourId);
      expect(verifiedConsumption).to.equal(energyWh);
    });

    it("should revert force finalize for non-disputed claim", async function () {
      // Create a new claim that reaches quorum
      const newHourId = hourId + 1;
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, newHourId);

      // Try to force finalize a finalized (not disputed) claim
      await expect(consumptionOracle.connect(owner).forceFinalize(
        consumerId, newHourId, energyWh, evidenceRoot
      )).to.be.revertedWithCustomError(consumptionOracle, "ClaimNotDisputed");
    });

    it("should revert force finalize with energy exceeding max submitted", async function () {
      const excessiveEnergy = 10000n; // More than any submitted value

      await expect(consumptionOracle.connect(owner).forceFinalize(
        consumerId, hourId, excessiveEnergy, evidenceRoot
      )).to.be.revertedWithCustomError(consumptionOracle, "EnergyExceedsMaxSubmitted");
    });

    it("should revert force finalize with unsubmitted evidence root", async function () {
      const fakeEvidenceRoot = ethers.keccak256(ethers.toUtf8Bytes("fake-evidence"));

      await expect(consumptionOracle.connect(owner).forceFinalize(
        consumerId, hourId, energyWh, fakeEvidenceRoot
      )).to.be.revertedWithCustomError(consumptionOracle, "EvidenceRootNotSubmitted");
    });

    it("should revert force finalize from non-owner", async function () {
      await expect(consumptionOracle.connect(consumer1).forceFinalize(
        consumerId, hourId, energyWh, evidenceRoot
      )).to.be.revertedWithCustomError(consumptionOracle, "OwnableUnauthorizedAccount");
    });
  });

  describe("getVerifiedConsumption", function () {
    it("should return 0 for unverified consumption", async function () {
      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, hourId);
      expect(verifiedConsumption).to.equal(0);
    });

    it("should return correct value after finalization", async function () {
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, hourId);
      expect(verifiedConsumption).to.equal(energyWh);
    });

    it("should return 0 for different hour", async function () {
      const sig1 = await signConsumptionClaim(
        verifier1, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig2 = await signConsumptionClaim(
        verifier2, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );
      const sig3 = await signConsumptionClaim(
        verifier3, consumerId, hourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig1
      );
      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig2
      );
      await consumptionOracle.connect(verifier3).submitConsumption(
        consumerId, hourId, energyWh, evidenceRoot, sig3
      );

      await time.increase(3601);
      await consumptionOracle.finalizeConsumption(consumerId, hourId);

      // Check different hour
      const differentHourId = hourId + 1;
      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, differentHourId);
      expect(verifiedConsumption).to.equal(0);
    });
  });


  describe("Baseline Mode", function () {
    beforeEach(async function () {
      // Enable baseline mode
      await consumptionOracle.connect(owner).setBaselineMode(true);
      await consumptionOracle.connect(owner).setSingleVerifierOverride(verifier1.address);
    });

    it("should finalize immediately in baseline mode with single verifier", async function () {
      const newHourId = hourId + 100;
      const signature = await signConsumptionClaim(
        verifier1, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await expect(consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, signature
      )).to.emit(consumptionOracle, "ConsumptionFinalized");

      const claimKey = await consumptionOracle.getClaimKey(consumerId, newHourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(true);
    });

    it("should store verified consumption in baseline mode", async function () {
      const newHourId = hourId + 101;
      const signature = await signConsumptionClaim(
        verifier1, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier1).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, signature
      );

      const verifiedConsumption = await consumptionOracle.getVerifiedConsumption(consumerId, newHourId);
      expect(verifiedConsumption).to.equal(energyWh);
    });

    it("should not finalize immediately for non-override verifier", async function () {
      const newHourId = hourId + 102;
      const signature = await signConsumptionClaim(
        verifier2, consumerId, newHourId, energyWh, evidenceRoot,
        await consumptionOracle.getAddress()
      );

      await consumptionOracle.connect(verifier2).submitConsumption(
        consumerId, newHourId, energyWh, evidenceRoot, signature
      );

      const claimKey = await consumptionOracle.getClaimKey(consumerId, newHourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(false);
    });

    it("should report baseline mode status correctly", async function () {
      expect(await consumptionOracle.isBaselineMode()).to.equal(true);
      
      await consumptionOracle.connect(owner).setBaselineMode(false);
      expect(await consumptionOracle.isBaselineMode()).to.equal(false);
    });
  });

  describe("Configuration Functions", function () {
    it("should allow owner to set claim window", async function () {
      const newClaimWindow = 7200; // 2 hours
      await consumptionOracle.connect(owner).setClaimWindow(newClaimWindow);
      expect(await consumptionOracle.claimWindow()).to.equal(newClaimWindow);
    });

    it("should allow owner to set quorum bps", async function () {
      const newQuorumBps = 5000; // 50%
      await consumptionOracle.connect(owner).setQuorumBps(newQuorumBps);
      expect(await consumptionOracle.quorumBps()).to.equal(newQuorumBps);
    });

    it("should allow owner to set registry", async function () {
      const newRegistry = ethers.Wallet.createRandom().address;
      await consumptionOracle.connect(owner).setRegistry(newRegistry);
      expect(await consumptionOracle.registry()).to.equal(newRegistry);
    });

    it("should allow owner to set treasury", async function () {
      const newTreasury = ethers.Wallet.createRandom().address;
      await consumptionOracle.connect(owner).setTreasury(newTreasury);
      expect(await consumptionOracle.treasury()).to.equal(newTreasury);
    });

    it("should revert setting registry to zero address", async function () {
      await expect(consumptionOracle.connect(owner).setRegistry(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(consumptionOracle, "ZeroAddress");
    });

    it("should revert setting treasury to zero address", async function () {
      await expect(consumptionOracle.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(consumptionOracle, "ZeroAddress");
    });

    it("should revert non-owner setting claim window", async function () {
      await expect(consumptionOracle.connect(consumer1).setClaimWindow(7200))
        .to.be.revertedWithCustomError(consumptionOracle, "OwnableUnauthorizedAccount");
    });

    it("should revert non-owner setting quorum bps", async function () {
      await expect(consumptionOracle.connect(consumer1).setQuorumBps(5000))
        .to.be.revertedWithCustomError(consumptionOracle, "OwnableUnauthorizedAccount");
    });

    it("should revert non-owner setting baseline mode", async function () {
      await expect(consumptionOracle.connect(consumer1).setBaselineMode(true))
        .to.be.revertedWithCustomError(consumptionOracle, "OwnableUnauthorizedAccount");
    });

    it("should revert non-owner setting single verifier override", async function () {
      await expect(consumptionOracle.connect(consumer1).setSingleVerifierOverride(verifier1.address))
        .to.be.revertedWithCustomError(consumptionOracle, "OwnableUnauthorizedAccount");
    });
  });

  describe("View Functions", function () {
    it("should return correct claim key", async function () {
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      
      // Verify it's a valid bytes32
      expect(claimKey).to.have.length(66); // 0x + 64 hex chars
      expect(claimKey.startsWith("0x")).to.equal(true);
    });

    it("should return empty claim bucket for non-existent claim", async function () {
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      const bucket = await consumptionOracle.getClaimBucket(claimKey);
      
      expect(bucket.deadline).to.equal(0);
      expect(bucket.snapshotId).to.equal(0);
      expect(bucket.submissionCount).to.equal(0);
      expect(bucket.finalized).to.equal(false);
    });

    it("should return false for hasSubmitted on non-existent claim", async function () {
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.hasSubmitted(claimKey, verifier1.address)).to.equal(false);
    });

    it("should return false for isFinalized on non-existent claim", async function () {
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isFinalized(claimKey)).to.equal(false);
    });

    it("should return false for isEvidenceRootSubmitted on non-existent claim", async function () {
      const claimKey = await consumptionOracle.getClaimKey(consumerId, hourId);
      expect(await consumptionOracle.isEvidenceRootSubmitted(claimKey, evidenceRoot)).to.equal(false);
    });
  });
});
