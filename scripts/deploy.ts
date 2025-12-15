import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * SEARChain Deployment Script
 * 
 * Deploys all contracts in the correct order and wires dependencies:
 * 1. SEARToken (ERC-20)
 * 2. HourlyCredits (ERC-1155)
 * 3. Registry
 * 4. Treasury
 * 5. ProductionOracle
 * 6. ConsumptionOracle
 * 7. Matcher
 * 8. Retirement
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
  network: string;
  chainId: number;
  timestamp: string;
}

// Default configuration parameters
const DEFAULT_CONFIG = {
  quorumBps: 6667,           // 66.67% quorum
  claimWindow: 3600,         // 1 hour in seconds
  rewardPerWhWei: 1e12,      // Reward per Wh
  slashBps: 1000,            // 10% slash
  faultThreshold: 3,         // 3 faults before slash
  minStake: ethers.parseEther("100"), // 100 SEAR minimum stake
  protocolFeeBps: 0,         // 0% protocol fee (lab mode)
};

async function main() {
  console.log("=".repeat(60));
  console.log("SEARChain Deployment Script");
  console.log("=".repeat(60));

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);

  const addresses: Partial<DeployedAddresses> = {
    deployer: deployer.address,
    network: network.name,
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
  };

  // ============ Deploy SEARToken ============
  console.log("\n[1/8] Deploying SEARToken...");
  const SEARToken = await ethers.getContractFactory("SEARToken");
  const searToken = await SEARToken.deploy(deployer.address);
  await searToken.waitForDeployment();
  addresses.searToken = await searToken.getAddress();
  console.log(`  SEARToken deployed at: ${addresses.searToken}`);

  // ============ Deploy HourlyCredits ============
  console.log("\n[2/8] Deploying HourlyCredits...");
  const HourlyCredits = await ethers.getContractFactory("HourlyCredits");
  const hourlyCredits = await HourlyCredits.deploy(deployer.address);
  await hourlyCredits.waitForDeployment();
  addresses.hourlyCredits = await hourlyCredits.getAddress();
  console.log(`  HourlyCredits deployed at: ${addresses.hourlyCredits}`);


  // ============ Deploy Registry ============
  console.log("\n[3/8] Deploying Registry...");
  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(addresses.searToken, deployer.address);
  await registry.waitForDeployment();
  addresses.registry = await registry.getAddress();
  console.log(`  Registry deployed at: ${addresses.registry}`);

  // ============ Deploy Treasury ============
  console.log("\n[4/8] Deploying Treasury...");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    addresses.searToken,
    addresses.registry,
    deployer.address
  );
  await treasury.waitForDeployment();
  addresses.treasury = await treasury.getAddress();
  console.log(`  Treasury deployed at: ${addresses.treasury}`);

  // ============ Deploy ProductionOracle ============
  console.log("\n[5/8] Deploying ProductionOracle...");
  const ProductionOracle = await ethers.getContractFactory("ProductionOracle");
  const productionOracle = await ProductionOracle.deploy(
    addresses.registry,
    addresses.hourlyCredits,
    addresses.treasury,
    deployer.address
  );
  await productionOracle.waitForDeployment();
  addresses.productionOracle = await productionOracle.getAddress();
  console.log(`  ProductionOracle deployed at: ${addresses.productionOracle}`);

  // ============ Deploy ConsumptionOracle ============
  console.log("\n[6/8] Deploying ConsumptionOracle...");
  const ConsumptionOracle = await ethers.getContractFactory("ConsumptionOracle");
  const consumptionOracle = await ConsumptionOracle.deploy(
    addresses.registry,
    addresses.treasury,
    deployer.address
  );
  await consumptionOracle.waitForDeployment();
  addresses.consumptionOracle = await consumptionOracle.getAddress();
  console.log(`  ConsumptionOracle deployed at: ${addresses.consumptionOracle}`);

  // ============ Deploy Matcher ============
  console.log("\n[7/8] Deploying Matcher...");
  const Matcher = await ethers.getContractFactory("Matcher");
  const matcher = await Matcher.deploy(
    addresses.consumptionOracle,
    addresses.hourlyCredits,
    addresses.searToken,
    addresses.treasury,
    deployer.address
  );
  await matcher.waitForDeployment();
  addresses.matcher = await matcher.getAddress();
  console.log(`  Matcher deployed at: ${addresses.matcher}`);

  // ============ Deploy Retirement ============
  console.log("\n[8/8] Deploying Retirement...");
  const Retirement = await ethers.getContractFactory("Retirement");
  const retirement = await Retirement.deploy(
    addresses.hourlyCredits,
    addresses.productionOracle,
    addresses.registry,
    deployer.address
  );
  await retirement.waitForDeployment();
  addresses.retirement = await retirement.getAddress();
  console.log(`  Retirement deployed at: ${addresses.retirement}`);

  // ============ Wire Contract Dependencies ============
  console.log("\n" + "=".repeat(60));
  console.log("Wiring Contract Dependencies");
  console.log("=".repeat(60));

  // SEARToken: Set Treasury as minter
  console.log("\n[1/9] SEARToken.setTreasury...");
  await searToken.setTreasury(addresses.treasury);
  console.log(`  Treasury set as minter: ${addresses.treasury}`);

  // HourlyCredits: Set ProductionOracle as minter, Retirement as burner
  console.log("\n[2/9] HourlyCredits.setProductionOracle...");
  await hourlyCredits.setProductionOracle(addresses.productionOracle);
  console.log(`  ProductionOracle set as minter: ${addresses.productionOracle}`);

  console.log("\n[3/9] HourlyCredits.setRetirement...");
  await hourlyCredits.setRetirement(addresses.retirement);
  console.log(`  Retirement set as burner: ${addresses.retirement}`);

  // Registry: Set oracles for snapshot authorization
  console.log("\n[4/9] Registry.setProductionOracle...");
  await registry.setProductionOracle(addresses.productionOracle);
  console.log(`  ProductionOracle authorized: ${addresses.productionOracle}`);

  console.log("\n[5/9] Registry.setConsumptionOracle...");
  await registry.setConsumptionOracle(addresses.consumptionOracle);
  console.log(`  ConsumptionOracle authorized: ${addresses.consumptionOracle}`);

  // Treasury: Set oracles for reward/fault functions
  console.log("\n[6/9] Treasury.setProductionOracle...");
  await treasury.setProductionOracle(addresses.productionOracle);
  console.log(`  ProductionOracle authorized: ${addresses.productionOracle}`);

  console.log("\n[7/9] Treasury.setConsumptionOracle...");
  await treasury.setConsumptionOracle(addresses.consumptionOracle);
  console.log(`  ConsumptionOracle authorized: ${addresses.consumptionOracle}`);


  // ============ Set Initial Parameters ============
  console.log("\n" + "=".repeat(60));
  console.log("Setting Initial Parameters");
  console.log("=".repeat(60));

  // Registry parameters
  console.log("\n[8/9] Setting Registry parameters...");
  await registry.setQuorumBps(DEFAULT_CONFIG.quorumBps);
  console.log(`  quorumBps: ${DEFAULT_CONFIG.quorumBps}`);
  
  await registry.setClaimWindow(DEFAULT_CONFIG.claimWindow);
  console.log(`  claimWindow: ${DEFAULT_CONFIG.claimWindow}s`);
  
  await registry.setRewardPerWhWei(DEFAULT_CONFIG.rewardPerWhWei);
  console.log(`  rewardPerWhWei: ${DEFAULT_CONFIG.rewardPerWhWei}`);
  
  await registry.setSlashBps(DEFAULT_CONFIG.slashBps);
  console.log(`  slashBps: ${DEFAULT_CONFIG.slashBps}`);
  
  await registry.setFaultThreshold(DEFAULT_CONFIG.faultThreshold);
  console.log(`  faultThreshold: ${DEFAULT_CONFIG.faultThreshold}`);
  
  await registry.setMinStake(DEFAULT_CONFIG.minStake);
  console.log(`  minStake: ${ethers.formatEther(DEFAULT_CONFIG.minStake)} SEAR`);

  // Matcher protocol fee
  console.log("\n[9/9] Setting Matcher protocol fee...");
  await matcher.setProtocolFeeBps(DEFAULT_CONFIG.protocolFeeBps);
  console.log(`  protocolFeeBps: ${DEFAULT_CONFIG.protocolFeeBps}`);

  // ============ Save Deployed Addresses ============
  console.log("\n" + "=".repeat(60));
  console.log("Saving Deployment Addresses");
  console.log("=".repeat(60));

  const outputDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, `addresses-${network.chainId}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(addresses, null, 2));
  console.log(`\nAddresses saved to: ${outputFile}`);

  // ============ Deployment Summary ============
  console.log("\n" + "=".repeat(60));
  console.log("Deployment Summary");
  console.log("=".repeat(60));
  console.log(`
  SEARToken:         ${addresses.searToken}
  HourlyCredits:     ${addresses.hourlyCredits}
  Registry:          ${addresses.registry}
  Treasury:          ${addresses.treasury}
  ProductionOracle:  ${addresses.productionOracle}
  ConsumptionOracle: ${addresses.consumptionOracle}
  Matcher:           ${addresses.matcher}
  Retirement:        ${addresses.retirement}
  `);

  console.log("=".repeat(60));
  console.log("Deployment Complete!");
  console.log("=".repeat(60));

  return addresses as DeployedAddresses;
}

// Export for use in tests
export { main as deploy, DEFAULT_CONFIG };

// Run if executed directly
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
