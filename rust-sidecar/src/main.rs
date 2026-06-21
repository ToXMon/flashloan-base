use anyhow::Result;
use clap::Parser;
use flashloan_sidecar::config::Config;
use flashloan_sidecar::grpc_server::{GrpcConfig, GrpcServer};
use flashloan_sidecar::price_book::PriceBook;
use flashloan_sidecar::price_feed::PriceFeed;
use flashloan_sidecar::pools::PoolRegistry;
use flashloan_sidecar::triangle_scanner::TriangleScanner;
use flashloan_sidecar::types::OpportunitySignal;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

/// FlashLoan Sidecar — High-speed opportunity detection for Base chain
#[derive(Parser, Debug)]
#[command(name = "flashloan-sidecar", version, about)]
struct Args {
    /// Path to config file (JSON)
    #[arg(long, default_value = "config/sidecar.json", env = "SIDECAR_CONFIG_PATH")]
    config: PathBuf,

    /// gRPC server port
    #[arg(long, env = "SIDECAR_GRPC_PORT")]
    grpc_port: Option<u16>,

    /// Alchemy RPC URL (https://)
    #[arg(long, env = "SIDECAR_RPC_URL")]
    rpc_url: Option<String>,

    /// Alchemy WebSocket URL (wss://)
    #[arg(long, env = "SIDECAR_WS_URL")]
    ws_url: Option<String>,

    /// Minimum net profit (USD) to emit a signal
    #[arg(long, env = "SIDECAR_MIN_PROFIT_USD")]
    min_profit_usd: Option<f64>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, env = "RUST_LOG")]
    log_level: Option<String>,

    /// Print config and exit (dry run)
    #[arg(long)]
    dry_run: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Load config: file → env → CLI overrides
    let mut config = Config::from_file(&args.config)?;
    config.apply_env_overrides();

    // Apply CLI overrides (highest priority)
    if let Some(port) = args.grpc_port {
        config.grpc_port = port;
    }
    if let Some(ref rpc) = args.rpc_url {
        config.rpc_url = rpc.clone();
    }
    if let Some(ref ws) = args.ws_url {
        config.ws_url = ws.clone();
    }
    if let Some(profit) = args.min_profit_usd {
        config.min_profit_usd = profit;
    }
    if let Some(ref level) = args.log_level {
        config.log_level = level.clone();
    }

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .with_target(false)
        .init();

    // Startup banner
    info!("══════════════════════════════════════════════════════");
    info!("  FlashLoan Sidecar v0.1.0 — Base Chain Detector");
    info!("══════════════════════════════════════════════════════");
    info!("  RPC:       {}", config.rpc_url);
    info!("  WebSocket: {}", config.ws_url);
    info!("  gRPC port: {}", config.grpc_port);
    info!("  Min profit: ${:.2}", config.min_profit_usd);
    info!("  Min spread: {} bps", config.min_spread_bps);
    info!("  Flash fee:  {} bps", config.flash_loan_fee_bps);
    info!("  Scan interval: {}ms", config.scan_interval_ms);
    info!("  Log level: {}", config.log_level);
    info!("══════════════════════════════════════════════════════");

    // Dry run: print config and exit
    if args.dry_run {
        info!("Dry run — printing config:");
        println!("{}", serde_json::to_string_pretty(&config)?);
        return Ok(());
    }

    // Load pool configuration
    let pool_registry = PoolRegistry::load(&config.pools_config_path)?;
    let pool_count = pool_registry.len();
    info!("Loaded {} pool configurations", pool_count);

    // ── Create broadcast channels ──────────────────────────────────────
    let (signal_tx, _) = tokio::sync::broadcast::channel::<OpportunitySignal>(256);
    let (price_tx, _) =
        tokio::sync::broadcast::channel::<flashloan_sidecar::price_feed::PriceEvent>(256);

    // ── Initialize shared price book (V2, pool-address-keyed) ──────────
    let price_book = PriceBook::new();
    let price_book_arc = Arc::new(price_book.clone());

    // ── Start price feed ──────────────────────────────────────────────
    let price_feed = PriceFeed::new(
        config.ws_url.clone(),
        &pool_registry,
        price_book_arc,
        price_tx.clone(),
    );
    tokio::spawn(async move {
        if let Err(e) = price_feed.start().await {
            tracing::error!("Price feed error: {}", e);
        }
    });
    info!("Price feed started");

    // ── Start triangle scanner ────────────────────────────────────────
    let mut triangle = TriangleScanner::new(price_book, config.clone());
    let sig_tx = signal_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = triangle.start_continuous(sig_tx).await {
            tracing::error!("Triangle scanner error: {}", e);
        }
    });
    info!("Triangle scanner started");

    // ── Start gRPC server ─────────────────────────────────────────────
    let grpc_config = GrpcConfig {
        listen_addr: format!("0.0.0.0:{}", config.grpc_port),
        buffer_size: 256,
    };
    let grpc_server = GrpcServer::new(grpc_config, signal_tx, price_tx, pool_count);
    let listen_addr = grpc_server.listen_addr().to_string();

    info!("gRPC server starting on {}", listen_addr);
    info!("══════════════════════════════════════════════════════");
    info!("  Sidecar ready — streaming signals to TypeScript core");
    info!("══════════════════════════════════════════════════════");

    // Run gRPC server (blocks until shutdown)
    grpc_server.run().await?;

    Ok(())
}
