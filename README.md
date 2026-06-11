# ⚡ Base Flash Loan Multi-Strategy Engine

Multi-strategy flash loan system for **Base chain** (Coinbase L2). Leverage farming, cross-DEX arbitrage, triangle arb, and memecoin hunting — all powered by Aave V3 flash loans.

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI Dashboard                         │
│              (dashboard.ts — unified UI)                 │
├──────────────┬──────────────┬───────────────┬───────────┤
│  Opportunity │  Arbitrage   │  Memecoin     │  Alchemy  │
│  Scanner     │  Engine      │  Hunter       │  Provider │
│  (Aave rates,│  (Multi-DEX  │  (New token   │  (WS subs,│
│   leverage)  │   price arb) │   detection)  │   sim)    │
├──────────────┴──────────────┴───────────────┴───────────┤
│                    Shared Constants                      │
│           (tokens, DEXs, ABIs, addresses)                │
├─────────────────────────────────────────────────────────┤
│                  PositionV2.sol                          │
│          (5 strategies, 3 DEXs, Aave V3)                 │
├─────────────────────────────────────────────────────────┤
│                   Base Chain                             │
│    Aave V3 │ Aerodrome │ Uniswap V3 │ BaseSwap           │
└─────────────────────────────────────────────────────────┘
```

## 📂 Project Structure

```
flashloan-base/
├── contracts/
│   ├── Position.sol          # V1 — Simple leverage farming
│   ├── PositionV2.sol        # V2 — Multi-strategy (arb + leverage + triangle)
│   └── addresses.sol         # Base protocol address registry
├── scripts/
│   ├── deploy.ts             # Deploy Position V1
│   └── deploy-v2.ts          # Deploy PositionV2
├── src/scanner/
│   ├── constants.ts          # Shared tokens, ABIs, DEX addresses
│   ├── alchemy-provider.ts   # Alchemy WebSocket + simulation integration
│   ├── opportunity-scanner.ts # Aave rate spreads + leverage finder
│   ├── arb-engine.ts         # Multi-DEX arbitrage scanner
│   ├── memecoin-hunter.ts    # New memecoin detection + safety scoring
│   └── dashboard.ts          # Unified CLI dashboard
├── hardhat.config.ts
├── package.json
└── .env.example
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Requires Node.js 22+
nvm use 22
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Alchemy API key and wallet private key
```

### 3. Compile Contracts

```bash
npx hardhat compile
```

### 4. Deploy (Base Sepolia first for testing)

```bash
npx hardhat run scripts/deploy-v2.ts --network baseSepolia
# Then mainnet:
npx hardhat run scripts/deploy-v2.ts --network base
```

### 5. Run Scanners

```bash
# Full opportunity scan
npm run scan

# Continuous monitoring (15s interval)
npm run scan:watch

# Arbitrage opportunities
npm run arb

# Memecoin hunter
npm run memecoins

# Unified dashboard
npm run dashboard

# Continuous dashboard
npm run dashboard:monitor
```

## ⚡ Strategies

### Strategy 0: Leverage Farming
Flash loan → Swap on Aerodrome → Supply to Aave → Borrow → Repay flash loan.
Profitable when: **supply APY > borrow APY + 0.05% flash fee + gas**

### Strategy 1: Cross-DEX Arbitrage
Flash loan → Buy on cheaper DEX → Sell on expensive DEX → Repay flash loan.
Profitable when: **price spread > 0.05% flash fee + gas (~$0.01 on Base)**

### Strategy 2: Triangle Arbitrage
Flash loan → WETH→USDC (Aerodrome) → DAI (Uniswap) → WETH (Aerodrome) → Repay.
Profitable when: **cumulative rate product > 1 + fees**

### Strategy 3: Liquidation (planned)
Flash loan → Repay underwater Aave position → Seize collateral at discount.

### Strategy 4: Memecoin Sniper (planned)
Flash loan → Buy new token on Aerodrome → Sell on momentum.

## 🔗 Connected Protocols (Base)

| Protocol | Purpose | Address |
|----------|---------|---------|
| Aave V3 Pool | Flash loans + lending | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Aerodrome CL | Concentrated liquidity swaps | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Aerodrome AMM | Stable/volatile pool swaps | `0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925` |
| Uniswap V3 | Secondary DEX for arb | `0x2626664c2603336E57B271c5C0b26F421741e481` |

## 🔒 Security Features

- **ReentrancyGuard** on all external entry points AND the flash loan callback
- **Approved router whitelist** — only known DEX routers can be used
- **Health factor enforcement** — withdrawals blocked if position becomes unsafe
- **Emergency withdraw** — restricted to owner only, cannot rug via guardian
- **MEV protection** — route through Flashbots Protect RPC
- **Minimum profit check** — arbitrage reverts if below `minProfit` threshold
- **Safe transfer** — handles non-standard ERC20 return values

## 📊 Profitability Model

```
Base gas cost: ~$0.01-0.10 per tx (cheapest L2)
Aave flash fee: 0.05% (5 bps)
Break-even spread: ~6 bps (flash fee + gas)

Example arbitrage:
  Flash loan: 10 WETH ($25,000)
  Spread: 15 bps ($37.50 gross)
  Flash fee: 5 bps ($12.50)
  Gas: ~$0.05
  Net profit: $24.95
```

## 🛠 Development

### Run Tests

```bash
npx hardhat test --network hardhatBase
```

### Verify Contract

```bash
npx hardhat verify --network base <CONTRACT_ADDRESS>
```

### Clean Build

```bash
npx hardhat clean && npx hardhat compile
```

## ⚠️ Risks

- **Smart contract risk** — Aave V3 and Aerodrome are audited but not risk-free
- **MEV exposure** — public mempool transactions can be front-run (use Flashbots RPC)
- **Liquidation risk** — leverage positions can be liquidated if health factor drops below 1.0
- **Impermanent loss** — not applicable to lending but relevant if extending to LP positions
- **Oracle risk** — Aave relies on Chainlink price feeds on Base
- **Gas spikes** — Base gas can spike during L1 congestion periods

## 📝 License

UNLICENSED — For educational and research purposes only. Use at your own risk.
