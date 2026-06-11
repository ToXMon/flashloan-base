/**
 * Base Memecoin Hunter
 *
 * Detects, scores, and monitors new memecoins on Base chain:
 * - New token deployment monitoring (pending txs via Alchemy)
 * - Honeypot/rug-pull detection via contract analysis
 * - Holder distribution scoring
 * - Liquidity depth analysis
 * - Momentum/volume tracking via DEXScreener API
 * - Safety scoring system (0-100)
 *
 * Designed for Base chain's memecoin ecosystem (BRETT, TOSHI, DEGEN, etc.)
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface MemecoinCandidate {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  pairAddress: string | null;
  pairDex: string;
  createdAt: number;
  creatorAddress: string;
  txHash: string;

  // Scoring
  safetyScore: number;         // 0-100 (100 = safest)
  liquidityScore: number;      // 0-100
  holderScore: number;         // 0-100
  momentumScore: number;       // 0-100
  overallScore: number;        // 0-100 weighted

  // Metrics
  liquidityUSD: number;
  volume24h: number;
  priceChange1h: number;
  priceChange24h: number;
  holderCount: number;
  topHolderPercent: number;    // % held by top 10 holders
  buyCount24h: number;
  sellCount24h: number;

  // Flags
  flags: SafetyFlag[];
  recommendation: "BUY" | "WATCH" | "AVOID" | "RUG";
}

interface SafetyFlag {
  type: "CRITICAL" | "WARNING" | "INFO";
  label: string;
  detail: string;
}

interface DEXScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns: { m5: { buys: number; sells: number }; h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  volume: { m5: number; h1: number; h24: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  pairCreatedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// Contract Analysis Patterns (Honeypot Detection)
// ═══════════════════════════════════════════════════════════════

const SUSPICIOUS_FUNCTION_SIGNATURES = [
  "0x42966c68",   // burn(address,uint256) — can burn others' tokens
  "0x9dc29fac",   // burnFrom(address,uint256)
  "0xa9059cbb",   // transfer(address,uint256) — check for hooks
  "0x23b872dd",   // transferFrom(address,address,uint256)
  "0x40c10f19",   // mint(address,uint256) — inflationary
  "0xa0712d68",   // mint(uint256) — owner can mint
  "0x715018a6",   // renounceOwnership
  "0xf2fde38b",   // transferOwnership
  "0x8da5cb5b",   // owner()
];

const RED_FLAG_BYTECODE_PATTERNS = [
  // Blacklist mapping patterns
  { pattern: "blacklist", weight: -25 },
  { pattern: "blackList", weight: -25 },
  { pattern: "_isBlacklisted", weight: -25 },
  // Fee manipulation
  { pattern: "setFee", weight: -10 },
  { pattern: "swapFee", weight: -10 },
  { pattern: "tradingFee", weight: -10 },
  // Trading pauses
  { pattern: "tradingOpen", weight: -15 },
  { pattern: "launch", weight: -15 },
  { pattern: "enableTrading", weight: -15 },
  // Tax tokens
  { pattern: "_tax", weight: -5 },
  { pattern: "sellFee", weight: -15 },
  { pattern: "buyFee", weight: -15 },
];

// ═══════════════════════════════════════════════════════════════
// Known Safe Tokens (whitelist)
// ═══════════════════════════════════════════════════════════════

const SAFE_TOKENS = new Set([
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
  "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
  "0xB6fe221Fe9EeF5aBa2fA62aB649aA5cBB5c67b60", // rETH
]);

// ═══════════════════════════════════════════════════════════════
// Memecoin Hunter Class
// ═══════════════════════════════════════════════════════════════

export class BaseMemecoinHunter {
  private provider: ethers.JsonRpcProvider;
  private dexScreenerBase = "https://api.dexscreener.com";

  constructor(rpcUrl?: string) {
    const url = rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org";
    this.provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true });
  }

  // ───────────────────────────────────────────────────────
  // Analyze a token (full pipeline)
  // ───────────────────────────────────────────────────────

  async analyzeToken(tokenAddress: string): Promise<MemecoinCandidate> {
    const flags: SafetyFlag[] = [];

    // 1. Basic token info
    const tokenInfo = await this.getTokenInfo(tokenAddress);

    // 2. Contract safety analysis
    const contractSafety = await this.analyzeContractSafety(tokenAddress);
    flags.push(...contractSafety.flags);

    // 3. DEX data (DEXScreener)
    const dexData = await this.getDEXData(tokenAddress);

    // 4. Holder analysis
    const holderAnalysis = await this.analyzeHolders(tokenAddress);

    // 5. Calculate scores
    const safetyScore = this.calculateSafetyScore(contractSafety, flags);
    const liquidityScore = this.calculateLiquidityScore(dexData);
    const holderScore = this.calculateHolderScore(holderAnalysis);
    const momentumScore = this.calculateMomentumScore(dexData);
    const overallScore = Math.round(
      safetyScore * 0.35 + liquidityScore * 0.25 + holderScore * 0.2 + momentumScore * 0.2
    );

    // 6. Determine recommendation
    const recommendation = this.getRecommendation(overallScore, flags);

    return {
      address: tokenAddress,
      ...tokenInfo,
      pairAddress: dexData?.pairAddress || null,
      pairDex: dexData?.dexId || "unknown",
      createdAt: dexData?.pairCreatedAt || 0,
      creatorAddress: "unknown",
      txHash: "",
      safetyScore,
      liquidityScore,
      holderScore,
      momentumScore,
      overallScore,
      liquidityUSD: dexData?.liquidity?.usd || 0,
      volume24h: dexData?.volume?.h24 || 0,
      priceChange1h: this.calcPriceChange1h(dexData),
      priceChange24h: 0,
      holderCount: holderAnalysis.holderCount,
      topHolderPercent: holderAnalysis.topHolderPercent,
      buyCount24h: dexData?.txns?.h24?.buys || 0,
      sellCount24h: dexData?.txns?.h24?.sells || 0,
      flags,
      recommendation,
    };
  }

  // ───────────────────────────────────────────────────────
  // Token Info
  // ───────────────────────────────────────────────────────

  private async getTokenInfo(address: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: bigint;
  }> {
    const contract = new ethers.Contract(
      address,
      [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function totalSupply() view returns (uint256)",
      ],
      this.provider
    );

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name().catch(() => "Unknown"),
      contract.symbol().catch(() => "???"),
      contract.decimals().catch(() => 18),
      contract.totalSupply().catch(() => 0n),
    ]);

    return { name, symbol, decimals, totalSupply };
  }

  // ───────────────────────────────────────────────────────
  // Contract Safety Analysis
  // ───────────────────────────────────────────────────────

  private async analyzeContractSafety(
    tokenAddress: string
  ): Promise<{ score: number; flags: SafetyFlag[] }> {
    const flags: SafetyFlag[] = [];
    let score = 100;

    // Whitelist check
    if (SAFE_TOKENS.has(tokenAddress.toLowerCase())) {
      return { score: 100, flags: [{ type: "INFO", label: "Whitelisted", detail: "Known safe token" }] };
    }

    try {
      const code = await this.provider.getCode(tokenAddress);

      // Check bytecode for red flags
      const bytecode = ethers.hexlify(code).toLowerCase();

      for (const pattern of RED_FLAG_BYTECODE_PATTERNS) {
        if (bytecode.includes(pattern.pattern.toLowerCase())) {
          score += pattern.weight;
          flags.push({
            type: pattern.weight <= -20 ? "CRITICAL" : "WARNING",
            label: pattern.pattern,
            detail: `Suspicious pattern found in bytecode: ${pattern.pattern}`,
          });
        }
      }

      // Check for proxy (upgradeable = risk)
      if (bytecode.includes("e5cfe957") || bytecode.includes("3659cfe6")) {
        // UPGRADE_INTERFACE or _setImplementation
        score -= 20;
        flags.push({
          type: "WARNING",
          label: "Proxy Contract",
          detail: "Token uses upgradeable proxy — owner can change logic",
        });
      }

      // Check if contract can pause transfers
      if (bytecode.includes("paused") || bytecode.includes("whennotpaused")) {
        score -= 15;
        flags.push({
          type: "WARNING",
          label: "Pausable",
          detail: "Token transfers can be paused",
        });
      }

      // Check for max transaction limits
      if (bytecode.includes("_maxtx") || bytecode.includes("maxtransaction")) {
        flags.push({
          type: "INFO",
          label: "TX Limit",
          detail: "Token has max transaction amount limits",
        });
        score -= 5;
      }
    } catch {
      flags.push({
        type: "WARNING",
        label: "No Bytecode",
        detail: "Could not read contract bytecode",
      });
      score -= 10;
    }

    return { score: Math.max(0, Math.min(100, score)), flags };
  }

  // ───────────────────────────────────────────────────────
  // DEX Data (DEXScreener API)
  // ───────────────────────────────────────────────────────

  private async getDEXData(tokenAddress: string): Promise<DEXScreenerPair | null> {
    try {
      const url = `${this.dexScreenerBase}/latest/dex/tokens/${tokenAddress}`;
      const response = await fetch(url);

      if (!response.ok) return null;

      const data = await response.json() as { pairs: DEXScreenerPair[] };
      if (!data.pairs || data.pairs.length === 0) return null;

      // Filter for Base chain pairs, sort by liquidity
      const basePairs = data.pairs
        .filter((p) => p.chainId === "base")
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

      return basePairs[0] || null;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────
  // Holder Analysis
  // ───────────────────────────────────────────────────────

  private async analyzeHolders(tokenAddress: string): Promise<{
    holderCount: number;
    topHolderPercent: number;
  }> {
    // In production, use Alchemy's getAssetTransfers or a holder API
    // For now, return defaults
    return {
      holderCount: 0,
      topHolderPercent: 0,
    };
  }

  // ───────────────────────────────────────────────────────
  // Score Calculations
  // ───────────────────────────────────────────────────────

  private calculateSafetyScore(
    contractAnalysis: { score: number; flags: SafetyFlag[] },
    flags: SafetyFlag[]
  ): number {
    let score = contractAnalysis.score;

    // Critical flags are dealbreakers
    const criticalCount = flags.filter((f) => f.type === "CRITICAL").length;
    if (criticalCount >= 2) score = Math.min(score, 10);
    if (criticalCount >= 3) score = Math.min(score, 5);

    return Math.max(0, Math.min(100, score));
  }

  private calculateLiquidityScore(dexData: DEXScreenerPair | null): number {
    if (!dexData) return 0;

    const liq = dexData.liquidity?.usd || 0;
    if (liq >= 1000000) return 100;    // $1M+ = excellent
    if (liq >= 500000) return 80;
    if (liq >= 100000) return 60;      // $100K = decent
    if (liq >= 50000) return 40;
    if (liq >= 10000) return 20;       // $10K = risky
    return 5;                           // Nearly no liquidity
  }

  private calculateHolderScore(holderData: {
    holderCount: number;
    topHolderPercent: number;
  }): number {
    let score = 50;

    // More holders = better distribution
    if (holderData.holderCount >= 10000) score += 30;
    else if (holderData.holderCount >= 5000) score += 20;
    else if (holderData.holderCount >= 1000) score += 10;
    else if (holderData.holderCount >= 500) score += 5;

    // Top holder concentration
    if (holderData.topHolderPercent > 50) score -= 30;
    else if (holderData.topHolderPercent > 30) score -= 15;
    else if (holderData.topHolderPercent > 20) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  private calculateMomentumScore(dexData: DEXScreenerPair | null): number {
    if (!dexData) return 0;

    let score = 30; // baseline

    // Volume trend
    const vol24h = dexData.volume?.h24 || 0;
    if (vol24h >= 1000000) score += 40;
    else if (vol24h >= 500000) score += 30;
    else if (vol24h >= 100000) score += 20;
    else if (vol24h >= 50000) score += 10;

    // Buy/sell ratio
    const buys = dexData.txns?.h24?.buys || 0;
    const sells = dexData.txns?.h24?.sells || 0;
    if (buys > 0 && sells > 0) {
      const ratio = buys / sells;
      if (ratio > 2) score += 15;      // Heavy buying
      else if (ratio > 1.2) score += 10; // Moderate buying
      else if (ratio < 0.8) score -= 10; // More selling
    }

    return Math.max(0, Math.min(100, score));
  }

  private calcPriceChange1h(dexData: DEXScreenerPair | null): number {
    if (!dexData) return 0;
    // DEXScreener doesn't always provide price change directly
    // In production, track prices over time
    return 0;
  }

  private getRecommendation(
    overallScore: number,
    flags: SafetyFlag[]
  ): "BUY" | "WATCH" | "AVOID" | "RUG" {
    const criticalFlags = flags.filter((f) => f.type === "CRITICAL");

    if (criticalFlags.length >= 3) return "RUG";
    if (criticalFlags.length >= 1) return "AVOID";
    if (overallScore >= 75) return "BUY";
    if (overallScore >= 50) return "WATCH";
    if (overallScore >= 30) return "AVOID";
    return "RUG";
  }

  // ───────────────────────────────────────────────────────
  // Trending Tokens Scanner (DEXScreener)
  // ───────────────────────────────────────────────────────

  async scanTrendingTokens(): Promise<MemecoinCandidate[]> {
    console.log("\n🐸 Scanning Base for trending memecoins...");

    try {
      // DEXScreener: search for trending Base tokens
      const url = `${this.dexScreenerBase}/latest/dex/search?q=trending%20base`;
      const response = await fetch(url);

      if (!response.ok) {
        console.log("   ⚠️  DEXScreener API unavailable");
        return [];
      }

      const data = await response.json() as { pairs: DEXScreenerPair[] };

      const basePairs = (data.pairs || [])
        .filter((p) => p.chainId === "base")
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .slice(0, 10); // Top 10 by volume

      const candidates: MemecoinCandidate[] = [];

      for (const pair of basePairs) {
        try {
          const candidate = await this.analyzeToken(pair.baseToken.address);
          candidates.push(candidate);
        } catch {
          // Skip tokens that fail analysis
        }
      }

      this.printMemecoinReport(candidates);
      return candidates.sort((a, b) => b.overallScore - a.overallScore);
    } catch (err) {
      console.error("Memecoin scan error:", (err as Error).message);
      return [];
    }
  }

  // ───────────────────────────────────────────────────────
  // New Token Deployment Monitor (Alchemy WebSocket)
  // ───────────────────────────────────────────────────────

  async startDeploymentMonitor(): Promise<void> {
    console.log("🐸 Starting memecoin deployment monitor...");
    console.log("   Watching for new token deployments on Base\n");

    // In production, subscribe to Alchemy WebSocket for pending transactions
    // that interact with token factory contracts or Uniswap/Aerodrome routers

    // Alchemy method: alchemy_pendingTransactions
    // Filter: to = Aerodrome Factory || Uniswap V3 Factory
    //         && input starts with createPair/createPool signature

    const factoryAddresses = [
      "0x420dD381B31AEf6683DB6b902084cB0ffEcFc40e", // Aerodrome Factory
    ];

    console.log("   Monitoring factories:", factoryAddresses.join(", "));
    console.log("   (Requires Alchemy WebSocket for real-time monitoring)");
  }

  // ───────────────────────────────────────────────────────
  // Output
  // ───────────────────────────────────────────────────────

  private printMemecoinReport(candidates: MemecoinCandidate[]): void {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║              🐸 BASE MEMECOIN HUNTER REPORT                ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    for (const c of candidates) {
      const recEmoji = c.recommendation === "BUY" ? "🟢" :
                       c.recommendation === "WATCH" ? "🟡" :
                       c.recommendation === "AVOID" ? "🔴" : "💀";

      console.log(`\n  ${recEmoji} ${c.symbol} (${c.name})`);
      console.log(`     Address: ${c.address}`);
      console.log(`     Score: ${c.overallScore}/100 | Safety: ${c.safetyScore} | Liquidity: ${c.liquidityScore} | Momentum: ${c.momentumScore}`);
      console.log(`     Liquidity: $${(c.liquidityUSD || 0).toLocaleString()} | 24h Vol: $${(c.volume24h || 0).toLocaleString()}`);
      console.log(`     24h Buys/Sells: ${c.buyCount24h}/${c.sellCount24h}`);
      console.log(`     Recommendation: ${c.recommendation}`);

      if (c.flags.length > 0) {
        console.log(`     Flags:`);
        for (const flag of c.flags) {
          const flagEmoji = flag.type === "CRITICAL" ? "🚨" : flag.type === "WARNING" ? "⚠️" : "ℹ️";
          console.log(`       ${flagEmoji} [${flag.type}] ${flag.label}: ${flag.detail}`);
        }
      }
    }

    console.log("\n  ────────────────────────────────────────────────────────────\n");
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════════════

async function main() {
  const hunter = new BaseMemecoinHunter();
  const mode = process.argv[2] || "trending";

  if (mode === "analyze") {
    const tokenAddress = process.argv[3];
    if (!tokenAddress) {
      console.error("Usage: npx ts-node memecoin-hunter.ts analyze <tokenAddress>");
      process.exit(1);
    }
    const result = await hunter.analyzeToken(tokenAddress);
    console.log(JSON.stringify(result, (key, value) =>
      typeof value === "bigint" ? value.toString() : value, 2));
  } else {
    await hunter.scanTrendingTokens();
  }
}

main().catch(console.error);
