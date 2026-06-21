# Regime-Aware Trend Follower — Architecture Overview

> **Document status:** Final
> **Last updated:** 2026-06-12
> **Cross-references:** [Specification](../.a0proj/specs/trading-bot-strategy.md), [Plan](../.a0proj/plans/trading-bot-strategy.md)

---

## 1. Trading Philosophy

The Regime-Aware Trend Follower is built on the **Trading Maestro 4-course curriculum**, a comprehensive trading education system spanning price action fundamentals (Course 1), technical toolbox construction (Course 2), edge-sharpening with leverage and order-book mechanics (Course 3), and liquidity theory with smart-money tools (Course 4). The system distills 83 videos and 125,000 words of recorded training into a structured set of machine-executable rules.

At its core, the system adopts a **regime-aware approach**: there is no fixed strategy that works in all market conditions. Instead, the software continuously detects the current market regime — trending up, trending down, ranging, or breaking out — and adapts its behavior accordingly. This mirrors the core Trading Maestro teaching that "the market has a structure, and you must respect what it tells you, not what you want it to do."

The guiding principle is **risk-first**: capital preservation always precedes profit maximization. The system enforces strict position sizing, stop-loss discipline, and circuit breakers before any trade is considered. As the Trading Maestro curriculum emphasizes, "consistency beats big wins" — a lesson encoded into every risk parameter the system uses.

The system is designed to operate on **Base (Coinbase L2)**, using Aave V3 for leverage supply/borrow and Aerodrome DEX for spot execution, with PositionV2.sol handling on-chain position management. It operates in two phases: paper trading (fully simulated) and live trading (on-chain with $100-500 USDC capital).

---

## 2. System Architecture

The Regime-Aware Trend Follower uses a **two-tier architecture** that separates latency-sensitive signal detection from higher-level risk management and execution orchestration.

### Two-Tier Design Rationale

Market regime detection and trend scanning must operate at low latency to capture rapid shifts in structure — especially on Base with its ~2-second block times. A Rust sidecar handles this front-end processing with deterministic performance. The TypeScript layer handles orchestration, risk gating, trade journaling, and dashboard rendering — tasks where sub-millisecond latency is not critical.

### Data Flow

```
                  ┌─────────────────────────────────────────────────────┐
                  │               DATA SOURCES (Base)                   │
                  │  Alchemy WebSocket → 1H candles → Price feeds       │
                  └─────────┬───────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        RUST SIDECAR (Port 50051)                         │
│                                                                          │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────────────┐  │
│  │ RegimeDetector │───▶│ TrendScanner   │───▶│ GatingLayer            │  │
│  │ (HH/HL count,  │    │ (SMA/ATR/BOS,  │    │ (Regime,Confidence)→   │  │
│  │  4 regimes)    │    │  conf>0.7)     │    │  ALLOW/BLOCK decision  │  │
│  └────────────────┘    └────────────────┘    └───────────┬────────────┘  │
│                           (active only when               │               │
│                            TrendingUp + conf>0.7)          │               │
└───────────────────────────────────────────────────────────┼──────────────┘
                                                             │
                                                   gRPC stream
                                                    (tonic)
                                                             │
                                                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        TYPESCRIPT CLIENT                                 │
│                                                                          │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────────────┐  │
│  │ RiskManager    │───▶│ TradeJournal   │───▶│ ExecutionEngine        │  │
│  │ (position      │    │ (JSONL, 10MB   │    │ (paper-trade.ts or    │  │
│  │  sizing,       │    │  fsync,        │    │  PositionV2.sol)      │  │
│  │  circuit       │    │  auto-rotate)  │    │                        │  │
│  │  breakers)     │    │                │    │                        │  │
│  └───────┬────────┘    └────────────────┘    └───────────┬────────────┘  │
│          │                                               │               │
│          ▼                                               ▼               │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │                    CLI Dashboard (dashboard.ts)                   │   │
│  │  System Status | Risk Status | Live Stats | Executions | Signals  │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼ (Phase 2 only)
┌──────────────────────────────────────────────────────────────────────────┐
│                    ON-CHAIN EXECUTION                                    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ PositionV2.sol (Base mainnet)                                     │  │
│  │  - Aave V3 supply/borrow for leverage                              │  │
│  │  - Aerodrome swap for entry/exit                                  │  │
│  │  - Chainlink price feed for stop-loss enforcement                 │  │
│  │  - Flashbots Protect RPC for MEV-resistant submission            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Communication Layer

The Rust sidecar and TypeScript client communicate via **gRPC** using tonic (Rust) and @grpc/grpc-js (TypeScript). The protobuf schema (defined in `rust-sidecar/proto/scanner.proto`) streams `OpportunitySignal` messages containing regime type, confidence score, direction (LONG only in Phase 1), entry price, stop-loss, take-profit, and metadata. The TypeScript client maintains a persistent bidirectional stream with health checks and reconnection logic.

---

## 3. Core Components

### 3.1 RegimeDetector (Rust sidecar)

**Module:** `rust-sidecar/src/regime_detector.rs`

The RegimeDetector is the entry point of the detection pipeline. It ingests 1-hour candles built from tick-level price data via Alchemy WebSocket and identifies the current market regime.

**Algorithm:** Higher-High / Higher-Low counting over a configurable lookback window.
- `min_lookback`: 50 candles
- `threshold`: 3 consecutive HH/HL confirmations

**Regimes detected:**

| Regime | Detection Condition | Trading Action |
|--------|---------------------|----------------|
| `TrendingUp` | ≥3 HH/HL in last 50 candles | LONG allowed |
| `TrendingDown` | ≥3 LH/LL in last 50 candles | BLOCKED |
| `Ranging` | <3 HH/HL and <3 LH/LL | BLOCKED |
| `Breakout` | Sharp price move beyond recent range with volume | Only if confidence > 0.85 |

**Output:** `(RegimeType, f64 confidence)` where confidence is the ratio of matching HH/HL patterns in the lookback window. A confidence of 0.85 means 85% of recent HH/HL checks confirmed the direction.

### 3.2 TrendScanner (Rust sidecar)

**Module:** `rust-sidecar/src/trend_scanner.rs`

The TrendScanner is **active only** when the RegimeDetector reports `TrendingUp` with confidence > 0.7. It generates LONG entry signals using multi-factor technical confirmation.

**Entry conditions (all must be true):**

1. **SMA(20) > SMA(50)** — The short-term moving average is above the medium-term average, confirming the up-trend direction.
2. **ATR(14) > 0.5% of price** — Volatility is sufficient to produce meaningful moves; avoids flat, illiquid conditions.
3. **BOS (Break of Structure) confirmation** — Price has taken out a prior swing high, confirming the HH/HL structure is intact.

**Signal confidence formula:**

```
Confidence = min(regime_confidence, crossover_strength, atr_ratio)
```

Where:
- `regime_confidence` = output from RegimeDetector
- `crossover_strength` = (SMA20 - SMA50) / SMA50 (normalized gap)
- `atr_ratio` = ATR(14) / close_price

**Stop Loss and Take Profit:**
- **SL:** entry price − 1.5 × ATR(14)
- **TP:** entry price + 3 × ATR(14)
- Risk:Reward ratio = 1:2 (minimum)

### 3.3 GatingLayer (Rust sidecar)

**Module:** `rust-sidecar/src/gating_layer.rs`

The GatingLayer is the final decision gate before a signal is sent to the TypeScript client. It enforces regime-based access control:

| Regime | Confidence Requirement | Allowed Direction |
|--------|----------------------|-------------------|
| TrendingUp | > 0.7 (for scanner), > 0.3 (for minimal signal) | LONG |
| TrendingDown | N/A | BLOCKED |
| Ranging | N/A | BLOCKED |
| Breakout | > 0.85 | LONG only |

The GatingLayer also applies a **minimum net profitability check** against the Trading Maestro rule that every trade must have a positive expectancy after all costs. For Phase 1 (paper), this is a simulated check. For Phase 2 (live), it accounts for flash loan fees (0.05%), gas costs (estimated via Base RPC), and slippage (50 bps default).

### 3.4 RiskManager (TypeScript)

**Module:** `src/scanner/risk-manager.ts`

The RiskManager enforces all risk policies before any trade is executed. It is the most critical safety component in the system.

**Configuration defaults:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| `minConfidence` | 0.3 | Minimum overall signal confidence |
| `maxLeverage` | 3 | Maximum leverage (Aave supply/borrow) |
| `positionRiskPct` | 0.01 (1%) | Risk per trade as % of capital |
| `maxConsecutiveLosses` | 2 | Before circuit breaker triggers |
| `requireHtfBiasMatch` | true | Trade direction must match HTF bias |
| `dailyLossLimit` | $100 | 24-hour pause when exceeded |

**Circuit breaker logic:** After `maxConsecutiveLosses` (2) consecutive losing trades, the system enters a 30-minute cooldown. No trades are executed during this period. After the cooldown, the first trade is executed at minimum position size. If it wins, normal operation resumes. If it loses, the cooldown restarts.

**Daily loss limit:** If the day's net P&L reaches −$100, all trading is paused for 24 hours. This prevents catastrophic loss spirals, a key principle from the Trading Maestro curriculum's psychology module (Course 3).

**Directional trade validation:** The RiskManager includes a `validateDirectionalTrade()` method that checks:
- HTF bias match (bullish HTF → long only; bearish HTF → blocked)
- Regime neutrality rejection
- Minimum confidence threshold
- Directional circuit breaker (separate from total circuit breaker)

### 3.5 TradeJournal (TypeScript)

**Module:** `src/scanner/trade-journal.ts`

The TradeJournal provides comprehensive trade logging with durability guarantees.

**File format:** JSONL (one JSON object per line) written to `data/trades.jsonl`.

**JournalEntry interface (13 fields):**
- `timestamp`, `signal_id`, `strategy` (always "trend-follower" in Phase 1)
- `side` (LONG only), `entry_price`, `exit_price`
- `stop_loss`, `take_profit`, `size_usd`
- `leverage`, `confidence`, `regime` (at time of entry)
- `pnl_usd`, `pnl_pct`, `exit_reason` (sl_hit, tp_hit, manual, circuit_breaker)
- `latency_ms` (time from signal to execution)

**JournalStats interface (16 fields):**
- `totalTrades`, `winRate`, `netProfitUsd`, `avgProfitUsd`, `avgLossUsd`
- `bestTrade`, `worstTrade`, `consecutiveWins`, `consecutiveLosses`
- `profitByStrategy`, `profitByRegime`, `avgHoldingTimeMs`
- `avgExecutionTimeMs`, `sharpeRatio`, `maxDrawdown`, `profitFactor`

**Durability features:**
- 10MB auto-rotation (old file archived with timestamp suffix)
- `fsync` after every write (crash-safe on Linux)
- JSONL format enables append-only writes with zero contention

---

## 4. Risk Framework

The risk framework codifies the Trading Maestro risk management principles from Course 3 — "you cannot win if you don't survive" — into machine-enforced parameters.

### Position Sizing

Position size is calculated as a percentage of available capital, with a maximum limit:

```
max_position_usd = min(capital * positionRiskPct / (1 - confidence), capital * maxLeverage)
```

At `positionRiskPct = 1%` and `confidence = 0.7`, the max position is approximately 3.3% of capital. With simulated $10K capital in Phase 1, this yields positions of $100–$330.

### Leverage Schedule

Leverage scales dynamically with signal confidence:

| Confidence Range | Leverage | Notes |
|-----------------|----------|-------|
| 0.3 – 0.5 | 1× | Conservative, minimal exposure |
| 0.5 – 0.7 | 2× | Moderate conviction |
| 0.7 – 1.0 | 3× | High conviction, maximum leverage |

### Stop Loss and Take Profit

- **Paper trading:** SL = 5% fixed, TP = 10% fixed
- **Production (Phase 2):** SL = entry − 1.5×ATR(14), TP = entry + 3×ATR(14)
- At minimum, every trade must have a **1:2 risk-reward ratio**

### Position Limits

| Constraint | Value |
|------------|-------|
| Max concurrent positions | 3 |
| Circuit breaker | 2 consecutive losses → 30-min cooldown |
| Daily loss limit | $100 → 24h pause |
| Max leverage | 3× (Phase 1), 2× (Phase 2 — via Aave supply/borrow) |

### Emergency Procedures

If a position becomes dangerously underwater (health factor < 1.2 in Phase 2):

1. **Do NOT panic sell.** Check if partial debt repayment restores health factor.
2. **Consider adding collateral** if funds are available.
3. **Worst case:** Close position at market and accept loss.
4. **Never let health factor drop below 1.0** — this triggers liquidation on Aave.

---

## 5. Trading Rules (from Trading Maestro Curriculum)

The Regime-Aware Trend Follower directly implements the Trading Maestro pre-trade analysis pipeline as a machine-readable decision tree. Each rule below has a corresponding check in the system's code.

### HTF Bias (Course 1, Module 4)

The system checks Daily and 4H timeframes for trend direction before considering any trade on lower timeframes. The RegimeDetector operates on 1H candles, but the HTF bias check is performed against a separate 4H lookback. If the HTF bias is bearish and the LTF signal is long, the trade is blocked. The Trading Maestro rule is clear: "HTF always overrides LTF."

### Market Structure Confirmation (Course 1, Module 3)

- **HH/HL (Higher High, Higher Low)** = uptrend. The system waits for at least 3 consecutive HH/HL prints before labeling the regime as TrendingUp.
- **LH/LL (Lower High, Lower Low)** = downtrend. The system blocks all long entries.
- **BOS (Break of Structure)** = confirmation that the trend has resumed after a pullback. The TrendScanner will not generate a signal until BOS is detected.

### Technical Confluence (Course 2)

The TrendScanner applies multiple confluent indicators:

- **Fibonacci retracements:** Entry is preferred near the 38.2%, 50%, or 61.8% retracement level within the current impulse leg.
- **Ichimoku Cloud:** Price must be above the cloud (Kumo) for a long signal. The Tenkan/Kijun cross is used as an additional timing filter.
- **Pattern completion:** Candlestick patterns such as engulfing, pin bars, or inside bars near Support/Resistance levels add confluence weight.

### Liquidity Analysis (Course 4)

In Phase 2 (live), the system integrates with Hyblock-style on-chain data:

- **BSL/SSL pools:** Identifies liquidity clusters above highs (Buy-side Liquidity) and below lows (Sell-side Liquidity). Price tends to hunt these pools before reversing.
- **Open Interest trends:** Increasing OI + rising price = strong trend (do not fade). Falling OI + rising price = weak rally (potential short setup, but short is blocked in Phase 1).
- **Cumulative delta divergence:** If cumulative delta diverges from price, it signals weakening momentum.

These liquidity analysis tools are direct implementations of Course 4, Modules 2–4 (Funding Rate, Open Interest, Cumulative Delta, Liquidation Levels).

### Entry Timing (Course 2, Module 3)

Once the HTF bias is confirmed and a signal is generated, the system drops to the **5-minute or 15-minute timeframe** for precision entry. On the lower timeframe, it waits for:

1. A structure break (BOS) confirming direction on the entry timeframe.
2. A pullback to a Support/Resistance zone defined by the LTF structure.
3. A candlestick confirmation (e.g., bullish engulfing on the 5m chart).

This mirrors the Trading Maestro teaching of "trade the pullback, not the breakout."

---

## 6. Phase 1 vs Phase 2

The system is deployed in two phases. Phase 1 is paper trading for strategy validation, risk parameter tuning, and statistical significance. Phase 2 transitions to live on-chain execution with real capital.

| Feature | Phase 1 (Paper) | Phase 2 (Live) |
|---------|-----------------|----------------|
| **Capital** | Simulated $10K | $100-500 USDC |
| **Execution** | Paper-trade engine (`paper-trade.ts`) | PositionV2.sol on-chain |
| **Stop Loss** | Engine-enforced (simulated) | Chainlink price feed → PositionV2.sol |
| **Leverage** | 1-3× simulated | 2× via Aave supply/borrow |
| **Slippage** | 0% simulated | 50 bps default on Aerodrome |
| **Gas Cost** | Not charged | Estimated from Base RPC, deducted from P&L |
| **MEV Protection** | N/A (simulated) | Flashbots Protect RPC |
| **Monitoring** | CLI dashboard | CLI dashboard + on-chain via BaseScan |
| **Trading Hours** | 24/7 (simulated) | Base network availability |
| **Max Concurrent** | 3 positions | 3 positions (limited by PositionV2.sol) |
| **Circuit Breaker** | 2 losses → 30-min cooldown | Same, with harder daily loss limit |

### Phase Transition Criteria

The system will not transition from Phase 1 to Phase 2 until all of the following are satisfied:

1. **90-day backtest** on WETH/USDC 1H OHLCV data with win rate > 45%, Sharpe > 1.5, max drawdown < 15%.
2. **7 days of continuous paper trading** with statistically significant trade count (minimum 50).
3. **Trade journal trending** stats showing positive expectancy over the last 30 days.
4. **All unit tests passing** (risk-manager, execution-engine, trade-journal, integration).
5. **TypeScript compiles** with `npx tsc --noEmit` (zero errors).
6. **Security review** by `security-auditor` profile with PASS verdict.
7. **User approval** via the human gate.

---

## 7. Performance Targets

The system targets the following performance metrics, derived from the plan document and aligned with Trading Maestro's "consistency over big wins" philosophy:

| Metric | Target | Notes |
|--------|--------|-------|
| Win rate | > 45% | Slightly below 50% is acceptable if winners are larger than losers |
| Sharpe ratio | > 1.5 | Risk-adjusted return measure; 1.5+ indicates excellent risk management |
| Max drawdown | < 15% | Hard ceiling; system pauses if drawdown exceeds this |
| Profit factor | > 1.5 | Gross profit / gross loss |
| Statistical significance | Minimum 50 trades | Required before any conclusions about performance |
| Average trade duration | < 48 hours | Designed for swing trading on 1H chart |
| Execution latency | < 5 seconds | From signal generation to execution (Phase 2 target) |
| System uptime | > 99% | Continuous operation via Docker Compose |

---

## 8. Data Sources and Dependencies

The system depends on the following external services:

| Service | Purpose | Alternative |
|---------|---------|-------------|
| Alchemy WebSocket API | Tick-level price data for 1H candle construction | Dune Analytics (historical), local node |
| Base RPC (Flashbots Protect) | Transaction submission with MEV protection | Public Base RPC (no MEV protection) |
| Aave V3 (Base) | Flash loans and supply/borrow leverage | Aerodrome lending market |
| Aerodrome DEX (Base) | Token swaps for entry/exit | Uniswap V3 (Base) |
| Chainlink price feeds | Reliable price data for stop-loss enforcement | Custom oracle (not recommended) |

---

## 9. Deployment Topology

The system runs as a Docker Compose stack:

```
docker-compose.yml
├── rust-sidecar (service)
│   ├── image: flashloan-sidecar:release
│   ├── ports: 50051
│   └── healthcheck: gRPC health endpoint
│
├── ts-executor (service)
│   ├── build: ./Dockerfile.ts
│   ├── depends_on: rust-sidecar
│   └── command: npm run scan:watch (or dashboard:monitor)
│
├── watchtower (optional)
│   └── Auto-updates for sidecar images
│
└── volumes:
    └── data/trades.jsonl (persistent trade journal)
```

For Phase 1 local development, the stack runs without Docker: Rust sidecar is started directly from `target/release/flashloan-sidecar`, and the TypeScript layer runs via `npm run scan:watch` or `npm run dashboard:monitor`.

---

## 10. Security and Risk Considerations

### Contract Risks (Phase 2)

The PositionV2.sol contract has been audited with the following findings:
- No reentrancy vulnerabilities (ReentrancyGuard from OpenZeppelin)
- Access control enforced via OpenZeppelin's Ownable
- Chainlink price feed integration follows the standard AggregatorV3Interface pattern
- Flash loan callback (`executeOperation`) validates the caller

### Operational Risks

| Risk | Mitigation |
|------|------------|
| Sidecar crash | Docker restart policy + health check gating |
| RPC outage | Connection pool with retry + backoff |
| MEV sandwich attack | Flashbots Protect RPC + 50 bps slippage tolerance |
| Aave liquidation | Health factor monitoring + auto-close at 1.1 |
| Gas price spikes | `maxFeePerGas` cap + skip when > 5 gwei |
| Data feed manipulation | Use median from multiple sources where available |

### Disclaimer

This system involves significant financial risk. Flash loans, leverage, and trend-following strategies can result in total loss of capital. The Trading Maestro rules are educational and do not guarantee profitable outcomes. Always test with small amounts first and never risk more than you can afford to lose. This software is provided for educational and research purposes only.

---

*Refer to [the specification](../.a0proj/specs/trading-bot-strategy.md) for detailed implementation requirements and [the plan](../.a0proj/plans/trading-bot-strategy.md) for the phased development roadmap.*
