# Flash Loan Maximization: Event-Driven Architecture with Multi-Provider Routing and Selective AI Enhancement

## Problem Statement

How might we transform the current polling-based flash loan system into a real-time, multi-provider, intelligently-augmented platform that captures transient Base-chain opportunities before MEV bots — without over-engineering the solution?

## Core Concept (One Sentence)

Upgrade the Base flash loan system to WebSocket event-driven scanning with multi-provider flash loan routing (Aave V3 + Balancer V2) and config-driven DEX registry, while selectively applying AI evaluation for non-latency-critical decisions like memecoin safety scoring and position management.

---

## Template Analysis Summary

### Template 1: Eliza (AI Agent Framework)
**Architecture patterns extracted:**
- Plugin/action system: strategies as swappable plugins with standard interfaces
- Memory system: retrievable store for past decisions and outcomes
- Multi-agent runtime: separate agents for separate concerns
- Character-driven config: JSON-defined behavior profiles
- Model-agnostic: swap LLM providers without code changes

**Relevant for:** Strategy plugin architecture, memory-enhanced trade logging, AI memecoin evaluation

**NOT relevant for:** Real-time arb execution (LLM latency kills speed-sensitive trades)

### Template 2: Flashloan Masterclass (Balancer V2 Leverage)
**Architecture patterns extracted:**
- Balancer V2 `flashLoan()` + `receiveFlashLoan()` callback pattern
- Clean position lifecycle: `openPosition()` → `receiveFlashLoan()` → `open()` → `swap()` → `supply()` → `borrow()`
- Aave health factor threshold enforcement inside contract
- Struct-based params (OpenParams, CloseParams) for gas-efficient calls
- Test fixtures with configurable leverage amounts

**Relevant for:** Alternative flash loan provider (Balancer), cleaner position lifecycle pattern, health factor monitoring

**NOT relevant for:** Base-specific DEX integration (template targets Ethereum mainnet)

### Template 3: Trading Bot v3 (Event-Driven Arb)
**Architecture patterns extracted:**
- WebSocket event-driven: `pool.on('Swap', eventHandler)` triggers instant price check
- Profitability pipeline: `checkPrice()` → `determineDirection()` → `determineProfitability()` → `executeTrade()`
- Quoter simulation via `staticCall` (gas-free price quotes before execution)
- Config-driven DEX registry: all addresses, fees, settings in config.json
- Liquidity-aware sizing: trade 50% of available pool liquidity, not fixed amounts
- `isLocal`/`isDeployed` toggle for safe mainnet monitoring without execution

**Relevant for:** WebSocket event listeners replacing polling, quoter pre-simulation, config-driven architecture, trade pipeline pattern

**NOT relevant for:** PancakeSwap on Base (not deployed there), Balancer flash loans for arb (trading bot uses Balancer but we have Aave)

---

## Recommended Direction

### Three-Pillar Enhancement

**Pillar 1: Real-Time Event-Driven Core** (from Trading Bot v3)
Replace the 15-second polling interval with WebSocket swap event listeners across all monitored DEXes. Every Swap event on Aerodrome CL, Aerodrome AMM, Uniswap V3, and BaseSwap triggers an immediate cross-DEX price check and profitability evaluation. This is the single highest-impact change — on Base's ~2-second blocks, a 15-second poll misses 7+ blocks of opportunities.

The existing `ArbitrageEngine` class gets refactored into an event-driven pipeline: `onSwapEvent()` → `checkCrossDexPrices()` → `simulateViaQuoters()` → `determineProfitability()` → `executeIfProfitable()`. Quoter `staticCall` simulations replace speculative price calculations, giving gas-free exact output quotes before committing any gas.

**Pillar 2: Multi-Provider Flash Loan Router** (from Masterclass)
Add Balancer V2 as an alternative flash loan provider alongside Aave V3. A new `FlashLoanRouter` module compares both providers on-the-fly: which has the requested asset, what's the fee (Aave: 0.05%, Balancer: 0% for most pools but requires repayment in-kind), and what's the available liquidity. Routes to the cheapest option automatically.

This also means moving all DEX addresses, token configs, pool fees, and provider addresses into a single `base-config.json` (from Trading Bot v3's config-driven pattern), making it trivial to add new DEXes or adjust parameters.

**Pillar 3: Selective AI Enhancement** (from Eliza — but carefully)
Do NOT put an LLM in the arb execution path. The latency (1-5 seconds) would kill speed-sensitive opportunities. Instead, apply AI where latency is acceptable:
- Memecoin safety scoring: LLM evaluates token metadata, contract patterns, holder distribution, social signals into a 0-100 safety score (currently done with basic heuristics in `memecoin-hunter.ts`)
- Position management advice: AI monitors open Aave positions and suggests when to reduce exposure based on market conditions
- Market regime detection: classify current market as trending/ranging/volatile to adjust strategy parameters

The strategy selection itself remains deterministic code. AI enhances inputs, not decisions.

---

## Key Assumptions to Validate

- [ ] **WebSocket stability**: Base RPC (Alchemy) supports stable WebSocket connections with swap event subscriptions. Test: subscribe to Aerodrome pool Swap events for 24 hours, measure reconnection frequency.
- [ ] **Quoter accuracy**: Uniswap V3 QuoterV2 `staticCall` returns prices within 5 bps of actual execution on Base. Test: compare quoter outputs vs real swap results across 50 transactions.
- [ ] **Balancer on Base**: Balancer V2 Vault is deployed on Base with sufficient liquidity for major pairs (WETH/USDC). Test: check Balancer docs or on-chain for Vault address on chain 8453.
- [ ] **AI latency budget**: Memecoin evaluation can tolerate 2-5 second LLM response time because new tokens remain tradeable for minutes/hours. Test: measure average memecoin opportunity window from first detection to liquidity drain.
- [ ] **PositionV2 extensibility**: Current contract can receive new execution paths without requiring full rewrite. Test: gas estimation for multi-provider flash loan callback routing.

## Technical Feasibility Assessment

| Enhancement | Feasibility | Difficulty | Estimated Effort | Risk Level |
|-------------|-------------|------------|------------------|------------|
| WebSocket event listeners | HIGH | Medium | 2-3 days | LOW — ethers.js v6 has native WebSocket support |
| Quoter pre-simulation | HIGH | Low | 1 day | LOW — direct copy of Trading Bot v3 pattern |
| Config-driven DEX registry | HIGH | Low | 0.5 days | LOW — JSON config + type-safe loader |
| Multi-provider flash loan router | MEDIUM | Medium-High | 3-5 days | MEDIUM — needs Balancer integration testing on Base fork |
| Strategy plugin architecture | MEDIUM | Medium | 2-3 days | MEDIUM — requires interface design but Eliza pattern is proven |
| AI memecoin safety scoring | MEDIUM | Medium | 2-3 days | LOW — latency-tolerant, can use any LLM provider |
| AI position management | LOW-MEDIUM | High | 5-7 days | HIGH — requires careful guardrails, potential for costly mistakes |
| AI market regime detection | LOW | High | 5-7 days | MEDIUM — needs training data and validation |

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MEV front-running still wins most arb opportunities | HIGH | MEDIUM | Use Flashbots Protect RPC; focus on less competitive pairs; accept that some opportunities are MEV-only |
| WebSocket disconnections miss events | MEDIUM | HIGH | Auto-reconnect with backoff; maintain polling as fallback; log missed blocks |
| Balancer V2 not deployed or illiquid on Base | MEDIUM | LOW | Check first; if unavailable, pillar 2 becomes Aave-only with planned Balancer addition |
| AI hallucination leads to bad memecoin trade | MEDIUM | HIGH | AI score is advisory only, not auto-executed; human confirms trades over configurable threshold |
| Gas estimation inaccuracy causes failed txs | LOW | HIGH | Add 20% gas buffer; pre-simulate via `eth_call`; track gas accuracy over time |
| Complexity from multi-provider routing introduces bugs | MEDIUM | MEDIUM | Extensive fork testing; start with single-provider, add second after core is stable |
| Over-engineering: too many pillars at once | HIGH | MEDIUM | Ship pillar 1 first (event-driven), validate, then pillar 2, then pillar 3 |

## MVP Scope

### In Scope (Phase 1 — Ship First)
1. WebSocket event listeners on Aerodrome CL/AMM and Uniswap V3 Swap events
2. Event-driven profitability pipeline (checkPrices → simulateViaQuoters → determineProfitability → execute)
3. Quoter-based pre-simulation via `staticCall` before execution
4. Config-driven DEX registry (`base-config.json`) with all addresses and fees
5. `isDeployed`/`monitorOnly` toggle for safe mainnet monitoring without execution

### In Scope (Phase 2 — After Phase 1 Validates)
6. Multi-provider flash loan router (Aave V3 + Balancer V2)
7. Strategy plugin interface (each strategy implements `scan()`, `evaluate()`, `execute()`)
8. AI memecoin safety scoring (LLM-enhanced token evaluation)

### In Scope (Phase 3 — After Phase 2 Validates)
9. AI position management advisor
10. Market regime detection
11. Memory-enhanced strategy selection (track which strategies work in which conditions)

### Not Doing (and Why)
- **LLM in arb execution path** — Latency kills. Arb opportunities on Base last <2s. No AI in the hot path.
- **Full Eliza agent framework integration** — Massive overkill. We need targeted AI features, not a full agent runtime.
- **Multi-chain support** — Focus on Base first. Multi-chain adds RPC complexity, different DEX addresses, different gas models. Later.
- **Social media trading signals** (Eliza has Twitter/Discord connectors) — Outside scope. We're building a trading engine, not a social bot.
- **Automated memecoin execution** — AI scores are advisory only. Memecoin trades require human confirmation until confidence metrics prove reliable.
- **PancakeSwap V3 integration** — Not deployed on Base. The template references it for Arbitrum, but Base uses Aerodrome/BaseSwap instead.
- **Real-time dashboard UI** — CLI dashboard is sufficient. A web UI is a separate project.

## Success Criteria

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Detection latency | <1 second from on-chain event to opportunity alert | Timestamp comparison: Swap event block vs scanner log |
| Failed transaction reduction | <5% of executed transactions fail (vs current estimate of ~15-20%) | Track tx receipts: success vs revert count |
| Opportunity capture rate | Detect >3x more arb opportunities than 15s polling | A/B test: event-driven vs polling over 24 hours |
| Flash loan cost optimization | Multi-provider routing saves >10% on fees in ≥20% of cases | Compare Aave-only fee vs best-provider fee per opportunity |
| AI memecoin accuracy | Safety score correlates with actual outcome >60% of the time | Backtest scores against tokens that later rug vs moon |
| System uptime | >99% over 7-day continuous run | Monitor reconnection events and missed blocks |
| Net profitability | System generates net positive P&L after all costs over 30 days | Track: gross profit - flash fees - gas - slippage |

## Open Questions

1. Is Balancer V2 Vault deployed on Base chain (8453)? If not, what alternatives exist beyond Aave V3 for flash loans?
2. What's the average duration of cross-DEX arb opportunities on Base? Sub-second? Multi-second? This determines whether any processing overhead is tolerable.
3. Does Alchemy's Base WebSocket support have rate limits that would constrain monitoring multiple pools simultaneously?
4. What's the current memecoin opportunity window on Aerodrome? Do tokens remain liquid for minutes or seconds after launch?
5. Should the AI memecoin scorer use on-chain data only, or also fetch social signals (Twitter mentions, Dexscreener boosted status)?

---

## Template Pattern Mapping

| Pattern | Source Template | Application in Flash Loan System |
|---------|----------------|-------------------------------|
| WebSocket event listeners | Trading Bot v3 (`pool.on('Swap', eventHandler)`) | Replace 15s polling in `opportunity-scanner.ts` |
| Quoter staticCall simulation | Trading Bot v3 (`quoter.quoteExactInputSingle.staticCall`) | Pre-trade validation in `arb-engine.ts` |
| Config-driven DEX registry | Trading Bot v3 (`config.json`) | Replace hardcoded addresses in `constants.ts` |
| Profitability pipeline | Trading Bot v3 (`checkPrice → determineDirection → determineProfitability → executeTrade`) | Refactor `ArbitrageEngine` method chain |
| isLocal/isDeployed toggle | Trading Bot v3 (`PROJECT_SETTINGS`) | Safe mainnet monitoring mode |
| Balancer flash loan callback | Masterclass (`receiveFlashLoan` pattern) | Alternative to Aave in `PositionV2.sol` |
| Struct-based params | Masterclass (`OpenParams`, `CloseParams`) | Already partially adopted in PositionV2.sol |
| Health factor enforcement | Masterclass (`require(getHealthFactor() > threshold)`) | Already present; add automated monitoring |
| Plugin/action architecture | Eliza (`actions`, `providers`, `evaluators`) | Strategy plugins with standard interface |
| Memory system | Eliza (`memory.search()`, `memory.create()`) | Trade outcome tracking for strategy learning |
| Model-agnostic provider | Eliza (multiple LLM support) | Swap between OpenAI/Anthropic/local for memecoin scoring |

---

*Generated: 2026-06-06 | Idea-Refine Phase 3 Output | Awaiting user review*
