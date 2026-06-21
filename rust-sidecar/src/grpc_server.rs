//! gRPC server for streaming opportunity signals and price updates to the TypeScript core.

use crate::price_feed::PriceEvent;
use crate::types::{DexType, OpportunitySignal, Strategy};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use crate::proto::scanner_service_server::{ScannerService, ScannerServiceServer};
use crate::proto::{
    Dex, Direction, Empty, ExecutionResult, HealthCheck, HealthStatus, PoolPriceUpdate,
    OpportunitySignal as ProtoOpportunitySignal, RouteHop as ProtoRouteHop,
    Strategy as ProtoStrategy, StreamRequest,
    DirectionalSignal as ProtoDirectionalSignal,
    RegimeUpdate as ProtoRegimeUpdate,
};

// ── Conversion helpers ───────────────────────────────────────────────

fn dex_type_to_proto(dex: &DexType) -> i32 {
    match dex {
        DexType::AerodromeCl => Dex::AerodromeCl as i32,
        DexType::AerodromeAmm => Dex::AerodromeAmm as i32,
        DexType::UniswapV3 => Dex::UniswapV3 as i32,
        DexType::SushiSwap => Dex::Unspecified as i32,
    }
}

fn strategy_to_proto(strategy: &Strategy) -> i32 {
    match strategy {
        Strategy::TriangleArb => ProtoStrategy::TriangleArb as i32,
        Strategy::CrossDexArb => ProtoStrategy::CrossDexArb as i32,
        Strategy::MemecoinSnipe => ProtoStrategy::Memecoin as i32,
        Strategy::LeverageFarm => ProtoStrategy::Unspecified as i32,
    }
}

fn signal_to_proto(signal: &OpportunitySignal, signal_id: &str) -> ProtoOpportunitySignal {
    let route: Vec<ProtoRouteHop> = signal
        .hops
        .iter()
        .map(|hop| ProtoRouteHop {
            pool_address: hop.pool_id.clone(),
            dex: dex_type_to_proto(&hop.dex),
            token_in: hop.token_in.clone(),
            token_out: hop.token_out.clone(),
            fee_bps: 0,
            expected_output: format!("{:.6}", hop.amount_out),
        })
        .collect();

    ProtoOpportunitySignal {
        signal_id: signal_id.to_string(),
        strategy: strategy_to_proto(&signal.strategy),
        timestamp: signal.detected_at_ms as i64,
        confidence: signal.confidence as f32,
        expected_profit_usd: format!("{:.6}", signal.gross_profit_usd),
        expected_profit_bps: (signal.gross_profit_usd / signal.net_profit_usd.max(0.01) * 10000.0) as i32,
        route,
        input_token: signal.hops.first().map(|h| h.token_in.clone()).unwrap_or_default(),
        input_amount: "1000.0".to_string(),
        estimated_gas_cost_usd: "0.001".to_string(),
        net_profit_usd: format!("{:.6}", signal.net_profit_usd),
        expires_at: signal.detected_at_ms as i64 + 2000,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn price_event_to_proto(event: &PriceEvent) -> PoolPriceUpdate {
    let ts = now_ms();
    match event {
        PriceEvent::QuoteUpdated { pool_address } => PoolPriceUpdate {
            pool_address: pool_address.clone(),
            dex: Dex::Unspecified as i32,
            token_a: String::new(),
            token_b: String::new(),
            price_a_to_b: String::new(),
            price_b_to_a: String::new(),
            timestamp: ts,
            liquidity: String::new(),
        },
        PriceEvent::ConnectionLost { dex } => PoolPriceUpdate {
            pool_address: format!("__connection_lost_{:?}", dex),
            dex: dex_type_to_proto(dex),
            token_a: String::new(),
            token_b: String::new(),
            price_a_to_b: String::new(),
            price_b_to_a: String::new(),
            timestamp: ts,
            liquidity: String::new(),
        },
        PriceEvent::ConnectionRestored { dex } => PoolPriceUpdate {
            pool_address: format!("__connection_restored_{:?}", dex),
            dex: dex_type_to_proto(dex),
            token_a: String::new(),
            token_b: String::new(),
            price_a_to_b: String::new(),
            price_b_to_a: String::new(),
            timestamp: ts,
            liquidity: String::new(),
        },
    }
}

// ── gRPC server configuration ───────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GrpcConfig {
    pub listen_addr: String,
    pub buffer_size: usize,
}

impl Default for GrpcConfig {
    fn default() -> Self {
        Self {
            listen_addr: "0.0.0.0:50051".into(),
            buffer_size: 256,
        }
    }
}

// ── ScannerServer ───────────────────────────────────────────────────

pub struct ScannerServer {
    signal_tx: broadcast::Sender<OpportunitySignal>,
    price_tx: broadcast::Sender<PriceEvent>,
    active_feeds: i32,
    signals_emitted: Arc<AtomicU64>,
    last_signal_at: Arc<AtomicI64>,
    start_time: Instant,
}

impl ScannerServer {
    pub fn new(
        signal_tx: broadcast::Sender<OpportunitySignal>,
        price_tx: broadcast::Sender<PriceEvent>,
        active_feeds: usize,
    ) -> Self {
        Self {
            signal_tx,
            price_tx,
            active_feeds: active_feeds as i32,
            signals_emitted: Arc::new(AtomicU64::new(0)),
            last_signal_at: Arc::new(AtomicI64::new(0)),
            start_time: Instant::now(),
        }
    }
}

// ── ScannerService trait implementation ──────────────────────────────

#[tonic::async_trait]
impl ScannerService for ScannerServer {
    type StreamOpportunitiesStream =
        std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<ProtoOpportunitySignal, Status>> + Send>>;
    type StreamPricesStream =
        std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<PoolPriceUpdate, Status>> + Send>>;

    async fn stream_opportunities(
        &self,
        _request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamOpportunitiesStream>, Status> {
        let rx = self.signal_tx.subscribe();
        let signals_emitted = self.signals_emitted.clone();
        let last_signal_at = self.last_signal_at.clone();

        let stream = BroadcastStream::new(rx).filter_map(move |result| {
            match result {
                Ok(signal) => {
                    signals_emitted.fetch_add(1, Ordering::Relaxed);
                    last_signal_at.store(now_ms(), Ordering::Relaxed);
                    let signal_id = format!(
                        "sig-{}-{}",
                        signal.detected_at_ms,
                        signal.hops.first().map(|h| &h.pool_id[..8.min(h.pool_id.len())]).unwrap_or("unknown")
                    );
                    Some(Ok(signal_to_proto(&signal, &signal_id)))
                }
                Err(e) => {
                    warn!("Signal stream lagged: {}", e);
                    None
                }
            }
        });

        Ok(Response::new(Box::pin(stream) as Self::StreamOpportunitiesStream))
    }

    async fn stream_prices(
        &self,
        _request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamPricesStream>, Status> {
        let rx = self.price_tx.subscribe();

        let stream = BroadcastStream::new(rx).filter_map(|result| {
            match result {
                Ok(event) => Some(Ok(price_event_to_proto(&event))),
                Err(e) => {
                    warn!("Price stream lagged: {}", e);
                    None
                }
            }
        });

        Ok(Response::new(Box::pin(stream) as Self::StreamPricesStream))
    }

    async fn get_health(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<HealthCheck>, Status> {
        let uptime = self.start_time.elapsed().as_secs() as i64;
        let emitted = self.signals_emitted.load(Ordering::Relaxed) as i64;
        let last_at = self.last_signal_at.load(Ordering::Relaxed);

        Ok(Response::new(HealthCheck {
            status: HealthStatus::Healthy as i32,
            uptime_seconds: uptime,
            active_feeds: self.active_feeds,
            signals_emitted: emitted,
            last_signal_at: last_at,
        }))
    }

    async fn report_execution(
        &self,
        request: Request<ExecutionResult>,
    ) -> Result<Response<Empty>, Status> {
        let result = request.into_inner();
        if result.success {
            info!(
                signal_id = %result.signal_id,
                profit = %result.actual_profit_usd,
                tx_hash = %result.tx_hash,
                execution_ms = result.execution_time_ms,
                "Execution reported: SUCCESS"
            );
        } else {
            warn!(
                signal_id = %result.signal_id,
                error = %result.error_message,
                "Execution reported: FAILED"
            );
        }
        Ok(Response::new(Empty {}))
    }

    // ── New: Streaming stub methods (gating layer integration deferred) ─

    type StreamDirectionalSignalsStream =
        std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<ProtoDirectionalSignal, Status>> + Send>>;

    async fn stream_directional_signals(
        &self,
        _request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamDirectionalSignalsStream>, Status> {
        // Stub: returns empty stream. Gating layer integration in later slice.
        let stream = tokio_stream::iter(vec![]);
        Ok(Response::new(Box::pin(stream) as Self::StreamDirectionalSignalsStream))
    }

    type StreamRegimeUpdatesStream =
        std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<ProtoRegimeUpdate, Status>> + Send>>;

    async fn stream_regime_updates(
        &self,
        _request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamRegimeUpdatesStream>, Status> {
        // Stub: returns empty stream. Regime detection integration in later slice.
        let stream = tokio_stream::iter(vec![]);
        Ok(Response::new(Box::pin(stream) as Self::StreamRegimeUpdatesStream))
    }

    async fn get_current_regime(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<ProtoRegimeUpdate>, Status> {
        // Stub: returns default regime update. Will integrate with RegimeDetector later.
        Ok(Response::new(ProtoRegimeUpdate {
            regime: String::new(),
            previous_regime: String::new(),
            confidence: 0.0,
            changed_at_block: 0,
            pairs_affected: vec![],
            detected_at_ms: 0,
        }))
    }

    type StreamSignalsStream =
        std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<crate::proto::ScannerResponse, Status>> + Send>>;

    async fn stream_signals(
        &self,
        _request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamSignalsStream>, Status> {
        // Stub: returns empty stream. Unified signal stream in later slice.
        let stream = tokio_stream::iter(vec![]);
        Ok(Response::new(Box::pin(stream) as Self::StreamSignalsStream))
    }
}

// ── Server startup helper ───────────────────────────────────────────

pub struct GrpcServer {
    config: GrpcConfig,
    scanner: ScannerServer,
}

impl GrpcServer {
    pub fn new(
        config: GrpcConfig,
        signal_tx: broadcast::Sender<OpportunitySignal>,
        price_tx: broadcast::Sender<PriceEvent>,
        active_feeds: usize,
    ) -> Self {
        let scanner = ScannerServer::new(signal_tx, price_tx, active_feeds);
        Self { config, scanner }
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let addr: SocketAddr = self.config.listen_addr.parse()?;
        info!("gRPC server starting on {}", addr);
        tonic::transport::Server::builder()
            .add_service(ScannerServiceServer::new(self.scanner))
            .serve(addr)
            .await?;
        Ok(())
    }

    pub fn listen_addr(&self) -> &str {
        &self.config.listen_addr
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grpc_config_default() {
        let config = GrpcConfig::default();
        assert_eq!(config.listen_addr, "0.0.0.0:50051");
        assert_eq!(config.buffer_size, 256);
    }

    #[test]
    fn scanner_server_creation() {
        let (sig_tx, _) = broadcast::channel(16);
        let (price_tx, _) = broadcast::channel(16);
        let server = ScannerServer::new(sig_tx, price_tx, 5);
        assert_eq!(server.active_feeds, 5);
        assert_eq!(server.signals_emitted.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn grpc_server_creation() {
        let (sig_tx, _) = broadcast::channel(16);
        let (price_tx, _) = broadcast::channel(16);
        let server = GrpcServer::new(GrpcConfig::default(), sig_tx, price_tx, 10);
        assert_eq!(server.listen_addr(), "0.0.0.0:50051");
    }

    #[test]
    fn grpc_config_custom() {
        let config = GrpcConfig {
            listen_addr: "127.0.0.1:9999".into(),
            buffer_size: 512,
        };
        assert_eq!(config.listen_addr, "127.0.0.1:9999");
    }

    #[test]
    fn dex_type_mapping() {
        assert_eq!(dex_type_to_proto(&DexType::AerodromeCl), Dex::AerodromeCl as i32);
        assert_eq!(dex_type_to_proto(&DexType::AerodromeAmm), Dex::AerodromeAmm as i32);
        assert_eq!(dex_type_to_proto(&DexType::UniswapV3), Dex::UniswapV3 as i32);
        assert_eq!(dex_type_to_proto(&DexType::SushiSwap), Dex::Unspecified as i32);
    }

    #[test]
    fn strategy_mapping() {
        assert_eq!(strategy_to_proto(&Strategy::TriangleArb), ProtoStrategy::TriangleArb as i32);
        assert_eq!(strategy_to_proto(&Strategy::CrossDexArb), ProtoStrategy::CrossDexArb as i32);
        assert_eq!(strategy_to_proto(&Strategy::MemecoinSnipe), ProtoStrategy::Memecoin as i32);
        assert_eq!(strategy_to_proto(&Strategy::LeverageFarm), ProtoStrategy::Unspecified as i32);
    }

    #[test]
    fn signal_to_proto_conversion() {
        use crate::types::RouteHop;
        let signal = OpportunitySignal {
            strategy: Strategy::TriangleArb,
            hops: vec![RouteHop {
                pool_id: "0xpool1".into(),
                dex: DexType::AerodromeCl,
                token_in: "0xtokenA".into(),
                token_out: "0xtokenB".into(),
                amount_out: 1500.0,
            }],
            gross_profit_usd: 5.0,
            net_profit_usd: 4.5,
            confidence: 0.85,
            detected_at_ms: 1700000000000,
        };
        let proto = signal_to_proto(&signal, "test-sig-1");
        assert_eq!(proto.signal_id, "test-sig-1");
        assert_eq!(proto.strategy, ProtoStrategy::TriangleArb as i32);
        assert_eq!(proto.timestamp, 1700000000000);
        assert!((proto.confidence - 0.85).abs() < 0.01);
        assert_eq!(proto.route.len(), 1);
        assert_eq!(proto.route[0].pool_address, "0xpool1");
        assert_eq!(proto.input_token, "0xtokenA");
    }

    #[tokio::test]
    async fn health_check_returns_healthy() {
        let (sig_tx, _) = broadcast::channel(16);
        let (price_tx, _) = broadcast::channel(16);
        let server = ScannerServer::new(sig_tx, price_tx, 3);
        let resp = server.get_health(Request::new(Empty {})).await.unwrap();
        let health = resp.into_inner();
        assert_eq!(health.status, HealthStatus::Healthy as i32);
        assert_eq!(health.active_feeds, 3);
        assert_eq!(health.signals_emitted, 0);
    }

    #[tokio::test]
    async fn report_execution_logs_success() {
        let (sig_tx, _) = broadcast::channel(16);
        let (price_tx, _) = broadcast::channel(16);
        let server = ScannerServer::new(sig_tx, price_tx, 1);
        let result = ExecutionResult {
            signal_id: "test-123".into(),
            success: true,
            actual_profit_usd: "1.50".into(),
            tx_hash: "0xabc".into(),
            error_message: String::new(),
            execution_time_ms: 42,
        };
        let resp = server.report_execution(Request::new(result)).await.unwrap();
        let _ = resp.into_inner();
    }
}
