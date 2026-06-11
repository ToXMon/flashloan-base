/**
 * Trade Journal — Persistent JSONL-based trade log with analytics.
 *
 * Records every TradeResult enriched with signal context into an
 * append-only JSONL file. Provides stats, filtering, CSV export,
 * and automatic file rotation when the journal grows past 10 MB.
 *
 * Usage:
 *   const journal = new TradeJournal('data/trades.jsonl');
 *   await journal.append(entry);
 *   const stats = await journal.getStats();
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type { TradeResult } from './execution-engine.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface JournalEntry extends TradeResult {
  strategy: string;
  route_summary: string;
  input_token: string;
  input_amount: string;
  expected_profit_usd: number;
  actual_profit_usd: number;
  profit_delta_usd: number;
  gas_cost_usd: number;
  net_profit_usd: number;
  confidence: number;
  signal_timestamp: number;
  execution_timestamp: number;
  latency_ms: number;
}

export interface JournalStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  winRate: number;
  totalProfitUsd: number;
  totalGasCostUsd: number;
  netProfitUsd: number;
  avgProfitUsd: number;
  avgLossUsd: number;
  bestTrade: JournalEntry | null;
  worstTrade: JournalEntry | null;
  avgExecutionTimeMs: number;
  profitByStrategy: Record<string, { trades: number; winRate: number; profit: number }>;
  consecutiveWins: number;
  consecutiveLosses: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── TradeJournal ──────────────────────────────────────────────────

export class TradeJournal {
  private filePath: string;

  constructor(filePath: string = 'data/trades.jsonl') {
    this.filePath = filePath;
  }

  // ── Append ────────────────────────────────────────────────────

  /**
   * Append a journal entry as a single JSON line.
   * Auto-creates the parent directory and fsyncs for durability.
   * Rotates the file if it exceeds 10 MB.
   */
  async append(entry: JournalEntry): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Rotate if file exceeds size limit
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size >= MAX_FILE_SIZE) {
        const ext = path.extname(this.filePath);
        const base = this.filePath.slice(0, -ext.length || Infinity);
        const rotatedPath = `${base}-${Date.now()}${ext}`;
        await fs.rename(this.filePath, rotatedPath);
      }
    } catch {
      // File doesn't exist yet — no rotation needed
    }

    // Append the entry as a single JSON line
    const line = JSON.stringify(entry) + '\n';
    const fd = await fs.open(this.filePath, 'a');
    try {
      await fd.write(line);
      await fd.sync(); // fsync for durability
    } finally {
      await fd.close();
    }
  }

  // ── Read All ──────────────────────────────────────────────────

  /** Read all journal entries from the file. */
  async readAll(): Promise<JournalEntry[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as JournalEntry);
    } catch {
      return [];
    }
  }

  // ── Stats ─────────────────────────────────────────────────────

  /** Compute comprehensive analytics across all recorded trades. */
  async getStats(): Promise<JournalStats> {
    const entries = await this.readAll();

    if (entries.length === 0) {
      return {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        winRate: 0,
        totalProfitUsd: 0,
        totalGasCostUsd: 0,
        netProfitUsd: 0,
        avgProfitUsd: 0,
        avgLossUsd: 0,
        bestTrade: null,
        worstTrade: null,
        avgExecutionTimeMs: 0,
        profitByStrategy: {},
        consecutiveWins: 0,
        consecutiveLosses: 0,
      };
    }

    const successful = entries.filter(e => e.success);
    const failed = entries.filter(e => !e.success);

    // Calculate profit-based wins/losses (actual_profit_usd > 0)
    const winningTrades = successful.filter(e => (e.actual_profit_usd ?? 0) > 0);
    const losingTrades = successful.filter(e => (e.actual_profit_usd ?? 0) < 0);

    const totalProfit = entries.reduce(
      (sum, e) => sum + (e.success ? (e.actual_profit_usd ?? 0) : 0), 0,
    );
    const totalGas = entries.reduce(
      (sum, e) => sum + (e.gas_cost_usd ?? 0), 0,
    );

    const avgProfit = winningTrades.length > 0
      ? winningTrades.reduce((s, e) => s + (e.actual_profit_usd ?? 0), 0) / winningTrades.length
      : 0;

    const avgLoss = losingTrades.length > 0
      ? losingTrades.reduce((s, e) => s + (e.actual_profit_usd ?? 0), 0) / losingTrades.length
      : 0;

    // Best / worst by actual_profit_usd
    const profitables = entries.filter(e => e.success);
    let bestTrade: JournalEntry | null = null;
    let worstTrade: JournalEntry | null = null;
    if (profitables.length > 0) {
      bestTrade = profitables.reduce((best, e) =>
        (e.actual_profit_usd ?? 0) > (best.actual_profit_usd ?? 0) ? e : best,
      );
      worstTrade = profitables.reduce((worst, e) =>
        (e.actual_profit_usd ?? 0) < (worst.actual_profit_usd ?? 0) ? e : worst,
      );
    }

    const avgExecTime = entries.reduce(
      (sum, e) => sum + (e.execution_time_ms ?? 0), 0,
    ) / entries.length;

    // Per-strategy breakdown
    const strategyMap: Record<string, { trades: number; wins: number; profit: number }> = {};
    for (const e of entries) {
      const s = e.strategy || 'UNKNOWN';
      if (!strategyMap[s]) strategyMap[s] = { trades: 0, wins: 0, profit: 0 };
      strategyMap[s].trades++;
      if (e.success) {
        strategyMap[s].profit += e.actual_profit_usd ?? 0;
        if ((e.actual_profit_usd ?? 0) > 0) strategyMap[s].wins++;
      }
    }
    const profitByStrategy: Record<string, { trades: number; winRate: number; profit: number }> = {};
    for (const [key, val] of Object.entries(strategyMap)) {
      profitByStrategy[key] = {
        trades: val.trades,
        winRate: val.trades > 0 ? val.wins / val.trades : 0,
        profit: Math.round(val.profit * 100) / 100,
      };
    }

    // Consecutive wins/losses (from the end of the array)
    let consecutiveWins = 0;
    let consecutiveLosses = 0;
    // Walk backwards for consecutive wins
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.success && (e.actual_profit_usd ?? 0) > 0) {
        consecutiveWins++;
      } else {
        break;
      }
    }
    // Walk backwards for consecutive losses
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e.success || (e.actual_profit_usd ?? 0) <= 0) {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    return {
      totalTrades: entries.length,
      successfulTrades: successful.length,
      failedTrades: failed.length,
      winRate: entries.length > 0 ? successful.length / entries.length : 0,
      totalProfitUsd: Math.round(totalProfit * 100) / 100,
      totalGasCostUsd: Math.round(totalGas * 100) / 100,
      netProfitUsd: Math.round((totalProfit - totalGas) * 100) / 100,
      avgProfitUsd: Math.round(avgProfit * 100) / 100,
      avgLossUsd: Math.round(avgLoss * 100) / 100,
      bestTrade,
      worstTrade,
      avgExecutionTimeMs: Math.round(avgExecTime * 100) / 100,
      profitByStrategy,
      consecutiveWins,
      consecutiveLosses,
    };
  }

  // ── Filter by Date Range ──────────────────────────────────────

  /** Return entries whose signal_timestamp falls within [start, end]. */
  async getByDateRange(start: number, end: number): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter(
      e => e.signal_timestamp >= start && e.signal_timestamp <= end,
    );
  }

  // ── Filter by Strategy ────────────────────────────────────────

  /** Return entries matching the given strategy name. */
  async getByStrategy(strategy: string): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter(e => e.strategy === strategy);
  }

  // ── CSV Export ────────────────────────────────────────────────

  /** Export all entries to a CSV file and return the output path. */
  async exportCsv(outputPath: string): Promise<string> {
    const entries = await this.readAll();
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    const headers = [
      'signal_id', 'success', 'strategy', 'route_summary',
      'input_token', 'input_amount', 'expected_profit_usd',
      'actual_profit_usd', 'profit_delta_usd', 'gas_cost_usd',
      'net_profit_usd', 'confidence', 'signal_timestamp',
      'execution_timestamp', 'latency_ms', 'tx_hash',
      'execution_time_ms', 'block_number', 'error',
    ];

    const escapeCsv = (val: unknown): string => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = entries.map(e => [
      e.signal_id, e.success, e.strategy, e.route_summary,
      e.input_token, e.input_amount, e.expected_profit_usd,
      e.actual_profit_usd, e.profit_delta_usd, e.gas_cost_usd,
      e.net_profit_usd, e.confidence, e.signal_timestamp,
      e.execution_timestamp, e.latency_ms, e.tx_hash ?? '',
      e.execution_time_ms, e.block_number ?? '', e.error ?? '',
    ].map(escapeCsv).join(','));

    const csv = [headers.join(','), ...rows].join('\n') + '\n';
    await fs.writeFile(outputPath, csv, 'utf-8');
    return outputPath;
  }

  // ── Recent Entries ────────────────────────────────────────────

  /** Return the last N entries from the journal. */
  async getRecent(limit: number): Promise<JournalEntry[]> {
    if (limit <= 0) return [];
    const entries = await this.readAll();
    return entries.slice(-limit);
  }
}
