#!/usr/bin/env node
/**
 * Base Flash Loan Dashboard — Unified CLI
 *
 * Real-time profit tracking, risk management, and opportunity monitoring.
 * Combines all scanners into a single dashboard.
 *
 * Usage:
 *   npx ts-node dashboard.ts              # Full dashboard
 *   npx ts-node dashboard.ts scan         # One-shot scan
 *   npx ts-node dashboard.ts monitor      # Continuous monitoring
 *   npx ts-node dashboard.ts memecoins    # Memecoin hunter
 *   npx ts-node dashboard.ts arb          # Arbitrage scanner
 *   npx ts-node dashboard.ts risk         # Risk analysis only
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import { BaseOpportunityScanner } from "./opportunity-scanner.js";
import { BaseMemecoinHunter } from "./memecoin-hunter.js";
import { ArbitrageEngine } from "./arb-engine.js";
import type { TradeJournal, JournalStats, JournalEntry } from "./trade-journal.js";
import type { RiskManager, RiskState, CircuitBreakerStatus, DailyStats } from "./risk-manager.js";
import type { ExecutionEngine, EngineStatus, TradeResult } from "./execution-engine.js";
import type { ScannerClient, HealthCheck, OpportunitySignal } from "./grpc-client.js";
import { ConnectionState, Strategy } from "./grpc-client.js";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface PortfolioState {
  totalValueUSD: number;
  positions: PositionState[];
  totalPnL: number;
  unrealizedPnL: number;
  gasSpentUSD: number;
}

interface PositionState {
  id: string;
  strategy: string;
  collateralAsset: string;
  debtAsset: string;
  collateralAmount: string;
  debtAmount: string;
  healthFactor: number;
  liquidationPrice: number;
  currentPrice: number;
  pnlUSD: number;
  ageHours: number;
  apyNet: number;
  status: "SAFE" | "WARNING" | "DANGER" | "CLOSED";
}

interface RiskMetrics {
  overallRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  maxLossUSD: number;
  liquidationDistance: number; // % drop to liquidation
  concentrationRisk: number;  // 0-100
  impermanentLoss: number;    // estimated IL %
  gasRisk: number;            // gas spike exposure
  protocolRisk: number;       // Aave/Aerodrome risk score
  correlationRisk: number;    // asset correlation
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const POSITION_V2 = ""; // Will be set after deployment

const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

const POSITION_ABI = [
  "function currentPosition() external view returns (address collateralAsset, address debtAsset, uint256 collateralAmount, uint256 debtAmount, bool isOpen, uint8 strategy, uint256 openedAt)",
  "function getHealthFactor() external view returns (uint256)",
  "function getAccountData() external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function strategyProfits(uint8) external view returns (uint256)",
  "function strategyExecutions(uint8) external view returns (uint256)",
  "function totalProfitWithdrawn() external view returns (uint256)",
  "function getTokenBalance(address) external view returns (uint256)",
];

// ═══════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════

class FlashLoanDashboard {
  private provider: ethers.JsonRpcProvider;
  private scanner: BaseOpportunityScanner;
  private memecoinHunter: BaseMemecoinHunter;
  private arbEngine: ArbitrageEngine;
  private ethPriceUSD: number = 2500;
  private startTime: number = Date.now();

  constructor() {
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    this.provider = new ethers.JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
    this.scanner = new BaseOpportunityScanner(rpcUrl);
    this.memecoinHunter = new BaseMemecoinHunter(rpcUrl);
    this.arbEngine = new ArbitrageEngine(rpcUrl);
  }

  // ───────────────────────────────────────────────────────
  // Full Dashboard
  // ───────────────────────────────────────────────────────

  async renderDashboard(): Promise<void> {
    this.clearScreen();
    this.renderHeader();

    try {
      // Fetch all data in parallel
      const [block, feeData, portfolio, risk] = await Promise.all([
        this.provider.getBlockNumber(),
        this.provider.getFeeData(),
        this.getPortfolioState(),
        this.calculateRiskMetrics(),
      ]);

      this.renderSystemStatus(block, feeData);
      await this.renderPortfolio(portfolio);
      this.renderRiskMetrics(risk);
      this.renderQuickActions();
    } catch (err) {
      console.log(`  ⚠️  Error: ${(err as Error).message}`);
    }
  }

  // ───────────────────────────────────────────────────────
  // Header
  // ───────────────────────────────────────────────────────

  private renderHeader(): void {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║                                                              ║");
    console.log("║     ⚡  BASE FLASH LOAN DASHBOARD  ⚡                        ║");
    console.log("║     Multi-Strategy DeFi Profit Engine                         ║");
    console.log("║                                                              ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
  }

  private renderSystemStatus(block: number, feeData: ethers.FeeData): void {
    const gasGwei = ethers.formatUnits(feeData.gasPrice || 0n, "gwei");
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    console.log("\n  ┌─ SYSTEM STATUS ──────────────────────────────────────────┐");
    console.log(`  │ Network: Base (8453)          Block: ${block}`);
    console.log(`  │ Gas: ${parseFloat(gasGwei).toFixed(4)} gwei         ETH: $${this.ethPriceUSD}`);
    console.log(`  │ Uptime: ${hours}h ${mins}m`);
    console.log("  └──────────────────────────────────────────────────────────┘");
  }

  // ───────────────────────────────────────────────────────
  // Portfolio
  // ───────────────────────────────────────────────────────

  private async getPortfolioState(): Promise<PortfolioState> {
    const contractAddress = process.env.POSITION_CONTRACT;

    if (!contractAddress) {
      return {
        totalValueUSD: 0,
        positions: [],
        totalPnL: 0,
        unrealizedPnL: 0,
        gasSpentUSD: 0,
      };
    }

    try {
      const contract = new ethers.Contract(contractAddress, POSITION_ABI, this.provider);

      const [accountData, currentPos, strategyProfits0, strategyProfits1, strategyProfits2, exec0, exec1, exec2, totalWithdrawn] = await Promise.all([
        contract.getAccountData().catch(() => null),
        contract.currentPosition().catch(() => null),
        contract.strategyProfits(0).catch(() => 0n),
        contract.strategyProfits(1).catch(() => 0n),
        contract.strategyProfits(2).catch(() => 0n),
        contract.strategyExecutions(0).catch(() => 0n),
        contract.strategyExecutions(1).catch(() => 0n),
        contract.strategyExecutions(2).catch(() => 0n),
        contract.totalProfitWithdrawn().catch(() => 0n),
      ]);

      const positions: PositionState[] = [];

      if (currentPos && currentPos.isOpen) {
        const hf = accountData ? Number(accountData.healthFactor) / 1e18 : 0;
        const collateralUSD = accountData ? Number(accountData.totalCollateralBase) / 1e8 : 0;
        const debtUSD = accountData ? Number(accountData.totalDebtBase) / 1e8 : 0;

        positions.push({
          id: "1",
          strategy: ["LEVERAGE_FARM", "FLASH_ARB", "TRIANGLE_ARB", "LIQUIDATION", "MEMECOIN_SNIPER"][currentPos.strategy] || "UNKNOWN",
          collateralAsset: currentPos.collateralAsset,
          debtAsset: currentPos.debtAsset,
          collateralAmount: ethers.formatEther(currentPos.collateralAmount),
          debtAmount: ethers.formatEther(currentPos.debtAmount),
          healthFactor: hf,
          liquidationPrice: 0,
          currentPrice: 0,
          pnlUSD: 0,
          ageHours: currentPos.openedAt > 0 ? (Date.now() / 1000 - Number(currentPos.openedAt)) / 3600 : 0,
          apyNet: 0,
          status: hf > 1.5 ? "SAFE" : hf > 1.2 ? "WARNING" : "DANGER",
        });
      }

      const totalPnL = Number(ethers.formatEther(
        strategyProfits0 + strategyProfits1 + strategyProfits2
      )) * this.ethPriceUSD;

      return {
        totalValueUSD: positions.reduce((sum, p) => sum + p.pnlUSD, 0),
        positions,
        totalPnL,
        unrealizedPnL: 0,
        gasSpentUSD: 0,
      };
    } catch {
      return {
        totalValueUSD: 0,
        positions: [],
        totalPnL: 0,
        unrealizedPnL: 0,
        gasSpentUSD: 0,
      };
    }
  }

  private async renderPortfolio(state: PortfolioState): Promise<void> {
    console.log("\n  ┌─ PORTFOLIO ──────────────────────────────────────────────┐");
    console.log(`  │ Total Value: $${state.totalValueUSD.toFixed(2)}`);
    console.log(`  │ Total P&L:   $${state.totalPnL.toFixed(2)}`);

    if (state.positions.length === 0) {
      console.log("  │ No active positions");
    } else {
      for (const pos of state.positions) {
        const statusEmoji = pos.status === "SAFE" ? "🟢" : pos.status === "WARNING" ? "🟡" : "🔴";
        console.log(`  │ ${statusEmoji} [${pos.strategy}] HF: ${pos.healthFactor.toFixed(2)}`);
        console.log(`  │    Collateral: ${parseFloat(pos.collateralAmount).toFixed(4)} | Debt: ${parseFloat(pos.debtAmount).toFixed(4)}`);
        console.log(`  │    P&L: $${pos.pnlUSD.toFixed(2)} | Age: ${pos.ageHours.toFixed(1)}h`);
      }
    }
    console.log("  └──────────────────────────────────────────────────────────┘");
  }

  // ───────────────────────────────────────────────────────
  // Risk Metrics
  // ───────────────────────────────────────────────────────

  private async calculateRiskMetrics(): Promise<RiskMetrics> {
    // Simplified risk calculation
    return {
      overallRisk: "LOW",
      maxLossUSD: 0,
      liquidationDistance: 0,
      concentrationRisk: 30,
      impermanentLoss: 0,
      gasRisk: 10,
      protocolRisk: 15,
      correlationRisk: 20,
    };
  }

  private renderRiskMetrics(risk: RiskMetrics): void {
    const riskEmoji = risk.overallRisk === "LOW" ? "🟢" :
                      risk.overallRisk === "MEDIUM" ? "🟡" :
                      risk.overallRisk === "HIGH" ? "🔴" : "💀";

    console.log("\n  ┌─ RISK METRICS ──────────────────────────────────────────┐");
    console.log(`  │ Overall: ${riskEmoji} ${risk.overallRisk}`);
    console.log(`  │ Liquidation Distance: ${risk.liquidationDistance.toFixed(1)}%`);
    console.log(`  │ Concentration: ${risk.concentrationRisk}/100`);
    console.log(`  │ Protocol Risk: ${risk.protocolRisk}/100`);
    console.log("  └──────────────────────────────────────────────────────────┘");
  }

  // ───────────────────────────────────────────────────────
  // Quick Actions
  // ───────────────────────────────────────────────────────

  private renderQuickActions(): void {
    console.log("\n  ┌─ COMMANDS ───────────────────────────────────────────────┐");
    console.log("  │ scan       — Full opportunity scan                        │");
    console.log("  │ monitor    — Continuous monitoring (15s interval)          │");
    console.log("  │ memecoins  — Memecoin hunter report                       │");
    console.log("  │ arb        — Arbitrage engine scan                        │");
    console.log("  │ risk       — Detailed risk analysis                       │");
    console.log("  │ deploy     — Deploy PositionV2 contract                   │");
    console.log("  └──────────────────────────────────────────────────────────┘\n");
  }

  // ───────────────────────────────────────────────────────
  // Continuous Monitor
  // ───────────────────────────────────────────────────────

  async startMonitor(intervalSec: number = 15): Promise<void> {
    console.log(`🚀 Starting continuous monitor (${intervalSec}s interval)...\n`);

    const render = async () => {
      await this.renderDashboard();
    };

    await render();

    setInterval(async () => {
      await render();
    }, intervalSec * 1000);

    process.on("SIGINT", () => {
      console.log("\n🛑 Dashboard stopped.");
      process.exit(0);
    });
  }

  // ───────────────────────────────────────────────────────
  // Utility
  // ───────────────────────────────────────────────────────

  private clearScreen(): void {
    process.stdout.write("\x1Bc");
  }
}

// ═══════════════════════════════════════════════════════════════
// Trading Dashboard — Live P&L, Risk, Execution Feed
// ═══════════════════════════════════════════════════════════════

// ANSI color helpers (no external deps)
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
};

const strategyName = (s: Strategy): string =>
  Strategy[s] ?? 'UNKNOWN';

export class TradingDashboard {
  private tradeJournal?: TradeJournal;
  private riskManager?: RiskManager;
  private executionEngine?: ExecutionEngine;
  private scannerClient?: ScannerClient;

  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = Date.now();

  // Live buffers
  private recentTrades: TradeResult[] = [];
  private recentSignals: OpportunitySignal[] = [];
  private lastHealth: HealthCheck | null = null;
  private lastEngineStatus: EngineStatus | null = null;

  private static readonly MAX_TRADES = 10;
  private static readonly MAX_SIGNALS = 5;

  constructor(deps: {
    tradeJournal?: TradeJournal;
    riskManager?: RiskManager;
    executionEngine?: ExecutionEngine;
    scannerClient?: ScannerClient;
  }) {
    this.tradeJournal = deps.tradeJournal;
    this.riskManager = deps.riskManager;
    this.executionEngine = deps.executionEngine;
    this.scannerClient = deps.scannerClient;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start(intervalMs: number = 3000): void {
    this.startTime = Date.now();
    this.stop();
    this.interval = setInterval(() => this.render(), intervalMs);
    this.render();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Event Callbacks ──────────────────────────────────────────

  onTrade(result: TradeResult): void {
    this.recentTrades.unshift(result);
    if (this.recentTrades.length > TradingDashboard.MAX_TRADES) {
      this.recentTrades.length = TradingDashboard.MAX_TRADES;
    }
  }

  onSignal(signal: OpportunitySignal): void {
    this.recentSignals.unshift(signal);
    if (this.recentSignals.length > TradingDashboard.MAX_SIGNALS) {
      this.recentSignals.length = TradingDashboard.MAX_SIGNALS;
    }
  }

  // ── Main Render ──────────────────────────────────────────────

  private render(): void {
    process.stdout.write('\x1Bc');
    this.renderHeader();
    this.renderSystemStatus();
    this.renderRiskStatus();
    this.renderLiveStats();
    this.renderRecentExecutions();
    this.renderOpportunityFeed();
    this.renderSessionInfo();
  }

  // ── Header ──────────────────────────────────────────────────

  private renderHeader(): void {
    console.log(
      `${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`,
    );
    console.log(
      `${C.bold}${C.cyan}║  ⚡  TRADING DASHBOARD — Live P&L · Risk · Executions  ⚡   ║${C.reset}`,
    );
    console.log(
      `${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`,
    );
  }

  // ── System Status ────────────────────────────────────────────

  private renderSystemStatus(): void {
    const conn = this.scannerClient?.getState() ?? ConnectionState.DISCONNECTED;
    const connColor =
      conn === ConnectionState.CONNECTED
        ? C.green
        : conn === ConnectionState.CONNECTING
          ? C.yellow
          : C.red;

    // Fetch health async (use cached if available)
    if (this.scannerClient && conn === ConnectionState.CONNECTED) {
      this.scannerClient
        .getHealth()
        .then((h) => { this.lastHealth = h; })
        .catch(() => {});
    }

    // Fetch engine status
    if (this.executionEngine) {
      this.executionEngine
        .getStatus()
        .then((s) => { this.lastEngineStatus = s; })
        .catch(() => {});
    }

    const h = this.lastHealth;
    const e = this.lastEngineStatus;

    console.log(
      `\n  ${C.bold}┌─ SYSTEM STATUS ──────────────────────────────────────────┐${C.reset}`,
    );
    console.log(
      `  │ Rust Sidecar: ${connColor}${conn}${C.reset}   Active Feeds: ${h?.active_feeds ?? '—'}`,
    );
    console.log(
      `  │ Signals Emitted: ${h?.signals_emitted ?? '—'}   Last Signal: ${h ? this.fmtTime(h.last_signal_at) : '—'}`,
    );
    console.log(
      `  │ Engine: ${e ? (e.initialized ? `${C.green}initialized${C.reset}` : `${C.yellow}not initialized${C.reset}`) : C.dim + 'not connected' + C.reset}   Block: ${e?.blockNumber ?? '—'}`,
    );
    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}`,
    );
  }

  // ── Risk Status ──────────────────────────────────────────────

  private renderRiskStatus(): void {
    const state = this.riskManager?.getState();
    const cb = this.riskManager?.getCircuitBreakerStatus();
    const daily = this.riskManager?.getDailyStats();

    if (!state && !cb && !daily) {
      console.log(
        `\n  ${C.dim}┌─ RISK STATUS ──────────────────── not configured ─────────┐${C.reset}`,
      );
      console.log(`  ${C.dim}│ No RiskManager connected${C.reset}`);
      console.log(
        `  ${C.dim}└──────────────────────────────────────────────────────────┘${C.reset}`,
      );
      return;
    }

    const paused = state?.isPaused ?? false;
    const cbActive = cb?.active ?? false;

    const statusIcon = paused
      ? `${C.bgRed}${C.white} PAUSED ${C.reset}`
      : cbActive
        ? `${C.yellow}⚠ BREAKER${C.reset}`
        : `${C.green}✓ ACTIVE${C.reset}`;

    console.log(
      `\n  ${C.bold}┌─ RISK STATUS ────────────────────────────────────────────┐${C.reset}`,
    );
    console.log(`  │ Status: ${statusIcon}`);
    console.log(
      `  │ Circuit Breaker: ${cbActive ? `${C.red}TRIPPED${C.reset} — ${cb?.reason ?? ''}` : `${C.green}OK${C.reset}`}${cbActive && cb?.resumesAt ? ` (resumes ${this.fmtTime(cb.resumesAt)})` : ''}`,
    );
    console.log(
      `  │ Consecutive Failures: ${state?.consecutiveFailures ?? 0}`,
    );
    console.log(
      `  │ Daily P&L: ${this.fmtUsd(daily?.profit ?? 0, daily?.profit ?? 0)}   Loss: ${this.fmtUsd(daily?.loss ?? 0, -(daily?.loss ?? 0), true)}   Trades: ${daily?.trades ?? 0}`,
    );
    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}`,
    );
  }

  // ── Live Stats ───────────────────────────────────────────────

  private renderLiveStats(): void {
    // Read stats from journal (cached via getStats, called each render)
    // Use a sync-style approach: display last known or fetch async
    // Since getStats is async, we use a cached pattern
    if (this.tradeJournal) {
      this.tradeJournal
        .getStats()
        .then((stats) => { this._cachedStats = stats; })
        .catch(() => {});
    }

    const s = this._cachedStats;

    if (!s) {
      console.log(
        `\n  ${C.dim}┌─ LIVE STATS ────────────────── awaiting data ────────────┐${C.reset}`,
      );
      console.log(
        `  ${C.dim}│ Trade journal stats will appear after first trades${C.reset}`,
      );
      console.log(
        `  ${C.dim}└──────────────────────────────────────────────────────────┘${C.reset}`,
      );
      return;
    }

    const pnlColor = s.netProfitUsd >= 0 ? C.green : C.red;
    const wrColor = s.winRate >= 0.5 ? C.green : s.winRate >= 0.3 ? C.yellow : C.red;

    console.log(
      `\n  ${C.bold}┌─ LIVE STATS ─────────────────────────────────────────────┐${C.reset}`,
    );
    console.log(
      `  │ Total Trades: ${s.totalTrades}   Success: ${C.green}${s.successfulTrades}${C.reset}   Failed: ${C.red}${s.failedTrades}${C.reset}`,
    );
    console.log(
      `  │ Win Rate: ${wrColor}${(s.winRate * 100).toFixed(1)}%${C.reset}   Net P&L: ${pnlColor}${this.fmtUsd(s.netProfitUsd, s.netProfitUsd)}${C.reset}`,
    );
    console.log(
      `  │ Avg Profit: ${C.green}${s.avgProfitUsd.toFixed(2)}${C.reset}   Avg Loss: ${C.red}${s.avgLossUsd.toFixed(2)}${C.reset}   Gas Cost: $${s.totalGasCostUsd.toFixed(2)}`,
    );
    if (s.bestTrade) {
      console.log(
        `  │ Best: ${C.green}$${s.bestTrade.net_profit_usd.toFixed(2)}${C.reset} (${s.bestTrade.signal_id.slice(0, 8)})   Worst: ${C.red}$${s.worstTrade?.net_profit_usd.toFixed(2) ?? '0.00'}${C.reset} (${s.worstTrade?.signal_id.slice(0, 8) ?? '—'})`,
      );
    }
    if (s.consecutiveWins > 0 || s.consecutiveLosses > 0) {
      const streak =
        s.consecutiveWins > 0
          ? `${C.green}W${s.consecutiveWins}${C.reset}`
          : `${C.red}L${s.consecutiveLosses}${C.reset}`;
      console.log(`  │ Streak: ${streak}   Avg Exec Time: ${s.avgExecutionTimeMs.toFixed(0)}ms`);
    }
    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}`,
    );
  }

  // ── Recent Executions ────────────────────────────────────────

  private renderRecentExecutions(): void {
    console.log(
      `\n  ${C.bold}┌─ RECENT EXECUTIONS (last ${TradingDashboard.MAX_TRADES}) ────────────────────────┐${C.reset}`,
    );

    if (this.recentTrades.length === 0) {
      console.log(
        `  ${C.dim}│ No executions yet. Trades will appear here in real time.${C.reset}`,
      );
    } else {
      // Table header
      console.log(
        `  ${C.dim}│ ${'Signal ID'.padEnd(10)} ${'Strategy'.padEnd(14)} ${'Profit'.padStart(10)} ${'Gas'.padStart(8)} ${'Time'.padEnd(10)}${C.reset}`,
      );
      console.log(
        `  ${C.dim}│ ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(10)}${C.reset}`,
      );

      for (const t of this.recentTrades) {
        const profit = t.profit_usd ?? 0;
        const pColor = profit >= 0 ? C.green : C.red;
        const sign = profit >= 0 ? '+' : '';
        const gas = t.gas_cost_usd?.toFixed(2) ?? '—';
        const status = t.success ? '✓' : '✗';
        const sColor = t.success ? C.green : C.red;

        // Find matching signal to get strategy name
        const strat = this.strategyForSignal(t.signal_id);

        console.log(
          `  │ ${sColor}${status}${C.reset} ${t.signal_id.slice(0, 8).padEnd(8)} ${strat.padEnd(14)} ${pColor}${sign}${profit.toFixed(2)}${C.reset} ${gas.padStart(8)} ${this.fmtTime(t.execution_time_ms ?? Date.now(), true)}`,
        );
      }
    }

    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}`,
    );
  }

  // ── Opportunity Feed ─────────────────────────────────────────

  private renderOpportunityFeed(): void {
    console.log(
      `\n  ${C.bold}┌─ OPPORTUNITY FEED (last ${TradingDashboard.MAX_SIGNALS}) ─────────────────────────┐${C.reset}`,
    );

    if (this.recentSignals.length === 0) {
      console.log(
        `  ${C.dim}│ Waiting for signals from Rust sidecar...${C.reset}`,
      );
    } else {
      for (const sig of this.recentSignals) {
        const profit = parseFloat(sig.net_profit_usd) || parseFloat(sig.expected_profit_usd) || 0;
        const pColor = profit >= 0 ? C.green : C.red;
        const conf = (sig.confidence * 100).toFixed(0);
        const expired = sig.expires_at < Date.now() / 1000;
        const expiryTag = expired
          ? `${C.red}EXPIRED${C.reset}`
          : `${C.dim}exp ${this.fmtTime(sig.expires_at * 1000)}${C.reset}`;

        console.log(
          `  │ ${strategyName(sig.strategy).padEnd(16)} ${pColor}$${profit.toFixed(2)}${C.reset}  conf:${conf}%  ${sig.signal_id.slice(0, 8)}  ${expiryTag}`,
        );
        if (sig.route.length > 0) {
          console.log(
            `  │   ${C.dim}route: ${sig.route.map((h) => `${h.token_in.slice(0, 6)}→${h.token_out.slice(0, 6)}`).join(' → ')}${C.reset}`,
          );
        }
      }
    }

    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}`,
    );
  }

  // ── Session Info ─────────────────────────────────────────────

  private renderSessionInfo(): void {
    const uptime = Date.now() - this.startTime;
    const h = Math.floor(uptime / 3600000);
    const m = Math.floor((uptime % 3600000) / 60000);
    const s = Math.floor((uptime % 60000) / 1000);

    console.log(
      `\n  ${C.bold}┌─ SESSION ────────────────────────────────────────────────┐${C.reset}`,
    );
    console.log(
      `  │ Started: ${new Date(this.startTime).toISOString().slice(11, 19)}   Uptime: ${h}h ${m}m ${s}s`,
    );
    console.log(
      `  │ Signals received: ${this.recentSignals.length}   Trades executed: ${this.recentTrades.length}`,
    );
    console.log(
      `  ${C.bold}└──────────────────────────────────────────────────────────┘${C.reset}\n`,
    );
  }

  // ── Helpers ──────────────────────────────────────────────────

  private _cachedStats: JournalStats | null = null;

  private fmtUsd(value: number, colorValue: number, invert = false): string {
    const v = invert ? -value : value;
    const color = colorValue >= 0 ? C.green : C.red;
    const sign = v >= 0 ? '+' : '';
    return `${color}${sign}$${v.toFixed(2)}${C.reset}`;
  }

  private fmtTime(ms: number, short = false): string {
    if (ms === 0) return '—';
    const d = new Date(ms);
    if (short) {
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    }
    return d.toISOString().slice(11, 19);
  }

  private strategyForSignal(signalId: string): string {
    const match = this.recentSignals.find((s) => s.signal_id === signalId);
    if (match) return strategyName(match.strategy);
    return 'unknown';
  }
}

// ── Factory ────────────────────────────────────────────────────

export function createDashboard(deps: {
  tradeJournal?: TradeJournal;
  riskManager?: RiskManager;
  executionEngine?: ExecutionEngine;
  scannerClient?: ScannerClient;
}): TradingDashboard {
  return new TradingDashboard(deps);
}

// ═══════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════

async function main() {
  const dashboard = new FlashLoanDashboard();
  const command = process.argv[2] || "dashboard";

  switch (command) {
    case "scan": {
      const scanner = new BaseOpportunityScanner();
      await scanner.scan();
      break;
    }
    case "monitor": {
      await dashboard.startMonitor(15);
      break;
    }
    case "memecoins": {
      const hunter = new BaseMemecoinHunter();
      await hunter.scanTrendingTokens();
      break;
    }
    case "arb": {
      const engine = new ArbitrageEngine();
      await engine.findAllOpportunities();
      break;
    }
    default: {
      await dashboard.renderDashboard();
      break;
    }
  }
}

main().catch(console.error);
