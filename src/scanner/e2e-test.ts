
/**
 * E2E Integration Test (T17): Rust Sidecar <-> TypeScript gRPC Client
 *
 * Verifies: Rust sidecar starts -> TS client connects -> health check flows -> disconnect.
 *
 * Usage:
 *   SIDECAR_GRPC_PORT=50052 cargo run &
 *   npx tsx src/scanner/e2e-test.ts
 */

import {
  ScannerClient,
  ConnectionState,
  HealthStatus,
  type HealthCheck,
  type OpportunitySignal,
  type PoolPriceUpdate,
  type SignalHandler,
} from './grpc-client.js';

const GRPC_URL = process.env.GRPC_URL ?? 'localhost:50052';
const TEST_TIMEOUT_MS = 15_000;
const STREAM_WAIT_MS = 5_000;

// --- Test Runner ---

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, detail: string): void {
  if (!condition) throw new Error(`FAIL [${name}]: ${detail}`);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, detail: 'OK', durationMs: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail: msg, durationMs: Date.now() - start });
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

// --- Signal Handler (collects events) ---

const receivedSignals: OpportunitySignal[] = [];
const receivedPrices: PoolPriceUpdate[] = [];
const receivedHealth: HealthCheck[] = [];
const receivedErrors: Error[] = [];

const collector: SignalHandler = {
  onOpportunity(signal: OpportunitySignal): void {
    receivedSignals.push(signal);
  },
  onPriceUpdate(update: PoolPriceUpdate): void {
    receivedPrices.push(update);
  },
  onHealthCheck(health: HealthCheck): void {
    receivedHealth.push(health);
  },
  onError(error: Error): void {
    receivedErrors.push(error);
  },
};

// --- Tests ---

async function main(): Promise<void> {
  console.log('');
  console.log('=======================================================');
  console.log('  E2E Integration Test: Rust Sidecar <-> TS gRPC Client');
  console.log('=======================================================');
  console.log(`  Target: ${GRPC_URL}`);
  console.log(`  Timeout: ${TEST_TIMEOUT_MS}ms`);
  console.log('=======================================================');
  console.log('');

  const client = new ScannerClient(GRPC_URL, {
    maxRetries: 0,
    initialDelayMs: 500,
    maxDelayMs: 2_000,
  });

  // Track state transitions
  const stateTransitions: ConnectionState[] = [];
  client.onStateChange((state) => {
    stateTransitions.push(state);
    console.log(`  [STATE] -> ${state}`);
  });

  // -- Test 1: Client Instantiation --
  await runTest('ScannerClient instantiation', async () => {
    assert(client.getState() === ConnectionState.DISCONNECTED, 'init-state', 'Initial state should be DISCONNECTED');
  });

  // -- Test 2: Connection to Rust Sidecar --
  await runTest('Connect to Rust sidecar gRPC server', async () => {
    const connectPromise = client.connect();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), TEST_TIMEOUT_MS),
    );
    await Promise.race([connectPromise, timeout]);
    assert(client.getState() === ConnectionState.CONNECTED, 'connected', `State is ${client.getState()}, expected CONNECTED`);
  });

  // -- Test 3: Health Check --
  await runTest('GetHealth RPC returns valid HealthCheck', async () => {
    const health = await client.getHealth();
    console.log(`    Health: status=${health.status} uptime=${health.uptime_seconds}s feeds=${health.active_feeds} signals=${health.signals_emitted}`);

    assert(
      Number(health.status) === HealthStatus.HEALTHY,
      'health-status',
      `Expected HEALTHY(1), got ${health.status}`,
    );
    const uptime = Number(health.uptime_seconds);
    assert(
      !isNaN(uptime) && uptime >= 0,
      'uptime',
      `uptime_seconds should be non-negative, got ${health.uptime_seconds}`,
    );
    assert(
      typeof Number(health.active_feeds) === 'number' && !isNaN(Number(health.active_feeds)),
      'feeds',
      `active_feeds should be numeric, got ${health.active_feeds}`,
    );
    assert(
      typeof Number(health.signals_emitted) === 'number' && !isNaN(Number(health.signals_emitted)),
      'signals',
      `signals_emitted should be numeric, got ${health.signals_emitted}`,
    );
  });

  // -- Test 4: Health Check Consistency --
  await runTest('Second GetHealth shows increasing uptime', async () => {
    const health1 = await client.getHealth();
    await new Promise((r) => setTimeout(r, 1500));
    const health2 = await client.getHealth();
    console.log(`    uptime: ${health1.uptime_seconds}s -> ${health2.uptime_seconds}s`);

    const uptime1 = Number(health1.uptime_seconds);
    const uptime2 = Number(health2.uptime_seconds);
    assert(
      uptime2 >= uptime1,
      'uptime-increasing',
      `Uptime should increase: ${uptime1} -> ${uptime2}`,
    );
  });

  // -- Test 5: Stream Opportunities --
  await runTest('StreamOpportunities RPC establishes stream', async () => {
    client.streamOpportunities(collector);

    // Wait for stream to establish (will not get signals without real WS data)
    await new Promise((r) => setTimeout(r, STREAM_WAIT_MS));
    console.log(`    Signals received: ${receivedSignals.length} (expected 0 without real WS data)`);
    console.log(`    Errors received: ${receivedErrors.length}`);

    // Stream should be active without fatal errors
    assert(
      client.getState() === ConnectionState.CONNECTED,
      'stream-state',
      `Client should remain CONNECTED during stream, got ${client.getState()}`,
    );
  });

  // -- Test 6: Disconnect --
  await runTest('Disconnect cleanly', async () => {
    client.disconnect();
    assert(
      client.getState() === ConnectionState.DISCONNECTED,
      'disconnected',
      `State should be DISCONNECTED after disconnect(), got ${client.getState()}`,
    );
  });

  // -- Test 7: State Transitions --
  await runTest('State transitions follow expected sequence', async () => {
    console.log(`    Transitions: ${stateTransitions.join(' -> ')}`);

    assert(
      stateTransitions.length >= 3,
      'min-transitions',
      `Expected at least 3 transitions, got ${stateTransitions.length}`,
    );
    assert(
      stateTransitions.includes(ConnectionState.CONNECTED),
      'was-connected',
      'Should have seen CONNECTED state',
    );
    assert(
      stateTransitions[stateTransitions.length - 1] === ConnectionState.DISCONNECTED,
      'ends-disconnected',
      `Final state should be DISCONNECTED, got ${stateTransitions[stateTransitions.length - 1]}`,
    );
  });

  // -- Summary --
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('');
  console.log('=======================================================');
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('=======================================================');

  if (failed > 0) {
    console.log('');
    console.log('  Failed tests:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    }
  }

  // Output JSON for automated parsing
  const report = {
    test: 'T17-e2e-grpc-integration',
    timestamp: new Date().toISOString(),
    grpc_url: GRPC_URL,
    results,
    summary: { total, passed, failed },
    state_transitions: stateTransitions,
    signals_received: receivedSignals.length,
    prices_received: receivedPrices.length,
    errors_received: receivedErrors.length,
  };

  console.log('');
  console.log('  JSON Report:');
  console.log(JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
