/**
 * Alchemy Integration Module
 *
 * Provides:
 * - Real-time block subscriptions (WebSocket)
 * - Token balance queries
 * - Transaction simulation (eth_simulateTransaction)
 * - Gas estimation with Base-specific tuning
 * - Enhanced event logging
 * - Mempool monitoring for MEV awareness
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface AlchemyConfig {
  apiKey: string;
  network: "base" | "base-sepolia";
}

interface BlockEvent {
  blockNumber: number;
  timestamp: number;
  gasUsed: bigint;
  baseFeePerGas: bigint;
  transactionCount: number;
}

interface TokenBalance {
  token: string;
  symbol: string;
  balance: bigint;
  balanceUSD: number;
  decimals: number;
}

interface SimulationResult {
  success: boolean;
  gasUsed: number;
  returnData: string;
  logs: ethers.Log[];
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Alchemy Provider Factory
// ═══════════════════════════════════════════════════════════════

export function createAlchemyProvider(
  network: "base" | "base-sepolia" = "base"
): ethers.JsonRpcProvider {
  const apiKey = process.env.ALCHEMY_API_KEY;

  if (apiKey) {
    const subdomain = network === "base" ? "base-mainnet" : "base-sepolia";
    const url = `https://${subdomain}.g.alchemy.com/v2/${apiKey}`;
    return new ethers.JsonRpcProvider(url, network === "base" ? 8453 : 84532, {
      staticNetwork: true,
      batchStallTime: 50,
    });
  }

  // Fallback to public RPC
  const url = network === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org";
  return new ethers.JsonRpcProvider(url, network === "base" ? 8453 : 84532, {
    staticNetwork: true,
  });
}

export function createAlchemyWebSocket(
  network: "base" | "base-sepolia" = "base"
): ethers.WebSocketProvider | null {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  ALCHEMY_API_KEY not set — WebSocket features disabled");
    return null;
  }

  const subdomain = network === "base" ? "base-mainnet" : "base-sepolia";
  const url = `wss://${subdomain}.g.alchemy.com/v2/${apiKey}`;

  try {
    return new ethers.WebSocketProvider(url);
  } catch {
    console.warn("⚠️  Failed to create Alchemy WebSocket provider");
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Alchemy Helper Class
// ═══════════════════════════════════════════════════════════════

export class AlchemyBase {
  private provider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider | null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(network: "base" | "base-sepolia" = "base") {
    this.provider = createAlchemyProvider(network);
    this.wsProvider = createAlchemyWebSocket(network);
  }

  // ───────────────────────────────────────────────────────
  // Block Subscriptions
  // ───────────────────────────────────────────────────────

  async subscribeToBlocks(callback: (event: BlockEvent) => void): Promise<void> {
    if (!this.wsProvider) {
      console.warn("⚠️  WebSocket not available — polling blocks instead");
      let lastBlock = await this.provider.getBlockNumber();

      this.pollingInterval = setInterval(async () => {
        try {
          const current = await this.provider.getBlockNumber();
          if (current > lastBlock) {
            const block = await this.provider.getBlock(current);
            if (block) {
              callback({
                blockNumber: block.number,
                timestamp: block.timestamp,
                gasUsed: block.gasUsed,
                baseFeePerGas: block.baseFeePerGas || 0n,
                transactionCount: block.transactions.length,
              });
            }
            lastBlock = current;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Block polling error:", message);
        }
      }, 2000); // Poll every 2s
      return;
    }

    this.wsProvider.on("block", async (blockNumber: number) => {
      try {
        const block = await this.provider.getBlock(blockNumber);
        if (block) {
          callback({
            blockNumber: block.number,
            timestamp: block.timestamp,
            gasUsed: block.gasUsed,
            baseFeePerGas: block.baseFeePerGas || 0n,
            transactionCount: block.transactions.length,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Block subscription error:", message);
      }
    });
  }

  // ───────────────────────────────────────────────────────
  // Token Balances
  // ───────────────────────────────────────────────────────

  async getTokenBalances(
    walletAddress: string,
    tokens: Array<{ address: string; symbol: string; decimals: number }>
  ): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];

    for (const token of tokens) {
      try {
        const contract = new ethers.Contract(
          token.address,
          ["function balanceOf(address) view returns (uint256)"],
          this.provider
        );

        const balance = await contract.balanceOf(walletAddress);

        balances.push({
          token: token.address,
          symbol: token.symbol,
          balance,
          balanceUSD: 0, // Would need price oracle
          decimals: token.decimals,
        });
      } catch {
        balances.push({
          token: token.address,
          symbol: token.symbol,
          balance: 0n,
          balanceUSD: 0,
          decimals: token.decimals,
        });
      }
    }

    return balances;
  }

  // ───────────────────────────────────────────────────────
  // Gas Estimation (Base-specific)
  // ───────────────────────────────────────────────────────

  async estimateGas(tx: ethers.TransactionRequest): Promise<{
    gasLimit: bigint;
    gasCostETH: number;
    gasCostUSD: number;
    baseFee: bigint;
    priorityFee: bigint;
  }> {
    const [gasLimit, feeData] = await Promise.all([
      this.provider.estimateGas(tx),
      this.provider.getFeeData(),
    ]);

    const baseFee = feeData.gasPrice || 1000000n;
    const priorityFee = feeData.maxPriorityFeePerGas || 100000n;
    const gasCostWei = gasLimit * (baseFee + priorityFee);
    const gasCostETH = Number(ethers.formatEther(gasCostWei));

    return {
      gasLimit,
      gasCostETH,
      gasCostUSD: gasCostETH * 2500, // Approximate
      baseFee,
      priorityFee,
    };
  }

  // ───────────────────────────────────────────────────────
  // Transaction Simulation (Alchemy)
  // ───────────────────────────────────────────────────────

  async simulateTransaction(tx: {
    from: string;
    to: string;
    data: string;
    value?: bigint;
  }): Promise<SimulationResult> {
    try {
      // Use Alchemy's eth_simulateTransaction if available
      const result = await this.provider.send("eth_simulateTransaction", [
        {
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value ? ethers.hexlify(tx.value) : "0x0",
        },
        "latest",
      ]);

      return {
        success: true,
        gasUsed: parseInt(result.gasUsed || "0", 16),
        returnData: result.returnData || "0x",
        logs: [],
      };
    } catch (err) {
      // Fallback to eth_call (view-only simulation)
      try {
        const result = await this.provider.call({
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value || 0n,
        });

        return {
          success: true,
          gasUsed: 0,
          returnData: result,
          logs: [],
        };
      } catch (callErr) {
        return {
          success: false,
          gasUsed: 0,
          returnData: "0x",
          logs: [],
          error: (callErr as Error).message,
        };
      }
    }
  }

  // ───────────────────────────────────────────────────────
  // Mempool Monitoring (Pending Transactions)
  // ───────────────────────────────────────────────────────

  async subscribePendingTransactions(
    callback: (txHash: string) => void
  ): Promise<void> {
    if (!this.wsProvider) {
      console.warn("⚠️  WebSocket not available for mempool monitoring");
      return;
    }

    // Alchemy pending transaction subscription
    this.wsProvider.on("pending", (txHash: string) => {
      callback(txHash);
    });
  }

  // ───────────────────────────────────────────────────────
  // Cleanup
  // ───────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.wsProvider) {
      await this.wsProvider.destroy();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Base Token List (for balance queries)
// ═══════════════════════════════════════════════════════════════

export const BASE_TOKENS = [
  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18 },
  { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC", decimals: 6 },
  { address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", symbol: "weETH", decimals: 18 },
  { address: "0xB6fe221Fe9EeF5aBa2fA62aB649aA5cBB5c67b60", symbol: "rETH", decimals: 18 },
];
