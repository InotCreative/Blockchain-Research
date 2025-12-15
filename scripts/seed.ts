import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * SEARChain Seed Script
 * 
 * Seeds the deployed contracts with sample data:
 * - Register sample producers and consumers
 * - Stake and activate sample verifiers
 * - Fund Treasury with initial SEAR
 */

interface DeployedAddresses {
  deployer: string;
  searToken: string;
  hourlyCredits: string;
  registry: string;
  treasury: string;
  productionOracle: string;
  consumptionOracle: string;
  matcher: string;
  retirement: string;
}

// Seed configuration
const SEED_CONFIG = {
  // Initial SEAR supply to mint (for testing)
  initialSearSupply: ethers.parseEther("1000000"), // 1M SEAR
  
  // Treasury funding
  treasuryFunding: ethers.parseEther("100000"), // 100K SEAR for rewards
  
  // Verifier stake amount
  verifierStake: ethers.parseEther("100"), // 100 SEAR per verifier
  
  // Number of sample verifiers to create
  numVerifiers: 3,
  
  // Sample producers
  producers: [
    {
      systemSerial: "ENPHASE-SYS-001",
      metadata: "Solar Array A - 10kW residential",
    },
    {
      systemSerial: "ENPHASE-SYS-002", 
      metadata: "Solar Array B - 25kW commercial",
    },
    {
      systemSerial: "ENPHASE-SYS-003",
      metadata: "Solar Array C - 5kW residential",
    },
  ],
  
  // Sample consumers
  consumers: [
    {
      meterId: "METER-001",
      metadata: "Office Building A",
    },
    {
      meterId: "METER-002",
      metadata: "Residential Complex B",
    },
  ],
};

async function loadAddresses(chainId: number): Promise<DeployedAddresses> {
  const addressFile = path.join(__dirname, "..", "deployments", `addresses-${chainId}.json`);
  
  if (!fs.existsSync(addressFile)) {
    throw new Error(`Deployment addresses not found at ${addressFile}. Run deploy.ts first.`);
  }
  
  return JSON.parse(fs.readFileSync(addressFile, "utf-8"));
}

async function main() {
  console.log("=".repeat(60));
  console.log("SEARChain Seed Script");
  console.log("=".repeat(60));

  // Get signers
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  
  console.log(`\nDeployer: ${deployer.address}`);
  
  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);

  // Load deployed addresses
  const addresses = await loadAddresses(Number(network.chainId));
  console.log("\nLoaded deployment addresses");

  // Get contract instances
  const searToken = await ethers.getContractAt("SEARToken", addresses.searToken);
  const registry = await ethers.getContractAt("Registry", addresses.registry);
  const treasury = await ethers.getContractAt("Treasury", addresses.treasury);


  // ============ Mint Initial SEAR Supply ============
  console.log("\n" + "=".repeat(60));
  console.log("Minting Initial SEAR Supply");
  console.log("=".repeat(60));

  // First, we need to mint SEAR through Treasury (since only Treasury can mint)
  // For seeding, we'll deposit ETH equivalent or use a special setup
  // Since Treasury is the only minter, we need to fund it first
  
  // For testing purposes, let's check if Treasury has a deposit function
  // and fund it with SEAR that we can then distribute
  
  // Actually, looking at the contracts, Treasury.deposit() requires SEAR tokens
  // but SEARToken.mint() requires Treasury to call it
  // This is a chicken-and-egg problem for initial seeding
  
  // Solution: We'll need to temporarily set deployer as treasury, mint, then reset
  // Or we can add an initial mint in the token contract
  
  // For now, let's check the current setup and work with what we have
  const currentTreasury = await searToken.treasury();
  console.log(`\nCurrent Treasury: ${currentTreasury}`);
  
  // We need to mint initial supply - let's do it through Treasury
  // The Treasury needs SEAR to distribute rewards, so we need to bootstrap
  
  // Check if deployer has any SEAR
  let deployerBalance = await searToken.balanceOf(deployer.address);
  console.log(`Deployer SEAR balance: ${ethers.formatEther(deployerBalance)} SEAR`);

  // For initial seeding, we'll need to mint through a workaround
  // Let's temporarily set deployer as treasury, mint, then restore
  if (deployerBalance === 0n) {
    console.log("\nBootstrapping initial SEAR supply...");
    
    // Temporarily set deployer as treasury
    await searToken.setTreasury(deployer.address);
    console.log("  Temporarily set deployer as treasury");
    
    // Mint initial supply to deployer
    await searToken.mint(deployer.address, SEED_CONFIG.initialSearSupply);
    console.log(`  Minted ${ethers.formatEther(SEED_CONFIG.initialSearSupply)} SEAR to deployer`);
    
    // Restore treasury
    await searToken.setTreasury(addresses.treasury);
    console.log("  Restored Treasury as minter");
    
    deployerBalance = await searToken.balanceOf(deployer.address);
    console.log(`  Deployer SEAR balance: ${ethers.formatEther(deployerBalance)} SEAR`);
  }

  // ============ Fund Treasury ============
  console.log("\n" + "=".repeat(60));
  console.log("Funding Treasury");
  console.log("=".repeat(60));

  // Approve Treasury to spend deployer's SEAR
  await searToken.approve(addresses.treasury, SEED_CONFIG.treasuryFunding);
  console.log(`\nApproved Treasury to spend ${ethers.formatEther(SEED_CONFIG.treasuryFunding)} SEAR`);

  // Deposit to Treasury reward pool
  await treasury.deposit(SEED_CONFIG.treasuryFunding);
  console.log(`Deposited ${ethers.formatEther(SEED_CONFIG.treasuryFunding)} SEAR to Treasury`);

  const rewardPool = await treasury.getRewardPool();
  console.log(`Treasury reward pool: ${ethers.formatEther(rewardPool)} SEAR`);

  // ============ Register Sample Producers ============
  console.log("\n" + "=".repeat(60));
  console.log("Registering Sample Producers");
  console.log("=".repeat(60));

  const producerIds: string[] = [];
  
  for (let i = 0; i < SEED_CONFIG.producers.length; i++) {
    const producer = SEED_CONFIG.producers[i];
    const systemIdHash = ethers.keccak256(ethers.toUtf8Bytes(producer.systemSerial));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes(producer.metadata));
    
    console.log(`\n[${i + 1}/${SEED_CONFIG.producers.length}] Registering producer: ${producer.systemSerial}`);
    
    const tx = await registry.registerProducer(systemIdHash, metaHash, deployer.address);
    const receipt = await tx.wait();
    
    // Get producerId from event
    const event = receipt?.logs.find((log: any) => {
      try {
        const parsed = registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === "ProducerRegistered";
      } catch {
        return false;
      }
    });
    
    if (event) {
      const parsed = registry.interface.parseLog({ topics: event.topics as string[], data: event.data });
      const producerId = parsed?.args[0];
      producerIds.push(producerId);
      console.log(`  ProducerId: ${producerId}`);
    }
  }


  // ============ Register Sample Consumers ============
  console.log("\n" + "=".repeat(60));
  console.log("Registering Sample Consumers");
  console.log("=".repeat(60));

  const consumerIds: string[] = [];
  
  for (let i = 0; i < SEED_CONFIG.consumers.length; i++) {
    const consumer = SEED_CONFIG.consumers[i];
    const meterIdHash = ethers.keccak256(ethers.toUtf8Bytes(consumer.meterId));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes(consumer.metadata));
    
    console.log(`\n[${i + 1}/${SEED_CONFIG.consumers.length}] Registering consumer: ${consumer.meterId}`);
    
    const tx = await registry.registerConsumer(meterIdHash, metaHash, deployer.address);
    const receipt = await tx.wait();
    
    // Get consumerId from event
    const event = receipt?.logs.find((log: any) => {
      try {
        const parsed = registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === "ConsumerRegistered";
      } catch {
        return false;
      }
    });
    
    if (event) {
      const parsed = registry.interface.parseLog({ topics: event.topics as string[], data: event.data });
      const consumerId = parsed?.args[0];
      consumerIds.push(consumerId);
      console.log(`  ConsumerId: ${consumerId}`);
    }
  }

  // ============ Stake and Activate Verifiers ============
  console.log("\n" + "=".repeat(60));
  console.log("Staking and Activating Verifiers");
  console.log("=".repeat(60));

  const verifierAddresses: string[] = [];
  
  // Use available signers as verifiers (or create deterministic addresses)
  const numVerifiers = Math.min(SEED_CONFIG.numVerifiers, signers.length);
  
  for (let i = 0; i < numVerifiers; i++) {
    const verifier = signers[i];
    verifierAddresses.push(verifier.address);
    
    console.log(`\n[${i + 1}/${numVerifiers}] Setting up verifier: ${verifier.address}`);
    
    // Transfer SEAR to verifier if not deployer
    if (i > 0) {
      await searToken.transfer(verifier.address, SEED_CONFIG.verifierStake);
      console.log(`  Transferred ${ethers.formatEther(SEED_CONFIG.verifierStake)} SEAR`);
    }
    
    // Add to allowlist (permissioned mode)
    await registry.addToAllowlist(verifier.address);
    console.log(`  Added to allowlist`);
    
    // Approve Registry to spend SEAR for staking
    await searToken.connect(verifier).approve(addresses.registry, SEED_CONFIG.verifierStake);
    console.log(`  Approved Registry for staking`);
    
    // Stake as verifier
    await registry.connect(verifier).stakeAsVerifier(SEED_CONFIG.verifierStake);
    console.log(`  Staked ${ethers.formatEther(SEED_CONFIG.verifierStake)} SEAR`);
    
    // Activate verifier
    await registry.connect(verifier).activateVerifier();
    console.log(`  Activated as verifier`);
  }

  // ============ Verify Setup ============
  console.log("\n" + "=".repeat(60));
  console.log("Verifying Setup");
  console.log("=".repeat(60));

  const activeVerifiers = await registry.getActiveVerifiers();
  console.log(`\nActive verifiers: ${activeVerifiers.length}`);
  for (const v of activeVerifiers) {
    const verifierData = await registry.getVerifier(v);
    console.log(`  ${v}: stake=${ethers.formatEther(verifierData.stake)} SEAR, active=${verifierData.active}`);
  }

  // ============ Save Seed Data ============
  console.log("\n" + "=".repeat(60));
  console.log("Saving Seed Data");
  console.log("=".repeat(60));

  const seedData = {
    timestamp: new Date().toISOString(),
    chainId: Number(network.chainId),
    deployer: deployer.address,
    producers: SEED_CONFIG.producers.map((p, i) => ({
      ...p,
      producerId: producerIds[i] || "unknown",
      systemIdHash: ethers.keccak256(ethers.toUtf8Bytes(p.systemSerial)),
    })),
    consumers: SEED_CONFIG.consumers.map((c, i) => ({
      ...c,
      consumerId: consumerIds[i] || "unknown",
      meterIdHash: ethers.keccak256(ethers.toUtf8Bytes(c.meterId)),
    })),
    verifiers: verifierAddresses.map((addr, i) => ({
      address: addr,
      stake: ethers.formatEther(SEED_CONFIG.verifierStake),
    })),
    treasuryFunding: ethers.formatEther(SEED_CONFIG.treasuryFunding),
  };

  const outputDir = path.join(__dirname, "..", "deployments");
  const outputFile = path.join(outputDir, `seed-data-${network.chainId}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(seedData, null, 2));
  console.log(`\nSeed data saved to: ${outputFile}`);

  // ============ Summary ============
  console.log("\n" + "=".repeat(60));
  console.log("Seed Summary");
  console.log("=".repeat(60));
  console.log(`
  Producers registered: ${producerIds.length}
  Consumers registered: ${consumerIds.length}
  Verifiers activated:  ${activeVerifiers.length}
  Treasury funded:      ${ethers.formatEther(SEED_CONFIG.treasuryFunding)} SEAR
  `);

  console.log("=".repeat(60));
  console.log("Seeding Complete!");
  console.log("=".repeat(60));

  return seedData;
}

// Export for use in tests
export { main as seed, SEED_CONFIG };

// Run if executed directly
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
