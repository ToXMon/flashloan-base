//! FlashLoan Sidecar — High-speed opportunity detection for Base chain
//!
//! Module architecture:
//! - `types`: Shared domain types (PoolQuote, PriceBook, Strategy, etc.)
//! - `config`: Configuration loading from file/env/CLI
//! - `price_feed`: WebSocket price feeds (Aerodrome CL, Uniswap V3)
//! - `triangle_scanner`: Triangle arbitrage path finding via petgraph
//! - `cross_dex_scanner`: Cross-DEX price comparison
//! - `memecoin_processor`: Memecoin opportunity detection
//! - `grpc_server`: gRPC server streaming signals to TypeScript core

pub mod config;
pub mod cross_dex_scanner;
pub mod grpc_server;
pub mod memecoin_processor;
pub mod pools;
pub mod price_book;
pub mod price_feed;
pub mod triangle_scanner;
pub mod gating_layer;
pub mod regime_detector;
pub mod trend_scanner;
pub mod types;

// Re-export key types for convenience
pub use types::{
    DexType, MemecoinToken, OpportunitySignal, PoolsConfig, PoolConfig, PoolId, PoolQuote,
    PriceBook, RouteHop, Strategy, TokenAddress, WhaleEvent,
};

// Re-export new price_book types (pool-address-keyed store)
pub use price_book::{PoolQuote as PoolQuoteV2, PriceBook as PriceBookV2, TriangleEdge};

pub use config::Config;

// ── Generated gRPC/protobuf types ──────────────────────────────────────

/// Generated protobuf types and tonic service definitions.
///
/// Compiled from `proto/scanner.proto` and `proto/common.proto` by `tonic-build`.
/// Re-exported here so all modules can reference `crate::proto::*`.
pub mod proto {
    #![allow(dead_code, clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/flashloan.scanner.v1.rs"));
}
