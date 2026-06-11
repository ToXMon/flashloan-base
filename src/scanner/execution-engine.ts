/**
 * Execution Engine — Turns validated OpportunitySignals into on-chain flash loan
 * transactions on Base chain via PositionV2.sol.
 *
 * Flow: Signal → RiskManager validation → TX construction → Submit → Record
 *
 * Usage:
 *   const engine = new ExecutionEngine(config, riskManager);
 *   await engine.init();
 *   const result = await engine.executeSignal(signal);
 */

import { ethers, Contract, Wallet, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import type { RiskManager } from './risk-manager.js';
import type { OpportunitySignal } from './grpc-client.js';
import { Strategy, Dex } from './grpc-client.js';

// ─── Configuration ──────────────────────────────────────────────────

export interface ExecutionConfig {
  positionV2Address: string;
  baseRpcUrl: string;
  maxGasPriceGwei: number;
  confirmationBlocks: number;
  deadlineSeconds: number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  positionV2Address: '0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A',
  baseRpcUrl: '',
  maxGasPriceGwei: 1.0,
  confirmationBlocks: 1,
  deadlineSeconds: 30,
};

// ─── Trade Result ──────────────────────────────────────────────────

export interface TradeResult {
  success: boolean;
  signal_id: string;
  tx_hash?: string;
  profit_usd?: number;
  gas_cost_usd?: number;
  error?: string;
  execution_time_ms: number;
  block_number?: number;
}

// ─── Engine Status ─────────────────────────────────────────────────

export interface EngineStatus {
  initialized: boolean;
  connected: boolean;
  walletAddress: string;
  contractAddress: string;
  chainId: number;
  blockNumber: number;
  contractBalance: Record<string, string>;
}

// ─── PositionV2 ABI (execution functions only) ─────────────────────

const POSITION_V2_ABI = [
  'function executeTriangleArb(tuple(address flashAsset, uint256 flashAmount, address[3] path, address[3] routers, uint24[3] poolFees, uint256 minProfit, uint8[3] dexTypes) params) external',
  'function executeArbitrage(tuple(address flashAsset, uint256 flashAmount, address buyDexRouter, address sellDexRouter, address intermediateToken, uint24 buyPoolFee, uint24 sellPoolFee, uint256 minProfit, uint8 dexType) params) external',
  'function owner() external view returns (address)',
  'function paused() external view returns (bool)',
  'function getTokenBalance(address token) external view returns (uint256)',
  'event ArbitrageExecuted(uint8 indexed arbType, address indexed asset, uint256 amount, uint256 profit)',
];

// ─── DEX type mapping: gRPC Dex → contract uint8 ───────────────────
// Contract: 0=AeroCL, 1=UniV3, 2=AeroAMM
// gRPC:     AERODROME_CL=1, AERODROME_AMM=2, UNISWAP_V3=3

function grpcDexToContractType(dex: Dex): number {
  switch (dex) {
    case Dex.AERODROME_CL: return 0;
    case Dex.UNISWAP_V3: return 1;
    case Dex.AERODROME_AMM: return 2;
    default: return 0;
  }
}

// ─── ExecutionEngine ───────────────────────────────────────────────

export class ExecutionEngine {
  private config: ExecutionConfig;
  private riskManager: RiskManager;
  private provider: JsonRpcProvider | null = null;
  private wallet: Wallet | null = null;
  private contract: Contract | null = null;
  private _initialized = false;

  constructor(config: Partial<ExecutionConfig>, riskManager: RiskManager) {
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config };
    this.riskManager = riskManager;
  }

  // ── Initialization ────────────────────────────────────────────

  /**
   * Initialize the engine: connect to Base RPC, create wallet, load contract.
   * Reads PRIVATE_KEY and BASE_RPC_URL from process.env.
   */
  async init(): Promise<void> {
    const rpcUrl = this.config.baseRpcUrl || process.env.BASE_RPC_URL;
    if (!rpcUrl) {
      throw new Error('BASE_RPC_URL not configured (config or env)');
    }

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY not set in environment');
    }

    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(privateKey, this.provider);
    this.contract = new Contract(
      this.config.positionV2Address,
      POSITION_V2_ABI,
      this.wallet,
    );

    // Verify connection
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== 8453) {
      throw new Error(
        `Expected Base (8453), got chain ${network.chainId}`,
      );
    }

    this._initialized = true;
    console.log(
      `[ExecutionEngine] Initialized — wallet: ${this.wallet.address}, ` +
      `contract: ${this.config.positionV2Address}, chain: ${network.chainId}`,
    );
  }

  // ── Main Execution ────────────────────────────────────────────

  /**
   * Execute an OpportunitySignal through the full pipeline:
   *   1. Risk validation
   *   2. Expiry check
   *   3. Gas estimation
   *   4. TX construction and submission
   *   5. Confirmation and profit parsing
   *   6. Trade recording
   */
  async executeSignal(signal: OpportunitySignal): Promise<TradeResult> {
    const startTime = Date.now();

    if (!this._initialized || !this.contract || !this.provider || !this.wallet) {
      return this.fail(signal.signal_id, startTime, 'Engine not initialized — call init() first');
    }

    // Step 1: Risk validation
    const validation = this.riskManager.validateSignal(signal);
    if (!validation.approved) {
      console.warn(
        `[ExecutionEngine] Signal ${signal.signal_id} rejected: ${validation.reasons.join('; ')}`,
      );
      return {
        success: false,
        signal_id: signal.signal_id,
        error: `Risk rejected: ${validation.reasons.join('; ')}`,
        execution_time_ms: Date.now() - startTime,
      };
    }

    // Step 2: Expiry check
    const nowSec = Math.floor(Date.now() / 1000);
    if (signal.expires_at <= nowSec) {
      return this.fail(signal.signal_id, startTime, 'Signal expired before execution');
    }

    // Step 3: Determine strategy and build TX
    try {
      let txResponse: ethers.TransactionResponse;

      switch (signal.strategy) {
        case Strategy.TRIANGLE_ARB:
          txResponse = await this.executeTriangleArb(signal);
          break;
        case Strategy.CROSS_DEX_ARB:
          txResponse = await this.executeCrossDexArb(signal);
          break;
        case Strategy.MEMECOIN:
          return this.fail(signal.signal_id, startTime, 'Memecoin strategy not supported by PositionV2');
        default:
          return this.fail(signal.signal_id, startTime, `Unknown strategy: ${signal.strategy}`);
      }

      console.log(
        `[ExecutionEngine] TX sent: ${txResponse.hash} (signal: ${signal.signal_id})`,
      );

      // Step 4: Wait for confirmation
      const receipt = await this.withTimeout(
        this.provider.waitForTransaction(
          txResponse.hash,
          this.config.confirmationBlocks,
          this.config.deadlineSeconds * 1000,
        ),
        this.config.deadlineSeconds * 1000,
        `TX confirmation timeout (${this.config.deadlineSeconds}s)`,
      );

      if (!receipt) {
        return this.fail(signal.signal_id, startTime, 'TX receipt is null — transaction may have been dropped');
      }

      // Step 5: Parse result
      const result = this.parseReceipt(signal, receipt, startTime);

      // Step 6: Record trade
      this.riskManager.recordTrade({
        signal_id: signal.signal_id,
        timestamp: Date.now(),
        profit_usd: result.profit_usd ?? 0,
        success: result.success,
        error_message: result.error,
      });

      return result;

    } catch (err) {
      const errorMsg = this.decodeError(err);
      console.error(
        `[ExecutionEngine] TX failed for ${signal.signal_id}: ${errorMsg}`,
      );

      this.riskManager.recordTrade({
        signal_id: signal.signal_id,
        timestamp: Date.now(),
        profit_usd: 0,
        success: false,
        error_message: errorMsg,
      });

      return this.fail(signal.signal_id, startTime, errorMsg);
    }
  }

  // ── Triangle Arbitrage ────────────────────────────────────────

  private async executeTriangleArb(
    signal: OpportunitySignal,
  ): Promise<ethers.TransactionResponse> {
    if (signal.route.length !== 3) {
      throw new Error(`Triangle arb requires exactly 3 hops, got ${signal.route.length}`);
    }

    const [hop0, hop1, hop2] = signal.route;

    const params = {
      flashAsset: signal.input_token,
      flashAmount: parseUnits(signal.input_amount, 18),
      path: [hop0.token_in, hop1.token_in, hop2.token_in] as [string, string, string],
      routers: [hop0.pool_address, hop1.pool_address, hop2.pool_address] as [string, string, string],
      poolFees: [hop0.fee_bps * 100, hop1.fee_bps * 100, hop2.fee_bps * 100] as [number, number, number],
      minProfit: this.calculateMinProfit(signal),
      dexTypes: [
        grpcDexToContractType(hop0.dex),
        grpcDexToContractType(hop1.dex),
        grpcDexToContractType(hop2.dex),
      ] as [number, number, number],
    };

    return this.sendTransaction('executeTriangleArb', [params]);
  }

  // ── Cross-DEX Arbitrage ───────────────────────────────────────

  private async executeCrossDexArb(
    signal: OpportunitySignal,
  ): Promise<ethers.TransactionResponse> {
    if (signal.route.length !== 2) {
      throw new Error(`Cross-DEX arb requires exactly 2 hops, got ${signal.route.length}`);
    }

    const [buyHop, sellHop] = signal.route;

    const params = {
      flashAsset: signal.input_token,
      flashAmount: parseUnits(signal.input_amount, 18),
      buyDexRouter: buyHop.pool_address,
      sellDexRouter: sellHop.pool_address,
      intermediateToken: buyHop.token_out,
      buyPoolFee: buyHop.fee_bps * 100,
      sellPoolFee: sellHop.fee_bps * 100,
      minProfit: this.calculateMinProfit(signal),
      dexType: grpcDexToContractType(buyHop.dex),
    };

    return this.sendTransaction('executeArbitrage', [params]);
  }

  // ── TX Submission ─────────────────────────────────────────────

  private async sendTransaction(
    method: string,
    args: unknown[],
  ): Promise<ethers.TransactionResponse> {
    if (!this.contract || !this.provider) {
      throw new Error('Engine not initialized');
    }

    // Estimate gas
    let gasEstimate: bigint;
    try {
      gasEstimate = await this.contract[method].estimateGas(...args);
    } catch (gasErr) {
      throw new Error(
        `Gas estimation failed for ${method} — signal likely no longer profitable: ${this.decodeError(gasErr)}`,
      );
    }

    // Apply 20% buffer
    const gasLimit = (gasEstimate * 120n) / 100n;

    // EIP-1559 gas pricing for Base
    const feeData = await this.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;

    // Cap gas price at config max
    const maxGasPrice = parseUnits(
      this.config.maxGasPriceGwei.toString(),
      'gwei',
    );
    const cappedMaxFee = maxFeePerGas > maxGasPrice ? maxGasPrice : maxFeePerGas;

    // Send TX with retry
    try {
      const tx = await this.contract[method](...args, {
        gasLimit,
        maxFeePerGas: cappedMaxFee,
        maxPriorityFeePerGas,
        type: 2, // EIP-1559
      });
      return tx;
    } catch (sendErr) {
      // Single retry on network errors
      if (this.isNetworkError(sendErr)) {
        console.warn('[ExecutionEngine] Network error, retrying once...');
        await this.sleep(1000);
        const tx = await this.contract[method](...args, {
          gasLimit,
          maxFeePerGas: cappedMaxFee,
          maxPriorityFeePerGas,
          type: 2,
        });
        return tx;
      }
      throw sendErr;
    }
  }

  // ── Receipt Parsing ───────────────────────────────────────────

  private parseReceipt(
    signal: OpportunitySignal,
    receipt: ethers.TransactionReceipt,
    startTime: number,
  ): TradeResult {
    const gasCostWei = receipt.gasUsed * receipt.gasPrice;
    const gasCostEth = Number(formatUnits(gasCostWei, 18));
    // Approximate ETH/USD for gas cost (Base uses ETH for gas)
    const gasCostUsd = gasCostEth * 2500; // Rough ETH price

    // Try to parse ArbitrageExecuted events
    let profitUsd = parseFloat(signal.net_profit_usd);
    const arbEvent = receipt.logs
      .map((log) => {
        try {
          return this.contract!.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === 'ArbitrageExecuted');

    if (arbEvent) {
      const profitWei = arbEvent.args.profit as bigint;
      profitUsd = Number(formatUnits(profitWei, 18)) * 2500;
    }

    const success = receipt.status === 1;
    return {
      success,
      signal_id: signal.signal_id,
      tx_hash: receipt.hash,
      profit_usd: success ? profitUsd : 0,
      gas_cost_usd: gasCostUsd,
      error: success ? undefined : 'Transaction reverted on-chain',
      execution_time_ms: Date.now() - startTime,
      block_number: receipt.blockNumber,
    };
  }

  // ── Status ────────────────────────────────────────────────────

  /** Get current engine status and connection info. */
  async getStatus(): Promise<EngineStatus> {
    if (!this._initialized || !this.provider || !this.wallet || !this.contract) {
      return {
        initialized: false,
        connected: false,
        walletAddress: '',
        contractAddress: this.config.positionV2Address,
        chainId: 0,
        blockNumber: 0,
        contractBalance: {},
      };
    }

    let blockNumber = 0;
    let chainId = 0;
    let connected = false;
    const balances: Record<string, string> = {};

    try {
      const network = await this.provider.getNetwork();
      chainId = Number(network.chainId);
      blockNumber = Number(await this.provider.getBlockNumber());
      connected = true;

      // Check WETH and USDC balances on contract
      const wethAddr = '0x4200000000000000000000000000000000000006';
      const usdcAddr = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      try {
        const wethBal = await this.contract.getTokenBalance(wethAddr);
        balances.WETH = formatUnits(wethBal, 18);
      } catch { /* ignore */ }
      try {
        const usdcBal = await this.contract.getTokenBalance(usdcAddr);
        balances.USDC = formatUnits(usdcBal, 6);
      } catch { /* ignore */ }
    } catch {
      connected = false;
    }

    return {
      initialized: this._initialized,
      connected,
      walletAddress: this.wallet.address,
      contractAddress: this.config.positionV2Address,
      chainId,
      blockNumber,
      contractBalance: balances,
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /** Shutdown the engine and release resources. */
  shutdown(): void {
    this.provider = null;
    this.wallet = null;
    this.contract = null;
    this._initialized = false;
    console.log('[ExecutionEngine] Shutdown complete');
  }

  // ── Internal Helpers ──────────────────────────────────────────

  /**
   * Calculate minimum profit in wei for the contract's minProfit param.
   * Ensures at least the signal's net profit is protected.
   */
  private calculateMinProfit(signal: OpportunitySignal): bigint {
    const netProfitUsd = parseFloat(signal.net_profit_usd);
    // Convert USD to 18-decimal wei (rough: 1 USD ≈ 0.0004 ETH ≈ 4e14 wei)
    // This is a safety floor — the contract uses it to revert if profit < minProfit
    const profitWei = parseUnits(
      Math.max(netProfitUsd * 0.0004, 0.0001).toFixed(18),
      18,
    );
    return profitWei;
  }

  /** Build a failed TradeResult. */
  private fail(
    signalId: string,
    startTime: number,
    error: string,
  ): TradeResult {
    return {
      success: false,
      signal_id: signalId,
      error,
      execution_time_ms: Date.now() - startTime,
    };
  }

  /** Decode ethers error into a human-readable string. */
  private decodeError(err: unknown): string {
    if (err instanceof Error) {
      // Contract revert
      if ('reason' in err && typeof (err as any).reason === 'string') {
        return `Contract revert: ${(err as any).reason}`;
      }
      // Transaction reverted without reason
      if ('code' in err) {
        const code = (err as any).code;
        if (code === 'TRANSACTION_REPLACED') return 'Transaction replaced';
        if (code === 'TIMEOUT') return 'Transaction timed out';
        if (code === 'NETWORK_ERROR') return 'Network error';
        if (code === 'NONCE_EXPIRED') return 'Nonce expired';
      }
      // Server error with body
      if ('serverError' in err && err.serverError) {
        return `Server error: ${JSON.stringify(err.serverError).slice(0, 200)}`;
      }
      return err.message.slice(0, 300);
    }
    return String(err).slice(0, 300);
  }

  /** Check if an error is retriable network error. */
  private isNetworkError(err: unknown): boolean {
    if (err instanceof Error && 'code' in err) {
      const code = (err as any).code;
      return code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT';
    }
    return false;
  }

  /** Promise with timeout wrapper. */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      const result = await Promise.race([promise, timeout]);
      return result;
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Simple sleep utility. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
