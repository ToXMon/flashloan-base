//! Concurrent price book for real-time DEX pool prices.
//!
//! DashMap-based in-memory store keyed by pool address, supporting
//! concurrent reads from scanners and writes from WebSocket price feeds.

use crate::types::DexType;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ── Pool quote (pool-address-keyed) ─────────────────────────────────

/// A price quote from a single DEX pool, keyed by pool address.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolQuote {
    /// Pool contract address (0x-prefixed, checksummed).
    pub pool_address: String,
    /// DEX protocol that owns this pool.
    pub dex: DexType,
    /// Token A address.
    pub token_a: String,
    /// Token B address.
    pub token_b: String,
    /// Price of token A in terms of token B (amount of B per 1 A).
    pub price_a_to_b: f64,
    /// Price of token B in terms of token A (amount of A per 1 B).
    pub price_b_to_a: f64,
    /// Pool fee in basis points.
    pub fee_bps: u32,
    /// Available liquidity (raw units).
    pub liquidity: u128,
    /// Unix timestamp in milliseconds when this quote was captured.
    pub timestamp: i64,
    /// Block number when this quote was captured.
    pub block_number: u64,
}

// ── Triangle edge (for graph building) ──────────────────────────────

/// A directed edge in the triangle-arbitrage graph.
///
/// Each pool produces two edges: A→B and B→A.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriangleEdge {
    /// Source token address.
    pub from_token: String,
    /// Destination token address.
    pub to_token: String,
    /// Pool address providing this edge.
    pub pool_address: String,
    /// Pool fee in basis points.
    pub fee_bps: u32,
    /// Conversion price along this edge.
    pub price: f64,
}

// ── PriceBook ────────────────────────────────────────────────────────

/// Concurrent price book shared across threads.
///
/// Internally an `Arc<DashMap<String, PoolQuote>>` keyed by pool address.
/// Supports sub-microsecond reads and lock-free concurrent updates.
#[derive(Debug, Clone)]
pub struct PriceBook {
    inner: Arc<DashMap<String, PoolQuote>>,
}

impl PriceBook {
    /// Create an empty price book.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
        }
    }

    /// Insert or update a pool quote.
    ///
    /// If a quote for the same pool address already exists it is replaced.
    pub fn update(&self, quote: PoolQuote) {
        self.inner.insert(quote.pool_address.clone(), quote);
    }

    /// Look up a quote by pool address.
    pub fn get(&self, pool_address: &str) -> Option<PoolQuote> {
        self.inner.get(pool_address).map(|r| r.value().clone())
    }

    /// Return all quotes that involve the given token address.
    ///
    /// A pool matches if `token_a == token` **or** `token_b == token`.
    pub fn get_all_for_token(&self, token: &str) -> Vec<PoolQuote> {
        self.inner
            .iter()
            .filter(|entry| {
                let q = entry.value();
                q.token_a == token || q.token_b == token
            })
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Convert an amount of token A to token B using a specific pool.
    ///
    /// Returns `None` if the pool is not found.
    ///
    /// **Note:** This does **not** deduct fees — callers must account
    /// for `fee_bps` separately.
    pub fn get_price(&self, pool_address: &str, amount_a: f64) -> Option<f64> {
        self.inner.get(pool_address).map(|r| {
            let q = r.value();
            // Determine direction: if the caller wants to go A→B use price_a_to_b,
            // otherwise B→A. Since the key is the pool address, we return A→B.
            // Callers that need the reverse should divide by price_a_to_b or
            // multiply by price_b_to_a directly.
            amount_a * q.price_a_to_b
        })
    }

    /// Number of pools tracked.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// True when no pools are tracked.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Remove all entries.
    pub fn clear(&self) {
        self.inner.clear();
    }

    /// Iterator over all quotes (read-only guard per entry).
    ///
    /// Collect into a `Vec` if you need owned data or the borrow
    /// would outlive the DashMap guard.
    pub fn iter(&self) -> dashmap::iter::Iter<'_, String, PoolQuote> {
        self.inner.iter()
    }

    /// Build directed triangle-arbitrage edges from all pools.
    ///
    /// Each pool generates **two** edges:
    /// - `token_a → token_b` at `price_a_to_b`
    /// - `token_b → token_a` at `price_b_to_a`
    ///
    /// The triangle scanner feeds these into a `petgraph::DiGraph`.
    pub fn build_triangle_edges(&self) -> Vec<TriangleEdge> {
        self.inner
            .iter()
            .flat_map(|entry| {
                let q = entry.value();
                let pool = q.pool_address.clone();
                let fee = q.fee_bps;
                let a = q.token_a.clone();
                let b = q.token_b.clone();
                let p_ab = q.price_a_to_b;
                let p_ba = q.price_b_to_a;

                [
                    TriangleEdge {
                        from_token: a.clone(),
                        to_token: b.clone(),
                        pool_address: pool.clone(),
                        fee_bps: fee,
                        price: p_ab,
                    },
                    TriangleEdge {
                        from_token: b,
                        to_token: a,
                        pool_address: pool,
                        fee_bps: fee,
                        price: p_ba,
                    },
                ]
            })
            .collect()
    }
}

impl Default for PriceBook {
    fn default() -> Self {
        Self::new()
    }
}

// ── Unit tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_quote(pool: &str, a: &str, b: &str, p_ab: f64, p_ba: f64) -> PoolQuote {
        PoolQuote {
            pool_address: pool.to_string(),
            dex: DexType::AerodromeCl,
            token_a: a.to_string(),
            token_b: b.to_string(),
            price_a_to_b: p_ab,
            price_b_to_a: p_ba,
            fee_bps: 30,
            liquidity: 1_000_000,
            timestamp: 1_700_000_000_000,
            block_number: 12_345_678,
        }
    }

    #[test]
    fn create_empty_price_book() {
        let book = PriceBook::new();
        assert_eq!(book.len(), 0);
        assert!(book.is_empty());
    }

    #[test]
    fn update_and_get_quote() {
        let book = PriceBook::new();
        let quote = make_quote("0xpool1", "0xA", "0xB", 1500.0, 0.000667);
        book.update(quote);

        assert_eq!(book.len(), 1);
        let fetched = book.get("0xpool1").expect("pool should exist");
        assert_eq!(fetched.token_a, "0xA");
        assert_eq!(fetched.token_b, "0xB");
        assert!((fetched.price_a_to_b - 1500.0).abs() < f64::EPSILON);
    }

    #[test]
    fn update_replaces_existing() {
        let book = PriceBook::new();
        book.update(make_quote("0xpool1", "0xA", "0xB", 100.0, 0.01));
        book.update(make_quote("0xpool1", "0xA", "0xB", 200.0, 0.005));

        let fetched = book.get("0xpool1").unwrap();
        assert!((fetched.price_a_to_b - 200.0).abs() < f64::EPSILON);
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn get_nonexistent_returns_none() {
        let book = PriceBook::new();
        assert!(book.get("0xnope").is_none());
    }

    #[test]
    fn get_all_for_token_finds_multiple_pools() {
        let book = PriceBook::new();
        // ETH/USDC on Aerodrome
        book.update(make_quote("0xpool1", "0xETH", "0xUSDC", 3000.0, 0.000333));
        // ETH/USDT on Uniswap (same token_a)
        book.update(make_quote("0xpool2", "0xETH", "0xUSDT", 3001.0, 0.000333));
        // USDC/DAI (no ETH)
        book.update(make_quote("0xpool3", "0xUSDC", "0xDAI", 1.0, 1.0));

        let eth_pools = book.get_all_for_token("0xETH");
        assert_eq!(eth_pools.len(), 2);

        let usdc_pools = book.get_all_for_token("0xUSDC");
        assert_eq!(usdc_pools.len(), 2); // pool1 (as token_b) + pool3 (as token_a)

        let dai_pools = book.get_all_for_token("0xDAI");
        assert_eq!(dai_pools.len(), 1);

        let no_pools = book.get_all_for_token("0xNOPE");
        assert!(no_pools.is_empty());
    }

    #[test]
    fn get_price_converts_amount() {
        let book = PriceBook::new();
        book.update(make_quote("0xpool1", "0xA", "0xB", 1500.0, 0.000667));

        let result = book.get_price("0xpool1", 2.0).unwrap();
        assert!((result - 3000.0).abs() < 1e-9);
    }

    #[test]
    fn get_price_missing_pool() {
        let book = PriceBook::new();
        assert!(book.get_price("0xnope", 1.0).is_none());
    }

    #[test]
    fn build_triangle_edges_correctness() {
        let book = PriceBook::new();
        book.update(make_quote("0xp1", "0xETH", "0xUSDC", 3000.0, 1.0 / 3000.0));
        book.update(make_quote("0xp2", "0xUSDC", "0xDAI", 1.0, 1.0));

        let edges = book.build_triangle_edges();
        assert_eq!(edges.len(), 4); // 2 pools × 2 directions

        // Find ETH→USDC edge
        let eth_usdc = edges
            .iter()
            .find(|e| e.from_token == "0xETH" && e.to_token == "0xUSDC")
            .expect("ETH→USDC edge");
        assert_eq!(eth_usdc.pool_address, "0xp1");
        assert!((eth_usdc.price - 3000.0).abs() < 1e-9);
        assert_eq!(eth_usdc.fee_bps, 30);

        // Find USDC→ETH edge
        let usdc_eth = edges
            .iter()
            .find(|e| e.from_token == "0xUSDC" && e.to_token == "0xETH")
            .expect("USDC→ETH edge");
        assert!((usdc_eth.price - 1.0 / 3000.0).abs() < 1e-12);
    }

    #[test]
    fn clear_removes_all_entries() {
        let book = PriceBook::new();
        book.update(make_quote("0xp1", "0xA", "0xB", 1.0, 1.0));
        book.update(make_quote("0xp2", "0xC", "0xD", 2.0, 0.5));
        assert_eq!(book.len(), 2);

        book.clear();
        assert!(book.is_empty());
        assert_eq!(book.len(), 0);
    }

    #[test]
    fn default_trait_works() {
        let book = PriceBook::default();
        assert!(book.is_empty());
    }
}
