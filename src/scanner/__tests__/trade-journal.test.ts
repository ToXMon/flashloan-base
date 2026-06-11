/**
 * Trade Journal Tests — node:test suite for TradeJournal class.
 *
 * Covers: append/readAll, stats, date range filter, strategy filter,
 * CSV export, file rotation, empty journal, and getRecent.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { TradeJournal, type JournalEntry } from '../trade-journal.js';

// ─── Helpers ───────────────────────────────────────────────────────

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    success: true,
    signal_id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tx_hash: '0x' + 'ab'.repeat(32),
    profit_usd: 1.5,
    gas_cost_usd: 0.01,
    execution_time_ms: 150,
    block_number: 12345678,
    strategy: 'TRIANGLE_ARB',
    route_summary: 'WETH→USDC→DAI→WETH',
    input_token: '0x4200000000000000000000000000000000000006',
    input_amount: '1000000000000000000',
    expected_profit_usd: 1.0,
    actual_profit_usd: 1.5,
    profit_delta_usd: 0.5,
    net_profit_usd: 1.49,
    confidence: 0.85,
    signal_timestamp: Date.now(),
    execution_timestamp: Date.now(),
    latency_ms: 150,
    ...overrides,
  };
}

// ─── Test Suite ────────────────────────────────────────────────────

describe('TradeJournal', () => {
  let tmpDir: string;
  let journalPath: string;
  let journal: TradeJournal;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tj-test-'));
    journalPath = path.join(tmpDir, 'trades.jsonl');
    journal = new TradeJournal(journalPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── a. append and readAll ─────────────────────────────────────

  it('append and readAll — writes 3 entries, reads them back', async () => {
    const entries = [
      makeEntry({ signal_id: 'sig-1' }),
      makeEntry({ signal_id: 'sig-2' }),
      makeEntry({ signal_id: 'sig-3' }),
    ];

    for (const e of entries) {
      await journal.append(e);
    }

    const read = await journal.readAll();
    assert.equal(read.length, 3);
    assert.equal(read[0].signal_id, 'sig-1');
    assert.equal(read[1].signal_id, 'sig-2');
    assert.equal(read[2].signal_id, 'sig-3');
  });

  // ── b. stats calculation ──────────────────────────────────────

  it('stats calculation — winRate, totalProfit, avgProfit, avgLoss, consecutive', async () => {
    const now = Date.now();
    const entries: JournalEntry[] = [
      makeEntry({
        success: true, signal_id: 'w1', actual_profit_usd: 2.0,
        profit_usd: 2.0, gas_cost_usd: 0.05, net_profit_usd: 1.95,
        execution_time_ms: 100, strategy: 'TRIANGLE_ARB',
        signal_timestamp: now - 5000,
      }),
      makeEntry({
        success: true, signal_id: 'w2', actual_profit_usd: 3.0,
        profit_usd: 3.0, gas_cost_usd: 0.05, net_profit_usd: 2.95,
        execution_time_ms: 200, strategy: 'TRIANGLE_ARB',
        signal_timestamp: now - 4000,
      }),
      makeEntry({
        success: false, signal_id: 'f1', actual_profit_usd: 0,
        profit_usd: 0, gas_cost_usd: 0.05, net_profit_usd: -0.05,
        error: 'reverted', execution_time_ms: 50, strategy: 'CROSS_DEX_ARB',
        signal_timestamp: now - 3000,
      }),
      makeEntry({
        success: true, signal_id: 'l1', actual_profit_usd: -1.0,
        profit_usd: -1.0, gas_cost_usd: 0.05, net_profit_usd: -1.05,
        execution_time_ms: 150, strategy: 'CROSS_DEX_ARB',
        signal_timestamp: now - 2000,
      }),
      makeEntry({
        success: true, signal_id: 'w3', actual_profit_usd: 1.5,
        profit_usd: 1.5, gas_cost_usd: 0.05, net_profit_usd: 1.45,
        execution_time_ms: 120, strategy: 'TRIANGLE_ARB',
        signal_timestamp: now - 1000,
      }),
    ];

    for (const e of entries) {
      await journal.append(e);
    }

    const stats = await journal.getStats();

    // 5 total, 4 successful, 1 failed
    assert.equal(stats.totalTrades, 5);
    assert.equal(stats.successfulTrades, 4);
    assert.equal(stats.failedTrades, 1);
    assert.equal(stats.winRate, 4 / 5);

    // totalProfit = sum of actual_profit for successful trades = 2+3+(-1)+1.5 = 5.5
    assert.equal(stats.totalProfitUsd, 5.5);

    // totalGas = 5 * 0.05 = 0.25
    assert.equal(stats.totalGasCostUsd, 0.25);

    // net = 5.5 - 0.25 = 5.25
    assert.equal(stats.netProfitUsd, 5.25);

    // winning trades: w1(2.0), w2(3.0), w3(1.5) → avg = 6.5/3 ≈ 2.17
    assert.equal(stats.avgProfitUsd, Math.round((2 + 3 + 1.5) / 3 * 100) / 100);

    // losing trades: l1(-1.0) → avg = -1.0
    assert.equal(stats.avgLossUsd, -1.0);

    // Best trade: w2 with 3.0
    assert.ok(stats.bestTrade);
    assert.equal(stats.bestTrade.signal_id, 'w2');

    // Worst trade: l1 with -1.0
    assert.ok(stats.worstTrade);
    assert.equal(stats.worstTrade.signal_id, 'l1');

    // avg execution time = (100+200+50+150+120)/5 = 124
    assert.equal(stats.avgExecutionTimeMs, 124);

    // Consecutive: last entry is w3 (success, profit>0), so consecutiveWins=1
    assert.equal(stats.consecutiveWins, 1);
    assert.equal(stats.consecutiveLosses, 0);

    // Strategy breakdown
    assert.ok(stats.profitByStrategy['TRIANGLE_ARB']);
    assert.ok(stats.profitByStrategy['CROSS_DEX_ARB']);
  });

  // ── c. date range filtering ───────────────────────────────────

  it('getByDateRange — filters by signal_timestamp range', async () => {
    const base = 1000000;
    const entries = [
      makeEntry({ signal_id: 'old', signal_timestamp: base - 1000 }),
      makeEntry({ signal_id: 'start', signal_timestamp: base }),
      makeEntry({ signal_id: 'mid', signal_timestamp: base + 500 }),
      makeEntry({ signal_id: 'end', signal_timestamp: base + 1000 }),
      makeEntry({ signal_id: 'future', signal_timestamp: base + 2000 }),
    ];

    for (const e of entries) {
      await journal.append(e);
    }

    const filtered = await journal.getByDateRange(base, base + 1000);
    assert.equal(filtered.length, 3);
    const ids = filtered.map(e => e.signal_id);
    assert.ok(ids.includes('start'));
    assert.ok(ids.includes('mid'));
    assert.ok(ids.includes('end'));
    assert.ok(!ids.includes('old'));
    assert.ok(!ids.includes('future'));
  });

  // ── d. strategy filtering ─────────────────────────────────────

  it('getByStrategy — filters by strategy name', async () => {
    const entries = [
      makeEntry({ signal_id: 't1', strategy: 'TRIANGLE_ARB' }),
      makeEntry({ signal_id: 'c1', strategy: 'CROSS_DEX_ARB' }),
      makeEntry({ signal_id: 't2', strategy: 'TRIANGLE_ARB' }),
      makeEntry({ signal_id: 'm1', strategy: 'MEMECOIN' }),
    ];

    for (const e of entries) {
      await journal.append(e);
    }

    const tri = await journal.getByStrategy('TRIANGLE_ARB');
    assert.equal(tri.length, 2);
    assert.ok(tri.every(e => e.strategy === 'TRIANGLE_ARB'));

    const cross = await journal.getByStrategy('CROSS_DEX_ARB');
    assert.equal(cross.length, 1);
    assert.equal(cross[0].signal_id, 'c1');

    const mem = await journal.getByStrategy('MEMECOIN');
    assert.equal(mem.length, 1);

    const none = await journal.getByStrategy('NONEXISTENT');
    assert.equal(none.length, 0);
  });

  // ── e. CSV export ─────────────────────────────────────────────

  it('exportCsv — writes valid CSV with headers and rows', async () => {
    const entries = [
      makeEntry({ signal_id: 'csv-1', strategy: 'TRIANGLE_ARB' }),
      makeEntry({ signal_id: 'csv-2', strategy: 'CROSS_DEX_ARB' }),
    ];

    for (const e of entries) {
      await journal.append(e);
    }

    const csvPath = path.join(tmpDir, 'export.csv');
    const result = await journal.exportCsv(csvPath);
    assert.equal(result, csvPath);

    const csv = await fs.readFile(csvPath, 'utf-8');
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 3); // header + 2 rows

    // Verify header
    const headers = lines[0].split(',');
    assert.ok(headers.includes('signal_id'));
    assert.ok(headers.includes('strategy'));
    assert.ok(headers.includes('actual_profit_usd'));

    // Verify signal IDs present in data rows
    assert.ok(lines[1].includes('csv-1'));
    assert.ok(lines[2].includes('csv-2'));
  });

  // ── f. file rotation ──────────────────────────────────────────

  it('file rotation — rotates when file exceeds size limit', async () => {
    // Use a custom journal with a small rotation override via direct file manipulation.
    // We write a file that's already > 10 MB, then append and check rotation.
    const smallRotationJournal = new TradeJournal(journalPath);

    // Create a file larger than 10 MB by writing big entries
    // Each entry ~500 bytes. 10MB = ~20,000 entries. Too slow.
    // Instead, create a large file directly, then let append trigger rotation.
    const bigLine = JSON.stringify({ ...makeEntry(), padding: 'x'.repeat(500) }) + '\n';
    const neededLines = Math.ceil((10 * 1024 * 1024) / bigLine.length) + 1;

    // Write in bulk for speed
    const fd = await fs.open(journalPath, 'w');
    try {
      for (let i = 0; i < neededLines; i++) {
        await fd.write(bigLine);
      }
      await fd.sync();
    } finally {
      await fd.close();
    }

    // Verify file is large
    const statBefore = await fs.stat(journalPath);
    assert.ok(statBefore.size >= 10 * 1024 * 1024, 'Pre-condition: file must be >= 10MB');

    // Now append one more entry — should trigger rotation
    await smallRotationJournal.append(makeEntry({ signal_id: 'post-rotation' }));

    // The original file should now be small (only the new entry)
    const statAfter = await fs.stat(journalPath);
    assert.ok(statAfter.size < 10 * 1024 * 1024, 'After rotation, file should be small');

    // A rotated file should exist in the same directory
    const files = await fs.readdir(tmpDir);
    const rotatedFiles = files.filter(f => f.startsWith('trades-') && f.endsWith('.jsonl'));
    assert.equal(rotatedFiles.length, 1, 'Should have one rotated file');

    // New entry should be readable
    const entries = await smallRotationJournal.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].signal_id, 'post-rotation');
  });

  // ── g. empty journal ──────────────────────────────────────────

  it('getStats on empty file — returns zeros and nulls', async () => {
    // Don't write anything
    const stats = await journal.getStats();
    assert.equal(stats.totalTrades, 0);
    assert.equal(stats.successfulTrades, 0);
    assert.equal(stats.failedTrades, 0);
    assert.equal(stats.winRate, 0);
    assert.equal(stats.totalProfitUsd, 0);
    assert.equal(stats.totalGasCostUsd, 0);
    assert.equal(stats.netProfitUsd, 0);
    assert.equal(stats.avgProfitUsd, 0);
    assert.equal(stats.avgLossUsd, 0);
    assert.equal(stats.bestTrade, null);
    assert.equal(stats.worstTrade, null);
    assert.equal(stats.avgExecutionTimeMs, 0);
    assert.equal(stats.consecutiveWins, 0);
    assert.equal(stats.consecutiveLosses, 0);
    assert.deepStrictEqual(stats.profitByStrategy, {});
  });

  // ── h. getRecent ──────────────────────────────────────────────

  it('getRecent — returns last N entries', async () => {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const e = makeEntry({ signal_id: `recent-${i}` });
      entries.push(e);
      await journal.append(e);
    }

    const recent3 = await journal.getRecent(3);
    assert.equal(recent3.length, 3);
    assert.equal(recent3[0].signal_id, 'recent-7');
    assert.equal(recent3[1].signal_id, 'recent-8');
    assert.equal(recent3[2].signal_id, 'recent-9');

    // Request more than available
    const recent20 = await journal.getRecent(20);
    assert.equal(recent20.length, 10);

    // Request 0
    const recent0 = await journal.getRecent(0);
    assert.equal(recent0.length, 0);
  });
});
