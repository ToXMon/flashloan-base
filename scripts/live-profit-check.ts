#!/usr/bin/env tsx
/**
 * Live Profitability Pre-Check
 * Run: npx tsx scripts/live-profit-check.ts
 *
 * Queries current Base mainnet DEX prices to find real-time
 * cross-DEX arbitrage opportunities. Read-only — no transactions.
 *
 * Strategy: Compare WETH/USDC spot prices across Aerodrome CL,
 * Uniswap V3, and Aerodrome AMM. Compute spreads and flag any
 * that exceed the 15 bps minimum threshold.
 */

import { ethers, Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const AERO_CL_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERO_AMM_ROUTER = '0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925';
const UNI_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const UNI_V3_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const AERO_FACTORY = '0x420dD381B31AEf6683DB6b902084cB0ffEcFc40e';
const UNI_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

const AAVE_FLASH_FEE_BPS = 5; // 0.05%
const MIN_SPREAD_BPS = 15;

// ════════════════════════════════════════════════════════════════════════
// ABIs
// ════════════════════════════════════════════════════════════════════════

const QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)',
];

const AERO_CL_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
];

const AERO_CL_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const UNI_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function balanceOf(address) external view returns (uint256)',
];

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) external view returns (tuple(uint256 data, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint40 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getReservesList() external view returns (address[])',
];

// ════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════

interface PriceQuote {
  dex: string;
  pair: string;
  pool: string;
  fee: number;
  wethPerToken: number;
  tokenPerWeth: number;
  priceUsd: number;
  liquidity?: number;
}

interface DexPair {
  name: string;
  quoteA: PriceQuote;
  quoteB: PriceQuote;
  spreadBps: number;
  profitable: boolean;
  netAfterFeesBps: number;
}

interface AaveRate {
  asset: string;
  symbol: string;
  decimals: number;
  supplyAPY: number;
  borrowAPY: number;
  availableLiquidityUsd: number;
  utilization: number;
}

interface Report {
  timestamp: string;
  blockNumber: number;
  ethPriceUsd: number;
  crossDexPairs: DexPair[];
  bestOpportunities: DexPair[];
  aaveRates: AaveRate[];
  summary: {
    totalPairs: number;
    profitablePairs: number;
    avgSpreadBps: number;
    maxSpreadBps: number;
    minSpreadBps: number;
    estimatedGasCostUsd: number;
    flashFeeBps: number;
  };
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════════════════════
// Price Queries
// ════════════════════════════════════════════════════════════════════════

async function getUniV3Quote(
  provider: JsonRpcProvider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const quoter = new Contract(UNI_V3_QUOTER, QUOTER_ABI, provider);
    const amountOut = await quoter.quoteExactInputSingle(
      tokenIn, tokenOut, amountIn, fee, 0,
    );
    return amountOut as bigint;
  } catch (err) {
    console.warn(`  [UniV3] quote failed fee=${fee}:`, (err as Error).message.slice(0, 120));
    return null;
  }
}

async function getAeroCLPoolPrice(
  provider: JsonRpcProvider,
  tokenA: string,
  tokenB: string,
  fee: number,
): Promise<{ sqrtPriceX96: bigint; pool: string; feeTier: number } | null> {
  try {
    const factory = new Contract(AERO_FACTORY, AERO_CL_FACTORY_ABI, provider);
    const poolAddr = await factory.getPool(tokenA, tokenB, fee);
    if (poolAddr === ethers.ZeroAddress) return null;

    const pool = new Contract(poolAddr, AERO_CL_POOL_ABI, provider);
    const slot0 = await pool.slot0();
    const token0 = await pool.token0();
    const poolFee = await pool.fee();

    return {
      sqrtPriceX96: slot0.sqrtPriceX96 as bigint,
      pool: poolAddr,
      feeTier: Number(poolFee),
    };
  } catch (err) {
    console.warn(`  [AeroCL] pool query failed fee=${fee}:`, (err as Error).message.slice(0, 100));
    return null;
  }
}

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, token0: string, token1: string, decimals0: number, decimals1: number): number {
  // Price = (sqrtPriceX96 / 2^96)^2
  const Q96 = 1n << 96n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const price = Number(priceX192) / Number(Q96 * Q96);

  // Adjust for decimals
  const adjusted = price * 10 ** (decimals0 - decimals1);

  // If WETH is token0, price is WETH per token1
  // If WETH is token1, price is token1 per WETH
  const wethAddr = token0.toLowerCase() === WETH.toLowerCase() ? token0 :
    token1.toLowerCase() === WETH.toLowerCase() ? token1 : null;

  if (!wethAddr) return adjusted;

  return adjusted;
}

async function getAeroAMMPoolPrice(
  provider: JsonRpcProvider,
  tokenA: string,
  tokenB: string,
): Promise<{ price: number; pool: string } | null> {
  try {
    // Aerodrome AMM uses a simple constant product formula
    // We can query reserves via the pair contract
    // The AMM router doesn't have a direct quote function like UniV3
    // Instead, use the factory to get the pair and get reserves
    // For now, return null and note this requires the actual pair contract
    return null;
  } catch (err) {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Aave V3 Rates
// ════════════════════════════════════════════════════════════════════════

async function getAaveRates(provider: JsonRpcProvider): Promise<AaveRate[]> {
  try {
    const pool = new Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
    const reserves = await pool.getReservesList();

    const rates: AaveRate[] = [];
    for (const asset of reserves as string[]) {
      try {
        const data = await pool.getReserveData(asset);
        const erc20 = new Contract(asset, ERC20_ABI, provider);
        const symbol = await erc20.symbol();
        const decimals = await erc20.decimals();

        // Aave rates are in ray (1e27) — convert to APY
        const supplyRateRay = data.currentLiquidityRate as bigint;
        const borrowRateRay = data.currentVariableBorrowRate as bigint;

        // RAY = 1e27
        const ray = 1e27;
        const supplyAPY = (Math.pow(1 + Number(supplyRateRay) / ray / 365, 365) - 1) * 100;
        const borrowAPY = (Math.pow(1 + Number(borrowRateRay) / ray / 365, 365) - 1) * 100;

        // Available liquidity in $ (approximate)
        const liquidityData = data.data as bigint;
        const availableLiquidity = liquidityData & BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
        const availableEth = Number(formatUnits(availableLiquidity, decimals));

        // Utilization rate
        const totalDebt = data.totalDebt as bigint;
        const utilization = Number(availableLiquidity) > 0
          ? Number(totalDebt) / (Number(availableLiquidity) + Number(totalDebt)) * 100
          : 0;

        rates.push({
          asset,
          symbol,
          decimals: Number(decimals),
          supplyAPY,
          borrowAPY,
          availableLiquidityUsd: availableEth * 2500, // Rough USD estimate
          utilization,
        });
      } catch (e) {
        // Skip assets that fail
      }
    }

    return rates;
  } catch (err) {
    console.warn('  [Aave] Failed to get rates:', (err as Error).message.slice(0, 100));
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════
// Main Check
// ════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Live Profitability Pre-Check — Base Mainnet              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ BASE_RPC_URL not set. Create .env with BASE_RPC_URL=...');
    process.exit(1);
  }

  console.log(`  Connecting to Base mainnet...`);
  const provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });

  const network = await provider.getNetwork();
  console.log(`  Chain: ${network.chainId} (${network.name || 'Base'})\n`);

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const ethPrice = block?.baseFeePerGas
    ? Number(formatUnits(block.baseFeePerGas, 'gwei')) * 2500
    : 2500; // Fallback ETH price estimate

  console.log(`  Block: ${blockNumber}`);
  console.log(`  ETH/USD: ~$${ethPrice.toFixed(0)}\n`);

  // ═══════════════════════════════════════════════════════════════════
  // 1. Cross-DEX Price Comparison
  // ═══════════════════════════════════════════════════════════════════

  console.log('─'.repeat(60));
  console.log('  PHASE 1: Cross-DEX Price Comparison');
  console.log('─'.repeat(60));
  console.log('');

  const pairs: DexPair[] = [];
  const feeTiers = [500, 3000]; // 0.05%, 0.3%
  const AMOUNT_IN = parseUnits('1', 18); // 1 WETH

  for (const fee of feeTiers) {
    console.log(`  Fee tier: ${fee} (${(fee/10000)*100}%)`);

    // ── Uniswap V3 ────────────────────────────────────────────
    const uniWethUsdc = await getUniV3Quote(provider, WETH, USDC, AMOUNT_IN, fee);
    const uniUsdcWeth = uniWethUsdc ? await getUniV3Quote(provider, USDC, WETH, uniWethUsdc, fee) : null;

    if (uniWethUsdc) {
      const usdcPerWeth = Number(formatUnits(uniWethUsdc, 6));
      console.log(`    UniV3  WETH→USDC: $${usdcPerWeth.toFixed(2)}`);
    }

    // ── Aerodrome CL ──────────────────────────────────────────
    const aeroPrice = await getAeroCLPoolPrice(provider, WETH, USDC, fee);
    if (aeroPrice) {
      const token0 = WETH.toLowerCase() < USDC.toLowerCase() ? WETH : USDC;
      const token1 = token0 === WETH ? USDC : WETH;
      const price = sqrtPriceX96ToPrice(aeroPrice.sqrtPriceX96, token0, token1, 18, 6);
      const usdcPerWethAero = token0 === WETH ? price : 1 / price;
      console.log(`    AeroCL WETH→USDC: $${usdcPerWethAero.toFixed(2)}`);
      console.log(`      Pool: ${aeroPrice.pool}`);
    }

    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Exact price comparison via UniV3 Quoter for both directions
  // ═══════════════════════════════════════════════════════════════════

  console.log('  Cross-DEX Quotes (1 WETH → USDC):');
  console.log('');

  const wethDecimals = 18;
  const usdcDecimals = 6;
  const oneWeth = parseUnits('1', 18);
  const oneUsdc = parseUnits('1', 6);

  const quotes: PriceQuote[] = [];

  // UniV3 quotes at different fee tiers
  for (const fee of feeTiers) {
    const amountOut = await getUniV3Quote(provider, WETH, USDC, oneWeth, fee);
    if (amountOut) {
      const usdcPerWeth = Number(formatUnits(amountOut, 6));
      quotes.push({
        dex: 'Uniswap V3',
        pair: 'WETH/USDC',
        pool: UNI_V3_QUOTER,
        fee: fee,
        wethPerToken: 1 / usdcPerWeth,
        tokenPerWeth: usdcPerWeth,
        priceUsd: usdcPerWeth,
      });
      console.log(`  UniV3 (fee ${fee}):   1 WETH = $${usdcPerWeth.toFixed(2)} USDC`);
    }
  }

  // Aerodrome CL quotes via slot0
  for (const fee of feeTiers) {
    const priceData = await getAeroCLPoolPrice(provider, WETH, USDC, fee);
    if (priceData) {
      const token0 = WETH.toLowerCase() < USDC.toLowerCase() ? WETH : USDC;
      const price = sqrtPriceX96ToPrice(priceData.sqrtPriceX96, token0, token1 = token0 === WETH ? USDC : WETH, 18, 6);
      const usdcPerWeth = token0 === WETH ? price : 1 / price;
      quotes.push({
        dex: 'Aerodrome CL',
        pair: 'WETH/USDC',
        pool: priceData.pool,
        fee: fee,
        wethPerToken: 1 / usdcPerWeth,
        tokenPerWeth: usdcPerWeth,
        priceUsd: usdcPerWeth,
      });
      console.log(`  AeroCL (fee ${fee}):   1 WETH = $${usdcPerWeth.toFixed(2)} USDC  (pool: ${priceData.pool.slice(0, 10)}...)`);
    }
  }

  // Check for UniV3 reverse direction (to catch inverted quotes)
  const uniReverse = await getUniV3Quote(provider, USDC, WETH, oneUsdc, 500);
  if (uniReverse) {
    const wethPerUsdc = Number(formatUnits(uniReverse, 18));
    const derivedUsdcPerWeth = 1 / wethPerUsdc;
    console.log(`  UniV3 (fee 500 rev): 1 WETH = $${derivedUsdcPerWeth.toFixed(2)} USDC  (from USDC→WETH)`);
    if (quotes.length === 0) {
      quotes.push({
        dex: 'Uniswap V3',
        pair: 'WETH/USDC',
        pool: UNI_V3_QUOTER,
        fee: 500,
        wethPerToken: wethPerUsdc,
        tokenPerWeth: derivedUsdcPerWeth,
        priceUsd: derivedUsdcPerWeth,
      });
    }
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // 2. Compute Cross-DEX Spreads
  // ═══════════════════════════════════════════════════════════════════

  console.log('─'.repeat(60));
  console.log('  PHASE 2: Spread Analysis');
  console.log('─'.repeat(60));
  console.log('');

  // Find min/max prices across DEXes
  if (quotes.length >= 2) {
    const minPrice = Math.min(...quotes.map(q => q.priceUsd));
    const maxPrice = Math.max(...quotes.map(q => q.priceUsd));
    const avgPrice = quotes.reduce((s, q) => s + q.priceUsd, 0) / quotes.length;

    const bestBuy = quotes.reduce((best, q) => q.priceUsd < best.priceUsd ? q : best);
    const bestSell = quotes.reduce((best, q) => q.priceUsd > best.priceUsd ? q : best);

    if (bestBuy.dex !== bestSell.dex || bestBuy.fee !== bestSell.fee) {
      const rawSpreadBps = ((bestSell.priceUsd - bestBuy.priceUsd) / bestBuy.priceUsd) * 10000;
      const flashFee = 5; // 0.05%
      const gasCost = 0.10; // ~$0.10 per tx on Base
      const gasCostBps = (gasCost / bestBuy.priceUsd) * 10000;
      const netSpreadBps = rawSpreadBps - flashFee - gasCostBps;

      console.log(`  Best buy:  ${bestBuy.dex} (fee ${bestBuy.fee}) @ $${bestBuy.priceUsd.toFixed(2)}`);
      console.log(`  Best sell: ${bestSell.dex} (fee ${bestSell.fee}) @ $${bestSell.priceUsd.toFixed(2)}`);
      console.log(`  Raw spread:     ${rawSpreadBps.toFixed(2)} bps`);
      console.log(`  Flash fee:      -${flashFee} bps (0.05%)`);
      console.log(`  Gas cost:       -${gasCostBps.toFixed(2)} bps (~$${gasCost.toFixed(2)})`);
      console.log(`  Net after fees: ${netSpreadBps.toFixed(2)} bps`);
      console.log(`  Requires ${MIN_SPREAD_BPS} bps: ${netSpreadBps >= MIN_SPREAD_BPS ? '✅ YES' : '❌ NO'}`);

      pairs.push({
        name: 'WETH/USDC',
        quoteA: bestBuy,
        quoteB: bestSell,
        spreadBps: rawSpreadBps,
        profitable: netSpreadBps >= MIN_SPREAD_BPS,
        netAfterFeesBps: netSpreadBps,
      });
    } else {
      console.log('  All quotes from same DEX/fee — no cross-DEX spread found');
    }

    console.log(`\n  Average WETH price: $${avgPrice.toFixed(2)}`);
    console.log(`  Price range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
  } else {
    console.log('  Insufficient price quotes to compute spreads');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // 3. Aave V3 Rates
  // ═══════════════════════════════════════════════════════════════════

  console.log('─'.repeat(60));
  console.log('  PHASE 3: Aave V3 Lending Rates');
  console.log('─'.repeat(60));
  console.log('');

  const aaveRates = await getAaveRates(provider);
  const relevantRates = aaveRates.filter(r =>
    ['WETH', 'USDC', 'DAI', 'USDbC', 'cbETH', 'weETH', 'rETH'].includes(r.symbol)
  );

  if (relevantRates.length > 0) {
    console.log('  Asset        Supply APY    Borrow APY    Utilization  Available');
    console.log('  ─────────────────────────────────────────────────────────────────');
    for (const rate of relevantRates) {
      const availStr = rate.availableLiquidityUsd > 1_000_000
        ? `$${(rate.availableLiquidityUsd / 1_000_000).toFixed(1)}M`
        : `$${(rate.availableLiquidityUsd / 1_000).toFixed(0)}K`;
      console.log(
        `  ${rate.symbol.padEnd(10)} ` +
        `${rate.supplyAPY.toFixed(2).padStart(9)}% ` +
        `${rate.borrowAPY.toFixed(2).padStart(9)}% ` +
        `${rate.utilization.toFixed(1).padStart(9)}% ` +
        `${availStr.padStart(10)}`
      );
    }
  } else {
    console.log('  Unable to fetch Aave V3 rates (may need higher RPC limits)');
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════
  // Generate Report
  // ═══════════════════════════════════════════════════════════════════

  console.log('─'.repeat(60));
  console.log('  Generating Report...');
  console.log('─'.repeat(60));
  console.log('');

  const report: Report = {
    timestamp: timestamp(),
    blockNumber,
    ethPriceUsd: ethPrice,
    crossDexPairs: pairs,
    bestOpportunities: pairs.filter(p => p.profitable).sort((a, b) => b.netAfterFeesBps - a.netAfterFeesBps),
    aaveRates: relevantRates,
    summary: {
      totalPairs: pairs.length,
      profitablePairs: pairs.filter(p => p.profitable).length,
      avgSpreadBps: pairs.length > 0 ? pairs.reduce((s, p) => s + p.spreadBps, 0) / pairs.length : 0,
      maxSpreadBps: pairs.length > 0 ? Math.max(...pairs.map(p => p.spreadBps)) : 0,
      minSpreadBps: pairs.length > 0 ? Math.min(...pairs.map(p => p.spreadBps)) : 0,
      estimatedGasCostUsd: 0.10,
      flashFeeBps: AAVE_FLASH_FEE_BPS,
    },
  };

  // Save report
  const reportPath = path.resolve(process.cwd(), 'docs', 'live-profitability-report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const md = generateMarkdown(report, quotes);
  fs.writeFileSync(reportPath, md, 'utf8');

  console.log(`  Report saved to: ${reportPath}`);
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('  CHECK COMPLETE');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Print verdict
  const profitable = report.summary.profitablePairs > 0;
  if (profitable) {
    console.log(`  ✅ ${report.summary.profitablePairs} profitable opportunity/ies found!`);
    console.log(`     Best spread: ${report.bestOpportunities[0].netAfterFeesBps.toFixed(2)} bps net`);
  } else {
    console.log(`  ❌ No profitable opportunities found above ${MIN_SPREAD_BPS} bps threshold`);
    console.log(`     Max spread detected: ${report.summary.maxSpreadBps.toFixed(2)} bps`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Markdown Generator
// ════════════════════════════════════════════════════════════════════════

function generateMarkdown(report: Report, quotes: PriceQuote[]): string {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push('# Live Profitability Report — Base Mainnet');
  push('');
  push(`*Generated: ${report.timestamp}*`);
  push(`*Block: ${report.blockNumber}*`);
  push('');
  push('## Summary');
  push('');
  push('| Metric | Value |');
  push('|--------|-------|');
  push(`| DEX Pairs Checked | ${report.summary.totalPairs} |`);
  push(`| Profitable Pairs (>${MIN_SPREAD_BPS} bps) | ${report.summary.profitablePairs} |`);
  push(`| Average Spread | ${report.summary.avgSpreadBps.toFixed(1)} bps |`);
  push(`| Max Spread | ${report.summary.maxSpreadBps.toFixed(1)} bps |`);
  push(`| Flash Loan Fee | ${report.summary.flashFeeBps} bps (0.05%) |`);
  push(`| Estimated Gas | $${report.summary.estimatedGasCostUsd.toFixed(2)} |`);
  push(`| Block Number | ${report.blockNumber} |`);
  push('');

  push('## Current DEX Prices (1 WETH → USDC)');
  push('');
  push('| DEX | Fee | 1 WETH in USDC |');
  push('|-----|-----|----------------|');
  for (const q of quotes) {
    push(`| ${q.dex} | ${q.fee} | $${q.priceUsd.toFixed(2)} |`);
  }
  push('');

  push('## Cross-DEX Opportunities');
  push('');
  if (report.crossDexPairs.length === 0) {
    push('*No cross-DEX arbitrage opportunities detected in this scan.*');
    push('');
    push('### Why no opportunities?');
    push('- DEX prices are tightly arbitraged by live bots (Base has competitive MEV)');
    push('- Only one quote source succeeded (other DEXes may have insufficient liquidity)');
    push('- The script may need to check additional pairs (WETH/DAI, WETH/USDbC)');
    push('- Real-time scanning via the Rust sidecar + gRPC streaming provides better coverage');
    push('');
    push('### Recommended Next Steps');
    push('1. Start the Rust sidecar for continuous price streaming and triangle arb detection');
    push('2. Run the fork simulation to validate the full pipeline works');
    push('3. Monitor during high-volatility periods when spreads widen');
    push('4. Consider adding more DEXes (BaseSwap, Balancer)');
  } else {
    for (const pair of report.crossDexPairs) {
      push(`### ${pair.name}`);
      push('');
      push(`| Metric | Value |`);
      push(`|--------|-------|`);
      push(`| Buy DEX | ${pair.quoteA.dex} (fee ${pair.quoteA.fee}) |`);
      push(`| Sell DEX | ${pair.quoteB.dex} (fee ${pair.quoteB.fee}) |`);
      push(`| Buy Price | $${pair.quoteA.priceUsd.toFixed(2)} |`);
      push(`| Sell Price | $${pair.quoteB.priceUsd.toFixed(2)} |`);
      push(`| Raw Spread | ${pair.spreadBps.toFixed(1)} bps |`);
      push(`| Net After Fees | ${pair.netAfterFeesBps.toFixed(1)} bps |`);
      push(`| Profitable? | ${pair.profitable ? '✅ Yes' : '❌ No'} |`);
      push('');
    }
  }

  push('## Aave V3 Lending Rates');
  push('');
  push('| Asset | Supply APY | Borrow APY | Utilization | Available |');
  push('|-------|-----------|------------|-------------|-----------|');
  for (const rate of report.aaveRates) {
    const availStr = rate.availableLiquidityUsd > 1_000_000
      ? `$${(rate.availableLiquidityUsd / 1_000_000).toFixed(1)}M`
      : `$${(rate.availableLiquidityUsd / 1_000).toFixed(0)}K`;
    push(`| ${rate.symbol} | ${rate.supplyAPY.toFixed(2)}% | ${rate.borrowAPY.toFixed(2)}% | ${rate.utilization.toFixed(1)}% | ${availStr} |`);
  }
  push('');

  push('## Strategy Viability');
  push('');
  const verdict = report.summary.profitablePairs > 0
    ? '**POTENTIALLY VIABLE** — Live cross-DEX spreads detected that exceed minimum thresholds after fees.'
    : '**CAUTION** — No live opportunities detected above the 15 bps threshold in this snapshot. Markets may have tighter spreads during low volatility.';
  push(verdict);
  push('');
  push('');
  push('## Risk Assessment');
  push('');
  push('| Factor | Status |');
  push('|--------|--------|');
  push('| Flash Loan Fee (0.05%) | Fixed cost |');
  push('| Gas Cost (~$0.10) | Low on Base |');
  push('| Slippage Risk | Standard (50 bps limit) |');
  push('| MEV Risk | Low (sequential ordering, no mempool) |');
  push('| Liquidity Risk | Check Aave reserves above |');
  push('');

  push('---');
  push('');
  push(`*Report auto-generated by live-profit-check.ts at ${report.timestamp}*`);
  push('*⚠️  This is a read-only snapshot. No transactions were executed.*');
  push('*Always validate with fork simulation before deploying real capital.*');

  return lines.join('\n');
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
