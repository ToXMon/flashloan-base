# Avalanche C-Chain Flash Loan Arbitrage Feasibility Report

**Date**: 2026-06-06
**Researcher**: Agent Zero Deep Research
**Data Sources**: DeFiLlama API, Aave Address Book (GitHub), CoinGecko

---

## 1. Chain Specifications

| Parameter | Value |
|-----------|-------|
| **Chain Name** | Avalanche C-Chain (Contract Chain) |
| **Chain ID** | 43114 |
| **Block Time** | ~2 seconds |
| **Finality** | ~1-2 seconds (sub-second typical) |
| **Native Token** | AVAX |
| **AVAX Price** | $6.62 (as of research date) |
| **Consensus** | Snowball (Avalanche consensus) |
| **EVM Compatible** | Yes (full Solidity support) |
| **Total DeFi TVL** | $472.4M |
| **Block Explorer** | SnowTrace (snowscan.xyz) |
| **RPC** | `https://api.avax.network/ext/bc/C/rpc` |

### Comparison to Base

| Metric | Avalanche C-Chain | Base |
|--------|-------------------|------|
| Chain ID | 43114 | 8453 |
| Block Time | ~2s | ~2s |
| Finality | ~1-2s | ~2s (sequencer) |
| Total TVL | $472M | $3.8B |
| Native Token | AVAX ($6.62) | ETH ($ variable) |
| Gas Token | AVAX | ETH |
| EVM Compatible | Yes | Yes |

---

## 2. Flash Loan Providers

### Aave V3 on Avalanche

| Parameter | Value |
|-----------|-------|
| **Flash Loan Fee** | 0.05% (5 basis points) |
| **Pool Address** | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| **Pool Addresses Provider** | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| **Pool Configurator** | `0x8145eddDf43f50276641b55bd3AD95944510021E` |
| **Aave Oracle** | `0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C` |
| **ACL Manager** | `0xa72636CbcAa8F5FF95B2cc47F3CDEe83F3294a0B` |
| **Protocol Data Provider** | `0x243Aa95cAC2a25651eda86e80bEe66114413c43b` |
| **Collector** | `0x5ba7fd868c40c16f7aDfAe6CF87121E13FC2F7a0` |
| **Explorer Prefix** | `https://snowscan.xyz/address/` |

**Supported Assets for Flash Loans** (major assets): AVAX, WETH.e, WBTC.e, USDC, USDT, DAI.e, LINK.e, AAVE, FRAX, and more.

### Balancer V2 on Avalanche

| Parameter | Value |
|-----------|-------|
| **Available** | YES — confirmed on Avalanche |
| **Flash Loan Fee** | 0% (free flash loans) |
| **Strategic Value** | HIGH — 0% fee makes this the priority provider |

> Note: Balancer V2 offers 0% flash loans on all pools, making it the most cost-effective provider. This mirrors the strategy on Base where Balancer is preferred over Aave.

### Benqi (Native Avalanche Lending)

| Parameter | Value |
|-----------|-------|
| **Category** | Lending |
| **Available** | YES — native Avalanche protocol |
| **Flash Loan Support** | Not standard — Benqi is a Compound fork, no native flash loan facility |

### Other Potential Flash Loan Sources

- **Trader Joe**: No native flash loan facility
- **Curve**: No native flash loan facility (but pools can be leveraged via Aave)
- **Dexalot**: Order-book DEX, no flash loans

---

## 3. Top DEXes by TVL and Volume

### DEX Volume Rankings (24h)

Total DEX 24h Volume on Avalanche: **$135,051,965**

| Rank | DEX | 24h Volume | 7d Volume | Category |
|------|-----|-----------|----------|----------|
| 1 | **Pharaoh V3** | $48,720,906 | $184,350,953 | CLMM DEX |
| 2 | **Uniswap V3** | $22,554,889 | $69,677,925 | CLMM DEX |
| 3 | **Blackhole CLMM** | $12,869,744 | $186,367,487 | CLMM DEX |
| 4 | **PumpSpace V3** | $4,836,711 | $23,235,043 | CLMM DEX |
| 5 | **Joe V2.2** (Trader Joe) | $2,670,647 | $28,990,366 | AMM/CLMM |
| 6 | **WOOFi Swap** | $2,536,317 | $3,810,853 | Aggregator |
| 7 | **Pangolin V3** | $2,512,436 | $18,692,818 | CLMM DEX |
| 8 | **Metric** | $2,246,443 | $13,168,268 | DEX |
| 9 | **Dexalot DEX** | $2,037,727 | $9,441,878 | Order Book |
| 10 | **Uniswap V4** | $1,312,797 | $11,183,399 | CLMM DEX |
| 11 | **Joe DEX** (legacy) | $679,897 | $3,294,405 | AMM |
| 12 | **Joe V2.1** | $608,051 | $3,643,989 | AMM |
| 13 | **Curve DEX** | $125,296 | $435,952 | Stableswap |

### Key Observations

1. **Pharaoh V3 dominates** with $48.7M 24h volume (36% of total) — this is the primary DEX on Avalanche
2. **Uniswap V3 is #2** with $22.5M — good for cross-chain arb comparison with Base
3. **Blackhole CLMM** has strong 7d volume ($186M) but lower 24h ($12.9M) — possibly volatile
4. **Trader Joe (V2.2 + legacy)** combined ~$3.96M — was historically the top Avalanche native DEX but has lost ground to Pharaoh
5. **Curve has minimal volume** ($125K) — limited stableswap arb opportunity
6. **85 total DEX protocols** listed on DeFiLlama for Avalanche

### Arbitrage-Relevant DEX Pairs

Most liquid pairs for cross-DEX arbitrage:
- Pharaoh V3 <-> Uniswap V3 (largest volume overlap)
- Pharaoh V3 <-> Trader Joe V2.2
- Uniswap V3 <-> Pangolin V3
- WOOFi <-> Pharaoh V3 (aggregator routing)

---

## 4. Gas Cost Analysis

### Avalanche C-Chain Gas Costs

| Transaction Type | Gas Units | AVAX Cost | USD Cost |
|-----------------|-----------|-----------|----------|
| Simple Transfer | 21,000 | 0.000525 | $0.003 |
| DEX Swap | ~200,000 | 0.005000 | $0.033 |
| Flash Loan Arb (simple) | ~350,000 | 0.008750 | $0.058 |
| Flash Loan Arb (complex) | ~500,000 | 0.012500 | $0.083 |
| Flash Loan + Multi-hop | ~700,000 | 0.017500 | $0.116 |

**Assumptions**: Base fee ~25 nAVAX (0.000000025 AVAX per gas unit), AVAX @ $6.62

### Gas Cost Comparison

| Chain | Flash Loan Arb (USD) |
|-------|---------------------|
| **Avalanche C-Chain** | $0.06 - $0.12 |
| **Base** | $0.001 - $0.01 |
| **Ethereum Mainnet** | $5 - $50 |

> Avalanche gas is significantly cheaper than Ethereum but ~10x more expensive than Base. This affects minimum profitable trade size.

### Break-Even Analysis

For a flash loan arbitrage to be profitable on Avalanche:

$$\text{Min Profit} > \text{Flash Loan Fee} + \text{Gas} + \text{Slippage}$$

| Provider | Fee | Gas (USD) | Slippage Buffer (2 bps) | Min Spread Needed |
|----------|-----|-----------|-------------------------|-------------------|
| Balancer (0%) | 0 bps | $0.083 | 2 bps | ~2 bps + $0.083/loan_size |
| Aave V3 (0.05%) | 5 bps | $0.083 | 2 bps | ~7 bps + $0.083/loan_size |

**Minimum loan for $0.10 net profit:**
- Balancer: $0.10 - $0.083 = $0.017 profit needed from spread → ~$850 loan at 2 bps
- Aave V3: $0.10 - $0.083 = $0.017 from spread after 5 bps fee → ~$3,400 loan at 7 bps

---

## 5. MEV Protection on Avalanche

### Current MEV Landscape

| Feature | Status |
|---------|--------|
| Private Mempool | **NOT available** — No Avalanche equivalent of Flashbots Protect |
| MEV Relay | **NOT available** — No private transaction routing
| Front-running Risk | **HIGH** — All transactions visible in public mempool |
| Sandwich Attack Risk | **MODERATE** — Lower TVL than Ethereum means fewer MEV bots |
| Flash Blocks | **NOT available** — No equivalent to Base Flashblocks |

### MEV Protection Strategies for Avalanche

1. **Use tight slippage limits** — Maximum 50 bps for arb transactions
2. **Avoid predictable patterns** — Randomize transaction timing
3. **Direct validator connections** — Some Avalanche validators may accept private transactions (no standard protocol)
4. **Self-validate** — Avalanche's sub-second finality means MEV windows are shorter than Ethereum
5. **Use aggregators** — WOOFi and other aggregators may provide some MEV protection through routing

### Risk Assessment

The lack of Flashbots-style protection on Avalanche is a **significant risk factor**. However:
- The 2-second block time limits MEV extraction windows
- Lower overall DeFi activity means fewer sophisticated MEV bots
- Sub-second finality means transactions confirm quickly once included

---

## 6. Key Risks for Avalanche Flash Loan Arbitrage

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **No MEV protection** | Front-running can eliminate profit | Tight slippage, random timing, direct validator connections |
| **Lower TVL than Base** | Smaller arb opportunities | Focus on highest-volume pairs (Pharaoh/Uniswap V3) |
| **Gas costs higher than Base** | Higher break-even threshold | Use Balancer (0% fee) as primary flash loan source |
| **AVAX price volatility** | Gas costs fluctuate in USD terms | Monitor AVAX price, adjust min profit thresholds |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Liquidity fragmentation** | 85 DEXes split liquidity thin | Target top 5 DEXes only |
| **New/unknown DEXes** | Pharaoh V3 dominance is recent | Verify contract safety before interacting |
| **Cross-chain bridge risk** | Moving funds between chains | Use official Avalanche Bridge, keep minimal exposure |
| **Validator centralization** | Some validators may front-run | Spread transactions across validators |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Network congestion** | Rare on Avalanche | Monitor gas prices, avoid peak periods |
| **Smart contract risk** | Aave V3 audited, low risk | Use established protocols only |
| **Regulatory** | Avalanche is a public chain | Standard compliance practices |

### Avalanche-Specific Risks

1. **Subnet Complexity**: Avalanche's subnet architecture means some assets may only be available on specific subnets, not the C-Chain
2. **Bridge Dependency**: Many assets on Avalanche are bridged (WETH.e, WBTC.e) — bridge risk applies
3. **Fee Market Dynamics**: Avalanche's gas fee market can spike during high activity despite generally low fees
4. **DEX Fragmentation**: The 85 DEXes mean liquidity is spread thin — concentration on top 3-4 is essential
5. **Pharaoh V3 Concentration**: Single DEX dominates volume — if Pharaoh experiences issues, arb opportunity landscape changes dramatically

---

## 7. Feasibility Assessment

### Overall Verdict: **MODERATELY FEASIBLE**

### Strengths
- Fast finality (~1-2 seconds) enables quick execution
- 0% flash loans available via Balancer V2
- $135M daily DEX volume provides arb opportunities
- Full EVM compatibility allows code reuse from Base
- 85 DEXes create potential for price discrepancies

### Weaknesses
- No MEV protection (major disadvantage vs Base)
- Higher gas costs than Base (~$0.08 vs ~$0.001 per tx)
- Lower TVL than Base ($472M vs $3.8B)
- AVAX price volatility affects profitability
- DEX landscape dominated by newer/unproven protocols (Pharaoh V3)

### Recommended Strategy

1. **Primary flash loan source**: Balancer V2 (0% fee) — same as Base strategy
2. **Fallback flash loan source**: Aave V3 (0.05% fee)
3. **Target DEXes**: Pharaoh V3, Uniswap V3, Trader Joe V2.2, Pangolin V3
4. **Minimum trade size**: $3,000+ for Aave, $500+ for Balancer
5. **Maximum positions**: Start with $100-500 capital for testing

### Implementation Priority vs Other Chains

| Chain | TVL | Volume | Gas | MEV Protection | Priority |
|-------|------|--------|-----|----------------|----------|
| Base (current) | $3.8B | High | $0.001 | Partial (Flashblocks) | 1 (operational) |
| Arbitrum | $1.2B | High | $0.01-0.05 | Partial (Flashbots) | 2 |
| Polygon | $1.1B | Medium | $0.01 | Limited | 3 |
| **Avalanche** | **$472M** | **$135M/day** | **$0.08** | **None** | **4** |
| BSC | $5.0B | High | $0.05-0.20 | Limited | 5 |

### Key Contract Addresses (Quick Reference)

```
# Aave V3 Avalanche
POOL=0x794a61358D6845594F94dc1DB02A252b5b4814aD
POOL_ADDRESSES_PROVIDER=0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
POOL_CONFIGURATOR=0x8145eddDf43f50276641b55bd3AD95944510021E
ORACLE=0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C
ACL_MANAGER=0xa72636CbcAa8F5FF95B2cc47F3CDEe83F3294a0B
DATA_PROVIDER=0x243Aa95cAC2a25651eda86e80bEe66114413c43b

# Chain Configuration
CHAIN_ID=43114
RPC_URL=https://api.avax.network/ext/bc/C/rpc
EXPLORER=https://snowscan.xyz
BLOCK_TIME=2s
NATIVE_TOKEN=AVAX
```

---

*Report generated by Agent Zero Deep Research. Data sourced from DeFiLlama API, Aave GitHub Address Book, and CoinGecko. All figures are point-in-time snapshots and may have changed since research date.*
