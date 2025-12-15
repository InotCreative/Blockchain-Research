import { expect } from "chai";
import { ethers } from "hardhat";
import { Retirement, HourlyCredits } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Retirement", function () {
  let retirement: Retirement;
  let hourlyCredits: HourlyCredits;
  let owner: HardhatEthersSigner;
  let productionOracle: HardhatEthersSigner;
  let registry: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Sample test data
  const hourId = 500000;
  const amountWh = 5000n; // 5 kWh
  const claimKey = ethers.keccak256(ethers.toUtf8Bytes("test-claim-key"));
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("carbon-offset"));

  // SREC constant: 1 MWh = 1,000,000 Wh
  const SREC_WH = 1_000_000n;

  beforeEach(async function () {
    [owner, productionOracle, registry, user1, user2] = await ethers.getSigners();

    // Deploy HourlyCredits
    const HourlyCreditsFactory = await ethers.getContractFactory("HourlyCredits");
    hourlyCredits = await HourlyCreditsFactory.deploy(owner.address);
    await hourlyCredits.waitForDeployment();

    // Deploy Retirement
    const RetirementFactory = await ethers.getContractFactory("Retirement");
    retirement = await RetirementFactory.deploy(
      await hourlyCredits.getAddress(),
      productionOracle.address,
      registry.address,
      owner.address
    );
    await retirement.waitForDeployment();

    // Set up HourlyCredits permissions
    await hourlyCredits.connect(owner).setProductionOracle(productionOracle.address);
    await hourlyCredits.connect(owner).setRetirement(await retirement.getAddress());
  });

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await retirement.owner()).to.equal(owner.address);
    });

    it("should set the correct HourlyCredits address", async function () {
      expect(await retirement.hourlyCredits()).to.equal(await hourlyCredits.getAddress());
    });

    it("should set the correct ProductionOracle address", async function () {
      expect(await retirement.productionOracle()).to.equal(productionOracle.address);
    });

    it("should set the correct Registry address", async function () {
      expect(await retirement.registry()).to.equal(registry.address);
    });


    it("should initialize nextRetireId to 1", async function () {
      expect(await retirement.getNextRetireId()).to.equal(1);
    });

    it("should initialize nextCertId to 1", async function () {
      expect(await retirement.getNextCertId()).to.equal(1);
    });

    it("should revert if HourlyCredits is zero address", async function () {
      const RetirementFactory = await ethers.getContractFactory("Retirement");
      await expect(
        RetirementFactory.deploy(
          ethers.ZeroAddress,
          productionOracle.address,
          registry.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });

    it("should revert if ProductionOracle is zero address", async function () {
      const RetirementFactory = await ethers.getContractFactory("Retirement");
      await expect(
        RetirementFactory.deploy(
          await hourlyCredits.getAddress(),
          ethers.ZeroAddress,
          registry.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });

    it("should revert if Registry is zero address", async function () {
      const RetirementFactory = await ethers.getContractFactory("Retirement");
      await expect(
        RetirementFactory.deploy(
          await hourlyCredits.getAddress(),
          productionOracle.address,
          ethers.ZeroAddress,
          owner.address
        )
      ).to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });
  });

  describe("retireHourly", function () {
    beforeEach(async function () {
      // Mint some HCN tokens to user1
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
    });

    it("should retire hourly credits and burn HCN", async function () {
      const retireAmount = 2000n;
      const balanceBefore = await hourlyCredits.balanceOf(user1.address, hourId);

      await retirement.connect(user1).retireHourly(hourId, retireAmount, reasonHash);

      const balanceAfter = await hourlyCredits.balanceOf(user1.address, hourId);
      expect(balanceAfter).to.equal(balanceBefore - retireAmount);
    });

    it("should emit Retired event", async function () {
      const retireAmount = 2000n;
      const tx = await retirement.connect(user1).retireHourly(hourId, retireAmount, reasonHash);
      
      await expect(tx)
        .to.emit(retirement, "Retired")
        .withArgs(1, user1.address, hourId, retireAmount);
    });

    it("should return correct retireId", async function () {
      const retireAmount = 2000n;
      const retireId = await retirement.connect(user1).retireHourly.staticCall(hourId, retireAmount, reasonHash);
      expect(retireId).to.equal(1);
    });

    it("should increment retireId for each retirement", async function () {
      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);
      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);
      
      expect(await retirement.getNextRetireId()).to.equal(3);
    });

    it("should store correct retirement record", async function () {
      const retireAmount = 2000n;
      await retirement.connect(user1).retireHourly(hourId, retireAmount, reasonHash);

      const record = await retirement.getRetirementRecord(1);
      expect(record.owner).to.equal(user1.address);
      expect(record.hourId).to.equal(hourId);
      expect(record.amountWh).to.equal(retireAmount);
      expect(record.reasonHash).to.equal(reasonHash);
      expect(record.timestamp).to.be.gt(0);
    });

    it("should store claimKey in retirement record", async function () {
      await retirement.connect(user1).retireHourly(hourId, 2000n, reasonHash);
      const record = await retirement.getRetirementRecord(1);
      expect(record.claimKey).to.not.equal(ethers.ZeroHash);
    });

    it("should revert if amount is zero", async function () {
      await expect(retirement.connect(user1).retireHourly(hourId, 0, reasonHash))
        .to.be.revertedWithCustomError(retirement, "ZeroAmount");
    });

    it("should revert if insufficient balance", async function () {
      const excessAmount = amountWh + 1n;
      await expect(retirement.connect(user1).retireHourly(hourId, excessAmount, reasonHash))
        .to.be.revertedWithCustomError(retirement, "InsufficientBalance")
        .withArgs(hourId, excessAmount, amountWh);
    });

    it("should allow retiring all credits", async function () {
      await retirement.connect(user1).retireHourly(hourId, amountWh, reasonHash);
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(0);
    });

    it("should allow multiple retirements from same hourId", async function () {
      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);
      await retirement.connect(user1).retireHourly(hourId, 2000n, reasonHash);
      
      expect(await hourlyCredits.balanceOf(user1.address, hourId)).to.equal(amountWh - 3000n);
    });
  });


  describe("retireSREC", function () {
    const hourId1 = 500000;
    const hourId2 = 500001;
    const hourId3 = 500002;

    beforeEach(async function () {
      // Mint enough HCN for SREC testing (need at least 1 MWh)
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 400_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 400_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId3, 400_000n, claimKey);
    });

    it("should retire SREC batch when total is exactly 1 MWh", async function () {
      const hourIds = [hourId1, hourId2, hourId3];
      const amounts = [400_000n, 400_000n, 200_000n]; // Total = 1,000,000 Wh

      await retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash);

      expect(await hourlyCredits.balanceOf(user1.address, hourId1)).to.equal(0);
      expect(await hourlyCredits.balanceOf(user1.address, hourId2)).to.equal(0);
      expect(await hourlyCredits.balanceOf(user1.address, hourId3)).to.equal(200_000n);
    });

    it("should emit CertificateIssued event", async function () {
      // Mint additional tokens to have enough for 500k each
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 100_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 100_000n, claimKey);
      
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n, 500_000n]; // Total = 1,000,000 Wh

      const tx = await retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash);
      
      await expect(tx)
        .to.emit(retirement, "CertificateIssued");
    });

    it("should return correct certId", async function () {
      // Mint additional tokens to have enough for 500k each
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 100_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 100_000n, claimKey);
      
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n, 500_000n];

      const certId = await retirement.connect(user1).retireSREC.staticCall(hourIds, amounts, reasonHash);
      expect(certId).to.equal(1);
    });

    it("should increment certId for each certificate", async function () {
      // First SREC
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 1_000_000n, claimKey);
      await retirement.connect(user1).retireSREC([hourId1], [1_000_000n], reasonHash);

      // Second SREC
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 1_000_000n, claimKey);
      await retirement.connect(user1).retireSREC([hourId2], [1_000_000n], reasonHash);

      expect(await retirement.getNextCertId()).to.equal(3);
    });

    it("should store correct certificate data", async function () {
      // Mint additional tokens to have enough for 500k each
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 100_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 100_000n, claimKey);
      
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n, 500_000n];

      await retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash);

      const cert = await retirement.getCertificate(1);
      expect(cert.owner).to.equal(user1.address);
      expect(cert.totalWh).to.equal(1_000_000n);
      expect(cert.metadataHash).to.equal(reasonHash);
      expect(cert.hourIds.length).to.equal(2);
      expect(cert.amounts.length).to.equal(2);
      expect(cert.claimKeys.length).to.equal(2);
      expect(cert.timestamp).to.be.gt(0);
    });

    it("should allow 2 MWh SREC batch", async function () {
      // Mint more tokens
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 1_000_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 1_000_000n, claimKey);

      const hourIds = [hourId1, hourId2];
      const amounts = [1_000_000n, 1_000_000n]; // Total = 2,000,000 Wh = 2 MWh

      await retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash);

      const cert = await retirement.getCertificate(1);
      expect(cert.totalWh).to.equal(2_000_000n);
    });

    it("should revert if total is not multiple of 1 MWh", async function () {
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n, 499_999n]; // Total = 999,999 Wh (not 1 MWh)

      await expect(retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash))
        .to.be.revertedWithCustomError(retirement, "InvalidSRECAmount")
        .withArgs(999_999n);
    });

    it("should revert if arrays are empty", async function () {
      await expect(retirement.connect(user1).retireSREC([], [], reasonHash))
        .to.be.revertedWithCustomError(retirement, "EmptyArrays");
    });

    it("should revert if array lengths mismatch", async function () {
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n]; // Only 1 amount

      await expect(retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash))
        .to.be.revertedWithCustomError(retirement, "ArrayLengthMismatch");
    });

    it("should revert if any amount is zero", async function () {
      const hourIds = [hourId1, hourId2];
      const amounts = [1_000_000n, 0n];

      await expect(retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash))
        .to.be.revertedWithCustomError(retirement, "ZeroAmount");
    });

    it("should revert if insufficient balance for any hour", async function () {
      // Mint additional to hourId1 to make total valid (1 MWh) but hourId2 insufficient
      // hourId1 has 400,000, hourId2 has 400,000
      // We want total = 1,000,000 but hourId2 to be insufficient
      // So: hourId1 = 500,000 (need 100k more), hourId2 = 500,000 (only have 400k)
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 100_000n, claimKey);
      
      const hourIds = [hourId1, hourId2];
      const amounts = [500_000n, 500_000n]; // hourId2 only has 400,000, needs 500,000

      await expect(retirement.connect(user1).retireSREC(hourIds, amounts, reasonHash))
        .to.be.revertedWithCustomError(retirement, "InsufficientBalance");
    });
  });


  describe("getRetirementRecord", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
    });

    it("should return correct retirement record", async function () {
      await retirement.connect(user1).retireHourly(hourId, 2000n, reasonHash);

      const record = await retirement.getRetirementRecord(1);
      expect(record.owner).to.equal(user1.address);
      expect(record.hourId).to.equal(hourId);
      expect(record.amountWh).to.equal(2000n);
      expect(record.reasonHash).to.equal(reasonHash);
    });

    it("should revert for non-existent retireId", async function () {
      await expect(retirement.getRetirementRecord(999))
        .to.be.revertedWithCustomError(retirement, "RetirementNotFound")
        .withArgs(999);
    });

    it("should revert for retireId 0", async function () {
      await expect(retirement.getRetirementRecord(0))
        .to.be.revertedWithCustomError(retirement, "RetirementNotFound")
        .withArgs(0);
    });
  });

  describe("getCertificate", function () {
    const hourId1 = 500000;
    const hourId2 = 500001;

    beforeEach(async function () {
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId1, 500_000n, claimKey);
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, 500_000n, claimKey);
    });

    it("should return correct certificate data", async function () {
      await retirement.connect(user1).retireSREC([hourId1, hourId2], [500_000n, 500_000n], reasonHash);

      const cert = await retirement.getCertificate(1);
      expect(cert.owner).to.equal(user1.address);
      expect(cert.totalWh).to.equal(1_000_000n);
      expect(cert.hourIds[0]).to.equal(hourId1);
      expect(cert.hourIds[1]).to.equal(hourId2);
      expect(cert.amounts[0]).to.equal(500_000n);
      expect(cert.amounts[1]).to.equal(500_000n);
    });

    it("should return claimKeys array", async function () {
      await retirement.connect(user1).retireSREC([hourId1, hourId2], [500_000n, 500_000n], reasonHash);

      const cert = await retirement.getCertificate(1);
      expect(cert.claimKeys.length).to.equal(2);
      expect(cert.claimKeys[0]).to.not.equal(ethers.ZeroHash);
      expect(cert.claimKeys[1]).to.not.equal(ethers.ZeroHash);
    });

    it("should revert for non-existent certId", async function () {
      await expect(retirement.getCertificate(999))
        .to.be.revertedWithCustomError(retirement, "CertificateNotFound")
        .withArgs(999);
    });

    it("should revert for certId 0", async function () {
      await expect(retirement.getCertificate(0))
        .to.be.revertedWithCustomError(retirement, "CertificateNotFound")
        .withArgs(0);
    });
  });

  describe("Configuration Functions", function () {
    it("should allow owner to set HourlyCredits", async function () {
      const newAddress = user2.address;
      await retirement.connect(owner).setHourlyCredits(newAddress);
      expect(await retirement.hourlyCredits()).to.equal(newAddress);
    });

    it("should revert if non-owner sets HourlyCredits", async function () {
      await expect(retirement.connect(user1).setHourlyCredits(user2.address))
        .to.be.revertedWithCustomError(retirement, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting HourlyCredits to zero address", async function () {
      await expect(retirement.connect(owner).setHourlyCredits(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });

    it("should allow owner to set ProductionOracle", async function () {
      const newAddress = user2.address;
      await retirement.connect(owner).setProductionOracle(newAddress);
      expect(await retirement.productionOracle()).to.equal(newAddress);
    });

    it("should revert if non-owner sets ProductionOracle", async function () {
      await expect(retirement.connect(user1).setProductionOracle(user2.address))
        .to.be.revertedWithCustomError(retirement, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting ProductionOracle to zero address", async function () {
      await expect(retirement.connect(owner).setProductionOracle(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });

    it("should allow owner to set Registry", async function () {
      const newAddress = user2.address;
      await retirement.connect(owner).setRegistry(newAddress);
      expect(await retirement.registry()).to.equal(newAddress);
    });

    it("should revert if non-owner sets Registry", async function () {
      await expect(retirement.connect(user1).setRegistry(user2.address))
        .to.be.revertedWithCustomError(retirement, "OwnableUnauthorizedAccount");
    });

    it("should revert if setting Registry to zero address", async function () {
      await expect(retirement.connect(owner).setRegistry(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(retirement, "ZeroAddress");
    });
  });

  describe("ClaimKey Tracking", function () {
    beforeEach(async function () {
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId, amountWh, claimKey);
    });

    it("should generate unique claimKeys for different hourIds", async function () {
      const hourId2 = hourId + 1;
      await hourlyCredits.connect(productionOracle).mint(user1.address, hourId2, amountWh, claimKey);

      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);
      await retirement.connect(user1).retireHourly(hourId2, 1000n, reasonHash);

      const record1 = await retirement.getRetirementRecord(1);
      const record2 = await retirement.getRetirementRecord(2);

      expect(record1.claimKey).to.not.equal(record2.claimKey);
    });

    it("should use same claimKey for same hourId retirements", async function () {
      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);
      await retirement.connect(user1).retireHourly(hourId, 1000n, reasonHash);

      const record1 = await retirement.getRetirementRecord(1);
      const record2 = await retirement.getRetirementRecord(2);

      expect(record1.claimKey).to.equal(record2.claimKey);
    });
  });

  describe("SREC Constant", function () {
    it("should have SREC_WH constant equal to 1,000,000", async function () {
      expect(await retirement.SREC_WH()).to.equal(1_000_000n);
    });
  });
});
