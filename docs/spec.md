# Spec: FlashLoan Base — Rust Sidecar + Live Trading System

**Status:** DRAFT — Awaiting review  
**Date:** 2026-06-05  
**Author:** Agent Zero (Master Developer)  

---

## Objective

Extend the existing flashloan-base system (TypeScript scanners + Solidity contracts on Base chain) with a **Rust sidecar** for sub-5ms opportunity detection and a **live execution pipeline** for real flash loan trades starting at $100-200 micro-executions.

The system detects arbitrage opportunities across Aerodrome CL, Uniswap V3, and Aerodrome AMM on Base (Chain ID 8453), validates profitability after all costs, and executes via the existing PositionV2.sol contract — which already supports cross-DEX arb (`ArbParams`) and triangle arb (`TriangleParams`).

**User:** Solo DeFi trader running automated strategies.  
**Success:** First profitable live trade executed with net > $0.10 after all costs, detected within a 200ms Flashblock window, with full safety gate coverage.

---

## A. System Architecture

### Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose Network                    │
│                                                              │
│  ┌──────────────────┐         ┌──────────────────────────┐  │
│  │   Rust Sidecar   │  gRPC   │   TypeScript Core        │  │
│  │   (Detection)    │────────▶│   (Execution + UI)       │  │
│  │                  │ :50051  │                          │  │
│  │  • price-feed    │         │  • grpc-client           │  │
│  │  • triangle-scan │         │  • execution-engine      │  │
│  │  • cross-dex     │         │  • risk-manager          │  │
│  │  • memecoin-proc │         │  • trade-journal         │  │
│  │  • grpc-server   │         │  • dashboard             │  │
│  └──────────────────┘         └──────────────────────────┘  │
│          │                            │                      │
│     WebSocket                  ethers.js v6                  │
│     (Alchemy)                  (Alchemy RPC)                 │
│          │                            │                      │
│          ▼                            ▼                      │
│     Base Chain (8453)          PositionV2.sol                │
│     • Aerodrome CL             • executeFlashArb()           │
│     • Uniswap V3               • executeTriangleArb()        │
│     • Aerodrome AMM            • Aave V3 flash loans         │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Language | Role | Process |
|-----------|----------|------|---------|
| Rust Sidecar | Rust 1.80+ | Price aggregation, opportunity detection, signal emission | Binary, always-on |
| TypeScript Core | Node 22+ | Signal reception, safety checks, contract execution, UI | tsx process |
| PositionV2.sol | Solidity 0.8.28 | On-chain flash loan execution | Deployed contract |

### Latency Budget (within 200ms Flashblock)

| Stage | Component | Target | Max |
|-------|-----------|--------|-----|
| WebSocket receive + parse | Rust | 0.1ms | 0.5ms |
| Price book update | Rust | 0.1ms | 0.3ms |
| Triangle path scan | Rust | 0.5ms | 2.0ms |
| Profit check + signal | Rust | 0.2ms | 0.5ms |
| gRPC send | Rust→TS | 0.3ms | 1.0ms |
| Risk gate + TX build | TS | 2.0ms | 5.0ms |
| Sign + send to RPC | TS | 1.0ms | 3.0ms |
| **Total detection-to-sent** | | **4.2ms** | **12.3ms** |
| Sequencer inclusion | Base | 50ms | 200ms |

### Communication Protocol

- **gRPC server-streaming** from Rust sidecar to TypeScript core
- Rust sends `OpportunitySignal` messages as they are detected
- TypeScript sends `ExecutionResult` back via unary calls
- Protobuf definitions in `rust-sidecar/proto/signal.proto`

---

## B. Rust Sidecar Modules

### B.1 price-feed

**Purpose:** Subscribe to real-time price updates from Aerodrome CL, Uniswap V3, and Aerodrome AMM via WebSocket. Maintain an in-memory price book updated in <1ms.

**Inputs:**
- Alchemy WebSocket subscriptions for `Swap` events on known pool addresses
- Pool configurations from `pools.toml` (static file, hot-reloadable)

**Outputs:**
- Updates to the shared `PriceBook` (in-memory, concurrent)
- `PriceUpdate` events published to internal broadcast channel

**Data Structures:**

```rust
/// A single price quote for a token pair at a specific pool
#[derive(Debug, Clone)]
pub struct PoolQuote {
    pub pool_address: Address,       // alloy::primitives::Address
    pub dex: DexType,                // AeroCL | UniV3 | AeroAMM
    pub token_in: Address,
    pub token_out: Address,
    pub amount_out: U256,            // alloy::primitives::U256
    pub fee_bps: u32,                // Pool fee in basis points
    pub liquidity: u128,             // Available liquidity (for sizing)
    pub timestamp_ms: u64,           // When this quote was computed
    pub block_number: u64,
}

/// In-memory price book: concurrent, lock-free reads
pub struct PriceBook {
    /// (token_in, token_out, dex, pool_fee) → latest quote
    quotes: DashMap<(Address, Address, DexType, u32), PoolQuote>,
    /// Known token metadata
    tokens: HashMap<Address, TokenMeta>,
    /// Last update timestamp for staleness detection
    last_update: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DexType {
    AerodromeCL,
    UniswapV3,
    AerodromeAMM,
}

#[derive(Debug, Clone)]
pub struct TokenMeta {
    pub address: Address,
    pub symbol: String,
    pub decimals: u8,
}
```

**Algorithms:**
1. Connect to Alchemy WebSocket (`wss://base-mainnet.g.alchemy.com/v2/{key}`)
2. Subscribe to `logs` for Swap event signatures across all tracked pools
3. Parse Swap events using `simd-json` (2-4 GB/s parsing)
4. Compute new price from swap amounts: `price = amount_out / amount_in`
5. Update `PriceBook` via `DashMap::insert`
6. Broadcast `PriceUpdate` on `tokio::sync::broadcast` channel
7. If WebSocket disconnects, reconnect with exponential backoff (100ms, 200ms, 400ms, max 5s)

**Performance Requirements:**
- Parse + update price book in < 0.5ms per event
- Handle 1000+ events/second sustained
- Staleness detection: flag any quote older than 5 seconds as stale

**Error Handling:**
- WebSocket disconnect → reconnect with backoff, log error, emit `HealthStatus::Degraded`
- Malformed event → skip, increment `parse_errors` counter, continue
- Price book full → evict oldest entries (LRU)

**Configuration (`pools.toml`):**
```toml
[[pool]]
address = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
dex = "AerodromeCL"
token_a = { address = "0x4200000000000000000000000000000000000006", symbol = "WETH", decimals = 18 }
token_b = { address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol = "USDC", decimals = 6 }
fee_bps = 3000

[[pool]]
address = "0x2626664c2603336E57B271c5C0b26F421741e481"
dex = "UniswapV3"
token_a = { address = "0x4200000000000000000000000000000000000006", symbol = "WETH", decimals = 18 }
token_b = { address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol = "USDC", decimals = 6 }
fee_bps = 3000
```

---

### B.2 triangle-scanner

**Purpose:** Continuously scan the price book for profitable 3-hop arbitrage paths (tokenA → tokenB → tokenC → tokenA). Emit signals when net profit exceeds the minimum threshold after all costs.

**Inputs:**
- `PriceBook` (shared reference)
- `PriceUpdate` broadcast channel subscription
- Configuration: min profit threshold, fee schedule, gas estimate

**Outputs:**
- `OpportunitySignal` messages sent via gRPC (when profitable)

**Data Structures:**

```rust
#[derive(Debug, Clone)]
pub struct TrianglePath {
    pub hops: [Hop; 3],
    pub gross_profit_usd: f64,
    pub net_profit_usd: f64,
    pub flash_loan_fee_usd: f64,
    pub gas_cost_usd: f64,
    pub optimal_amount_in: f64,
    pub confidence: f64,  // 0.0-1.0 based on liquidity depth
}

#[derive(Debug, Clone)]
pub struct Hop {
    pub token_in: Address,
    pub token_out: Address,
    pub pool_address: Address,
    pub dex: DexType,
    pub pool_fee_bps: u32,
    pub expected_amount_out: U256,
}
```

**Algorithms:**
1. Build a directed graph of all token pairs with edges weighted by exchange rate
2. Use `petgraph` to enumerate all 3-edge cycles in the graph
3. For each cycle, compute:
   - `gross_profit = amount_out_after_hop3 - amount_in`
   - `flash_fee = amount_in * 0.0005` (Aave V3 0.05%)
   - `gas_cost = 300000 * gas_price * eth_price` (estimated 300k gas for triangle arb)
   - `slippage_buffer = amount_in * 0.001` (10 bps conservative slippage)
   - `net_profit = gross_profit - flash_fee - gas_cost - slippage_buffer`
4. Skip if `net_profit < $0.10` or `spread < 15 bps`
5. Compute optimal input amount: iterate over $100, $200, $500, $1000, $2000 and pick the one with highest expected net profit
6. Score confidence based on: liquidity depth in each hop, quote freshness (< 500ms old = high), historical hit rate for this path
7. Emit `OpportunitySignal` only if confidence > 0.5

**Profit Calculation (concrete example):**
```
Input: 1000 USDC
Hop 1: USDC → WETH via AeroCL (0.3% fee) → get 0.2985 WETH
Hop 2: WETH → DAI via UniV3 (0.05% fee) → get 1004.5 DAI  
Hop 3: DAI → USDC via AeroAMM (0.01% fee) → get 1003.8 USDC

Gross profit: 1003.8 - 1000 = $3.80
Flash fee: 1000 * 0.0005 = $0.50
Gas cost: 300000 * 0.000000001 * $2500 = $0.00075 (Base is cheap)
Slippage buffer: 1000 * 0.001 = $1.00
Net profit: $3.80 - $0.50 - $0.00075 - $1.00 = $2.29
Spread: 38 bps > 15 bps minimum ✓
Net > $0.10 ✓
→ EMIT SIGNAL
```

**Performance Requirements:**
- Full graph scan in < 2ms (target ~20 token nodes, ~60 edges)
- Triggered rescan on price update in < 1ms
- Zero allocations in hot path (pre-allocate path buffers)

**Error Handling:**
- Stale quote in path → discard path, don't emit
- Insufficient liquidity for optimal size → reduce size, recalculate
- Graph too large → limit to top-20 tokens by volume

---

### B.3 cross-dex-scanner

**Purpose:** Compare prices for identical token pairs across Aerodrome and Uniswap V3. Detect cross-DEX arbitrage when the price difference exceeds costs.

**Inputs:**
- `PriceBook` (shared reference)
- Same configuration as triangle-scanner

**Outputs:**
- `OpportunitySignal` with `signal_type = CROSS_DEX_ARB`

**Data Structures:**

```rust
#[derive(Debug, Clone)]
pub struct CrossDexOpportunity {
    pub token_in: Address,
    pub token_out: Address,
    pub buy_dex: DexType,
    pub buy_pool: Address,
    pub buy_price: f64,
    pub sell_dex: DexType,
    pub sell_pool: Address,
    pub sell_price: f64,
    pub spread_bps: u32,
    pub optimal_amount_usd: f64,
    pub net_profit_usd: f64,
    pub confidence: f64,
}
```

**Algorithms:**
1. For each token pair in the price book that has quotes on two different DEXes:
2. Compute `spread_bps = |sell_price - buy_price| / buy_price * 10000`
3. Skip if `spread_bps < 15` (minimum viable spread)
4. Calculate net profitability:
   - `buy_fee = buy_pool_fee` + `sell_fee = sell_pool_fee`
   - `flash_fee = 5 bps` (Aave V3)
   - `gas = 250000 * gas_price * eth_price` (estimated 250k gas for cross-DEX)
   - `slippage = 10 bps` per swap
   - `net = spread - buy_fee - sell_fee - flash_fee - slippage - gas`
5. Skip if `net_profit_usd < 0.10`
6. Emit signal with the cheaper DEX as buy, more expensive as sell

**Performance Requirements:**
- Scan all cross-DEX pairs in < 1ms
- Re-evaluate on each price update

---

### B.4 memecoin-processor

**Purpose:** Monitor new token launches on Aerodrome, detect pump patterns, and score memecoin opportunities for the TypeScript `memecoin-hunter.ts` to evaluate further.

**Inputs:**
- Aerodrome factory events (new pair creation) via WebSocket
- Price and volume data from the price feed
- External signals from `degen-alpha-scout` Agent Zero profile

**Outputs:**
- `MemecoinSignal` messages via gRPC

**Data Structures:**

```rust
#[derive(Debug, Clone)]
pub struct MemecoinSignal {
    pub token_address: Address,
    pub pair_address: Address,
    pub token_symbol: String,
    pub initial_price_usd: f64,
    pub volume_5m_usd: f64,
    pub price_change_5m_pct: f64,
    pub liquidity_usd: f64,
    pub holder_count: u32,
    pub risk_score: u8,        // 1-10 (10 = highest risk)
    pub pump_score: f64,       // 0.0-1.0
    pub whale_activity: bool,  // Large buys detected
}
```

**Algorithms:**
1. Subscribe to Aerodrome Factory `PairCreated` events
2. For each new pair:
   a. Fetch initial token metadata (symbol, decimals, total supply)
   b. Start tracking price via WebSocket
   c. After 60 seconds, compute initial metrics (volume, price change, liquidity)
   d. Score: `pump_score = f(volume_acceleration, holder_growth, price_momentum)`
   e. Score: `risk_score = f(contract_age, liquidity_lock, holder_concentration, honeypot_probability)`
   f. Emit signal if `pump_score > 0.6` AND `risk_score < 5`
3. Skip tokens where `risk_score >= 7` (likely rug/honeypot)

**Safety:**
- Never auto-execute memecoin trades (requires manual confirmation in Phase 3)
- Always route through `onchain-analyzer` for contract safety check before signal

**Performance Requirements:**
- Process new pair event in < 100ms (non-latency-critical)
- Track up to 50 active memecoin pairs simultaneously

---

### B.5 grpc-server

**Purpose:** Expose detected opportunities to the TypeScript core via gRPC server-streaming.

**Protobuf Definitions:**

```protobuf
syntax = "proto3";

package flashloan;

service OpportunityService {
  // Server-streaming: Rust pushes opportunities as they appear
  rpc StreamOpportunities(StreamRequest) returns (stream OpportunitySignal);
  
  // Unary: TS reports execution results back
  rpc ReportExecution(ExecutionResult) returns (ExecutionAck);
  
  // Unary: TS requests current health/status
  rpc GetHealth(HealthRequest) returns (HealthStatus);
}

message StreamRequest {
  repeated SignalType signal_types = 1;
  double min_profit_usd = 2;       // Filter: minimum net profit
  uint32 min_confidence_bps = 3;   // Filter: minimum confidence (0-10000)
}

enum SignalType {
  SIGNAL_TYPE_UNSPECIFIED = 0;
  TRIANGLE_ARB = 1;
  CROSS_DEX_ARB = 2;
  MEMECOIN = 3;
}

message OpportunitySignal {
  string signal_id = 1;             // UUID v4
  SignalType signal_type = 2;
  uint64 timestamp_ms = 3;
  double confidence = 4;           // 0.0-1.0
  double net_profit_usd = 5;
  double optimal_amount_usd = 6;
  uint32 spread_bps = 7;
  
  oneof details {
    TriangleDetails triangle = 10;
    CrossDexDetails cross_dex = 11;
    MemecoinDetails memecoin = 12;
  }
}

message TriangleDetails {
  repeated HopDetail hops = 1;     // Exactly 3 hops
  double gross_profit_usd = 2;
  double flash_fee_usd = 3;
  double gas_cost_usd = 4;
  double slippage_buffer_usd = 5;
}

message HopDetail {
  string token_in = 1;             // Checksummed address
  string token_out = 2;
  string pool_address = 3;
  string dex_type = 4;             // "AeroCL" | "UniV3" | "AeroAMM"
  uint32 pool_fee_bps = 5;
  string expected_amount_out = 6;  // Decimal string (no precision loss)
}

message CrossDexDetails {
  string token_in = 1;
  string token_out = 2;
  string buy_dex = 3;
  string buy_pool_address = 4;
  string sell_dex = 5;
  string sell_pool_address = 6;
  double buy_price = 7;
  double sell_price = 8;
}

message MemecoinDetails {
  string token_address = 1;
  string pair_address = 2;
  string token_symbol = 3;
  double pump_score = 4;
  uint32 risk_score = 5;
  double volume_5m_usd = 6;
  bool whale_activity = 7;
}

message ExecutionResult {
  string signal_id = 1;
  bool executed = 2;
  bool success = 3;
  string tx_hash = 4;              // Empty if not executed
  double actual_profit_usd = 5;
  double actual_gas_usd = 6;
  string error_message = 7;
}

message ExecutionAck {
  bool received = 1;
}

message HealthRequest {}

message HealthStatus {
  bool healthy = 1;
  uint64 uptime_seconds = 2;
  uint64 signals_emitted = 3;
  uint64 price_updates_received = 4;
  uint32 active_pools_tracked = 5;
  uint64 last_signal_ms = 6;
  string version = 7;
}
```

**gRPC Server Configuration:**
- Listen on `0.0.0.0:50051` (configurable via `GRPC_PORT` env)
- Max message size: 4 MB
- Keepalive: 30s ping, 60s timeout
- Graceful shutdown on SIGTERM

**Reconnection Handling:**
- If TypeScript client disconnects, buffer last 100 signals in memory
- On reconnect, replay missed signals (within 30s window)
- Beyond 30s, discard old signals and send fresh stream

---

## C. TypeScript Core Extensions

### C.1 grpc-client

**File:** `src/scanner/grpc-client.ts`  
**Purpose:** Connect to Rust sidecar, receive opportunity signals, dispatch to execution engine.

```typescript
export interface OpportunitySignal {
  signalId: string;
  signalType: 'TRIANGLE_ARB' | 'CROSS_DEX_ARB' | 'MEMECOIN';
  timestampMs: number;
  confidence: number;
  netProfitUsd: number;
  optimalAmountUsd: number;
  spreadBps: number;
  details: TriangleDetails | CrossDexDetails | MemecoinDetails;
}

export class GrpcClient {
  private client: Client;
  private signalHandlers: Map<SignalType, SignalHandler[]>;
  
  constructor(rustSidecarUrl: string);
  async start(): Promise<void>;
  onSignal(type: SignalType, handler: SignalHandler): void;
  async reportExecution(result: ExecutionResult): Promise<void>;
  async getHealth(): Promise<HealthStatus>;
  async stop(): Promise<void>;
}
```

**Dependencies:** `@grpc/grpc-js`, `@grpc/proto-loader`  
**Error handling:** Auto-reconnect with 1s backoff. Log all disconnects/reconnects.

---

### C.2 execution-engine

**File:** `src/scanner/execution-engine.ts`  
**Purpose:** Convert a received `OpportunitySignal` into a signed transaction submitted to Base.

**Pipeline:**
```
Signal received
  → Risk gate check (risk-manager)
  → Build contract call params (TriangleParams or ArbParams)
  → Estimate gas
  → Simulate via eth_call (static call)
  → Sign transaction
  → Submit to Flashbots Protect RPC (or Alchemy if unavailable)
  → Monitor for inclusion (up to 3 blocks = ~6s)
  → Report result to Rust sidecar + trade journal
```

**Contract Call Mapping:**

| Signal Type | Contract Function | Params Struct |
|-------------|-------------------|---------------|
| `TRIANGLE_ARB` | `executeTriangleArb(TriangleParams)` | TriangleParams from signal details |
| `CROSS_DEX_ARB` | `executeFlashArb(ArbParams)` | ArbParams from signal details |
| `MEMECOIN` | Manual review → `snipeToken(...)` if approved | Custom params |

**Slippage Protection:**
- Set `minProfit` in contract params = `net_profit_usd * 0.5` (50% of expected profit as safety margin)
- If static call reverts, do NOT submit the transaction
- If gas estimate exceeds 400k gas, skip (likely reverting path)

**Dependencies:** `ethers.js v6` (already in project), `PositionV2 ABI` (from constants.ts)  

---

### C.3 risk-manager

**File:** `src/scanner/risk-manager.ts`  
**Purpose:** Pre-trade safety checks. Every signal passes through this before execution.

**Safety Gates (ALL must pass):**

```typescript
interface RiskConfig {
  // Profitability
  minNetProfitUsd: 0.10,           // Minimum $0.10 after all costs
  minSpreadBps: 15,                // Minimum 15 bps spread
  minConfidence: 0.3,              // Minimum signal confidence
  
  // Position sizing
  maxPositionSizeUsd: 200,         // Start small
  minPositionSizeUsd: 50,          // Don't bother with tiny amounts
  maxLeverage: 3,                  // Never exceed 3x
  
  // Health factor
  minHealthFactor: 1.1,            // Never let health drop below 1.1
  warningHealthFactor: 1.2,        // Start reducing at 1.2
  
  // Gas
  maxGasPriceGwei: 2,              // Don't trade during gas spikes
  maxGasEstimate: 400000,          // Skip if gas estimate too high
  
  // Circuit breakers
  maxConsecutiveFailures: 3,       // Pause after 3 fails
  circuitBreakerPauseMs: 1800000,  // 30-minute pause
  dailyLossLimitUsd: 100,          // Stop trading if daily loss > $100
  minWinRate: 0.40,                // Re-evaluate if win rate drops below 40%
  winRateSampleSize: 20,           // Minimum trades before checking win rate
  
  // MEV
  useFlashbots: true,              // Route through Flashbots Protect
  
  // Timing
  maxSignalAgeMs: 500,             // Discard signals older than 500ms
  maxPendingExecutions: 1,         // Only one execution at a time
}
```

**Circuit Breaker Logic:**

```typescript
class RiskManager {
  private consecutiveFailures = 0;
  private dailyPnl = 0;
  private tradeResults: boolean[] = [];  // Rolling window
  private circuitBreakerUntil = 0;
  private pendingExecutions = 0;
  
  checkSignal(signal: OpportunitySignal): RiskDecision {
    if (Date.now() < this.circuitBreakerUntil) return 'CIRCUIT_BREAKER_ACTIVE';
    if (this.pendingExecutions >= config.maxPendingExecutions) return 'MAX_CONCURRENT';
    if (signal.netProfitUsd < config.minNetProfitUsd) return 'PROFIT_TOO_LOW';
    if (signal.spreadBps < config.minSpreadBps) return 'SPREAD_TOO_LOW';
    if (signal.confidence < config.minConfidence) return 'CONFIDENCE_TOO_LOW';
    if (Date.now() - signal.timestampMs > config.maxSignalAgeMs) return 'SIGNAL_STALE';
    if (signal.optimalAmountUsd > config.maxPositionSizeUsd) return 'POSITION_TOO_LARGE';
    return 'APPROVED';
  }
  
  recordResult(success: boolean, pnlUsd: number): void {
    this.tradeResults.push(success);
    this.dailyPnl += pnlUsd;
    
    if (!success) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 0;
    }
    
    // Circuit breaker: 3 consecutive failures → 30-min pause
    if (this.consecutiveFailures >= config.maxConsecutiveFailures) {
      this.circuitBreakerUntil = Date.now() + config.circuitBreakerPauseMs;
    }
    
    // Daily loss limit
    if (this.dailyPnl < -config.dailyLossLimitUsd) {
      this.circuitBreakerUntil = Date.now() + 86400000; // 24h pause
    }
    
    // Win rate check (after minimum sample)
    if (this.tradeResults.length >= config.winRateSampleSize) {
      const recent = this.tradeResults.slice(-50);
      const winRate = recent.filter(Boolean).length / recent.length;
      if (winRate < config.minWinRate) {
        // Flag for parameter re-evaluation, don't auto-pause
        emitEvent('WIN_RATE_LOW', { winRate, sampleSize: recent.length });
      }
    }
  }
}
```

---

### C.4 trade-journal

**File:** `src/scanner/trade-journal.ts`  
**Purpose:** Log every trade (executed or skipped) with full context for post-analysis.

**Data Model:**

```typescript
interface TradeRecord {
  id: string;                      // UUID
  timestamp: string;               // ISO 8601
  signal: OpportunitySignal;       // The original signal
  decision: 'EXECUTED' | 'SKIPPED' | 'CIRCUIT_BREAKER' | 'RISK_REJECTED';
  riskChecks: RiskCheckResult[];   // All gate results
  txHash?: string;
  gasUsed?: number;
  gasCostUsd?: number;
  expectedProfitUsd: number;
  actualProfitUsd?: number;
  executionTimeMs?: number;        // Signal received → TX submitted
  inclusionTimeMs?: number;        // TX submitted → block included
  errorMessage?: string;
}
```

**Storage:** Append-only JSONL file at `data/trades.jsonl` (one JSON object per line).  
**Integration with trade_journal tool:** Export CSV for analysis via the trade_journal tool's `analyze` and `shadow` actions.

---

### C.5 dashboard (extensions)

**File:** `src/scanner/dashboard.ts` (extend existing)  
**New features:**
- Live signal feed (last 20 opportunities from Rust sidecar)
- Real-time P&L tracker (rolling 24h, 7d)
- Active positions display
- Risk manager status (circuit breaker state, daily P&L)
- Rust sidecar health (via gRPC `GetHealth`)
- Trade history table (from trade journal)

---

## D. Smart Contract Considerations

### Option Evaluation

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Extend PositionV2.sol | Already deployed, supports both ArbParams and TriangleParams, proven | 947 lines, complex, gas-heavy for simple arb | **Use for Phase 2** |
| Deploy new lean ArbOnly.sol | Minimal gas (~180k vs ~300k), focused logic, less attack surface | New deployment, new audit needed, duplicates some logic | **Consider for Phase 3** |

### Decision: Use PositionV2.sol for Phase 2

PositionV2.sol already has:
- `executeFlashArb(ArbParams)` — cross-DEX arb with slippage protection via `minProfit`
- `executeTriangleArb(TriangleParams)` — 3-hop triangle arb with per-hop routing
- Aave V3 flash loan integration (0.05% fee)
- `onlyOwner` access control
- Emergency `withdrawAll()` function

**For Phase 3**, evaluate deploying a gas-optimized `ArbOnly.sol` (~150 lines) if volume justifies the gas savings:
- Removes leverage farming, liquidation, and memecoin sniping code paths
- Hardcodes Aerodrome CL + Uniswap V3 routers (no storage reads)
- Estimated gas savings: 30-40% per arb transaction

### Contract Interaction Safety

- Always call `minProfit` with conservative estimate (50% of expected profit)
- Always set `deadline = block.timestamp + 120` (2-minute expiry)
- Always use Flashbots Protect RPC for MEV protection
- Verify `onlyOwner` — only our executor wallet can call execution functions

---

## E. Safety & Risk Framework

### Layer 1: Rust Sidecar (Detection Safety)
- Only emit signals with `confidence > 0.3` and `spread > 15 bps`
- Discard any quote older than 5 seconds
- Require minimum liquidity depth in all hops

### Layer 2: TypeScript Risk Manager (Pre-Execution Safety)
- All gates from Section C.3 must pass
- Static call simulation must succeed before TX submission
- Gas estimate must be under 400k

### Layer 3: Smart Contract (On-Chain Safety)
- `minProfit` parameter enforces minimum profitability at contract level
- `deadline` parameter prevents stale execution
- Aave V3 health factor check before flash loan
- `onlyOwner` ensures only our wallet can execute

### Layer 4: Operational Safety
- **Daily loss limit:** $100 → 24-hour trading pause
- **Consecutive failure limit:** 3 → 30-minute pause
- **Win rate monitoring:** Alert if < 40% over 20+ trades
- **Gas spike protection:** Don't trade if gas > 2 gwei
- **Signal freshness:** Discard signals older than 500ms

### Emergency Procedures

| Scenario | Action |
|----------|--------|
| Health factor drops below 1.1 | Immediate position close, accept loss |
| Flash loan not repaid (revert) | TX reverts automatically, no funds lost (atomic) |
| Unexpected contract behavior | Call `withdrawAll()` to recover all tokens |
| Rust sidecar crashes | TypeScript falls back to existing 15s polling scanners |
| Gas spike > 5 gwei | Pause all execution until gas normalizes |
| Daily loss > $100 | 24-hour auto-pause, manual review required |

### Profitability Hypothesis Testing

We treat each strategy as a hypothesis, not a guarantee:

| Hypothesis | Test | Success Criteria | Failure Criteria |
|------------|------|-----------------|------------------|
| Stablecoin triangle arb is profitable on Base | Execute 50 micro-trades at $100-200 | Win rate > 60%, avg net > $0.15 | Win rate < 40% or avg net < $0.05 |
| WETH/USDC cross-DEX arb works | Execute 30 trades | Win rate > 55%, avg net > $0.10 | Win rate < 35% |
| Rust sidecar improves hit rate | Compare 15s vs Rust over 100 opportunities | Hit rate > 2x improvement | No significant improvement |

---

## F. Integration Points (Agent Zero Crypto Tools)

### Pipeline Integration

```
Rust Sidecar detects opportunity
        │
        ▼
gRPC Signal ──→ TypeScript receives
        │
        ├──→ risk-manager (gates)
        │         │
        │         ├──→ onchain-analyzer (contract safety for memecoins)
        │         └──→ defi-trader (profitability validation)
        │
        ├──→ execution-engine
        │         │
        │         └──→ alpha_tool (factor scoring)
        │
        └──→ trade-journal
                  │
                  └──→ trade_journal tool (post-trade analysis)
```

### onchain-analyzer Integration
- **When:** Before executing any memecoin or unknown token trade
- **How:** Call `call_subordinate` with `profile: 'onchain-analyzer'`
- **Input:** Token contract address + pair address
- **Output:** Risk score (1-10), contract safety report
- **Gate:** Skip trade if risk score ≥ 5 (for auto) or ≥ 7 (for manual review)

### defi-trader Integration  
- **When:** During Phase 3, for opportunity scanning augmentation
- **How:** Periodically invoke `defi-trader` profile to scan DeFi opportunities
- **Use:** Cross-reference Rust sidecar signals with broader market analysis

### degen-alpha-scout Integration
- **When:** For memecoin strategy (Phase 3)
- **How:** Call `call_subordinate` with `profile: 'degen-alpha-scout'`
- **Input:** New token address from memecoin-processor
- **Output:** Alpha score, pump detection, whale tracking, risk assessment

### alpha_tool Integration
- **When:** Scoring opportunity confidence
- **How:** Use `alpha_tool` with `bench` action to compute factors (momentum, RSI, volatility)
- **Use:** Feed factor scores into Rust sidecar confidence calculation

### backtest_tool Integration
- **When:** Before deploying any new strategy to live
- **How:** Run `backtest_tool` with strategy code against historical OHLCV data
- **Gate:** Strategy must show positive expectancy over 90-day backtest before live deployment

### trade_journal Tool Integration
- **When:** After each trading session
- **How:** Export `data/trades.jsonl` to CSV, run `trade_journal` `analyze` and `shadow` actions
- **Output:** Win rate, expectancy, session distribution, discipline score

---

## G. Data Models

### Rust Structs (Summary)

| Struct | Purpose | Key Fields |
|--------|---------|------------|
| `PoolQuote` | Single price quote | pool_address, token_in, token_out, amount_out, fee_bps, liquidity |
| `PriceBook` | In-memory price store | DashMap of quotes, token metadata, staleness tracking |
| `TrianglePath` | 3-hop arb path | hops[3], gross/net profit, optimal amount, confidence |
| `CrossDexOpportunity` | Cross-DEX arb | buy/sell dex, prices, spread, net profit |
| `MemecoinSignal` | New token alert | token address, pump/risk scores, volume, whale activity |
| `OpportunitySignal` | gRPC message | signal_id, type, confidence, profit, details (oneof) |

### TypeScript Interfaces (Summary)

| Interface | Purpose | Key Fields |
|-----------|---------|------------|
| `OpportunitySignal` | Received from Rust | signalId, signalType, confidence, netProfitUsd, details |
| `RiskConfig` | Safety parameters | minProfit, maxPosition, circuitBreaker settings |
| `TradeRecord` | Journal entry | signal, decision, txHash, actualProfit, executionTime |
| `ExecutionResult` | Sent back to Rust | signalId, executed, success, txHash, actualProfit |

### Protobuf Schemas

Full definitions in Section B.5 above.

---

## H. Deployment

### Docker Compose Configuration

```yaml
# docker-compose.yml
version: '3.8'

services:
  rust-sidecar:
    build:
      context: ./rust-sidecar
      dockerfile: Dockerfile
    environment:
      - ALCHEMY_WS_URL=wss://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
      - GRPC_PORT=50051
      - POOLS_CONFIG=/etc/flashloan/pools.toml
      - RUST_LOG=info
    volumes:
      - ./rust-sidecar/config/pools.toml:/etc/flashloan/pools.toml:ro
    ports:
      - "50051:50051"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "grpc_health_probe", "-addr=:50051"]
      interval: 10s
      timeout: 5s
      retries: 3

  typescript-core:
    build:
      context: .
      dockerfile: Dockerfile.ts
    environment:
      - RUST_SIDECAR_URL=rust-sidecar:50051
      - BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
      - FLASHBOTS_RPC_URL=https://rpc.flashbots.net/fast
      - PRIVATE_KEY=${PRIVATE_KEY}
      - POSITION_V2_ADDRESS=${POSITION_V2_ADDRESS}
      - ALCHEMY_API_KEY=${ALCHEMY_API_KEY}
    depends_on:
      rust-sidecar:
        condition: service_healthy
    restart: unless-stopped
    command: ["npx", "tsx", "src/scanner/grpc-client.ts"]
```

### Environment Variables

```bash
# .env (secrets — NEVER commit)
PRIVATE_KEY=0x...                     # Executor wallet private key
ALCHEMY_API_KEY=...                   # Alchemy API key
POSITION_V2_ADDRESS=0x...             # Deployed PositionV2 contract
BASESCAN_API_KEY=...                  # For contract verification

# .env.shared (non-secret config)
RUST_SIDECAR_URL=localhost:50051
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
FLASHBOTS_RPC_URL=https://rpc.flashbots.net/fast
GRPC_PORT=50051
RUST_LOG=info
```

### Secret Management
- Secrets stored in `.a0proj/secrets.env` (gitignored)
- Docker secrets via `env_file: .a0proj/secrets.env`
- Never log or expose `PRIVATE_KEY`
- Reference via `process.env.PRIVATE_KEY` only

---

## I. Phased Delivery Plan

### Phase 1: Rust Sidecar Foundation (Week 1-2)
**Goal:** Price feed + triangle scanner + gRPC bridge, no execution.

| Milestone | Deliverable | Test |
|-----------|------------|------|
| M1.1 | `price-feed` module reads Aerodrome + UniV3 WebSocket events | Receives 1000+ events/min, updates PriceBook in <1ms |
| M1.2 | `PriceBook` with DashMap, staleness detection | Concurrent read/write benchmarks pass |
| M1.3 | `triangle-scanner` enumerates paths, calculates profit | Detects known triangle paths on Base mainnet |
| M1.4 | `grpc-server` streams `OpportunitySignal` messages | TS client receives and parses signals |
| M1.5 | Integration test: live mainnet feed → signal output | Log 100+ opportunities over 1 hour |

**Exit criteria:** Rust sidecar runs for 4 hours continuously, emits signals that match manual price checks. No execution yet.

### Phase 2: Micro-Execution (Week 3-4)
**Goal:** Execute $100-200 stablecoin triangle arb trades with full safety.

| Milestone | Deliverable | Test |
|-----------|------------|------|
| M2.1 | `grpc-client.ts` receives and validates signals | Parses all signal types correctly |
| M2.2 | `risk-manager.ts` with all safety gates | Rejects signals below thresholds, circuit breaker works |
| M2.3 | `execution-engine.ts` builds and submits TX | Static call simulation passes, TX included on-chain |
| M2.4 | First live micro-trade executed | Net profit > $0.10 after all costs |
| M2.5 | 50-trade sample collected | Win rate > 60%, avg net > $0.15 |

**Exit criteria:** 50 trades executed, win rate > 60%, no safety incidents, daily loss never exceeded $50.

### Phase 3: Multi-Strategy + Scaling (Week 5-8)
**Goal:** Activate cross-DEX, LST arb, memecoin strategies. Scale position sizes.

| Milestone | Deliverable | Test |
|-----------|------------|------|
| M3.1 | `cross-dex-scanner` in Rust | Detects Aero vs UniV3 price gaps |
| M3.2 | Cross-DEX execution via `executeFlashArb` | 20+ cross-DEX trades executed |
| M3.3 | `memecoin-processor` + `degen-alpha-scout` integration | Memecoin signals scored and logged |
| M3.4 | Position sizing increased to $500 based on Phase 2 results | Win rate maintained above 50% |
| M3.5 | Evaluate gas-optimized `ArbOnly.sol` contract | Gas savings > 30% justified |
| M3.6 | Agent Zero specialist integration (onchain-analyzer, defi-trader) | Safety checks run automatically |

**Exit criteria:** All strategies active, daily P&L positive over 7-day window, no safety incidents.

### Phase 4: Optimization (Week 9-12)
**Goal:** Performance tuning, expanded token coverage, Flashblocks integration.

| Milestone | Deliverable | Test |
|-----------|------------|------|
| M4.1 | Base Flashblocks integration (200ms updates) | Detection latency < 10ms total |
| M4.2 | Expanded token set (20+ tokens) | More triangle paths discovered |
| M4.3 | Dynamic position sizing based on confidence | Higher profit on high-confidence signals |
| M4.4 | Trade journal analysis dashboard | Win rate, expectancy, strategy breakdown |
| M4.5 | Evaluate Rust execution path (bypass TS for hot paths) | Latency improvement measured |

---

## J. Testing Strategy

### J.1 Rust Module Tests

| Test Level | Framework | Location | What to Test |
|------------|-----------|----------|-------------|
| Unit | `#[test]` + `tokio::test` | `rust-sidecar/src/**/tests.rs` | Price parsing, profit calc, graph traversal, signal filtering |
| Integration | `tokio::test` | `rust-sidecar/tests/` | gRPC server startup, client connect, signal streaming |
| Property | `proptest` | `rust-sidecar/src/**/prop_tests.rs` | Profit calc never negative for valid inputs, graph cycle detection is complete |
| Load | Custom bench | `rust-sidecar/benches/` | 1000 events/sec sustained, <1ms price update, <2ms triangle scan |

**Key test scenarios:**
- WebSocket disconnect → reconnect without panic
- Stale quote → excluded from path
- Zero-liquidity pool → excluded from path
- Negative profit signal → never emitted
- gRPC client disconnect → server buffers and replays

### J.2 TypeScript Extension Tests

| Test Level | Framework | Location | What to Test |
|------------|-----------|----------|-------------|
| Unit | Vitest/Jest | `src/scanner/__tests__/` | Risk manager gates, execution params builder, trade journal formatting |
| Integration | Hardhat fork | `test/` | Execute arb on Base fork, verify contract interaction, gas estimation |
| E2E | Manual | N/A | Full pipeline: Rust signal → TS execution → on-chain TX (on Sepolia first) |

**Key test scenarios:**
- Signal below $0.10 → risk manager rejects
- Consecutive failures trigger circuit breaker
- Daily loss limit triggers 24h pause
- Stale signal (500ms+) → rejected
- Static call revert → TX not submitted
- Gas spike → execution paused

### J.3 Integration Tests

| Scenario | Setup | Expected Result |
|----------|-------|----------------|
| Happy path triangle arb | Deploy PositionV2 on Base fork, feed Rust known prices that create arb | TX submitted, profit captured |
| Happy path cross-DEX | Same setup, different DEX prices | TX submitted via `executeFlashArb` |
| Safety: profit too low | Feed prices with < 15 bps spread | Signal emitted but risk manager rejects |
| Safety: gas spike | Set gas price to 5 gwei | Risk manager rejects execution |
| Safety: circuit breaker | Send 3 failing signals | 4th signal rejected with CB message |
| Recovery: Rust crash | Kill Rust sidecar | TS falls back to polling, reconnects when Rust restarts |

### J.4 Backtest Validation

Before any strategy goes live:
1. Write strategy as `generate_signals()` function
2. Run through `backtest_tool` with 90 days of Base OHLCV data
3. Verify positive expectancy (avg profit per trade > $0)
4. Verify max drawdown < 20% of capital
5. Only deploy if backtest passes all criteria

---

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Rust sidecar | Rust | 1.80+ | Detection engine |
| | alloy | 1.0 | Ethereum RPC/WS |
| | tokio | 1.x | Async runtime |
| | tokio-tungstenite | 0.24 | WebSocket client |
| | tonic | 0.12 | gRPC framework |
| | prost | 0.13 | Protobuf codec |
| | simd-json | 0.14 | Fast JSON parsing |
| | dashmap | 6.x | Concurrent HashMap |
| | petgraph | 0.6 | Graph algorithms |
| | crossbeam | 0.8 | Concurrent queues |
| TypeScript core | Node.js | 22+ | Execution layer |
| | ethers.js | 6.x | Contract interaction |
| | @grpc/grpc-js | 1.x | gRPC client |
| | tsx | 4.22+ | TS runner |
| Smart contracts | Solidity | 0.8.28 | On-chain execution |
| | Hardhat | 3.x | Build tool |
| Infrastructure | Docker | 24+ | Containerization |
| | Docker Compose | 2.x | Multi-container orchestration |

## Commands

```bash
# Rust sidecar
cd rust-sidecar
cargo build --release           # Build optimized binary
cargo test                      # Run all Rust tests
cargo test -- --nocapture       # Run with output
cargo bench                     # Run benchmarks
cargo run --release             # Run sidecar

# TypeScript core (existing + extensions)
npm install                     # Install dependencies
npm run compile                 # Compile Solidity contracts
npm run test                    # Run contract tests against Base fork
npx tsx src/scanner/grpc-client.ts  # Start gRPC client + execution

# Docker Compose (production)
docker compose build            # Build both containers
docker compose up -d            # Start system
docker compose logs -f          # Follow logs
docker compose down             # Stop system
```

## Project Structure (Extended)

```
flashloan-base/
├── rust-sidecar/                # NEW: Rust detection engine
│   ├── Cargo.toml
│   ├── build.rs
│   ├── proto/
│   │   └── signal.proto         # gRPC protobuf definitions
│   ├── config/
│   │   └── pools.toml           # Pool configuration
│   ├── src/
│   │   ├── main.rs              # Entry point
│   │   ├── feeds/
│   │   │   ├── mod.rs
│   │   │   ├── websocket.rs      # Alchemy WS client
│   │   │   ├── flashblocks.rs    # Flashblocks feed (Phase 4)
│   │   │   └── parser.rs         # Event parsing with simd-json
│   │   ├── engine/
│   │   │   ├── mod.rs
│   │   │   ├── price_book.rs     # In-memory price store
│   │   │   ├── triangle.rs       # Triangle arb scanner
│   │   │   ├── cross_dex.rs      # Cross-DEX comparator
│   │   │   └── memecoin.rs       # Memecoin processor
│   │   ├── grpc/
│   │   │   ├── mod.rs
│   │   │   ├── server.rs         # gRPC server implementation
│   │   │   └── generated.rs      # Auto-generated from proto
│   │   └── config.rs             # Configuration loading
│   ├── tests/
│   │   ├── integration_test.rs
│   │   └── grpc_client_test.rs
│   └── benches/
│       └── price_book_bench.rs
│
├── contracts/                   # EXISTING: Solidity contracts
│   ├── PositionV2.sol           # Multi-strategy flash loan
│   └── Position.sol             # V1 contract
│
├── scripts/                     # EXISTING: Deployment
│   ├── deploy.ts
│   └── deploy-v2.ts
│
├── src/scanner/                 # EXTENDED: TypeScript core
│   ├── constants.ts             # EXISTING: Token addresses, ABIs
│   ├── alchemy-provider.ts      # EXISTING: RPC provider
│   ├── opportunity-scanner.ts   # EXISTING: Polling scanner (fallback)
│   ├── arb-engine.ts            # EXISTING: Arb execution logic
│   ├── memecoin-hunter.ts       # EXISTING: Memecoin tracking
│   ├── dashboard.ts             # EXTENDED: Add live signal feed
│   ├── grpc-client.ts           # NEW: gRPC client for Rust signals
│   ├── execution-engine.ts      # NEW: Signal → TX pipeline
│   ├── risk-manager.ts          # NEW: Pre-trade safety gates
│   └── trade-journal.ts         # NEW: Trade logging + analysis
│
├── data/                        # NEW: Runtime data
│   └── trades.jsonl             # Append-only trade log
│
├── test/                        # EXISTING: Contract tests
├── docker-compose.yml           # NEW: Multi-container deployment
├── Dockerfile                   # NEW: TypeScript container
├── hardhat.config.ts            # EXISTING: Hardhat v3 config
├── package.json                 # EXTENDED: Add gRPC dependencies
└── .env.example                 # EXTENDED: Add new env vars
```

## Code Style

### Rust
```rust
// Modules: snake_case files, CamelCase types
// Error handling: thiserror for library errors, anyhow for application
// Concurrency: prefer DashMap > RwLock<HashMap>, crossbeam channels

use anyhow::Result;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PriceBookError {
    #[error("Stale quote for pool {pool}")]
    StaleQuote { pool: String },
    #[error("Insufficient liquidity: {available} < {required}")]
    InsufficientLiquidity { available: f64, required: f64 },
}
```

### TypeScript
```typescript
// Follow existing project conventions
// Interfaces for data shapes, classes for services
// async/await with proper error handling

export interface OpportunitySignal {
  readonly signalId: string;
  readonly signalType: SignalType;
  readonly netProfitUsd: number;
}

export class RiskManager {
  private readonly config: RiskConfig;
  
  constructor(config: RiskConfig) {
    this.config = config;
  }
  
  checkSignal(signal: OpportunitySignal): RiskDecision {
    // Guard clauses first, happy path last
    if (signal.netProfitUsd < this.config.minNetProfitUsd) {
      return { approved: false, reason: 'PROFIT_TOO_LOW' };
    }
    return { approved: true };
  }
}
```

## Boundaries

### Always
- Run tests before any deployment
- Validate all safety gates before execution
- Log every trade (executed or skipped) to trade journal
- Use Flashbots Protect RPC for arbitrage transactions
- Keep PositionV2.sol `minProfit` parameter conservative
- Monitor health factor after every trade

### Ask First
- Increasing position size above $200
- Adding new token pairs to the monitoring list
- Deploying a new smart contract
- Changing circuit breaker thresholds
- Enabling memecoin auto-execution (requires manual review)

### Never
- Execute trades with health factor < 1.1
- Commit private keys or API keys to git
- Skip risk manager checks for "obvious" opportunities
- Run memecoin auto-execution without onchain-analyzer check
- Increase daily loss limit above $100 without manual approval
- Deploy untested contract changes to mainnet

## Success Criteria

- [ ] Rust sidecar runs continuously for 24 hours without crash
- [ ] Price book tracks 30+ pools with < 1s staleness
- [ ] Triangle scanner detects known arb paths on Base mainnet
- [ ] gRPC bridge delivers signals to TS in < 2ms overhead
- [ ] Risk manager rejects all signals below safety thresholds
- [ ] Circuit breaker activates on 3 consecutive failures
- [ ] First live trade executed with net profit > $0.10
- [ ] 50-trade sample shows > 60% win rate
- [ ] Trade journal captures every trade with full context
- [ ] Dashboard displays live signal feed and P&L

## Open Questions

1. **Flashblocks access:** Do we have access to Base Flashblocks (200ms updates) via Alchemy, or only standard WebSocket? This affects Phase 4 scope.
2. **Flashbots on Base:** Is Flashbots Protect RPC available and effective on Base, or do we need an alternative MEV protection strategy?
3. **PositionV2 address:** Is the contract already deployed to Base mainnet, or do we need to deploy first?
4. **Initial capital:** What's the wallet balance available for micro-executions? This determines starting position size.
5. **Gas cost verification:** Need to measure actual gas costs for `executeTriangleArb()` and `executeFlashArb()` on Base mainnet to refine profit calculations.
6. **Aerodrome pool discovery:** Should we auto-discover pools from Aerodrome Factory, or use a static list in `pools.toml`?

---

*This spec is a living document. Update when decisions change, scope adjusts, or new constraints emerge.*
