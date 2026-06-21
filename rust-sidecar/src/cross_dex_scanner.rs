//! Cross-DEX price divergence scanner.
//!
//! Compares prices for the same trading pair across Aerodrome CL/AMM
//! and Uniswap V3. When the spread exceeds `min_spread_bps`, emits
//! an `OpportunitySignal` for cross-DEX arbitrage.

use crate::types::{
    DexType, OpportunitySignal, PriceBook, RouteHop, Strategy, TokenAddress,
};
use anyhow::Result;
use tokio::sync::broadcast;
use tracing::info;

/// A detected cross-DEX spread.
#[derive(Debug, Clone)]
pub struct Spread {
    /// Token pair.
    pub base: TokenAddress,
    pub quote: TokenAddress,
    /// Best price on the buy side.
    pub buy_price: f64,
    /// DEX offering the buy price.
    pub buy_dex: DexType,
    /// Best price on the sell side.
    pub sell_price: f64,
    /// DEX offering the sell price.
    pub sell_dex: DexType,
    /// Spread in basis points.
    pub spread_bps: f64,
}

/// Cross-DEX arbitrage scanner.
///
/// Scans the shared `PriceBook` for pairs quoted on multiple DEXes
/// and computes the spread between the cheapest buy and the best sell.
pub struct CrossDexScanner {
    /// Shared price book.
    price_book: PriceBook,
    /// Minimum spread (basis points) to generate a signal.
    min_spread_bps: u16,
    /// Minimum net profit (USD) to emit a signal.
    min_profit_usd: f64,
}

impl CrossDexScanner {
    /// Create a new cross-DEX scanner.
    pub fn new(price_book: PriceBook, min_spread_bps: u16, min_profit_usd: f64) -> Self {
        Self {
            price_book,
            min_spread_bps,
            min_profit_usd,
        }
    }

    /// Scan all pairs for cross-DEX spreads.
    ///
    /// For each pair quoted on 2+ DEXes, find the best bid and ask
    /// across DEXes and compute the spread.
    ///
    /// TODO: Account for gas costs and flash loan fee in net profit calc.
    pub fn scan(&self) -> Vec<Spread> {
        let mut spreads = Vec::new();

        for entry in self.price_book.iter() {
            let (base, quote) = entry.key();
            let quotes = entry.value();

            // Need at least 2 quotes from different DEXes
            if quotes.len() < 2 {
                continue;
            }

            // Find best (lowest) price and worst (highest) price across DEXes
            let mut best_buy = None;
            let mut best_sell = None;

            for q in quotes {
                match best_buy {
                    None => best_buy = Some(q.clone()),
                    Some(ref current) if q.price < current.price => best_buy = Some(q.clone()),
                    _ => {}
                }
                match best_sell {
                    None => best_sell = Some(q.clone()),
                    Some(ref current) if q.price > current.price => best_sell = Some(q.clone()),
                    _ => {}
                }
            }

            if let (Some(buy), Some(sell)) = (&best_buy, &best_sell) {
                if buy.dex == sell.dex {
                    continue; // Same DEX, no cross-DEX opportunity
                }

                let spread_bps = ((sell.price - buy.price) / buy.price) * 10_000.0;

                if spread_bps >= self.min_spread_bps as f64 {
                    spreads.push(Spread {
                        base: base.clone(),
                        quote: quote.clone(),
                        buy_price: buy.price,
                        buy_dex: buy.dex,
                        sell_price: sell.price,
                        sell_dex: sell.dex,
                        spread_bps,
                    });
                }
            }
        }

        spreads
    }

    /// Convert a spread to an opportunity signal.
    ///
    /// TODO: Add realistic gas and fee estimation.
    pub fn spread_to_signal(&self, spread: &Spread) -> OpportunitySignal {
        let gross = spread.sell_price - spread.buy_price;
        let fee = spread.buy_price * 0.0005; // Aave flash loan fee
        let gas_est = 0.001; // ~$0.001 gas on Base

        OpportunitySignal {
            strategy: Strategy::CrossDexArb,
            hops: vec![
                RouteHop {
                    pool_id: String::new(), // TODO: fill from quote
                    dex: spread.buy_dex,
                    token_in: spread.base.clone(),
                    token_out: spread.quote.clone(),
                    amount_out: spread.buy_price,
                },
                RouteHop {
                    pool_id: String::new(),
                    dex: spread.sell_dex,
                    token_in: spread.quote.clone(),
                    token_out: spread.base.clone(),
                    amount_out: spread.sell_price,
                },
            ],
            gross_profit_usd: gross,
            net_profit_usd: gross - fee - gas_est,
            confidence: 0.5, // TODO: dynamic confidence
            detected_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }

    /// Run the scanner in a loop, publishing signals.
    ///
    /// TODO: Implement with tokio interval.
    pub async fn run(&self, _signal_tx: broadcast::Sender<OpportunitySignal>) -> Result<()> {
        info!(
            "CrossDexScanner starting — min_spread={}bps, min_profit=${}",
            self.min_spread_bps, self.min_profit_usd
        );
        // TODO: scan loop with interval
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DexType, PoolQuote};
    use dashmap::DashMap;
    use std::sync::Arc;

    fn make_book() -> PriceBook {
        Arc::new(DashMap::new())
    }

    fn add_quote(
        book: &PriceBook,
        base: &str,
        quote: &str,
        dex: DexType,
        price: f64,
    ) {
        let key = (base.into(), quote.into());
        book.entry(key)
            .or_insert_with(Vec::new)
            .push(PoolQuote {
                pool_id: format!("0x{}-{:?}", base, dex),
                dex,
                base_token: base.into(),
                quote_token: quote.into(),
                price,
                liquidity_usd: 100_000.0,
                timestamp_ms: 0,
            });
    }

    #[test]
    fn no_spread_single_dex() {
        let book = make_book();
        add_quote(&book, "0xA", "0xB", DexType::AerodromeCl, 1500.0);
        let scanner = CrossDexScanner::new(book, 10, 0.10);
        let spreads = scanner.scan();
        assert!(spreads.is_empty());
    }

    #[test]
    fn detects_cross_dex_spread() {
        let book = make_book();
        add_quote(&book, "0xA", "0xB", DexType::AerodromeCl, 1500.0);
        add_quote(&book, "0xA", "0xB", DexType::UniswapV3, 1505.0);
        let scanner = CrossDexScanner::new(book, 10, 0.10);
        let spreads = scanner.scan();
        assert_eq!(spreads.len(), 1);
        assert!(spreads[0].spread_bps > 30.0);
    }

    #[test]
    fn filters_below_min_spread() {
        let book = make_book();
        add_quote(&book, "0xA", "0xB", DexType::AerodromeCl, 1500.0);
        add_quote(&book, "0xA", "0xB", DexType::UniswapV3, 1500.5); // ~3.3 bps
        let scanner = CrossDexScanner::new(book, 10, 0.10);
        let spreads = scanner.scan();
        assert!(spreads.is_empty());
    }

    #[test]
    fn spread_to_signal_strategy() {
        let book = make_book();
        add_quote(&book, "0xA", "0xB", DexType::AerodromeCl, 1500.0);
        add_quote(&book, "0xA", "0xB", DexType::UniswapV3, 1510.0);
        let scanner = CrossDexScanner::new(book, 10, 0.10);
        let spreads = scanner.scan();
        let signal = scanner.spread_to_signal(&spreads[0]);
        assert_eq!(signal.strategy, Strategy::CrossDexArb);
        assert_eq!(signal.hops.len(), 2);
    }
}
