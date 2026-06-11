# Ethereum Mainnet Flash Loan Arbitrage Feasibility Report

**Date**: 2026-06-06
**Researcher**: Agent Zero Deep Research
**Status**: Live web data verified

---

## 1. Chain Specifications

| Parameter | Value |
|-----------|-------|
| Chain Name | Ethereum Mainnet |
| Chain ID | 1 |
| Native Token | ETH |
| Block Time | ~12 seconds (post-Merge, PoS) |
| Consensus | Proof of Stake (Beacon Chain) |
| Total DeFi TVL | $36.2 billion (DeFiLlama, June 2026) |
| ETH Price | $1,554.52 (CoinGecko, June 6 2026) |

---

## 2. Flash Loan Providers

### 2.1 Aave V3 (Primary)

| Parameter | Value |
|-----------|-------|
| Protocol | Aave V3 |
| Fee | 0.05% (5 basis points) |
| Pool Address | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| Pool Addresses Provider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` |
| Pool Configurator | `0x64b761D848206f447Fe2dd461b0c635Ec39EbB27` |
| Flashloan Logic | `0x6D414cd0d5eAf8C43200ac0c325A7E2Ad83B8be6` |
| AAVE Token | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` |
| 24h Protocol Fees | $2,877,664 (DeFiLlama) |
| Max Flash Loan | Limited by pool liquidity (billions available) |

**Notes**: Aave V3 is the largest lending protocol on Ethereum. Flash loans are called via `Pool.flashLoan()` or `Pool.flashLoanSimple()`. The 0.05% fee is the standard rate; premium-tier flash loans may have different fees.

### 2.2 Balancer V2/V3

| Parameter | Value |
|-----------|-------|
| Protocol | Balancer V2 / V3 |
| Fee | 0% (zero fee flash loans) |
| Vault V2 Address | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |
| Token (BAL) | `0xba100000625a3754423978a60c9317c58a424e3D` |
| V2 ETH TVL | $18.0M (DeFiLlama) |
| V3 ETH TVL | $57.0M (DeFiLlama) |
| Combined TVL | ~$75M on Ethereum |

**Notes**: Balancer offers zero-fee flash loans, making them the cheapest source. However, lower TVL means maximum loan sizes are more limited. Balancer V3 vault address should be verified from their docs. Flash loans via `Vault.flashLoan()`.

### 2.3 dYdX

| Parameter | Value |
|-----------|-------|
| Protocol | dYdX V4 (now independent appchain) |
| Status | **No longer available on Ethereum** |

**Notes**: dYdX migrated to its own Cosmos-based appchain (dYdX Chain). The old V2/V3 flash loan functionality on Ethereum is deprecated and no longer functional. Do NOT use old dYdX flash loan addresses. dYdX Chain TVL is ~$98.1M (DeFiLlama) but operates on its own chain.

### 2.4 MakerDAO / Sky Flash Mint (DSS Flash)

| Parameter | Value |
|-----------|-------|
| Protocol | MakerDAO / Sky Lending |
| Fee | ~0.09% (stability fee annualized, charged proportionally) |
| Flash Mint Module | DSS Flash (simplified flash minting of DAI) |
| DAI Address | `0x6B175474E89094C44Da98b954EedeAC495271d0F` |
| 24h Protocol Fees | $1,033,866 (DeFiLlama, Sky Lending) |

**Notes**: MakerDAO's flash mint allows minting unlimited DAI for one transaction as long as it's returned with a fee. The fee was historically 0.09% but varies based on governance. Very high liquidity (backed by MakerDAO's massive collateral). The DSS Flash module address should be verified from current MakerDAO/Sky docs.

### 2.5 Uniswap V3 Flash

| Parameter | Value |
|-----------|-------|
| Protocol | Uniswap V3 / V4 |
| Fee | 0% (only pay gas) |
| Mechanism | `callback` pattern in swaps
| Uniswap V3 ETH TVL | $784.5M |
| Uniswap V4 ETH TVL | $470.9M |

**Notes**: Uniswap pools allow flash loans via the callback mechanism - borrow from pool liquidity within a swap. No protocol fee, but you must return the borrowed amount. Available on V2, V3, and V4.

### Flash Loan Provider Comparison

| Provider | Fee | Max Size | Pros | Cons |
|----------|-----|----------|------|------|
| Aave V3 | 0.05% | Very large ($B+) | Most liquid, reliable | Fee adds cost |
| Balancer | 0% | Medium ($75M TVL) | Free, no fee | Limited by pool sizes |
| MakerDAO Flash Mint | ~0.09% | Very large | Unlimited DAI | Higher fee, governance risk |
| Uniswap Flash | 0% | Large | Free, high liquidity | Callback complexity |
| dYdX | N/A | N/A | - | **Deprecated on Ethereum** |

---

## 3. Top DEXes by TVL and Volume on Ethereum

*Data sourced from DeFiLlama API, June 6 2026*

### 3.1 TVL Rankings (Ethereum only)

| Rank | DEX | ETH TVL | Total TVL | Category |
|------|-----|---------|-----------|----------|
| 1 | Curve DEX | $1,339,879,225 | $1,419,511,602 | DEX |
| 2 | Uniswap V3 | $784,526,309 | $1,371,396,731 | DEX |
| 3 | Uniswap V4 | $470,939,404 | $627,269,642 | DEX |
| 4 | Balancer V3 | $57,049,695 | $81,849,546 | DEX |
| 5 | 1inch | $2,073,152 | $2,302,812 | DEX Aggregator |

Note: Balancer V2 adds $18.0M on Ethereum. 1inch is an aggregator, not a DEX itself.

### 3.2 24h Volume Rankings (Ethereum)

| Rank | DEX | 24h Volume |
|------|-----|------------|
| 1 | Uniswap V4 | $704,873,646 |
| 2 | Uniswap V3 | $697,417,283 |
| 3 | Curve DEX | $242,088,963 |
| 4 | Fluid DEX | $153,540,623 |
| 5 | Native Swap | $117,147,575 |
| 6 | Ekubo | $45,819,702 |
| 7 | Uniswap V2 | $36,208,852 |
| 8 | Metric | $31,270,901 |

### 3.3 24h Fees

| Protocol | 24h Fees |
|----------|----------|
| Aave V3 | $2,877,664 |
| Flashbots | $1,749,535 |
| Lido | $1,221,088 |
| Sky Lending | $1,033,866 |
| Uniswap V3 | $956,405 |
| Titan Builder | $689,025 |
| Uniswap V4 | $603,331 |

---

## 4. Gas Cost Analysis

*Data from Etherscan V2 API, Block 25,261,368, June 6 2026*

### Current Gas Prices

| Metric | Value |
|--------|-------|
| Base Fee | 0.066 gwei |
| Safe Gas | 0.066 gwei |
| Proposed Gas | 0.066 gwei |
| Fast Gas | 0.067 gwei |
| Gas Used Ratio | 42.4% (current block) |

### Flash Loan Arbitrage Gas Estimate (~500k gas units)

| Scenario | Gas Price | Gas Cost (ETH) | Gas Cost (USD) |
|----------|-----------|----------------|----------------|
| Current (low activity) | 0.066 gwei | 0.000033 ETH | $0.05 |
| With priority tip | 0.566 gwei | 0.000283 ETH | $0.44 |
| Moderate activity | 5 gwei | 0.0025 ETH | $3.89 |
| Busy network | 20 gwei | 0.01 ETH | $15.55 |
| High congestion | 50 gwei | 0.025 ETH | $38.86 |
| Extreme congestion | 100 gwei | 0.05 ETH | $77.73 |

### Break-Even Analysis ($100k Flash Loan)

| Component | Cost |
|-----------|------|
| Aave V3 fee (0.05%) | $50.00 |
| Gas (current low) | $0.05 |
| Gas (with tip) | $0.44 |
| Gas (moderate) | $3.89 |
| Gas (busy) | $15.55 |
| **Total cost (low)** | **$50.05** |
| **Total cost (moderate)** | **$53.89** |
| **Total cost (busy)** | **$65.55** |
| **Min price gap needed** | **~5.1 bps (low) to 6.6 bps (busy)** |

### Key Insight

Ethereum L1 gas is currently extremely cheap (sub-1 gwei), making flash loan arbitrage much more viable than during high-activity periods. However, when DeFi activity picks up, gas can spike to 20-100+ gwei, significantly eroding profits. The $0.05 gas cost at current rates is negligible compared to the 0.05% Aave fee ($50 per $100k).

---

## 5. MEV Protection

### 5.1 Flashbots

| Parameter | Value |
|-----------|-------|
| Category | MEV Infrastructure |
| 24h Revenue | $1,749,535 (DeFiLlama) |
| Website | https://flashbots.net |
| Key Product | Flashbots Protect RPC |

**Flashbots Protect RPC**: Submit transactions privately to avoid frontrunning. Transactions are only visible to Flashbots builders, not the public mempool.

**How to use**:
- Set RPC to `https://rpc.flashbots.net`
- Transactions are submitted to Flashbots builders
- No cost for submission (only pay gas if included)
- Fast mode: targets next 3 blocks
- MEV-Share: can receive MEV kickbacks

### 5.2 MEV-Share

Flashbots MEV-Share allows users to receive a portion of MEV extracted from their transactions. When an arbitrage is found by a searcher, a portion of profits is returned to the original user.

### 5.3 Private Mempool Options

| Provider | Type | Notes |
|----------|------|-------|
| Flashbots Protect | Free RPC | Primary MEV protection |
| MEV Blocker (CoW Protocol) | Free RPC | Returns MEV to users |
| BloxRoute | Paid | BDR (block builder) access |
| Titan Builder | Builder | 24h fees $689K, top Ethereum builder |
| Rsync Builder | Builder | Another major builder |

### 5.4 Flashbots Integration for Arbitrage

For arbitrageurs, MEV protection cuts both ways:
- **As protection**: Use Flashbots Protect to hide your arb transactions from frontrunners
- **As competition**: Other searchers using Flashbots can frontrun you if your transaction hits the public mempool
- **Best practice**: Always submit arb transactions through private channels (Flashbots, MEV Blocker)

---

## 6. Key Risks for Ethereum Flash Loan Arbitrage

### 6.1 MEV / Frontrunning Risk

**Severity: CRITICAL**

Ethereum has the most sophisticated MEV ecosystem of any chain. Top builders (Titan, Rsync) process $689K+ in daily fees. Any profitable arbitrage visible in the public mempool WILL be frontrun.

- Use Flashbots Protect or private RPC exclusively
- Assume your transaction is being watched at all times
- Competing searchers have sub-millisecond infrastructure

### 6.2 Gas Price Volatility

**Severity: HIGH**

Gas prices can spike 100x between submission and inclusion:
- Current: 0.066 gwei
- Busy: 20+ gwei
- Extreme: 100+ gwei

Your arbitrage must remain profitable across the full gas price range.

### 6.3 Slippage Risk

**Severity: HIGH**

Ethereum's 12-second block time means:
- Price can change between submission and inclusion
- Multiple blocks of latency possible
- Other searchers can change the state in between

Set strict slippage limits and deadline parameters.

### 6.4 Liquidity Depth

**Severity: MEDIUM**

While Ethereum has the deepest liquidity, large flash loans ($1M+) can move prices:
- Curve pools: deep for stablecoins, thinner for volatile pairs
- Uniswap V3: concentrated liquidity means depth varies by range
- Always check pool reserves before execution

### 6.5 Smart Contract Risk

**Severity: MEDIUM**

- Flash loan contracts are battle-tested (Aave V3 since 2022)
- Your own contract is the weakest link
- Reentrancy guard is mandatory
- Always audit your own arbitrage contract

### 6.6 Competition Intensity

**Severity: HIGH**

Ethereum is the most competitive chain for MEV:
- Professional MEV firms with custom infrastructure
- Latency-optimized infrastructure (collocated nodes)
- Backrun and sandwich attacks common
- Profit margins are thin and competition is fierce

### 6.7 Regulatory Risk

**Severity: LOW-MEDIUM**

- Ethereum is under increasing regulatory scrutiny
- MEV extraction sits in a legal gray area
- Flash loans themselves are not regulated
- Tax implications of each trade must be considered

---

## 7. Feasibility Assessment

### 7.1 Advantages over L2s

| Factor | Ethereum | L2s (Base, Arbitrum) |
|--------|----------|----------------------|
| Liquidity | Deepest ($36B TVL) | Growing but smaller |
| Number of DEXes | 15+ active | 5-10 active |
| Flash loan providers | 4+ active | 1-3 active |
| Gas cost (current) | $0.05-$15 | $0.001-$0.10 |
| Block time | 12 seconds | 1-2 seconds |
| MEV competition | Extreme | Moderate |
| Price discovery | Primary | Derivative |

### 7.2 Profitability Thresholds

| Flash Loan Size | Aave Fee | Gas (current) | Min Revenue to Profit |
|-----------------|----------|---------------|----------------------|
| $10,000 | $5.00 | $0.44 | $5.44 |
| $50,000 | $25.00 | $0.44 | $25.44 |
| $100,000 | $50.00 | $0.44 | $50.44 |
| $500,000 | $250.00 | $0.44 | $250.44 |
| $1,000,000 | $500.00 | $0.44 | $500.44 |

### 7.3 Recommended Strategy

1. **Use Balancer or Uniswap flash loans** when possible (0% fee vs Aave's 0.05%)
2. **Always submit through Flashbots Protect** to avoid frontrunning
3. **Target cross-DEX price gaps > 7 basis points** to ensure profitability
4. **Monitor gas prices** and only execute when gas is under 5 gwei
5. **Focus on stablecoin pairs** (USDC/USDT/DAI) for lower slippage
6. **Consider triangle arb routes** across 3+ pools for harder-to-detect opportunities

### 7.4 Comparison with Base Chain

| Metric | Ethereum | Base |
|--------|----------|------|
| Block Time | 12 seconds | ~2 seconds |
| Gas Cost | $0.05-$15 | $0.001-$0.10 |
| Flash Loan Fee | 0.05% | 0.05% |
| DeFi TVL | $36.2B | $3.8B |
| Top DEX Volume | $700M/day | Varies |
| MEV Competition | Extreme | Moderate |
| Recommended For | Large ($100k+) arb | Small-medium arb |

---

## 8. Contract Address Reference

### Aave V3 Ethereum

```
Pool:                    0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
PoolAddressesProvider:   0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
PoolConfigurator:        0x64b761D848206f447Fe2dd461b0c635Ec39EbB27
FlashloanLogic:          0x6D414cd0d5eAf8C43200ac0c325A7E2Ad83B8be6
AAVE Token:              0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9
```

### Balancer

```
Vault V2:                0xBA12222222228d8Ba445958a75a0704d566BF2C8
BAL Token:               0xba100000625a3754423978a60c9317c58a424e3D
```

### MakerDAO / Sky

```
DAI:                     0x6B175474E89094C44Da98b954EedeAC495271d0F
```

### Key Tokens

```
WETH:                    0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
USDC:                    0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDT:                    0xdAC17F958D2ee523a2206206994597C13D831ec7
```

---

## 9. Data Sources

| Data Point | Source | URL |
|------------|--------|-----|
| Chain TVL | DeFiLlama API | `api.llama.fi/v2/chains` |
| DEX TVL | DeFiLlama API | `api.llama.fi/protocols` |
| DEX Volume | DeFiLlama API | `api.llama.fi/overview/dexs/Ethereum` |
| Protocol Fees | DeFiLlama API | `api.llama.fi/overview/fees/ethereum` |
| Gas Prices | Etherscan V2 API | `api.etherscan.io/v2/api` |
| ETH Price | CoinGecko API | `api.coingecko.com/api/v3/simple/price` |
| Aave Addresses | bgd-labs/aave-address-book | GitHub raw |
| Block Number | 25,261,368 | Etherscan |

---

## 10. Conclusion

Ethereum mainnet flash loan arbitrage is **feasible but extremely competitive**. The key advantages are deep liquidity ($36.2B TVL), multiple flash loan providers, and currently low gas costs. The main challenges are MEV competition from professional searchers and the 12-second block time creating execution latency.

**For Tolu's flash loan system**: Ethereum is best suited for large-value arbitrages ($100K+) where the absolute dollar profit justifies the complexity. For smaller trades, Base chain remains more practical due to faster blocks, lower gas, and less MEV competition.

**Recommended approach**: Start with Base (already operational), then expand to Ethereum for large cross-chain opportunities. Use Balancer/Uniswap flash loans (0% fee) on Ethereum when possible, always submit through Flashbots Protect, and target stablecoin pairs where slippage is more predictable.
