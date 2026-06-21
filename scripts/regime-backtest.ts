/**
 * Regime-Backtest.ts — 90-Day Backtest for Regime-Aware Trend Follower
 *
 * Self-contained TypeScript script. No imports from existing src/.
 * Interfaces mirror Rust sidecar structs from:
 *   rust-sidecar/src/regime_detector.rs
 *   rust-sidecar/src/trend_scanner.rs
 *   rust-sidecar/src/gating_layer.rs
 *
 * Run: npx ts-node scripts/regime-backtest.ts
 * With assumptions: npx ts-node scripts/regime-backtest.ts --assumptions
 *
 * Date: 2026-06-12
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Interfaces (matching Rust sidecar structs) ─────────────────────────────

enum RegimeType {
  Trending = 'Trending',
  Ranging = 'Ranging',
  Breakout = 'Breakout',
  Reversal = 'Reversal',
}

enum TrendDirection {
  Bullish = 'Bullish',
  Bearish = 'Bearish',
  Neutral = 'Neutral',
}

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TrendScanResult {
  direction: TrendDirection;
  crossover: 'GoldenCross' | 'DeathCross' | 'None';
  BOS: 'Bullish' | 'Bearish' | 'None';
  sweepSignal: 'BSL' | 'SSL' | 'None';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  smaFast: number;
  smaSlow: number;
}

interface DirectionalSignal {
  pair: string;
  direction: 'Long' | 'Short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  regimeConfirmed: boolean;
  expiresAt: number;
  detectedAtMs: number;
}

type GateDecision = { allow: true } | { allow: false; reason: string };

// ─── Trade Record ────────────────────────────────────────────────────────────

interface TradeRecord {
  entryTime: number;
  exitTime: number;
  direction: 'Long' | 'Short';
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  pnlPct: number;
  pnlUsd: number;
  reason: 'stop_loss' | 'take_profit' | 'expired';
  regimeAtEntry: RegimeType;
  confidence: number;
  gated: boolean;
}

// ─── Synthetic Data Generator ───────────────────────────────────────────────

/**
 * generateSyntheticCandles: 90 days of 1H OHLCV simulating WETH/USDC price action
 * with trending phases, ranging periods, and breakout patterns.
 */
function generateSyntheticCandles(count: number): CandleData[] {
  const candles: CandleData[] = [];
  const now = Date.UTC(2026, 5, 12, 0, 0, 0); // Jun 12 2026 00:00 UTC
  const startMs = now - count * 3600_000;

  let price = 2800.0; // Starting WETH/USDC ~$2800
  let trend = 0; // cumulative drift
  let phase = 0; // phase counter for regime switching
  const regimeSchedule: { start: number; duration: number; type: string }[] = [
    { start: 0, duration: 14 * 24, type: 'trending_up' },    // Days 1-14
    { start: 14 * 24, duration: 7 * 24, type: 'ranging' },    // Days 15-21
    { start: 21 * 24, duration: 10 * 24, type: 'trending_up' }, // Days 22-31
    { start: 31 * 24, duration: 5 * 24, type: 'breakout' },   // Days 32-36
    { start: 36 * 24, duration: 12 * 24, type: 'trending_down' }, // Days 37-48
    { start: 48 * 24, duration: 8 * 24, type: 'ranging' },    // Days 49-56
    { start: 56 * 24, duration: 15 * 24, type: 'trending_up' }, // Days 57-71
    { start: 71 * 24, duration: 4 * 24, type: 'breakout' },   // Days 72-75
    { start: 75 * 24, duration: 10 * 24, type: 'trending_down' }, // Days 76-85
    { start: 85 * 24, duration: 5 * 24, type: 'ranging' },    // Days 86-90
  ];

  for (let i = 0; i < count; i++) {
    const hourMs = startMs + i * 3600_000;
    const hourOfDay = new Date(hourMs).getUTCHours();

    // Determine current regime phase
    const currentPhase = regimeSchedule.find(
      (r) => i >= r.start && i < r.start + r.duration
    );

    // Base drift depends on regime
    let baseDrift = 0;
    let volatility = 0.004; // ~0.4% base volatility per hour

    if (currentPhase) {
      switch (currentPhase.type) {
        case 'trending_up':
          baseDrift = 0.0006; // ~0.06% per hour = ~1.4% per day
          volatility = 0.005;
          break;
        case 'trending_down':
          baseDrift = -0.0006;
          volatility = 0.005;
          break;
        case 'ranging':
          baseDrift = 0.0;
          volatility = 0.0035;
          break;
        case 'breakout':
          baseDrift = 0.0012; // stronger trend
          volatility = 0.008; // higher volatility
          break;
      }
    } else {
      // Default: ranging
      baseDrift = 0;
      volatility = 0.004;
    }

    // Add intraday pattern (slight dip in Asian session, rally in US)
    const intradayBias =
      hourOfDay >= 8 && hourOfDay <= 16 ? 0.0003 : hourOfDay >= 0 && hourOfDay <= 6 ? -0.0002 : 0.0;

    // Random component (Brownian motion approximation)
    const random = (Math.random() - 0.5) * volatility * 2;

    // Mean reversion tendency (pull back to trend)
    const meanReversion = -0.00005 * (price - 2800) * (1 + trend * 0.01);

    // Phase transition: add volatility spike on regime change
    const isPhaseTransition =
      regimeSchedule.some((r) => i === r.start || i === r.start + 1);
    const transitionVol = isPhaseTransition ? 0.012 : 0.0;

    const change =
      price * (baseDrift + intradayBias + random + meanReversion) +
      (Math.random() - 0.5) * transitionVol * price;

    price += change;
    price = Math.max(price, 1800); // floor
    price = Math.min(price, 4200); // ceiling

    // Accumulate trend for visual debug
    trend += baseDrift;

    // Generate OHLC from single price with realistic spread
    const o = price - change * (0.3 + Math.random() * 0.4);
    const c = price;
    const h = Math.max(o, c) + Math.abs(change) * (0.5 + Math.random() * 0.8) + Math.random() * 2;
    const l = Math.min(o, c) - Math.abs(change) * (0.5 + Math.random() * 0.6) - Math.random() * 2;
    const v = (300 + Math.random() * 700) * (1 + (isPhaseTransition ? 2 : 0) + (currentPhase?.type === 'breakout' ? 1.5 : 0));

    candles.push({
      timestamp: hourMs,
      open: parseFloat(o.toFixed(2)),
      high: parseFloat(h.toFixed(2)),
      low: parseFloat(l.toFixed(2)),
      close: parseFloat(c.toFixed(2)),
      volume: parseFloat(v.toFixed(2)),
    });

    // Force price back if it overshoots beyond bounds
    if (price > 4100) price = 3900 + Math.random() * 100;
    if (price < 1900) price = 2000 + Math.random() * 100;
  }

  return candles;
}

// ─── ATR Calculation (Wilder's smoothing) ─────────────────────────────────

function computeATR(candles: CandleData[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hpc = Math.abs(candles[i].high - candles[i - 1].close);
    const lpc = Math.abs(candles[i].low - candles[i - 1].close);
    trueRanges.push(Math.max(hl, hpc, lpc));
  }

  // Initial SMA
  const initialTRs = trueRanges.slice(0, period);
  let atr = initialTRs.reduce((a, b) => a + b, 0) / period;

  // Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

// ─── SMA Calculation ──────────────────────────────────────────────────────

function computeSMA(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─── RegimeDetector Class ─────────────────────────────────────────────────

class RegimeDetector {
  private lookback: number;
  private atrPeriod: number;
  private trendThreshold: number;
  private hhHlRequired: number;
  private breakoutAtrMultiplier: number;
  private candles: CandleData[] = [];

  constructor(
    lookback: number = 20,
    atrPeriod: number = 14,
    trendThreshold: number = 0.005,
    hhHlRequired: number = 2,
    breakoutAtrMultiplier: number = 2.0
  ) {
    this.lookback = lookback;
    this.atrPeriod = atrPeriod;
    this.trendThreshold = trendThreshold;
    this.hhHlRequired = hhHlRequired;
    this.breakoutAtrMultiplier = breakoutAtrMultiplier;
  }

  update(candle: CandleData): { regime: RegimeType; direction: TrendDirection; confidence: number } {
    this.candles.push(candle);
    if (this.candles.length > this.lookback * 4) {
      this.candles.shift();
    }
    return this.detect();
  }

  reset(): void {
    this.candles = [];
  }

  private detect(): { regime: RegimeType; direction: TrendDirection; confidence: number } {
    if (this.candles.length < 20) {
      return { regime: RegimeType.Ranging, direction: TrendDirection.Neutral, confidence: 0.1 };
    }

    const recent = this.candles.slice(-this.lookback);
    const atr = computeATR(recent, this.atrPeriod);
    const avgPrice = recent.reduce((s, c) => s + c.close, 0) / recent.length;
    const atrPct = avgPrice > 0 ? atr / avgPrice : 0;

    // Find swing highs and lows
    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 2; i < recent.length - 2; i++) {
      const prev2 = recent[i - 2].high;
      const prev1 = recent[i - 1].high;
      const curr = recent[i].high;
      const next1 = recent[i + 1].high;
      const next2 = recent[i + 2].high;

      if (
        curr > prev2 * (1 + this.trendThreshold) &&
        curr > prev1 * (1 + this.trendThreshold) &&
        curr >= next1 &&
        curr >= next2
      ) {
        swingHighs.push(curr);
      }

      const pl2 = recent[i - 2].low;
      const pl1 = recent[i - 1].low;
      const cl = recent[i].low;
      const nl1 = recent[i + 1].low;
      const nl2 = recent[i + 2].low;

      if (
        cl < pl2 * (1 - this.trendThreshold) &&
        cl < pl1 * (1 - this.trendThreshold) &&
        cl <= nl1 &&
        cl <= nl2
      ) {
        swingLows.push(cl);
      }
    }

    // HH/HL counts
    let hhCount = 0;
    let hlCount = 0;
    let lhCount = 0;
    let llCount = 0;

    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i] > swingHighs[i - 1]) hhCount++;
      else if (swingHighs[i] < swingHighs[i - 1]) lhCount++;
    }
    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i] > swingLows[i - 1]) hlCount++;
      else if (swingLows[i] < swingLows[i - 1]) llCount++;
    }

    const totalSwings = swingHighs.length + swingLows.length;

    // Check for breakout: recent volatility surge
    const atrHistory: number[] = [];
    for (let i = this.atrPeriod; i < recent.length; i++) {
      const slice = recent.slice(i - this.atrPeriod, i);
      atrHistory.push(computeATR(slice, this.atrPeriod));
    }
    const avgAtr = atrHistory.length > 0
      ? atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length
      : atr;
    const breakoutVol = avgAtr > 0 ? atr / avgAtr : 1;
    const isBreakout = breakoutVol > this.breakoutAtrMultiplier;

    // Classify regime
    if (isBreakout && totalSwings >= 2) {
      // Determine breakout direction
      const lastClose = recent[recent.length - 1].close;
      const avgHigh = recent.slice(-5).reduce((s, c) => s + c.high, 0) / 5;
      const direction = lastClose > avgHigh ? TrendDirection.Bullish : TrendDirection.Bearish;
      const confidence = Math.min(0.9, 0.5 + (breakoutVol - 1.5) * 0.3);
      return { regime: RegimeType.Breakout, direction, confidence };
    }

    if (hhCount >= this.hhHlRequired && hlCount >= this.hhHlRequired) {
      const confidence = Math.min(0.95, 0.4 + hhCount * 0.15 + hlCount * 0.1);
      return { regime: RegimeType.Trending, direction: TrendDirection.Bullish, confidence };
    }

    if (llCount >= this.hhHlRequired && lhCount >= this.hhHlRequired) {
      const confidence = Math.min(0.95, 0.4 + llCount * 0.15 + lhCount * 0.1);
      return { regime: RegimeType.Trending, direction: TrendDirection.Bearish, confidence };
    }

    // Check for reversal: recent direction change
    if (llCount >= 2 && swingHighs.length > 2 && swingHighs[swingHighs.length - 1] < swingHighs[0]) {
      return { regime: RegimeType.Reversal, direction: TrendDirection.Bearish, confidence: 0.5 };
    }
    if (hhCount >= 2 && swingLows.length > 2 && swingLows[swingLows.length - 1] > swingLows[0]) {
      return { regime: RegimeType.Reversal, direction: TrendDirection.Bullish, confidence: 0.5 };
    }

    // Default: ranging
    const confidence = Math.max(0.2, 0.5 - Math.abs(totalSwings - 4) * 0.05);
    return { regime: RegimeType.Ranging, direction: TrendDirection.Neutral, confidence };
  }

  getCandleCount(): number {
    return this.candles.length;
  }
}

// ─── TrendScanner Class ──────────────────────────────────────────────────

class TrendScanner {
  private candles: CandleData[] = [];
  private fastPeriod: number;
  private slowPeriod: number;
  private atrPeriod: number;

  constructor(fastPeriod: number = 20, slowPeriod: number = 50, atrPeriod: number = 14) {
    this.fastPeriod = fastPeriod;
    this.slowPeriod = slowPeriod;
    this.atrPeriod = atrPeriod;
  }

  update(candle: CandleData): void {
    this.candles.push(candle);
    if (this.candles.length > this.slowPeriod * 4) {
      this.candles.shift();
    }
  }

  scan(): TrendScanResult | null {
    if (this.candles.length < this.slowPeriod + 20) return null;

    const closes = this.candles.map((c) => c.close);

    // SMA computation
    const smaFast = computeSMA(closes, this.fastPeriod);
    const smaSlow = computeSMA(closes, this.slowPeriod);

    // Previous SMAs for crossover detection
    const prevCloses = closes.slice(0, -1);
    const prevSmaFast = computeSMA(prevCloses, this.fastPeriod);
    const prevSmaSlow = computeSMA(prevCloses, this.slowPeriod);

    // Crossover detection
    const wasBelow = prevSmaFast < prevSmaSlow;
    const isAbove = smaFast > smaSlow;
    const crossover: 'GoldenCross' | 'DeathCross' | 'None' =
      wasBelow && isAbove
        ? 'GoldenCross'
        : !wasBelow && !isAbove && Math.abs(prevSmaFast - prevSmaSlow) > 0.01
          ? 'DeathCross'
          : 'None';

    // ATR calculation
    const atr = computeATR(this.candles, this.atrPeriod);
    const currentPrice = this.candles[this.candles.length - 1].close;
    const atrPct = currentPrice > 0 ? atr / currentPrice : 0;

    // ATR guard: must be >= 0.5% for viable trading
    if (atrPct < 0.005) return null;

    // BOS (Break of Structure) detection
    const recent = this.candles.slice(-20);
    const recentHighs = recent.map((c) => c.high);
    const recentLows = recent.map((c) => c.low);

    // Find recent swing high
    let bosDirection: 'Bullish' | 'Bearish' | 'None' = 'None';
    for (let i = 3; i < recent.length - 3; i++) {
      const isSwingHigh =
        recentHighs[i] > recentHighs[i - 1] &&
        recentHighs[i] > recentHighs[i - 2] &&
        recentHighs[i] > recentHighs[i - 3] &&
        recentHighs[i] >= recentHighs[i + 1] &&
        recentHighs[i] >= recentHighs[i + 2];

      if (isSwingHigh && recent.length > i + 5) {
        // Check if price broke above this swing high
        const maxAfter = Math.max(...recentHighs.slice(i + 1));
        if (maxAfter > recentHighs[i] + atr * 0.5) {
          bosDirection = 'Bullish';
        }
      }

      const isSwingLow =
        recentLows[i] < recentLows[i - 1] &&
        recentLows[i] < recentLows[i - 2] &&
        recentLows[i] < recentLows[i - 3] &&
        recentLows[i] <= recentLows[i + 1] &&
        recentLows[i] <= recentLows[i + 2];

      if (isSwingLow && recent.length > i + 5) {
        const minAfter = Math.min(...recentLows.slice(i + 1));
        if (minAfter < recentLows[i] - atr * 0.5) {
          bosDirection = 'Bearish';
        }
      }
    }

    // Sweep signal (liquidity sweep detection with wick analysis)
    let sweepSignal: 'BSL' | 'SSL' | 'None' = 'None';
    const lastCandle = this.candles[this.candles.length - 1];
    const prevCandle = this.candles[this.candles.length - 2];
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
    const recentMax = Math.max(...recentHighs);
    const recentMin = Math.min(...recentLows);

    if (upperWick > bodySize * 0.6 && lastCandle.high >= recentMax) {
      sweepSignal = 'BSL';
    }
    if (lowerWick > bodySize * 0.6 && lastCandle.low <= recentMin) {
      sweepSignal = 'SSL';
    }

    // Direction determination
    let direction = TrendDirection.Neutral;
    let confidence = 0.3;

    if (crossover === 'GoldenCross' && bosDirection === 'Bullish') {
      direction = TrendDirection.Bullish;
      confidence = 0.65 + atrPct * 10;
    } else if (crossover === 'DeathCross' && bosDirection === 'Bearish') {
      direction = TrendDirection.Bearish;
      confidence = 0.65 + atrPct * 10;
    } else if (crossover === 'GoldenCross') {
      direction = TrendDirection.Bullish;
      confidence = 0.45;
    } else if (crossover === 'DeathCross') {
      direction = TrendDirection.Bearish;
      confidence = 0.45;
    } else if (bosDirection === 'Bullish') {
      direction = TrendDirection.Bullish;
      confidence = 0.35;
    } else if (bosDirection === 'Bearish') {
      direction = TrendDirection.Bearish;
      confidence = 0.35;
    }

    // Calculate SL/TP with ATR multiplier
    const slMultiplier = 1.5;
    const tpMultiplier = 3.0;
    let entryPrice = currentPrice;
    let stopLoss = entryPrice;
    let takeProfit = entryPrice;

    if (direction === TrendDirection.Bullish) {
      stopLoss = entryPrice - atr * slMultiplier;
      takeProfit = entryPrice + atr * tpMultiplier;
    } else if (direction === TrendDirection.Bearish) {
      stopLoss = entryPrice + atr * slMultiplier;
      takeProfit = entryPrice - atr * tpMultiplier;
    }

    confidence = Math.min(0.95, Math.max(0.1, confidence));

    return {
      direction,
      crossover,
      BOS: bosDirection,
      sweepSignal,
      confidence,
      entryPrice: parseFloat(entryPrice.toFixed(2)),
      stopLoss: parseFloat(stopLoss.toFixed(2)),
      takeProfit: parseFloat(takeProfit.toFixed(2)),
      smaFast: parseFloat(smaFast.toFixed(2)),
      smaSlow: parseFloat(smaSlow.toFixed(2)),
    };
  }
}

// ─── GatingLayer Class ───────────────────────────────────────────────────

class GatingLayer {
  private currentRegime: RegimeType = RegimeType.Ranging;
  private currentDirection: TrendDirection = TrendDirection.Neutral;

  updateRegime(regime: RegimeType, direction: TrendDirection): void {
    this.currentRegime = regime;
    this.currentDirection = direction;
  }

  gateSignal(
    signal: DirectionalSignal
  ): GateDecision {
    switch (this.currentRegime) {
      case RegimeType.Trending:
        if (this.currentDirection === TrendDirection.Bullish && signal.direction === 'Long') {
          return { allow: true };
        }
        if (this.currentDirection === TrendDirection.Bearish && signal.direction === 'Short') {
          return { allow: true };
        }
        return { allow: false, reason: `Trending ${this.currentDirection} does not match signal ${signal.direction}` };

      case RegimeType.Breakout:
        if (signal.confidence > 0.85) {
          return { allow: true };
        }
        return { allow: false, reason: `Breakout requires confidence >0.85, got ${signal.confidence.toFixed(2)}` };

      case RegimeType.Ranging:
        return { allow: false, reason: 'Ranging regime blocks all directional signals' };

      case RegimeType.Reversal:
        return { allow: false, reason: 'Reversal regime blocks all directional signals' };
    }
  }
}

// ─── Backtest Engine ─────────────────────────────────────────────────────

interface BacktestConfig {
  initialCapital: number;
  riskPerTradePct: number;
  maxConcurrent: number;
  slAtrMultiplier: number;
  tpAtrMultiplier: number;
  maxHoldHours: number;
  minConfidence: number;
}

const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  riskPerTradePct: 0.02, // 2% risk per trade
  maxConcurrent: 3,
  slAtrMultiplier: 1.5,
  tpAtrMultiplier: 3.0,
  maxHoldHours: 24,
  minConfidence: 0.4,
};

interface BacktestPosition {
  signal: DirectionalSignal;
  entryTime: number;
  entryPrice: number;
  sizeUsd: number;
  stopLoss: number;
  takeProfit: number;
}

function runBacktest(
  candles: CandleData[],
  config: BacktestConfig = DEFAULT_CONFIG
): { trades: TradeRecord[]; equityCurve: number[] } {
  const regimeDetector = new RegimeDetector();
  const trendScanner = new TrendScanner();
  const gatingLayer = new GatingLayer();

  const trades: TradeRecord[] = [];
  const equityCurve: number[] = [config.initialCapital];

  // Gated vs ungated tracking for A/B comparison
  let activePositions: BacktestPosition[] = [];
  let equity = config.initialCapital;
  let lastRegime: RegimeType = RegimeType.Ranging;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Step 1: Update regime detector
    const regimeResult = regimeDetector.update(candle);
    gatingLayer.updateRegime(regimeResult.regime, regimeResult.direction);
    lastRegime = regimeResult.regime;

    // Step 2: Update trend scanner
    trendScanner.update(candle);

    // Step 3: Check existing positions for SL/TP/expiry
    const closedPositions: BacktestPosition[] = [];
    const remainingPositions: BacktestPosition[] = [];

    for (const pos of activePositions) {
      const holdHours = (candle.timestamp - pos.entryTime) / 3600_000;

      if (holdHours > config.maxHoldHours) {
        // Expired
        const pnlPct = (candle.close - pos.entryPrice) / pos.entryPrice;
        const pnlUsd = pos.sizeUsd * (pos.signal.direction === 'Long' ? pnlPct : -pnlPct);
        trades.push({
          entryTime: pos.entryTime,
          exitTime: candle.timestamp,
          direction: pos.signal.direction,
          entryPrice: pos.entryPrice,
          exitPrice: candle.close,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          pnlPct: pos.signal.direction === 'Long' ? pnlPct * 100 : -pnlPct * 100,
          pnlUsd,
          reason: 'expired',
          regimeAtEntry: lastRegime,
          confidence: pos.signal.confidence,
          gated: true,
        });
        equity += pnlUsd;
        closedPositions.push(pos);
        continue;
      }

      // Check SL/TP
      let hit = false;
      if (pos.signal.direction === 'Long') {
        if (candle.low <= pos.stopLoss) {
          const pnlPct = (pos.stopLoss - pos.entryPrice) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Long',
            entryPrice: pos.entryPrice,
            exitPrice: pos.stopLoss,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'stop_loss',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: true,
          });
          equity += pnlUsd;
          hit = true;
        } else if (candle.high >= pos.takeProfit) {
          const pnlPct = (pos.takeProfit - pos.entryPrice) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Long',
            entryPrice: pos.entryPrice,
            exitPrice: pos.takeProfit,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'take_profit',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: true,
          });
          equity += pnlUsd;
          hit = true;
        }
      } else {
        // Short
        if (candle.high >= pos.stopLoss) {
          const pnlPct = (pos.entryPrice - pos.stopLoss) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Short',
            entryPrice: pos.entryPrice,
            exitPrice: pos.stopLoss,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'stop_loss',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: true,
          });
          equity += pnlUsd;
          hit = true;
        } else if (candle.low <= pos.takeProfit) {
          const pnlPct = (pos.entryPrice - pos.takeProfit) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Short',
            entryPrice: pos.entryPrice,
            exitPrice: pos.takeProfit,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'take_profit',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: true,
          });
          equity += pnlUsd;
          hit = true;
        }
      }

      if (hit) {
        closedPositions.push(pos);
      } else {
        remainingPositions.push(pos);
      }
    }
    activePositions = remainingPositions;

    // Step 4: Scan for new signals
    const scanResult = trendScanner.scan();

    if (
      scanResult &&
      scanResult.direction !== TrendDirection.Neutral &&
      scanResult.confidence >= config.minConfidence &&
      activePositions.length < config.maxConcurrent
    ) {
      const direction: 'Long' | 'Short' =
        scanResult.direction === TrendDirection.Bullish ? 'Long' : 'Short';

      const signal: DirectionalSignal = {
        pair: 'WETH/USDC',
        direction,
        entryPrice: scanResult.entryPrice,
        stopLoss: scanResult.stopLoss,
        takeProfit: scanResult.takeProfit,
        confidence: scanResult.confidence,
        regimeConfirmed: lastRegime === RegimeType.Trending || lastRegime === RegimeType.Breakout,
        expiresAt: candle.timestamp + config.maxHoldHours * 3600_000,
        detectedAtMs: candle.timestamp,
      };

      // Gate the signal
      const gateResult = gatingLayer.gateSignal(signal);

      if (gateResult.allow) {
        // Open position at next candle's close
        if (i + 1 < candles.length) {
          const nextCandle = candles[i + 1];
          const fillPrice = nextCandle.close;
          const riskAmount = equity * config.riskPerTradePct;
          const priceRisk =
            direction === 'Long'
              ? fillPrice - signal.stopLoss
              : signal.stopLoss - fillPrice;
          const positionSize = priceRisk > 0 ? (riskAmount / priceRisk) * fillPrice : 0;

          if (positionSize > 0) {
            activePositions.push({
              signal,
              entryTime: nextCandle.timestamp,
              entryPrice: fillPrice,
              sizeUsd: Math.min(positionSize, equity * 0.5),
              stopLoss: signal.stopLoss,
              takeProfit: signal.takeProfit,
            });

            // Also track ungated version (for A/B comparison)
            // We simulate it as a separate trade record with gated=false
            // Will be aggregated in summary
          }
        }
      }
    }

    // Track equity
    equityCurve.push(equity);
  }

  return { trades, equityCurve };
}

// ─── Ungated Backtest (A/B comparison) ───────────────────────────────────

function runUngatedBacktest(
  candles: CandleData[],
  config: BacktestConfig = DEFAULT_CONFIG
): TradeRecord[] {
  const trendScanner = new TrendScanner();
  const regimeDetector = new RegimeDetector();

  const trades: TradeRecord[] = [];
  let equity = config.initialCapital;
  let activePositions: BacktestPosition[] = [];
  let lastRegime: RegimeType = RegimeType.Ranging;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const regimeResult = regimeDetector.update(candle);
    lastRegime = regimeResult.regime;
    trendScanner.update(candle);

    // Close positions
    const remaining: BacktestPosition[] = [];
    for (const pos of activePositions) {
      const holdHours = (candle.timestamp - pos.entryTime) / 3600_000;
      let closed = false;

      if (holdHours > config.maxHoldHours) {
        const pnlPct = (candle.close - pos.entryPrice) / pos.entryPrice;
        const pnlUsd = pos.sizeUsd * (pos.signal.direction === 'Long' ? pnlPct : -pnlPct);
        trades.push({
          entryTime: pos.entryTime,
          exitTime: candle.timestamp,
          direction: pos.signal.direction,
          entryPrice: pos.entryPrice,
          exitPrice: candle.close,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          pnlPct: pos.signal.direction === 'Long' ? pnlPct * 100 : -pnlPct * 100,
          pnlUsd,
          reason: 'expired',
          regimeAtEntry: lastRegime,
          confidence: pos.signal.confidence,
          gated: false,
        });
        equity += pnlUsd;
        closed = true;
      } else if (pos.signal.direction === 'Long') {
        if (candle.low <= pos.stopLoss) {
          const pnlPct = (pos.stopLoss - pos.entryPrice) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Long',
            entryPrice: pos.entryPrice,
            exitPrice: pos.stopLoss,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'stop_loss',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: false,
          });
          equity += pnlUsd;
          closed = true;
        } else if (candle.high >= pos.takeProfit) {
          const pnlPct = (pos.takeProfit - pos.entryPrice) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Long',
            entryPrice: pos.entryPrice,
            exitPrice: pos.takeProfit,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'take_profit',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: false,
          });
          equity += pnlUsd;
          closed = true;
        }
      } else {
        if (candle.high >= pos.stopLoss) {
          const pnlPct = (pos.entryPrice - pos.stopLoss) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Short',
            entryPrice: pos.entryPrice,
            exitPrice: pos.stopLoss,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'stop_loss',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: false,
          });
          equity += pnlUsd;
          closed = true;
        } else if (candle.low <= pos.takeProfit) {
          const pnlPct = (pos.entryPrice - pos.takeProfit) / pos.entryPrice;
          const pnlUsd = pos.sizeUsd * pnlPct;
          trades.push({
            entryTime: pos.entryTime,
            exitTime: candle.timestamp,
            direction: 'Short',
            entryPrice: pos.entryPrice,
            exitPrice: pos.takeProfit,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            pnlPct: pnlPct * 100,
            pnlUsd,
            reason: 'take_profit',
            regimeAtEntry: lastRegime,
            confidence: pos.signal.confidence,
            gated: false,
          });
          equity += pnlUsd;
          closed = true;
        }
      }

      if (!closed) remaining.push(pos);
    }
    activePositions = remaining;

    // New signals (ungated)
    const scanResult = trendScanner.scan();
    if (
      scanResult &&
      scanResult.direction !== TrendDirection.Neutral &&
      scanResult.confidence >= config.minConfidence &&
      activePositions.length < config.maxConcurrent
    ) {
      const direction: 'Long' | 'Short' =
        scanResult.direction === TrendDirection.Bullish ? 'Long' : 'Short';

      const signal: DirectionalSignal = {
        pair: 'WETH/USDC',
        direction,
        entryPrice: scanResult.entryPrice,
        stopLoss: scanResult.stopLoss,
        takeProfit: scanResult.takeProfit,
        confidence: scanResult.confidence,
        regimeConfirmed: lastRegime === RegimeType.Trending || lastRegime === RegimeType.Breakout,
        expiresAt: candle.timestamp + config.maxHoldHours * 3600_000,
        detectedAtMs: candle.timestamp,
      };

      if (i + 1 < candles.length) {
        const fillPrice = candles[i + 1].close;
        const riskAmount = equity * config.riskPerTradePct;
        const priceRisk =
          direction === 'Long'
            ? fillPrice - signal.stopLoss
            : signal.stopLoss - fillPrice;
        const positionSize = priceRisk > 0 ? (riskAmount / priceRisk) * fillPrice : 0;

        if (positionSize > 0) {
          activePositions.push({
            signal,
            entryTime: candles[i + 1].timestamp,
            entryPrice: fillPrice,
            sizeUsd: Math.min(positionSize, equity * 0.5),
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
          });
        }
      }
    }
  }

  return trades;
}

// ─── Metrics Calculation ─────────────────────────────────────────────────

interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  netProfit: number;
  sharpeRatio: number;
  profitFactor: number;
  avgHoldHours: number;
  minTradeRegime: Record<string, number>;
}

function computeMetrics(trades: TradeRecord[], equityCurve: number[]): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      maxDrawdown: 0,
      netProfit: 0,
      sharpeRatio: 0,
      profitFactor: 0,
      avgHoldHours: 0,
      minTradeRegime: {},
    };
  }

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length
    : 0;

  const netProfit = trades.reduce((s, t) => s + t.pnlUsd, 0);

  // Max drawdown from equity curve
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak > 0 ? (peak - val) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe ratio (annualized, assuming daily returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 24) {
    const prev = equityCurve[Math.max(0, i - 24)];
    const ret = prev > 0 ? (equityCurve[Math.min(equityCurve.length - 1, i)] - prev) / prev : 0;
    dailyReturns.push(ret);
  }
  const avgDailyReturn =
    dailyReturns.length > 0
      ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
      : 0;
  const stdDailyReturn = dailyReturns.length > 1
    ? Math.sqrt(
        dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) /
          (dailyReturns.length - 1)
      )
    : 0;
  const sharpeRatio = stdDailyReturn > 0
    ? (avgDailyReturn / stdDailyReturn) * Math.sqrt(365)
    : 0;

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Avg hold hours
  const avgHoldHours = trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 3600_000, 0) / trades.length;

  // Trade count by regime
  const minTradeRegime: Record<string, number> = {};
  for (const t of trades) {
    const key = t.regimeAtEntry;
    minTradeRegime[key] = (minTradeRegime[key] || 0) + 1;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    maxDrawdown: maxDd,
    netProfit,
    sharpeRatio,
    profitFactor,
    avgHoldHours,
    minTradeRegime,
  };
}

// ─── Assumption Validations ──────────────────────────────────────────────

interface AssumptionResult {
  assumption: string;
  label: string;
  pass: boolean;
  detail: string;
}

function validateAssumptions(
  candles: CandleData[],
  gatedTrades: TradeRecord[],
  ungatedTrades: TradeRecord[],
  metrics: BacktestMetrics
): AssumptionResult[] {
  const results: AssumptionResult[] = [];

  // A3: Trends per week count (PASS if >3x/week on >2% moves)
  const weeklyCandles = 7 * 24;
  const totalWeeks = Math.floor(candles.length / weeklyCandles);
  let trendWeeks = 0;
  for (let w = 0; w < totalWeeks; w++) {
    const start = w * weeklyCandles;
    const weekHigh = Math.max(...candles.slice(start, start + weeklyCandles).map((c) => c.high));
    const weekLow = Math.min(...candles.slice(start, start + weeklyCandles).map((c) => c.low));
    const weekMove = weekLow > 0 ? (weekHigh - weekLow) / weekLow : 0;
    if (weekMove > 0.02) trendWeeks++;
  }
  const trendsPerWeek = trendWeeks / Math.max(1, totalWeeks);
  results.push({
    assumption: 'A3',
    label: 'Trends per week (>2% moves)',
    pass: trendsPerWeek > 3,
    detail: `${trendsPerWeek.toFixed(2)}x/week (>3 required)`,
  });

  // A4: Win rate on SMA crossover with 1:2 RR (PASS if >45%)
  const winRate = metrics.winRate * 100;
  results.push({
    assumption: 'A4',
    label: 'Win rate on SMA crossover with 1:2 RR',
    pass: winRate > 45,
    detail: `${winRate.toFixed(1)}% (>45% required)`,
  });

  // A6: A/B test gated vs ungated win rate (PASS if gated > ungated by >10pp)
  const gatedWinRate =
    gatedTrades.length > 0
      ? (gatedTrades.filter((t) => t.pnlUsd > 0).length / gatedTrades.length) * 100
      : 0;
  const ungatedWinRate =
    ungatedTrades.length > 0
      ? (ungatedTrades.filter((t) => t.pnlUsd > 0).length / ungatedTrades.length) * 100
      : 0;
  const winRateDiff = gatedWinRate - ungatedWinRate;
  results.push({
    assumption: 'A6',
    label: 'Gated vs ungated win rate (>10pp difference)',
    pass: winRateDiff > 10,
    detail: `Gated: ${gatedWinRate.toFixed(1)}%, Ungated: ${ungatedWinRate.toFixed(1)}%, Diff: ${winRateDiff.toFixed(1)}pp`,
  });

  // A7: Aave borrow cost check (PASS if avg net covers borrow + $0.50)
  const aaveBorrowCostEstimate = 0.15; // $0.15 per trade on Base
  const avgTradePnl =
    gatedTrades.length > 0
      ? gatedTrades.reduce((s, t) => s + t.pnlUsd, 0) / gatedTrades.length
      : 0;
  results.push({
    assumption: 'A7',
    label: 'Aave borrow cost coverage',
    pass: avgTradePnl > aaveBorrowCostEstimate + 0.5,
    detail: `Avg PnL: $${avgTradePnl.toFixed(2)}, Cost: $${(aaveBorrowCostEstimate + 0.5).toFixed(2)}`,
  });

  return results;
}

// ─── CSV Export ──────────────────────────────────────────────────────────

function exportTradesCSV(trades: TradeRecord[], filePath: string): void {
  const header =
    'entryTime,exitTime,direction,entryPrice,exitPrice,stopLoss,takeProfit,pnlPct,pnlUsd,reason,regimeAtEntry,confidence,gated\n';
  const rows = trades.map(
    (t) =>
      `${t.entryTime},${t.exitTime},${t.direction},${t.entryPrice.toFixed(2)},${t.exitPrice.toFixed(2)},${t.stopLoss.toFixed(2)},${t.takeProfit.toFixed(2)},${t.pnlPct.toFixed(2)},${t.pnlUsd.toFixed(2)},${t.reason},${t.regimeAtEntry},${t.confidence.toFixed(2)},${t.gated}`
  );
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, header + rows.join('\n'), 'utf-8');
}

// ─── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const showAssumptions = process.argv.includes('--assumptions');
  const candleCount = 90 * 24; // 90 days of 1H candles
  const candles = generateSyntheticCandles(candleCount);

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║     REGIME-AWARE TREND FOLLOWER — 90-DAY BACKTEST      ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`\nStart: ${new Date(candles[0].timestamp).toISOString()}`);
  console.log(`End:   ${new Date(candles[candles.length - 1].timestamp).toISOString()}`);
  console.log(`Candles: ${candles.length} (1H OHLCV)`);
  console.log(`Price range: $${Math.min(...candles.map((c) => c.low)).toFixed(2)} - $${Math.max(...candles.map((c) => c.high)).toFixed(2)}`);
  console.log(`Initial capital: $${DEFAULT_CONFIG.initialCapital.toFixed(2)}`);

  // Run gated backtest
  console.log(`\n── Running Gated Backtest ──`);
  const { trades: gatedTrades, equityCurve } = runBacktest(candles, DEFAULT_CONFIG);
  const gatedMetrics = computeMetrics(gatedTrades, equityCurve);

  // Run ungated backtest for A/B comparison
  console.log(`── Running Ungated Backtest (A/B comparison) ──`);
  const ungatedTrades = runUngatedBacktest(candles, DEFAULT_CONFIG);
  const gatedOnlyTrades = gatedTrades.filter((t) => t.gated);
  const ungatedMetrics = computeMetrics(ungatedTrades, equityCurve);

  // ── Summary Tables ──

  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│                   GATED BACKTEST SUMMARY                    │`);
  console.log(`├─────────────────────┬───────────────────────────────────────┤`);
  console.log(`│ Metric              │ Value                                 │`);
  console.log(`├─────────────────────┼───────────────────────────────────────┤`);
  console.log(`│ Total Trades        │ ${gatedMetrics.totalTrades.toString().padEnd(38)}│`);
  console.log(`│ Wins                │ ${gatedMetrics.wins.toString().padEnd(38)}│`);
  console.log(`│ Losses              │ ${gatedMetrics.losses.toString().padEnd(38)}│`);
  console.log(`│ Win Rate            │ ${(gatedMetrics.winRate * 100).toFixed(1).padEnd(7)}%${' '.repeat(30)}│`);
  console.log(`│ Avg Win             │ $${gatedMetrics.avgWin.toFixed(2).padEnd(34)}│`);
  console.log(`│ Avg Loss            │ $${gatedMetrics.avgLoss.toFixed(2).padEnd(34)}│`);
  console.log(`│ Avg Hold            │ ${gatedMetrics.avgHoldHours.toFixed(1).padEnd(8)}h${' '.repeat(28)}│`);
  console.log(`│ Max Drawdown        │ ${(gatedMetrics.maxDrawdown * 100).toFixed(2).padEnd(6)}%${' '.repeat(29)}│`);
  console.log(`│ Net Profit          │ $${gatedMetrics.netProfit.toFixed(2).padEnd(33)}│`);
  console.log(`│ Sharpe Ratio        │ ${gatedMetrics.sharpeRatio.toFixed(2).padEnd(7)}${' '.repeat(30)}│`);
  console.log(`│ Profit Factor       │ ${gatedMetrics.profitFactor === Infinity ? '∞' : gatedMetrics.profitFactor.toFixed(2).padEnd(7)}${' '.repeat(29)}│`);
  console.log(`└─────────────────────┴───────────────────────────────────────┘`);

  // Pass criteria
  const passTradeCount = gatedMetrics.totalTrades >= 50;
  const passWinRate = gatedMetrics.winRate > 0.45;
  const overallPass = passTradeCount && passWinRate;

  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│                   PASS / FAIL CRITERIA                     │`);
  console.log(`├─────────────────────┬───────────────────────────────────────┤`);
  console.log(`│ Criteria            │ Status                                │`);
  console.log(`├─────────────────────┼───────────────────────────────────────┤`);
  console.log(
    `│ Min 50 trades       │ ${passTradeCount ? '✅ PASS' : '❌ FAIL'}` +
    ` (${gatedMetrics.totalTrades.toString().padStart(3)})${' '.repeat(30)}│`
  );
  console.log(
    `│ Win rate > 45%      │ ${passWinRate ? '✅ PASS' : '❌ FAIL'}` +
    ` (${(gatedMetrics.winRate * 100).toFixed(1).padStart(5)}%)${' '.repeat(28)}│`
  );
  console.log(
    `│ OVERALL             │ ${overallPass ? '✅ PASS' : '❌ FAIL'}${' '.repeat(39)}│`
  );
  console.log(`└─────────────────────┴───────────────────────────────────────┘`);

  // A/B comparison
  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│               A/B: GATED vs UNGATED                        │`);
  console.log(`├─────────────────────┬────────────┬────────────┬────────────┤`);
  console.log(`│ Metric              │ Gated      │ Ungated    │ Delta      │`);
  console.log(`├─────────────────────┼────────────┼────────────┼────────────┤`);
  const abWinRate = ungatedMetrics.winRate * 100;
  console.log(
    `│ Win Rate            │ ${(gatedMetrics.winRate * 100).toFixed(1).padStart(6)}%  │` +
    ` ${abWinRate.toFixed(1).padStart(6)}%  │` +
    ` ${(gatedMetrics.winRate * 100 - abWinRate).toFixed(1).padStart(6)}pp │`
  );
  console.log(
    `│ Net Profit          │ $${gatedMetrics.netProfit.toFixed(0).padStart(6)}  │` +
    ` $${ungatedMetrics.netProfit.toFixed(0).padStart(6)}  │` +
    ` $${(gatedMetrics.netProfit - ungatedMetrics.netProfit).toFixed(0).padStart(6)}  │`
  );
  console.log(
    `│ Total Trades        │ ${gatedMetrics.totalTrades.toString().padStart(8)}  │` +
    ` ${ungatedMetrics.totalTrades.toString().padStart(8)}  │` +
    ` ${(gatedMetrics.totalTrades - ungatedMetrics.totalTrades).toString().padStart(8)}  │`
  );
  console.log(`└─────────────────────┴────────────┴────────────┴────────────┘`);

  // Regime distribution
  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│              TRADE DISTRIBUTION BY REGIME                   │`);
  console.log(`├─────────────────────┬───────────────────────────────────────┤`);
  for (const [regime, count] of Object.entries(gatedMetrics.minTradeRegime)) {
    console.log(`│ ${regime.padEnd(19)} │ ${count.toString().padStart(5)} trades${' '.repeat(30)}│`);
  }
  console.log(`└─────────────────────┴───────────────────────────────────────┘`);

  // Assumptions
  if (showAssumptions) {
    const assumptions = validateAssumptions(candles, gatedOnlyTrades, ungatedTrades, gatedMetrics);

    console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│               ASSUMPTION VALIDATIONS                        │`);
    console.log(`├──────┬─────────────────────────┬────────┬──────────────────┤`);
    console.log(`│ Code │ Check                   │ Result │ Detail           │`);
    console.log(`├──────┼─────────────────────────┼────────┼──────────────────┤`);
    for (const a of assumptions) {
      console.log(
        `│ ${a.assumption.padEnd(4)} │ ${a.label.padEnd(23)} │ ${a.pass ? '✅ PASS' : '❌ FAIL'} │ ${a.detail.padEnd(16)} │`
      );
    }
    console.log(`└──────┴─────────────────────────┴────────┴──────────────────┘`);
  }

  // Save CSV
  const csvPath = path.resolve(__dirname, '..', 'data', 'backtest-trades.csv');
  exportTradesCSV(gatedTrades, csvPath);
  console.log(`\n📊 Trades saved to: ${csvPath}`);
  console.log(`   ${gatedTrades.length} trade records exported.\n`);
}

// ─── Execute ─────────────────────────────────────────────────────────────

main();
