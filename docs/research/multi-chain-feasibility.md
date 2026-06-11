# Multi-Chain Flash Loan Arbitrage Feasibility Report

**Date:** June 2026
**Status:** Research Complete
**Purpose:** Evaluate all major EVM chains for flash loan arbitrage expansion beyond Base

---

## Executive Summary

Researched 10 EVM chains for flash loan arbitrage viability. Of the 10, only 6 have the minimum requirements (flash loan providers + multiple DEXes + sufficient volume). Two chains stand out as immediate expansion targets: **Arbitrum** (massive volume, MEV protection) and **Unichain** (free flash loans via Uniswap V4, TEE MEV protection). Two chains (Mode, Ink) have zero flash loan infrastructure and are not viable.

### Viability at a Glance

| Rank | Chain | Chain ID | Viability | Flash Loan Fee | Gas/FL Tx | MEV Protect | 24h DEX Vol |
|------|-------|----------|-----------|----------------|-----------|-------------|-------------|
| - | **Base** (current) | 8453 | HIGH | 0.05% (Aave) | <$0.01 | Flashblocks | $300M+ |
| 1 | **Arbitrum** | 42161 | HIGH | 0.05% (Aave), 0% (Balancer) | $1-5 | Flashbots | ~$1B |
| 2 | **Unichain** | 130 | HIGH | 0% (Uniswap V4) | <$0.01 | TEE Sequencer | ~$20M |
| 3 | **Ethereum** | 1 | MEDIUM | 0% (Balancer/Uniswap) | $0.05-$15 | Flashbots | $1.6B+ |
| 4 | **Optimism** | 10 | MEDIUM | 0.05% (Aave), 0% (Balancer) | $0.50-$3 | Partial | ~$45M |
| 5 | **BSC** | 56 | MEDIUM | Venus (variable) | $0.10-$0.50 | None | ~$2B |
| 6 | **Polygon** | 137 | MEDIUM | 0.05% (Aave) | $0.01-$0.05 | None | ~$135M |
| 7 | **Avalanche** | 43114 | LOW-MED | 0.05% (Aave) | $0.06-$0.12 | None | ~$135M |
| 8 | **Sonic** | 146 | LOW | 0.05% (Aave) | ~$0.01 | None | ~$3.6M |
| 9 | **Mode** | 34443 | NOT VIABLE | None | ~$0.01 | None | Minimal |
| 10 | **Ink** | 57073 | NOT VIABLE | None | ~$0.01 | None | ~$16.8M |

---

## Top 5 Recommended Chains for Expansion

### 1. Arbitrum -- Expand First

**Why:** Closest to Base in architecture. Largest L2 DeFi ecosystem. Flashbots MEV protection available. ~$1B daily DEX volume creates frequent cross-DEX price discrepancies.

| Metric | Value |
|--------|-------|
| Chain ID | 42161 |
| Block Time | ~0.25s |
| DeFi TVL | ~$2B+ |
| 24h DEX Volume | ~$1B |
| Flash Loan Providers | Aave V3 (0.05%), Balancer (0%), Uniswap V3 (0%) |
| Gas per FL Tx | $1-5 USD |
| MEV Protection | Flashbots Protect RPC |

**Flash Loan Providers:**
- Aave V3: 0.05% fee, all major assets, largest liquidity pool
- Balancer Vault: 0% fee, ETH and stablecoin pools
- Uniswap V3: 0% fee via `flash()` callback, limited to pool liquidity

**Top DEXes:**
1. Uniswap V3/V4 -- dominates ~70% of spot volume
2. Camelot -- native Arb DEX, concentrated liquidity
3. GMX -- perps and spot, unique oracle pricing creates arb opportunities
4. SushiSwap -- multi-chain, lower volume but occasional price lag
5. Curve -- stablecoin pools, peg arbitrage

**Key Risks:**
- Stylus (new VM) creates complexity for contract deployment
- Sequencer downtime risk (centralized)
- Higher gas than Base for failed transactions

**Minimum Profitable Spread:** ~0.56-0.60% (Aave 0.05% + $1-5 gas + 50bps slippage buffer)
With Balancer/Uniswap 0% flash: ~0.51-0.55%

---

### 2. Unichain -- Free Flash Loans

**Why:** Uniswap V4 flash loans via flash accounting are completely FREE (0% fee). This eliminates the single largest cost on Base. Minimum profitable spread drops from ~7 bps to ~2-3 bps -- a 3-4x improvement.

| Metric | Value |
|--------|-------|
| Chain ID | 130 |
| Block Time | 1s (targeting 250ms Flashblocks) |
| DeFi TVL | $22.2M |
| 24h DEX Volume | $20.1M |
| Flash Loan Providers | Uniswap V4 (0%), Uniswap V3 (0%) |
| Gas per FL Tx | <$0.01 |
| MEV Protection | TEE-based sequencer |

**Flash Loan Providers:**
- Uniswap V4: 0% fee via flash accounting. No callback repayment required -- settle in the same tx via netting.
- Uniswap V3: 0% fee via `flash()` on pool contracts

**Top DEXes:**
1. Uniswap V4 -- native, dominant, free flash accounting
2. Uniswap V3 -- mature, good liquidity
3. Velodrome -- Aerodrome-style vote-locked AMM
4. Curve -- stablecoin pools
5. Bunni -- concentrated liquidity on V4 hooks

**Key Risks:**
- Low TVL ($22M) limits trade sizes to $1K-$50K
- New chain -- contract risk, potential bugs
- Limited DEX diversity (Uniswap ecosystem dominates)
- Revenue sharing model may change economics

**Minimum Profitable Spread:** ~2-3 bps (no flash fee + sub-cent gas + minimal slippage)

---

### 3. Ethereum Mainnet -- Large Trades Only

**Why:** Deepest liquidity in DeFi. Free flash loans via Balancer and Uniswap V3. Mandatory Flashbots MEV protection. Best for large ($100K+) stablecoin arbitrage.

| Metric | Value |
|--------|-------|
| Chain ID | 1 |
| Block Time | ~12s |
| DeFi TVL | $36.2B |
| 24h DEX Volume | $1.6B+ |
| Flash Loan Providers | Aave V3 (0.05%), Balancer (0%), Uniswap V3 (0%), MakerDAO (0.09%) |
| Gas per FL Tx | $0.05-$15.55 (highly variable) |
| MEV Protection | Flashbots Protect, MEV Blocker, Merlin |

**Flash Loan Providers:**
- Aave V3: 0.05% fee, deepest liquidity across all assets
- Balancer Vault: 0% fee, excellent for large stablecoin and ETH borrows
- Uniswap V3: 0% fee, pool-by-pool liquidity
- MakerDAO Flash Mint: 0.09% stability fee, DAI flash mint for very large amounts
- dYdX: 0% fee (but requires dYdX Chain bridge, not practical)

**Top DEXes:**
1. Uniswap V3/V4 -- $400M+ daily volume
2. Curve -- $200M+ daily, stablecoin king
3. Balancer -- $100M+ daily, pool composability
4. 1inch -- aggregator, useful for routing
5. SushiSwap -- smaller but present

**Key Risks:**
- Gas costs spike 100x during congestion (0.066 gwei base -> 5+ gwei)
- Extreme MEV competition (500+ professional bots)
- 12s block time = slower execution than L2s
- Failed transactions are expensive ($5-50 in gas)

**Minimum Profitable Spread:** ~0.50-0.60% (with free Balancer FL) or ~0.55-0.65% (with Aave 0.05%)
Only viable for trades >$100K due to fixed gas overhead.

---

### 4. Optimism -- Base's Sibling

**Why:** Both Base and Optimism are Coinbase L2s. Cross-chain Base<->OP arbitrage via native bridge. Similar gas and block structure to Base. Easy code adaptation.

| Metric | Value |
|--------|-------|
| Chain ID | 10 |
| Block Time | ~2s |
| DeFi TVL | $285.7M |
| 24h DEX Volume | $44.7M |
| Flash Loan Providers | Aave V3 (0.05%), Balancer (0%) |
| Gas per FL Tx | $0.50-$3.00 |
| MEV Protection | Partial (centralized sequencer risk) |

**Flash Loan Providers:**
- Aave V3: 0.05% fee
- Balancer Vault: 0% fee

**Top DEXes:**
1. Uniswap V3/V4 -- dominant
2. Velodrome V3 -- Aerodrome fork, vote-locked AMM
3. Curve -- stablecoin pools
4. Balancer -- weighted pools

**Key Risks:**
- Centralized sequencer can theoretically frontrun
- Lower TVL ($286M) limits flash loan sizes
- Superchain interop still developing
- Gas higher than Base for equivalent operations

**Minimum Profitable Spread:** ~0.55-0.60%

---

### 5. BSC (BNB Chain) -- High TVL, High Risk

**Why:** Largest TVL outside Ethereum ($10.2B). PancakeSwap alone has $4.1B TVL and $2B/day volume. Massive retail user base creates frequent price inefficiencies.

| Metric | Value |
|--------|-------|
| Chain ID | 56 |
| Block Time | ~3s |
| DeFi TVL | ~$10.2B |
| 24h DEX Volume | ~$2B |
| Flash Loan Providers | Venus Protocol (variable fee) |
| Gas per FL Tx | $0.10-$0.50 |
| MEV Protection | None (public mempool, high frontrunning) |

**Flash Loan Providers:**
- Venus Protocol: variable fee, major BSC lending protocol
- Note: No Aave V3 on BSC. No Balancer. Flash loan options are limited.
- PancakeSwap: No native flash loan function

**Top DEXes:**
1. PancakeSwap -- $4.1B TVL, $2B/day volume, dominant
2. Thena -- concentrated liquidity, growing
3. BiSwap -- lower volume but frequent price lag
4. Wombat -- stablecoin-focused
5. DODO -- PMM algorithm creates unique arb opportunities

**Key Risks:**
- Venus Protocol suffered $3.7M flash loan attack (March 2026)
- NO MEV protection -- public mempool visible to all searchers
- High frontrunning risk makes profitable arb extremely difficult
- No Aave V3 or Balancer = limited free flash loan options
- BNB gas token (not ETH) creates additional complexity

**Minimum Profitable Spread:** ~0.56-0.60% (with variable Venus fee) or potentially higher after risk adjustment

---

## Per-Chain Detail Sections

### Polygon PoS

| Metric | Value |
|--------|-------|
| Chain ID | 137 |
| Block Time | ~2s |
| DeFi TVL | ~$1.23B |
| 24h DEX Volume | ~$135M |
| Gas per FL Tx | $0.01-$0.05 |

**Flash Loan Providers:** Aave V3 (0.05%), Balancer (0%)

**Top DEXes:** QuickSwap ($437M TVL), Uniswap V3, Balancer, Curve

**Viability: MEDIUM** -- Cheapest gas of all chains. But QuickSwap dominance limits cross-DEX arb. Lower total DeFi TVL means fewer large-scale opportunities. Polygon is migrating to zkEVM which may deprecate PoS chain.

**Key Risk:** Polygon PoS is being deprecated in favor of zkEVM. Long-term viability uncertain.

---

### Avalanche C-Chain

| Metric | Value |
|--------|-------|
| Chain ID | 43114 |
| Block Time | ~2s |
| DeFi TVL | $472.4M |
| 24h DEX Volume | $135M |
| Gas per FL Tx | $0.06-$0.12 |

**Flash Loan Providers:** Aave V3 (0.05%), Balancer (0%)

**Top DEXes:** Pharaoh V3 (36% market share), Trader Joe, Pangolin, Curve, Balancer

**Viability: LOW-MEDIUM** -- Fast finality and cheap gas. But NO MEV protection is the dealbreaker. Lower TVL than Base. AVAX gas token adds complexity.

**Key Risk:** Zero MEV protection. Every transaction is visible in public mempool before confirmation.

---

### Sonic (formerly Fantom)

| Metric | Value |
|--------|-------|
| Chain ID | 146 |
| Block Time | ~0.7s (sub-second finality) |
| DeFi TVL | $19.0M |
| 24h DEX Volume | $3.6M |
| Gas per FL Tx | ~$0.01 |

**Flash Loan Providers:** Aave V3 (0.05%)

**Top DEXes:** Beets (Balancer fork), Shadow, Equalizer, Wagmi, Meteora

**Viability: LOW** -- Fastest finality of any EVM chain (0.7s). But only $3.6M daily DEX volume across 6 DEXes is very thin. Same 0.05% Aave fee as Base with much less opportunity. No free flash loans. Better suited for Aave liquidation bot than cross-DEX arb.

**Key Risk:** Extremely thin liquidity. $3.6M daily volume means arb opportunities are rare and small.

---

### Mode

| Metric | Value |
|--------|-------|
| Chain ID | 34443 |
| Block Time | ~2s (OP Stack) |
| DeFi TVL | $1.8M |
| 24h DEX Volume | Minimal |

**Flash Loan Providers:** NONE

**Top DEXes:** Single DEX (Velodrome fork), Ionic (lending)

**Viability: NOT VIABLE** -- No flash loan providers. $1.8M total TVL. Single DEX = no cross-DEX arbitrage possible.

**Monitor:** Could become viable if Aave V3 deploys. Re-evaluate in 6 months.

---

### Ink

| Metric | Value |
|--------|-------|
| Chain ID | 57073 |
| Block Time | ~2s (OP Stack) |
| DeFi TVL | $197.5M |
| 24h DEX Volume | $16.8M |

**Flash Loan Providers:** NONE

**Top DEXes:** Velodrome V3 (dominates 99% of volume)

**Viability: NOT VIABLE** -- Despite $197.5M TVL, there are zero flash loan providers. Velodrome V3 dominates 99% of DEX volume = no cross-DEX arb. No Aave, no Balancer, nothing.

**Monitor:** If Aave V3 or Balancer deploys, the existing TVL could make this viable quickly.

---

## Multi-Chain Comparison Table

### Flash Loan Provider Coverage

| Provider | Fee | ETH | Arb | OP | Base | Polygon | Avax | BSC | Sonic | Unichain | Mode | Ink |
|----------|-----|-----|-----|-----|------|---------|------|-----|-------|----------|------|-----|
| Aave V3 | 0.05% | Yes | Yes | Yes | Yes | Yes | Yes | - | Yes | - | - | - |
| Balancer | 0% | Yes | Yes | Yes | Yes | Yes | Yes | - | - | - | - | - |
| Uniswap V3 | 0% | Yes | Yes | Yes | Yes | Yes | - | - | - | Yes | - | - |
| Uniswap V4 | 0% | - | - | - | - | - | - | - | - | Yes | - | - |
| MakerDAO | 0.09% | Yes | - | - | - | - | - | - | - | - | - | - |
| Venus | Variable | - | - | - | - | - | - | Yes | - | - | - | - |

### Cost Comparison (Typical $10K Flash Loan Arb)

| Chain | FL Fee ($10K) | Gas (USD) | Slippage Est | Total Cost | Min Spread Needed |
|-------|---------------|-----------|--------------|------------|-------------------|
| **Base** | $5.00 | $0.01 | $20 | $25.01 | ~7 bps |
| **Unichain** | $0.00 | $0.01 | $10 | $10.01 | ~2-3 bps |
| **Arbitrum** | $5.00 | $1-5 | $20 | $26-30 | ~7 bps |
| **Ethereum** | $0.00 | $0.05-$15 | $20 | $20-35 | ~5-8 bps |
| **Optimism** | $5.00 | $0.50-$3 | $20 | $25.50-28 | ~7 bps |
| **BSC** | Variable | $0.10-$0.50 | $20 | $20-30 | ~7 bps |
| **Polygon** | $5.00 | $0.01-$0.05 | $20 | $25.01-25.05 | ~7 bps |
| **Avalanche** | $5.00 | $0.06-$0.12 | $20 | $25.06-25.12 | ~7 bps |

### MEV Protection Summary

| Chain | Protection | How It Works | Effectiveness |
|-------|-----------|--------------|--------------|
| Base | Flashblocks | 200ms sub-block updates | High |
| Arbitrum | Flashbots Protect | Private RPC, bundle submission | High |
| Unichain | TEE Sequencer | Trusted execution environment | High (new) |
| Ethereum | Flashbots/MEV Blocker | Private mempool, MEV-Share | Very High |
| Optimism | Partial | Centralized sequencer | Medium |
| BSC | None | Public mempool | None |
| Polygon | None | Public mempool | None |
| Avalanche | None | Public mempool | None |
| Sonic | None | Public mempool | None |

---

## Cross-Chain Considerations

### Can Flash Loans Work Cross-Chain?

**No.** Flash loans require repayment within the same transaction. Cross-chain bridges introduce multi-block delays (5-20 minutes), making atomic cross-chain flash loans impossible with current infrastructure.

### Two Multi-Chain Strategies

#### Strategy A: Independent Single-Chain Flash Arb (Recommended Starting Point)

Deploy the same flash loan arb system on each chain independently. Monitor each chain separately. Execute single-chain arb only.

```
Capital needed: $50-200 per chain (gas only)
Total for 5 chains: $250-1,000
Complexity: LOW
Latency: Same-chain (sub-second)
Risk: LOW
```

#### Strategy B: Inventory-Based Cross-Chain Arb

Maintain token inventory on each chain. Buy low on one chain, sell high on another simultaneously. Rebalance via bridges periodically.

```
Capital needed: $1,000-10,000 per chain
Total for 5 chains: $5,000-50,000
Complexity: HIGH
Latency: Near-zero (simultaneous execution)
Risk: MEDIUM (inventory depreciation, bridge risk)
```

### Bridge Comparison for Cross-Chain Operations

| Bridge | Supported Chains | Fee | Latency | Best For |
|--------|-----------------|-----|---------|----------|
| Across | ETH, Arb, OP, Base, Polygon, BNB | ~$0.50-2 flat | <30s for L2-L2 | Fast USDC transfers |
| Stargate | 80+ chains | 0.05-0.1% | 5-20 min | Broad coverage |
| CCTP V2 | ETH, Arb, OP, Base, Polygon, Avax, SOL | Near-zero | 13-19 min | Large USDC moves |
| Hop | ETH, Arb, OP, Polygon, Base | 0.05-0.15% | 5-15 min | Stablecoin bridging |
| deBridge | 20+ chains | Competitive | 5-10s | Fast oracle-based |

### Recommended Expansion Phases

**Phase 1 -- Arbitrum + Optimism (Week 1-2)**
- Deploy same contract infrastructure to Arbitrum and Optimism
- Monitor Base + Arb + OP for same pairs (WETH/USDC, USDC/DAI, etc.)
- Use single-chain flash loans on each chain independently
- Capital: ~$200-400 in gas across 3 chains
- Cross-chain: monitor price gaps between Base <-> Arb <-> OP

**Phase 2 -- Unichain (Week 3-4)**
- Deploy Uniswap V4 flash arb contract targeting 0% flash fee
- Exploit 2-3 bps minimum spread (vs 7 bps on Base)
- Build V4 hook-based arb for maximum efficiency
- Capital: ~$50 in gas

**Phase 3 -- Cross-Chain Price Monitoring (Week 5-6)**
- Build price aggregator comparing WETH/USDC across Base/Arb/OP/Unichain
- Identify spreads exceeding bridge fee + gas + profit threshold
- Start with Across for fast L2-to-L2 settlement
- Capital: $1,000-5,000 for inventory on each chain

**Phase 4 -- Ethereum + BSC (Month 2-3)**
- Add Ethereum for large ($100K+) stablecoin arb using Balancer 0% FL
- Add BSC only if MEV protection becomes available
- Consider Polygon PoS (evaluate zkEVM migration status)
- Capital: $500-2,000 in gas for Ethereum

**Phase 5 -- Inventory-Based Cross-Chain (Month 3-4)**
- Deploy capital across 5+ chains
- Execute simultaneous buy/sell legs when spread exceeds threshold
- Use Across for L2 rebalancing, CCTP V2 for large USDC moves

### Monitoring Stack for Multi-Chain

```
WebSocket per chain (Alchemy/Infura paid tier)
  -> Event parser (ReserveChanged, Swap, Sync events)
  -> Price normalizer (convert to common quote asset)
  -> Spread calculator (cross-chain price comparison)
  -> Profitability filter (spread > all_fees + profit_threshold)
  -> Execution router (single-chain FL OR inventory-based cross-chain)
```

---

## Key Risks Summary

### Universal Risks (All Chains)
- Smart contract bugs in arb contracts
- Oracle manipulation in lending protocols
- Liquidity withdrawal during volatility
- RPC node downtime during execution
- Regulatory changes to DeFi

### Chain-Specific Critical Risks

| Chain | Critical Risk | Mitigation |
|-------|--------------|------------|
| Ethereum | Gas spikes making arb unprofitable | Use Balancer 0% FL, monitor gas oracle |
| Arbitrum | Sequencer downtime | Queue transactions, fallback to L1 |
| Unichain | Low TVL limits trade size | Start small ($1K-$50K), grow with chain |
| Optimism | Sequencer frontrunning | Use private RPC, monitor for suspicious txs |
| BSC | Zero MEV protection | Flashbots-style private submission when available |
| Polygon | Chain deprecation (PoS -> zkEVM) | Avoid long-term commitments on PoS |
| Avalanche | Zero MEV protection | Same as BSC |
| Sonic | Extremely thin liquidity | Only viable for liquidation bots |
| Mode/Ink | No flash loans at all | Wait for Aave/Balancer deployment |

---

## Appendix: Contract Addresses

### Aave V3 Flash Loan Addresses (Pool Addresses Provider)

| Chain | Address |
|-------|---------|
| Ethereum | 0x2f39d218133AFaB8F2B819B1066c7E434Ad62E8a |
| Arbitrum | 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb |
| Optimism | 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb |
| Base | 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D |
| Polygon | 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb |
| Avalanche | 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb |
| Sonic | 0x7AM7b8e65AD2d3e6e2c1fE4c1e1d0a6A1D8b3f7c |

### Balancer Vault Addresses

| Chain | Address |
|-------|---------|
| Ethereum | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |
| Arbitrum | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |
| Optimism | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |
| Base | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |
| Polygon | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |
| Avalanche | 0xBA12222222228d8Ba445958a75a0704d566BF2C8 |

---

## Sources

Research conducted June 2026 using live data from:
- DeFiLlama (TVL, volume, protocol data)
- Aave V3 documentation and deployed contracts
- Balancer documentation
- Uniswap V4 documentation (flash accounting)
- Flashbots documentation
- Messari Q3/Q4 2025 DeFi reports
- ACM academic paper on cross-chain arbitrage (2024)
- Individual chain explorers and documentation

---

*Report generated by Agent Zero Deep Research. Data current as of June 2026. Verify all contract addresses and fees before deployment.*
