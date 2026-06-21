//! TOML-based pool configuration loader.
//!
//! Loads pool definitions from `pools.toml`, validates addresses,
//! and provides iteration over configured pools.

use crate::types::{DexType, PoolConfig, PoolsConfig};
use anyhow::{Context, Result};
use std::path::Path;

// ── Address validation ───────────────────────────────────────────────

/// Check that a string is a valid 0x-prefixed, 40-hex-char Ethereum address.
fn is_valid_address(s: &str) -> bool {
    if s.len() != 42 {
        return false;
    }
    let bytes = s.as_bytes();
    bytes[0] == b'0' && bytes[1] == b'x' && bytes[2..].iter().all(|b| b.is_ascii_hexdigit())
}

// ── PoolsFile (TOML shape) ───────────────────────────────────────────

/// Intermediate struct matching the TOML file layout.
/// Uses the same `PoolsConfig` type from `types.rs` via serde.
#[derive(Debug, Clone, serde::Deserialize)]
struct PoolsFile {
    pools: Vec<PoolEntry>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct PoolEntry {
    pool_id: String,
    token_a: String,
    token_b: String,
    fee_bps: u16,
    dex: DexType,
}

// ── PoolRegistry ─────────────────────────────────────────────────────

/// Runtime pool registry loaded from a TOML file.
pub struct PoolRegistry {
    configs: Vec<PoolConfig>,
}

impl PoolRegistry {
    /// Load pools from a TOML file.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading pools file {:?}", path))?;
        let file: PoolsFile = toml::from_str(&raw)
            .with_context(|| format!("parsing pools TOML {:?}", path))?;

        let mut configs = Vec::with_capacity(file.pools.len());
        for (i, entry) in file.pools.iter().enumerate() {
            Self::validate_entry(&entry.pool_id, &entry.token_a, &entry.token_b, i)?;
            configs.push(PoolConfig {
                pool_id: entry.pool_id.clone(),
                dex: entry.dex,
                token_a: entry.token_a.clone(),
                token_b: entry.token_b.clone(),
                fee_bps: entry.fee_bps,
            });
        }

        tracing::info!("loaded {} pools from {:?}", configs.len(), path);
        Ok(Self { configs })
    }

    /// Return an iterator over all loaded pool configs.
    pub fn iter(&self) -> impl Iterator<Item = &PoolConfig> {
        self.configs.iter()
    }

    /// Number of loaded pools.
    pub fn len(&self) -> usize {
        self.configs.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.configs.is_empty()
    }

    /// Convert to the shared PoolsConfig type used by the rest of the codebase.
    pub fn into_pools_config(self) -> PoolsConfig {
        PoolsConfig {
            pools: self.configs,
        }
    }

    /// Filter pools by DEX type.
    pub fn by_dex(&self, dex: DexType) -> Vec<&PoolConfig> {
        self.configs.iter().filter(|p| p.dex == dex).collect()
    }

    /// Validate a single pool entry's addresses.
    fn validate_entry(pool_id: &str, token_a: &str, token_b: &str, index: usize) -> Result<()> {
        let check = |addr: &str, label: &str| -> Result<()> {
            if !is_valid_address(addr) {
                anyhow::bail!(
                    "pool[{}] {}: invalid address {:?} (expected 0x-prefixed 40-hex-char)",
                    index,
                    label,
                    addr
                );
            }
            Ok(())
        };
        check(pool_id, "pool_id")?;
        check(token_a, "token_a")?;
        check(token_b, "token_b")?;
        Ok(())
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn valid_address_check() {
        assert!(is_valid_address("0x4200000000000000000000000000000000000006"));
        assert!(is_valid_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
        assert!(is_valid_address(
            "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"
        ));
    }

    #[test]
    fn invalid_address_too_short() {
        assert!(!is_valid_address("0x1234"));
    }

    #[test]
    fn invalid_address_no_prefix() {
        assert!(!is_valid_address(
            "4200000000000000000000000000000000000006"
        ));
    }

    #[test]
    fn invalid_address_wrong_length() {
        assert!(!is_valid_address(
            "0x420000000000000000000000000000000000000"
        )); // 39 chars
    }

    #[test]
    fn invalid_address_non_hex() {
        assert!(!is_valid_address(
            "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGgg"
        ));
    }

    #[test]
    fn load_pools_toml() {
        let path = Path::new("pools.toml");
        if !path.exists() {
            eprintln!("skipping: pools.toml not found (run from rust-sidecar/)");
            return;
        }
        let registry = PoolRegistry::load(path).expect("failed to load pools.toml");
        assert!(registry.len() >= 15, "expected >= 15 pools, got {}", registry.len());

        // Verify DEX coverage
        let aero_cl = registry.by_dex(DexType::AerodromeCl);
        let aero_amm = registry.by_dex(DexType::AerodromeAmm);
        let uni_v3 = registry.by_dex(DexType::UniswapV3);
        assert!(!aero_cl.is_empty(), "no Aerodrome CL pools");
        assert!(!aero_amm.is_empty(), "no Aerodrome AMM pools");
        assert!(!uni_v3.is_empty(), "no Uniswap V3 pools");
    }

    #[test]
    fn load_minimal_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(
            f,
            r#"
[[pools]]
pool_id = "0x0000000000000000000000000000000000000001"
token_a = "0x0000000000000000000000000000000000000002"
token_b = "0x0000000000000000000000000000000000000003"
fee_bps = 30
dex = "uniswap_v3"

[[pools]]
pool_id = "0x0000000000000000000000000000000000000004"
token_a = "0x0000000000000000000000000000000000000005"
token_b = "0x0000000000000000000000000000000000000006"
fee_bps = 5
dex = "aerodrome_cl"
"#
        )
        .unwrap();

        let registry = PoolRegistry::load(&path).unwrap();
        assert_eq!(registry.len(), 2);
        assert_eq!(registry.configs[0].dex, DexType::UniswapV3);
        assert_eq!(registry.configs[0].fee_bps, 30);
        assert_eq!(registry.configs[1].dex, DexType::AerodromeCl);
        assert_eq!(registry.configs[1].fee_bps, 5);
    }

    #[test]
    fn reject_invalid_address_in_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(
            f,
            r#"
[[pools]]
pool_id = "not_an_address"
token_a = "0x0000000000000000000000000000000000000002"
token_b = "0x0000000000000000000000000000000000000003"
fee_bps = 30
dex = "uniswap_v3"
"#
        )
        .unwrap();

        let result = PoolRegistry::load(&path);
        assert!(result.is_err(), "should reject invalid address");
    }

    #[test]
    fn into_pools_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rt.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(
            f,
            r#"
[[pools]]
pool_id = "0x0000000000000000000000000000000000000001"
token_a = "0x0000000000000000000000000000000000000002"
token_b = "0x0000000000000000000000000000000000000003"
fee_bps = 10
dex = "aerodrome_amm"
"#
        )
        .unwrap();

        let registry = PoolRegistry::load(&path).unwrap();
        let pc = registry.into_pools_config();
        assert_eq!(pc.pools.len(), 1);
        assert_eq!(pc.pools[0].dex, DexType::AerodromeAmm);
        assert_eq!(pc.pools[0].fee_bps, 10);
    }
}
