/**
 * Risk Manager — Pre-trade safety checks, circuit breakers, and loss protection.
 *
 * Validates incoming OpportunitySignals against configurable safety thresholds
 * before execution. Tracks trade outcomes to trigger circuit breakers on
 * consecutive failures and daily loss limits.
 *
 * Usage:
 *   import { riskManager } from './risk-manager.js';
 *   const { approved, reasons } = riskManager.validateSignal(signal);
 *   if (approved) { executeTrade(signal); }
 *   riskManager.recordTrade({ signal_id, timestamp, profit_usd, success, error_message });
 */

import type { OpportunitySignal } from './grpc-client.js';

// ─── Configuration ──────────────────────────────────────────────────

export interface RiskConfig {
  /** Minimum net profit in USD after all costs */
  minProfitUsd: number;
  /** Minimum spread in basis points */
  minSpreadBps: number;
  /** Minimum signal confidence (0–1) */
  minConfidence: number;
  /** Maximum position size in USD */
  maxPositionUsd: number;
  /** Maximum leverage multiplier */
  maxLeverage: number;
  /** Minimum Aave health factor */
  minHealthFactor: number;
  /** Consecutive failures before circuit breaker triggers */
  maxConsecutiveFailures: number;
  /** Circuit breaker pause duration in minutes */
  circuitBreakerPauseMinutes: number;
  /** Daily loss limit in USD */
  dailyLossLimitUsd: number;
  /** Daily loss pause duration in hours */
  dailyLossPauseHours: number;
  /** Maximum number of trades per day */
  maxTradesPerDay: number;
  /** Maximum slippage tolerance in basis points */
  slippageToleranceBps: number;
  /** Maximum gas price in gwei (Base typically < 1) */
  gasPriceMaxGwei: number;
  /** Token addresses that should never be traded */
  tokenBlacklist: string[];
}

export const DEFAULT_CONFIG: RiskConfig = {
  minProfitUsd: 0.10,
  minSpreadBps: 15,
  minConfidence: 0.3,
  maxPositionUsd: 200,
  maxLeverage: 3,
  minHealthFactor: 1.1,
  maxConsecutiveFailures: 3,
  circuitBreakerPauseMinutes: 30,
  dailyLossLimitUsd: 100,
  dailyLossPauseHours: 24,
  maxTradesPerDay: 100,
  slippageToleranceBps: 50,
  gasPriceMaxGwei: 1.0,
  tokenBlacklist: [],
};

// ─── Trade Record ───────────────────────────────────────────────────

export interface TradeRecord {
  signal_id: string;
  timestamp: number;
  profit_usd: number;
  success: boolean;
  error_message?: string;
}

// ─── Risk State ────────────────────────────────────────────────────

export interface RiskState {
  consecutiveFailures: number;
  circuitBreakerActive: boolean;
  circuitBreakerResumesAt: number | null;
  dailyLossUsd: number;
  dailyLossResetAt: number;
  dailyTradeCount: number;
  tradeHistory: TradeRecord[];
  isPaused: boolean;
}

// ─── Validation Result ─────────────────────────────────────────────

export interface ValidationResult {
  approved: boolean;
  reasons: string[];
}

// ─── Circuit Breaker Status ────────────────────────────────────────

export interface CircuitBreakerStatus {
  active: boolean;
  resumesAt: number | null;
  reason: string;
}

// ─── Daily Stats ───────────────────────────────────────────────────

export interface DailyStats {
  trades: number;
  profit: number;
  loss: number;
  winRate: number;
}

// ─── Helper: normalise address to lowercase ────────────────────────

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

// ─── RiskManager ───────────────────────────────────────────────────

export class RiskManager {
  private config: RiskConfig;
  private state: RiskState;
  private blacklistedSet: Set<string>;

  constructor(config?: Partial<RiskConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.blacklistedSet = new Set(
      this.config.tokenBlacklist.map(normalizeAddress),
    );
    this.state = {
      consecutiveFailures: 0,
      circuitBreakerActive: false,
      circuitBreakerResumesAt: null,
      dailyLossUsd: 0,
      dailyLossResetAt: this.startOfToday(),
      dailyTradeCount: 0,
      tradeHistory: [],
      isPaused: false,
    };
  }

  // ── Signal Validation ──────────────────────────────────────────

  /**
   * Validate an incoming signal against all safety checks.
   * Returns approval status with reasons for any rejections.
   */
  validateSignal(signal: OpportunitySignal): ValidationResult {
    const reasons: string[] = [];
    const now = Date.now();

    // Refresh daily counters if day rolled over
    this.maybeResetDaily(now);

    // Auto-resume circuit breaker if pause period elapsed
    this.maybeAutoResumeCircuitBreaker(now);

    // ── System-level checks ───────────────────────────────────

    if (this.state.isPaused) {
      reasons.push('System is manually paused');
    }

    if (this.state.circuitBreakerActive) {
      const remaining = this.state.circuitBreakerResumesAt!
        ? Math.ceil((this.state.circuitBreakerResumesAt! - now) / 60_000)
        : 'unknown';
      reasons.push(
        `Circuit breaker active (resumes in ${remaining} min)`,
      );
    }

    if (this.state.dailyLossUsd <= -this.config.dailyLossLimitUsd) {
      reasons.push(
        `Daily loss limit reached ($${Math.abs(this.state.dailyLossUsd).toFixed(2)} / $${this.config.dailyLossLimitUsd})`,
      );
    }

    if (this.state.dailyTradeCount >= this.config.maxTradesPerDay) {
      reasons.push(
        `Daily trade limit reached (${this.state.dailyTradeCount} / ${this.config.maxTradesPerDay})`,
      );
    }

    // ── Signal-level checks ───────────────────────────────────

    const netProfit = parseFloat(signal.net_profit_usd);
    if (Number.isNaN(netProfit) || netProfit < this.config.minProfitUsd) {
      reasons.push(
        `Net profit $${netProfit.toFixed(4)} below minimum $${this.config.minProfitUsd}`,
      );
    }

    if (signal.expected_profit_bps < this.config.minSpreadBps) {
      reasons.push(
        `Spread ${signal.expected_profit_bps} bps below minimum ${this.config.minSpreadBps} bps`,
      );
    }

    if (signal.confidence < this.config.minConfidence) {
      reasons.push(
        `Confidence ${signal.confidence.toFixed(2)} below minimum ${this.config.minConfidence}`,
      );
    }

    if (signal.expires_at * 1000 <= now) {
      reasons.push('Signal expired');
    }

    // Position size check — parse input_amount as approximate USD if possible
    const inputAmount = parseFloat(signal.input_amount);
    if (!Number.isNaN(inputAmount) && inputAmount > this.config.maxPositionUsd) {
      reasons.push(
        `Position size $${inputAmount.toFixed(2)} exceeds max $${this.config.maxPositionUsd}`,
      );
    }

    // Token blacklist — check input token and all route tokens
    const inputLower = normalizeAddress(signal.input_token);
    if (this.blacklistedSet.has(inputLower)) {
      reasons.push(`Input token ${signal.input_token} is blacklisted`);
    }

    for (const hop of signal.route) {
      const inLower = normalizeAddress(hop.token_in);
      const outLower = normalizeAddress(hop.token_out);
      if (this.blacklistedSet.has(inLower)) {
        reasons.push(`Route token ${hop.token_in} is blacklisted`);
      }
      if (this.blacklistedSet.has(outLower)) {
        reasons.push(`Route token ${hop.token_out} is blacklisted`);
      }
    }

    return {
      approved: reasons.length === 0,
      reasons,
    };
  }

  // ── Trade Recording ────────────────────────────────────────────

  /**
   * Record the outcome of a trade. Updates internal state for
   * circuit breakers and daily limits.
   */
  recordTrade(record: TradeRecord): void {
    this.state.tradeHistory.push(record);
    this.state.dailyTradeCount++;

    if (record.success) {
      this.state.consecutiveFailures = 0;
      if (record.profit_usd > 0) {
        this.state.dailyLossUsd += record.profit_usd;
      }
    } else {
      this.state.consecutiveFailures++;
      if (record.profit_usd < 0) {
        this.state.dailyLossUsd += record.profit_usd; // profit_usd is negative
      }

      // Trigger circuit breaker on consecutive failures
      if (
        this.state.consecutiveFailures >= this.config.maxConsecutiveFailures &&
        !this.state.circuitBreakerActive
      ) {
        this.state.circuitBreakerActive = true;
        this.state.circuitBreakerResumesAt =
          Date.now() + this.config.circuitBreakerPauseMinutes * 60_000;
      }
    }

    // Trigger daily loss pause
    if (
      this.state.dailyLossUsd <= -this.config.dailyLossLimitUsd &&
      !this.state.circuitBreakerActive
    ) {
      this.state.circuitBreakerActive = true;
      this.state.circuitBreakerResumesAt =
        Date.now() + this.config.dailyLossPauseHours * 3_600_000;
      // Note: daily loss pause uses the same circuit breaker mechanism
      // but with the longer daily-loss-pause duration.
    }
  }

  // ── State Access ───────────────────────────────────────────────

  /** Get a snapshot of the current risk state. */
  getState(): RiskState {
    return { ...this.state };
  }

  /** Get circuit breaker status with human-readable reason. */
  getCircuitBreakerStatus(): CircuitBreakerStatus {
    if (!this.state.circuitBreakerActive) {
      return {
        active: false,
        resumesAt: null,
        reason: 'Circuit breaker not active',
      };
    }

    const resumeTime = this.state.circuitBreakerResumesAt ?? 0;
    const isDailyLoss = this.state.dailyLossUsd <= -this.config.dailyLossLimitUsd;
    const reason = isDailyLoss
      ? `Daily loss limit reached ($${Math.abs(this.state.dailyLossUsd).toFixed(2)})`
      : `${this.state.consecutiveFailures} consecutive failures`;

    return {
      active: true,
      resumesAt: resumeTime,
      reason,
    };
  }

  /** Get today's trade statistics. */
  getDailyStats(): DailyStats {
    this.maybeResetDaily(Date.now());

    const trades = this.state.dailyTradeCount;
    const profit = this.state.tradeHistory
      .filter((t) => t.profit_usd > 0)
      .reduce((sum, t) => sum + t.profit_usd, 0);
    const loss = this.state.tradeHistory
      .filter((t) => t.profit_usd < 0)
      .reduce((sum, t) => sum + Math.abs(t.profit_usd), 0);
    const wins = this.state.tradeHistory.filter(
      (t) => t.success && t.profit_usd > 0,
    ).length;
    const total = this.state.tradeHistory.length;

    return {
      trades,
      profit,
      loss,
      winRate: total > 0 ? wins / total : 0,
    };
  }

  /**
   * Whether the system is ready to accept new signals.
   * Not paused, not in circuit breaker, not over daily limits.
   */
  isReady(): boolean {
    this.maybeResetDaily(Date.now());
    this.maybeAutoResumeCircuitBreaker(Date.now());

    return (
      !this.state.isPaused &&
      !this.state.circuitBreakerActive &&
      this.state.dailyLossUsd > -this.config.dailyLossLimitUsd &&
      this.state.dailyTradeCount < this.config.maxTradesPerDay
    );
  }

  // ── Manual Controls ────────────────────────────────────────────

  /** Manually pause all trading. */
  pause(): void {
    this.state.isPaused = true;
  }

  /** Resume from manual pause. */
  resume(): void {
    this.state.isPaused = false;
  }

  /** Reset daily counters (useful for testing or manual reset). */
  resetDaily(): void {
    this.state.dailyLossUsd = 0;
    this.state.dailyTradeCount = 0;
    this.state.dailyLossResetAt = this.startOfToday();
    // Keep only today's trade history for stats accuracy
    const todayStart = this.startOfToday();
    this.state.tradeHistory = this.state.tradeHistory.filter(
      (t) => t.timestamp >= todayStart,
    );
  }

  // ── Internal Helpers ───────────────────────────────────────────

  /** Auto-resume circuit breaker if the pause period has elapsed. */
  private maybeAutoResumeCircuitBreaker(now: number): void {
    if (
      this.state.circuitBreakerActive &&
      this.state.circuitBreakerResumesAt !== null &&
      now >= this.state.circuitBreakerResumesAt
    ) {
      this.state.circuitBreakerActive = false;
      this.state.circuitBreakerResumesAt = null;
      this.state.consecutiveFailures = 0;
    }
  }

  /** Reset daily counters if the day has rolled over. */
  private maybeResetDaily(now: number): void {
    const todayStart = this.startOfToday();
    if (this.state.dailyLossResetAt < todayStart) {
      this.state.dailyLossUsd = 0;
      this.state.dailyTradeCount = 0;
      this.state.dailyLossResetAt = todayStart;
      this.state.tradeHistory = this.state.tradeHistory.filter(
        (t) => t.timestamp >= todayStart,
      );
    }
  }

  /** Get timestamp for start of today (midnight UTC). */
  private startOfToday(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}

// ─── Factory & Singleton ───────────────────────────────────────────

/** Create a new RiskManager with optional config overrides. */
export function createRiskManager(config?: Partial<RiskConfig>): RiskManager {
  return new RiskManager(config);
}

/** Default singleton instance with standard safety thresholds. */
export const riskManager = new RiskManager();
