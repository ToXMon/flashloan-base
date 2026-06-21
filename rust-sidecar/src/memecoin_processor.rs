//! Memecoin opportunity processor.
//!
//! Tracks new token deployments, detects whale accumulations,
//! and generates `OpportunitySignal::MemecoinSnipe` signals
//! when momentum and volume criteria are met.

use crate::types::{
    MemecoinToken, OpportunitySignal, RouteHop, Strategy, TokenAddress, WhaleEvent,
};
use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::broadcast;
use tracing::info;

/// Configuration filters for memecoin tracking.
#[derive(Debug, Clone)]
pub struct MemecoinFilters {
    /// Minimum 24h volume in USD to consider.
    pub min_volume_usd: f64,
    /// Maximum token age in seconds (ignore old tokens).
    pub max_age_secs: u64,
    /// Minimum whale buy to trigger a signal.
    pub min_whale_buy_usd: f64,
    /// Minimum holder count to consider legitimate.
    pub min_holder_count: u64,
}

impl Default for MemecoinFilters {
    fn default() -> Self {
        Self {
            min_volume_usd: 10_000.0,
            max_age_secs: 86_400,
            min_whale_buy_usd: 5_000.0,
            min_holder_count: 50,
        }
    }
}

/// Memecoin processor tracking state.
pub struct MemecoinProcessor {
    /// Tracked tokens by address.
    tokens: HashMap<TokenAddress, MemecoinToken>,
    /// Recent whale events per token.
    whale_events: HashMap<TokenAddress, Vec<WhaleEvent>>,
    /// Filters.
    filters: MemecoinFilters,
}

impl MemecoinProcessor {
    /// Create a new memecoin processor.
    pub fn new(filters: MemecoinFilters) -> Self {
        Self {
            tokens: HashMap::new(),
            whale_events: HashMap::new(),
            filters,
        }
    }

    /// Add or update a tracked token.
    pub fn upsert_token(&mut self, token: MemecoinToken) {
        self.tokens.insert(token.address.clone(), token);
    }

    /// Record a whale event and check if it triggers a signal.
    ///
    /// Returns an `OpportunitySignal` if:
    /// - Buy exceeds `min_whale_buy_usd`
    /// - Token passes volume and age filters
    /// - Multiple whales accumulated recently
    pub fn process_whale_event(&mut self, event: WhaleEvent) -> Option<OpportunitySignal> {
        // Only process buys
        if !event.is_buy {
            return None;
        }

        // Check token exists and passes filters
        let token = self.tokens.get(&event.token)?;
        if token.volume_24h_usd < self.filters.min_volume_usd {
            return None;
        }
        if token.age_secs > self.filters.max_age_secs {
            return None;
        }

        // Record event
        self.whale_events
            .entry(event.token.clone())
            .or_insert_with(Vec::new)
            .push(event.clone());

        // Check whale buy threshold
        if event.amount_usd < self.filters.min_whale_buy_usd {
            return None;
        }

        // Count recent whale buys (last 10 events)
        let whale_count = self
            .whale_events
            .get(&event.token)
            .map(|events| {
                events
                    .iter()
                    .rev()
                    .take(10)
                    .filter(|e| e.is_buy && e.amount_usd >= self.filters.min_whale_buy_usd)
                    .count()
            })
            .unwrap_or(0);

        // Need at least 2 significant whale buys for a signal
        if whale_count < 2 {
            return None;
        }

        let confidence = (whale_count as f64 / 10.0).min(1.0);

        Some(OpportunitySignal {
            strategy: Strategy::MemecoinSnipe,
            hops: vec![RouteHop {
                pool_id: String::new(), // TODO: fill from DEX pool
                dex: crate::types::DexType::AerodromeCl,
                token_in: "0xETH".into(), // TODO: real WETH address
                token_out: event.token.clone(),
                amount_out: token.market_cap_usd,
            }],
            gross_profit_usd: 0.0, // TODO: estimate from momentum
            net_profit_usd: 0.0,
            confidence,
            detected_at_ms: event.timestamp_ms,
        })
    }

    /// Get a tracked token by address.
    pub fn get_token(&self, address: &TokenAddress) -> Option<&MemecoinToken> {
        self.tokens.get(address)
    }

    /// Get whale event count for a token.
    pub fn whale_event_count(&self, address: &TokenAddress) -> usize {
        self.whale_events.get(address).map(|v| v.len()).unwrap_or(0)
    }

    /// Number of tracked tokens.
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// Run the processor loop.
    ///
    /// TODO: Subscribe to new token events, process in real-time.
    pub async fn run(&mut self, _signal_tx: broadcast::Sender<OpportunitySignal>) -> Result<()> {
        info!(
            "MemecoinProcessor starting — min_vol=${}, max_age={}s",
            self.filters.min_volume_usd, self.filters.max_age_secs
        );
        // TODO: subscribe to new pair events on Aerodrome
        // TODO: track whale wallets via large transfer filters
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_token(address: &str, volume: f64, age: u64) -> MemecoinToken {
        MemecoinToken {
            address: address.into(),
            symbol: "TEST".into(),
            name: "Test Token".into(),
            age_secs: age,
            volume_24h_usd: volume,
            market_cap_usd: 100_000.0,
            holder_count: 200,
        }
    }

    #[test]
    fn filters_ignore_low_volume() {
        let mut proc = MemecoinProcessor::new(MemecoinFilters::default());
        proc.upsert_token(make_token("0x1", 5_000.0, 100)); // below min_volume
        let event = WhaleEvent {
            token: "0x1".into(),
            wallet: "0xw".into(),
            amount_usd: 10_000.0,
            is_buy: true,
            timestamp_ms: 1000,
        };
        assert!(proc.process_whale_event(event).is_none());
    }

    #[test]
    fn filters_ignore_old_tokens() {
        let mut proc = MemecoinProcessor::new(MemecoinFilters::default());
        proc.upsert_token(make_token("0x2", 50_000.0, 200_000)); // too old
        let event = WhaleEvent {
            token: "0x2".into(),
            wallet: "0xw".into(),
            amount_usd: 10_000.0,
            is_buy: true,
            timestamp_ms: 1000,
        };
        assert!(proc.process_whale_event(event).is_none());
    }

    #[test]
    fn single_whale_no_signal() {
        let mut proc = MemecoinProcessor::new(MemecoinFilters::default());
        proc.upsert_token(make_token("0x3", 50_000.0, 100));
        let event = WhaleEvent {
            token: "0x3".into(),
            wallet: "0xw".into(),
            amount_usd: 10_000.0,
            is_buy: true,
            timestamp_ms: 1000,
        };
        assert!(proc.process_whale_event(event).is_none()); // only 1 whale
    }

    #[test]
    fn two_whale_buys_emit_signal() {
        let mut proc = MemecoinProcessor::new(MemecoinFilters::default());
        proc.upsert_token(make_token("0x4", 50_000.0, 100));

        // First whale
        let e1 = WhaleEvent {
            token: "0x4".into(),
            wallet: "0xw1".into(),
            amount_usd: 10_000.0,
            is_buy: true,
            timestamp_ms: 1000,
        };
        assert!(proc.process_whale_event(e1).is_none());

        // Second whale triggers
        let e2 = WhaleEvent {
            token: "0x4".into(),
            wallet: "0xw2".into(),
            amount_usd: 10_000.0,
            is_buy: true,
            timestamp_ms: 2000,
        };
        let signal = proc.process_whale_event(e2);
        assert!(signal.is_some());
        let s = signal.unwrap();
        assert_eq!(s.strategy, Strategy::MemecoinSnipe);
        assert!(s.confidence > 0.0);
    }

    #[test]
    fn sell_events_ignored() {
        let mut proc = MemecoinProcessor::new(MemecoinFilters::default());
        proc.upsert_token(make_token("0x5", 50_000.0, 100));
        let event = WhaleEvent {
            token: "0x5".into(),
            wallet: "0xw".into(),
            amount_usd: 50_000.0,
            is_buy: false,
            timestamp_ms: 1000,
        };
        assert!(proc.process_whale_event(event).is_none());
    }
}
