//! Integration tests for the flashloan sidecar pipeline.
//!
//! Verifies the full signal flow:
//!   PriceBook → TriangleScanner → broadcast channels → gRPC server → client
//!
//! Test areas:
//!   A — PriceBook → TriangleScanner pipeline
//!   B — Broadcast channel delivery
//!   C — gRPC server health check
//!   D — Full pipeline end-to-end

use flashloan_sidecar::config::Config;
use flashloan_sidecar::grpc_server::ScannerServer;
use flashloan_sidecar::price_book::{PoolQuote, PriceBook};
use flashloan_sidecar::price_feed::PriceEvent;
use flashloan_sidecar::proto;
use flashloan_sidecar::proto::scanner_service_client::ScannerServiceClient;
use flashloan_sidecar::proto::scanner_service_server::{ScannerService, ScannerServiceServer};
use flashloan_sidecar::triangle_scanner::TriangleScanner;
use flashloan_sidecar::types::{DexType, OpportunitySignal, RouteHop, Strategy};

use std::net::SocketAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tonic::Request;

// ── Helpers ───────────────────────────────────────────────────────────

/// Allocate a free TCP port on localhost (TOCTOU-safe for test envs).
fn allocate_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Current time in milliseconds since epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Create a PriceBook with a profitable triangle: WETH → USDC → DAI → WETH.
///
/// Cycle product ≈ 1.155 (before fees), ~1.145 after fees (30 bps per hop).
/// Expected net profit ≈ $139 on $1000 input — well above min thresholds.
fn create_profitable_triangle_book() -> PriceBook {
    let book = PriceBook::new();
    let ts = now_ms();
    let bn = 1000;

    // Pool 1: WETH / USDC (1 WETH = 2000 USDC)
    book.update(PoolQuote {
        pool_address: "pool_weth_usdc".into(),
        dex: DexType::UniswapV3,
        token_a: "WETH".into(),
        token_b: "USDC".into(),
        price_a_to_b: 2000.0,
        price_b_to_a: 0.0005,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: bn,
    });

    // Pool 2: USDC / DAI (1 USDC = 1.05 DAI — mispriced for arb)
    book.update(PoolQuote {
        pool_address: "pool_usdc_dai".into(),
        dex: DexType::AerodromeCl,
        token_a: "USDC".into(),
        token_b: "DAI".into(),
        price_a_to_b: 1.05,
        price_b_to_a: 0.952,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: bn,
    });

    // Pool 3: DAI / WETH (1 DAI = 0.00055 WETH — mispriced for arb)
    book.update(PoolQuote {
        pool_address: "pool_dai_weth".into(),
        dex: DexType::AerodromeCl,
        token_a: "DAI".into(),
        token_b: "WETH".into(),
        price_a_to_b: 0.00055,
        price_b_to_a: 1818.18,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: bn,
    });

    book
}

/// Create a sample OpportunitySignal for testing broadcast channels.
fn sample_signal() -> OpportunitySignal {
    OpportunitySignal {
        strategy: Strategy::TriangleArb,
        hops: vec![
            RouteHop {
                pool_id: "pool_weth_usdc".into(),
                dex: DexType::UniswapV3,
                token_in: "WETH".into(),
                token_out: "USDC".into(),
                amount_out: 2000.0,
            },
            RouteHop {
                pool_id: "pool_usdc_dai".into(),
                dex: DexType::AerodromeCl,
                token_in: "USDC".into(),
                token_out: "DAI".into(),
                amount_out: 2100.0,
            },
            RouteHop {
                pool_id: "pool_dai_weth".into(),
                dex: DexType::AerodromeCl,
                token_in: "DAI".into(),
                token_out: "WETH".into(),
                amount_out: 1.155,
            },
        ],
        gross_profit_usd: 155.0,
        net_profit_usd: 139.0,
        confidence: 0.97,
        detected_at_ms: now_ms() as u64,
    }
}

// ══════════════════════════════════════════════════════════════════════
// Test A: PriceBook → TriangleScanner pipeline
// ══════════════════════════════════════════════════════════════════════

#[test]
fn pricebook_builds_triangle_edges_for_three_pools() {
    let book = create_profitable_triangle_book();
    let edges = book.build_triangle_edges();

    // 3 pools × 2 directed edges each = 6
    assert_eq!(edges.len(), 6, "3 pools should produce 6 directed edges");

    // Verify WETH → USDC edge exists with correct price
    let weth_usdc = edges
        .iter()
        .find(|e| e.from_token == "WETH" && e.to_token == "USDC")
        .expect("WETH→USDC edge should exist");
    assert!((weth_usdc.price - 2000.0).abs() < 0.01);
    assert_eq!(weth_usdc.pool_address, "pool_weth_usdc");
    assert_eq!(weth_usdc.fee_bps, 30);

    // Verify reverse edge
    let usdc_weth = edges
        .iter()
        .find(|e| e.from_token == "USDC" && e.to_token == "WETH")
        .expect("USDC→WETH edge should exist");
    assert!((usdc_weth.price - 0.0005).abs() < 1e-9);
}

#[test]
fn scanner_detects_profitable_triangle() {
    let book = create_profitable_triangle_book();
    let config = Config::default();
    let mut scanner = TriangleScanner::new(book, config);

    let opportunities = scanner.scan();

    // Exactly 1 unique triangle after dedup (canonical key rotation)
    assert_eq!(
        opportunities.len(),
        1,
        "Should detect exactly one unique profitable triangle"
    );

    let opp = &opportunities[0];

    // Path and pools
    assert_eq!(opp.path.len(), 3, "Triangle must have 3 tokens");
    assert_eq!(opp.pools.len(), 3, "Triangle must have 3 pool hops");

    // Profitability
    assert!(opp.gross_profit_bps > 0, "Gross profit must be positive");
    assert!(
        opp.net_profit_usd > 0.10,
        "Net profit ({}) must exceed $0.10 minimum",
        opp.net_profit_usd
    );

    // Cycle product ≈ 1.155 → gross spread ≈ 1446 bps
    assert!(
        opp.gross_profit_bps > 1000,
        "Gross profit ({} bps) should be >1000 bps for this mispriced triangle",
        opp.gross_profit_bps
    );

    // Confidence
    assert!(opp.confidence >= 0.3, "Confidence must meet 0.3 threshold");
    assert!(opp.confidence <= 1.0, "Confidence must not exceed 1.0");

    // Graph stats
    let (nodes, edges) = scanner.stats();
    assert_eq!(nodes, 3, "Graph should have 3 token nodes");
    assert_eq!(edges, 6, "Graph should have 6 directed edges");
}

#[test]
fn scanner_returns_empty_for_flat_prices() {
    let book = PriceBook::new();
    let ts = now_ms();

    // Create 3 pools with 1:1:1 prices (no arb possible)
    book.update(PoolQuote {
        pool_address: "pool_a_b".into(),
        dex: DexType::UniswapV3,
        token_a: "TKA".into(),
        token_b: "TKB".into(),
        price_a_to_b: 1.0,
        price_b_to_a: 1.0,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: 1,
    });
    book.update(PoolQuote {
        pool_address: "pool_b_c".into(),
        dex: DexType::AerodromeCl,
        token_a: "TKB".into(),
        token_b: "TKC".into(),
        price_a_to_b: 1.0,
        price_b_to_a: 1.0,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: 1,
    });
    book.update(PoolQuote {
        pool_address: "pool_c_a".into(),
        dex: DexType::AerodromeCl,
        token_a: "TKC".into(),
        token_b: "TKA".into(),
        price_a_to_b: 1.0,
        price_b_to_a: 1.0,
        fee_bps: 30,
        liquidity: 1_000_000,
        timestamp: ts,
        block_number: 1,
    });

    let config = Config::default();
    let mut scanner = TriangleScanner::new(book, config);
    let opportunities = scanner.scan();

    assert!(
        opportunities.is_empty(),
        "Flat prices with fees should produce no opportunities"
    );
}

#[test]
fn opportunity_converts_to_signal() {
    let book = create_profitable_triangle_book();
    let config = Config::default();
    let mut scanner = TriangleScanner::new(book, config);

    let opportunities = scanner.scan();
    assert!(!opportunities.is_empty());

    let signal = opportunities[0].to_signal();

    assert_eq!(signal.strategy, Strategy::TriangleArb);
    assert_eq!(signal.hops.len(), 3, "Signal must have 3 route hops");
    assert!(signal.net_profit_usd > 0.0, "Net profit must be positive");
    assert!(signal.confidence > 0.0, "Confidence must be positive");
    assert!(signal.detected_at_ms > 0, "Timestamp must be set");

    // Verify hops form a connected route: hop[i].token_out == hop[i+1].token_in
    for i in 0..signal.hops.len() - 1 {
        assert_eq!(
            signal.hops[i].token_out, signal.hops[i + 1].token_in,
            "Hops must be connected: hop[{}].token_out should equal hop[{}].token_in",
            i, i + 1
        );
    }
    // Route should be cyclic
    assert_eq!(
        signal.hops.last().unwrap().token_out,
        signal.hops.first().unwrap().token_in,
        "Route must be cyclic: last hop returns to input token"
    );
}

// ══════════════════════════════════════════════════════════════════════
// Test B: Broadcast channel flow
// ══════════════════════════════════════════════════════════════════════

#[test]
fn broadcast_delivers_signal_to_all_subscribers() {
    let (tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let mut rx1 = tx.subscribe();
    let mut rx2 = tx.subscribe();

    let signal = sample_signal();
    let sent_count = tx.send(signal.clone()).unwrap();
    assert_eq!(sent_count, 2, "Should deliver to 2 active receivers");

    let received1 = rx1.try_recv().unwrap();
    assert_eq!(received1.strategy, Strategy::TriangleArb);
    assert_eq!(received1.hops.len(), 3);
    assert!((received1.net_profit_usd - 139.0).abs() < 0.01);

    let received2 = rx2.try_recv().unwrap();
    assert_eq!(received2.strategy, Strategy::TriangleArb);
    assert_eq!(received2.hops.len(), 3);
}

#[test]
fn broadcast_late_subscriber_gets_new_messages() {
    let (tx, _rx_keepalive) = broadcast::channel::<OpportunitySignal>(16);

    // Send before late subscriber joins — kept alive by _rx_keepalive
    tx.send(sample_signal()).unwrap();

    // Late subscriber should still get new messages
    let mut rx_late = tx.subscribe();
    tx.send(sample_signal()).unwrap();

    let received = rx_late.try_recv().unwrap();
    assert_eq!(received.strategy, Strategy::TriangleArb);
}

#[tokio::test]
async fn scanner_sends_signal_via_broadcast() {
    let book = create_profitable_triangle_book();
    let config = Config::default();
    let mut scanner = TriangleScanner::new(book, config);

    let (tx, mut rx) = broadcast::channel::<OpportunitySignal>(16);

    let opportunities = scanner.scan();
    assert!(!opportunities.is_empty());

    // Convert and send like start_continuous does
    for opp in opportunities {
        let signal = opp.to_signal();
        tx.send(signal).unwrap();
    }

    let received = tokio::time::timeout(Duration::from_millis(100), rx.recv())
        .await
        .expect("Should receive signal within timeout")
        .expect("Channel should not be closed");

    assert_eq!(received.strategy, Strategy::TriangleArb);
    assert_eq!(received.hops.len(), 3);
    assert!(received.net_profit_usd > 0.0);
}

// ══════════════════════════════════════════════════════════════════════
// Test C: gRPC server health check
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn scanner_server_health_check_direct() {
    let (signal_tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let (price_tx, _) = broadcast::channel::<PriceEvent>(16);

    let server = ScannerServer::new(signal_tx, price_tx, 3);

    // Call trait method directly — no network
    let response = server
        .get_health(Request::new(proto::Empty {}))
        .await
        .unwrap();
    let health = response.into_inner();

    assert_eq!(health.status, proto::HealthStatus::Healthy as i32);
    assert_eq!(health.active_feeds, 3);
    assert_eq!(health.signals_emitted, 0);
    assert!(health.uptime_seconds >= 0);
}

#[tokio::test]
async fn grpc_server_responds_to_health_check_over_network() {
    let (signal_tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let (price_tx, _) = broadcast::channel::<PriceEvent>(16);

    let server = ScannerServer::new(signal_tx, price_tx, 2);
    let port = allocate_port();
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(ScannerServiceServer::new(server))
            .serve_with_shutdown(addr, async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    // Wait for server to bind
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut client = ScannerServiceClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .expect("Should connect to gRPC server");

    let response = client
        .get_health(Request::new(proto::Empty {}))
        .await
        .unwrap();
    let health = response.into_inner();

    assert_eq!(health.status, proto::HealthStatus::Healthy as i32);
    assert_eq!(health.active_feeds, 2);
    assert_eq!(health.signals_emitted, 0);

    let _ = shutdown_tx.send(());
}

// ══════════════════════════════════════════════════════════════════════
// Test D: Full pipeline (PriceBook → Scanner → Broadcast → gRPC)
// ══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn full_pipeline_scanner_emits_signal_through_grpc() {
    // ── Step 1: Create PriceBook with profitable triangle ──
    let book = create_profitable_triangle_book();
    let config = Config::default();
    let mut scanner = TriangleScanner::new(book, config);

    // ── Step 2: Run scan — should detect the triangle ──
    let opportunities = scanner.scan();
    assert!(!opportunities.is_empty(), "Scanner should detect profitable triangle");
    assert!(
        opportunities[0].net_profit_usd > 0.10,
        "Net profit ({}) must exceed $0.10",
        opportunities[0].net_profit_usd
    );

    // ── Step 3: Convert to signal ──
    let signal = opportunities[0].to_signal();
    assert_eq!(signal.strategy, Strategy::TriangleArb);
    assert_eq!(signal.hops.len(), 3);

    // ── Step 4: Create broadcast channels ──
    let (signal_tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let (price_tx, _) = broadcast::channel::<PriceEvent>(16);

    // ── Step 5: Start gRPC server on random port ──
    let server = ScannerServer::new(signal_tx.clone(), price_tx, 1);
    let port = allocate_port();
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(ScannerServiceServer::new(server))
            .serve_with_shutdown(addr, async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    // ── Step 6: Connect client and subscribe to opportunity stream ──
    let mut client = ScannerServiceClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .expect("Should connect to gRPC server");

    let stream = client
        .stream_opportunities(Request::new(proto::StreamRequest {}))
        .await
        .expect("Should start opportunity stream");
    let mut stream = stream.into_inner();

    // ── Step 7: Send signal to broadcast channel ──
    signal_tx.send(signal.clone()).unwrap();

    // ── Step 8: Verify signal received on gRPC stream ──
    let proto_signal = tokio::time::timeout(Duration::from_secs(2), stream.message())
        .await
        .expect("Should receive signal within 2s timeout")
        .expect("Stream should not error")
        .expect("Should receive a signal message");

    assert_eq!(
        proto_signal.strategy,
        proto::Strategy::TriangleArb as i32
    );
    assert_eq!(proto_signal.route.len(), 3, "Proto signal should have 3 hops");
    assert!(!proto_signal.signal_id.is_empty(), "Signal should have an ID");

    // ── Step 9: Health check should show signals_emitted > 0 ──
    let health = client
        .get_health(Request::new(proto::Empty {}))
        .await
        .unwrap()
        .into_inner();

    assert!(
        health.signals_emitted > 0,
        "Server should have emitted at least 1 signal (got {})",
        health.signals_emitted
    );
    assert_eq!(health.status, proto::HealthStatus::Healthy as i32);

    let _ = shutdown_tx.send(());
}

#[tokio::test]
async fn full_pipeline_price_events_stream_through_grpc() {
    let (signal_tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let (price_tx, _) = broadcast::channel::<PriceEvent>(16);

    let server = ScannerServer::new(signal_tx, price_tx.clone(), 1);
    let port = allocate_port();
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(ScannerServiceServer::new(server))
            .serve_with_shutdown(addr, async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut client = ScannerServiceClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    // Subscribe to price stream
    let stream = client
        .stream_prices(Request::new(proto::StreamRequest {}))
        .await
        .unwrap();
    let mut stream = stream.into_inner();

    // Send a price event
    price_tx
        .send(PriceEvent::QuoteUpdated {
            pool_address: "pool_weth_usdc".into(),
        })
        .unwrap();

    // Verify price update received
    let update = tokio::time::timeout(Duration::from_secs(2), stream.message())
        .await
        .expect("Should receive price update within timeout")
        .expect("Stream should not error")
        .expect("Should receive a price update message");

    assert_eq!(update.pool_address, "pool_weth_usdc");

    let _ = shutdown_tx.send(());
}

#[tokio::test]
async fn full_pipeline_report_execution() {
    let (signal_tx, _) = broadcast::channel::<OpportunitySignal>(16);
    let (price_tx, _) = broadcast::channel::<PriceEvent>(16);

    let server = ScannerServer::new(signal_tx, price_tx, 1);
    let port = allocate_port();
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(ScannerServiceServer::new(server))
            .serve_with_shutdown(addr, async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut client = ScannerServiceClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    // Report a successful execution
    let result = proto::ExecutionResult {
        signal_id: "sig-test-123".into(),
        success: true,
        actual_profit_usd: "42.50".into(),
        tx_hash: "0xabc123".into(),
        error_message: String::new(),
        execution_time_ms: 150,
    };

    let response = client.report_execution(Request::new(result)).await;
    assert!(response.is_ok(), "ReportExecution should succeed");

    // Report a failed execution
    let fail_result = proto::ExecutionResult {
        signal_id: "sig-test-456".into(),
        success: false,
        actual_profit_usd: "0.00".into(),
        tx_hash: String::new(),
        error_message: "Reverted: insufficient output".into(),
        execution_time_ms: 200,
    };

    let response = client.report_execution(Request::new(fail_result)).await;
    assert!(response.is_ok(), "ReportExecution for failure should also succeed");

    let _ = shutdown_tx.send(());
}
