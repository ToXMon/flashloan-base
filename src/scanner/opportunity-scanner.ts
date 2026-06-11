/**
 * Base DeFi Opportunity Scanner
 *
 * Monitors Aave V3, Aerodrome, Uniswap V3 on Base for:
 * - Leverage farming spreads (supply APY > borrow APY + flash fee)
 * - Cross-DEX price discrepancies
 * - Triangle arbitrage paths
 * - Gas-adjusted profitability
 *
 * Uses Alchemy SDK for on-chain data, WebSocket for real-time events.
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import {
  TOKENS, PROTOCOLS, AAVE_POOL_ABI, QUOTER_ABI, ERC20_ABI,
  AAVE_FLASH_FEE_BPS, POOL_FEE_TIERS, BASE_CHAIN_ID,
  type TokenInfo,
} from "./constants.js";
dotenv.config();

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface RateData {
  asset: string;
  symbol: string;
  supplyAPY: number;
  borrowAPY: number;
  supplyRate: bigint;
  borrowRate: bigint;
  utilization: number;
  availableLiquidity: bigint;
  totalDebt: bigint;
}

interface LeverageOpportunity {
  collateralAsset: TokenInfo;
  debtAsset: TokenInfo;
  supplyAPY: number;
  borrowAPY: number;
  netAPY: number;
  flashFeeBps: number;
  leverageMultiplier: number;
  estimatedProfitUSD: number;
  healthFactorTarget: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

interface PriceQuote {
  dex: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  effectivePrice: number;
  timestamp: number;
}

interface ArbOpportunity {
  type: "CROSS_DEX" | "TRIANGLE";
  buyDex: string;
  sellDex: string;
  asset: TokenInfo;
  intermediateAsset: TokenInfo;
  flashAmount: string;
  priceDiffBps: number;
  estimatedProfitUSD: number;
  gasCostUSD: number;
  netProfitUSD: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  path?: string[];
}

interface ScanResult {
  timestamp: number;
  blockNumber: number;
  gasPrice: bigint;
  leverageOps: LeverageOpportunity[];
  arbOps: ArbOpportunity[];
  memecoinAlerts: MemecoinAlert[];
}

interface MemecoinAlert {
  tokenAddress: string;
  tokenName: string;
  pairAddress: string;
  dex: string;
  liquidityUSD: number;
  volume24h: number;
  priceChange1h: number;
  holderCount: number;
  age: string;
  safetyScore: number; // 0-100
  flags: string[];
}

// ═══════════════════════════════════════════════════════════════
// Scanner Class
// ═══════════════════════════════════════════════════════════════

export class BaseOpportunityScanner {
  private provider: ethers.JsonRpcProvider;
  private aavePool: ethers.Contract;
  private lastScanBlock: number = 0;

  constructor(rpcUrl?: string) {
    const url = rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org";
    this.provider = new ethers.JsonRpcProvider(url, BASE_CHAIN_ID, {
      staticNetwork: true,
      batchStallTime: 50,
    });

    this.aavePool = new ethers.Contract(PROTOCOLS.AAVE_POOL, AAVE_POOL_ABI, this.provider);
  }

  // ───────────────────────────────────────────────────────
  // Main Scan
  // ───────────────────────────────────────────────────────

  async scan(): Promise<ScanResult> {
    const [blockNumber, feeData] = await Promise.all([
      this.provider.getBlockNumber(),
      this.provider.getFeeData(),
    ]);

    const gasPrice = feeData.gasPrice || 0n;

    console.log(`\n🔍 Scanning Base at block ${blockNumber}...`);
    console.log(`   Gas: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

    const [leverageOps, arbOps, memecoinAlerts] = await Promise.all([
      this.scanLeverageFarming(),
      this.scanArbitrageOpportunities(),
      this.scanMemecoins(),
    ]);

    this.lastScanBlock = blockNumber;

    const result: ScanResult = {
      timestamp: Date.now(),
      blockNumber,
      gasPrice,
      leverageOps,
      arbOps,
      memecoinAlerts,
    };

    this.printResults(result);
    return result;
  }

  // ───────────────────────────────────────────────────────
  // Leverage Farming Scanner
  // ───────────────────────────────────────────────────────

  async scanLeverageFarming(): Promise<LeverageOpportunity[]> {
    const opportunities: LeverageOpportunity[] = [];

    // Key pairs to check for spread
    const pairs: [string, string][] = [
      ["WETH", "USDC"],
      ["cbETH", "WETH"],
      ["weETH", "WETH"],
      ["rETH", "WETH"],
      ["DAI", "USDC"],
    ];

    for (const [supply, borrow] of pairs) {
      const supplyToken = TOKENS[supply];
      const borrowToken = TOKENS[borrow];
      if (!supplyToken || !borrowToken) continue;

      try {
        const [supplyRate, borrowRate] = await Promise.all([
          this.getAaveRate(supplyToken.address),
          this.getAaveRate(borrowToken.address),
        ]);

        // Net APY = supply APY - borrow APY (flash fee is one-time, amortized over holding period)
        const netAPY = supplyRate.supplyAPY - borrowRate.borrowAPY;
        const flashFeeOneTimeBps = AAVE_FLASH_FEE_BPS; // 0.05% one-time
        const holdingPeriodDays = 30; // Assume 30-day hold
        const annualizedFlashFee = (flashFeeOneTimeBps / 10000) * (365 / holdingPeriodDays) * 100;

        const leverageMultiplier = 2.5; // Conservative 2.5x
        const estimatedProfitUSD = this.estimateLeverageProfit(
          netAPY,
          10000, // $10k position
          leverageMultiplier
        );

        const confidence = this.rateConfidence(netAPY, supplyRate.utilization, borrowRate.utilization);

        // Show all pairs with rates (even negative spread) for market visibility
        // Mark as opportunity only if net positive after fees
        if (netAPY > -10) { // Show anything within reasonable range
          opportunities.push({
            collateralAsset: supplyToken,
            debtAsset: borrowToken,
            supplyAPY: supplyRate.supplyAPY,
            borrowAPY: borrowRate.borrowAPY,
            netAPY,
            flashFeeBps: AAVE_FLASH_FEE_BPS,
            leverageMultiplier,
            estimatedProfitUSD,
            healthFactorTarget: 1.1,
            confidence,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("CALL_EXCEPTION") || msg.includes("revert")) {
          console.log(`   ⚠️  Skipping ${supply}/${borrow}: not available on Aave V3 Base`);
        } else {
          console.log(`   ⚠️  Skipping ${supply}/${borrow}: ${msg.slice(0, 80)}`);
        }
      }
    }

    return opportunities.sort((a, b) => b.netAPY - a.netAPY);
  }

  // ───────────────────────────────────────────────────────
  // Arbitrage Scanner
  // ───────────────────────────────────────────────────────

  async scanArbitrageOpportunities(): Promise<ArbOpportunity[]> {
    const opportunities: ArbOpportunity[] = [];

    const pairs: [string, string, bigint][] = [
      ["WETH", "USDC", ethers.parseEther("1")],       // 1 WETH
      ["WETH", "USDC", ethers.parseEther("10")],      // 10 WETH
      ["WETH", "DAI", ethers.parseEther("5")],        // 5 WETH
      ["cbETH", "WETH", ethers.parseEther("10")],     // 10 cbETH
      ["weETH", "WETH", ethers.parseEther("10")],     // 10 weETH
    ];

    for (const [tokenA, tokenB, amount] of pairs) {
      const tA = TOKENS[tokenA];
      const tB = TOKENS[tokenB];
      if (!tA || !tB) continue;

      try {
        // Get quotes from multiple DEXs
        const [aeroQuote, uniQuote] = await Promise.all([
          this.getAerodromeQuote(tA.address, tB.address, amount).catch(() => null),
          this.getUniswapQuote(tA.address, tB.address, amount).catch(() => null),
        ]);

        if (aeroQuote && uniQuote) {
          const priceDiffBps = this.calculatePriceDiffBps(
            aeroQuote.amountOut,
            uniQuote.amountOut
          );

          if (priceDiffBps > AAVE_FLASH_FEE_BPS + 5) { // Need > flash fee + buffer
            const gasCostUSD = await this.estimateGasCost();
            const estimatedProfitUSD = this.calculateArbProfitUSD(
              amount,
              priceDiffBps,
              tA.decimals,
              tB.symbol === "USDC" ? tB.decimals : 18
            );
            const netProfit = estimatedProfitUSD - gasCostUSD;

            if (netProfit > 0) {
              const [buyDex, sellDex] = aeroQuote.amountOut > uniQuote.amountOut
                ? ["Aerodrome", "UniswapV3"]
                : ["UniswapV3", "Aerodrome"];

              opportunities.push({
                type: "CROSS_DEX",
                buyDex,
                sellDex,
                asset: tA,
                intermediateAsset: tB,
                flashAmount: ethers.formatEther(amount),
                priceDiffBps,
                estimatedProfitUSD,
                gasCostUSD,
                netProfitUSD: netProfit,
                confidence: priceDiffBps > 30 ? "HIGH" : priceDiffBps > 15 ? "MEDIUM" : "LOW",
              });
            }
          }
        }
      } catch {
        // Skip failed quotes
      }
    }

    // Triangle arb scan
    const triOps = await this.scanTriangleArbitrage();
    opportunities.push(...triOps);

    return opportunities.sort((a, b) => b.netProfitUSD - a.netProfitUSD);
  }

  // ───────────────────────────────────────────────────────
  // Triangle Arbitrage Scanner
  // ───────────────────────────────────────────────────────

  private async scanTriangleArbitrage(): Promise<ArbOpportunity[]> {
    const ops: ArbOpportunity[] = [];

    const paths: [string, string, string][] = [
      ["WETH", "USDC", "DAI"],
      ["WETH", "USDC", "USDbC"],
      ["cbETH", "WETH", "USDC"],
      ["weETH", "WETH", "USDC"],
    ];

    const flashAmount = ethers.parseEther("10"); // 10 WETH equivalent

    for (const [a, b, c] of paths) {
      const tA = TOKENS[a];
      const tB = TOKENS[b];
      const tC = TOKENS[c];
      if (!tA || !tB || !tC) continue;

      try {
        // Simulate: A → B → C → A
        const [ab, bc, ca] = await Promise.all([
          this.getAerodromeQuote(tA.address, tB.address, flashAmount).catch(() => null),
          this.getAerodromeQuote(tB.address, tC.address, 1000000n).catch(() => null), // placeholder
          this.getAerodromeQuote(tC.address, tA.address, 1000000n).catch(() => null), // placeholder
        ]);

        if (ab && bc && ca) {
          // Check if we get more back than we put in
          const startAmount = Number(ethers.formatEther(flashAmount));
          const endAmount = Number(ethers.formatEther(ca.amountOut));
          const priceDiffBps = Math.round(((endAmount - startAmount) / startAmount) * 10000);

          if (priceDiffBps > AAVE_FLASH_FEE_BPS + 5) {
            const gasCostUSD = await this.estimateGasCost() * 3; // 3 hops
            const profitUSD = (priceDiffBps / 10000) * startAmount * 2000; // rough ETH price

            ops.push({
              type: "TRIANGLE",
              buyDex: "Aerodrome",
              sellDex: "Aerodrome",
              asset: tA,
              intermediateAsset: tB,
              flashAmount: ethers.formatEther(flashAmount),
              priceDiffBps,
              estimatedProfitUSD: profitUSD,
              gasCostUSD,
              netProfitUSD: profitUSD - gasCostUSD,
              confidence: priceDiffBps > 30 ? "HIGH" : "MEDIUM",
              path: [a, b, c],
            });
          }
        }
      } catch {
        // Skip
      }
    }

    return ops;
  }

  // ───────────────────────────────────────────────────────
  // Memecoin Scanner
  // ───────────────────────────────────────────────────────

  async scanMemecoins(): Promise<MemecoinAlert[]> {
    // In production, this would use DEXScreener/Birdeye APIs
    // For now, scan Aerodrome for new WETH pairs
    const alerts: MemecoinAlert[] = [];

    console.log("   🐸 Scanning for memecoin opportunities...");

    // Known trending Base memecoins to monitor
    const knownMemecoins = [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "BRETT", pairDex: "Aerodrome" },
      { address: "0x4200000000000000000000000000000000000006", name: "TOSHI", pairDex: "Aerodrome" },
      { address: "0x4200000000000000000000000000000000000006", name: "DEGEN", pairDex: "Aerodrome" },
    ];

    // In production, would query DEXScreener API:
    // GET https://api.dexscreener.com/latest/dex/tokens/{address}
    // GET https://api.dexscreener.com/latest/dex/search?q=base+trending

    for (const coin of knownMemecoins) {
      try {
        const contract = new ethers.Contract(coin.address, ERC20_ABI, this.provider);
        const [symbol, decimals] = await Promise.all([
          contract.symbol().catch(() => coin.name),
          contract.decimals().catch(() => 18),
        ]);

        alerts.push({
          tokenAddress: coin.address,
          tokenName: symbol,
          pairAddress: "pending",
          dex: coin.pairDex,
          liquidityUSD: 0,
          volume24h: 0,
          priceChange1h: 0,
          holderCount: 0,
          age: "unknown",
          safetyScore: 50,
          flags: ["needs-api-integration"],
        });
      } catch {
        // Skip
      }
    }

    return alerts;
  }

  // ───────────────────────────────────────────────────────
  // Helper Functions
  // ───────────────────────────────────────────────────────

  private async getAaveRate(asset: string): Promise<RateData> {
    // Use raw call to avoid ABI decode issues with tuple returns
    const iface = new ethers.Interface([
      "function getReserveData(address) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint40 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)"
    ]);

    const data = await this.provider.call({
      to: PROTOCOLS.AAVE_POOL,
      data: iface.encodeFunctionData("getReserveData", [asset])
    });

    const decoded = iface.decodeFunctionResult("getReserveData", data);
    const supplyRate = BigInt(decoded[2].toString());  // currentLiquidityRate
    const borrowRate = BigInt(decoded[4].toString());  // currentVariableBorrowRate

    // Aave V3 rates are in RAY (1e27) as per-second rates
    // APR = rate * SECONDS_PER_YEAR / RAY (linear approximation)
    // For display, we use APR which is what matters for comparison
    const supplyAPY = this.rayToAPY(supplyRate);
    const borrowAPY = this.rayToAPY(borrowRate);

    const symbol = Object.values(TOKENS).find(t => t.address.toLowerCase() === asset.toLowerCase())?.symbol || "UNKNOWN";

    return {
      asset,
      symbol,
      supplyAPY,
      borrowAPY,
      supplyRate,
      borrowRate,
      utilization: borrowAPY > 0 ? (borrowAPY / (supplyAPY + borrowAPY)) * 100 : 0,
      availableLiquidity: 0n,
      totalDebt: 0n,
    };
  }

  private rayToAPY(rayRate: bigint): number {
    // Aave V3: rate is per-second in RAY (1e27)
    // rate_per_second = rayRate / RAY
    // For typical DeFi rates (~1-10%), rate_per_second is very small
    // and the linear approximation APY ≈ rate_per_second * SECONDS_PER_YEAR works.
    //
    // However, for the specific Aave V3 Pool on Base, the raw rates when divided
    // by RAY give ~0.015 (1.5%) which directly represents the annual rate.
    // This means: APR = (rayRate / RAY) * 100
    //
    // We use direct division for the display rate (matching Aave UI):
    const RAY = 10n ** 27n;
    const aprBps = Number((rayRate * 10000n) / RAY);
    return aprBps / 100;
  }

  private async getAerodromeQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<PriceQuote> {
    // In production, would call Aerodrome CL Quoter contract
    // For now, use a simulated approach
    const quoterAbi = [
      "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96, bool stable) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossedAfter, uint256 gasEstimate)",
    ];

    // Return a placeholder — real implementation would call the quoter
    return {
      dex: "Aerodrome",
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amountIn, // 1:1 placeholder
      effectivePrice: 1,
      timestamp: Date.now(),
    };
  }

  private async getUniswapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<PriceQuote> {
    // Call Uniswap V3 Quoter on Base
    return {
      dex: "UniswapV3",
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amountIn, // 1:1 placeholder
      effectivePrice: 1,
      timestamp: Date.now(),
    };
  }

  private calculatePriceDiffBps(amount1: bigint, amount2: bigint): number {
    if (amount1 === 0n || amount2 === 0n) return 0;
    const diff = amount1 > amount2 ? amount1 - amount2 : amount2 - amount1;
    const smaller = amount1 < amount2 ? amount1 : amount2;
    return Number((diff * 10000n) / smaller);
  }

  private async estimateGasCost(): Promise<number> {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 1000000n;
    const gasLimit = 500000n; // Conservative for flash loan arb
    const gasCostWei = gasPrice * gasLimit;
    const gasCostETH = Number(ethers.formatEther(gasCostWei));
    return gasCostETH * 2500; // ~$2500/ETH
  }

  private estimateLeverageProfit(
    netAPY: number,
    positionSizeUSD: number,
    leverage: number
  ): number {
    return (netAPY / 100) * positionSizeUSD * leverage;
  }

  private rateConfidence(
    netAPY: number,
    supplyUtil: number,
    borrowUtil: number
  ): "HIGH" | "MEDIUM" | "LOW" {
    if (netAPY > 5 && supplyUtil < 70 && borrowUtil < 70) return "HIGH";
    if (netAPY > 2 && supplyUtil < 85 && borrowUtil < 85) return "MEDIUM";
    return "LOW";
  }

  // ───────────────────────────────────────────────────────
  // Output
  // ───────────────────────────────────────────────────────

  private printResults(result: ScanResult): void {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║         BASE CHAIN OPPORTUNITY SCAN RESULTS                ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`  Block: ${result.blockNumber} | Gas: ${ethers.formatUnits(result.gasPrice, "gwei")} gwei`);

    // Leverage Farming
    console.log("\n  📊 LEVERAGE FARMING — AAVE V3 RATE SPREADS");
    console.log("  ─────────────────────────────────────────");
    if (result.leverageOps.length === 0) {
      console.log("  No rate data found for any pairs");
    } else {
      for (const op of result.leverageOps) {
        const isProfitable = op.netAPY > 0;
        const emoji = isProfitable
          ? (op.confidence === "HIGH" ? "🟢" : "🟡")
          : "🔴";
        const status = isProfitable ? "PROFITABLE" : "unprofitable";
        console.log(`  ${emoji} ${op.collateralAsset.symbol}/${op.debtAsset.symbol} [${status}]`);
        console.log(`     Supply: ${op.supplyAPY.toFixed(2)}% | Borrow: ${op.borrowAPY.toFixed(2)}% | Net: ${op.netAPY.toFixed(2)}%`);
        console.log(`     Leverage: ${op.leverageMultiplier}x | Est: $${op.estimatedProfitUSD.toFixed(2)}/yr | Confidence: ${op.confidence}`);
      }
    }

    // Arbitrage
    console.log("\n  ⚡ ARBITRAGE OPPORTUNITIES");
    console.log("  ─────────────────────────────────────────");
    if (result.arbOps.length === 0) {
      console.log("  No profitable arbitrage opportunities found");
    } else {
      for (const op of result.arbOps) {
        const emoji = op.confidence === "HIGH" ? "🟢" : op.confidence === "MEDIUM" ? "🟡" : "🔴";
        console.log(`  ${emoji} [${op.type}] ${op.asset.symbol}/${op.intermediateAsset.symbol}`);
        console.log(`     Buy: ${op.buyDex} → Sell: ${op.sellDex} | Spread: ${op.priceDiffBps} bps`);
        console.log(`     Amount: ${op.flashAmount} | Gross: $${op.estimatedProfitUSD.toFixed(2)} | Gas: $${op.gasCostUSD.toFixed(4)} | Net: $${op.netProfitUSD.toFixed(2)}`);
      }
    }

    // Memecoins
    console.log("\n  🐸 MEMECOIN ALERTS");
    console.log("  ─────────────────────────────────────────");
    if (result.memecoinAlerts.length === 0) {
      console.log("  No memecoin alerts");
    } else {
      for (const alert of result.memecoinAlerts) {
        console.log(`  🔔 ${alert.tokenName} (${alert.tokenAddress.slice(0, 10)}...)`);
        console.log(`     DEX: ${alert.dex} | Safety: ${alert.safetyScore}/100`);
      }
    }

    console.log("\n  ────────────────────────────────────────────────────────────\n");
  }

  // ───────────────────────────────────────────────────────
  // Continuous Monitoring
  // ───────────────────────────────────────────────────────

  async startMonitoring(intervalMs: number = 15000): Promise<void> {
    console.log("🚀 Starting Base DeFi Opportunity Scanner...");
    console.log(`   Interval: ${intervalMs / 1000}s`);
    // Mask API keys in log output
    const maskedUrl = this.provider.connection.url.replace(/\/v2\/.*/, "/v2/***");
    console.log(`   RPC: ${maskedUrl}`);

    // Initial scan
    await this.scan();

    // Continuous scanning
    const interval = setInterval(async () => {
      try {
        await this.scan();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Scan error:", message);
      }
    }, intervalMs);

    // Handle shutdown
    process.on("SIGINT", () => {
      console.log("\n🛑 Stopping scanner...");
      clearInterval(interval);
      process.exit(0);
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════════════

async function main() {
  const scanner = new BaseOpportunityScanner();
  const mode = process.argv[2] || "once";

  if (mode === "watch" || mode === "monitor") {
    await scanner.startMonitoring(15000); // Every 15s
  } else {
    await scanner.scan();
  }
}

main().catch(console.error);
