//! Regime Detector — Market regime classification from price action
//!
//! Classifies market regime (Trending, Ranging, Breakout, Reversal) using
//! deterministic Trading Maestro rules: HH/HL counting, ATR volatility,
//! and break-of-structure detection.

use serde::{Deserialize, Serialize};

/// Direction within a trending regime
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrendDirection {
    Bullish,
    Bearish,
    Neutral,
}

/// Market regime classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegimeType {
    /// Uptrending market: HH/HL sequence
    Trending,
    /// Sideways market: no clear directional structure
    Ranging,
    /// Volatile breakout from compression
    Breakout,
    /// Trend reversal confirmed by BOS against prior direction
    Reversal,
}

impl RegimeType {
    /// Human-readable label
    pub fn label(&self) -> &'static str {
        match self {
            RegimeType::Trending => "Trending",
            RegimeType::Ranging => "Ranging",
            RegimeType::Breakout => "Breakout",
            RegimeType::Reversal => "Reversal",
        }
    }
}

/// A single OHLCV candle
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CandleData {
    pub timestamp: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl CandleData {
    /// Create a new candle
    pub fn new(timestamp: i64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Self {
        Self {
            timestamp,
            open,
            high,
            low,
            close,
            volume,
        }
    }

    /// True range for a candle relative to previous close
    pub fn true_range(&self, prev_close: f64) -> f64 {
        let hl = self.high - self.low;
        let hc = (self.high - prev_close).abs();
        let lc = (self.low - prev_close).abs();
        hl.max(hc).max(lc)
    }
}

/// Configuration for regime detection
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RegimeDetectorConfig {
    /// Minimum candles needed for detection (default: 20)
    pub lookback_period: usize,
    /// Period for ATR calculation (default: 14)
    pub atr_period: usize,
    /// Min % price movement to count as a swing high/low (default: 0.005 = 0.5%)
    pub trend_threshold: f64,
    /// Min HH/HL count to classify as trending (default: 2)
    pub hh_hl_required: usize,
    /// ATR multiplier for breakout detection (default: 2.0)
    pub breakout_atr_multiplier: f64,
    /// Volume surge multiplier for breakout confirmation (default: 1.5)
    pub breakout_volume_multiplier: f64,
    /// ATR multiplier for volatility quartile calculation (default: 1.0)
    pub volatility_range_factor: f64,
    /// Per-step percentage threshold for HH/HL detection (default: 0.003 = 0.3%)
    pub per_step_threshold: f64,
}

impl Default for RegimeDetectorConfig {
    fn default() -> Self {
        Self {
            lookback_period: 20,
            atr_period: 14,
            trend_threshold: 0.005,
            hh_hl_required: 2,
            breakout_atr_multiplier: 2.0,
            breakout_volume_multiplier: 1.5,
            volatility_range_factor: 1.0,
            per_step_threshold: 0.003,
        }
    }
}

/// Result of a regime detection update
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegimeUpdate {
    pub regime: RegimeType,
    pub trend_direction: TrendDirection,
    pub volatility: f64,
    pub confidence: f64,
    pub timestamp: i64,
}

/// Intermediate structure counts for HH/HL detection
#[derive(Debug, Clone, Default)]
struct StructureCounts {
    hh_count: usize,
    hl_count: usize,
    lh_count: usize,
    ll_count: usize,
    total_swings: usize,
}

/// Market regime detector
///
/// Uses price action (HH/HL counting) + ATR volatility classification
/// to determine market regime deterministically.
#[derive(Debug, Clone)]
pub struct RegimeDetector {
    /// Configuration
    config: RegimeDetectorConfig,
    /// Rolling candle buffer (newest last)
    candles: Vec<CandleData>,
    /// Previous regime for transition detection
    last_regime: RegimeType,
    /// Last ATR value
    last_atr: f64,
    /// Running ATR values for quartile calculation
    atr_history: Vec<f64>,
}

impl RegimeDetector {
    /// Create a new regime detector with the given config
    pub fn new(config: RegimeDetectorConfig) -> Self {
        Self {
            config,
            candles: Vec::with_capacity(config.lookback_period * 2),
            last_regime: RegimeType::Ranging,
            last_atr: 0.0,
            atr_history: Vec::with_capacity(config.atr_period * 4),
        }
    }

    /// Update with a new candle and return regime detection result.
    /// This is the main entry point.
    pub fn update(&mut self, candle: &CandleData) -> RegimeUpdate {
        // Add candle to buffer
        self.candles.push(*candle);

        // Keep buffer bounded
        let max_candles = self.config.lookback_period * 4;
        if self.candles.len() > max_candles {
            self.candles.remove(0);
        }

        // Compute ATR
        self.last_atr = self.compute_atr();
        self.atr_history.push(self.last_atr);
        if self.atr_history.len() > self.config.lookback_period {
            self.atr_history.remove(0);
        }

        // Detect regime
        let (regime, trend_direction, confidence) = self.detect_regime();
        self.last_regime = regime;

        RegimeUpdate {
            regime,
            trend_direction,
            volatility: self.last_atr,
            confidence,
            timestamp: candle.timestamp,
        }
    }

    /// Get current candle count
    pub fn candle_count(&self) -> usize {
        self.candles.len()
    }

    /// Reset detector state
    pub fn reset(&mut self) {
        self.candles.clear();
        self.atr_history.clear();
        self.last_atr = 0.0;
        self.last_regime = RegimeType::Ranging;
    }

    // ── Private helpers ──

    /// Detect regime from current candle buffer
    fn detect_regime(&self) -> (RegimeType, TrendDirection, f64) {
        let len = self.candles.len();
        if len < self.config.lookback_period.min(5) {
            return (RegimeType::Ranging, TrendDirection::Neutral, 0.0);
        }

        let lookback = self.config.lookback_period.min(len);
        let window = &self.candles[len - lookback..];

        // 1. Count HH/HL/LH/LL
        let counts = self.count_structure(window);

        // 2. Compute current volatility context
        let avg_atr = self.average_atr();
        let atr_ratio = if avg_atr > 0.0 {
            self.last_atr / avg_atr
        } else {
            1.0
        };

        // 3. Recent price direction
        let first_close = window[0].close;
        let last_close = window[window.len() - 1].close;
        let net_change = (last_close - first_close) / first_close;

        // 4. Classify
        let trending_bullish = counts.hh_count >= self.config.hh_hl_required
            && counts.hl_count >= self.config.hh_hl_required;
        let trending_bearish = counts.lh_count >= self.config.hh_hl_required
            && counts.ll_count >= self.config.hh_hl_required;

        // Volume surge check (last 3 vs previous 7)
        let volume_surge = if window.len() >= 10 {
            let recent_vol: f64 = window[window.len() - 3..].iter().map(|c| c.volume).sum();
            let prior_vol: f64 = window[window.len() - 10..window.len() - 3].iter().map(|c| c.volume).sum();
            prior_vol > 0.0 && recent_vol / prior_vol * (10.0 / 3.0) >= self.config.breakout_volume_multiplier
        } else {
            false
        };

        // Breakout: high volatility + volume surge + directional break
        let is_breakout = atr_ratio >= self.config.breakout_atr_multiplier
            && volume_surge
            && (trending_bullish || trending_bearish);

        // Reversal: BOS against prior regime + volume
        let is_reversal = self.detect_reversal(window, &counts, net_change, atr_ratio, volume_surge);

        // Determine regime with priority
        let (regime, trend_dir) = if len < self.config.lookback_period.min(5) {
            (RegimeType::Ranging, TrendDirection::Neutral)
        } else if is_reversal {
            // Reversal has highest priority (it overrides even strong trends)
            if net_change > 0.0 {
                (RegimeType::Reversal, TrendDirection::Bullish)
            } else {
                (RegimeType::Reversal, TrendDirection::Bearish)
            }
        } else if is_breakout {
            if trending_bullish {
                (RegimeType::Breakout, TrendDirection::Bullish)
            } else {
                (RegimeType::Breakout, TrendDirection::Bearish)
            }
        } else if trending_bullish {
            (RegimeType::Trending, TrendDirection::Bullish)
        } else if trending_bearish {
            (RegimeType::Trending, TrendDirection::Bearish)
        } else {
            (RegimeType::Ranging, TrendDirection::Neutral)
        };

        // Confidence score 0-1
        let confidence = self.compute_confidence(&counts, window, atr_ratio, volume_surge);

        (regime, trend_dir, confidence)
    }

    /// Count HH/HL/LH/LL in a candle window
    ///
    /// Running-extreme swing detection: track the running highest high and
    /// lowest low as the window is scanned. Every time a new extreme is
    /// established, the previous extreme is recorded as a swing point.
    /// This creates chains of swing points in trends (each new high makes
    /// the previous peak a swing) while also handling direction changes.
    fn count_structure(&self, window: &[CandleData]) -> StructureCounts {
        let mut counts = StructureCounts::default();

        if window.len() < 3 {
            return counts;
        }

        let threshold = self.config.trend_threshold;

        let mut swing_highs: Vec<(usize, f64)> = Vec::new();
        let mut swing_lows: Vec<(usize, f64)> = Vec::new();

        // Running-extreme: record a swing point EVERY TIME the running
        // high/low updates. When curr.high > running_high, the OLD
        // running_high was a peak; when curr.high < running_high, the OLD
        // running_high was also a peak (direction change). Same for lows.
        // This naturally produces chains of swing points in steady trends.
        let mut running_high = window[0].high;
        let mut running_high_idx = 0usize;
        let mut running_low = window[0].low;
        let mut running_low_idx = 0usize;

        for i in 1..window.len() {
            let curr = &window[i];

            // --- Swing High Detection ---
            // Record swing point EVERY TIME running_high updates.
            // The previous running_high was a peak; the new current value
            // establishes a new extreme. This naturally produces chains of
            // swing points in steady trends and on direction changes.
            if curr.high > running_high {
                // New high — record previous peak
                if running_high_idx > 0 && running_high_idx < window.len() - 1 {
                    swing_highs.push((running_high_idx, running_high));
                }
                running_high = curr.high;
                running_high_idx = i;
            } else if curr.high < running_high {
                // Lower high — record previous peak (direction change)
                if running_high_idx > 0 && running_high_idx < window.len() - 1 {
                    swing_highs.push((running_high_idx, running_high));
                }
                running_high = curr.high;
                running_high_idx = i;
            }
            // If equal, running point unchanged

            // --- Swing Low Detection ---
            if curr.low < running_low {
                // New low — record previous trough
                if running_low_idx > 0 && running_low_idx < window.len() - 1 {
                    swing_lows.push((running_low_idx, running_low));
                }
                running_low = curr.low;
                running_low_idx = i;
            } else if curr.low > running_low {
                // Higher low — record previous trough
                if running_low_idx > 0 && running_low_idx < window.len() - 1 {
                    swing_lows.push((running_low_idx, running_low));
                }
                running_low = curr.low;
                running_low_idx = i;
            }
            // If equal, running point unchanged
        }

        // Record final extremes — ensures the last candle's peak/trough is
        // captured even if no subsequent candle creates a significant change
        if running_high_idx > 0 {
            swing_highs.push((running_high_idx, running_high));
        }
        if running_low_idx > 0 {
            swing_lows.push((running_low_idx, running_low));
        }

        // Compare consecutive swing highs for HH vs LH
        // Using per-step threshold (0.003 = 0.3%) catches ~0.5% reversals
        // without over-detecting in trending/ranging regimes.
        let per_step_threshold = self.config.per_step_threshold;
        for i in 1..swing_highs.len() {
            let prev = swing_highs[i - 1].1;
            let curr = swing_highs[i].1;
            let change = (curr - prev) / prev.abs().max(0.0001);

            if change >= per_step_threshold {
                counts.hh_count += 1; // Higher High (requires threshold to filter noise)
            } else if change <= -per_step_threshold {
                counts.lh_count += 1; // Lower High (requires threshold to filter noise)
            }
        }

        // Compare consecutive swing lows for HL vs LL
        // HL uses relaxed threshold: any consecutive increase counts
        // (lows rise in smaller increments than trend_threshold in mild trends)
        for i in 1..swing_lows.len() {
            let prev = swing_lows[i - 1].1;
            let curr = swing_lows[i].1;
            let change = (curr - prev) / prev.abs().max(0.0001);

            if change > 0.0 {
                counts.hl_count += 1; // Higher Low (any increase)
            } else if change < -per_step_threshold {
                counts.ll_count += 1; // Lower Low (requires per-step threshold to filter noise)
            }
        }

        counts.total_swings = swing_highs.len() + swing_lows.len();
        counts
    }

    /// Compute ATR (Average True Range) using Wilder's method
    fn compute_atr(&self) -> f64 {
        let len = self.candles.len();
        if len < 2 {
            return 0.0;
        }

        let period = self.config.atr_period.min(len - 1);
        if period == 0 {
            return 0.0;
        }

        // Calculate true ranges
        let mut tr_values: Vec<f64> = Vec::with_capacity(len - 1);
        for i in 1..len {
            let tr = self.candles[i].true_range(self.candles[i - 1].close);
            tr_values.push(tr);
        }

        // Wilder's smoothed ATR
        // First ATR = SMA of first `period` TR values
        // Subsequent: ATR = (prev_ATR * (period - 1) + current_TR) / period
        if tr_values.len() <= period {
            // Not enough data for smoothed ATR — use SMA
            return tr_values.iter().sum::<f64>() / tr_values.len() as f64;
        }

        // Initial SMA
        let initial_sum: f64 = tr_values[..period].iter().sum();
        let mut atr = initial_sum / period as f64;

        // Wilder smoothing for remaining values
        for i in period..tr_values.len() {
            atr = (atr * (period as f64 - 1.0) + tr_values[i]) / period as f64;
        }

        atr
    }

    /// Average ATR over history (for volatility quartile comparison)
    fn average_atr(&self) -> f64 {
        if self.atr_history.is_empty() {
            return self.last_atr;
        }
        self.atr_history.iter().sum::<f64>() / self.atr_history.len() as f64
    }

    /// Detect reversal: BOS against prior regime with volume and volatility confirmation
    fn detect_reversal(
        &self,
        window: &[CandleData],
        counts: &StructureCounts,
        net_change: f64,
        atr_ratio: f64,
        volume_surge: bool,
    ) -> bool {
        // Reversal requires:
        // 1. Prior regime was trending (stored in last_regime)
        // 2. Current structure contradicts prior trend
        // 3. Volume surge or volatility spike
        // 4. Net change direction opposite to prior trend

        if counts.total_swings < 3 {
            return false;
        }

        let prior_trending = matches!(
            self.last_regime,
            RegimeType::Trending | RegimeType::Breakout
        );
        let prior_reversal = matches!(self.last_regime, RegimeType::Reversal);

        // Allow reversal detection even without prior trending regime when:
        // - total_swings shows enough structure
        // - volatility/volume confirms the reversal
        // - structure_change is clear (LH+LL or HH+HL)
        // This handles cases where gentle trends (below structure threshold)
        // still produce clear reversals in cumulative price direction.
        // Relaxed volatility/volume — computed once, used in both the
        // no-prior-regime and prior-reversal branches below
        let volatility_or_volume = atr_ratio >= 1.0 || volume_surge
            || (counts.lh_count >= 2 && counts.ll_count >= 2)
            || (counts.hh_count >= 2 && counts.hl_count >= 2);

        if !prior_trending && !prior_reversal {
            // Without a prior trending/breakout regime, reversal is not
            // well-defined (there's no trend to reverse from). The structure
            // counts here just indicate a new trend forming, not a reversal.
            // Return false and let the main classification handle it via
            // trending_bullish / trending_bearish checks.
            return false;
        }



        // If we were already in a reversal, continue the counter-trend direction
        // The reversal goes AGAINST the prior trend, so:
        // - If last trend was BULLISH, reversal is bearish → expect LH+LL (bearish structure)
        // - If last trend was BEARISH, reversal is bullish → expect HH+HL (bullish structure)
        if prior_reversal {
            if self.last_trend_was_bullish() {
                // Trend was up → reversal is bearish
                // Continue expecting LH+LL (bearish structure)
                if counts.lh_count >= 1 && counts.ll_count >= 1 {
                    return volatility_or_volume;
                }
            } else {
                // Trend was down → reversal is bullish
                // Continue expecting HH+HL (bullish structure)
                if counts.hh_count >= 1 && counts.hl_count >= 1 {
                    return volatility_or_volume;
                }
            }
            return false;
        }

        // Check for structure change against current price direction
        // A reversal means the swing structure contradicts the immediate price move.
        // Price up (net_change > 0): reversal must show bearish structure (LH+LL).
        // Price down (net_change < 0): reversal must show bullish structure (HH+HL).
        // No net change (≈0): not a reversal.
        // This is more robust than last_trend_was_bullish() which returns false
        // for both neutral and bullish breakout regimes, causing false positives.
        let structure_change = if net_change > 0.0 {
            counts.lh_count >= 1 && counts.ll_count >= 1
        } else if net_change < 0.0 {
            counts.hh_count >= 1 && counts.hl_count >= 1
        } else {
            false
        };

        // Relaxed: volatility/volume OR sufficient swing counts (at least 2 pairs)
        let volatility_or_volume = atr_ratio >= 1.0 || volume_surge || (counts.lh_count >= 2 && counts.ll_count >= 2)
            || (counts.hh_count >= 2 && counts.hl_count >= 2);

        structure_change && volatility_or_volume
    }

    /// Heuristic: was the last trend bullish? (based on stored state tracking)
    /// Uses the buffer's earlier half vs later half to determine direction.
    /// If the earlier part is higher, the trend has shifted down (previously up).
    /// If the later part is higher, the trend is still up.
    fn last_trend_was_bullish(&self) -> bool {
        // We check if we have enough recent candles to determine direction
        // by comparing net price change over the lookback period
        let len = self.candles.len();
        if len < 5 {
            return false;
        }

        let midpoint = len / 2;
        // Use early half (before midpoint) vs late half (after midpoint)
        let early_start = (midpoint / 2).max(0);
        let late_start = midpoint;
        let half_len = (midpoint / 2).max(1);

        let early_avg = self.candles[early_start..early_start + half_len.min(len - early_start)]
            .iter()
            .map(|c| c.close)
            .sum::<f64>()
            / half_len as f64;
        let late_avg = self.candles[late_start..late_start + half_len.min(len - late_start)]
            .iter()
            .map(|c| c.close)
            .sum::<f64>()
            / half_len as f64;

        // If early candles are higher than late candles, the trend was bullish
        // (price has fallen since, meaning a bearish reversal from a prior up-trend)
        // Actually: when early_avg > late_avg, the prior trend was higher → was bullish
        // When late_avg > early_avg, price is still rising → still bullish
        // We check: was price going up BEFORE the reversal?
        // Compare the very first portion vs the early middle portion
        let before_reversal_start = (midpoint / 4).max(0);
        let before_reversal_mid = midpoint / 2;
        let quarter_len = (midpoint / 4).max(1);

        let early_quarter_avg = self.candles[before_reversal_start..before_reversal_start + quarter_len.min(len - before_reversal_start)]
            .iter()
            .map(|c| c.close)
            .sum::<f64>()
            / quarter_len as f64;
        let mid_quarter_avg = self.candles[before_reversal_mid..before_reversal_mid + quarter_len.min(len - before_reversal_mid)]
            .iter()
            .map(|c| c.close)
            .sum::<f64>()
            / quarter_len as f64;

        // If the first quarter is lower than mid quarter, it was trending up (bullish)
        // Meaning: price increased from early to mid → was bullish
        let was_bullish_before = (mid_quarter_avg - early_quarter_avg) / early_quarter_avg.abs().max(0.0001)
            > self.config.trend_threshold;

        // Also check if late portion is still above early portion
        // (still in uptrend overall)
        let still_bullish = (late_avg - early_avg) / early_avg.abs().max(0.0001)
            > self.config.trend_threshold;

        was_bullish_before || still_bullish
    }

    /// Compute confidence score (0.0 - 1.0) based on signal strength
    fn compute_confidence(
        &self,
        counts: &StructureCounts,
        window: &[CandleData],
        atr_ratio: f64,
        volume_surge: bool,
    ) -> f64 {
        let mut score = 0.5; // Baseline

        // Structure clarity: more HH/HL pairs = higher confidence
        let structure_score = (counts.hh_count + counts.hl_count + counts.lh_count + counts.ll_count)
            as f64
            / (self.config.lookback_period as f64 * 0.3);
        score += structure_score.min(0.2);

        // Volatility consistency
        if atr_ratio >= 1.0 && atr_ratio <= 3.0 {
            score += 0.1;
        }

        // Volume confirmation
        if volume_surge {
            score += 0.1;
        }

        // Sufficient data penalizer
        if window.len() < self.config.lookback_period {
            score *= window.len() as f64 / self.config.lookback_period as f64;
        }

        // Bounded [0, 1]
        score.clamp(0.0, 1.0)
    }
}

// ── Pure function alternative for stateless use ──

/// Stateless regime detection from a slice of candles.
/// Useful for backtesting or when you don't need incremental updates.
pub fn detect_regime_from_candles(
    candles: &[CandleData],
    config: &RegimeDetectorConfig,
) -> RegimeUpdate {
    let mut detector = RegimeDetector::new(config.clone());
    let mut last_update = RegimeUpdate {
        regime: RegimeType::Ranging,
        trend_direction: TrendDirection::Neutral,
        volatility: 0.0,
        confidence: 0.0,
        timestamp: 0,
    };

    for candle in candles {
        last_update = detector.update(candle);
    }

    last_update
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    // ── Helpers: generate synthetic candle data ──

    /// Generate rising HH/HL sequence (bullish trending)
    fn trending_up_candles(count: usize) -> Vec<CandleData> {
        let mut candles = Vec::with_capacity(count);
        let start_price = 100.0;
        let ts_start = 1718000000000;

        for i in 0..count {
            let open = start_price + i as f64 * 0.5;
            let close = open + 0.3 + (i % 3) as f64 * 0.1;
            let high = open + 1.0 + (i % 2) as f64 * 0.5;
            let low = open - 0.5 - (i % 3) as f64 * 0.2;
            let volume = 1000000.0 + (i % 7) as f64 * 100000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high.max(close + 0.1),
                low.min(close - 0.1),
                close.max(open + 0.01),
                volume,
            ));
        }

        candles
    }

    /// Generate falling LH/LL sequence (bearish trending)
    fn trending_down_candles(count: usize) -> Vec<CandleData> {
        let mut candles = Vec::with_capacity(count);
        let start_price = 110.0;
        let ts_start = 1718000000000;

        for i in 0..count {
            let open = start_price - i as f64 * 0.5;
            let close = open - 0.3 - (i % 3) as f64 * 0.1;
            let high = open + 0.5 + (i % 2) as f64 * 0.3;
            let low = open - 1.0 - (i % 3) as f64 * 0.5;
            let volume = 1000000.0 + (i % 7) as f64 * 100000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open.max(close + 0.01),
                high.max(close + 0.1),
                low.min(close - 0.1),
                close.max(low + 0.01),
                volume,
            ));
        }

        candles
    }

    /// Generate ranging/oscillating price (no clear direction)
    fn ranging_candles(count: usize) -> Vec<CandleData> {
        let mut candles = Vec::with_capacity(count);
        let base_price = 100.0;
        let ts_start = 1718000000000;

        for i in 0..count {
            let offset = (i as f64 * 0.5).sin() * 0.5; // oscillation ~±0.5
            let open = base_price + offset;
            let close = base_price + (offset * 0.8);
            let high = open + 0.3;
            let low = open - 0.3;
            let volume = 500000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high,
                low,
                close,
                volume,
            ));
        }

        candles
    }

    /// Generate compression → breakout pattern
    fn breakout_candles(count: usize) -> Vec<CandleData> {
        let mut candles = Vec::with_capacity(count);
        let base_price = 100.0;
        let ts_start = 1718000000000;

        // First 2/3: compression (ranging, low volatility)
        let compress_end = count * 2 / 3;
        for i in 0..compress_end {
            let noise = (i as f64 * 0.3).sin() * 0.15;
            let open = base_price + noise;
            let close = base_price + noise * 0.9;
            let high = open + 0.1;
            let low = open - 0.1;
            let volume = 300000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high,
                low,
                close,
                volume,
            ));
        }

        // Last 1/3: explosive breakout upward
        for i in compress_end..count {
            let progress = (i - compress_end) as f64;
            let open = base_price + progress * 0.3;
            let close = open + 0.5 + (i % 2) as f64 * 0.2;
            let high = open + 1.0 + (i % 2) as f64 * 0.3;
            let low = open - 0.1;
            let volume = 2_000_000.0 + (i % 5) as f64 * 500000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high,
                low,
                close,
                volume,
            ));
        }

        candles
    }

    /// Generate reversal pattern: uptrend → downtrend with BOS
    fn reversal_candles(count: usize) -> Vec<CandleData> {
        let mut candles = Vec::with_capacity(count);
        let ts_start = 1718000000000;
        let midpoint = count / 2;

        // First half: strong uptrend
        for i in 0..midpoint {
            let open = 100.0 + i as f64 * 0.6;
            let close = open + 0.4;
            let high = open + 1.2;
            let low = open - 0.3;
            let volume = 1_000_000.0;

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high,
                low,
                close,
                volume,
            ));
        }

        // Second half: sharp reversal downward
        for i in midpoint..count {
            let progress = (i - midpoint) as f64;
            let open = 100.0 + midpoint as f64 * 0.6 - progress * 0.8;
            let close = open - 0.5;
            let high = open + 0.3;
            let low = open - 1.5;
            let volume = 3_000_000.0 + (i % 3) as f64 * 500000.0; // volume surge

            candles.push(CandleData::new(
                ts_start + i as i64 * 3600000,
                open,
                high,
                low,
                close,
                volume,
            ));
        }

        candles
    }

    // ── Test: CandleData true_range ──

    #[test]
    fn test_true_range() {
        let candle = CandleData::new(1, 100.0, 105.0, 98.0, 102.0, 1_000_000.0);

        // TR = max(HL, |H - prev_C|, |L - prev_C|)
        // HL = 105 - 98 = 7
        // |H - prev_C| = |105 - 101| = 4
        // |L - prev_C| = |98 - 101| = 3
        // TR = max(7, 4, 3) = 7
        let tr = candle.true_range(101.0);
        assert!((tr - 7.0).abs() < 0.001, "TR should be 7, got {}", tr);
    }

    // ── Test 1: Rising HH/HL → Trending Bullish ──

    #[test]
    fn test_trending_up_detected() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config.clone());

        let candles = trending_up_candles(60);
        let mut last_update = None;

        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert!(
            update.regime == RegimeType::Trending || update.regime == RegimeType::Breakout,
            "Expected Trending or Breakout, got {:?}",
            update.regime
        );
        assert_eq!(update.trend_direction, TrendDirection::Bullish);
        assert!(
            update.confidence > 0.5,
            "Confidence should be > 0.5, got {}",
            update.confidence
        );
    }

    // ── Test 2: Falling LH/LL → Trending Bearish ──

    #[test]
    fn test_trending_down_detected() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config.clone());

        let candles = trending_down_candles(60);
        let mut last_update = None;

        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert!(
            update.regime == RegimeType::Trending || update.regime == RegimeType::Breakout,
            "Expected Trending or Breakout, got {:?}",
            update.regime
        );
        assert_eq!(update.trend_direction, TrendDirection::Bearish);
    }

    // ── Test 3: Oscillating range → Ranging ──

    #[test]
    fn test_ranging_detected() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config.clone());

        let candles = ranging_candles(60);
        let mut last_update = None;

        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert_eq!(
            update.regime,
            RegimeType::Ranging,
            "Expected Ranging, got {:?}",
            update.regime
        );
        assert_eq!(update.trend_direction, TrendDirection::Neutral);
    }

    // ── Test 4: Compression → breakout ──

    #[test]
    fn test_breakout_detected() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config.clone());

        let candles = breakout_candles(60);
        let mut last_update = None;

        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert!(
            update.regime == RegimeType::Breakout || update.regime == RegimeType::Trending,
            "Expected Breakout or Trending, got {:?}",
            update.regime
        );
        assert!(
            update.confidence > 0.3,
            "Confidence should be > 0.3, got {}",
            update.confidence
        );
    }

    // ── Test 5: Trend reversal with BOS → Reversal ──

    #[test]
    fn test_reversal_detected() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config.clone());

        let candles = reversal_candles(60);
        let mut last_update = None;

        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert!(
            update.regime == RegimeType::Reversal,
            "Expected Reversal, got {:?}",
            update.regime
        );
        assert!(
            update.volatility > 0.0,
            "Volatility should be > 0"
        );
    }

    // ── Test 6: Insufficient data → Ranging / Neutral ──

    #[test]
    fn test_insufficient_data_returns_ranging() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config);

        // Only 3 candles — way below minimum lookback
        let candles = vec![
            CandleData::new(1, 100.0, 101.0, 99.0, 100.5, 1_000_000.0),
            CandleData::new(2, 100.5, 102.0, 100.0, 101.0, 1_000_000.0),
            CandleData::new(3, 101.0, 103.0, 100.5, 102.0, 1_000_000.0),
        ];

        let mut last_update = None;
        for candle in &candles {
            last_update = Some(detector.update(candle));
        }

        let update = last_update.expect("Should produce an update");
        assert_eq!(
            update.regime,
            RegimeType::Ranging,
            "Expected Ranging with insufficient data, got {:?}",
            update.regime
        );
        assert_eq!(update.trend_direction, TrendDirection::Neutral);
        // Confidence should be very low or zero
        assert!(
            update.confidence < 0.3,
            "Confidence should be < 0.3 with insufficient data, got {}",
            update.confidence
        );
    }

    // ── Test: Candle count tracking ──

    #[test]
    fn test_candle_count_grows() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config);

        assert_eq!(detector.candle_count(), 0);

        for i in 0..10 {
            detector.update(&CandleData::new(
                i, 100.0, 101.0, 99.0, 100.5, 1_000_000.0,
            ));
        }

        assert_eq!(detector.candle_count(), 10);
    }

    // ── Test: Reset clears state ──

    #[test]
    fn test_reset_clears_state() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config);

        for i in 0..30 {
            detector.update(&CandleData::new(
                i, 100.0, 101.0, 99.0, 100.5, 1_000_000.0,
            ));
        }

        assert!(detector.candle_count() > 0);
        detector.reset();
        assert_eq!(detector.candle_count(), 0);
    }

    // ── Test: Stateless detect_regime_from_candles ──

    #[test]
    fn test_stateless_detect_from_candles() {
        let config = RegimeDetectorConfig::default();
        let candles = trending_up_candles(40);

        let update = detect_regime_from_candles(&candles, &config);
        assert!(
            update.regime == RegimeType::Trending || update.regime == RegimeType::Breakout,
            "Expected Trending or Breakout from stateless detection, got {:?}",
            update.regime
        );
    }

    // ── Test: Buffer bounding (should not grow unbounded) ──

    #[test]
    fn test_buffer_bounded() {
        let config = RegimeDetectorConfig::default();
        let mut detector = RegimeDetector::new(config);

        // Feed many more candles than the buffer limit (lookback*4 = 80)
        let candles = ranging_candles(200);
        for candle in &candles {
            detector.update(candle);
        }

        // Should be bounded at 80 (lookback*4)
        assert!(
            detector.candle_count() <= 80,
            "Buffer should be bounded at 80, got {}",
            detector.candle_count()
        );
    }

    // ── Test: RegimeType label ──

    #[test]
    fn test_regime_type_labels() {
        assert_eq!(RegimeType::Trending.label(), "Trending");
        assert_eq!(RegimeType::Ranging.label(), "Ranging");
        assert_eq!(RegimeType::Breakout.label(), "Breakout");
        assert_eq!(RegimeType::Reversal.label(), "Reversal");
    }

    // ── Test: CandleData constructor ──

    #[test]
    fn test_candle_data_new() {
        let c = CandleData::new(100, 10.0, 12.0, 9.0, 11.0, 5000.0);
        assert_eq!(c.timestamp, 100);
        assert!((c.open - 10.0).abs() < 0.001);
        assert!((c.close - 11.0).abs() < 0.001);
        assert!((c.volume - 5000.0).abs() < 0.001);
    }
}
