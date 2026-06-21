//! Triangle arbitrage scanner using petgraph.
//!
//! Finds profitable 3-token cycles across Aerodrome CL, Uniswap V3,
//! and Aerodrome AMM by maintaining a directed weighted graph of
//! all pool edges and enumerating simple cycles.
//!
//! ## Algorithm
//!
//! 1. Build a `DiGraph<token_address, EdgeData>` from the PriceBook edges.
//! 2. Keep the best edge (highest fee-adjusted price) per token pair.
//! 3. Enumerate all 3-node cycles: for each A→B→C, check if C→A exists.
//! 4. Compute fee-adjusted cycle product = adj(A→B) × adj(B→C) × adj(C→A).
//! 5. Filter by spread, net profit, and confidence thresholds.

use crate::config::Config;
use crate::price_book::{PriceBook, TriangleEdge};
use crate::types::{DexType, OpportunitySignal, RouteHop, Strategy};
use anyhow::Result;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::{debug, info};

/// Maximum tokens to consider for triangle scanning (performance guard).
const MAX_SCAN_TOKENS: usize = 20;

// ── Edge data ───────────────────────────────────────────────────────

/// Directed edge in the arbitrage graph (best route between two tokens).
#[derive(Debug, Clone)]
pub struct EdgeData {
    /// Pool contract address providing this route.
    pub pool_address: String,
    /// Pool fee in basis points.
    pub fee_bps: u32,
    /// Raw conversion price (amount_out per 1 unit_in).
    pub price: f64,
    /// DEX protocol providing this pool.
    pub dex: DexType,
}

// ── Triangle opportunity ────────────────────────────────────────────

/// A detected triangle arbitrage opportunity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriangleOpportunity {
    /// Token addresses forming the cycle [A, B, C].
    pub path: Vec<String>,
    /// Pool addresses for each hop [A→B pool, B→C pool, C→A pool].
    pub pools: Vec<String>,
    /// Gross spread in basis points (before costs).
    pub gross_profit_bps: i64,
    /// Estimated net profit in USD after all costs.
    pub net_profit_usd: f64,
    /// Confidence score 0.0..1.0 based on liquidity and spread.
    pub confidence: f64,
    /// Recommended input amount in USD (string for precision).
    pub input_amount: String,
    /// Unix timestamp (ms) when this opportunity expires (~2s Base block time).
    pub expires_at: i64,
}

impl TriangleOpportunity {
    /// Convert to an `OpportunitySignal` for gRPC broadcast.
    pub fn to_signal(&self) -> OpportunitySignal {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let input: f64 = self.input_amount.parse().unwrap_or(1000.0);

        // Build route hops from path + pools.
        // Each hop: pool_i takes token_i → token_{i+1 mod 3}.
        let mut hops = Vec::with_capacity(3);
        for i in 0..3 {
            let next = (i + 1) % 3;
            hops.push(RouteHop {
                pool_id: self.pools[i].clone(),
                dex: DexType::AerodromeCl, // Best-effort; exact dex requires edge data
                token_in: self.path[i].clone(),
                token_out: self.path[next].clone(),
                amount_out: 0.0, // Populated by executor with actual quotes
            });
        }

        OpportunitySignal {
            strategy: Strategy::TriangleArb,
            hops,
            gross_profit_usd: self.gross_profit_bps as f64 / 10000.0 * input,
            net_profit_usd: self.net_profit_usd,
            confidence: self.confidence,
            detected_at_ms: now_ms,
        }
    }

    /// Canonical key for deduplication (rotates path to start from smallest token).
    fn canonical_key(&self) -> Vec<String> {
        if self.path.is_empty() {
            return vec![];
        }
        let min_idx = (0..self.path.len())
            .min_by_key(|&i| &self.path[i])
            .unwrap_or(0);
        self.path
            .iter()
            .cycle()
            .skip(min_idx)
            .take(self.path.len())
            .cloned()
            .collect()
    }
}

// ── Scanner ─────────────────────────────────────────────────────────

/// Triangle arbitrage scanner.
///
/// Maintains a directed graph of token pairs and their prices,
/// then searches for profitable 3-hop cycles.
pub struct TriangleScanner {
    /// Shared price book (V2, pool-address-keyed).
    price_book: PriceBook,
    /// Configuration thresholds.
    config: Config,
    /// Directed graph: nodes = token addresses, edges = pool routes.
    graph: DiGraph<String, EdgeData>,
    /// Map token address → node index for fast lookup.
    token_index: HashMap<String, NodeIndex>,
    /// Running flag for continuous scanning.
    running: Arc<AtomicBool>,
    /// Cached raw edge count for change detection.
    cached_edge_count: usize,
}

impl TriangleScanner {
    /// Create a new triangle scanner.
    pub fn new(price_book: PriceBook, config: Config) -> Self {
        Self {
            price_book,
            config,
            graph: DiGraph::new(),
            token_index: HashMap::new(),
            running: Arc::new(AtomicBool::new(false)),
            cached_edge_count: 0,
        }
    }

    /// Ensure a token node exists in the graph, returning its index.
    fn ensure_node(&mut self, token: String) -> NodeIndex {
        if let Some(&idx) = self.token_index.get(&token) {
            return idx;
        }
        let idx = self.graph.add_node(token.clone());
        self.token_index.insert(token, idx);
        idx
    }

    /// Rebuild the graph from the current price book.
    ///
    /// Only rebuilds when the edge count changes (cheap invalidation check).
    /// Keeps the best edge (highest fee-adjusted price) per token pair.
    /// Limits to top-N most liquid tokens for performance.
    pub fn rebuild_graph(&mut self) {
        let raw_edges = self.price_book.build_triangle_edges();

        // Skip rebuild if edge count unchanged and graph is populated
        if raw_edges.len() == self.cached_edge_count && self.graph.node_count() > 0 {
            return;
        }
        self.cached_edge_count = raw_edges.len();

        // Determine top tokens by total liquidity
        let top_tokens = self.top_tokens_by_liquidity(&raw_edges, MAX_SCAN_TOKENS);

        self.graph = DiGraph::new();
        self.token_index.clear();

        // Keep best edge per (from, to) pair among top tokens
        let mut best_edges: HashMap<(String, String), EdgeData> = HashMap::new();

        for edge in &raw_edges {
            // Skip tokens not in the top set
            if !top_tokens.contains(&edge.from_token) || !top_tokens.contains(&edge.to_token) {
                continue;
            }

            let key = (edge.from_token.clone(), edge.to_token.clone());
            let adjusted_price = edge.price * (1.0 - edge.fee_bps as f64 / 10000.0);

            let should_replace = best_edges.get(&key).map_or(true, |existing| {
                let existing_adj = existing.price * (1.0 - existing.fee_bps as f64 / 10000.0);
                adjusted_price > existing_adj
            });

            if should_replace {
                // Look up DEX from the price book
                let dex = self
                    .price_book
                    .get(&edge.pool_address)
                    .map(|q| q.dex)
                    .unwrap_or(DexType::AerodromeCl);

                best_edges.insert(
                    key,
                    EdgeData {
                        pool_address: edge.pool_address.clone(),
                        fee_bps: edge.fee_bps,
                        price: edge.price,
                        dex,
                    },
                );
            }
        }

        // Populate graph
        for ((from, to), edge_data) in best_edges {
            let from_idx = self.ensure_node(from);
            let to_idx = self.ensure_node(to);
            self.graph.add_edge(from_idx, to_idx, edge_data);
        }

        debug!(
            "Graph rebuilt: {} nodes, {} edges (from {} raw edges, {} top tokens)",
            self.graph.node_count(),
            self.graph.edge_count(),
            raw_edges.len(),
            top_tokens.len(),
        );
    }

    /// Determine the top-N most liquid tokens from the edge set.
    fn top_tokens_by_liquidity(
        &self,
        edges: &[TriangleEdge],
        limit: usize,
    ) -> HashSet<String> {
        let mut token_liq: HashMap<String, u128> = HashMap::new();

        for edge in edges {
            if let Some(quote) = self.price_book.get(&edge.pool_address) {
                *token_liq.entry(edge.from_token.clone()).or_insert(0) += quote.liquidity;
                *token_liq.entry(edge.to_token.clone()).or_insert(0) += quote.liquidity;
            }
        }

        let mut ranked: Vec<_> = token_liq.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));

        ranked.into_iter().take(limit).map(|(t, _)| t).collect()
    }

    // ── Core scan ───────────────────────────────────────────────────

    /// Scan for profitable triangle cycles.
    ///
    /// Returns all opportunities with net profit >= `min_profit_usd`,
    /// deduplicated and sorted by net profit descending.
    pub fn scan(&mut self) -> Vec<TriangleOpportunity> {
        self.rebuild_graph();

        if self.graph.node_count() < 3 {
            return vec![];
        }

        let min_spread = self.config.min_spread_bps as f64 / 10000.0;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let mut opportunities: Vec<TriangleOpportunity> = Vec::new();

        // Enumerate all 3-node cycles: A → B → C → A
        for a_idx in self.graph.node_indices() {
            // Collect outgoing edges from A (clone data to avoid borrow issues)
            let edges_a: Vec<(NodeIndex, EdgeData)> = self
                .graph
                .edges(a_idx)
                .map(|e| (e.target(), e.weight().clone()))
                .collect();

            // Skip tokens with < 2 outgoing edges (can't form enough hops)
            if edges_a.len() < 1 {
                continue;
            }

            for (b_idx, edge_ab) in &edges_a {
                let edges_b: Vec<(NodeIndex, EdgeData)> = self
                    .graph
                    .edges(*b_idx)
                    .map(|e| (e.target(), e.weight().clone()))
                    .collect();

                for (c_idx, edge_bc) in &edges_b {
                    // C must differ from A (no 2-node degenerate cycles)
                    if *c_idx == a_idx {
                        continue;
                    }

                    // Check for C → A edge
                    let edge_ca_opt: Option<EdgeData> = self
                        .graph
                        .edges(*c_idx)
                        .find(|e| e.target() == a_idx)
                        .map(|e| e.weight().clone());

                    let edge_ca = match edge_ca_opt {
                        Some(e) => e,
                        None => continue,
                    };

                    // Fee-adjusted cycle product
                    let adj_ab = edge_ab.price * (1.0 - edge_ab.fee_bps as f64 / 10000.0);
                    let adj_bc = edge_bc.price * (1.0 - edge_bc.fee_bps as f64 / 10000.0);
                    let adj_ca = edge_ca.price * (1.0 - edge_ca.fee_bps as f64 / 10000.0);
                    let cycle_product = adj_ab * adj_bc * adj_ca;

                    let spread = cycle_product - 1.0;
                    if spread <= min_spread {
                        continue;
                    }

                    // Profitability
                    let input_amount = 1000.0;
                    let net_profit = self.compute_net_profit(spread, input_amount);

                    if net_profit < self.config.min_profit_usd {
                        continue;
                    }

                    // Confidence scoring
                    let pools = [
                        edge_ab.pool_address.as_str(),
                        edge_bc.pool_address.as_str(),
                        edge_ca.pool_address.as_str(),
                    ];
                    let confidence = self.compute_confidence(spread, &pools);

                    if confidence < 0.3 {
                        continue;
                    }

                    let token_a = self.graph[a_idx].clone();
                    let token_b = self.graph[*b_idx].clone();
                    let token_c = self.graph[*c_idx].clone();

                    opportunities.push(TriangleOpportunity {
                        path: vec![token_a, token_b, token_c],
                        pools: vec![
                            edge_ab.pool_address.clone(),
                            edge_bc.pool_address.clone(),
                            edge_ca.pool_address.clone(),
                        ],
                        gross_profit_bps: (spread * 10000.0).round() as i64,
                        net_profit_usd: net_profit,
                        confidence,
                        input_amount: format!("{:.2}", input_amount),
                        expires_at: now_ms + 2000, // ~2s Base block time
                    });
                }
            }
        }

        // Deduplicate by canonical path, keeping highest net profit per cycle
        let mut best_by_path: HashMap<Vec<String>, TriangleOpportunity> = HashMap::new();
        for opp in opportunities {
            let key = opp.canonical_key();
            best_by_path
                .entry(key)
                .and_modify(|existing| {
                    if opp.net_profit_usd > existing.net_profit_usd {
                        *existing = opp.clone();
                    }
                })
                .or_insert(opp);
        }

        let mut results: Vec<TriangleOpportunity> = best_by_path.into_values().collect();
        results.sort_by(|a, b| {
            b.net_profit_usd
                .partial_cmp(&a.net_profit_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        debug!("Scan complete: {} unique opportunities found", results.len());
        results
    }

    // ── Profitability ───────────────────────────────────────────────

    /// Compute net profit after all costs.
    ///
    /// Costs included:
    /// - Aave V3 flash loan fee (0.05% = 5 bps)
    /// - Gas estimate (~$0.01 on Base)
    /// - Slippage estimate (50 bps total across all hops)
    fn compute_net_profit(&self, spread: f64, input_amount: f64) -> f64 {
        let gross_profit = spread * input_amount;
        let aave_fee = input_amount * self.config.flash_loan_fee_bps as f64 / 10000.0;
        let gas_cost = 0.01; // ~$0.01 on Base (gas is very cheap)
        let slippage = input_amount * 0.005; // 50 bps total slippage estimate

        gross_profit - aave_fee - gas_cost - slippage
    }

    /// Compute confidence score based on spread magnitude and pool liquidity.
    ///
    /// Returns 0.0..1.0. Weighted combination:
    /// - 60% spread magnitude (higher spread = more margin for error)
    /// - 40% minimum pool liquidity across the three hops
    fn compute_confidence(&self, spread: f64, pool_addresses: &[&str]) -> f64 {
        // Spread-based confidence (60% weight)
        let spread_bps = spread * 10000.0;
        let spread_conf = if spread_bps >= 50.0 {
            0.95
        } else if spread_bps >= 30.0 {
            0.75
        } else if spread_bps >= 15.0 {
            0.55
        } else {
            0.25
        };

        // Liquidity-based confidence (40% weight)
        let liquidities: Vec<f64> = pool_addresses
            .iter()
            .filter_map(|addr| self.price_book.get(addr))
            .map(|q| q.liquidity as f64)
            .collect();

        let liquidity_conf = if liquidities.is_empty() {
            0.1 // Unknown liquidity → low confidence
        } else {
            let min_liq = liquidities.into_iter().fold(f64::MAX, f64::min);
            if min_liq >= 1_000_000.0 {
                1.0
            } else if min_liq >= 100_000.0 {
                0.8
            } else if min_liq >= 10_000.0 {
                0.5
            } else {
                0.2
            }
        };

        let score: f64 = spread_conf * 0.6 + liquidity_conf * 0.4;
        f64::min(score, 1.0)
    }

    // ── Continuous scanning ─────────────────────────────────────────

    /// Start continuous scanning at the configured interval.
    ///
    /// Publishes `OpportunitySignal` via the broadcast channel.
    /// Call `stop()` to terminate.
    pub async fn start_continuous(
        &mut self,
        tx: broadcast::Sender<OpportunitySignal>,
    ) -> Result<()> {
        let interval_ms = self.config.scan_interval_ms;
        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();

        info!(
            "TriangleScanner starting continuous mode — interval={}ms",
            interval_ms
        );

        let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));

        while running.load(Ordering::SeqCst) {
            interval.tick().await;

            let opportunities = self.scan();
            for opp in opportunities {
                let signal = opp.to_signal();
                let _ = tx.send(signal);
            }
        }

        info!("TriangleScanner stopped");
        Ok(())
    }

    /// Stop continuous scanning.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Get graph stats for monitoring: `(node_count, edge_count)`.
    pub fn stats(&self) -> (usize, usize) {
        (self.graph.node_count(), self.graph.edge_count())
    }
}

// ── Unit tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price_book::PoolQuote;
    use crate::types::DexType;

    /// Build a test config with tight thresholds.
    fn make_config() -> Config {
        Config {
            min_profit_usd: 0.10,
            min_spread_bps: 15,
            flash_loan_fee_bps: 5,
            scan_interval_ms: 1000,
            max_triangle_depth: 3,
            ..Config::default()
        }
    }

    /// Build a scanner backed by an empty price book.
    fn make_scanner() -> TriangleScanner {
        TriangleScanner::new(PriceBook::new(), make_config())
    }

    /// Helper: create a V2 PoolQuote.
    fn make_quote(
        pool: &str,
        token_a: &str,
        token_b: &str,
        price_ab: f64,
        price_ba: f64,
        fee_bps: u32,
        liquidity: u128,
    ) -> PoolQuote {
        PoolQuote {
            pool_address: pool.to_string(),
            dex: DexType::AerodromeCl,
            token_a: token_a.to_string(),
            token_b: token_b.to_string(),
            price_a_to_b: price_ab,
            price_b_to_a: price_ba,
            fee_bps,
            liquidity,
            timestamp: 0,
            block_number: 0,
        }
    }

    // ── Graph building ──────────────────────────────────────────────

    #[test]
    fn scanner_creation() {
        let scanner = make_scanner();
        let (nodes, edges) = scanner.stats();
        assert_eq!(nodes, 0);
        assert_eq!(edges, 0);
    }

    #[test]
    fn graph_rebuild_from_edges() {
        let book = PriceBook::new();
        book.update(make_quote(
            "0xP1", "0xA", "0xB",
            1.5, 0.667, 30, 100_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        scanner.rebuild_graph();

        let (nodes, edges) = scanner.stats();
        assert_eq!(nodes, 2, "should have 2 token nodes");
        // Two directed edges: A→B and B→A
        assert_eq!(edges, 2, "should have 2 directed edges (one per direction)");
    }

    #[test]
    fn graph_rebuild_keeps_best_edge_per_pair() {
        let book = PriceBook::new();
        // Two pools for the same pair with different prices
        book.update(make_quote(
            "0xP1", "0xA", "0xB",
            1.5, 0.667, 30, 100_000,
        ));
        book.update(make_quote(
            "0xP2", "0xA", "0xB",
            1.6, 0.625, 30, 100_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        scanner.rebuild_graph();

        let (_, edges) = scanner.stats();
        // Should still be 2 edges (one best per direction), not 4
        assert_eq!(edges, 2, "should deduplicate to best edge per direction");
    }

    #[test]
    fn graph_caching_skips_unchanged() {
        let book = PriceBook::new();
        book.update(make_quote(
            "0xP1", "0xA", "0xB",
            1.5, 0.667, 30, 100_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        scanner.rebuild_graph();
        let (n1, e1) = scanner.stats();

        // Rebuild without changes — should reuse cached graph
        scanner.rebuild_graph();
        let (n2, e2) = scanner.stats();

        assert_eq!((n1, e1), (n2, e2), "cached graph should be identical");
    }

    // ── Triangle detection ──────────────────────────────────────────

    #[test]
    fn scan_empty_graph_returns_nothing() {
        let mut scanner = make_scanner();
        assert!(scanner.scan().is_empty());
    }

    #[test]
    fn scan_two_tokens_no_triangle() {
        let book = PriceBook::new();
        book.update(make_quote(
            "0xP1", "0xA", "0xB",
            1.5, 0.667, 30, 100_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        assert!(scanner.scan().is_empty(), "need ≥3 tokens for a triangle");
    }

    #[test]
    fn triangle_detection_with_profitable_cycle() {
        let book = PriceBook::new();
        // Build a profitable triangle A→B→C→A
        // Each hop gains ~1% before fees:
        //   raw product = 1.01 × 1.01 × 1.01 = 1.030301
        //   after 5bps fees each: 1.01×0.9995 = 1.009495 per hop
        //   adjusted product = 1.009495³ ≈ 1.028689
        //   spread ≈ 287 bps
        book.update(make_quote(
            "0xP_AB", "0xA", "0xB",
            1.01, 0.9901, 5, 1_000_000,
        ));
        book.update(make_quote(
            "0xP_BC", "0xB", "0xC",
            1.01, 0.9901, 5, 1_000_000,
        ));
        book.update(make_quote(
            "0xP_CA", "0xC", "0xA",
            1.01, 0.9901, 5, 1_000_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        let opportunities = scanner.scan();

        assert!(!opportunities.is_empty(), "should detect at least one triangle");

        let opp = &opportunities[0];
        assert_eq!(opp.path.len(), 3, "triangle has 3 tokens");
        assert_eq!(opp.pools.len(), 3, "triangle has 3 pools");
        assert!(opp.gross_profit_bps > 0, "gross profit should be positive");
        assert!(
            opp.net_profit_usd >= 0.10,
            "net profit should exceed min_profit_usd, got {}",
            opp.net_profit_usd
        );
        assert!(
            opp.confidence >= 0.3,
            "confidence should meet threshold, got {}",
            opp.confidence
        );
        assert!(opp.expires_at > 0, "expiry should be set");
    }

    #[test]
    fn unprofitable_cycle_filtered_out() {
        let book = PriceBook::new();
        // Nearly flat cycle: 1.001 × 1.001 × 1.001 ≈ 1.003003
        // After 30bps fees each: 1.001×0.997 = 0.997997 per hop
        // Adjusted product = 0.997997³ ≈ 0.993998 → NEGATIVE spread
        book.update(make_quote(
            "0xP_AB", "0xA", "0xB",
            1.001, 0.999, 30, 100_000,
        ));
        book.update(make_quote(
            "0xP_BC", "0xB", "0xC",
            1.001, 0.999, 30, 100_000,
        ));
        book.update(make_quote(
            "0xP_CA", "0xC", "0xA",
            1.001, 0.999, 30, 100_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        let opportunities = scanner.scan();

        assert!(
            opportunities.is_empty(),
            "unprofitable cycle should be filtered out, got {}",
            opportunities.len()
        );
    }

    #[test]
    fn triangles_deduplicated() {
        let book = PriceBook::new();
        book.update(make_quote(
            "0xP_AB", "0xA", "0xB",
            1.02, 0.9804, 5, 1_000_000,
        ));
        book.update(make_quote(
            "0xP_BC", "0xB", "0xC",
            1.02, 0.9804, 5, 1_000_000,
        ));
        book.update(make_quote(
            "0xP_CA", "0xC", "0xA",
            1.02, 0.9804, 5, 1_000_000,
        ));

        let mut scanner = TriangleScanner::new(book, make_config());
        let opportunities = scanner.scan();

        // The same triangle is found from each starting node but should
        // be deduplicated to a single entry.
        assert_eq!(
            opportunities.len(),
            1,
            "should have exactly 1 deduplicated triangle, got {}",
            opportunities.len()
        );
    }

    // ── Profit calculation ──────────────────────────────────────────

    #[test]
    fn profit_calculation_after_fees() {
        let scanner = make_scanner();

        // 100 bps spread on $1000 input
        let spread = 0.01; // 100 bps
        let net = scanner.compute_net_profit(spread, 1000.0);

        // Gross: 0.01 × 1000 = $10.00
        // Aave fee: 1000 × 5/10000 = $0.50
        // Gas: $0.01
        // Slippage: 1000 × 0.005 = $5.00
        // Net: 10.00 − 0.50 − 0.01 − 5.00 = $4.49
        let expected = 10.0 - 0.50 - 0.01 - 5.00;
        let diff = (net - expected).abs();
        assert!(diff < 0.01, "net profit: got {:.4}, expected {:.4}", net, expected);
        assert!(net > 0.0, "should be profitable");
    }

    #[test]
    fn profit_negative_for_tight_spread() {
        let scanner = make_scanner();

        // 5 bps spread on $1000 input
        let spread = 0.0005; // 5 bps
        let net = scanner.compute_net_profit(spread, 1000.0);

        // Gross: 0.0005 × 1000 = $0.50
        // Aave fee: $0.50
        // Gas: $0.01
        // Slippage: $5.00
        // Net: 0.50 − 0.50 − 0.01 − 5.00 = −$5.01
        assert!(net < 0.0, "tight spread should yield negative net profit");
    }

    // ── Confidence scoring ──────────────────────────────────────────

    #[test]
    fn confidence_range_and_monotonicity() {
        let book = PriceBook::new();
        book.update(make_quote(
            "0xP1", "0xA", "0xB",
            1.5, 0.667, 5, 500_000,
        ));
        book.update(make_quote(
            "0xP2", "0xB", "0xC",
            1.5, 0.667, 5, 500_000,
        ));
        book.update(make_quote(
            "0xP3", "0xC", "0xA",
            1.5, 0.667, 5, 500_000,
        ));

        let scanner = TriangleScanner::new(book, make_config());

        let conf_high = scanner.compute_confidence(0.005, &["0xP1", "0xP2", "0xP3"]);
        let conf_low = scanner.compute_confidence(0.001, &["0xP1", "0xP2", "0xP3"]);

        assert!(
            conf_high > 0.5,
            "high spread (50 bps) confidence should be > 0.5, got {}",
            conf_high
        );
        assert!(
            conf_low < conf_high,
            "lower spread should give lower confidence: {} vs {}",
            conf_low, conf_high
        );
        assert!(conf_high <= 1.0 && conf_high >= 0.0, "out of range");
        assert!(conf_low <= 1.0 && conf_low >= 0.0, "out of range");
    }

    #[test]
    fn confidence_low_for_unknown_pools() {
        let scanner = make_scanner();

        // Pools not in price book → unknown liquidity → low confidence
        let conf = scanner.compute_confidence(0.001, &["0xUNKNOWN1", "0xUNKNOWN2", "0xUNKNOWN3"]);
        assert!(
            conf < 0.3,
            "unknown pools should yield low confidence, got {}",
            conf
        );
    }

    // ── Stop flag ───────────────────────────────────────────────────

    #[test]
    fn stop_sets_running_false() {
        let scanner = make_scanner();
        assert!(!scanner.running.load(Ordering::SeqCst));
        scanner.running.store(true, Ordering::SeqCst);
        assert!(scanner.running.load(Ordering::SeqCst));
        scanner.stop();
        assert!(!scanner.running.load(Ordering::SeqCst));
    }

    // ── Edge case: profit formula precision ──────────────────────

    #[test]
    fn profit_formula_matches_specification() {
        let scanner = make_scanner();
        // Formula: net = spread*input - input*(fee_bps/10000) - 0.01 - input*0.005
        // For $1000, fee_bps=5: net = spread*1000 - 0.50 - 0.01 - 5.00 = spread*1000 - 5.51

        // Case 1: 100 bps spread on $1000 → net = 10.00 - 5.51 = $4.49
        let net = scanner.compute_net_profit(0.01, 1000.0);
        assert!((net - 4.49).abs() < 0.001, "100bps/$1000: expected 4.49, got {:.4}", net);

        // Case 2: 56.1 bps → net ≈ 5.61 - 5.51 = $0.10 (exact minimum threshold)
        let net_threshold = scanner.compute_net_profit(0.00561, 1000.0);
        assert!((net_threshold - 0.10).abs() < 0.001, "56.1bps threshold: expected 0.10, got {:.6}", net_threshold);

        // Case 3: zero spread → net = -5.51 (pure cost)
        let net_zero = scanner.compute_net_profit(0.0, 1000.0);
        assert!((net_zero - (-5.51)).abs() < 0.001, "zero spread: expected -5.51, got {:.4}", net_zero);

        // Case 4: $500 input, 100 bps → net = 5.00 - 0.25 - 0.01 - 2.50 = $2.24
        let net_500 = scanner.compute_net_profit(0.01, 500.0);
        assert!((net_500 - 2.24).abs() < 0.001, "$500/100bps: expected 2.24, got {:.4}", net_500);
    }

    // ── Edge case: multiple opportunities sorted descending ──────

    #[test]
    fn multiple_opportunities_sorted_by_net_profit_descending() {
        let book = PriceBook::new();

        // Triangle 1: A→B→C→A — high profit (2% per hop, 5 bps fee)
        book.update(make_quote("0xP_AB", "0xA", "0xB", 1.02, 0.9804, 5, 1_000_000));
        book.update(make_quote("0xP_BC", "0xB", "0xC", 1.02, 0.9804, 5, 1_000_000));
        book.update(make_quote("0xP_CA", "0xC", "0xA", 1.02, 0.9804, 5, 1_000_000));

        // Triangle 2: D→E→F→D — moderate profit (1.5% per hop, 5 bps fee)
        book.update(make_quote("0xP_DE", "0xD", "0xE", 1.015, 0.9852, 5, 1_000_000));
        book.update(make_quote("0xP_EF", "0xE", "0xF", 1.015, 0.9852, 5, 1_000_000));
        book.update(make_quote("0xP_FD", "0xF", "0xD", 1.015, 0.9852, 5, 1_000_000));

        let mut scanner = TriangleScanner::new(book, make_config());
        let opps = scanner.scan();

        assert!(opps.len() >= 2, "should find at least 2 triangles, got {}", opps.len());

        // Verify sorted descending by net_profit_usd
        for i in 1..opps.len() {
            assert!(
                opps[i - 1].net_profit_usd >= opps[i].net_profit_usd,
                "not sorted: opp[{}].net={:.4} < opp[{}].net={:.4}",
                i - 1, opps[i - 1].net_profit_usd, i, opps[i].net_profit_usd
            );
        }

        // First triangle (2% hops) should have higher profit than second (1.5% hops)
        assert!(
            opps[0].net_profit_usd > opps[1].net_profit_usd,
            "first triangle should be more profitable: {:.4} vs {:.4}",
            opps[0].net_profit_usd, opps[1].net_profit_usd
        );
    }

    // ── Edge case: confidence at maximum tier ────────────────────

    #[test]
    fn confidence_at_maximum_tier() {
        let book = PriceBook::new();
        // 2M+ liquidity per pool → liq_conf = 1.0
        book.update(make_quote("0xP1", "0xA", "0xB", 1.5, 0.667, 5, 2_000_000));
        book.update(make_quote("0xP2", "0xB", "0xC", 1.5, 0.667, 5, 2_000_000));
        book.update(make_quote("0xP3", "0xC", "0xA", 1.5, 0.667, 5, 2_000_000));

        let scanner = TriangleScanner::new(book, make_config());

        // 50 bps spread → spread_conf = 0.95
        // score = 0.95 * 0.6 + 1.0 * 0.4 = 0.57 + 0.40 = 0.97
        let conf = scanner.compute_confidence(0.005, &["0xP1", "0xP2", "0xP3"]);
        assert!((conf - 0.97).abs() < 0.01, "max confidence: expected 0.97, got {:.4}", conf);
        assert!(conf <= 1.0, "confidence should never exceed 1.0, got {:.4}", conf);
    }

    #[test]
    fn confidence_at_minimum_tier() {
        let scanner = make_scanner();
        // Unknown pools + very low spread → minimum confidence
        // spread < 15bps → spread_conf = 0.25
        // unknown liquidity → liq_conf = 0.1
        // score = 0.25 * 0.6 + 0.1 * 0.4 = 0.15 + 0.04 = 0.19
        let conf = scanner.compute_confidence(0.001, &["0xUNKNOWN1", "0xUNKNOWN2", "0xUNKNOWN3"]);
        assert!((conf - 0.19).abs() < 0.01, "min confidence: expected 0.19, got {:.4}", conf);
        assert!(conf < 0.3, "minimum confidence should be below 0.3 threshold, got {:.4}", conf);
    }

    // ── Edge case: canonical key deduplication ───────────────────

    #[test]
    fn canonical_key_normalizes_rotation() {
        let opp_from_a = TriangleOpportunity {
            path: vec!["0xA".into(), "0xB".into(), "0xC".into()],
            pools: vec!["p1".into(), "p2".into(), "p3".into()],
            gross_profit_bps: 100, net_profit_usd: 1.0, confidence: 0.8,
            input_amount: "1000.00".into(), expires_at: 0,
        };
        let opp_from_b = TriangleOpportunity {
            path: vec!["0xB".into(), "0xC".into(), "0xA".into()],
            pools: vec!["p2".into(), "p3".into(), "p1".into()],
            gross_profit_bps: 100, net_profit_usd: 1.0, confidence: 0.8,
            input_amount: "1000.00".into(), expires_at: 0,
        };
        let opp_from_c = TriangleOpportunity {
            path: vec!["0xC".into(), "0xA".into(), "0xB".into()],
            pools: vec!["p3".into(), "p1".into(), "p2".into()],
            gross_profit_bps: 100, net_profit_usd: 1.0, confidence: 0.8,
            input_amount: "1000.00".into(), expires_at: 0,
        };

        assert_eq!(opp_from_a.canonical_key(), opp_from_b.canonical_key(),
            "A→B→C and B→C→A should have same canonical key");
        assert_eq!(opp_from_b.canonical_key(), opp_from_c.canonical_key(),
            "B→C→A and C→A→B should have same canonical key");

        let key = opp_from_a.canonical_key();
        assert_eq!(key[0], "0xA", "canonical key should start from smallest token");
    }

    #[test]
    fn canonical_key_rejects_reverse_direction() {
        let opp_forward = TriangleOpportunity {
            path: vec!["0xA".into(), "0xB".into(), "0xC".into()],
            pools: vec!["p1".into(), "p2".into(), "p3".into()],
            gross_profit_bps: 100, net_profit_usd: 1.0, confidence: 0.8,
            input_amount: "1000.00".into(), expires_at: 0,
        };
        let opp_reverse = TriangleOpportunity {
            path: vec!["0xA".into(), "0xC".into(), "0xB".into()],
            pools: vec!["p3r".into(), "p2r".into(), "p1r".into()],
            gross_profit_bps: 80, net_profit_usd: 0.8, confidence: 0.7,
            input_amount: "1000.00".into(), expires_at: 0,
        };

        assert_ne!(opp_forward.canonical_key(), opp_reverse.canonical_key(),
            "forward and reverse directions must produce different canonical keys");
    }

    // ── Edge case: near-threshold spread filtered ───────────────

    #[test]
    fn spread_below_threshold_filtered_out() {
        // Build a cycle with ~12 bps spread (below 15 bps minimum)
        // With fee_bps=0, adjusted = raw.
        // p^3 ≈ 1.0012 → p ≈ 1.0003999
        let p = (1.0012_f64).powf(1.0 / 3.0);
        let p_inv = 1.0 / p;

        let book = PriceBook::new();
        book.update(make_quote("0xP_AB", "0xA", "0xB", p, p_inv, 0, 1_000_000));
        book.update(make_quote("0xP_BC", "0xB", "0xC", p, p_inv, 0, 1_000_000));
        book.update(make_quote("0xP_CA", "0xC", "0xA", p, p_inv, 0, 1_000_000));

        let mut scanner = TriangleScanner::new(book, make_config());
        let opps = scanner.scan();

        assert!(opps.is_empty(),
            "12 bps spread (below 15 bps threshold) should be filtered, got {}", opps.len());
    }
}
