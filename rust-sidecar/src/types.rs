//! Shared types for the flashloan sidecar.
//!
//! Core domain types used across all modules: price feeds, scanners,
//! memecoin detection, and gRPC signalling.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ── Address / ID aliases ──────────────────────────────────────────────

/// Ethereum address (hex, 0x-prefixed, checksummed).
pub type TokenAddress = String;

/// Pool identifier — typically the pool contract address.
pub type PoolId = String;

// ── DEX types ─────────────────────────────────────────────────────────

/// Supported DEX protocols on Base chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DexType {
    /// Aerodrome CL (concentrated liquidity)
    AerodromeCl,
    /// Aerodrome AMM (xy=k)
    AerodromeAmm,
    /// Uniswap V3 on Base
    UniswapV3,
    /// SushiSwap on Base
    SushiSwap,
}

impl std::fmt::Display for DexType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DexType::AerodromeCl => write!(f, "AerodromeCL"),
            DexType::AerodromeAmm => write!(f, "AerodromeAMM"),
            DexType::UniswapV3 => write!(f, "UniswapV3"),
            DexType::SushiSwap => write!(f, "SushiSwap"),
        }
    }
}

// ── Strategy types ────────────────────────────────────────────────────

/// Detection strategy that generated an opportunity signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// Triangle arbitrage (3-token cycle)
    TriangleArb,
    /// Cross-DEX price divergence
    CrossDexArb,
    /// Memecoin momentum / whale following
    MemecoinSnipe,
    /// Leverage farming via flash loan
    LeverageFarm,
}

impl std::fmt::Display for Strategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Strategy::TriangleArb => write!(f, "TriangleArb"),
            Strategy::CrossDexArb => write!(f, "CrossDexArb"),
            Strategy::MemecoinSnipe => write!(f, "MemecoinSnipe"),
            Strategy::LeverageFarm => write!(f, "LeverageFarm"),
        }
    }
}

// ── Price book types ──────────────────────────────────────────────────

/// A single price quote from a specific pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolQuote {
    /// Pool that produced this quote.
    pub pool_id: PoolId,
    /// DEX protocol.
    pub dex: DexType,
    /// Base token address.
    pub base_token: TokenAddress,
    /// Quote token address.
    pub quote_token: TokenAddress,
    /// Price as (amount_out / amount_in) scaled to 1e18.
    pub price: f64,
    /// Available liquidity in USD.
    pub liquidity_usd: f64,
    /// Unix timestamp (milliseconds) of this quote.
    pub timestamp_ms: u64,
}

/// Concurrent price book shared across all scanners.
///
/// Key: `(base_token, quote_token)` → sorted list of quotes by price.
pub type PriceBook = Arc<DashMap<(TokenAddress, TokenAddress), Vec<PoolQuote>>>;

// ── Route / opportunity types ─────────────────────────────────────────

/// A single hop in an arbitrage route.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteHop {
    /// Pool used for this hop.
    pub pool_id: PoolId,
    /// DEX protocol.
    pub dex: DexType,
    /// Token swapped from.
    pub token_in: TokenAddress,
    /// Token swapped to.
    pub token_out: TokenAddress,
    /// Expected amount out for 1 unit in.
    pub amount_out: f64,
}

/// An opportunity detected by a scanner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpportunitySignal {
    /// Strategy that produced this signal.
    pub strategy: Strategy,
    /// Route hops (2 for cross-DEX, 3 for triangle).
    pub hops: Vec<RouteHop>,
    /// Estimated gross profit (USD).
    pub gross_profit_usd: f64,
    /// Estimated net profit after gas + flash-loan fee (USD).
    pub net_profit_usd: f64,
    /// Confidence score 0..1.
    pub confidence: f64,
    /// Unix timestamp (ms).
    pub detected_at_ms: u64,
}

// ── Pool configuration (loaded at startup) ────────────────────────────

/// Static pool configuration entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    pub pool_id: PoolId,
    pub dex: DexType,
    pub token_a: TokenAddress,
    pub token_b: TokenAddress,
    pub fee_bps: u16,
}

/// Full pool configuration file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolsConfig {
    pub pools: Vec<PoolConfig>,
}

// ── Memecoin types ────────────────────────────────────────────────────

/// A memecoin token being tracked.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemecoinToken {
    pub address: TokenAddress,
    pub symbol: String,
    pub name: String,
    /// Age in seconds since deployment.
    pub age_secs: u64,
    /// 24h volume in USD.
    pub volume_24h_usd: f64,
    /// Market cap in USD.
    pub market_cap_usd: f64,
    /// Number of unique holders.
    pub holder_count: u64,
}

/// Whale activity event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhaleEvent {
    pub token: TokenAddress,
    pub wallet: String,
    pub amount_usd: f64,
    pub is_buy: bool,
    pub timestamp_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dex_type_display() {
        assert_eq!(DexType::AerodromeCl.to_string(), "AerodromeCL");
        assert_eq!(DexType::UniswapV3.to_string(), "UniswapV3");
    }

    #[test]
    fn strategy_display() {
        assert_eq!(Strategy::TriangleArb.to_string(), "TriangleArb");
    }

    #[test]
    fn pool_quote_serialization() {
        let q = PoolQuote {
            pool_id: "0xpool".into(),
            dex: DexType::UniswapV3,
            base_token: "0xbase".into(),
            quote_token: "0xquote".into(),
            price: 1500.0,
            liquidity_usd: 1_000_000.0,
            timestamp_ms: 1700000000000,
        };
        let json = serde_json::to_string(&q).unwrap();
        assert!(json.contains("uniswap_v3"));
        let back: PoolQuote = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pool_id, "0xpool");
    }

    #[test]
    fn price_book_insert_and_read() {
        let book: PriceBook = Arc::new(DashMap::new());
        let key = ("0xA".into(), "0xB".into());
        book.entry(key.clone()).or_insert_with(Vec::new).push(PoolQuote {
            pool_id: "0xp".into(),
            dex: DexType::AerodromeCl,
            base_token: "0xA".into(),
            quote_token: "0xB".into(),
            price: 1.5,
            liquidity_usd: 500_000.0,
            timestamp_ms: 0,
        });
        assert_eq!(book.get(&key).unwrap().len(), 1);
    }
}
