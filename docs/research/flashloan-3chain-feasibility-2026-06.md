# Flash Loan Arbitrage Feasibility: 3-Chain Research Report

**Date:** 2026-06-07
**Researcher:** Agent Zero Deep Research (Swarm)
**Data Sources:** DeFiLlama API (live), CoinGecko, protocol docs, web search

---

## Executive Summary

| Chain | Chain ID | Block Time | DeFi TVL | 24h DEX Vol | Gas/FL Tx | MEV Protection | Viability |
|-------|----------|------------|----------|-------------|-----------|----------------|-----------|
| **Ethereum** | 1 | ~12s | $36.2B | $1.6B+ | $0.05-$15.55 | Flashbots/MEV Blocker | **MEDIUM** |
| **Avalanche C-Chain** | 43114 | ~2s | $472.4M | $135M | $0.06-$0.12 | NONE | **LOW-MEDIUM** |
| **Optimism** | 10 | ~2s | $285.7M | $44.7M | $0.50-$3.00 | Partial (sequencer risk) | **MEDIUM** |

**Bottom Line:** Ethereum has deepest liquidity but extreme MEV competition. Avalanche has fast finality but no MEV protection. Optimism is viable but lower TVL than Base. For Tolu's current system on Base, expansion priority: Ethereum (large trades only) > Optimism (secondary) > Avalanche (tertiary).

---

## 1. Ethereum Mainnet

### Chain Fundamentals

| Parameter | Value |
|-----------|-------|
| Chain ID | 1 |
| Block Time | ~12 seconds (PoS) |
| Total DeFi TVL | **$36.2 billion** |
| ETH Price | **$1,554.52** |

### Flash Loan Providers

| Provider | Fee | Contract Address | Notes |
|----------|-----|------------------|-------|
| **Aave V3** | 0.05% (5 bps) | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | Primary provider; 24h fees: $2.88M |
| **Balancer V2/V3** | **0%** | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` (V2 Vault) | Free flash loans; ~$75M ETH TVL |
| **MakerDAO/Sky Flash Mint** | ~0.09% | DAI: `0x6B175474E89094C44Da98b954EedeAC495271d0F` | Unlimited DAI minting |
| **Uniswap V3/V4 Flash** | 0% (callback) | Pool-dependent | V3: $784.5M + V4: $470.9M ETH TVL |
| **dYdX** | DEPRECATED | — | Migrated to Cosmos appchain |

### Top DEXes by TVL on Ethereum

| DEX | ETH TVL | 24h Volume |
|-----|---------|------------|
| Curve DEX | $1.34B | $242.1M |
| Uniswap V3 | $784.5M | $697.4M |
| Uniswap V4 | $470.9M | $704.9M |
| Balancer V3 | $57.0M | — |
| 1inch (aggregator) | $2.1M | — |

### Gas Cost Analysis

**Current base fee: 0.066 gwei** (extremely low)

| Scenario | Gas Cost (USD) |
|----------|----------------|
| Current (0.066 gwei) | **$0.05** |
| With 0.5 gwei tip | **$0.44** |
| Moderate (5 gwei) | **$3.89** |
| Busy (20 gwei) | **$15.55** |

Break-even on $100K Aave flash loan: $50 fee + $0.44 gas = **$50.44 minimum revenue** (~5.1 bps price gap).
With Balancer (0% fee): ~$0.44 minimum = sub-1-bp price gap needed.

### MEV Protection

- **Flashbots Protect RPC**: `https://rpc.flashbots.net` — private tx submission
- **MEV Blocker** (CoW Protocol): returns MEV to users
- **Titan Builder**: $689K/day in fees, top ETH builder
- **MEV-Share**: receive kickbacks from searcher profits

ALL arb transactions must go through private mempools or they WILL be frontrun.

### Key Risks

1. **MEV Competition (CRITICAL)**: Professional searchers with collocated infra, sub-ms execution
2. **Gas Volatility (HIGH)**: Can spike 100x during busy periods
3. **12s Block Time (HIGH)**: Price can shift between submission and inclusion
4. **Slippage (HIGH)**: Large loans move prices on concentrated liquidity pools
5. **Smart Contract Risk (MEDIUM)**: Your contract is the weakest link

### Viability: MEDIUM

Feasible for large ($100K+) arbitrages due to deep liquidity and multiple providers (including free Balancer/Uniswap flash loans). However, MEV competition is extreme — professional firms dominate. Best for: stablecoin pairs with predictable slippage, using Flashbots Protect + Balancer 0% fee.

---

## 2. Avalanche C-Chain

### Chain Fundamentals

| Parameter | Value |
|-----------|-------|
| Chain ID | **43114** |
| Block Time | **~2 seconds** |
| Finality | **~1-2 seconds** (sub-second typical) |
| AVAX Price | **$6.62** |
| Total DeFi TVL | **$472.4M** |
| EVM Compatible | Yes |

### Flash Loan Providers

| Provider | Fee | Contract Address | Notes |
|----------|-----|------------------|-------|
| **Aave V3** | 0.05% (5 bps) | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | PoolAddressesProvider: `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| **Balancer V2** | **0%** | Confirmed on Avalanche | Priority provider — same strategy as Base |
| **Benqi** | N/A | — | Native lending, no flash loan support (Compound fork) |

### Top DEXes by Volume

Total 24h DEX Volume: **$135,051,965** across 85 DEX protocols.

| Rank | DEX | 24h Volume | 7d Volume |
|------|-----|-----------|----------|
| 1 | Pharaoh V3 | $48.7M | $184.4M |
| 2 | Uniswap V3 | $22.6M | $69.7M |
| 3 | Blackhole CLMM | $12.9M | $186.4M |
| 4 | PumpSpace V3 | $4.8M | $23.2M |
| 5 | Trader Joe V2.2 | $2.7M | $29.0M |
| 6 | WOOFi Swap | $2.5M | $3.8M |
| 7 | Pangolin V3 | $2.5M | $18.7M |

Key insight: Pharaoh V3 dominates with 36% of total volume. Curve has minimal presence ($125K/24h).

### Gas Cost Analysis

| Transaction Type | USD Cost |
|-----------------|----------|
| DEX Swap | ~$0.033 |
| Flash Loan Arb (simple) | ~$0.058 |
| Flash Loan Arb (complex) | ~$0.083 |
| Flash Loan + Multi-hop | ~$0.116 |

~10x more expensive than Base ($0.001-0.01), but still very cheap vs Ethereum ($5-50).

Break-even: Balancer 0% fee → ~$850 min loan for $0.10 profit. Aave 0.05% fee → ~$3,400 min loan.

### MEV Protection

**No MEV protection available on Avalanche.** No Flashbots equivalent, no private mempool, no Flashblocks.
This is the single biggest risk vs Base (which has partial MEV protection via Flashblocks).

Mitigations: tight slippage (50 bps max), randomize timing, sub-second finality limits MEV windows.

### Key Risks

1. **No MEV protection** (front-running can eliminate profit)
2. **Lower TVL than Base** ($472M vs $3.8B) — fewer/smaller arb opportunities
3. **Gas costs 10x higher than Base** — higher break-even threshold
4. **AVAX price volatility** — gas costs fluctuate in USD
5. **DEX fragmentation** — 85 DEXes split liquidity thin
6. **Pharaoh V3 concentration** — single DEX dominates, unproven protocol

### Viability: LOW-MEDIUM

The combination of no MEV protection + higher gas + lower TVL makes Avalanche less attractive than Base, Optimism, or Ethereum. However, 0% Balancer flash loans and fast finality make it viable for future expansion after primary chains are operational.

---

## 3. Optimism (OP Mainnet)

### Chain Fundamentals

| Parameter | Value |
|-----------|-------|
| Chain ID | **10** |
| Block Time | **~2 seconds** |
| Type | Optimistic Rollup (L2 on Ethereum) |
| Total DeFi TVL | **~$285.7M** |
| Native Token | ETH |
| Sequencer | Centralized (Optimism Foundation) |

### Flash Loan Providers

| Provider | Fee | Contract Address | Notes |
|----------|-----|------------------|-------|
| **Aave V3** | 0.05% (5 bps) | PoolAddressesProvider: `0xa97684EA0C0e415BAe18a0D3bdcC62b9cdE3E8B8` | Fee waiver available for FLASH_BORROWER role |
| **Uniswap V3 Flash** | Pool fee tier (0.05-1%) | Pool-dependent | 24h Vol: $24.24M (V3) + $1.04M (V4) |
| **Balancer V2** | **0%** | Verify on OP Etherscan | Standard Balancer 0% flash loan |
| **Solidly V3** | Possible via callback | — | TVL small on OP |
| **Beethoven X** | Possible (Balancer fork) | — | May support flash loans from pools |

### Top DEXes by Volume

**Total 24h Spot DEX Volume: ~$44.7M**

| Rank | DEX | 24h Volume | 7d Volume | All-Time |
|------|-----|-----------|-----------|----------|
| 1 | **Uniswap V3** | $24.24M | $78.8M | $39.4B |
| 2 | **Velodrome V3** | $18.29M | $94.9M | $27.1B |
| 3 | Uniswap V4 | $1.04M | $7.7M | $1.1B |
| 4 | Velodrome V2 | $0.59M | $3.9M | $3.6B |
| 5 | Curve DEX | $0.21M | $1.5M | $3.0B |
| 6 | Solidly V3 | $0.21M | $3.1M | $1.5B |
| 7 | Beets DEX | $0.10M | $0.3M | $1.9B |

Velodrome detail: Largest native DEX (ve(3,3) model), 0.02% base swap fees, dominant for OP-native tokens.

### Gas Cost Analysis

| Transaction Type | Estimated Cost (USD) |
|------------------|---------------------|
| Simple ETH transfer | $0.001-0.01 |
| Token swap (DEX) | $0.01-0.10 |
| Flash loan arbitrage (complex) | **$0.50-3.00** |

L2 base fee typically under 1 gwei; L1 data availability fee adds ~$0.01-0.05 per tx.

### Minimum Profitable Spread

```
Aave V3:  0.05% (5 bps) flash loan fee
        + ~0.01% (1 bp) gas
        + 0.02% (2 bps) slippage buffer
        + 0.01% (1 bp) MEV buffer
        = ~0.09% (9 bps) minimum spread

Balancer: 0% flash loan fee
        = ~4 bps minimum spread
```

### MEV Protection

| Feature | Status | Notes |
|---------|--------|-------|
| Flashbots Protect RPC | Available | Can submit via Flashbots |
| Private Mempool | Partial | OP sequencer sees all txs |
| Sequencer MEV | Risk | Centralized sequencer can theoretically reorder txs |
| Block Building | Sequencer-controlled | No competitive block building |

**Critical:** Centralized sequencer sees all transactions before ordering. Fundamentally different from Ethereum's Flashbots protection.

### Key Risks

1. **Sequencer Centralization (HIGH)**: Single sequencer controls tx ordering; could theoretically frontrun
2. **Lower TVL (HIGH)**: $285.7M total DeFi TVL << Base/Aribtrum; flash loans >$5-10M cause slippage
3. **Moderate DEX Volume (MEDIUM)**: $44.7M daily << Base ($200M+) or Arbitrum ($1B+)
4. **Velodrome Dominance (MEDIUM)**: Single DEX controls ~42% of volume; less cross-DEX arb opportunity
5. **Aave V3 Pause Risk (LOW)**: Governance can pause flash loans during market stress

### Viability: MEDIUM

| Factor | Rating | Notes |
|--------|--------|-------|
| Flash Loan Availability | 8/10 | Aave V3 + Uniswap V3 + Balancer |
| DEX Liquidity | 6/10 | $285M TVL, decent but not deep |
| DEX Volume | 5/10 | $44.7M/day — moderate opportunity frequency |
| Gas Costs | 9/10 | Excellent — sub-cent to few dollars |
| Block Speed | 8/10 | 2s blocks — fast execution |
| MEV Competition | 5/10 | Sequencer centralization risk |
| Ecosystem Maturity | 7/10 | Established L2 with proven protocols |

**Overall: 6/10 viability.** A step down from Base in opportunity frequency and liquidity. Consider as a secondary chain after Base is fully optimized.

---

## Cross-Chain Comparison vs Base (Current System)

| Metric | Base (Current) | Ethereum | Avalanche | Optimism |
|--------|---------------|----------|-----------|----------|
| DeFi TVL | ~$3.8B | $36.2B | $472.4M | $285.7M |
| 24h DEX Vol | ~$200M+ | ~$1.6B+ | ~$135M | ~$44.7M |
| Block Time | ~2s | ~12s | ~2s | ~2s |
| FL Providers | Aave V3 + Balancer | Aave V3 + Balancer + MakerDAO + Uniswap | Aave V3 + Balancer | Aave V3 + Balancer + Uniswap |
| Best FL Fee | 0% (Balancer) | 0% (Balancer/Uniswap) | 0% (Balancer) | 0% (Balancer) |
| Gas/FL Tx | $0.001-0.01 | $0.05-15.55 | $0.06-0.12 | $0.50-3.00 |
| MEV Protection | Partial (Flashblocks) | Strong (Flashbots) | NONE | Weak (sequencer) |
| Min Spread (Aave) | ~6 bps | ~5.1 bps | ~7 bps | ~9 bps |
| Min Spread (Balancer) | ~1 bp | ~0.3 bps | ~1 bp | ~4 bps |
| Arb Competition | Low-Medium (50-100 bots) | Extreme (500+ bots) | Low | Low-Medium |

### Expansion Priority

1. **Ethereum** — Large trade opportunities ($100K+), free Balancer/Uniswap flash loans, strong MEV protection via Flashbots. Deploy for large stablecoin arb only.
2. **Optimism** — Similar L2 profile to Base, fast blocks, low gas. Cross-chain Base↔OP arb via native bridge (both Coinbase L2s). Secondary priority.
3. **Avalanche** — Fast finality but no MEV protection and lower TVL. Tertiary priority for future expansion.

---

## Recommended Next Steps

1. **Ethereum deployment**: Implement Balancer 0% flash loan path + Flashbots Protect RPC for private mempool submission. Target stablecoin pairs (USDC/DAI/USDT) for predictable slippage on $100K+ trades.
2. **Optimism deployment**: Monitor Velodrome V3 vs Uniswap V3 price discrepancies. Implement cross-chain Base↔OP arb via native bridge.
3. **Avalanche exploration**: Wait until primary chains are operational. Then evaluate Pharaoh V3 + Balancer 0% FL path.
4. **Shared infrastructure**: Abstract flash loan provider interface to support Aave V3 + Balancer across all chains with chain-specific config.

---

*Report generated by Agent Zero Deep Research swarm — 3 parallel researcher agents.*
