/**
 * Example: Connect to the Rust sidecar gRPC server and log signals.
 *
 * Usage:
 *   GRPC_URL=localhost:50051 npx tsx src/scanner/grpc-client-example.ts
 */

import {
  ScannerClient,
  SignalHandler,
  OpportunitySignal,
  PoolPriceUpdate,
  HealthCheck,
  ConnectionState,
  formatSignal,
  isExpired,
} from './grpc-client.js';

const GRPC_URL = process.env.GRPC_URL ?? 'localhost:50051';

// ─── Console Logger Handler ──────────────────────────────────────────

const consoleHandler: SignalHandler = {
  onOpportunity(signal: OpportunitySignal): void {
    if (isExpired(signal)) {
      console.log(`[STALE] ${formatSignal(signal)}`);
      return;
    }
    console.log(`[SIGNAL] ${formatSignal(signal)}`);

    // Show route details
    for (const hop of signal.route) {
      console.log(
        `  ↳ pool=${hop.pool_address} fee=${hop.fee_bps}bps ` +
        `out=${hop.expected_output}`,
      );
    }
  },

  onPriceUpdate(update: PoolPriceUpdate): void {
    console.log(
      `[PRICE] pool=${update.pool_address.slice(0, 10)}… ` +
      `${update.token_a.slice(0, 8)}→${update.token_b.slice(0, 8)} ` +
      `price=${update.price_a_to_b} liq=${update.liquidity}`,
    );
  },

  onHealthCheck(health: HealthCheck): void {
    console.log(
      `[HEALTH] status=${health.status} uptime=${health.uptime_seconds}s ` +
      `feeds=${health.active_feeds} signals=${health.signals_emitted}`,
    );
  },

  onError(error: Error): void {
    console.error(`[ERROR] ${error.message}`);
  },
};

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Connecting to Rust sidecar at ${GRPC_URL}...`);

  const client = new ScannerClient(GRPC_URL, {
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 15_000,
  });

  // Monitor state changes
  client.onStateChange((state) => {
    console.log(`[STATE] ${state}`);
  });

  // Handle graceful shutdown
  const shutdown = (): void => {
    console.log('\nDisconnecting...');
    client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    console.log('Connected! Starting streams...');

    // Start streaming opportunities and prices
    client.streamOpportunities(consoleHandler);
    client.streamPrices(consoleHandler);

    // Periodic health check every 30 seconds
    setInterval(async () => {
      try {
        if (client.getState() === ConnectionState.CONNECTED) {
          const health = await client.getHealth();
          console.log(
            `[HEALTH] status=${health.status} uptime=${health.uptime_seconds}s ` +
            `signals=${health.signals_emitted}`,
          );
        }
      } catch (err) {
        console.error('[HEALTH CHECK FAILED]', err);
      }
    }, 30_000);

    console.log('Listening for signals. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}

main();
