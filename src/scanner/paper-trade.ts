/**
 * PaperTradingEngine — Slice 5: Paper Trading
 *
 * Simulates directional trading with regime detection, trend scanning,
 * gating simulation, paper execution, and P&L tracking. No real funds
 * are used; all positions are paper-only.
 *
 * Flow: PriceData → Regime Detection → Trend Scan → Gating → Execution → P&L
 */

import type { DirectionalTrade } from './execution-engine.js';

// ─── Supporting Types ─────────────────────────────────────────────────────

export interface PriceData {
  token: string;
  close: number[];
  high: number[];
  low: number[];
  currentPrice: number;
  timestamp: number;
}

export interface RegimeResult {
  regime: string;
  confidence: number;
  reasons: string[];
}

export interface TrendSignal {
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  reason: string;
  token: string;
}

export interface GatingResult {
  approved: boolean;
  reasons: string[];
  confidenceWeight: number;
}

export interface PaperPosition {
  signalId: string;
  side: 'long' | 'short';
  entryPrice: number;
  sizeUsd: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  currentPrice: number;
  unrealizedPnl: number;
  regime: string;
  confidence: number;
}

export interface PaperOrderResult {
  success: boolean;
  signalId: string;
  position: PaperPosition | null;
  error?: string;
  executionTimeMs: number;
}

export interface PaperCloseResult {
  signalId: string;
  exitPrice: number;
  exitTime: number;
  realizedPnl: number;
  returnPct: number;
  reason: CloseReason;
  holdTimeMs: number;
}

export interface PaperPnLSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  avgHoldTimeMs: number;
  bestTrade: PaperCloseResult | null;
  worstTrade: PaperCloseResult | null;
  consecutiveWins: number;
  consecutiveLosses: number;
  openPositions: number;
}

export interface PaperEvent {
  timestamp: number;
  type: 'signal' | 'position_open' | 'position_close' | 'mark_to_market' | 'summary';
  data: any;
}

export type CloseReason = 'stop_loss' | 'take_profit' | 'manual' | 'signal_reversal';

// ─── Configuration ────────────────────────────────────────────────────────

export interface PaperTradingConfig {
  initialBalanceUsd: number;
  maxLeverage: number;
  minConfidence: number;
  maxConsecutiveLosses: number;
  maxRiskPerTradePct: number;
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  regimeNoTradeZones: string[];
}

export const DEFAULT_PAPER_CONFIG: PaperTradingConfig = {
  initialBalanceUsd: 10_000,
  maxLeverage: 3,
  minConfidence: 0.3,
  maxConsecutiveLosses: 2,
  maxRiskPerTradePct: 2,
  defaultStopLossPct: 0.05,
  defaultTakeProfitPct: 0.10,
  regimeNoTradeZones: ['erratic'],
};

// ─── SMA Helper ───────────────────────────────────────────────────────────

/** Simple Moving Average over a slice of the last `period` values. */
export function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += values[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

// ─── RSI Helper (Wilder's 14-period) ──────────────────────────────────────

/** Relative Strength Index using Wilder's smoothing. Returns NaN until 14 bars. */
export function rsi(values: number[], period: number = 14): number[] {
  const result: number[] = [];
  if (values.length < period + 1) {
    return values.map(() => NaN);
  }

  // First average gain/loss over initial period
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(NaN); // index 0 has no delta
  for (let i = 1; i <= period; i++) {
    result.push(NaN);
  }
  result.push(100 - 100 / (1 + firstRs));

  // Subsequent values with Wilder smoothing
  for (let i = period + 2; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }

  return result;
}

// ─── Momentum Helper ──────────────────────────────────────────────────────

/** Returns the percentage change over `lookback` periods. */
export function momentum(values: number[], lookback: number): number {
  if (values.length < lookback + 1) return 0;
  const prev = values[values.length - 1 - lookback];
  const curr = values[values.length - 1];
  return prev === 0 ? 0 : ((curr - prev) / prev) * 100;
}

// ─── PaperTradingEngine ───────────────────────────────────────────────────

export class PaperTradingEngine {
  private config: PaperTradingConfig;
  private positions: Map<string, PaperPosition>;
  private events: PaperEvent[];
  private closedTrades: PaperCloseResult[];
  private balance: number;
  private peakBalance: number;
  private consecutiveLosses: number;
  private consecutiveWins: number;
  private totalTrades: number;

  constructor(config?: Partial<PaperTradingConfig>) {
    this.config = { ...DEFAULT_PAPER_CONFIG, ...config };
    this.positions = new Map();
    this.events = [];
    this.closedTrades = [];
    this.balance = this.config.initialBalanceUsd;
    this.peakBalance = this.balance;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.totalTrades = 0;
  }

  // ── Regime Detection ───────────────────────────────────────────────

  /**
   * Detect market regime from price data using SMA crossovers, price vs SMA
   * range analysis, and momentum scoring.
   */
  detectRegime(data: PriceData): RegimeResult {
    const reasons: string[] = [];
    const { close } = data;

    if (close.length < 50) {
      return { regime: 'insufficient_data', confidence: 0, reasons: ['Need at least 50 price bars'] };
    }

    // SMA crossovers
    const sma10 = sma(close, 10);
    const sma50 = sma(close, 50);
    const sma200 = close.length >= 200 ? sma(close, 200) : null;

    const lastSma10 = sma10[sma10.length - 1];
    const lastSma50 = sma50[sma50.length - 1];
    const lastPrice = close[close.length - 1];

    if (isNaN(lastSma10) || isNaN(lastSma50)) {
      return { regime: 'insufficient_data', confidence: 0, reasons: ['SMA values not yet computable'] };
    }

    // Check SMA crossovers
    const prevSma10 = sma10[sma10.length - 2];
    const prevSma50 = sma50[sma50.length - 2];
    const bullishCross = !isNaN(prevSma10 ?? NaN) && prevSma10 <= prevSma50 && lastSma10 > lastSma50;
    const bearishCross = !isNaN(prevSma10 ?? NaN) && prevSma10 >= prevSma50 && lastSma10 < lastSma50;

    if (bullishCross) reasons.push('Golden cross (SMA10 crossed above SMA50)');
    if (bearishCross) reasons.push('Death cross (SMA10 crossed below SMA50)');

    // Price vs SMA ranges — determine trending vs ranging
    const offset10 = (lastPrice - lastSma10) / lastSma10;
    const offset50 = (lastPrice - lastSma50) / lastSma50;

    // If both SMAs are far apart, trending; if converging, ranging
    const smaGap = Math.abs(lastSma10 - lastSma50) / lastSma50;

    // Momentum score (positive = upward momentum)
    const mom5 = momentum(close, 5);
    const mom10 = momentum(close, 10);
    const momScore = mom5 * 0.6 + mom10 * 0.4;

    // RSI for overbought/oversold
    const rsiValues = rsi(close, 14);
    const lastRsi = rsiValues[rsiValues.length - 1];

    // Classify regime
    let regime: string;
    let confidence: number;

    if (smaGap > 0.02 && Math.abs(momScore) > 1.5) {
      // Trending
      if (offset10 > 0 && offset50 > 0) {
        regime = 'bullish';
        reasons.push(`Price above SMA10 (+${(offset10 * 100).toFixed(1)}%) and SMA50 (+${(offset50 * 100).toFixed(1)}%)`);
      } else if (offset10 < 0 && offset50 < 0) {
        regime = 'bearish';
        reasons.push(`Price below SMA10 (${(offset10 * 100).toFixed(1)}%) and SMA50 (${(offset50 * 100).toFixed(1)}%)`);
      } else {
        regime = 'transitional';
        reasons.push('Mixed price-SMA position (trend transitioning)');
      }
      // Higher confidence in trending regimes
      confidence = Math.min(0.85, Math.abs(momScore) / 10 + 0.3);
      if (bullishCross || bearishCross) {
        confidence = Math.min(0.95, confidence + 0.1);
      }
    } else if (smaGap < 0.01 || (Math.abs(offset10) < 0.01 && Math.abs(offset50) < 0.01)) {
      regime = 'ranging';
      reasons.push(`Price oscillating near SMAs (gap: ${(smaGap * 100).toFixed(2)}%)`);
      confidence = 0.5;
    } else if (!isNaN(lastRsi ?? NaN) && (lastRsi > 75 || lastRsi < 25)) {
      regime = 'erratic';
      reasons.push(`RSI extreme (${lastRsi.toFixed(1)}) — potential reversal zone`);
      confidence = 0.4;
    } else {
      regime = 'neutral';
      reasons.push(`No strong trend signal (smaGap=${(smaGap * 100).toFixed(2)}%, momScore=${momScore.toFixed(2)})`);
      confidence = 0.3;
    }

    // Momentum-based confidence adjustment
    if (momScore > 5) reasons.push(`Strong upward momentum (${momScore.toFixed(1)}%)`);
    if (momScore < -5) reasons.push(`Strong downward momentum (${momScore.toFixed(1)}%)`);

    // Round confidence
    confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

    return { regime, confidence, reasons };
  }

  // ── Trend Scanning ─────────────────────────────────────────────────

  /**
   * Scan price data and produce a trend signal (direction + confidence).
   * Combines SMA position, RSI, and momentum scoring.
   */
  scanTrend(data: PriceData): TrendSignal {
    const { close, token } = data;

    if (close.length < 20) {
      return { direction: 'neutral', confidence: 0, reason: 'Insufficient data (< 20 bars)', token };
    }

    const rsiValues = rsi(close, 14);
    const lastRsi = rsiValues[rsiValues.length - 1];
    const sma20 = sma(close, 20);
    const lastSma20 = sma20[sma20.length - 1];
    const lastPrice = close[close.length - 1];

    // Score components (each 0..1 scaled)
    let score = 0;
    const parts: string[] = [];

    // 1. SMA position: price relative to SMA20
    const smaOffset = !isNaN(lastSma20) ? (lastPrice - lastSma20) / lastSma20 : 0;
    const smaScore = Math.max(-1, Math.min(1, smaOffset * 20)); // scale: ±5% → ±1
    score += smaScore * 0.35;
    if (Math.abs(smaOffset) > 0.02) {
      parts.push(`SMA20 offset ${(smaOffset * 100).toFixed(1)}%`);
    }

    // 2. RSI signal
    if (!isNaN(lastRsi)) {
      let rsiScore = 0;
      if (lastRsi > 70) rsiScore = -0.5;  // overbought → bearish
      else if (lastRsi > 60) rsiScore = -0.2;
      else if (lastRsi > 40) rsiScore = 0;  // neutral
      else if (lastRsi > 30) rsiScore = 0.2;
      else rsiScore = 0.5;  // oversold → bullish
      score += rsiScore * 0.30;
      parts.push(`RSI ${lastRsi.toFixed(1)}`);
    }

    // 3. Momentum
    const mom5 = momentum(close, 5);
    const mom10 = momentum(close, 10);
    const momScore = mom5 * 0.6 + mom10 * 0.4;
    const momNorm = Math.max(-1, Math.min(1, momScore / 8)); // normalize: ±8% → ±1
    score += momNorm * 0.35;
    if (Math.abs(momScore) > 2) {
      parts.push(`momentum ${momScore.toFixed(1)}%`);
    }

    // Determine direction
    const confidence = Math.min(0.95, Math.abs(score));
    let direction: 'long' | 'short' | 'neutral';
    if (score > 0.15) {
      direction = 'long';
    } else if (score < -0.15) {
      direction = 'short';
    } else {
      direction = 'neutral';
    }

    const reason = parts.length > 0
      ? `${direction} signal (score ${score.toFixed(2)}): ${parts.join(', ')}`
      : `${direction} signal (score ${score.toFixed(2)})`;

    // Clamp and round
    return {
      direction,
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
      reason,
      token,
    };
  }

  // ── Gating Simulation ──────────────────────────────────────────────

  /**
   * Determine whether a paper trade should be approved based on:
   * - HTF regime bias matching signal direction
   * - Minimum confidence threshold
   * - Regime no-trade zones
   * - Consecutive loss limit
   * - Risk per trade percentage
   */
  evaluateGate(signal: TrendSignal, regime: RegimeResult): GatingResult {
    const reasons: string[] = [];

    // 1. Check no-trade zones
    if (this.config.regimeNoTradeZones.includes(regime.regime)) {
      return {
        approved: false,
        reasons: [`Regime '${regime.regime}' is a no-trade zone`],
        confidenceWeight: 0,
      };
    }

    // 2. Minimum confidence
    if (signal.confidence < this.config.minConfidence) {
      return {
        approved: false,
        reasons: [`Confidence ${signal.confidence} below minimum ${this.config.minConfidence}`],
        confidenceWeight: 0,
      };
    }

    // 3. HTF bias match: bullish regime favors longs, bearish favors shorts
    let htfMatch = true;
    if (regime.regime === 'bullish' && signal.direction === 'short') {
      htfMatch = false;
      reasons.push('HTF regime is bullish but signal is short');
    } else if (regime.regime === 'bearish' && signal.direction === 'long') {
      htfMatch = false;
      reasons.push('HTF regime is bearish but signal is long');
    }

    const confidenceWeight = htfMatch ? 1.0 : 0.5;

    if (!htfMatch) {
      return {
        approved: false,
        reasons: ['HTF bias mismatch — signal direction opposite to regime'],
        confidenceWeight,
      };
    }

    // 4. Consecutive loss limit
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      return {
        approved: false,
        reasons: [`Consecutive losses (${this.consecutiveLosses}) reached limit (${this.config.maxConsecutiveLosses})`],
        confidenceWeight: 0,
      };
    }

    // 5. Risk per trade check
    const riskAmount = this.balance * (this.config.maxRiskPerTradePct / 100);
    if (this.balance <= 0) {
      return {
        approved: false,
        reasons: ['Account balance depleted'],
        confidenceWeight: 0,
      };
    }

    reasons.push(`Risk amount: $${riskAmount.toFixed(2)} (${this.config.maxRiskPerTradePct}% of $${this.balance.toFixed(2)})`);
    reasons.push(`Signal confidence: ${signal.confidence}, regime: ${regime.regime}`);

    return {
      approved: true,
      reasons,
      confidenceWeight,
    };
  }

  // ── Paper Execution ────────────────────────────────────────────────

  /**
   * Execute a paper trade: create a DirectionalTrade, simulate entry,
   * and register a PaperPosition.
   */
  paperExecute(signal: TrendSignal, regime: RegimeResult, entryPrice: number): PaperOrderResult {
    const startTime = Date.now();

    if (signal.direction === 'neutral') {
      return {
        success: false,
        signalId: `paper_${startTime}_${signal.token}`,
        position: null,
        error: 'Cannot execute neutral signal',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const signalId = `paper_${startTime}_${signal.token}_${signal.direction}`;

    // Calculate position size
    const sizeUsd = this.balance * (this.config.maxRiskPerTradePct / 100);
    const leverage = Math.min(this.config.maxLeverage, Math.floor(signal.confidence * 5) || 1);

    // Entry price from PriceData.currentPrice passed by evaluate()
    const stopLoss = signal.direction === 'long'
      ? entryPrice * (1 - this.config.defaultStopLossPct)
      : entryPrice * (1 + this.config.defaultStopLossPct);
    const takeProfit = signal.direction === 'long'
      ? entryPrice * (1 + this.config.defaultTakeProfitPct)
      : entryPrice * (1 - this.config.defaultTakeProfitPct);

    const position: PaperPosition = {
      signalId,
      side: signal.direction,
      entryPrice,
      sizeUsd,
      leverage,
      stopLoss,
      takeProfit,
      entryTime: startTime,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      regime: regime.regime,
      confidence: signal.confidence,
    };

    this.positions.set(signalId, position);
    this.totalTrades++;

    this.events.push({
      timestamp: startTime,
      type: 'position_open',
      data: { signalId, position },
    });

    return {
      success: true,
      signalId,
      position,
      executionTimeMs: Date.now() - startTime,
    };
  }

  // ── Evaluation Orchestrator ────────────────────────────────────────

  /**
   * Run one complete scan & paper trade cycle given price data.
   * 1. Detect regime
   * 2. Scan trend
   * 3. Evaluate gate
   * 4. If approved, execute paper trade
   */
  async evaluate(data: PriceData): Promise<{
    regime: RegimeResult;
    signal: TrendSignal;
    gating: GatingResult;
    order?: PaperOrderResult;
  }> {
    // Detect regime
    const regime = this.detectRegime(data);
    this.events.push({ timestamp: Date.now(), type: 'signal', data: { phase: 'regime', regime } });

    // Scan trend
    const signal = this.scanTrend(data);
    this.events.push({ timestamp: Date.now(), type: 'signal', data: { phase: 'trend', signal } });

    // Evaluate gate
    const gating = this.evaluateGate(signal, regime);
    this.events.push({ timestamp: Date.now(), type: 'signal', data: { phase: 'gating', gating } });

    if (!gating.approved || signal.direction === 'neutral') {
      return { regime, signal, gating };
    }

    // Execute paper trade with actual price from PriceData
    const order = this.paperExecute(signal, regime, data.currentPrice);
    return { regime, signal, gating, order };
  }

  // ── Mark-to-Market ─────────────────────────────────────────────────

  /**
   * Update all open positions with latest prices. Calculates unrealized P&L,
   * checks stop-loss and take-profit levels, and auto-closes hit positions.
   */
  async markToMarket(currentPrices: Record<string, number>): Promise<void> {
    const now = Date.now();

    for (const [signalId, position] of this.positions.entries()) {
      const price = currentPrices[signalId.split('_')[2] ?? 'unknown'];
      if (!price) continue;

      position.currentPrice = price;

      // Calculate unrealized P&L
      if (position.side === 'long') {
        position.unrealizedPnl = ((price - position.entryPrice) / position.entryPrice) * position.sizeUsd * position.leverage;
      } else {
        position.unrealizedPnl = ((position.entryPrice - price) / position.entryPrice) * position.sizeUsd * position.leverage;
      }

      // Check stop loss
      const hitStopLoss = position.side === 'long' && price <= position.stopLoss;
      const hitStopLossShort = position.side === 'short' && price >= position.stopLoss;
      const hitTakeProfit = position.side === 'long' && price >= position.takeProfit;
      const hitTakeProfitShort = position.side === 'short' && price <= position.takeProfit;

      if (hitStopLoss || hitStopLossShort) {
        this.closePosition(signalId, 'stop_loss', price);
      } else if (hitTakeProfit || hitTakeProfitShort) {
        this.closePosition(signalId, 'take_profit', price);
      }
    }

    this.events.push({ timestamp: now, type: 'mark_to_market', data: { positions: this.positions.size } });
  }

  // ── Close Position ─────────────────────────────────────────────────

  /**
   * Close an open position by signal ID. Calculates realized P&L,
   * updates account balance, and tracks win/loss streaks.
   */
  closePosition(signalId: string, reason: CloseReason, exitPrice?: number): PaperCloseResult {
    const position = this.positions.get(signalId);
    const now = Date.now();

    if (!position) {
      return {
        signalId,
        exitPrice: exitPrice ?? 0,
        exitTime: now,
        realizedPnl: 0,
        returnPct: 0,
        reason,
        holdTimeMs: 0,
      };
    }

    const price = exitPrice ?? position.currentPrice;
    const holdTimeMs = now - position.entryTime;

    // Calculate realized P&L
    let realizedPnl: number;
    if (position.side === 'long') {
      realizedPnl = ((price - position.entryPrice) / position.entryPrice) * position.sizeUsd * position.leverage;
    } else {
      realizedPnl = ((position.entryPrice - price) / position.entryPrice) * position.sizeUsd * position.leverage;
    }

    const returnPct = ((price - position.entryPrice) / position.entryPrice) * (position.side === 'long' ? 1 : -1) * 100;

    // Update balance
    this.balance += realizedPnl;
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Track streaks
    if (realizedPnl > 0) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }

    const result: PaperCloseResult = {
      signalId,
      exitPrice: price,
      exitTime: now,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      returnPct: Math.round(returnPct * 100) / 100,
      reason,
      holdTimeMs,
    };

    // Remove position and record
    this.positions.delete(signalId);
    this.closedTrades.push(result);

    this.events.push({
      timestamp: now,
      type: 'position_close',
      data: { result, position },
    });

    return result;
  }

  // ── Summary ────────────────────────────────────────────────────────

  /** Get comprehensive P&L summary statistics. */
  getSummary(): PaperPnLSummary {
    const wins = this.closedTrades.filter(t => t.realizedPnl > 0);
    const losses = this.closedTrades.filter(t => t.realizedPnl <= 0);
    const totalTrades = this.closedTrades.length;
    const totalPnlUsd = this.closedTrades.reduce((s, t) => s + t.realizedPnl, 0);
    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

    // Max drawdown
    let peak = this.config.initialBalanceUsd;
    let maxDrawdownUsd = 0;
    let runningBalance = this.config.initialBalanceUsd;
    for (const trade of this.closedTrades) {
      runningBalance += trade.realizedPnl;
      if (runningBalance > peak) peak = runningBalance;
      const dd = peak - runningBalance;
      if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
    }
    const maxDrawdownPct = peak > 0 ? (maxDrawdownUsd / peak) * 100 : 0;

    // Average hold time
    const avgHoldTimeMs = totalTrades > 0
      ? this.closedTrades.reduce((s, t) => s + t.holdTimeMs, 0) / totalTrades
      : 0;

    // Best and worst trade
    const sortedByPnl = [...this.closedTrades].sort((a, b) => b.realizedPnl - a.realizedPnl);
    const bestTrade = sortedByPnl.length > 0 ? sortedByPnl[0] : null;
    const worstTrade = sortedByPnl.length > 0 ? sortedByPnl[sortedByPnl.length - 1] : null;

    return {
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 100) / 100,
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      maxDrawdownUsd: Math.round(maxDrawdownUsd * 100) / 100,
      avgHoldTimeMs: Math.round(avgHoldTimeMs),
      bestTrade,
      worstTrade,
      consecutiveWins: this.consecutiveWins,
      consecutiveLosses: this.consecutiveLosses,
      openPositions: this.positions.size,
    };
  }

  // ── Event History ──────────────────────────────────────────────────

  /** Get the full event log. */
  getEvents(): PaperEvent[] {
    return [...this.events];
  }

  /** Get config (read-only access for testing). */
  getConfig(): PaperTradingConfig {
    return { ...this.config };
  }

  /** Get open positions (read-only snapshot). */
  getPositions(): Map<string, PaperPosition> {
    return new Map(this.positions);
  }

  /** Get current balance. */
  getBalance(): number {
    return this.balance;
  }
}

// ─── Self-Test ────────────────────────────────────────────────────────────

/**
 * Run a self-test demonstrating the engine with synthetic price data.
 * Invoke directly: `npx tsx src/scanner/paper-trade.ts`
 */
async function selfTest(): Promise<void> {
  console.log('📊 PaperTradingEngine Self-Test\n');

  const engine = new PaperTradingEngine();

  // Generate synthetic price data (100 bars of a trending oscillation)
  const close: number[] = [];
  for (let i = 0; i < 100; i++) {
    const trend = Math.sin(i / 10) * 5 + i * 0.3;
    close.push(100 + trend + (Math.random() - 0.5) * 2);
  }

  const priceData: PriceData = {
    token: 'TEST',
    close,
    high: close.map(c => c + 0.5),
    low: close.map(c => c - 0.5),
    currentPrice: close[close.length - 1],
    timestamp: Date.now(),
  };

  // Run evaluation cycle
  console.log('--- Cycle 1 ---');
  const result1 = await engine.evaluate(priceData);
  console.log(`Regime: ${result1.regime.regime} (${(result1.regime.confidence * 100).toFixed(0)}%)`);
  console.log(`  Reasons: ${result1.regime.reasons.join('; ')}`);
  console.log(`Signal: ${result1.signal.direction} (${(result1.signal.confidence * 100).toFixed(0)}%)`);
  console.log(`  Reason: ${result1.signal.reason}`);
  console.log(`Gate: ${result1.gating.approved ? '✅ APPROVED' : '❌ REJECTED'}`);
  console.log(`  Reasons: ${result1.gating.reasons.join('; ')}`);
  if (result1.order?.position) {
    console.log(`Position: ${result1.order.position.side} @ $${result1.order.position.entryPrice.toFixed(2)}, size $${result1.order.position.sizeUsd.toFixed(2)}x${result1.order.position.leverage}`);
  }

  // Mark to market at higher price
  console.log('\n--- Mark to Market (price +10%) ---');
  await engine.markToMarket({ TEST: close[close.length - 1] * 1.1 });

  // Get summary
  console.log('\n--- Summary ---');
  const summary = engine.getSummary();
  console.log(`Trades: ${summary.totalTrades} | Wins: ${summary.wins} | Losses: ${summary.losses}`);
  console.log(`Win rate: ${(summary.winRate * 100).toFixed(1)}% | Total PnL: $${summary.totalPnlUsd.toFixed(2)}`);
  console.log(`Drawdown: ${summary.maxDrawdownPct.toFixed(1)}% ($${summary.maxDrawdownUsd.toFixed(2)})`);
  console.log(`Open positions: ${summary.openPositions}`);
  console.log(`Balance: $${engine.getBalance().toFixed(2)}`);

  // Events
  console.log(`\nEvents logged: ${engine.getEvents().length}`);

  console.log('\n✅ Self-test complete');
}

// Run self-test when invoked directly
const isMainModule = process.argv.length >= 2 &&
  (process.argv[1]?.endsWith('paper-trade.ts') || process.argv[1]?.endsWith('paper-trade.js'));

if (isMainModule) {
  selfTest().catch(err => {
    console.error('Self-test failed:', err);
    process.exit(1);
  });
}
