/**
 * gRPC client for receiving trading signals from the Rust sidecar scanner.
 *
 * Connects to the ScannerService defined in scanner.proto and provides
 * streaming opportunity signals, price updates, health checks, and
 * execution reporting with automatic reconnection.
 *
 * Usage:
 *   const client = new ScannerClient('localhost:50051');
 *   await client.connect();
 *   client.streamOpportunities(handler);
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import path from 'path';

// ─── Connection State ────────────────────────────────────────────────

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

// ─── Proto-generated Types ───────────────────────────────────────────
// These match the protobuf definitions in scanner.proto / common.proto.

export enum Strategy {
  STRATEGY_UNSPECIFIED = 0,
  TRIANGLE_ARB = 1,
  CROSS_DEX_ARB = 2,
  MEMECOIN = 3,
}

export enum Dex {
  DEX_UNSPECIFIED = 0,
  AERODROME_CL = 1,
  AERODROME_AMM = 2,
  UNISWAP_V3 = 3,
}

export enum HealthStatus {
  HEALTH_STATUS_UNSPECIFIED = 0,
  HEALTHY = 1,
  DEGRADED = 2,
  UNHEALTHY = 3,
}

export interface RouteHop {
  pool_address: string;
  dex: Dex;
  token_in: string;
  token_out: string;
  fee_bps: number;
  expected_output: string;
}

export interface OpportunitySignal {
  signal_id: string;
  strategy: Strategy;
  timestamp: number;
  confidence: number;
  expected_profit_usd: string;
  expected_profit_bps: number;
  route: RouteHop[];
  input_token: string;
  input_amount: string;
  estimated_gas_cost_usd: string;
  net_profit_usd: string;
  expires_at: number;
}

export interface PoolPriceUpdate {
  pool_address: string;
  dex: Dex;
  token_a: string;
  token_b: string;
  price_a_to_b: string;
  price_b_to_a: string;
  timestamp: number;
  liquidity: string;
}

export interface HealthCheck {
  status: HealthStatus;
  uptime_seconds: number;
  active_feeds: number;
  signals_emitted: number;
  last_signal_at: number;
}

export interface ExecutionResult {
  signal_id: string;
  success: boolean;
  actual_profit_usd: string;
  tx_hash: string;
  error_message: string;
  execution_time_ms: number;
}

// ─── Handler Interface ───────────────────────────────────────────────

export interface SignalHandler {
  onOpportunity(signal: OpportunitySignal): void;
  onPriceUpdate(update: PoolPriceUpdate): void;
  onHealthCheck(health: HealthCheck): void;
  onError(error: Error): void;
}

// ─── gRPC Service Types (from proto loading) ────────────────────────

interface ScannerServiceClient {
  StreamOpportunities(
    request: {},
    metadata: grpc.Metadata,
    options: Partial<grpc.CallOptions>,
  ): grpc.ClientReadableStream<any>;
  StreamPrices(
    request: {},
    metadata: grpc.Metadata,
    options: Partial<grpc.CallOptions>,
  ): grpc.ClientReadableStream<any>;
  GetHealth(
    request: {},
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ): grpc.ClientUnaryCall;
  ReportExecution(
    request: any,
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ): grpc.ClientUnaryCall;
}

interface ScannerServiceConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): ScannerServiceClient;
}

// ─── Reconnection Config ────────────────────────────────────────────

export interface ReconnectionConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

const DEFAULT_RECONNECTION: ReconnectionConfig = {
  maxRetries: Infinity,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
};

// ─── ScannerClient ──────────────────────────────────────────────────

export class ScannerClient {
  private grpcUrl: string;
  private reconnectConfig: ReconnectionConfig;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private client: ScannerServiceClient | null = null;
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCalls: grpc.ClientReadableStream<any>[] = [];
  private handlers: Set<SignalHandler> = new Set();
  private stateChangeCallbacks: Array<(state: ConnectionState) => void> = [];

  // Proto package and service names
  private static readonly PACKAGE_NAME = 'flashloan.scanner.v1';
  private static readonly SERVICE_NAME = 'ScannerService';

  constructor(grpcUrl: string, reconnectionConfig?: Partial<ReconnectionConfig>) {
    this.grpcUrl = grpcUrl;
    this.reconnectConfig = { ...DEFAULT_RECONNECTION, ...reconnectionConfig };
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Connect to the Rust sidecar gRPC server. */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
      return;
    }

    this.setState(ConnectionState.CONNECTING);

    try {
      const Service = await this.loadProto();
      this.client = new Service(this.grpcUrl, grpc.credentials.createInsecure());

      // Verify connection with a health check
      await this.performHealthCheck();

      this.retryCount = 0;
      this.setState(ConnectionState.CONNECTED);
    } catch (err) {
      this.setState(ConnectionState.ERROR);
      this.scheduleReconnect();
      throw new Error(`Failed to connect to gRPC server at ${this.grpcUrl}: ${err}`);
    }
  }

  /** Start streaming opportunities to all registered handlers. */
  streamOpportunities(handler: SignalHandler): void {
    this.addHandler(handler);
    this.ensureConnected(() => this.startOpportunityStream());
  }

  /** Start streaming price updates to all registered handlers. */
  streamPrices(handler: SignalHandler): void {
    this.addHandler(handler);
    this.ensureConnected(() => this.startPriceStream());
  }

  /** Get a single health check from the sidecar. */
  async getHealth(): Promise<HealthCheck> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }
    return this.performHealthCheck();
  }

  /** Report an execution result back to the sidecar. */
  async reportExecution(result: ExecutionResult): Promise<void> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      this.client!.ReportExecution(result, (err) => {
        if (err) {
          reject(new Error(`ReportExecution failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /** Register a callback for connection state changes. */
  onStateChange(callback: (state: ConnectionState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  /** Get current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Disconnect and clean up all resources. */
  disconnect(): void {
    this.cancelReconnect();
    this.cancelActiveCalls();
    this.handlers.clear();

    if (this.client) {
      grpc.closeClient(this.client as any);
      this.client = null;
    }

    this.setState(ConnectionState.DISCONNECTED);
  }

  // ── Proto Loading ───────────────────────────────────────────────

  private async loadProto(): Promise<ScannerServiceConstructor> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const protoRoot = path.resolve(__dirname, '..', 'proto');

    const packageDef = await protoLoader.load(
      path.join(protoRoot, 'scanner.proto'),
      {
        keepCase: true,
        longs: String,
        enums: Number,
        defaults: true,
        oneofs: true,
        includeDirs: [protoRoot],
      },
    );

    const protoDescriptor = grpc.loadPackageDefinition(packageDef);

    // grpc-js creates nested namespaces (flashloan.scanner.v1),
    // NOT flat bracket-access keys like ['flashloan.scanner.v1']
    const pkg = (protoDescriptor as any).flashloan?.scanner?.v1;

    if (!pkg?.[ScannerClient.SERVICE_NAME]) {
      throw new Error(
        `Service ${ScannerClient.SERVICE_NAME} not found in package ${ScannerClient.PACKAGE_NAME}. ` +
        `Available keys: ${Object.keys(protoDescriptor).join(', ')}`,
      );
    }

    return pkg[ScannerClient.SERVICE_NAME];
  }

  // ── Streaming ───────────────────────────────────────────────────

  private startOpportunityStream(): void {
    if (!this.client) return;

    const call = this.client.StreamOpportunities(
      {},
      new grpc.Metadata(),
      {},
    );

    this.trackCall(call);

    call.on('data', (signal: OpportunitySignal) => {
      for (const handler of this.handlers) {
        try {
          handler.onOpportunity(signal);
        } catch (e) {
          handler.onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    call.on('error', (err: grpc.ServiceError) => {
      if (isStreamInterrupted(err)) {
        this.handleStreamError('StreamOpportunities', err);
      }
    });

    call.on('end', () => {
      this.removeCall(call);
    });
  }

  private startPriceStream(): void {
    if (!this.client) return;

    const call = this.client.StreamPrices(
      {},
      new grpc.Metadata(),
      {},
    );

    this.trackCall(call);

    call.on('data', (update: PoolPriceUpdate) => {
      for (const handler of this.handlers) {
        try {
          handler.onPriceUpdate(update);
        } catch (e) {
          handler.onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    call.on('error', (err: grpc.ServiceError) => {
      if (isStreamInterrupted(err)) {
        this.handleStreamError('StreamPrices', err);
      }
    });

    call.on('end', () => {
      this.removeCall(call);
    });
  }

  // ── Health Check ────────────────────────────────────────────────

  private performHealthCheck(): Promise<HealthCheck> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        return reject(new Error('Client not initialized'));
      }

      this.client.GetHealth({}, (err, response) => {
        if (err) {
          return reject(err);
        }
        // Notify handlers
        for (const handler of this.handlers) {
          try {
            handler.onHealthCheck(response as HealthCheck);
          } catch (e) {
            handler.onError(e instanceof Error ? e : new Error(String(e)));
          }
        }
        resolve(response as HealthCheck);
      });
    });
  }

  // ── Reconnection ────────────────────────────────────────────────

  private handleStreamError(streamName: string, err: grpc.ServiceError): void {
    console.error(`[grpc-client] ${streamName} error: ${err.message}`);
    this.setState(ConnectionState.ERROR);

    for (const handler of this.handlers) {
      handler.onError(new Error(`${streamName} stream error: ${err.message}`));
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= this.reconnectConfig.maxRetries) {
      console.error(
        `[grpc-client] Max reconnection attempts (${this.reconnectConfig.maxRetries}) reached.`,
      );
      return;
    }

    this.cancelReconnect();
    this.cancelActiveCalls();

    const delay = Math.min(
      this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.multiplier, this.retryCount),
      this.reconnectConfig.maxDelayMs,
    );

    this.retryCount++;
    console.log(
      `[grpc-client] Reconnecting in ${delay}ms (attempt ${this.retryCount})...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        // Re-establish streams after successful reconnect
        this.startOpportunityStream();
        this.startPriceStream();
        console.log('[grpc-client] Reconnected and streams restored.');
      } catch {
        // connect() already schedules the next retry
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Call Tracking ───────────────────────────────────────────────

  private trackCall(call: grpc.ClientReadableStream<any>): void {
    this.activeCalls.push(call);
  }

  private removeCall(call: grpc.ClientReadableStream<any>): void {
    const idx = this.activeCalls.indexOf(call);
    if (idx >= 0) this.activeCalls.splice(idx, 1);
  }

  private cancelActiveCalls(): void {
    for (const call of this.activeCalls) {
      call.cancel();
    }
    this.activeCalls = [];
  }

  // ── Handler Management ──────────────────────────────────────────

  private addHandler(handler: SignalHandler): void {
    this.handlers.add(handler);
  }

  // ── State ───────────────────────────────────────────────────────

  private setState(newState: ConnectionState): void {
    const prev = this.state;
    this.state = newState;
    if (prev !== newState) {
      for (const cb of this.stateChangeCallbacks) {
        try {
          cb(newState);
        } catch {
          // swallow callback errors
        }
      }
    }
  }

  private ensureConnected(action: () => void): void {
    if (this.state === ConnectionState.CONNECTED) {
      action();
    } else if (this.state === ConnectionState.DISCONNECTED) {
      console.warn('[grpc-client] Not connected. Call connect() first.');
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Returns true for gRPC errors that indicate a broken stream, not normal closure. */
function isStreamInterrupted(err: grpc.ServiceError): boolean {
  const retryableCodes = [
    grpc.status.UNAVAILABLE,
    grpc.status.INTERNAL,
    grpc.status.UNKNOWN,
    grpc.status.RESOURCE_EXHAUSTED,
    grpc.status.ABORTED,
  ];
  return retryableCodes.includes(err.code as number);
}

/** Pretty-print strategy name. */
export function strategyName(s: Strategy): string {
  return Strategy[s] ?? 'UNKNOWN';
}

/** Pretty-print DEX name. */
export function dexName(d: Dex): string {
  return Dex[d] ?? 'UNKNOWN';
}

/** Check if an opportunity has expired. */
export function isExpired(signal: OpportunitySignal, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  // expires_at is seconds in proto, convert to ms
  return now > signal.expires_at * 1000;
}

/** Human-readable summary of an opportunity signal (for logging). */
export function formatSignal(signal: OpportunitySignal): string {
  const hops = signal.route
    .map((h) => `${dexName(h.dex)}:${h.token_in.slice(0, 8)}→${h.token_out.slice(0, 8)}`)
    .join(' → ');
  return (
    `[${strategyName(signal.strategy)}] ` +
    `net=$${signal.net_profit_usd} ` +
    `conf=${(signal.confidence * 100).toFixed(0)}% ` +
    `route=[${hops}] ` +
    `expires=${signal.expires_at}`
  );
}
