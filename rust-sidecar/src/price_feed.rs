//! WebSocket price feed module.
//!
//! Connects to Alchemy WebSocket endpoints on Base chain, subscribes to
//! Swap events from Aerodrome CL and Uniswap V3 pools, decodes sqrtPriceX96
//! into human-readable prices, and updates the shared `PriceBook`.

use crate::pools::PoolRegistry;
use crate::price_book::{PoolQuote, PriceBook};
use crate::types::{DexType, PoolConfig};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite};

// ── Constants ─────────────────────────────────────────────────────────

/// Uniswap V3 / Aerodrome CL Swap event topic.
const SWAP_TOPIC: &str = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb11badb6a82d5d7e5eab9";

/// Q64.96 fixed-point scale: 2^96.
const Q96: f64 = 79_228_162_514_264_337_593_543_950_336.0;

/// Known token decimals on Base chain.
const TOKEN_DECIMALS: &[(&str, u8)] = &[
    ("0x4200000000000000000000000000000000000006", 18), // WETH
    ("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6),  // USDC
    ("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 18), // DAI
    ("0x50c5725949A6F0c72eF1a5A6F9Bf1d9295EcC1b2", 18), // cbETH
    ("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18), // cbETH (alt)
    ("0x04c0599Ae5A44757c0af6F9eC3b93da8976c150A", 18), // WEETH
];

/// Default token decimals when unknown.
const DEFAULT_DECIMALS: u8 = 18;

/// Maximum reconnection backoff in seconds.
const MAX_BACKOFF_SECS: u64 = 30;

/// Health check interval: warn if no message for this many seconds.
const STALE_THRESHOLD_SECS: u64 = 60;

// ── Price events ──────────────────────────────────────────────────────

/// Events emitted by the price feed.
#[derive(Debug, Clone)]
pub enum PriceEvent {
    /// A new quote was received and inserted into the book.
    QuoteUpdated { pool_address: String },
    /// WebSocket connection lost (will auto-reconnect).
    ConnectionLost { dex: DexType },
    /// Connection re-established.
    ConnectionRestored { dex: DexType },
}

// ── Feed metrics ──────────────────────────────────────────────────────

/// Atomic counters for feed health monitoring.
#[derive(Debug)]
pub struct FeedMetrics {
    pub messages_received: AtomicUsize,
    pub parse_errors: AtomicUsize,
    pub reconnections: AtomicUsize,
    pub last_message_ts: AtomicU64,
}

impl FeedMetrics {
    pub fn new() -> Self {
        Self {
            messages_received: AtomicUsize::new(0),
            parse_errors: AtomicUsize::new(0),
            reconnections: AtomicUsize::new(0),
            last_message_ts: AtomicU64::new(0),
        }
    }
}

impl Default for FeedMetrics {
    fn default() -> Self {
        Self::new()
    }
}

// ── Feed status snapshot ─────────────────────────────────────────────

/// Snapshot of feed health for external consumers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FeedStatus {
    pub messages_received: usize,
    pub parse_errors: usize,
    pub reconnections: usize,
    pub last_message_ago_secs: Option<u64>,
    pub active_pools: usize,
}

// ── PriceFeed ─────────────────────────────────────────────────────────

/// Manages WebSocket subscriptions and the shared price book.
///
/// Spawns one WebSocket connection per DEX type, batching all pool
/// addresses for that DEX into a single `eth_subscribe` call.
pub struct PriceFeed {
    price_book: Arc<PriceBook>,
    pools: Vec<PoolConfig>,
    ws_url: String,
    event_tx: broadcast::Sender<PriceEvent>,
    metrics: Arc<FeedMetrics>,
    shutdown: tokio::sync::watch::Sender<bool>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
}

impl PriceFeed {
    /// Create a new price feed.
    pub fn new(
        ws_url: String,
        pool_registry: &PoolRegistry,
        price_book: Arc<PriceBook>,
        event_tx: broadcast::Sender<PriceEvent>,
    ) -> Self {
        let pools: Vec<PoolConfig> = pool_registry.iter().cloned().collect();
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);

        tracing::info!(
            pools = pools.len(),
            ws_url = %ws_url.chars().take(50).collect::<String>(),
            "PriceFeed created"
        );

        Self {
            price_book,
            pools,
            ws_url,
            event_tx,
            metrics: Arc::new(FeedMetrics::new()),
            shutdown,
            shutdown_rx,
        }
    }

    /// Start the price feed — spawns one WS task per DEX.
    pub async fn start(&self) -> Result<()> {
        // Group pools by DEX type
        let mut dex_pools: HashMap<DexType, Vec<&PoolConfig>> = HashMap::new();
        for pool in &self.pools {
            dex_pools.entry(pool.dex).or_default().push(pool);
        }

        let mut handles = Vec::new();

        for (dex, pools) in dex_pools {
            let pool_addresses: Vec<String> = pools.iter().map(|p| p.pool_id.clone()).collect();
            let ws_url = self.ws_url.clone();
            let price_book = self.price_book.clone();
            let event_tx = self.event_tx.clone();
            let metrics = self.metrics.clone();
            let mut shutdown = self.shutdown_rx.clone();

            // Build a lookup: pool_address → PoolConfig
            let pool_lookup: HashMap<String, PoolConfig> = pools
                .iter()
                .map(|p| (p.pool_id.clone(), (*p).clone()))
                .collect();

            tracing::info!(
                dex = %dex,
                pools = pool_addresses.len(),
                "Spawning WS listener task"
            );

            let handle = tokio::spawn(async move {
                run_dex_feed(
                    dex,
                    pool_addresses,
                    pool_lookup,
                    &ws_url,
                    &price_book,
                    &event_tx,
                    &metrics,
                    &mut shutdown,
                )
                .await;
            });

            handles.push(handle);
        }

        tracing::info!(tasks = handles.len(), "PriceFeed started");
        Ok(())
    }

    /// Signal graceful shutdown to all WS tasks.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
        tracing::info!("PriceFeed stop signal sent");
    }

    /// Return a snapshot of feed health metrics.
    pub fn feed_status(&self) -> FeedStatus {
        let last_ts = self.metrics.last_message_ts.load(Ordering::Relaxed);
        let now = now_millis();
        let last_message_ago_secs = if last_ts > 0 {
            Some((now.saturating_sub(last_ts)) / 1000)
        } else {
            None
        };

        FeedStatus {
            messages_received: self.metrics.messages_received.load(Ordering::Relaxed),
            parse_errors: self.metrics.parse_errors.load(Ordering::Relaxed),
            reconnections: self.metrics.reconnections.load(Ordering::Relaxed),
            last_message_ago_secs,
            active_pools: self.price_book.len(),
        }
    }

    /// Get a snapshot of the current best quote for a pool.
    pub fn get_quote(&self, pool_address: &str) -> Option<PoolQuote> {
        self.price_book.get(pool_address)
    }
}

// ── Per-DEX WebSocket feed loop ───────────────────────────────────────

/// Run a persistent WebSocket connection for one DEX, subscribing to all
/// its pool addresses with a single `eth_subscribe` logs filter.
async fn run_dex_feed(
    dex: DexType,
    pool_addresses: Vec<String>,
    pool_lookup: HashMap<String, PoolConfig>,
    ws_url: &str,
    price_book: &PriceBook,
    event_tx: &broadcast::Sender<PriceEvent>,
    metrics: &FeedMetrics,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) {
    let mut backoff_secs: u64 = 1;

    loop {
        if *shutdown.borrow() {
            tracing::info!(dex = %dex, "Shutting down WS feed");
            return;
        }

        match connect_single_feed(dex, &pool_addresses, &pool_lookup, ws_url, price_book, event_tx, metrics, shutdown).await {
            Ok(()) => {
                tracing::warn!(dex = %dex, "WebSocket closed cleanly, reconnecting");
            }
            Err(e) => {
                tracing::error!(dex = %dex, error = %e, "WebSocket error, reconnecting");
            }
        }

        metrics.reconnections.fetch_add(1, Ordering::Relaxed);
        let _ = event_tx.send(PriceEvent::ConnectionLost { dex });

        // Exponential backoff with jitter
        let jitter = (now_millis() % 1000) as u64;
        let delay_secs = backoff_secs + (jitter % 1000) / 1000;
        tracing::info!(dex = %dex, delay_secs, "Reconnecting with backoff");

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)) => {},
            _ = shutdown.changed() => {
                tracing::info!(dex = %dex, "Shutdown during backoff");
                return;
            }
        }

        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
    }
}

/// Connect, subscribe, and process messages until disconnect or shutdown.
async fn connect_single_feed(
    dex: DexType,
    pool_addresses: &[String],
    pool_lookup: &HashMap<String, PoolConfig>,
    ws_url: &str,
    price_book: &PriceBook,
    event_tx: &broadcast::Sender<PriceEvent>,
    metrics: &FeedMetrics,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    tracing::info!(dex = %dex, "Connecting WebSocket");

    let (ws_stream, _) = connect_async(ws_url)
        .await
        .context("WebSocket connect failed")?;

    tracing::info!(dex = %dex, "WebSocket connected");
    let _ = event_tx.send(PriceEvent::ConnectionRestored { dex });

    let (mut write, mut read) = ws_stream.split();

    // Build eth_subscribe request with all pool addresses as address filter
    let address_filter: Vec<&str> = pool_addresses.iter().map(|s| s.as_str()).collect();
    let subscribe_msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_subscribe",
        "params": [
            "logs",
            {
                "address": address_filter,
                "topics": [SWAP_TOPIC]
            }
        ]
    });

    let msg = tungstenite::Message::Text(subscribe_msg.to_string().into());
    write.send(msg).await.context("Failed to send subscribe")?;

    tracing::info!(
        dex = %dex,
        pools = pool_addresses.len(),
        "Subscribed to Swap events"
    );

    // Read loop
    while let Some(msg_result) = tokio::select! {
        msg = read.next() => msg,
        _ = shutdown.changed() => None,
    } {
        match msg_result {
            Ok(tungstenite::Message::Text(text)) => {
                if let Err(e) = process_ws_message(
                    &text,
                    pool_lookup,
                    price_book,
                    event_tx,
                    metrics,
                ) {
                    tracing::debug!(error = %e, "Failed to process WS message");
                }
            }
            Ok(tungstenite::Message::Ping(data)) => {
                let _ = write.send(tungstenite::Message::Pong(data)).await;
            }
            Ok(tungstenite::Message::Close(_)) => {
                tracing::warn!(dex = %dex, "WebSocket closed by server");
                return Ok(());
            }
            Err(e) => {
                return Err(e).context("WebSocket read error");
            }
            _ => {}
        }
    }

    Ok(())
}

// ── Message processing ────────────────────────────────────────────────

/// Process a single WebSocket text message.
fn process_ws_message(
    text: &str,
    pool_lookup: &HashMap<String, PoolConfig>,
    price_book: &PriceBook,
    event_tx: &broadcast::Sender<PriceEvent>,
    metrics: &FeedMetrics,
) -> Result<()> {
    // Parse the JSON-RPC notification
    let val: serde_json::Value =
        serde_json::from_str(text).context("JSON parse")?;

    // Skip subscription confirmation
    if val.get("result").is_some() && val.get("id").is_some() {
        return Ok(());
    }

    // Extract params.result (log entry)
    let log = val
        .pointer("/params/result")
        .context("No params.result in WS message")?;

    let pool_address = log
        .get("address")
        .and_then(|v| v.as_str())
        .context("No address in log")?
        .to_lowercase();

    let data_hex = log
        .get("data")
        .and_then(|v| v.as_str())
        .context("No data in log")?;

    let block_number_hex = log
        .get("blockNumber")
        .and_then(|v| v.as_str())
        .unwrap_or("0x0");

    let block_number = u64::from_str_radix(block_number_hex.trim_start_matches("0x"), 16)
        .unwrap_or(0);

    // Look up pool config
    let config = pool_lookup
        .iter()
        .find(|(addr, _)| addr.eq_ignore_ascii_case(&pool_address))
        .map(|(_, c)| c.clone())
        .context(format!("Unknown pool address: {}", pool_address))?;

    // Decode Swap event data
    let swap = decode_swap_data(data_hex).context("Decode swap data")?;

    // Calculate prices from sqrtPriceX96
    let dec_a = get_decimals(&config.token_a);
    let dec_b = get_decimals(&config.token_b);
    let (price_a_to_b, price_b_to_a) =
        sqrt_price_to_human(swap.sqrt_price_x96, dec_a, dec_b);

    // Build quote and update price book
    let quote = PoolQuote {
        pool_address: config.pool_id.clone(),
        dex: config.dex,
        token_a: config.token_a.clone(),
        token_b: config.token_b.clone(),
        price_a_to_b,
        price_b_to_a,
        fee_bps: config.fee_bps as u32,
        liquidity: swap.liquidity,
        timestamp: now_millis() as i64,
        block_number,
    };

    tracing::trace!(
        pool = %config.pool_id,
        dex = %config.dex,
        price_a_to_b = %format!("{:.6}", price_a_to_b),
        liquidity = swap.liquidity,
        "Price update"
    );

    price_book.update(quote);
    metrics.messages_received.fetch_add(1, Ordering::Relaxed);
    metrics.last_message_ts.store(now_millis(), Ordering::Relaxed);

    let _ = event_tx.send(PriceEvent::QuoteUpdated {
        pool_address: config.pool_id.clone(),
    });

    Ok(())
}

// ── Swap event decoding ───────────────────────────────────────────────

/// Decoded Swap event data.
#[derive(Debug)]
struct SwapData {
    sqrt_price_x96: f64,
    liquidity: u128,
}

/// Decode Uniswap V3 style Swap event data.
///
/// Layout: sender (32) | recipient (32) | amount0 (32) | amount1 (32) |
///         sqrtPriceX96 (32) | liquidity (32) | tick (32)
/// Total: 7 × 32 = 224 bytes (0x-prefixed = 450 chars)
fn decode_swap_data(data_hex: &str) -> Result<SwapData> {
    let hex = data_hex.trim_start_matches("0x");
    let bytes = hex_decode(hex).context("hex decode swap data")?;

    anyhow::ensure!(bytes.len() >= 224, "Swap data too short: {} bytes", bytes.len());

    // sqrtPriceX96 is at offset 4*32 = 128 (after sender, recipient, amount0, amount1)
    let sqrt_price_bytes = &bytes[128..160];
    let sqrt_price_u256 = u128::from_be_bytes(
        sqrt_price_bytes[16..32].try_into()?,
    );

    // liquidity is at offset 5*32 = 160
    let liq_bytes = &bytes[160..192];
    let liquidity = u128::from_be_bytes(
        liq_bytes[16..32].try_into()?,
    );

    Ok(SwapData {
        sqrt_price_x96: sqrt_price_u256 as f64,
        liquidity,
    })
}

// ── Price calculation ─────────────────────────────────────────────────

/// Convert sqrtPriceX96 to human-readable prices accounting for decimals.
///
/// sqrtPriceX96 encodes √(price × 2^96) where price = token1/token0.
/// price = (sqrtPriceX96 / 2^96)^2
///
/// To get human price (token_B per token_A), we need to account for
/// decimal difference:
///   price_a_to_b = (sqrtPriceX96 / 2^96)^2 * 10^(dec_a - dec_b)
///   price_b_to_a = 1.0 / price_a_to_b
///
/// Note: "token0" and "token1" in the pool are determined by address
/// sorting. Our pools.toml defines token_a and token_b, where token_a
/// is the lower-address token (token0) by convention.
pub fn sqrt_price_to_human(sqrt_price_x96: f64, dec_a: u8, dec_b: u8) -> (f64, f64) {
    let price_x96 = (sqrt_price_x96 / Q96).powi(2);
    let decimal_adj = 10f64.powi((dec_a as i32) - (dec_b as i32));
    let price_a_to_b = price_x96 * decimal_adj;
    let price_b_to_a = if price_a_to_b > 0.0 { 1.0 / price_a_to_b } else { 0.0 };
    (price_a_to_b, price_b_to_a)
}

/// Get known decimals for a token address (case-insensitive).
pub fn get_decimals(token: &str) -> u8 {
    let lower = token.to_lowercase();
    TOKEN_DECIMALS
        .iter()
        .find(|(addr, _)| addr.eq_ignore_ascii_case(&lower))
            .map(|(_, d)| *d)
            .unwrap_or(DEFAULT_DECIMALS)
}

// ── Helpers ───────────────────────────────────────────────────────────

/// Current time in milliseconds since epoch.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Decode hex string to bytes (no 0x prefix).
fn hex_decode(hex: &str) -> Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        anyhow::bail!("Hex string has odd length");
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16)
            .with_context(|| format!("Invalid hex at position {}", i))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

// ── Unit tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── sqrtPriceX96 conversion tests ─────────────────────────────

    #[test]
    fn sqrt_price_weth_usdc() {
        // WETH = 18 decimals, USDC = 6 decimals
        // If WETH price = $2000, sqrtPriceX96 encodes token1/token0.
        // For a WETH/USDC pool where WETH is token0:
        //   price = 2000 USDC per WETH
        //   price_x96_raw = 2000 * 10^(6-18) = 2000e-12
        //   sqrtPriceX96 = sqrt(2000e-12) * 2^96
        let price_raw: f64 = 2000.0 * 1e-12; // token1/token0 in raw units
        let sqrt_p = price_raw.sqrt() * Q96;

        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(sqrt_p, 18, 6);

        // price_a_to_b should be ~2000.0
        assert!((price_a_to_b - 2000.0).abs() < 0.5, "price_a_to_b = {}", price_a_to_b);
        // price_b_to_a should be ~0.0005
        assert!((price_b_to_a - 0.0005).abs() < 0.00001, "price_b_to_a = {}", price_b_to_a);
    }

    #[test]
    fn sqrt_price_same_decimals() {
        // DAI/USDC with same decimals = both 18 (hypothetical)
        // If price = 1:1, sqrtPriceX96 = 2^96
        let sqrt_p = Q96; // sqrt(1) * 2^96

        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(sqrt_p, 18, 18);

        assert!((price_a_to_b - 1.0).abs() < 1e-10, "price_a_to_b = {}", price_a_to_b);
        assert!((price_b_to_a - 1.0).abs() < 1e-10, "price_b_to_a = {}", price_b_to_a);
    }

    #[test]
    fn sqrt_price_usdc_weth() {
        // USDC/WETH pool where USDC is token_a (6 dec) and WETH is token_b (18 dec)
        // If ETH = $2000, price = 1/2000 WETH per USDC in raw units
        // price_raw = (1/2000) * 10^(18-6) = 5e8
        // sqrtPriceX96 = sqrt(5e8) * 2^96
        let price_raw: f64 = 0.0005 * 1e12; // token1/token0 in raw = WETH/USDC raw
        let sqrt_p = price_raw.sqrt() * Q96;

        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(sqrt_p, 6, 18);

        // price_a_to_b = amount of WETH per 1 USDC ≈ 0.0005
        assert!((price_a_to_b - 0.0005).abs() < 0.000001, "price_a_to_b = {}", price_a_to_b);
        // price_b_to_a = amount of USDC per 1 WETH ≈ 2000
        assert!((price_b_to_a - 2000.0).abs() < 1.0, "price_b_to_a = {}", price_b_to_a);
    }

    #[test]
    fn sqrt_price_zero_input() {
        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(0.0, 18, 6);
        assert_eq!(price_a_to_b, 0.0);
        assert_eq!(price_b_to_a, 0.0);
    }

    // ── Hex decode tests ──────────────────────────────────────────

    #[test]
    fn hex_decode_valid() {
        let result = hex_decode("deadbeef").unwrap();
        assert_eq!(result, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn hex_decode_odd_length_fails() {
        assert!(hex_decode("abc").is_err());
    }

    #[test]
    fn hex_decode_invalid_char_fails() {
        assert!(hex_decode("zz").is_err());
    }

    // ── Swap data decode tests ────────────────────────────────────

    #[test]
    fn decode_swap_data_valid() {
        // Build a valid 224-byte swap data
        // Layout: sender(32) | recipient(32) | amount0(32) | amount1(32) |
        //         sqrtPriceX96(32) | liquidity(32) | tick(32)
        let mut data = vec![0u8; 224];

        // sqrtPriceX96 at offset 128, value = 2^96 (meaning price=1.0)
        // As a 256-bit big-endian, the lower 128 bits hold the value
        let sqrt_val: u128 = 1u128 << 96; // 2^96
        let sqrt_bytes = sqrt_val.to_be_bytes(); // 16 bytes
        data[144..160].copy_from_slice(&sqrt_bytes); // lower 16 of 32 bytes

        // liquidity at offset 160, value = 1000
        let liq: u128 = 1000;
        let liq_bytes = liq.to_be_bytes();
        data[176..192].copy_from_slice(&liq_bytes);

        let hex_string = format!("0x{}", hex::encode(&data));
        let result = decode_swap_data(&hex_string).unwrap();

        assert!((result.sqrt_price_x96 - (1u128 << 96) as f64).abs() < 1.0);
        assert_eq!(result.liquidity, 1000);
    }

    #[test]
    fn decode_swap_data_too_short_fails() {
        let data = vec![0u8; 100];
        let hex_string = format!("0x{}", hex::encode(&data));
        assert!(decode_swap_data(&hex_string).is_err());
    }

    // ── Decimal lookup tests ──────────────────────────────────────

    #[test]
    fn get_decimals_known_tokens() {
        assert_eq!(get_decimals("0x4200000000000000000000000000000000000006"), 18); // WETH
        assert_eq!(get_decimals("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), 6); // USDC
        assert_eq!(get_decimals("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"), 18); // DAI
    }

    #[test]
    fn get_decimals_unknown_defaults_to_18() {
        assert_eq!(get_decimals("0x0000000000000000000000000000000000000001"), 18);
    }

    // ── PriceFeed construction ────────────────────────────────────

    fn make_empty_registry() -> PoolRegistry {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.toml");
        std::fs::write(&path, "pools = []").unwrap();
        PoolRegistry::load(&path).unwrap()
    }

    #[test]
    fn price_feed_construction() {
        let (tx, _rx) = broadcast::channel(16);
        let price_book = Arc::new(PriceBook::new());
        let registry = make_empty_registry();

        let feed = PriceFeed::new(
            "wss://test".into(),
            &registry,
            price_book,
            tx,
        );
        assert_eq!(feed.pools.len(), 0);
        assert!(feed.feed_status().active_pools == 0);
    }

    #[test]
    fn price_feed_status_initial() {
        let (tx, _rx) = broadcast::channel(16);
        let price_book = Arc::new(PriceBook::new());
        let registry = make_empty_registry();

        let feed = PriceFeed::new("wss://test".into(), &registry, price_book, tx);
        let status = feed.feed_status();

        assert_eq!(status.messages_received, 0);
        assert_eq!(status.parse_errors, 0);
        assert_eq!(status.reconnections, 0);
        assert!(status.last_message_ago_secs.is_none());
    }

    // ── Shutdown tests ───────────────────────────────────────────

    #[test]
    fn stop_signal_sets_shutdown_flag() {
        let (tx, _rx) = broadcast::channel(16);
        let price_book = Arc::new(PriceBook::new());
        let registry = make_empty_registry();

        let feed = PriceFeed::new("wss://test".into(), &registry, price_book, tx);
        assert!(!*feed.shutdown_rx.borrow());
        feed.stop();
        assert!(*feed.shutdown_rx.borrow());
    }

    // ── FeedMetrics counter tests ────────────────────────────────

    #[test]
    fn feed_metrics_counters_update_correctly() {
        let metrics = FeedMetrics::new();

        // Verify initial state
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.parse_errors.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.reconnections.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.last_message_ts.load(Ordering::Relaxed), 0);

        // Simulate increments
        metrics.messages_received.fetch_add(1, Ordering::Relaxed);
        metrics.messages_received.fetch_add(1, Ordering::Relaxed);
        metrics.parse_errors.fetch_add(1, Ordering::Relaxed);
        metrics.reconnections.fetch_add(3, Ordering::Relaxed);
        let ts = now_millis();
        metrics.last_message_ts.store(ts, Ordering::Relaxed);

        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 2);
        assert_eq!(metrics.parse_errors.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.reconnections.load(Ordering::Relaxed), 3);
        assert_eq!(metrics.last_message_ts.load(Ordering::Relaxed), ts);
    }

    #[test]
    fn feed_status_shows_active_pools_after_update() {
        let (tx, _rx) = broadcast::channel(16);
        let price_book = Arc::new(PriceBook::new());
        let registry = make_empty_registry();

        let feed = PriceFeed::new("wss://test".into(), &registry, price_book.clone(), tx);
        assert_eq!(feed.feed_status().active_pools, 0);

        // Insert a quote directly into the price book
        let quote = PoolQuote {
            pool_address: "0xpool1".into(),
            dex: DexType::UniswapV3,
            token_a: "0xaaa".into(),
            token_b: "0xbbb".into(),
            price_a_to_b: 1.5,
            price_b_to_a: 1.0 / 1.5,
            fee_bps: 30,
            liquidity: 1000,
            timestamp: now_millis() as i64,
            block_number: 42,
        };
        price_book.update(quote);
        assert_eq!(feed.feed_status().active_pools, 1);
    }

    // ── Additional swap decode edge cases ────────────────────────

    #[test]
    fn decode_swap_data_empty_fails() {
        let hex_string = "0x";
        assert!(decode_swap_data(hex_string).is_err());
    }

    #[test]
    fn decode_swap_data_boundary_too_short_fails() {
        // 223 bytes = exactly one byte too short
        let data = vec![0u8; 223];
        let hex_string = format!("0x{}", hex::encode(&data));
        let result = decode_swap_data(&hex_string);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("too short"),
            "Expected 'too short' error, got: {}",
            err_msg
        );
    }

    #[test]
    fn decode_swap_data_exactly_224_bytes_succeeds() {
        let mut data = vec![0u8; 224];
        // Set sqrtPriceX96 at offset 128 (lower 16 bytes of 32-byte slot)
        let sqrt_val: u128 = 79_228_162_514_264_337_593_543_950_336; // 2^96
        data[144..160].copy_from_slice(&sqrt_val.to_be_bytes());
        // Set liquidity at offset 160
        let liq: u128 = 5000;
        data[176..192].copy_from_slice(&liq.to_be_bytes());

        let hex_string = format!("0x{}", hex::encode(&data));
        let result = decode_swap_data(&hex_string).unwrap();
        assert!((result.sqrt_price_x96 - sqrt_val as f64).abs() < 1.0);
        assert_eq!(result.liquidity, 5000);
    }

    #[test]
    fn decode_swap_data_invalid_hex_char_fails() {
        let bad_hex = "0x".to_string() + &"gg".repeat(112); // 224 bytes of invalid hex
        assert!(decode_swap_data(&bad_hex).is_err());
    }

    #[test]
    fn decode_swap_data_extra_bytes_succeeds() {
        // 256 bytes — more than needed, should still work (only reads first 224)
        let mut data = vec![0u8; 256];
        let sqrt_val: u128 = 1u128 << 96;
        data[144..160].copy_from_slice(&sqrt_val.to_be_bytes());
        let liq: u128 = 999;
        data[176..192].copy_from_slice(&liq.to_be_bytes());

        let hex_string = format!("0x{}", hex::encode(&data));
        let result = decode_swap_data(&hex_string).unwrap();
        assert_eq!(result.liquidity, 999);
    }

    // ── Additional hex_decode edge cases ─────────────────────────

    #[test]
    fn hex_decode_empty_string() {
        let result = hex_decode("").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn hex_decode_single_byte() {
        let result = hex_decode("ff").unwrap();
        assert_eq!(result, vec![0xff]);
    }

    // ── Decimal lookup edge cases ────────────────────────────────

    #[test]
    fn get_decimals_case_insensitive() {
        // WETH address in different cases should all return 18
        assert_eq!(get_decimals("0x4200000000000000000000000000000000000006"), 18);
        let upper = "0x4200000000000000000000000000000000000006".to_uppercase();
        assert_eq!(get_decimals(&upper), 18);
    }

    // ── sqrt_price extreme decimal differences ───────────────────

    #[test]
    fn sqrt_price_extreme_decimal_difference() {
        // token_a with 0 decimals, token_b with 18 decimals
        // This tests the edge of decimal adjustment
        let sqrt_p = Q96; // price = 1.0 raw
        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(sqrt_p, 0, 18);

        // price_a_to_b = 1.0 * 10^(0-18) = 1e-18
        assert!((price_a_to_b - 1e-18).abs() < 1e-25, "price_a_to_b = {}", price_a_to_b);
        // price_b_to_a = 1.0 / 1e-18 = 1e18
        assert!((price_b_to_a - 1e18).abs() < 1e10, "price_b_to_a = {}", price_b_to_a);
    }

    #[test]
    fn sqrt_price_very_small_price() {
        // Very small sqrtPriceX96 → near-zero price
        let sqrt_p = 1.0; // tiny
        let (price_a_to_b, price_b_to_a) = sqrt_price_to_human(sqrt_p, 18, 18);
        assert!(price_a_to_b > 0.0);
        assert!(price_a_to_b < 1e-50);
        assert!(price_b_to_a > 1e50);
    }

    // ── process_ws_message tests ─────────────────────────────────

    fn make_pool_lookup() -> HashMap<String, PoolConfig> {
        let mut map = HashMap::new();
        map.insert(
            "0xpool1".to_string(),
            PoolConfig {
                pool_id: "0xpool1".to_string(),
                dex: DexType::UniswapV3,
                token_a: "0x4200000000000000000000000000000000000006".to_string(), // WETH
                token_b: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".to_string(), // USDC
                fee_bps: 30,
            },
        );
        map
    }

    fn build_valid_swap_data_hex() -> String {
        let mut data = vec![0u8; 224];
        // sqrtPriceX96 = 2^96 at offset 128
        let sqrt_val: u128 = 1u128 << 96;
        data[144..160].copy_from_slice(&sqrt_val.to_be_bytes());
        // liquidity = 1000000 at offset 160
        let liq: u128 = 1_000_000;
        data[176..192].copy_from_slice(&liq.to_be_bytes());
        format!("0x{}", hex::encode(&data))
    }

    #[test]
    fn process_ws_message_subscription_confirmation_skipped() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        // Subscription confirmation has "result" and "id"
        let sub_confirm = r#"{"jsonrpc":"2.0","id":1,"result":"0xabc123"}"#;
        let result = process_ws_message(sub_confirm, &pool_lookup, &price_book, &tx, &metrics);

        assert!(result.is_ok());
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn process_ws_message_invalid_json_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let result = process_ws_message("not json at all", &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn process_ws_message_missing_params_result_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        // Valid JSON but no params.result
        let msg = r#"{"jsonrpc":"2.0","method":"eth_subscription"}"#;
        let result = process_ws_message(msg, &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
    }

    #[test]
    fn process_ws_message_unknown_pool_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let swap_data = build_valid_swap_data_hex();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "address": "0xunknown_pool_address",
                    "data": swap_data,
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn process_ws_message_valid_swap_updates_price_book() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let swap_data = build_valid_swap_data_hex();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "address": "0xpool1",
                    "data": swap_data,
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_ok(), "process_ws_message failed: {:?}", result);

        // Verify metrics updated
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 1);
        assert!(metrics.last_message_ts.load(Ordering::Relaxed) > 0);

        // Verify price book updated
        let quote = price_book.get("0xpool1");
        assert!(quote.is_some());
        let q = quote.unwrap();
        assert_eq!(q.pool_address, "0xpool1");
        assert_eq!(q.dex, DexType::UniswapV3);
        assert_eq!(q.liquidity, 1_000_000);
        assert_eq!(q.block_number, 0x100);
        assert!(q.price_a_to_b > 0.0);
        assert!(q.price_b_to_a > 0.0);
    }

    #[test]
    fn process_ws_message_malformed_swap_data_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "address": "0xpool1",
                    "data": "0xbaddata",
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
        // Messages received should NOT increment on parse error
        assert_eq!(metrics.messages_received.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn process_ws_message_missing_data_field_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "address": "0xpool1",
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
    }

    #[test]
    fn process_ws_message_missing_address_field_fails() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, _rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let swap_data = build_valid_swap_data_hex();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "data": swap_data,
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_err());
    }

    // ── Price event broadcast test ───────────────────────────────

    #[test]
    fn process_ws_message_broadcasts_quote_updated_event() {
        let pool_lookup = make_pool_lookup();
        let price_book = PriceBook::new();
        let (tx, mut rx) = broadcast::channel(16);
        let metrics = FeedMetrics::new();

        let swap_data = build_valid_swap_data_hex();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "result": {
                    "address": "0xpool1",
                    "data": swap_data,
                    "blockNumber": "0x100"
                }
            }
        });

        let result = process_ws_message(&msg.to_string(), &pool_lookup, &price_book, &tx, &metrics);
        assert!(result.is_ok());

        // Check that a QuoteUpdated event was broadcast
        let event = rx.try_recv().unwrap();
        match event {
            PriceEvent::QuoteUpdated { pool_address } => {
                assert_eq!(pool_address, "0xpool1");
            }
            _ => panic!("Expected QuoteUpdated event, got {:?}", event),
        }
    }
}
