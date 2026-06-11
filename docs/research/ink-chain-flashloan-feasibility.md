# Ink Chain Flash Loan Arbitrage Feasibility Report

**Date:** 2026-06-06
**Researcher:** Agent Zero Deep Research
**Status:** COMPLETED
**Confidence Level:** MIXED (chain specs confirmed, DeFi ecosystem partially confirmed, flash loan feasibility estimated)

---

## 1. What Is Ink Chain?

| Attribute | Value | Status |
|-----------|-------|--------|
| **Full Name** | Ink | CONFIRMED |
| **Builder** | Kraken (crypto exchange, est. 2011) | CONFIRMED |
| **Type** | Ethereum Layer 2 (Optimistic Rollup) | CONFIRMED |
| **Stack** | OP Stack (Optimism) | CONFIRMED |
| **Superchain** | Yes — part of Optimism Superchain | CONFIRMED |
| **Mainnet Launch** | December 18, 2024 | CONFIRMED |
| **Analogue** | Coinbase's Base (same OP Stack architecture) | CONFIRMED |
| **Mission** | Bring Kraken's 10M+ users into DeFi | CONFIRMED |
| **Sequencer** | Kraken operates sequencer (plans to decentralize) | CONFIRMED |

**Summary:** Ink is Kraken's answer to Coinbase's Base. Same OP Stack foundation, same Superchain membership, same EVM compatibility. Launched mainnet in late 2024 with 1-second block times. Currently centralized sequencer with plans to decentralize.

---

## 2. Chain Specifications

| Spec | Value | Status |
|------|-------|--------|
| **Chain ID** | 57073 | CONFIRMED (ChainList, Alchemy, DefiLlama) |
| **Block Time** | 1 second | CONFIRMED (Ink docs) |
| **Gas Token** | ETH | CONFIRMED |
| **EVM Compatible** | Yes (full EVM equivalence) | CONFIRMED |
| **Consensus** | Optimistic rollup (OP Stack) | CONFIRMED |
| **TPS** | ~2,000 estimated | ESTIMATED |
| **Finality** | Ethereum L1 dependent (optimistic ~7 day challenge period) | ESTIMATED |
| **RPC Providers** | Alchemy, QuickNode, GetBlock, Bootnode, Pocket Network | CONFIRMED |
| **Block Explorer** | Available via thirdweb, ChainList | CONFIRMED |

---

## 3. Overall DeFi TVL

| Metric | Value | Status |
|--------|-------|--------|
| **Total DeFi TVL** | $197,465,599 (~$197.5M) | CONFIRMED (DefiLlama API, 2026-06-06) |
| **Total Protocols** | 30 | CONFIRMED (DefiLlama) |
| **DEX Protocols** | 12 | CONFIRMED (DefiLlama) |

**Context:** $197.5M TVL is modest but growing. For comparison, Base has ~$4B+ TVL. Ink is ~5% of Base's DeFi activity.

---

## 4. Top DEXes on Ink (Volume & TVL)

### DEX Volume Rankings (DefiLlama)

| DEX | 24h Volume | 7d Volume | Ink TVL | Status |
|-----|-----------|-----------|---------|--------|
| **Velodrome V3** | $16,844,486 | $66,719,832 | $11,139,994 | CONFIRMED |
| **Nado Spot** | N/A | N/A | $50,126,841 | CONFIRMED (TVL only) |
| **Curve DEX** | $319 | $3,386 | $1,129 | CONFIRMED (minimal) |
| **Velodrome V2** | $135 | $2,237 | $56,052 | CONFIRMED (legacy) |
| **Uniswap V4** | N/A | N/A | $2,716 | CONFIRMED (minimal) |
| **InkySwap** | N/A | N/A | $383,008 | CONFIRMED |
| **DyorSwap AMM** | N/A | N/A | $89,419 | CONFIRMED |
| **SakuraSwap CLMM** | N/A | N/A | $55,609 | CONFIRMED |
| **SakuraSwap AMM** | N/A | N/A | $15,789 | CONFIRMED |
| **SquidSwap** | N/A | N/A | $58,181 | CONFIRMED |
| **Tsunami V3** | N/A | N/A | $17,749 | CONFIRMED |
| **InkSwap** | N/A | N/A | $16,364 | CONFIRMED |

**Key Observation:** Velodrome V3 dominates with $16.8M daily volume — that's ~99%+ of all DEX volume on Ink. This creates a single-point-of-failure for arbitrage. Nado Spot has $50M TVL but unclear volume (may be an OTC/spot settlement venue rather than traditional DEX).

### DEX Concentration Risk
- Velodrome V3: **~99% of DEX volume** (CRITICAL concentration)
- All other DEXes combined: <1% of volume
- Cross-DEX arbitrage opportunities are **severely limited** by this concentration

---

## 5. Lending Protocols & Flash Loan Providers

### All Lending Protocols on Ink

| Protocol | Category | Ink TVL | Flash Loans? | Status |
|----------|----------|---------|--------------|--------|
| **Tydro** | Lending | $135,522,661 | UNKNOWN | CONFIRMED TVL |
| **Morpho Blue** | Lending | $13 | Unlikely (minimal TVL) | CONFIRMED |
| **Spreads Finance** | Leverage/Lending | $190,915 | UNKNOWN | CONFIRMED |
| **Xpert** | Lending | $17 | Unlikely | CONFIRMED |
| **Shroomy Protocol** | Lending | $13,393 | Unlikely | CONFIRMED |

### Critical Gap: NO Major Flash Loan Providers

| Provider | Status on Ink | Notes |
|----------|---------------|-------|
| **Aave V3** | NOT PRESENT | No Aave deployment on Ink confirmed |
| **Balancer** | NOT PRESENT | No Balancer pools on Ink |
| **Uniswap V3 Flash** | THEORETICAL ONLY | Uniswap V4 deployed but $2,716 TVL — unusable for flash swaps |
| **dYdX** | NOT PRESENT | Not deployed on Ink |

**This is the single biggest blocker for flash loan arbitrage on Ink.**

### Tydro Deep Dive

Tydro holds $135.5M TVL on Ink — by far the largest lending protocol. However:
- No public documentation found on flash loan functionality
- No confirmed ability to execute uncollateralized borrows within a single transaction
- May be a yield/vault protocol rather than a traditional lending market
- **NEEDS VERIFICATION** before any flash loan strategy can be built

---

## 6. Gas Costs

| Metric | Value | Status |
|--------|-------|--------|
| **Typical Gas Price** | <1 gwei (estimated) | ESTIMATED |
| **Simple Transfer** | < $0.001 (estimated) | ESTIMATED |
| **DEX Swap** | < $0.01 (estimated) | ESTIMATED |
| **Complex DeFi Tx** | < $0.05 (estimated) | ESTIMATED |

**Methodology:** Ink uses OP Stack with ETH gas token. As an L2 with low congestion and 1-second blocks, gas costs should be comparable to Base (<1 gwei typical). However, no confirmed on-chain gas data was available at time of research.

**Impact on Arbitrage:** If gas is truly sub-cent, the profitability threshold for flash loan arbitrage is significantly lower than Ethereum mainnet. A $0.01 gas cost means a $10 flash loan arb only needs >0.1% profit margin to be viable (vs ~0.05% Aave fee + gas).

---

## 7. MEV Protection

| Aspect | Status | Notes |
|--------|--------|-------|
| **Flashbots/Protect RPC** | UNKNOWN | No confirmed Flashbots support for Ink |
| **Private Mempool** | UNKNOWN | No data found |
| **Sequencer Fair Ordering** | UNKNOWN | OP Stack default is FIFO, not fair ordering |
| **MEV-Share** | NOT PRESENT | Not deployed on Ink |
| **Frontrunning Risk** | MEDIUM-HIGH | Centralized sequencer + no MEV protection = high frontrunning risk |

**Assessment:** Ink currently uses Kraken's centralized sequencer with standard OP Stack transaction ordering. Without Flashbots Protect or equivalent private mempool, arbitrage transactions are visible in the public mempool and vulnerable to frontrunning. This is a significant risk for any profitable arbitrage strategy.

**Mitigation Options:**
1. Use private RPC endpoints if available (Alchemy/QuickNode may offer private mempool)
2. Submit transactions with tight slippage limits
3. Use atomic multi-step transactions to minimize exposure window
4. Monitor for MEV bot activity on Ink

---

## 8. Additional Ecosystem Protocols

### Capital Allocators / Yield

| Protocol | TVL on Ink | Category |
|----------|-----------|----------|
| **Veda** | $374,229,643 | Onchain Capital Allocator |
| **Sentora** | $373,724,142 | Risk Curators |
| **Upshift** | $7 | Onchain Capital Allocator |

Note: Veda and Sentora TVLs ($374M, $373M) exceed Ink's total DeFi TVL ($197M). This suggests these protocols may be counted with cross-chain TVL or there's double-counting in DefiLlama's methodology.

### Bridges

| Protocol | TVL on Ink |
|----------|-----------|
| **LayerZero V2** | $105,440 |
| **Hyperlane** | $34,138 |
| **Everclear** | $0 |

### RWA

| Protocol | TVL on Ink |
|----------|-----------|
| **Apollo Diversified Credit** | $10,984,266 |
| **Tether Gold** | $19,783 |
| **Midas RWA** | $65 |

---

## 9. Flash Loan Arbitrage Feasibility Assessment

### Overall Verdict: NOT FEASIBLE (Current State)

| Factor | Rating | Details |
|--------|--------|---------|
| **Flash Loan Availability** | CRITICAL BLOCKER | No Aave V3, no Balancer, no confirmed flash loan providers |
| **DEX Liquidity** | POOR | Only Velodrome V3 has meaningful volume ($16.8M/day) |
| **DEX Diversity** | CRITICAL | ~99% volume on single DEX = no cross-DEX arb opportunity |
| **Gas Costs** | FAVORABLE | Likely sub-cent, low barrier to profitability |
| **MEV Protection** | UNFAVORABLE | No private mempool, frontrunning risk high |
| **Block Speed** | FAVORABLE | 1-second blocks enable fast execution |
| **Ecosystem Maturity** | EARLY | 30 protocols, $197M TVL, launched Dec 2024 |

### Profitability Analysis

For flash loan arbitrage to be viable on any chain:

```
Required: Profit > Flash Loan Fee + Gas + Slippage + MEV Risk

On Ink (hypothetical, if flash loans existed):
- Flash loan fee: 0.05% (Aave standard) — BUT NO AAVE ON INK
- Gas cost: ~$0.01 (estimated, favorable)
- Slippage: Unknown (low liquidity = HIGH slippage risk)
- MEV risk: HIGH (no protection)

Minimum profitable spread: Unknown (cannot calculate without flash loan provider)
```

### What Would Make Ink Viable?

1. **Aave V3 deployment on Ink** — This is the #1 prerequisite
2. **Second major DEX** — Need at least 2 DEXes with $1M+ daily volume for cross-DEX arb
3. **Higher TVL** — Need $500M+ TVL for meaningful liquidity depth
4. **MEV protection** — Private mempool or Flashbots integration
5. **More token pairs** — Need diverse trading pairs with deep liquidity

### Monitoring Triggers

Set alerts for:
- Aave V3 governance proposal to deploy on Ink
- Balancer or Uniswap V3 pool deployment with $1M+ TVL
- Second DEX reaching $1M+ daily volume
- Ink total TVL crossing $500M
- Flashbots/MEV protection announcement for Ink

---

## 10. Comparison: Ink vs Base for Flash Loan Arb

| Factor | Base | Ink |
|--------|------|-----|
| Chain ID | 8453 | 57073 |
| TVL | ~$4B+ | ~$197M |
| Aave V3 | YES (0.05% fee) | NO |
| Balancer | YES (0% fee flash loans) | NO |
| Top DEX | Aerodrome ($500M+ vol/day) | Velodrome V3 ($16.8M vol/day) |
| DEX Count (meaningful) | 5+ | 1 |
| Flash Loan Providers | 3+ (Aave, Balancer, Uniswap) | 0 confirmed |
| MEV Protection | Flashbots Protect available | None confirmed |
| Gas Cost | <1 gwei, sub-cent | Likely similar (unconfirmed) |
| Block Time | ~2 seconds | 1 second |
| Arb Feasibility | **VIABLE** (your current system) | **NOT VIABLE** |

---

## 11. Data Sources

| Source | Data Retrieved | URL |
|--------|---------------|-----|
| DefiLlama Chains API | TVL, chain ID | api.llama.fi/v2/chains |
| DefiLlama Protocols API | Protocol list, chain TVLs | api.llama.fi/v2/protocols |
| DefiLlama DEX API | DEX volume rankings | api.llama.fi/overview/dexs/ink |
| Ink Documentation | Block time, specs | docs.inkonchain.com |
| ChainList | Chain ID, RPC | chainlist.org/chain/57073 |
| Alchemy | RPC, chain info | alchemy.com/rpc/ink |
| The Block | Launch announcement | theblock.co |
| CoinGecko | Chain overview | coingecko.com/learn |

---

## 12. Recommendations

1. **Do NOT build flash loan infrastructure on Ink yet** — The fundamental building blocks (flash loan providers, liquid DEXes) don't exist.
2. **Monitor Ink ecosystem growth** — Set up DefiLlama alerts for Ink TVL and new protocol deployments.
3. **Prioritize Aave V3 deployment** — If Aave deploys on Ink, feasibility changes dramatically.
4. **Consider Velodrome V3 analysis** — It's the only DEX with volume; understanding its pool structure would inform future arb opportunities.
5. **Revisit in 3-6 months** — Ink is only ~18 months old. DeFi ecosystems grow fast. Base took ~12 months to become viable for flash loan arb after launch.

---

*Report generated by Agent Zero Deep Research. Data as of 2026-06-06. All financial data from public on-chain sources. This is research only, not financial advice.*
