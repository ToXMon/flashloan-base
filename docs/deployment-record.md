# Deployment Record — PositionV2 on Base Mainnet

## Contract Information

| Field | Value |
|-------|-------|
| **Contract** | PositionV2 — Multi-Strategy Flash Loan |
| **Address** | `0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A` |
| **Network** | Base Mainnet (Chain ID: 8453) |
| **Deployer** | `0x06C74ebba31010f72673189a36D9Ca46083A053A` |
| **Compiler** | Solidity 0.8.28 (evm target: cancun) |
| **Optimizer** | Enabled, 200 runs |

## Deployment Details

| Field | Value |
|-------|-------|
| **Transaction Hash** | `0xd8aa467ce9cc8188bc481f1588a8a7d925d390161be58bb909aa1c2f338f5acf` |
| **Block Number** | 47,129,453 |
| **Gas Used** | 3,934,810 |
| **Timestamp** | 2026-06-10 ~00:40 UTC |
| **Max Fee Per Gas** | 0.15 gwei |
| **Priority Fee** | 0.001 gwei |

## Verification Status

| Explorer | Status | URL |
|----------|--------|-----|
| **Blockscout** | ✅ Verified | https://base.blockscout.com/address/0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A#code |
| **Sourcify** | ✅ Verified | https://sourcify.dev/server/repo-ui/8453/0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A |
| **BaseScan (Etherscan)** | ⚠️ Not verified | V1 API deprecated, V2 doesn't support chainid 8453 yet. Manual verification possible via https://basescan.org/verifyContract |

## Contract Architecture

### Strategies Enabled

| ID | Strategy | Description |
|----|----------|-------------|
| 0 | LEVERAGE_FARM | Aave V3 supply/borrow loop |
| 1 | FLASH_ARB | Cross-DEX flash loan arbitrage |
| 2 | TRIANGLE_ARB | 3-pool triangular arbitrage |
| 3 | LIQUIDATION | Aave liquidation hunting |
| 4 | MEMECOIN_SNIPER | Buy new tokens on Aerodrome |

### Connected DEXs (Base)

| DEX | Address | Type |
|-----|---------|------|
| Aerodrome CL | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | Concentrated Liquidity |
| Aerodrome AMM | `0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925` | Velodrome-style AMM |
| Uniswap V3 | `0x2626664c2603336E57B271c5C0b26F421741e481` | Concentrated Liquidity |

### Key Protocol Addresses

| Protocol | Address |
|----------|--------|
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Aave Addresses Provider | `0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870` |
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### Access Control

- **Owner** (immutable): `0x06C74ebba31010f72673189a36D9Ca46083A053A`
- **Guardian** (settable): Same as owner initially
- **Pause**: Emergency pause functionality available

## Configuration Changes Made

### hardhat.config.ts
- Added `@nomicfoundation/hardhat-verify` plugin import
- Added `dotenv/config` import for env loading
- Added `etherscan` config with Base custom chain
- Constructor is parameterless — no constructor args for verification

### .env
- `POSITION_V2_ADDRESS=0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A`
- `POSITION_CONTRACT=0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A`
- `BASESCAN_API_KEY=QY24EDJ7ZSS3J7PRRREXUE33MMZSJJ69AG`

## Post-Deployment Checklist

- [x] Contract compiled successfully
- [x] Deployed to Base mainnet
- [x] Address recorded in .env
- [x] Verified on Blockscout
- [x] Verified on Sourcify
- [ ] Verify on BaseScan (manual: https://basescan.org/verifyContract)
- [ ] Fund contract with initial capital (WETH/USDC)
- [ ] Test flash loan execution with small amount
- [ ] Start monitoring dashboard

## Gas Cost Analysis

| Metric | Value |
|--------|-------|
| Gas Used | 3,934,810 |
| Estimated Cost (ETH) | ~0.0000059 ETH (~$0.02 at ~$3,400/ETH) |
| Contract Size | 3 Solidity files, ~2,585 lines flattened |
