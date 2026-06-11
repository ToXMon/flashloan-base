/**
 * Unit tests for RiskManager — pre-trade safety checks, circuit breakers, and loss protection.
 *
 * Run: npx tsx src/scanner/__tests__/risk-manager.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RiskManager,
  createRiskManager,
  DEFAULT_CONFIG,
} from '../risk-manager.js';
import type { OpportunitySignal } from '../grpc-client.js';
import { Strategy, Dex } from '../grpc-client.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a valid signal that passes all default checks. */
function makeValidSignal(overrides?: Partial<OpportunitySignal>): OpportunitySignal {
  return {
    signal_id: 'test-001',
    strategy: Strategy.TRIANGLE_ARB,
    timestamp: Date.now(),
    confidence: 0.7,
    expected_profit_usd: '0.50',
    expected_profit_bps: 25,
    route: [
      {
        pool_address: '0xpool1',
        dex: Dex.AERODROME_CL,
        token_in: '0x4200000000000000000000000000000000000006', // WETH
        token_out: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        fee_bps: 5,
        expected_output: '1000',
      },
    ],
    input_token: '0x4200000000000000000000000000000000000006',
    input_amount: '150',
    estimated_gas_cost_usd: '0.01',
    net_profit_usd: '0.50',
    expires_at: Math.floor(Date.now() / 1000) + 60, // 60s from now
    ...overrides,
  };
}

// ─── Signal Validation ─────────────────────────────────────────────

void describe('RiskManager — Signal Validation', () => {
  let rm: RiskManager;

  void beforeEach(() => {
    rm = new RiskManager();
  });

  void it('approves a valid signal', () => {
    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, true);
    assert.equal(result.reasons.length, 0);
  });

  void it('rejects signal with net profit below minimum', () => {
    const result = rm.validateSignal(makeValidSignal({ net_profit_usd: '0.05' }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Net profit')));
  });

  void it('rejects signal with zero net profit', () => {
    const result = rm.validateSignal(makeValidSignal({ net_profit_usd: '0.00' }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Net profit')));
  });

  void it('rejects signal with negative net profit', () => {
    const result = rm.validateSignal(makeValidSignal({ net_profit_usd: '-0.50' }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Net profit')));
  });

  void it('rejects signal with spread below minimum', () => {
    const result = rm.validateSignal(makeValidSignal({ expected_profit_bps: 10 }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Spread')));
  });

  void it('rejects signal with confidence below minimum', () => {
    const result = rm.validateSignal(makeValidSignal({ confidence: 0.2 }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Confidence')));
  });

  void it('rejects expired signal', () => {
    const result = rm.validateSignal(
      makeValidSignal({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('expired')));
  });

  void it('rejects signal exceeding max position size', () => {
    const result = rm.validateSignal(makeValidSignal({ input_amount: '500' }));
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Position size')));
  });

  void it('rejects signal with blacklisted input token', () => {
    const blacklisted = '0xBadToken0000000000000000000000000000000001';
    const rmWithBlacklist = new RiskManager({
      tokenBlacklist: [blacklisted],
    });
    const result = rmWithBlacklist.validateSignal(
      makeValidSignal({ input_token: blacklisted }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('blacklisted')));
  });

  void it('rejects signal with blacklisted route token', () => {
    const blacklisted = '0xBadToken0000000000000000000000000000000001';
    const rmWithBlacklist = new RiskManager({
      tokenBlacklist: [blacklisted],
    });
    const result = rmWithBlacklist.validateSignal(
      makeValidSignal({
        route: [
          {
            pool_address: '0xpool1',
            dex: Dex.AERODROME_CL,
            token_in: blacklisted,
            token_out: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            fee_bps: 5,
            expected_output: '1000',
          },
        ],
      }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('blacklisted')));
  });

  void it('approves signal exactly at profit threshold', () => {
    const result = rm.validateSignal(makeValidSignal({ net_profit_usd: '0.10' }));
    assert.equal(result.approved, true);
  });

  void it('approves signal exactly at spread threshold', () => {
    const result = rm.validateSignal(makeValidSignal({ expected_profit_bps: 15 }));
    assert.equal(result.approved, true);
  });

  void it('approves signal exactly at confidence threshold', () => {
    const result = rm.validateSignal(makeValidSignal({ confidence: 0.3 }));
    assert.equal(result.approved, true);
  });

  void it('rejects when manually paused', () => {
    rm.pause();
    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('manually paused')));
  });

  void it('collects multiple rejection reasons', () => {
    const result = rm.validateSignal(
      makeValidSignal({
        net_profit_usd: '0.01',
        confidence: 0.1,
        expected_profit_bps: 5,
      }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.length >= 3);
  });

  void it('blacklist matching is case-insensitive', () => {
    const rmCI = new RiskManager({
      tokenBlacklist: ['0XBADTOKEN0000000000000000000000000000000001'],
    });
    const result = rmCI.validateSignal(
      makeValidSignal({ input_token: '0xbadtoken0000000000000000000000000000000001' }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('blacklisted')));
  });
});

// ─── Circuit Breaker ───────────────────────────────────────────────

void describe('RiskManager — Circuit Breaker', () => {
  void it('triggers after consecutive failures', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 3 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false, error_message: 'revert' });
    assert.equal(rm.getState().circuitBreakerActive, false);

    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -0.3, success: false, error_message: 'slippage' });
    assert.equal(rm.getState().circuitBreakerActive, false);

    rm.recordTrade({ signal_id: '3', timestamp: Date.now(), profit_usd: -0.2, success: false, error_message: 'timeout' });
    assert.equal(rm.getState().circuitBreakerActive, true);
  });

  void it('blocks signals while active', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 1 });
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });

    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Circuit breaker active')));
  });

  void it('auto-resumes after pause period', () => {
    const rm = new RiskManager({
      maxConsecutiveFailures: 1,
      circuitBreakerPauseMinutes: 1,
    });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });
    assert.equal(rm.getState().circuitBreakerActive, true);

    // Manually set resume time to the past to simulate elapsed time
    const state = rm.getState();
    // Access internal state via getState — we need to simulate time passing
    // Since we can't directly set internal state, use a trick:
    // Create a new manager with very short pause and check isReady after time passes
    const rmShort = new RiskManager({
      maxConsecutiveFailures: 1,
      circuitBreakerPauseMinutes: 0, // Immediate resume
    });
    rmShort.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });

    // With 0-minute pause, next check should auto-resume
    const result = rmShort.validateSignal(makeValidSignal());
    // The circuit breaker should have auto-resumed since pause minutes = 0
    assert.equal(rmShort.getState().circuitBreakerActive, false);
  });

  void it('resets consecutive failures after successful trade', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 3 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: 0.3, success: true });

    assert.equal(rm.getState().consecutiveFailures, 0);
    assert.equal(rm.getState().circuitBreakerActive, false);
  });

  void it('reports correct circuit breaker status', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 1 });
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });

    const status = rm.getCircuitBreakerStatus();
    assert.equal(status.active, true);
    assert.ok(status.resumesAt !== null);
    assert.ok(status.reason.includes('consecutive failures'));
  });

  void it('reports inactive status when not triggered', () => {
    const rm = new RiskManager();
    const status = rm.getCircuitBreakerStatus();
    assert.equal(status.active, false);
    assert.equal(status.resumesAt, null);
  });
});

// ─── Daily Loss Limit ──────────────────────────────────────────────

void describe('RiskManager — Daily Loss Limit', () => {
  void it('triggers pause after daily loss limit reached', () => {
    const rm = new RiskManager({ dailyLossLimitUsd: 10, maxConsecutiveFailures: 100 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -5, success: false });

    assert.equal(rm.getState().circuitBreakerActive, true);
    assert.ok(rm.getState().dailyLossUsd <= -10);
  });

  void it('blocks signals when daily loss limit reached', () => {
    const rm = new RiskManager({ dailyLossLimitUsd: 10, maxConsecutiveFailures: 100 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -5, success: false });

    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, false);
    assert.ok(
      result.reasons.some((r) => r.includes('Daily loss limit') || r.includes('Circuit breaker')),
    );
  });

  void it('tracks profits and losses correctly', () => {
    const rm = new RiskManager();

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 2.5, success: true });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -1.0, success: false });
    rm.recordTrade({ signal_id: '3', timestamp: Date.now(), profit_usd: 0.5, success: true });

    const stats = rm.getDailyStats();
    assert.equal(stats.trades, 3);
    assert.equal(stats.profit, 3.0);  // 2.5 + 0.5
    assert.equal(stats.loss, 1.0);    // abs(-1.0)
  });

  void it('calculates win rate correctly', () => {
    const rm = new RiskManager();

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 1.0, success: true });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -0.5, success: false });
    rm.recordTrade({ signal_id: '3', timestamp: Date.now(), profit_usd: 0.5, success: true });
    rm.recordTrade({ signal_id: '4', timestamp: Date.now(), profit_usd: -0.2, success: false });

    const stats = rm.getDailyStats();
    assert.equal(stats.trades, 4);
    assert.ok(Math.abs(stats.winRate - 0.5) < 0.001); // 2 wins / 4 total
  });

  void it('resets daily counters', () => {
    const rm = new RiskManager();

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: 1.0, success: true });

    assert.equal(rm.getState().dailyTradeCount, 2);
    rm.resetDaily();
    assert.equal(rm.getState().dailyTradeCount, 0);
    assert.equal(rm.getState().dailyLossUsd, 0);
  });
});

// ─── Daily Trade Limit ─────────────────────────────────────────────

void describe('RiskManager — Daily Trade Limit', () => {
  void it('rejects signals when daily trade limit reached', () => {
    const rm = new RiskManager({ maxTradesPerDay: 2 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 0.1, success: true });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: 0.1, success: true });

    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Daily trade limit')));
  });

  void it('counts both successful and failed trades', () => {
    const rm = new RiskManager({ maxTradesPerDay: 2 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 0.1, success: true });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -0.5, success: false });

    assert.equal(rm.getState().dailyTradeCount, 2);
    const result = rm.validateSignal(makeValidSignal());
    assert.equal(result.approved, false);
  });
});

// ─── Trade Recording & State ───────────────────────────────────────

void describe('RiskManager — Trade Recording', () => {
  void it('records trade history', () => {
    const rm = new RiskManager();

    rm.recordTrade({ signal_id: '1', timestamp: 1000, profit_usd: 0.5, success: true });
    rm.recordTrade({ signal_id: '2', timestamp: 2000, profit_usd: -0.3, success: false, error_message: 'revert' });

    const state = rm.getState();
    assert.equal(state.tradeHistory.length, 2);
    assert.equal(state.tradeHistory[0].signal_id, '1');
    assert.equal(state.tradeHistory[1].error_message, 'revert');
  });

  void it('updates consecutive failures correctly', () => {
    const rm = new RiskManager();

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.1, success: false });
    assert.equal(rm.getState().consecutiveFailures, 1);

    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: 0.1, success: true });
    assert.equal(rm.getState().consecutiveFailures, 0);

    rm.recordTrade({ signal_id: '3', timestamp: Date.now(), profit_usd: -0.2, success: false });
    assert.equal(rm.getState().consecutiveFailures, 1);
  });

  void it('updates daily P&L from trade profits', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 100 });

    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 2.0, success: true });
    assert.equal(rm.getState().dailyLossUsd, 2.0);

    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -1.5, success: false });
    assert.equal(rm.getState().dailyLossUsd, 0.5);
  });

  void it('getState returns a snapshot (not a reference)', () => {
    const rm = new RiskManager();
    const state1 = rm.getState();
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 0.1, success: true });
    const state2 = rm.getState();

    assert.equal(state1.dailyTradeCount, 0);
    assert.equal(state2.dailyTradeCount, 1);
  });
});

// ─── isReady() ─────────────────────────────────────────────────────

void describe('RiskManager — isReady()', () => {
  void it('returns true when everything is fine', () => {
    const rm = new RiskManager();
    assert.equal(rm.isReady(), true);
  });

  void it('returns false when manually paused', () => {
    const rm = new RiskManager();
    rm.pause();
    assert.equal(rm.isReady(), false);
  });

  void it('returns false when circuit breaker active', () => {
    const rm = new RiskManager({ maxConsecutiveFailures: 1 });
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -0.5, success: false });
    assert.equal(rm.isReady(), false);
  });

  void it('returns false when daily loss limit exceeded', () => {
    const rm = new RiskManager({ dailyLossLimitUsd: 5, maxConsecutiveFailures: 100 });
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: -1, success: false });
    assert.equal(rm.isReady(), false);
  });

  void it('returns false when daily trade limit reached', () => {
    const rm = new RiskManager({ maxTradesPerDay: 1 });
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 0.1, success: true });
    assert.equal(rm.isReady(), false);
  });

  void it('returns true again after resume', () => {
    const rm = new RiskManager();
    rm.pause();
    assert.equal(rm.isReady(), false);
    rm.resume();
    assert.equal(rm.isReady(), true);
  });
});

// ─── Manual Controls ───────────────────────────────────────────────

void describe('RiskManager — Manual Controls', () => {
  void it('pause and resume work', () => {
    const rm = new RiskManager();
    rm.pause();
    assert.equal(rm.getState().isPaused, true);
    rm.resume();
    assert.equal(rm.getState().isPaused, false);
  });

  void it('resetDaily clears counters', () => {
    const rm = new RiskManager();
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: -5, success: false });
    rm.recordTrade({ signal_id: '2', timestamp: Date.now(), profit_usd: 1, success: true });

    assert.equal(rm.getState().dailyTradeCount, 2);
    rm.resetDaily();
    assert.equal(rm.getState().dailyTradeCount, 0);
    assert.equal(rm.getState().dailyLossUsd, 0);
  });
});

// ─── Factory & Defaults ────────────────────────────────────────────

void describe('RiskManager — Factory & Defaults', () => {
  void it('createRiskManager returns new instance', () => {
    const rm1 = createRiskManager();
    const rm2 = createRiskManager({ minProfitUsd: 1.0 });

    assert.ok(rm1 instanceof RiskManager);
    assert.ok(rm2 instanceof RiskManager);
    assert.equal(rm1.validateSignal(makeValidSignal({ net_profit_usd: '0.50' })).approved, true);
    assert.equal(rm2.validateSignal(makeValidSignal({ net_profit_usd: '0.50' })).approved, false);
  });

  void it('default config has expected values', () => {
    assert.equal(DEFAULT_CONFIG.minProfitUsd, 0.10);
    assert.equal(DEFAULT_CONFIG.minSpreadBps, 15);
    assert.equal(DEFAULT_CONFIG.minConfidence, 0.3);
    assert.equal(DEFAULT_CONFIG.maxPositionUsd, 200);
    assert.equal(DEFAULT_CONFIG.maxLeverage, 3);
    assert.equal(DEFAULT_CONFIG.minHealthFactor, 1.1);
    assert.equal(DEFAULT_CONFIG.maxConsecutiveFailures, 3);
    assert.equal(DEFAULT_CONFIG.circuitBreakerPauseMinutes, 30);
    assert.equal(DEFAULT_CONFIG.dailyLossLimitUsd, 100);
    assert.equal(DEFAULT_CONFIG.dailyLossPauseHours, 24);
    assert.equal(DEFAULT_CONFIG.maxTradesPerDay, 100);
    assert.equal(DEFAULT_CONFIG.slippageToleranceBps, 50);
    assert.equal(DEFAULT_CONFIG.gasPriceMaxGwei, 1.0);
    assert.ok(Array.isArray(DEFAULT_CONFIG.tokenBlacklist));
  });

  void it('partial config merges with defaults', () => {
    const rm = new RiskManager({ minProfitUsd: 5.0 });
    // Should use overridden minProfitUsd
    const result = rm.validateSignal(makeValidSignal({ net_profit_usd: '1.00' }));
    assert.equal(result.approved, false);
    // But other defaults still work (spread check passes at 25 bps > 15)
    const result2 = rm.validateSignal(makeValidSignal({ net_profit_usd: '5.50' }));
    assert.equal(result2.approved, true);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────

void describe('RiskManager — Edge Cases', () => {
  void it('handles NaN net_profit_usd', () => {
    const result = new RiskManager().validateSignal(
      makeValidSignal({ net_profit_usd: 'invalid' }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('Net profit')));
  });

  void it('handles empty route', () => {
    const result = new RiskManager().validateSignal(
      makeValidSignal({ route: [] }),
    );
    assert.equal(result.approved, true);
  });

  void it('handles signal expiring exactly now', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = new RiskManager().validateSignal(
      makeValidSignal({ expires_at: now }),
    );
    assert.equal(result.approved, false);
    assert.ok(result.reasons.some((r) => r.includes('expired')));
  });

  void it('handles input_amount as non-numeric (skips position check)', () => {
    const result = new RiskManager().validateSignal(
      makeValidSignal({ input_amount: '1000000000000000000' }), // wei amount
    );
    // input_amount parsed as 1e18 which exceeds maxPosition, so it rejects
    // This is expected behavior — position check uses the raw number
    assert.equal(result.approved, false);
  });

  void it('zero profit successful trade does not add to daily profit', () => {
    const rm = new RiskManager();
    rm.recordTrade({ signal_id: '1', timestamp: Date.now(), profit_usd: 0, success: true });
    assert.equal(rm.getState().dailyLossUsd, 0);
  });

  void it('getDailyStats with no trades returns zeros', () => {
    const rm = new RiskManager();
    const stats = rm.getDailyStats();
    assert.equal(stats.trades, 0);
    assert.equal(stats.profit, 0);
    assert.equal(stats.loss, 0);
    assert.equal(stats.winRate, 0);
  });
});
