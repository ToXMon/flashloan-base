# Implementation Plan: FlashLoan Base — Rust Sidecar + Live Trading System

**Status:** READY FOR EXECUTION  
**Date:** 2026-06-09  
**Source:** docs/spec.md (1261 lines)  

## Overview

Extend the existing flashloan-base TypeScript/Solidity system with a Rust sidecar for sub-5ms opportunity detection and a live execution pipeline for real flash loan trades on Base chain. The system detects arbitrage across Aerodrome CL, Uniswap V3, and Aerodrome AMM, validates profitability after all costs, and executes via PositionV2.sol.

## Architecture Decisions

1. **Rust sidecar for detection, TypeScript for execution** — Rust handles WebSocket price feeds and graph-based path scanning in <5ms; TypeScript handles contract calls, risk management, and dashboard via existing ethers.js codebase.
2. **gRPC server-streaming bridge** — Rust pushes `OpportunitySignal` messages as detected; TypeScript receives and dispatches to execution pipeline. Low overhead (~1ms) compared to the 200ms Flashblock window.
3. **PositionV2.sol for Phase 2** — Already supports `executeTriangleArb()` and `executeFlashArb()` with Aave V3 flash loans. New ArbOnly.sol considered for Phase 3 if gas savings justify.
4. **Docker Compose deployment** — Both services in one compose file, shared network, health checks.
5. **Vertical slicing per strategy** — Build stablecoin triangle arb end-to-end first, then layer cross-DEX and memecoin strategies.
6. **Profitability as hypothesis testing** — Each strategy is validated with live micro-trades before scaling.

## Dependency Graph

```
Phase 0: Research & Setup
  T1 (Flashblocks research) ─────────────────────────────┐
  T2 (Flashbots research) ────────────────────────────────┤
  T3 (Rust toolchain setup) ──────────────────────────────┤
  T4 (Docker Compose skeleton) ───────────────────────────┤
  T5 (Deploy PositionV2) ─────────────────────────────────┤
                                                          │
Phase 1: Rust Foundation                                  │
  T6 (Protobuf definitions) ◄── T3                       │
  T7 (Rust project scaffold + Cargo.toml) ◄── T3         │
  T8 (pools.toml config) ◄── T7                          │
  T9 (PriceBook data structures) ◄── T7                  │
  T10 (WebSocket price feed) ◄── T8, T9                  │
  T11 (Price feed unit tests) ◄── T10                    │
  T12 (Triangle scanner core) ◄── T9                     │
  T13 (Triangle scanner profit calc + filtering) ◄── T12 │
  T14 (gRPC server) ◄── T6, T13                          │
  T15 (Integration test: live feed → signal) ◄── T14     │
  T16 (gRPC TypeScript client) ◄── T6                    │
  T17 (E2E integration: Rust → TS client) ◄── T15, T16   │
                                                          │
Phase 2: Micro-Execution                                  │
  T18 (Risk manager) ◄── T5, T16                         │
  T19 (Execution engine) ◄── T18, T5                     │
  T20 (Trade journal) ◄── T19                            │
  T21 (Dashboard extensions) ◄── T20, T16                │
  T22 (Contract tests on Base fork) ◄── T19              │
  T23 (Live micro-execution: 50 trades) ◄── T19, T22     │
  T24 (Phase 2 results analysis) ◄── T23                 │
                                                          │
Phase 3: Multi-Strategy                                   │
  T25 (Cross-DEX scanner in Rust) ◄── T14                │
  T26 (Cross-DEX execution integration) ◄── T25, T19     │
  T27 (Memecoin processor in Rust) ◄── T14               │
  T28 (Memecoin safety: onchain-analyzer integration) ◄── T27 │
  T29 (LST arb strategy: cbETH/weETH) ◄── T25            │
  T30 (Auto-discover pools module) ◄── T10               │
  T31 (Agent Zero integrations) ◄── T28                  │
  T32 (Evaluate ArbOnly.sol) ◄── T24                     │
  T33 (Phase 3 scaling + results) ◄── T26, T29, T31      │
                                                          │
Phase 4: Optimization                                     │
  T34 (Flashblocks integration) ◄── T1, T15              │
  T35 (Performance profiling + optimization) ◄── T15     │
  T36 (Advanced MEV protection) ◄── T2, T19             │
  T37 (Backtest all strategies) ◄── T24                  │
  T38 (Dynamic position sizing) ◄── T33                  │
  T39 (Expanded token coverage) ◄── T30                  │
  T40 (Final performance benchmarking) ◄── T35, T38      │
```

## Task List

---

### Phase 0: Research & Setup (Week 0)

---

## Task T1: Investigate Flashblocks Availability via Alchemy

**Description:** Research whether Alchemy provides Flashblocks (200ms state updates) for Base chain. Determine if the current Alchemy plan supports it, what WebSocket endpoint to use, and what data format Flashblocks provide.

**Assigned profile:** researcher  
**Dependencies:** None  
**Estimated effort:** 1 day  
**Priority:** P1

**Acceptance criteria:**
- [ ] Document answering: Is Flashblocks available on Base via Alchemy?
- [ ] If yes: WebSocket URL format, subscription method, data schema
- [ ] If no: alternative low-latency data sources evaluated
- [ ] Decision recorded for Phase 4 scope

**Verification:** Written report at `docs/research/flashblocks-availability.md`

**Files to create:**
- `docs/research/flashblocks-availability.md`

---

## Task T2: Investigate Flashbots Protect RPC on Base

**Description:** Research whether Flashbots Protect RPC is available and effective on Base chain. If not, identify alternative MEV protection strategies (private mempool, Sequencer-based protection, etc.).

**Assigned profile:** researcher  
**Dependencies:** None  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] Document answering: Can we use Flashbots Protect RPC (`https://rpc.flashbots.net/fast`) on Base?
- [ ] If yes: confirm it works, measure latency overhead
- [ ] If no: at least 2 alternative MEV protection strategies identified
- [ ] Recommendation for Phase 2 execution

**Verification:** Written report at `docs/research/flashbots-base-availability.md`

**Files to create:**
- `docs/research/flashbots-base-availability.md`

---

## Task T3: Set Up Rust Toolchain in Project

**Description:** Install Rust toolchain (1.80+), configure Cargo, verify compilation of a hello-world binary within the project structure. Set up CI-friendly build process.

**Assigned profile:** developer  
**Dependencies:** None  
**Estimated effort:** 0.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `rustc --version` shows 1.80+
- [ ] `rust-sidecar/` directory created with `Cargo.toml`
- [ ] `cargo build` succeeds inside `rust-sidecar/`
- [ ] `cargo test` runs (even with no tests)
- [ ] `.cargo/config.toml` configured for optimized Base target

**Verification:** `cd rust-sidecar && cargo build && cargo test`

**Files to create:**
- `rust-sidecar/Cargo.toml`
- `rust-sidecar/src/main.rs` (hello world)
- `rust-sidecar/.cargo/config.toml`

---

## Task T4: Docker Compose Skeleton

**Description:** Create `docker-compose.yml` with two services: `rust-sidecar` and `typescript-core`. Include health checks, shared network, environment variable configuration, and volume mounts.

**Assigned profile:** developer  
**Dependencies:** T3  
**Estimated effort:** 1 day  
**Priority:** P1

**Acceptance criteria:**
- [ ] `docker compose config` validates without errors
- [ ] Both services defined with correct build contexts
- [ ] Health check for rust-sidecar on port 50051
- [ ] typescript-core depends_on rust-sidecar with `service_healthy`
- [ ] Environment variables reference `.env` file (no hardcoded secrets)
- [ ] `Dockerfile` for Rust sidecar (multi-stage build)
- [ ] `Dockerfile.ts` for TypeScript core

**Verification:** `docker compose build` succeeds

**Files to create:**
- `docker-compose.yml`
- `rust-sidecar/Dockerfile`
- `Dockerfile.ts`
- `.dockerignore`

---

## Task T5: Deploy PositionV2.sol to Base Mainnet

**Description:** Deploy the existing PositionV2.sol contract to Base mainnet using the deploy-v2.ts script. Verify deployment, fund contract with initial capital, and record the address.

**Assigned profile:** developer  
**Dependencies:** None (contract already compiled)  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] `npm run compile` succeeds
- [ ] Contract deployed to Base mainnet (Chain ID 8453)
- [ ] Deployment address recorded in `.env` as `POSITION_V2_ADDRESS`
- [ ] Contract verified on BaseScan
- [ ] Owner is the executor wallet address
- [ ] Contract funded with $100-200 USDC for initial trades
- [ ] `withdrawAll()` tested on testnet first

**Verification:**
- Contract visible on BaseScan at recorded address
- `cast call $POSITION_V2_ADDRESS "owner()"` returns executor wallet

**Files to modify:**
- `.env` (add POSITION_V2_ADDRESS)
- `.env.example` (add template)

---

### Checkpoint: Phase 0 Complete
- [ ] Flashblocks research documented (T1)
- [ ] Flashbots research documented (T2)
- [ ] Rust toolchain compiles (T3)
- [ ] Docker Compose validates (T4)
- [ ] PositionV2 deployed and funded on Base mainnet (T5)
- [ ] Review with human before proceeding to Phase 1

---

### Phase 1: Rust Foundation (Week 1-2)

---

## Task T6: Define gRPC Protobuf Schemas

**Description:** Create the protobuf definitions for the Rust-TypeScript communication bridge. Define `OpportunityService`, `OpportunitySignal`, `ExecutionResult`, `HealthStatus`, and all nested message types per spec Section B.5.

**Assigned profile:** developer  
**Dependencies:** T3  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] `rust-sidecar/proto/signal.proto` contains all message types from spec
- [ ] `StreamOpportunities` RPC (server-streaming)
- [ ] `ReportExecution` RPC (unary)
- [ ] `GetHealth` RPC (unary)
- [ ] All enum values: `TRIANGLE_ARB`, `CROSS_DEX_ARB`, `MEMECOIN`
- [ ] `protoc --proto_path=proto --rust_out=src/grpc/generated proto/signal.proto` compiles

**Verification:** `protoc` compilation succeeds, generated Rust files exist

**Files to create:**
- `rust-sidecar/proto/signal.proto`
- `rust-sidecar/build.rs` (tonic-build code generation)

---

## Task T7: Rust Project Scaffold + Dependencies

**Description:** Configure the full Cargo.toml with all required dependencies (alloy, tokio, tonic, prost, simd-json, dashmap, petgraph, crossbeam, thiserror, anyhow). Set up module structure matching the spec's project layout.

**Assigned profile:** developer  
**Dependencies:** T3  
**Estimated effort:** 0.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `Cargo.toml` includes all spec-listed dependencies with correct versions
- [ ] Module structure created: `feeds/`, `engine/`, `grpc/`, `config.rs`
- [ ] Each module has `mod.rs` with placeholder exports
- [ ] `cargo build` succeeds with all dependencies resolved
- [ ] `cargo clippy` passes with no warnings

**Verification:** `cargo build && cargo clippy`

**Files to create:**
- `rust-sidecar/src/feeds/mod.rs`
- `rust-sidecar/src/feeds/websocket.rs`
- `rust-sidecar/src/feeds/parser.rs`
- `rust-sidecar/src/engine/mod.rs`
- `rust-sidecar/src/engine/price_book.rs`
- `rust-sidecar/src/engine/triangle.rs`
- `rust-sidecar/src/engine/cross_dex.rs`
- `rust-sidecar/src/engine/memecoin.rs`
- `rust-sidecar/src/grpc/mod.rs`
- `rust-sidecar/src/grpc/server.rs`
- `rust-sidecar/src/grpc/generated.rs`
- `rust-sidecar/src/config.rs`

---

## Task T8: Pool Configuration (pools.toml)

**Description:** Create the initial `pools.toml` configuration file with all high-confidence Base pools: WETH/USDC on Aerodrome CL, Uniswap V3, Aerodrome AMM; stablecoin pools (USDC/DAI, USDC/USDbC); LST pools (cbETH/WETH, weETH/WETH).

**Assigned profile:** developer  
**Dependencies:** T7  
**Estimated effort:** 0.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `rust-sidecar/config/pools.toml` contains at least 10 pool entries
- [ ] Each pool has: address, dex type, token_a, token_b, fee_bps
- [ ] Token addresses match `src/scanner/constants.ts` values
- [ ] Config loading function parses the file without errors
- [ ] Hot-reload mechanism defined (file watcher or SIGHUP)

**Verification:** Rust binary starts and logs "Loaded N pools from pools.toml"

**Files to create:**
- `rust-sidecar/config/pools.toml`
- `rust-sidecar/src/config.rs` (TOML parsing)

---

## Task T9: PriceBook Data Structures

**Description:** Implement the `PriceBook`, `PoolQuote`, `TokenMeta`, and `DexType` data structures using DashMap for concurrent access. Include staleness detection (AtomicU64 timestamp tracking).

**Assigned profile:** developer  
**Dependencies:** T7  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] `PriceBook` uses `DashMap<(Address, Address, DexType, u32), PoolQuote>`
- [ ] `get_quote(token_in, token_out, dex, fee)` returns latest quote
- [ ] `update_quote(quote)` inserts/updates in <0.1ms
- [ ] `get_stale_quotes(max_age_ms)` returns quotes older than threshold
- [ ] Thread-safe: concurrent read/write benchmark passes
- [ ] Unit tests for all methods

**Verification:** `cargo test -- price_book` passes

**Files to create:**
- `rust-sidecar/src/engine/price_book.rs`
- `rust-sidecar/src/engine/price_book_tests.rs`

---

## Task T10: WebSocket Price Feed Module

**Description:** Implement the Alchemy WebSocket price feed. Subscribe to Swap events across all tracked pools, parse events using simd-json, compute prices, and update the PriceBook. Implement reconnection with exponential backoff.

**Assigned profile:** developer  
**Dependencies:** T8, T9  
**Estimated effort:** 2 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] Connects to `wss://base-mainnet.g.alchemy.com/v2/{key}`
- [ ] Subscribes to `logs` for Swap event signatures on all tracked pools
- [ ] Parses Swap events using simd-json (<0.5ms per event)
- [ ] Computes price from swap amounts: `price = amount_out / amount_in`
- [ ] Updates `PriceBook` via `DashMap::insert`
- [ ] Broadcasts `PriceUpdate` on `tokio::sync::broadcast` channel
- [ ] Reconnects on disconnect with exponential backoff (100ms → 5s max)
- [ ] Handles 1000+ events/second sustained
- [ ] Logs connection status and event counts

**Verification:** Binary runs for 5 minutes, logs price updates, no panics

**Files to modify:**
- `rust-sidecar/src/feeds/websocket.rs`
- `rust-sidecar/src/feeds/parser.rs`

---

## Task T11: Price Feed Unit Tests + Benchmarks

**Description:** Write comprehensive unit tests and performance benchmarks for the price feed pipeline: event parsing, price calculation, PriceBook updates, staleness detection, reconnection logic.

**Assigned profile:** test-engineer  
**Dependencies:** T10  
**Estimated effort:** 1 day  
**Priority:** P1

**Acceptance criteria:**
- [ ] Unit tests for Swap event parsing (valid, malformed, missing fields)
- [ ] Unit tests for price calculation edge cases (zero amounts, extreme values)
- [ ] Unit tests for PriceBook concurrent access
- [ ] Unit tests for staleness detection (5s threshold)
- [ ] Unit tests for reconnection backoff timing
- [ ] Benchmark: parse + update < 0.5ms per event
- [ ] Benchmark: 1000 events/sec sustained
- [ ] Property test: profit calc never panics on valid inputs
- [ ] `cargo test` and `cargo bench` pass

**Verification:** `cargo test && cargo bench`

**Files to create:**
- `rust-sidecar/src/feeds/tests.rs`
- `rust-sidecar/benches/price_book_bench.rs`

---

## Task T12: Triangle Scanner Core (Graph Construction)

**Description:** Build the directed graph of token pairs from PriceBook data using petgraph. Enumerate all 3-edge cycles for triangle arbitrage paths.

**Assigned profile:** developer  
**Dependencies:** T9  
**Estimated effort:** 1.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `TriangleScanner` struct with `petgraph::Graph` internal state
- [ ] `rebuild_graph(price_book: &PriceBook)` constructs directed graph
- [ ] Edges weighted by exchange rate (amount_out / amount_in)
- [ ] `find_cycles()` enumerates all 3-edge cycles in <2ms
- [ ] Limits to top-20 tokens by volume when graph exceeds threshold
- [ ] Pre-allocated path buffers (zero alloc in hot path)
- [ ] Unit tests: known triangle paths detected on sample data

**Verification:** `cargo test -- triangle` passes

**Files to create:**
- `rust-sidecar/src/engine/triangle.rs`
- `rust-sidecar/src/engine/triangle_tests.rs`

---

## Task T13: Triangle Scanner Profit Calculation + Signal Filtering

**Description:** Implement profit calculation for each triangle path including flash loan fee (0.05%), gas cost, slippage buffer. Filter signals below thresholds. Compute optimal input amount and confidence score.

**Assigned profile:** developer  
**Dependencies:** T12  
**Estimated effort:** 1.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `calculate_profit(path, amount_in)` computes: gross_profit, flash_fee, gas_cost, slippage_buffer, net_profit
- [ ] Filters: `net_profit >= $0.10` AND `spread >= 15 bps`
- [ ] Optimal amount search over [$100, $200, $500, $1000, $2000]
- [ ] Confidence score based on: liquidity depth, quote freshness (<500ms), historical hit rate
- [ ] Only emits signal if `confidence > 0.5`
- [ ] Stale quotes (>5s) excluded from paths
- [ ] Unit tests match the spec's profit calculation example
- [ ] Property test: net_profit never positive for non-profitable paths

**Verification:** `cargo test -- profit` passes, manual calculation matches spec example

**Files to modify:**
- `rust-sidecar/src/engine/triangle.rs`

---

## Task T14: gRPC Server Implementation

**Description:** Implement the gRPC server using tonic. Stream `OpportunitySignal` messages from the triangle scanner. Handle `ReportExecution` and `GetHealth` unary calls. Implement graceful shutdown, reconnection buffering (last 100 signals), and keepalive.

**Assigned profile:** developer  
**Dependencies:** T6, T13  
**Estimated effort:** 2 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] Server listens on `0.0.0.0:50051` (configurable via env)
- [ ] `StreamOpportunities` pushes signals as detected
- [ ] `ReportExecution` receives and logs execution results
- [ ] `GetHealth` returns uptime, signals emitted, pools tracked
- [ ] Max message size: 4 MB
- [ ] Keepalive: 30s ping, 60s timeout
- [ ] Graceful shutdown on SIGTERM
- [ ] Client disconnect: buffer last 100 signals, replay on reconnect (30s window)
- [ ] Integration test: connect test client, receive signals

**Verification:** `cargo test -- grpc` passes, test client receives signals

**Files to modify:**
- `rust-sidecar/src/grpc/server.rs`
- `rust-sidecar/src/main.rs` (wire everything together)

---

## Task T15: Integration Test — Live Mainnet Feed → Signal Output

**Description:** Run the full Rust sidecar against Base mainnet for 4 hours continuously. Verify it detects real opportunities, price book stays fresh, no crashes or memory leaks.

**Assigned profile:** test-engineer  
**Dependencies:** T14  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] Sidecar runs for 4 hours without crash
- [ ] 100+ price updates received per minute
- [ ] PriceBook staleness never exceeds 5s for active pools
- [ ] At least 50 signals emitted (logged, not executed)
- [ ] Manual price check: 3 random signals match real prices within 10 bps
- [ ] Memory usage stable (no leak — check with `valgrind` or RSS tracking)
- [ ] Reconnection tested (restart Alchemy WS, verify recovery)

**Verification:** 4-hour run log analyzed, all criteria met

**Files to create:**
- `rust-sidecar/tests/integration_test.rs`

---

## Task T16: TypeScript gRPC Client

**Description:** Implement the TypeScript gRPC client that connects to the Rust sidecar, receives `OpportunitySignal` messages, parses them into typed interfaces, and dispatches to registered handlers.

**Assigned profile:** developer  
**Dependencies:** T6  
**Estimated effort:** 1.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `src/scanner/grpc-client.ts` implements `GrpcClient` class
- [ ] Connects to Rust sidecar at configurable URL
- [ ] Parses all signal types: TRIANGLE_ARB, CROSS_DEX_ARB, MEMECOIN
- [ ] `onSignal(type, handler)` registers typed handlers
- [ ] `reportExecution(result)` sends result back to Rust
- [ ] `getHealth()` queries sidecar health
- [ ] Auto-reconnects with 1s backoff on disconnect
- [ ] Logs all disconnects/reconnects
- [ ] Dependencies added: `@grpc/grpc-js`, `@grpc/proto-loader`

**Verification:** `npx tsx src/scanner/grpc-client.ts` connects to running sidecar

**Files to create:**
- `src/scanner/grpc-client.ts`

---

## Task T17: End-to-End Integration — Rust → TypeScript Signal Flow

**Description:** Wire the Rust sidecar and TypeScript gRPC client together. Verify signals flow from live Base mainnet through Rust detection into TypeScript handlers. Test with Docker Compose.

**Assigned profile:** developer  
**Dependencies:** T15, T16  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] `docker compose up` starts both services
- [ ] TypeScript client connects to Rust sidecar within 5s
- [ ] Signals received in TypeScript match Rust logs
- [ ] `getHealth()` returns correct stats from TS side
- [ ] Rust crash → TS logs disconnect, falls back gracefully
- [ ] Rust restart → TS reconnects within 10s
- [ ] Signal delivery latency: Rust emit → TS receive < 2ms

**Verification:** `docker compose up`, watch logs for 10 minutes, signals flowing

**Files to modify:**
- `docker-compose.yml` (wire TS command)
- `package.json` (add start:live script)

---

### Checkpoint: Phase 1 Complete
- [ ] Rust sidecar runs 4 hours continuously (T15)
- [ ] PriceBook tracks 10+ pools with <1s staleness
- [ ] Triangle scanner detects known arb paths
- [ ] gRPC bridge delivers signals in <2ms
- [ ] TypeScript client receives and parses all signal types
- [ ] Docker Compose runs both services
- [ ] Review with human before Phase 2 (live money)

---

### Phase 2: Micro-Execution (Week 3-4)

---

## Task T18: TypeScript Risk Manager

**Description:** Implement the pre-trade safety gate. Every signal passes through this module before execution. Includes profitability checks, position sizing, circuit breaker logic, daily loss limit, and signal freshness validation.

**Assigned profile:** developer  
**Dependencies:** T5, T16  
**Estimated effort:** 2 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `src/scanner/risk-manager.ts` implements `RiskManager` class
- [ ] All safety gates from spec Section C.3 implemented
- [ ] `checkSignal()` returns `APPROVED` or specific rejection reason
- [ ] Gates: min profit $0.10, min spread 15 bps, min confidence 0.3
- [ ] Position sizing: $50-$200, max leverage 3x
- [ ] Circuit breaker: 3 consecutive failures → 30-min pause
- [ ] Daily loss limit: $100 → 24-hour pause
- [ ] Signal freshness: reject if >500ms old
- [ ] Gas spike protection: reject if >2 gwei
- [ ] Max 1 pending execution at a time
- [ ] Win rate monitoring: alert if <40% over 20+ trades
- [ ] Unit tests for every gate and circuit breaker scenario

**Verification:** `npx vitest run -- risk-manager` all tests pass

**Files to create:**
- `src/scanner/risk-manager.ts`
- `src/scanner/__tests__/risk-manager.test.ts`

---

## Task T19: TypeScript Execution Engine

**Description:** Implement the signal-to-transaction pipeline. Convert `OpportunitySignal` into contract call parameters (`TriangleParams` or `ArbParams`), simulate via static call, estimate gas, sign and submit transaction.

**Assigned profile:** developer  
**Dependencies:** T18, T5  
**Estimated effort:** 2 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] `src/scanner/execution-engine.ts` implements `ExecutionEngine` class
- [ ] Signal type mapping: TRIANGLE_ARB → `executeTriangleArb`, CROSS_DEX_ARB → `executeFlashArb`
- [ ] Builds correct contract params from signal details
- [ ] Sets `minProfit = net_profit_usd * 0.5` (50% safety margin)
- [ ] Sets `deadline = block.timestamp + 120` (2-min expiry)
- [ ] Static call simulation before submission (skip if revert)
- [ ] Gas estimate check: skip if >400k gas
- [ ] Submits to Flashbots Protect RPC (or Alchemy fallback)
- [ ] Monitors for inclusion up to 3 blocks (~6s)
- [ ] Reports result to Rust sidecar and trade journal
- [ ] Unit tests for param building and gas checks

**Verification:** Dry-run on Base fork: static call succeeds with known profitable prices

**Files to create:**
- `src/scanner/execution-engine.ts`
- `src/scanner/__tests__/execution-engine.test.ts`

---

## Task T20: TypeScript Trade Journal

**Description:** Implement append-only trade logging. Record every signal (executed or skipped) with full context. Export to CSV for analysis via the trade_journal tool.

**Assigned profile:** developer  
**Dependencies:** T19  
**Estimated effort:** 1 day  
**Priority:** P1

**Acceptance criteria:**
- [ ] `src/scanner/trade-journal.ts` implements `TradeJournal` class
- [ ] `log(record)` appends JSON to `data/trades.jsonl`
- [ ] `TradeRecord` includes: id, timestamp, signal, decision, risk checks, tx hash, gas, expected/actual profit, execution time
- [ ] Decision types: EXECUTED, SKIPPED, CIRCUIT_BREAKER, RISK_REJECTED
- [ ] `exportCsv()` converts JSONL to CSV for trade_journal tool
- [ ] No duplicate records
- [ ] File rotation when size >10MB
- [ ] Unit tests for logging and CSV export

**Verification:** Log 10 test records, export CSV, verify with `head data/trades.jsonl`

**Files to create:**
- `src/scanner/trade-journal.ts`
- `src/scanner/__tests__/trade-journal.test.ts`
- `data/.gitkeep`

---

## Task T21: Dashboard Extensions for Live Trading

**Description:** Extend the existing CLI dashboard with live signal feed, real-time P&L tracking, risk manager status, Rust sidecar health, and trade history.

**Assigned profile:** developer  
**Dependencies:** T20, T16  
**Estimated effort:** 1.5 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] Live signal feed: last 20 opportunities from Rust sidecar
- [ ] Real-time P&L: rolling 24h and 7d
- [ ] Risk manager status: circuit breaker state, daily P&L, consecutive failures
- [ ] Rust sidecar health via `getHealth()`: uptime, pools tracked, signals emitted
- [ ] Trade history table: last 20 trades from trade journal
- [ ] Active positions display (if any leverage positions open)
- [ ] Dashboard updates every 2 seconds
- [ ] Graceful fallback when Rust sidecar is down

**Verification:** `npm run dashboard:monitor` shows live data with Rust sidecar running

**Files to modify:**
- `src/scanner/dashboard.ts`

---

## Task T22: Contract Tests on Base Fork

**Description:** Write Hardhat tests that verify PositionV2.sol execution functions work correctly on a Base mainnet fork. Test triangle arb and cross-DEX arb with known profitable price conditions.

**Assigned profile:** test-engineer  
**Dependencies:** T19  
**Estimated effort:** 1.5 days  
**Priority:** P0

**Acceptance criteria:**
- [ ] Tests run against Base mainnet fork via Hardhat
- [ ] `executeTriangleArb` succeeds with profitable prices
- [ ] `executeFlashArb` succeeds with cross-DEX price gap
- [ ] TX reverts when `minProfit` not met
- [ ] TX reverts when flash loan not repaid
- [ ] Gas usage measured: triangle arb <300k, cross-DEX <250k
- [ ] `onlyOwner` check: non-owner call reverts
- [ ] `deadline` expiry: past-deadline TX reverts
- [ ] All tests pass: `npm run test`

**Verification:** `npm run test` passes with fork tests

**Files to create:**
- `test/execution-e2e.ts`
- `test/risk-gates.ts`

---

## Task T23: Live Micro-Execution — 50 Stablecoin Triangle Arb Trades

**Description:** Execute 50 real flash loan trades at $100-200 position size for stablecoin triangle arbitrage (USDC/DAI/USDbC). This is hypothesis testing: prove the strategy is profitable with real money.

**Assigned profile:** developer (with human gate for first trade)  
**Dependencies:** T19, T22  
**Estimated effort:** 3-5 days (waiting for opportunities)  
**Priority:** P0

**Acceptance criteria:**
- [ ] First trade executed with human gate approval
- [ ] 50 trades completed (or 7 days elapsed, whichever first)
- [ ] Win rate > 60%
- [ ] Average net profit > $0.15 per trade
- [ ] No safety incidents: health factor never < 1.1
- [ ] Daily loss never exceeded $50
- [ ] Circuit breaker never triggered more than twice
- [ ] All trades logged to trade journal
- [ ] No stuck positions or unrecovered funds

**Verification:** Trade journal analysis confirms criteria

**Human Gate Required:** Explicit approval before first live trade

---

## Task T24: Phase 2 Results Analysis

**Description:** Analyze the 50-trade sample using the trade_journal tool. Compute win rate, expectancy, session distribution, discipline score. Generate shadow trading profile. Document findings and recommendations.

**Assigned profile:** researcher  
**Dependencies:** T23  
**Estimated effort:** 1 day  
**Priority:** P0

**Acceptance criteria:**
- [ ] Trade journal CSV exported from `data/trades.jsonl`
- [ ] `trade_journal analyze` run: win rate, expectancy, avg win/loss
- [ ] `trade_journal shadow` run: trading style, discipline score
- [ ] Written analysis: strategy profitability assessment
- [ ] Go/No-Go recommendation for Phase 3 scaling
- [ ] Position sizing recommendation based on evidence
- [ ] If win rate < 40%: document failure analysis and parameter adjustments

**Verification:** Report at `docs/research/phase2-results.md`

**Files to create:**
- `docs/research/phase2-results.md`

---

### Checkpoint: Phase 2 Complete
- [ ] Risk manager rejects all invalid signals
- [ ] Execution engine submits profitable trades
- [ ] 50 trades executed with >60% win rate
- [ ] Trade journal captures every trade
- [ ] Dashboard shows live P&L
- [ ] Phase 2 analysis report completed
- [ ] Human review: proceed to Phase 3 based on evidence

---

### Phase 3: Multi-Strategy (Week 5-8)

---

## Task T25: Cross-DEX Scanner in Rust

**Description:** Implement the cross-DEX scanner in Rust. Compare prices for identical token pairs across Aerodrome and Uniswap V3. Emit `OpportunitySignal` with `CROSS_DEX_ARB` type when spread exceeds costs.

**Assigned profile:** developer  
**Dependencies:** T14  
**Estimated effort:** 2 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] `rust-sidecar/src/engine/cross_dex.rs` implements `CrossDexScanner`
- [ ] Scans all token pairs with quotes on 2+ DEXes
- [ ] `spread_bps = |sell_price - buy_price| / buy_price * 10000`
- [ ] Filters: spread >= 15 bps, net_profit >= $0.10
- [ ] Calculates net profitability including: pool fees, flash fee, gas, slippage
- [ ] Scans all cross-DEX pairs in <1ms
- [ ] Re-evaluates on each price update
- [ ] Unit tests with known price gaps

**Verification:** `cargo test -- cross_dex` passes

**Files to create:**
- `rust-sidecar/src/engine/cross_dex.rs`

---

## Task T26: Cross-DEX Execution Integration

**Description:** Wire cross-DEX signals into the TypeScript execution engine. Map `CROSS_DEX_ARB` signals to `executeFlashArb(ArbParams)` calls. Execute 20+ cross-DEX trades.

**Assigned profile:** developer  
**Dependencies:** T25, T19  
**Estimated effort:** 1.5 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] Execution engine handles `CROSS_DEX_ARB` signal type
- [ ] Maps to `executeFlashArb` with correct `ArbParams`
- [ ] 20+ cross-DEX trades executed
- [ ] Win rate > 55% for cross-DEX
- [ ] Average net profit > $0.10
- [ ] All trades logged to trade journal

**Verification:** Trade journal shows 20+ cross-DEX trades with stats

**Files to modify:**
- `src/scanner/execution-engine.ts`
- `src/scanner/grpc-client.ts`

---

## Task T27: Memecoin Processor in Rust

**Description:** Implement the memecoin monitoring module in Rust. Subscribe to Aerodrome Factory PairCreated events, track new token launches, compute pump scores and risk scores, and emit `MemecoinSignal` via gRPC.

**Assigned profile:** developer  
**Dependencies:** T14  
**Estimated effort:** 2 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] `rust-sidecar/src/engine/memecoin.rs` implements `MemecoinProcessor`
- [ ] Subscribes to Aerodrome Factory `PairCreated` events
- [ ] Tracks up to 50 active memecoin pairs
- [ ] Computes `pump_score` based on volume acceleration, holder growth, price momentum
- [ ] Computes `risk_score` based on contract age, liquidity lock, holder concentration
- [ ] Emits signal if `pump_score > 0.6` AND `risk_score < 5`
- [ ] Skips tokens with `risk_score >= 7`
- [ ] Processes new pair in <100ms
- [ ] Unit tests with mock pair events

**Verification:** `cargo test -- memecoin` passes

**Files to create:**
- `rust-sidecar/src/engine/memecoin.rs`

---

## Task T28: Memecoin Safety — Onchain Analyzer Integration

**Description:** Integrate the Agent Zero `onchain-analyzer` profile into the memecoin pipeline. Before any memecoin signal is actionable, run contract safety checks.

**Assigned profile:** developer  
**Dependencies:** T27  
**Estimated effort:** 1.5 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] When memecoin signal received in TS, call `onchain-analyzer` via `call_subordinate`
- [ ] Input: token contract address + pair address
- [ ] Output: risk score (1-10), contract safety report
- [ ] Auto-skip if risk score >= 5
- [ ] Manual review queue if risk score 5-6
- [ ] Memecoin trades NEVER auto-execute in Phase 3
- [ ] Safety results logged to trade journal

**Verification:** Test with known memecoin address, verify safety report generated

**Files to modify:**
- `src/scanner/grpc-client.ts` (memecoin handler)
- `src/scanner/execution-engine.ts` (memecoin path)

---

## Task T29: LST Arbitrage Strategy (cbETH/weETH)

**Description:** Activate LST arbitrage using the cross-DEX scanner. Track cbETH/WETH and weETH/WETH price gaps across Aerodrome and Uniswap V3. Execute when spread exceeds costs.

**Assigned profile:** developer  
**Dependencies:** T25  
**Estimated effort:** 1.5 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] LST pools added to `pools.toml`: cbETH/WETH, weETH/WETH on Aerodrome CL + UniV3
- [ ] Cross-DEX scanner detects LST price gaps
- [ ] Execution engine handles LST arb via `executeFlashArb`
- [ ] 10+ LST arb trades executed
- [ ] Win rate > 50%
- [ ] Position sizing: $200-500 (scaled from Phase 2 evidence)

**Verification:** Trade journal shows LST trades with positive expectancy

**Files to modify:**
- `rust-sidecar/config/pools.toml` (add LST pools)

---

## Task T30: Auto-Discover Pools Module

**Description:** Implement automatic pool discovery from Aerodrome Factory and Uniswap V3 Factory. Replace the static `pools.toml` approach with dynamic pool discovery that adds new pools as they appear.

**Assigned profile:** developer  
**Dependencies:** T10  
**Estimated effort:** 2 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] `rust-sidecar/src/feeds/discovery.rs` implements `PoolDiscovery`
- [ ] Subscribes to Aerodrome Factory `PoolCreated` events
- [ ] Subscribes to Uniswap V3 Factory `PoolCreated` events
- [ ] Filters: only add pools with >$50K TVL
- [ ] Auto-adds new pools to PriceBook and scanner
- [ ] Logs discovered pools with metadata
- [ ] Gracefully handles duplicate discoveries
- [ ] Initial discovery on startup: scan existing factory state

**Verification:** Start sidecar, verify it discovers 20+ pools automatically

**Files to create:**
- `rust-sidecar/src/feeds/discovery.rs`

---

## Task T31: Agent Zero Specialist Integrations

**Description:** Integrate Agent Zero specialist profiles into the trading pipeline: `defi-trader` for opportunity scanning augmentation, `degen-alpha-scout` for memecoin alpha, `alpha_tool` for factor-based scoring.

**Assigned profile:** developer  
**Dependencies:** T28  
**Estimated effort:** 1.5 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] `defi-trader` periodically scans DeFi opportunities, cross-references with Rust signals
- [ ] `degen-alpha-scout` receives memecoin signals, returns alpha scores
- [ ] `alpha_tool` `bench` action used to score opportunity confidence
- [ ] Integration results logged for each specialist call
- [ ] Specialist insights do NOT block execution (async, advisory only)

**Verification:** Log shows specialist calls happening alongside signal processing

**Files to create:**
- `src/scanner/agent-integrations.ts`

---

## Task T32: Evaluate Gas-Optimized ArbOnly.sol

**Description:** Based on Phase 2 gas measurements, evaluate whether deploying a lean `ArbOnly.sol` (~150 lines) justifies the gas savings. If yes, write the contract. If no, document the decision.

**Assigned profile:** developer  
**Dependencies:** T24  
**Estimated effort:** 2 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] Phase 2 gas data analyzed: actual gas per trade, cost in USD
- [ ] ArbOnly.sol designed: hardcoded routers, no leverage/memecoin code paths
- [ ] Estimated gas savings: 30-40% per arb
- [ ] Decision documented with cost-benefit analysis
- [ ] If proceeding: contract written, tested on fork, deployed
- [ ] If not proceeding: document why (gas costs too low on Base to justify)

**Verification:** Decision report at `docs/research/arbonly-evaluation.md`

**Files to create:**
- `docs/research/arbonly-evaluation.md`
- `contracts/ArbOnly.sol` (if proceeding)

---

## Task T33: Phase 3 Scaling + Results Analysis

**Description:** Scale position sizes based on Phase 2 evidence. Increase from $200 to $500. Monitor all strategies over 7 days. Analyze results.

**Assigned profile:** researcher  
**Dependencies:** T26, T29, T31  
**Estimated effort:** 2 days (monitoring) + 1 day analysis  
**Priority:** P1

**Acceptance criteria:**
- [ ] Position sizing increased based on Phase 2 evidence (max $500)
- [ ] All strategies active: triangle, cross-DEX, LST arb
- [ ] 7-day trading window completed
- [ ] Daily P&L positive over the window
- [ ] No safety incidents
- [ ] Trade journal analysis for each strategy
- [ ] Per-strategy win rate and expectancy
- [ ] Go/No-Go recommendation for Phase 4

**Verification:** Report at `docs/research/phase3-results.md`

**Files to create:**
- `docs/research/phase3-results.md`

---

### Checkpoint: Phase 3 Complete
- [ ] Cross-DEX scanner detects Aero vs UniV3 price gaps
- [ ] LST arb strategy active
- [ ] Memecoin signals scored (manual execution only)
- [ ] Auto-discover pools working
- [ ] Agent Zero integrations advisory pipeline active
- [ ] 7-day positive P&L
- [ ] Review with human before Phase 4

---

### Phase 4: Optimization (Week 9-12)

---

## Task T34: Flashblocks Integration

**Description:** If Flashblocks are available (from T1 research), integrate them into the Rust price feed for 200ms state updates instead of standard WebSocket events.

**Assigned profile:** developer  
**Dependencies:** T1, T15  
**Estimated effort:** 3 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] If Flashblocks available: `rust-sidecar/src/feeds/flashblocks.rs` implemented
- [ ] Price updates received every 200ms (vs current event-driven)
- [ ] Detection latency measured: target <10ms total
- [ ] Fallback to standard WebSocket if Flashblocks unavailable
- [ ] If not available: document alternative approaches, move to backlog

**Verification:** Compare signal detection latency before/after Flashblocks

**Files to create:**
- `rust-sidecar/src/feeds/flashblocks.rs`

---

## Task T35: Performance Profiling + Optimization

**Description:** Profile the full pipeline (price feed → detection → gRPC → TS execution). Identify and fix bottlenecks. Target: detection-to-sent <10ms.

**Assigned profile:** developer  
**Dependencies:** T15  
**Estimated effort:** 3 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] Flame graphs generated for Rust sidecar hot paths
- [ ] Latency measurements at each stage: WS parse, price update, graph scan, gRPC send, TS receive, TX build, sign+send
- [ ] Detection-to-sent latency <10ms (target)
- [ ] Price book operations <0.5ms
- [ ] Triangle scan <2ms
- [ ] gRPC overhead <1ms
- [ ] Zero unnecessary allocations in hot paths
- [ ] Benchmark results documented

**Verification:** `cargo bench` shows improvements from baseline

**Files to create:**
- `docs/research/performance-profiling.md`
- `rust-sidecar/benches/pipeline_bench.rs`

---

## Task T36: Advanced MEV Protection

**Description:** Implement advanced MEV protection based on T2 research findings. This may include Flashbots Protect, private mempool, or Sequencer-based submission strategies.

**Assigned profile:** developer  
**Dependencies:** T2, T19  
**Estimated effort:** 2 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] MEV protection strategy implemented based on T2 findings
- [ ] TX submission routed through chosen MEV protection layer
- [ ] No sandwich attacks observed on executed trades
- [ ] Latency impact of MEV protection measured: <3ms overhead
- [ ] Fallback to standard RPC if MEV protection fails

**Verification:** Compare trade execution with/without MEV protection over 50 trades

**Files to modify:**
- `src/scanner/execution-engine.ts`

---

## Task T37: Backtest Validation of All Strategies

**Description:** Validate all active strategies using the backtest_tool with 90 days of Base OHLCV data. Each strategy must show positive expectancy before continued live deployment.

**Assigned profile:** researcher  
**Dependencies:** T24  
**Estimated effort:** 2 days  
**Priority:** P1

**Acceptance criteria:**
- [ ] Triangle arb strategy backtested over 90 days
- [ ] Cross-DEX strategy backtested over 90 days
- [ ] LST arb strategy backtested over 90 days
- [ ] Each strategy shows positive expectancy (avg profit per trade > $0)
- [ ] Max drawdown < 20% of capital per strategy
- [ ] Backtest results documented with Sharpe ratio, win rate, max drawdown
- [ ] Strategies failing backtest criteria flagged for parameter adjustment

**Verification:** Report at `docs/research/backtest-results.md`

**Files to create:**
- `docs/research/backtest-results.md`
- Strategy code files for backtest_tool input

---

## Task T38: Dynamic Position Sizing

**Description:** Implement confidence-based position sizing. Higher confidence signals get larger positions. Scale from evidence-based minimum to maximum based on rolling win rate.

**Assigned profile:** developer  
**Dependencies:** T33  
**Estimated effort:** 1.5 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] Position size = f(confidence, rolling_win_rate, daily_pnl)
- [ ] High confidence (>0.8) + high win rate (>65%): max position $500
- [ ] Medium confidence (0.5-0.8) + normal win rate: position $200-300
- [ ] Low confidence (0.3-0.5): position $100-200
- [ ] Position reduced after losses (risk-adjusted)
- [ ] Never exceeds max leverage 3x
- [ ] Position sizing logic unit tested

**Verification:** Unit tests pass, position sizes match expected values for given inputs

**Files to modify:**
- `src/scanner/risk-manager.ts`
- `src/scanner/execution-engine.ts`

---

## Task T39: Expanded Token Coverage

**Description:** Expand the token set from the initial stablecoin/core pairs to 20+ tokens. This increases triangle path discovery and cross-DEX opportunities.

**Assigned profile:** developer  
**Dependencies:** T30  
**Estimated effort:** 1.5 days  
**Priority:** P2

**Acceptance criteria:**
- [ ] 20+ tokens tracked in PriceBook
- [ ] At least 60 active edges in the triangle graph
- [ ] New token pairs: EURC/USDC, USDGLO/USDC, DOLA/USDC, extra LSTs
- [ ] Auto-discovery adds new qualifying pools automatically
- [ ] Triangle paths discovered increased by 3x from Phase 2
- [ ] No degradation in scan latency (<2ms)

**Verification:** Count of tracked tokens and graph edges logged at startup

**Files to modify:**
- `rust-sidecar/config/pools.toml` (add new pairs)

---

## Task T40: Final Performance Benchmarking + System Report

**Description:** Run comprehensive performance benchmarks on the complete system. Generate final system report with all metrics, strategy results, and recommendations for ongoing operation.

**Assigned profile:** researcher  
**Dependencies:** T35, T38  
**Estimated effort:** 1 day  
**Priority:** P2

**Acceptance criteria:**
- [ ] Full pipeline latency measured end-to-end
- [ ] Detection-to-sent latency <12ms (spec max)
- [ ] Throughput: 1000+ events/sec sustained
- [ ] Uptime: 24-hour continuous run without crash
- [ ] Strategy performance summary: win rate, expectancy, Sharpe per strategy
- [ ] System report at `docs/research/system-performance.md`
- [ ] Recommendations for ongoing operation and monitoring

**Verification:** 24-hour benchmark run completed successfully

**Files to create:**
- `docs/research/system-performance.md`

---

### Checkpoint: Phase 4 Complete
- [ ] Flashblocks integrated or documented as unavailable
- [ ] Detection-to-sent latency <12ms
- [ ] Advanced MEV protection active
- [ ] All strategies backtested
- [ ] Dynamic position sizing implemented
- [ ] 20+ tokens tracked
- [ ] Final system report completed
- [ ] System ready for continuous autonomous operation

---

## Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Flash loan not repaid (revert) | Low (atomic) | Medium | TX reverts automatically, no funds lost. Test on fork first. |
| Rust sidecar crash | Medium | Low | Docker restart policy. TS falls back to existing 15s polling scanners. |
| Price oracle manipulation | High | Low | Use direct pool prices from WebSocket, not oracles. Multiple pool confirmation. |
| MEV sandwich attack | Medium | Medium | Flashbots Protect or private mempool. Tight slippage limits. |
| Gas spike during execution | Low | Low | Gas price check in risk manager. Max 2 gwei threshold. |
| Stablecoin depeg | High | Very Low | Monitor peg health. Circuit breaker on >2% depeg. |
| Contract bug in PositionV2 | High | Very Low | Fork testing. `withdrawAll()` emergency function. `onlyOwner` access. |
| Daily loss limit exceeded | Medium | Low | $100 daily limit with 24-hour auto-pause. Manual review required. |
| Aerodrome MEV-resistant pools | Medium | Medium | Diversify across DEXes. Monitor Aerodrome upgrade announcements. |
| Rust memory leak over time | Medium | Low | 4-hour integration test. RSS monitoring in health check. |

## Profitability Hypothesis Testing

| Hypothesis | Test | Success Criteria | Failure Criteria | Task |
|------------|------|-----------------|------------------|------|
| Stablecoin triangle arb profitable on Base | 50 micro-trades at $100-200 | Win rate >60%, avg net >$0.15 | Win rate <40% or avg net <$0.05 | T23 |
| WETH/USDC cross-DEX arb works | 30 trades | Win rate >55%, avg net >$0.10 | Win rate <35% | T26 |
| Rust sidecar improves hit rate | Compare 15s vs Rust over 100 signals | Hit rate >2x improvement | No significant improvement | T17 |
| LST arb (cbETH/weETH) works | 10+ trades | Win rate >50% | Win rate <30% | T29 |

## Open Questions (Resolved During Phase 0)

1. Flashblocks access → T1 research task
2. Flashbots on Base → T2 research task  
3. PositionV2 deployment → T5 deployment task
4. Starting capital → $100-200 confirmed
5. Gas costs → User confirmed awareness
6. Pool discovery → Auto-discover (T30)

## Task Summary

| Phase | Tasks | Duration | Est. Days | Key Milestone |
|-------|-------|----------|-----------|---------------|
| Phase 0 | T1-T5 | Week 0 | 4.5 | System ready for development |
| Phase 1 | T6-T17 | Week 1-2 | 14 | Rust sidecar emitting live signals |
| Phase 2 | T18-T24 | Week 3-4 | 11.5 | 50 profitable live trades |
| Phase 3 | T25-T33 | Week 5-8 | 15 | Multi-strategy active, positive P&L |
| Phase 4 | T34-T40 | Week 9-12 | 14 | Optimized, backtested, autonomous |
| **Total** | **40 tasks** | **12 weeks** | **~59 days** | Complete live trading system |
