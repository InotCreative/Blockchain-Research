# SEARChain

A blockchain-based clean energy credit distribution system implementing a dual-token model for verifiable 24/7 energy matching.

## Overview

SEARChain is a lab blockchain system for distributing clean energy credits using Proof of Stake verification. The system implements:

- **HCN (Hourly Credit Notes)** - ERC-1155 tokens representing verified energy production. 1 HCN unit = 1 Wh.
- **SEAR** - ERC-20 token used for economic functions: verifier staking, rewards, payments, and governance.

Energy production is verified through the Enphase API by a set of staked verifiers who reach consensus on hourly production values.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        On-Chain (EVM)                           │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│  SEARToken  │HourlyCredits│  Registry   │      Treasury         │
│  (ERC-20)   │ (ERC-1155)  │             │                       │
├─────────────┴─────────────┴─────────────┴───────────────────────┤
│  ProductionOracle  │  ConsumptionOracle  │  Matcher  │Retirement│
└────────────────────┴─────────────────────┴───────────┴──────────┘
                              ▲
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                     Off-Chain Services                          │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ Verifier Oracle │    Finalizer    │    Registry Exporter        │
│   (Python)      │    (Python)     │       (Python)              │
└─────────────────┴─────────────────┴─────────────────────────────┘
```

## Prerequisites

- Node.js >= 18.x
- npm >= 9.x
- Python >= 3.10
- WSL (Windows Subsystem for Linux) - if on Windows

## Project Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone <repository-url>
cd searchain

# Install Node.js dependencies
npm install

# Compile smart contracts
npm run compile
```

### 2. Python Oracle Service Setup

```bash
# Navigate to oracle directory
cd oracle

# Create virtual environment
python -m venv .venv

# Activate virtual environment
# On Linux/macOS:
source .venv/bin/activate
# On Windows (WSL):
source .venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt
```

## Smart Contracts

### Contract Overview

| Contract            | Description                                                    |
|---------------------|----------------------------------------------------------------|
| `SEARToken`         | ERC-20 token for staking, rewards, and payments                |
| `HourlyCredits`     | ERC-1155 tokens representing verified hourly energy production |
| `Registry`          | Manages producers, consumers, and verifier membership          |
| `Treasury`          | Handles reward distribution and slashing                       |
| `ProductionOracle`  | Verifier consensus for production claims                       |
| `ConsumptionOracle` | Verifier consensus for consumption claims                      |
| `Matcher`           | 24/7 hourly matching between production and consumption        |
| `Retirement`        | Credit retirement and SREC certificate issuance                |

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
# Run all tests
npm test

# Run specific test file
npx hardhat test test/SEARToken.test.ts

# Run with gas reporting
REPORT_GAS=true npm test
```

## Contract Deployment

### Local Development (Hardhat Network)

```bash
# Start local Hardhat node (in a separate terminal)
npm run node

# Deploy contracts
npx hardhat run scripts/deploy.ts --network localhost

# Seed with sample data
npx hardhat run scripts/seed.ts --network localhost
```

### Deployment Output

Deployed addresses are saved to `deployments/addresses-<chainId>.json`:

```json
{
  "deployer": "0x...",
  "searToken": "0x...",
  "hourlyCredits": "0x...",
  "registry": "0x...",
  "treasury": "0x...",
  "productionOracle": "0x...",
  "consumptionOracle": "0x...",
  "matcher": "0x...",
  "retirement": "0x...",
  "chainId": 31337
}
```

### Default Configuration

| Parameter        | Value    | Description             |
|------------------|----------|-------------------------|
| `quorumBps`      | 6667     | 66.67% quorum threshold |
| `claimWindow`    | 3600     | 1 hour claim window     |
| `rewardPerWhWei` | 1e12     | Reward per Wh in wei    |
| `slashBps`       | 1000     | 10% slash percentage    |
| `faultThreshold` | 3        | Faults before slashing  |
| `minStake`       | 100 SEAR | Minimum verifier stake  |

## Oracle Service Configuration

### Environment Variables

Create a `.env` file in the `oracle/` directory:

```env
# Ethereum RPC
ETH_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337

# Verifier private key (for signing claims)
VERIFIER_PRIVATE_KEY=0x...

# Contract addresses (from deployment)
PRODUCTION_ORACLE_ADDRESS=0x...
CONSUMPTION_ORACLE_ADDRESS=0x...
REGISTRY_ADDRESS=0x...

# Enphase API (for production data)
ENPHASE_API_KEY=your_api_key
ENPHASE_ACCESS_TOKEN=your_access_token

# PostgreSQL (for evidence storage)
DATABASE_URL=postgresql://user:password@localhost:5432/searchain
```

### Running the Oracle Service

```bash
cd oracle

# Activate virtual environment
source .venv/bin/activate

# Run the submitter (polls Enphase and submits claims)
python -m oracle.submitter

# Run the finalizer (finalizes expired claims)
python -m oracle.finalizer
```

### Sample Data

Sample data files are provided for testing:

- `oracle/sample_enphase_responses.json` - Sample Enphase API responses for 3 systems over 3 hours
- `oracle/sample_consumption.csv` - Sample consumption data for 4 consumers over 4 hours

## Running Tests

### Smart Contract Tests

```bash
# All tests
npm test

# Specific test suites
npx hardhat test test/SEARToken.test.ts
npx hardhat test test/HourlyCredits.test.ts
npx hardhat test test/Registry.test.ts
npx hardhat test test/ProductionOracle.test.ts
npx hardhat test test/ConsumptionOracle.test.ts
npx hardhat test test/Matcher.test.ts
npx hardhat test test/Retirement.test.ts
npx hardhat test test/Treasury.test.ts

# Integration tests
npx hardhat test test/full-cycle.test.ts
npx hardhat test test/adversarial.test.ts
npx hardhat test test/baseline.test.ts
```

### Python Oracle Tests

```bash
cd oracle
source .venv/bin/activate

# Run all tests
pytest

# Run specific test file
pytest tests/test_enphase_client.py
pytest tests/test_evidence_store.py
pytest tests/test_submitter.py
```

## Project Structure

```
searchain/
├── contracts/              # Solidity smart contracts
│   ├── SEARToken.sol
│   ├── HourlyCredits.sol
│   ├── Registry.sol
│   ├── Treasury.sol
│   ├── ProductionOracle.sol
│   ├── ConsumptionOracle.sol
│   ├── Matcher.sol
│   └── Retirement.sol
├── scripts/                # Deployment scripts
│   ├── deploy.ts
│   └── seed.ts
├── test/                   # Smart contract tests
│   ├── SEARToken.test.ts
│   ├── HourlyCredits.test.ts
│   └── ...
├── oracle/                 # Python oracle service
│   ├── enphase_client.py   # Enphase API client
│   ├── consumption_client.py
│   ├── evidence_store.py   # PostgreSQL evidence storage
│   ├── submitter.py        # Claim submission
│   ├── finalizer.py        # Claim finalization
│   ├── registry_exporter.py
│   ├── requirements.txt
│   ├── sample_enphase_responses.json
│   ├── sample_consumption.csv
│   └── tests/
├── deployments/            # Deployed contract addresses
├── typechain-types/        # Generated TypeScript types
├── hardhat.config.ts
├── package.json
└── README.md
```

## Key Flows

### Production Verification Flow

1. Producer registers system via `Registry.registerProducer()`
2. Verifiers poll Enphase API for hourly production data
3. Verifiers submit signed claims via `ProductionOracle.submitProduction()`
4. After claim window, anyone calls `ProductionOracle.finalizeProduction()`
5. If quorum reached, HCN tokens are minted to producer
6. Winning verifiers receive SEAR rewards, losers get faults

### Matching Flow

1. Consumer registers via `Registry.registerConsumer()`
2. Consumption is verified via `ConsumptionOracle`
3. Producer lists credits via `Matcher.listCredits()`
4. Consumer buys credits via `Matcher.buyCredits()`
5. HCN transfers from seller to buyer, SEAR payment to seller

### Retirement Flow

1. Credit holder calls `Retirement.retireHourly()` or `Retirement.retireSREC()`
2. HCN tokens are burned
3. Certificate is issued with full provenance chain
4. Registry exporter generates JSON/CSV for external registries

## Research Metrics

The system supports measurement of:

- Gas per claim submission
- Gas per finalization
- Total gas per verified kWh
- Latency from hour end to finalized mint
- Scaling with 10-500 producers and 5-15 verifiers

### Benchmark Results

Run the baseline comparison tests to get research metrics:

```bash
npx hardhat test test/baseline.test.ts
```

#### Sample Results (5 kWh verification, 3 verifiers, 66.67% quorum)

| Metric | Baseline Mode | Decentralized Mode |
|--------|--------------|-------------------|
| Total Gas | ~548,000 | ~927,000 |
| Gas per kWh | ~110,000 | ~185,000 |
| Overhead | - | +69% |
| Finalization Latency | Immediate | ~1 hour (claim window) |

#### Research Questions Addressed

1. **RQ1**: Protocol-layer PoS verification works without L1 consensus changes ✅
2. **RQ2**: 66.67% quorum provides good balance of security vs. gas cost
3. **RQ3**: Hourly granularity adds ~24x overhead vs daily (24 claims vs 1)
4. **RQ4**: Gas scales linearly with verifier count (~110k per verifier submission)
5. **RQ5**: Decentralized mode adds 54-69% gas overhead vs baseline
6. **RQ6**: Full provenance reconstruction via claimKeys + evidenceRoots ✅

### Baseline Comparison Mode

Enable baseline mode for research comparison:

```solidity
// Single verifier mode (no consensus)
productionOracle.setBaselineMode(true);
productionOracle.setSingleVerifierOverride(verifierAddress);

// No slashing mode
treasury.setDisableSlashing(true);
```

### Adversarial Testing

Run adversarial tests to verify security under attack:

```bash
npx hardhat test test/adversarial.test.ts
```

Tests include:
- 20% malicious verifiers (quorum still works)
- 40% malicious verifiers (disputed state)
- Replay attacks (rejected)
- Double-match attacks (rejected)
- Signature forgery (rejected)

## License

ISC
