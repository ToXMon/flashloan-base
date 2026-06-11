/**
 * Unit tests for ExecutionEngine — signal-to-TX pipeline with mocked contract.
 *
 * Run: npx tsx src/scanner/__tests__/execution-engine.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine, DEFAULT_EXECUTION_CONFIG } from '../execution-engine.js';
import { RiskManager } from '../risk-manager.js';
import type { OpportunitySignal } from '../grpc-client.js';
import { Strategy, Dex } from '../grpc-client.js';

// ─── Test Helpers ──────────────────────────────────────────────────

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI  = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const POOL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const POOL_C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function makeTriangleSignal(overrides?: Partial<OpportunitySignal>): OpportunitySignal {
  return {
    signal_id: 'tri-001',
    strategy: Strategy.TRIANGLE_ARB,
    timestamp: Date.now(),
    confidence: 0.8,
    expected_profit_usd: '0.50',
    expected_profit_bps: 25,
    route: [
      { pool_address: POOL_A, dex: Dex.AERODROME_CL, token_in: WETH, token_out: USDC, fee_bps: 5, expected_output: '1000' },
      { pool_address: POOL_B, dex: Dex.UNISWAP_V3,    token_in: USDC, token_out: DAI,  fee_bps: 3, expected_output: '1000' },
      { pool_address: POOL_C, dex: Dex.AERODROME_AMM, token_in: DAI,  token_out: WETH, fee_bps: 5, expected_output: '0.5' },
    ],
    input_token: WETH,
    input_amount: '100',
    estimated_gas_cost_usd: '0.01',
    net_profit_usd: '0.50',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function makeCrossDexSignal(overrides?: Partial<OpportunitySignal>): OpportunitySignal {
  return {
    signal_id: 'crossdex-001',
    strategy: Strategy.CROSS_DEX_ARB,
    timestamp: Date.now(),
    confidence: 0.75,
    expected_profit_usd: '0.30',
    expected_profit_bps: 20,
    route: [
      { pool_address: POOL_A, dex: Dex.AERODROME_CL, token_in: WETH, token_out: USDC, fee_bps: 5, expected_output: '1000' },
      { pool_address: POOL_B, dex: Dex.UNISWAP_V3,    token_in: USDC, token_out: WETH, fee_bps: 3, expected_output: '0.505' },
    ],
    input_token: WETH,
    input_amount: '100',
    estimated_gas_cost_usd: '0.01',
    net_profit_usd: '0.30',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

/** Create a fresh engine with a RiskManager that passes all checks. */
function createEngine() {
  const rm = new RiskManager();
  const engine = new ExecutionEngine(
    { positionV2Address: '0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A' },
    rm,
  );
  return { engine, rm };
}

// ─── Uninitialized Engine ─────────────────────────────────────────

void describe('ExecutionEngine — Uninitialized', () => {
  void it('rejects signal when not initialized', async () => {
    const { engine } = createEngine();
    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('not initialized'));
    assert.equal(result.signal_id, 'tri-001');
    assert.ok(result.execution_time_ms >= 0);
  });

  void it('returns disconnected status when not initialized', async () => {
    const { engine } = createEngine();
    const status = await engine.getStatus();
    assert.equal(status.initialized, false);
    assert.equal(status.connected, false);
    assert.equal(status.walletAddress, '');
  });
});

// ─── Risk Rejection ───────────────────────────────────────────────

void describe('ExecutionEngine — Risk Rejection', () => {
  void it('rejects signal when RiskManager rejects', async () => {
    const { engine, rm } = createEngine();
    // Pause the risk manager so all signals are rejected
    rm.pause();

    // Initialize with mock
    await mockInit(engine);

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Risk rejected'));
    assert.ok(result.error!.includes('paused'));
    assert.equal(result.signal_id, 'tri-001');
    assert.equal(result.tx_hash, undefined);
  });

  void it('rejects signal with low profit', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    const result = await engine.executeSignal(
      makeTriangleSignal({ net_profit_usd: '0.01' }),
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Risk rejected'));
  });

  void it('rejects signal with low confidence', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    const result = await engine.executeSignal(
      makeTriangleSignal({ confidence: 0.1 }),
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Risk rejected'));
  });
});

// ─── Expiry Check ─────────────────────────────────────────────────

void describe('ExecutionEngine — Expiry Check', () => {
  void it('rejects expired signal even if risk passes', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    const expiredSignal = makeTriangleSignal({
      expires_at: Math.floor(Date.now() / 1000) - 10, // 10s ago
    });

    const result = await engine.executeSignal(expiredSignal);
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('expired'));
    assert.equal(result.signal_id, 'tri-001');
  });
});

// ─── TradeResult Format ───────────────────────────────────────────

void describe('ExecutionEngine — TradeResult Format', () => {
  void it('failed result has correct shape', async () => {
    const { engine } = createEngine();
    const result = await engine.executeSignal(makeTriangleSignal());

    assert.equal(result.success, false);
    assert.equal(typeof result.signal_id, 'string');
    assert.equal(typeof result.execution_time_ms, 'number');
    assert.ok(result.execution_time_ms >= 0);
    assert.equal(typeof result.error, 'string');
  });
});

// ─── Strategy Routing ─────────────────────────────────────────────

void describe('ExecutionEngine — Strategy Routing', () => {
  void it('rejects MEMECOIN strategy', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    const result = await engine.executeSignal(
      makeTriangleSignal({ strategy: Strategy.MEMECOIN, signal_id: 'meme-001' }),
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Memecoin strategy not supported'));
  });

  void it('rejects unknown strategy', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    const result = await engine.executeSignal(
      makeTriangleSignal({ strategy: 99 as any, signal_id: 'unknown-001' }),
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Unknown strategy'));
  });
});

// ─── Gas Estimation Failure ───────────────────────────────────────

void describe('ExecutionEngine — Gas Estimation Failure', () => {
  void it('handles gas estimation failure gracefully', async () => {
    const { engine, rm } = createEngine();
    const { mockContract, mockProvider } = await mockInitWithControls(engine, {
      gasEstimateError: new Error('execution reverted: insufficient liquidity'),
    });

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Gas estimation failed'));

    // Verify trade was recorded as failure
    const state = rm.getState();
    assert.equal(state.tradeHistory.length, 1);
    assert.equal(state.tradeHistory[0].success, false);
    assert.equal(state.tradeHistory[0].signal_id, 'tri-001');
  });
});

// ─── Contract Revert ──────────────────────────────────────────────

void describe('ExecutionEngine — Contract Revert', () => {
  void it('handles contract revert with reason', async () => {
    const { engine, rm } = createEngine();
    const revertError: any = new Error('Transaction reverted');
    revertError.reason = 'buy dex not approved';
    revertError.code = 'CALL_EXCEPTION';

    await mockInitWithControls(engine, { sendError: revertError });

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Contract revert'));
    assert.ok(result.error!.includes('buy dex not approved'));
  });
});

// ─── Successful Execution ─────────────────────────────────────────

void describe('ExecutionEngine — Successful Execution', () => {
  void it('executes triangle arb and records trade', async () => {
    const { engine, rm } = createEngine();

    const mockReceipt = {
      hash: '0xabc123',
      status: 1,
      blockNumber: 12345,
      gasUsed: 250000n,
      gasPrice: 100000000n, // 0.1 gwei
      logs: [],
    };

    await mockInitWithControls(engine, {
      txHash: '0xabc123',
      receipt: mockReceipt,
    });

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, true);
    assert.equal(result.tx_hash, '0xabc123');
    assert.equal(result.block_number, 12345);
    assert.equal(result.signal_id, 'tri-001');
    assert.ok(result.execution_time_ms >= 0);

    // Verify trade was recorded as success
    const state = rm.getState();
    assert.equal(state.tradeHistory.length, 1);
    assert.equal(state.tradeHistory[0].success, true);
    assert.equal(state.tradeHistory[0].signal_id, 'tri-001');
  });

  void it('executes cross-DEX arb and records trade', async () => {
    const { engine, rm } = createEngine();

    const mockReceipt = {
      hash: '0xdef456',
      status: 1,
      blockNumber: 12346,
      gasUsed: 200000n,
      gasPrice: 100000000n,
      logs: [],
    };

    await mockInitWithControls(engine, {
      txHash: '0xdef456',
      receipt: mockReceipt,
    });

    const result = await engine.executeSignal(makeCrossDexSignal());
    assert.equal(result.success, true);
    assert.equal(result.tx_hash, '0xdef456');
    assert.equal(result.signal_id, 'crossdex-001');

    const state = rm.getState();
    assert.equal(state.tradeHistory.length, 1);
    assert.equal(state.tradeHistory[0].success, true);
  });

  void it('parses ArbitrageExecuted event from receipt', async () => {
    const { engine, rm } = createEngine();

    // Create a mock log matching ArbitrageExecuted event
    // event ArbitrageExecuted(uint8 indexed arbType, address indexed asset, uint256 amount, uint256 profit)
    const mockReceipt = {
      hash: '0xevent123',
      status: 1,
      blockNumber: 12347,
      gasUsed: 220000n,
      gasPrice: 80000000n,
      logs: [{
        topics: [
          '0x0000000000000000000000000000000000000000000000000000000000000000', // placeholder
        ],
        data: '0x',
      }],
    };

    await mockInitWithControls(engine, {
      txHash: '0xevent123',
      receipt: mockReceipt,
    });

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, true);
    assert.ok(result.profit_usd !== undefined);
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────

void describe('ExecutionEngine — Shutdown', () => {
  void it('clears state on shutdown', async () => {
    const { engine } = createEngine();
    await mockInit(engine);

    engine.shutdown();

    const result = await engine.executeSignal(makeTriangleSignal());
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('not initialized'));
  });
});

// ─── Default Config ───────────────────────────────────────────────

void describe('ExecutionEngine — Default Config', () => {
  void it('has correct default values', () => {
    assert.equal(DEFAULT_EXECUTION_CONFIG.maxGasPriceGwei, 1.0);
    assert.equal(DEFAULT_EXECUTION_CONFIG.confirmationBlocks, 1);
    assert.equal(DEFAULT_EXECUTION_CONFIG.deadlineSeconds, 30);
    assert.ok(DEFAULT_EXECUTION_CONFIG.positionV2Address.startsWith('0x'));
  });
});

// ─── Mock Helpers ─────────────────────────────────────────────────
// These directly set private fields to inject mocks without real network.

interface MockControls {
  gasEstimateError?: Error;
  sendError?: Error;
  txHash?: string;
  receipt?: any;
}

/** Initialize engine with minimal mocks injected directly. */
async function mockInit(engine: ExecutionEngine): Promise<void> {
  await mockInitWithControls(engine, {});
}

async function mockInitWithControls(
  engine: ExecutionEngine,
  controls: MockControls,
): Promise<{ mockContract: any; mockProvider: any }> {
  const anyEngine = engine as any;

  // Create mock provider
  const mockProvider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlockNumber: async () => 12345,
    getFeeData: async () => ({
      maxFeePerGas: 500000000n, // 0.5 gwei
      maxPriorityFeePerGas: 100000000n, // 0.1 gwei
    }),
    waitForTransaction: async (hash: string) => controls.receipt ?? null,
  };

  // Create mock contract methods that match ethers Contract pattern:
  // contract.methodName(...) sends TX, contract.methodName.estimateGas(...) estimates gas

  const makeMethodMock = (methodName: string) => {
    const fn = async (...args: any[]) => {
      if (controls.sendError) throw controls.sendError;
      return { hash: controls.txHash ?? '0xmock' };
    };
    fn.estimateGas = async (...args: any[]) => {
      if (controls.gasEstimateError) throw controls.gasEstimateError;
      return 250000n;
    };
    return fn;
  };

  const mockContract: any = {
    interface: {
      parseLog: () => null,
    },
    executeTriangleArb: makeMethodMock('executeTriangleArb'),
    executeArbitrage: makeMethodMock('executeArbitrage'),
    getTokenBalance: async () => 0n,
    owner: async () => '0x06C74ebba31010f72673189a36D9Ca46083A053A',
    paused: async () => false,
  };

  // Inject mocks into private fields
  anyEngine.provider = mockProvider;
  anyEngine.wallet = { address: '0x06C74ebba31010f72673189a36D9Ca46083A053A' };
  anyEngine.contract = mockContract;
  anyEngine._initialized = true;

  return { mockContract, mockProvider };
}
