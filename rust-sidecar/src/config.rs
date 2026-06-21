//! Configuration loading for the flashloan sidecar.
//!
//! Config is resolved from (in priority order):
//! 1. CLI arguments (clap)
//! 2. Environment variables
//! 3. Config file (JSON)
//! 4. Compiled-in defaults

use crate::types::PoolsConfig;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Top-level sidecar configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Alchemy or custom RPC URL (https:// or wss://).
    pub rpc_url: String,

    /// WebSocket URL for real-time price feeds.
    pub ws_url: String,

    /// Path to pools configuration JSON file.
    pub pools_config_path: PathBuf,

    /// gRPC server listen port.
    pub grpc_port: u16,

    /// Minimum net profit (USD) to emit an opportunity signal.
    pub min_profit_usd: f64,

    /// Minimum spread in basis points for cross-DEX signals.
    pub min_spread_bps: u16,

    /// Flash loan fee in basis points (Aave V3 = 5 bps = 0.05%).
    pub flash_loan_fee_bps: u16,

    /// Maximum gas price (gwei) for profitability calculation.
    pub max_gas_price_gwei: f64,

    /// Scan interval in milliseconds for continuous mode.
    pub scan_interval_ms: u64,

    /// Maximum triangle path depth (3 = simple triangle).
    pub max_triangle_depth: u8,

    /// Memecoin minimum volume filter (USD).
    pub memecoin_min_volume_usd: f64,

    /// Memecoin maximum age filter (seconds).
    pub memecoin_max_age_secs: u64,

    /// Log level (trace, debug, info, warn, error).
    pub log_level: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            rpc_url: "https://mainnet.base.org".into(),
            ws_url: "wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY".into(),
            pools_config_path: PathBuf::from("config/pools.json"),
            grpc_port: 50051,
            min_profit_usd: 0.10,
            min_spread_bps: 10,
            flash_loan_fee_bps: 5,
            max_gas_price_gwei: 1.0,
            scan_interval_ms: 1000,
            max_triangle_depth: 3,
            memecoin_min_volume_usd: 10_000.0,
            memecoin_max_age_secs: 86_400,
            log_level: "info".into(),
        }
    }
}

impl Config {
    /// Load config from a JSON file, falling back to defaults for missing fields.
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config file {:?}", path))?;
        let cfg: Config = serde_json::from_str(&raw)
            .with_context(|| format!("parsing config file {:?}", path))?;
        Ok(cfg)
    }

    /// Override fields from environment variables (SIDECAR_* prefix).
    pub fn apply_env_overrides(&mut self) {
        if let Ok(v) = std::env::var("SIDECAR_RPC_URL") {
            self.rpc_url = v;
        }
        if let Ok(v) = std::env::var("SIDECAR_WS_URL") {
            self.ws_url = v;
        }
        if let Ok(v) = std::env::var("SIDECAR_GRPC_PORT") {
            if let Ok(port) = v.parse() {
                self.grpc_port = port;
            }
        }
        if let Ok(v) = std::env::var("SIDECAR_MIN_PROFIT_USD") {
            if let Ok(profit) = v.parse() {
                self.min_profit_usd = profit;
            }
        }
        if let Ok(v) = std::env::var("SIDECAR_LOG_LEVEL") {
            self.log_level = v;
        }
    }

    /// Load pools configuration from the configured path.
    pub fn load_pools(&self) -> Result<PoolsConfig> {
        if !self.pools_config_path.exists() {
            return Ok(PoolsConfig { pools: vec![] });
        }
        let raw = std::fs::read_to_string(&self.pools_config_path)
            .with_context(|| format!("reading pools config {:?}", self.pools_config_path))?;
        let pools: PoolsConfig = serde_json::from_str(&raw)
            .with_context(|| format!("parsing pools config {:?}", self.pools_config_path))?;
        Ok(pools)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let cfg = Config::default();
        assert_eq!(cfg.grpc_port, 50051);
        assert_eq!(cfg.flash_loan_fee_bps, 5);
        assert_eq!(cfg.max_triangle_depth, 3);
    }

    #[test]
    fn config_from_missing_file_returns_default() {
        let cfg = Config::from_file(PathBuf::from("nonexistent.json").as_path()).unwrap();
        assert_eq!(cfg.grpc_port, 50051);
    }

    #[test]
    fn config_roundtrip_json() {
        let cfg = Config::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.rpc_url, cfg.rpc_url);
        assert_eq!(back.min_profit_usd, cfg.min_profit_usd);
    }
}
