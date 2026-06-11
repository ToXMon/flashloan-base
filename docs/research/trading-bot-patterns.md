# Trading Bot & DeFi Codebase Pattern Analysis

**Date**: 2026-06-07
**Sources**: trading_bot_v3 (Arbitrum), defi_mc (SushiSwap-style), flashloan-base (Base)

---

## 1. Variant Comparison Table

| Dimension | trading_bot_v3 (Arbitrum) | defi_mc (BSC) | flashloan-base (Base) |
|---|---|---|---|
| **Language** | JavaScript (CommonJS) | Solidity 0.6.12 + React/TS | Solidity 0.8.28 + TypeScript |
| **Framework** | Hardhat 2.x | Truffle | Hardhat v3 |
| **Chain** | Arbitrum (multichain-ready) | BSC | Base (Chain ID 8453) |
| **Flash Loan Provider** | Balancer V2 Vault | N/A | Aave V3 (0.05% fee) |
| **DEX Support** | Uniswap V3 + PancakeSwap V3 | SushiSwap AMM (Uniswap V2 fork) | Aerodrome CL + Aerodrome AMM + Uniswap V3 |
| **Strategy Count** | 1 (cross-DEX arb) | 0 (staking/governance only) | 5 (leverage, arb, triangle, liquidation, memecoin) |
| **Monitoring** | WebSocket Swap events | None (frontend only) | Polling (15s), planned WebSocket + Flashblocks |
| **Price Simulation** | QuoterV2 staticCall | None | Quoter + Aerodrome getAmountsOut |
| **Profitability Calc** | Big.js (arbitrary precision) | SafeMath (uint256) | ethers.js v6 BigInt + gas-adjusted model |
| **Risk Management** | Min price diff threshold | Health factor not applicable | Health factor threshold (1.1), slippage BPS, minProfit |
| **Governance** | None | Full (GovernorAlpha + Timelock + Checkpoints) | Owner + Guardian + Pause |
| **Testing** | Minimal (deploy only) | None visible | Fork testing planned |
| **Deployment** | Hardhat Ignition | Truffle migrations | Hardhat scripts + Ignition |
| **Config** | config.json (static) | Truffle config | constants.ts + .env |
| **Memecoin Support** | None | None | Full pipeline (safety scoring, DEXScreener, honeypot detection) |

---

## 2. Unique Patterns Catalog

### 2.1 Event-Driven Swap Monitoring (trading_bot_v3)

**Source**: `bot.js:41-43`

~~~javascript
uPool.on('Swap', () => eventHandler(uPool, pPool, token0, token1))
pPool.on('Swap', () => eventHandler(uPool, pPool, token0, token1))
~~~

**Pattern**: Subscribe to Swap events on both DEX pools via WebSocket. On every swap, recalculate prices on both DEXes and check for arbitrage. This provides real-time reactivity without polling.

**Why it matters**: flashloan-base currently uses 15-second polling intervals. WebSocket event listeners could reduce latency to ~200ms, critical for MEV competition on Base.

**Applicability**: HIGH — port to Base with Aerodrome + UniV3 pool Swap events via Alchemy WebSocket.

---

### 2.2 Price Direction Determination (trading_bot_v3)

**Source**: `bot.js:75-94`

~~~javascript
const determineDirection = async (_priceDifference) => {
  if (_priceDifference >= PRICE_DIFFERENCE) {
    // Buy on Uniswap, Sell on Pancakeswap
    return [uniswap, pancakeswap]
  } else if (_priceDifference <= -(PRICE_DIFFERENCE)) {
    // Buy on Pancakeswap, Sell on Uniswap
    return [pancakeswap, uniswap]
  } else {
    return null
  }
}
~~~

**Pattern**: Compare normalized price difference against a configurable threshold (`PRICE_DIFFERENCE = 0.5`). If the spread exceeds the threshold in either direction, return the ordered exchange pair [buyDex, sellDex]. This separates direction logic from profitability logic.

**Applicability**: HIGH — flashloan-base's arb-engine.ts has similar logic but hardcoded. Making the threshold configurable and separating direction from profitability would improve maintainability.

---

### 2.3 QuoterV2 Off-Chain Simulation (trading_bot_v3)

**Source**: `bot.js:105-130`

~~~javascript
// Quote exact output (how much token0 needed to buy X of token1)
const [token0Needed] = await _exchangePath[0].quoter.quoteExactOutputSingle.staticCall(
  { tokenIn: _token0.address, tokenOut: _token1.address, fee: POOL_FEE,
    amount: BigInt(minAmount.round().toFixed(0)), sqrtPriceLimitX96: 0 }
)

// Quote exact input (how much token0 returned from selling X of token1)
const [token0Returned] = await _exchangePath[1].quoter.quoteExactInputSingle.staticCall(
  { tokenIn: _token1.address, tokenOut: _token0.address, fee: POOL_FEE,
    amountIn: BigInt(minAmount.round().toFixed(0)), sqrtPriceLimitX96: 0 }
)
~~~

**Pattern**: Use QuoterV2.staticCall to simulate swaps without spending gas. First, find how much input token you need to buy the intermediate token. Then, find how much input token you get back from selling the intermediate token. If the return exceeds the input, there's profit.

**Applicability**: HIGH — flashloan-base uses Quoter in arb-engine.ts but not `quoteExactOutputSingle`. Adding output-side quoting enables optimal position sizing ("how much can I borrow profitably?").

---

### 2.4 Liquidity-Based Position Sizing (trading_bot_v3)

**Source**: `bot.js:99-103`

~~~javascript
const liquidity = await getPoolLiquidity(_exchangePath[0].factory, _token0, _token1, POOL_FEE, provider)
const percentage = Big(0.5)
const minAmount = Big(liquidity[1]).mul(percentage)
~~~

**Pattern**: Read the actual pool liquidity (token balances in the pool) and size the trade as a fraction (50%) of available liquidity. This prevents oversized trades that cause excessive slippage.

**Applicability**: MEDIUM — flashloan-base doesn't dynamically size trades based on pool liquidity. Adding this would reduce slippage and improve fill rates.

---

### 2.5 Balancer V2 Flash Loan Pattern (trading_bot_v3)

**Source**: `contracts/Arbitrage.sol:1-85`

~~~solidity
contract Arbitrage is IFlashLoanRecipient {
    IVault private constant vault =
        IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);

    function executeTrade(...) external {
        bytes memory data = abi.encode(
            Trade({routerPath: _routerPath, tokenPath: _tokenPath, fee: _fee})
        );
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(_tokenPath[0]);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _flashAmount;
        vault.flashLoan(this, tokens, amounts, data);
    }

    function receiveFlashLoan(...) external override {
        require(msg.sender == address(vault));
        Trade memory trade = abi.decode(userData, (Trade));
        // Execute swaps...
        IERC20(trade.tokenPath[0]).transfer(address(vault), flashAmount);
        // Transfer profit to owner
        IERC20(trade.tokenPath[0]).transfer(owner, IERC20(trade.tokenPath[0]).balanceOf(address(this)));
    }
}
~~~

**Pattern**: Balancer's `IFlashLoanRecipient` callback pattern differs from Aave's `IFlashLoanSimpleReceiver`. Balancer passes `tokens[]`, `amounts[]`, `feeAmounts[]` arrays (multi-token flash loans). Aave passes a single asset + amount + premium. Balancer's vault is the same address across all chains (0xBA12...).

**Applicability**: MEDIUM — flashloan-base uses Aave V3 exclusively. Adding Balancer as a secondary flash loan provider on Base would provide redundancy and potentially lower fees for multi-token strategies.

---

### 2.6 UniV3 Price Calculation from sqrtPriceX96 (trading_bot_v3)

**Source**: `helpers/helpers.js:33-47`

~~~javascript
async function calculatePrice(_pool, _token0, _token1) {
  const [sqrtPriceX96] = await _pool.slot0()
  const decimalDifference = Number(Big(_token0.decimals - _token1.decimals).abs())
  const conversion = Big(10).pow(decimalDifference)
  const rate = Big((Big(sqrtPriceX96).div(Big(2 ** 96))) ** Big(2))
  const price = Big(rate).div(Big(conversion)).toString()
  // Handle inverse if price is 0
  if (price == 0) {
    return Big(rate).mul(Big(conversion)).toString()
  }
  return price
}
~~~

**Pattern**: Extract price from Uniswap V3 pool's `slot0()` → `sqrtPriceX96`. Formula: `price = (sqrtPriceX96 / 2^96)^2`, adjusted for decimal difference between tokens.

**Applicability**: MEDIUM — flashloan-base relies on Quoter contracts for prices (which is more accurate for specific amounts). However, this direct slot0 reading is faster (no simulation needed) and useful for quick price checks before committing to a full quote.

---

### 2.7 Multi-DEX Config Pattern (trading_bot_v3)

**Source**: `config.json`

~~~json
{
  "UNISWAP": {
    "QUOTER_V3": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    "FACTORY_V3": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "ROUTER_V3": "0xE592427A0AEce92De3Edee1F18E0157C05861564"
  },
  "PANCAKESWAP": {
    "QUOTER_V3": "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    "FACTORY_V3": "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    "ROUTER_V3": "0x1b81D678ffb9C0263b24A97847620C99d213eB14"
  }
}
~~~

**Pattern**: Each DEX is a self-contained config object with Factory, Quoter, and Router addresses. Adding a new DEX means adding another object. This is simpler than flashloan-base's approach.

**Applicability**: LOW — flashloan-base's `constants.ts` already has a cleaner version with typed interfaces and protocol grouping. The trading_bot_v3 pattern is simpler but less type-safe.

---

### 2.8 DEX Swap Event ABI Differences (trading_bot_v3)

**Source**: `helpers/abi.js:8-38`

~~~javascript
// Pancakeswap V3 has different Swap event (extra protocolFees fields)
const IPancakeswapV3Pool = [
  { "anonymous": false, "inputs": [
    // ... standard fields ...
    { "name": "protocolFeesToken0", "type": "uint128" },
    { "name": "protocolFeesToken1", "type": "uint128" }
  ], "name": "Swap", "type": "event" },
  // slot0 also different
]
~~~

**Pattern**: Even between UniV3-compatible DEXes, event ABIs can differ. PancakeSwap V3 adds `protocolFeesToken0/1` fields to the Swap event. Use DEX-specific ABIs to avoid decoding errors.

**Applicability**: HIGH — flashloan-base monitors Aerodrome (which has its own AMM + CL variants). Need DEX-specific Swap event ABIs for reliable event monitoring.

---

### 2.9 Express Server for Monitoring Dashboard (trading_bot_v3)

**Source**: `helpers/server.js:1-9`

~~~javascript
const express = require('express')
const PORT = process.env.PORT || 5000
const app = express();
const server = http.createServer(app).listen(PORT, () => console.log(`Listening on ${PORT}`))
app.use(express.static(path.join(__dirname, 'public')))
app.use(cors({ credentials: true, origin: '*' }))
~~~

**Pattern**: Simple Express server for serving a web dashboard alongside the bot. CORS enabled for cross-origin monitoring.

**Applicability**: LOW — flashloan-base uses a CLI dashboard (terminal-based). A web dashboard could be added later but is not a priority.

---

### 2.10 MasterChef Staking Rewards Math (defi_mc)

**Source**: `contracts/MasterChef.sol:70-85`

~~~solidity
struct UserInfo {
    uint256 amount;     // LP tokens provided
    uint256 rewardDebt; // Reward debt
}

struct PoolInfo {
    IERC20 lpToken;
    uint256 allocPoint;
    uint256 lastRewardBlock;
    uint256 accSushiPerShare; // Accumulated rewards per share * 1e12
}
~~~

**Calculation** (line 159):

~~~solidity
// pending reward = (user.amount * pool.accSushiPerShare) / 1e12 - user.rewardDebt
function pendingSushi(uint256 _pid, address _user) external view returns (uint256) {
    uint256 accSushiPerShare = pool.accSushiPerShare;
    uint256 lpSupply = pool.lpToken.balanceOf(address(this));
    if (block.number > pool.lastRewardBlock && lpSupply != 0) {
        uint256 multiplier = getMultiplier(pool.lastRewardBlock, block.number);
        uint256 sushiReward = multiplier.mul(sushiPerBlock).mul(pool.allocPoint).div(totalAllocPoint);
        accSushiPerShare = accSushiPerShare.add(sushiReward.mul(1e12).div(lpSupply));
    }
    return user.amount.mul(accSushiPerShare).div(1e12).sub(user.rewardDebt);
}
~~~

**Pattern**: The classic "accumulated rewards per share" pattern. Each pool tracks `accSushiPerShare` (scaled by 1e12 for precision). Users track `rewardDebt` — the rewards already accounted for. Pending rewards = `amount * accPerShare / scale - rewardDebt`. On deposit/withdraw, update pool, distribute pending, then update user's `rewardDebt = amount * accPerShare / scale`.

**Applicability**: HIGH — if flashloan-base adds yield farming (leverage farm strategy), this pattern is the gold standard for reward distribution. Could be used for tracking strategy performance rewards or LP incentive programs.

---

### 2.11 Emergency Withdraw Pattern (defi_mc)

**Source**: `contracts/MasterChef.sol:186-193`

~~~solidity
function emergencyWithdraw(uint256 _pid) public {
    PoolInfo storage pool = poolInfo[_pid];
    UserInfo storage user = userInfo[_pid][msg.sender];
    pool.lpToken.safeTransfer(address(msg.sender), user.amount);
    emit EmergencyWithdraw(msg.sender, _pid, user.amount);
    user.amount = 0;
    user.rewardDebt = 0;
}
~~~

**Pattern**: Emergency withdraw forfeits pending rewards but returns the principal immediately. No reward calculations, no updates — just transfer and zero out.

**Applicability**: HIGH — flashloan-base's PositionV2 already has `emergencyWithdraw()` but it's more complex (iterates tokens, tries Aave withdrawal). The simpler pattern from MasterChef — just send assets and zero state — is faster and safer in emergency scenarios.

---

### 2.12 Safe Transfer with Rounding Protection (defi_mc)

**Source**: `contracts/MasterChef.sol:198-205`

~~~solidity
function safeSushiTransfer(address _to, uint256 _amount) internal {
    uint256 sushiBal = sushi.balanceOf(address(this));
    if (_amount > sushiBal) {
        sushi.transfer(_to, sushiBal);
    } else {
        sushi.transfer(_to, _amount);
    }
}
~~~

**Pattern**: When transferring reward tokens, cap at actual balance. This prevents reverts from rounding errors where calculated rewards slightly exceed actual token balance.

**Applicability**: MEDIUM — flashloan-base's `_safeTransfer` uses low-level call for non-standard ERC20. Adding a balance-capped variant would prevent edge-case failures during profit withdrawals.

---

### 2.13 Governance Token with Checkpoints (defi_mc)

**Source**: `contracts/SushiToken.sol:29-60`

~~~solidity
struct Checkpoint {
    uint32 fromBlock;
    uint256 votes;
}
mapping (address => mapping (uint32 => Checkpoint)) public checkpoints;
mapping (address => uint32) public numCheckpoints;

function _moveDelegates(address srcRep, address dstRep, uint256 amount) internal {
    if (srcRep != dstRep && amount > 0) {
        if (srcRep != address(0)) {
            uint32 srcRepNum = numCheckpoints[srcRep];
            uint256 srcRepOld = srcRepNum > 0 ? checkpoints[srcRep][srcRepNum - 1].votes : 0;
            uint256 srcRepNew = srcRepOld.sub(amount);
            _writeCheckpoint(srcRep, srcRepNum, srcRepOld, srcRepNew);
        }
        // Similar for dstRep...
    }
}
~~~

**Pattern**: COMP-style governance token with per-block vote checkpoints. On every transfer, `_moveDelegates` updates vote weights. `getPriorVotes()` uses binary search to find historical voting power at any past block.

**Applicability**: LOW — governance is not needed for the current flashloan-base system. However, if the system ever issues a profit-sharing token, this checkpoint pattern is production-tested.

---

### 2.14 EIP-712 Typed Data Signing (defi_mc)

**Source**: `contracts/SushiToken.sol:123-148`

~~~solidity
bytes32 public constant DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
bytes32 public constant DELEGATION_TYPEHASH =
    keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");

function delegateBySig(address delegatee, uint nonce, uint expiry, uint8 v, bytes32 r, bytes32 s) external {
    bytes32 domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name())), getChainId(), address(this)));
    bytes32 structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, delegatee, nonce, expiry));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    address signatory = ecrecover(digest, v, r, s);
    require(signatory != address(0), "invalid signature");
    require(nonce == nonces[signatory]++, "invalid nonce");
    require(now <= expiry, "signature expired");
    return _delegate(signatory, delegatee);
}
~~~

**Pattern**: EIP-712 typed data signing for gasless delegation. Users sign an off-chain message, and anyone can submit it on-chain. Domain separator includes chain ID to prevent cross-chain replay.

**Applicability**: MEDIUM — could be used for gasless strategy configuration changes, allowing the bot operator to sign config updates off-chain and have a relay submit them.

---

### 2.15 Timelock for Delayed Execution (defi_mc)

**Source**: `contracts/Timelock.sol:58-95`

~~~solidity
uint public constant GRACE_PERIOD = 14 days;
uint public constant MINIMUM_DELAY = 2 days;
uint public constant MAXIMUM_DELAY = 30 days;

function queueTransaction(address target, uint value, string memory signature, bytes memory data, uint eta) public returns (bytes32) {
    require(eta >= getBlockTimestamp().add(delay), "must satisfy delay");
    bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
    queuedTransactions[txHash] = true;
    emit QueueTransaction(txHash, target, value, signature, data, eta);
    return txHash;
}

function executeTransaction(...) public payable returns (bytes memory) {
    require(queuedTransactions[txHash], "not queued");
    require(getBlockTimestamp() >= eta, "not yet");
    require(getBlockTimestamp() <= eta.add(GRACE_PERIOD), "stale");
    queuedTransactions[txHash] = false;
    // Execute call...
}
~~~

**Pattern**: Queue-then-execute with configurable delay (2-30 days), grace period (14 days), and cancellation. Transactions are hashed with all parameters for uniqueness. The `queuedTransactions` mapping prevents replay.

**Applicability**: MEDIUM — if flashloan-base becomes a multi-user system or a DAO, timelocks protect against malicious owner actions. For single-user operation, the existing owner + guardian pattern is sufficient.

---

### 2.16 LP Migration Pattern (defi_mc)

**Source**: `contracts/MasterChef.sol:77-96`

~~~solidity
interface IMigratorChef {
    function migrate(IERC20 token) external returns (IERC20);
}

function migrate(uint256 _pid) public {
    require(address(migrator) != address(0), "no migrator");
    PoolInfo storage pool = poolInfo[_pid];
    IERC20 lpToken = pool.lpToken;
    uint256 bal = lpToken.balanceOf(address(this));
    lpToken.safeApprove(address(migrator), bal);
    IERC20 newLpToken = migrator.migrate(lpToken);
    require(bal == newLpToken.balanceOf(address(this)), "migrate: bad");
    pool.lpToken = newLpToken;
}
~~~

**Pattern**: Pluggable migrator contract for upgrading LP tokens (e.g., migrating from Uniswap V2 LP to SushiSwap LP). The migrator handles the conversion, and the contract verifies balances match.

**Applicability**: MEDIUM — useful if flashloan-base needs to migrate positions between DEX versions (e.g., Aerodrome V1 → V2) or between protocol versions.

---

### 2.17 Multi-Strategy Router with Callback Dispatch (flashloan-base)

**Source**: `contracts/PositionV2.sol:360-395`

~~~solidity
function executeOperation(
    address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params
) external nonReentrant returns (bool) {
    require(msg.sender == AAVE_POOL, "caller not Aave");
    require(initiator == address(this), "not initiator");

    (StrategyType strategy, bytes memory strategyData) =
        abi.decode(params, (StrategyType, bytes));

    if (strategy == StrategyType.LEVERAGE_FARM) {
        if (!currentPosition.isOpen) {
            OpenParams memory op = abi.decode(strategyData, (OpenParams));
            _openLeverageFarm(op, amount, premium);
        } else {
            CloseParams memory cp = abi.decode(strategyData, (CloseParams));
            profit = _closeLeverageFarm(cp, amount, premium);
        }
    } else if (strategy == StrategyType.FLASH_ARB) {
        ArbParams memory ap = abi.decode(strategyData, (ArbParams));
        profit = _executeFlashArb(ap, amount, premium);
    } else if (strategy == StrategyType.TRIANGLE_ARB) {
        TriangleParams memory tp = abi.decode(strategyData, (TriangleParams));
        profit = _executeTriangleArb(tp, amount, premium);
    }

    strategyProfits[strategy] += profit;
    strategyExecutions[strategy]++;
}
~~~

**Pattern**: Single flash loan callback routes to different strategies based on `StrategyType` enum. Each strategy has its own params struct. Open/close state is tracked per strategy. This is more advanced than trading_bot_v3's single-strategy approach.

**Applicability**: Already implemented in flashloan-base. This is a competitive advantage — more extensible than trading_bot_v3.

---

### 2.18 Multi-DEX Type Dispatch (flashloan-base)

**Source**: `contracts/PositionV2.sol:660-690`

~~~solidity
function _swapByType(
    uint8 dexType, address router, address tokenIn, address tokenOut,
    uint256 amountIn, uint256 amountOutMin, uint24 fee
) internal returns (uint256 amountOut) {
    if (dexType == 2) {
        // Aerodrome AMM — stable/volatile pools
        return _swapAMM(router, tokenIn, tokenOut, amountIn, amountOutMin, false);
    } else {
        // dexType 0 (AeroCL) or 1 (UniV3) — both use exactInputSingle
        return _swapCL(router, tokenIn, tokenOut, amountIn, amountOutMin, fee);
    }
}
~~~

**Pattern**: Route swaps to different DEX types using a simple uint8 discriminator. CL DEXes (Aerodrome CL, UniV3) share the same interface. AMM DEXes (Aerodrome AMM) use a different swap function. This is cleaner than trading_bot_v3's hardcoded 2-DEX approach.

**Applicability**: Already implemented. Could be extended with more DEX types (e.g., type 3 = Curve, type 4 = 1inch aggregator).

---

### 2.19 Gas-Adjusted Profitability with Safety Margin (flashloan-base)

**Source**: `src/scanner/arb-engine.ts:60-75`

~~~typescript
interface ProfitabilityCheck {
  profitable: boolean;
  grossProfit: bigint;
  flashFee: bigint;
  gasCost: bigint;
  netProfit: bigint;
  netProfitUSD: number;
  breakEvenBps: number;
  actualSpreadBps: number;
  safetyMargin: number;
}
~~~

**Pattern**: Comprehensive profitability model that factors in flash fee, gas cost, slippage, and provides a safety margin calculation. This goes beyond trading_bot_v3's simpler `amountOut > amountIn` check.

**Applicability**: Already implemented. The `safetyMargin` field is particularly valuable — it quantifies how much room there is between break-even and actual profit.

---

### 2.20 Memecoin Safety Scoring System (flashloan-base)

**Source**: `src/scanner/memecoin-hunter.ts:64-85`

~~~typescript
const RED_FLAG_BYTECODE_PATTERNS = [
  { pattern: "blacklist", weight: -25 },
  { pattern: "blackList", weight: -25 },
  { pattern: "setFee", weight: -10 },
  { pattern: "tradingOpen", weight: -15 },
  { pattern: "sellFee", weight: -15 },
  { pattern: "buyFee", weight: -15 },
];
~~~

**Pattern**: Bytecode analysis of token contracts for honeypot/rug-pull indicators. Each red flag has a weight that reduces the safety score (0-100). Combined with holder analysis, liquidity scoring, and DEXScreener data.

**Applicability**: Unique to flashloan-base. Neither trading_bot_v3 nor defi_mc has anything comparable. This is a competitive advantage.

---

### 2.21 Execution Lock / Recursion Guard (trading_bot_v3)

**Source**: `bot.js:28-29, 44-49`

~~~javascript
let isExecuting = false

const eventHandler = async (_uPool, _pPool, _token0, _token1) => {
  if (!isExecuting) {
    isExecuting = true
    // ... execute trade ...
    isExecuting = false
  }
}
~~~

**Pattern**: Simple boolean lock prevents the bot from executing overlapping trades. If a swap event fires while already executing, it's skipped. This prevents double-spending flash loans.

**Applicability**: HIGH — flashloan-base doesn't have an off-chain execution lock. While the contract has `nonReentrant`, the TypeScript scanners could potentially fire multiple transactions in rapid succession. Adding an off-chain lock is critical.

---

### 2.22 Aave V3 Health Factor Monitoring (flashloan-base)

**Source**: `contracts/PositionV2.sol:140-142, 810-815`

~~~solidity
uint256 public healthFactorThreshold = 1.1e18;

function getHealthFactor() public view returns (uint256) {
    (,,,,, uint256 hf) = IPool(AAVE_POOL).getUserAccountData(address(this));
    return hf;
}

function isPositionSafe() public view returns (bool) {
    return getHealthFactor() > healthFactorThreshold;
}
~~~

**Pattern**: Real-time health factor monitoring from Aave V3. The contract checks `healthFactor > threshold` before opening positions and after withdrawals. The threshold is configurable by the owner.

**Applicability**: Already implemented. This is more sophisticated than trading_bot_v3 (no leverage positions) or defi_mc (no lending).

---

### 2.23 Big.js for Arbitrary Precision BigInt Math (trading_bot_v3)

**Source**: `bot.js:2, helpers/helpers.js:4`

~~~javascript
const Big = require('big.js')

// Used for precise decimal arithmetic alongside BigInt
const percentage = Big(0.5)
const minAmount = Big(liquidity[1]).mul(percentage)
const minAmountRounded = BigInt(minAmount.round().toFixed(0))
~~~

**Pattern**: BigInt has no decimal support. Big.js fills the gap for percentage calculations, price normalization, and any math requiring fractional precision. Convert back to BigInt for on-chain calls.

**Applicability**: MEDIUM — flashloan-base uses native ethers.js v6 formatting. Big.js could improve precision in profitability calculations where floating-point errors matter.

---

### 2.24 Hardhat Ignition Declarative Deployment (trading_bot_v3)

**Source**: `ignition/modules/Arbitrage.js`

~~~javascript
const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("TokenModule", (m) => {
  const DEPLOYER = m.getAccount(0)
  const Arbitrage = m.contract("Arbitrage", [], { from: DEPLOYER })
  return { Arbitrage }
});
~~~

**Pattern**: Declarative deployment module. Ignition handles retry logic, gas estimation, and multi-contract ordering. Simpler than migration scripts.

**Applicability**: LOW — flashloan-base uses Hardhat scripts for deployment. Ignition is a nice improvement for reliability but not essential.

---

---

## 3. Recommended Integrations

### 3.1 WebSocket Swap Event Monitoring (from trading_bot_v3)

**Priority**: HIGH
**Effort**: Medium (2-3 days)

Port the event-driven monitoring from `bot.js:41-43` to Base chain. Replace 15-second polling with WebSocket listeners on Aerodrome and Uniswap V3 pool Swap events.

~~~typescript
// Proposed: src/scanner/websocket-monitor.ts
import { ethers } from "ethers";

const wsProvider = new ethers.WebSocketProvider(
  `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
);

// Subscribe to pool Swap events
aeroPool.on("Swap", (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
  onSwapDetected("aerodrome", { amount0, amount1, sqrtPriceX96 });
});

uniPool.on("Swap", (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
  onSwapDetected("uniswap", { amount0, amount1, sqrtPriceX96 });
});
~~~

**Acceptance criteria**: Price updates within 200ms of on-chain swap. Graceful WebSocket reconnection on disconnect.

---

### 3.2 Off-Chain Execution Lock (from trading_bot_v3)

**Priority**: HIGH
**Effort**: Small (half day)

Add a simple execution lock to prevent concurrent trade submissions from the TypeScript scanners.

~~~typescript
// Proposed: src/scanner/execution-lock.ts
class ExecutionLock {
  private locked = false;

  async acquire(): Promise<boolean> {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    this.locked = false;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!await this.acquire()) return null;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
~~~

**Acceptance criteria**: Only one trade execution at a time. Lock released on success or failure.

---

### 3.3 Liquidity-Based Position Sizing (from trading_bot_v3)

**Priority**: MEDIUM
**Effort**: Small (1 day)

Before executing an arbitrage, check the actual pool liquidity and cap the flash loan amount to avoid excessive slippage.

~~~typescript
// Proposed: src/scanner/position-sizer.ts
function calculateOptimalSize(
  poolLiquidity: bigint,
  maxLiquidityPercent: number = 0.3,  // Use at most 30% of pool liquidity
  maxFlashAmount: bigint
): bigint {
  const maxSize = (poolLiquidity * BigInt(Math.floor(maxLiquidityPercent * 10000))) / 10000n;
  return maxSize < maxFlashAmount ? maxSize : maxFlashAmount;
}
~~~

**Acceptance criteria**: No trade exceeds X% of pool liquidity. Slippage reduced by Y% compared to fixed-size trades.

---

### 3.4 Balancer V2 Flash Loan as Secondary Provider (from trading_bot_v3)

**Priority**: MEDIUM
**Effort**: Medium (2-3 days)

Add Balancer Vault (0xBA12222222228d8Ba445958a75a0704d566BF2C8) as a fallback flash loan source. Balancer supports multi-token flash loans which could enable more complex strategies.

~~~solidity
// Proposed addition to PositionV2.sol
import {IVault} from "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import {IFlashLoanRecipient} from "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";

address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

function executeArbViaBalancer(ArbParams calldata params) external onlyOwner {
    IERC20[] memory tokens = new IERC20[](1);
    tokens[0] = IERC20(params.flashAsset);
    uint256[] memory amounts = new uint256[](1);
    amounts[0] = params.flashAmount;
    IVault(BALANCER_VAULT).flashLoan(this, tokens, amounts, abi.encode(params));
}
~~~

**Acceptance criteria**: Successfully execute an arbitrage using Balancer flash loan on Base. Compare gas costs with Aave.

---

### 3.5 Direct slot0 Price Reading for Fast Checks (from trading_bot_v3)

**Priority**: MEDIUM
**Effort**: Small (half day)

Add `slot0()` reading as a fast pre-filter before committing to Quoter simulations.

~~~typescript
// Proposed: src/scanner/fast-price.ts
async function getQuickPrice(pool: ethers.Contract): Promise<bigint> {
  const [sqrtPriceX96] = await pool.slot0();
  // price = (sqrtPriceX96 / 2^96)^2
  const Q96 = 1n << 96n;
  const price = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
  return price;
}
~~~

**Acceptance criteria**: Price check completes in <50ms. Used as pre-filter to skip Quoter calls when spread is clearly below threshold.

---

### 3.6 DEX-Specific Event ABIs (from trading_bot_v3)

**Priority**: MEDIUM
**Effort**: Small (1 day)

Define separate Swap event ABIs for Aerodrome CL, Aerodrome AMM, and Uniswap V3 on Base to avoid event decoding failures.

~~~typescript
// Proposed: src/scanner/dex-abis.ts
export const AERO_CL_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

export const AERO_AMM_SWAP_ABI = [
  "event Swap(address indexed sender, uint amount0Out, uint amount1Out, uint amount0In, uint amount1In, address indexed to)"
];

export const UNIV3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
~~~

**Acceptance criteria**: Successfully decode Swap events from all 3 DEX types without errors.

---

### 3.7 Emergency Withdraw Simplification (from defi_mc)

**Priority**: MEDIUM
**Effort**: Small (half day)

Simplify the emergency withdraw function to follow MasterChef's pattern — just transfer and zero out, no complex Aave withdrawal attempts.

~~~solidity
// Simplified proposal for PositionV2.sol
function emergencyWithdrawSimple(address[] calldata tokens) external onlyOwner {
    paused = true;
    for (uint256 i; i < tokens.length;) {
        uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
        if (bal > 0) _safeTransfer(tokens[i], owner, bal);
        unchecked { ++i; }
    }
    // Zero out position state
    currentPosition = PositionInfo({
        collateralAsset: address(0), debtAsset: address(0),
        collateralAmount: 0, debtAmount: 0, isOpen: false,
        strategy: StrategyType.LEVERAGE_FARM, openedAt: 0
    });
    emit EmergencyWithdraw(address(0), 0, owner);
}
~~~

**Acceptance criteria**: Emergency withdraw completes in a single transaction without try/catch.

---

### 3.8 Per-Block Profit Tracking with Accumulated Rewards Pattern (from defi_mc)

**Priority**: LOW
**Effort**: Medium (2 days)

Adapt the MasterChef `accSushiPerShare` pattern for tracking per-strategy profit on-chain, enabling historical performance queries.

~~~solidity
// Proposed tracking pattern
struct StrategyMetrics {
    uint256 totalProfit;
    uint256 executions;
    uint256 lastExecutionBlock;
    uint256 accProfitPerExecution; // average profit per execution * 1e18
}
mapping(StrategyType => StrategyMetrics) public strategyMetrics;
~~~

**Acceptance criteria**: Can query average profit per execution for each strategy type.

---

---

## 4. Priority Ranking

### HIGH Priority (Implement First)

| # | Pattern | Source | Value | Effort | Rationale |
|---|---------|--------|-------|--------|-----------|
| 1 | WebSocket Event Monitoring | trading_bot_v3 | High | 2-3d | 200ms vs 15s latency; critical for MEV competition |
| 2 | Off-Chain Execution Lock | trading_bot_v3 | High | 0.5d | Prevents double-spending flash loans |
| 3 | DEX-Specific Event ABIs | trading_bot_v3 | High | 1d | Required for reliable event monitoring |
| 4 | Direction Determination Logic | trading_bot_v3 | Medium | 0.5d | Cleaner arb direction separation |

### MEDIUM Priority (Implement Next)

| # | Pattern | Source | Value | Effort | Rationale |
|---|---------|--------|-------|--------|-----------|
| 5 | Liquidity-Based Position Sizing | trading_bot_v3 | Medium | 1d | Reduces slippage on large trades |
| 6 | Balancer V2 Flash Loan Fallback | trading_bot_v3 | Medium | 2-3d | Provider redundancy, multi-token loans |
| 7 | slot0 Fast Price Check | trading_bot_v3 | Medium | 0.5d | Pre-filter before expensive Quoter calls |
| 8 | QuoterV2 Output-Side Simulation | trading_bot_v3 | Medium | 1d | Optimal position sizing |
| 9 | Emergency Withdraw Simplification | defi_mc | Medium | 0.5d | Faster, safer emergency path |
| 10 | EIP-712 Gasless Config Signing | defi_mc | Medium | 2d | Gasless strategy parameter updates |
| 11 | Big.js Precise Math | trading_bot_v3 | Low | 0.5d | Better precision in profitability calcs |

### LOW Priority (Nice to Have)

| # | Pattern | Source | Value | Effort | Rationale |
|---|---------|--------|-------|--------|-----------|
| 12 | Governance Token Checkpoints | defi_mc | Low | 3d | Only needed for DAO/governance |
| 13 | Timelock Delayed Execution | defi_mc | Low | 2d | Only needed for multi-user systems |
| 14 | LP Migration Pattern | defi_mc | Low | 1d | Only needed for DEX version upgrades |
| 15 | Express Web Dashboard | trading_bot_v3 | Low | 2d | CLI dashboard is sufficient for now |
| 16 | Hardhat Ignition Deployment | trading_bot_v3 | Low | 1d | Current script deployment works |
| 17 | Accumulated Rewards Per Share | defi_mc | Low | 2d | Only needed for yield farming rewards |
| 18 | Multi-DEX Config Pattern | trading_bot_v3 | Low | 0.5d | Already have better typed version |

---

## 5. Gap Analysis — Missing Patterns Not Found in Any Source

These are patterns NOT found in any of the three codebases but relevant to flashloan-base:

| Missing Pattern | Description | External Sources |
|---|---|---|
| **Liquidation Bot** | Aave V3 liquidation with flash loan + collateral swap | Aave liquidation docs, DeFi Saver |
| **Sandwich Attack** | Mempool monitoring + JIT liquidity | Flashbots docs, MEV research |
| **JIT Liquidity** | Provide concentrated liquidity just-in-time for large swaps | Uniswap V4 hooks research |
| **Cross-Chain MEV** | Arbitrage across L1/L2 boundaries | Across Protocol, CCIP |
| **Perps Integration** | GMX/Synthetix/Hyperliquid funding rate arb | GMX SDK, Synthetix Perps |
| **Yield Aggregator** | Yearn/Beefy/Convex auto-compounding | Yearn vault contracts |
| **Backtesting Framework** | Historical data replay for strategy validation | Gelato, Chainlink data feeds |
| **MEV Protection** | Flashbots Protect RPC, private mempool | Flashbots Protect docs |
| **Gas Optimization** | Assembly swaps, storage packing, multicall | Solady, Gasleft.io |
| **Price Oracle Integration** | Chainlink feeds as sanity check | Chainlink Data Feeds |

---

## 6. Architecture Comparison Diagrams

### trading_bot_v3 Flow

~~~
Swap Event → checkPrice() → determineDirection() → determineProfitability() → executeTrade()
     ↓              ↓                    ↓                       ↓                    ↓
  WebSocket    slot0() price      spread >= 0.5%?       QuoterV2.simulate     Balancer.flashLoan()
               comparison         buy/sell ordering     Big.js math            → receiveFlashLoan()
                                                                               → swap DEX1
                                                                               → swap DEX2
                                                                               → repay + profit
~~~

### flashloan-base Flow

~~~
15s Poll → scan() → scanLeverageFarming() + scanArbitrageOpportunities() + scanMemecoins()
                ↓                              ↓                                    ↓
        Aave rate comparison         Cross-DEX price quotes          DEXScreener API
        supply APY > borrow APY?     Aerodrome vs UniV3 vs BaseSwap   Safety scoring
                ↓                              ↓                                    ↓
        LeverageOpportunity           ArbPath (simple/triangle)     MemecoinCandidate
                ↓                              ↓                                    ↓
        executeTrade()               executeArbitrage()            executeArbitrage()
        via PositionV2.sol            via PositionV2.sol              via PositionV2.sol
        StrategyType enum             ArbParams struct               ArbParams struct
~~~

### Key Architectural Difference

trading_bot_v3 uses a **reactive** pattern (event-driven) while flashloan-base uses a **proactive** pattern (polling). The ideal system combines both: WebSocket events trigger immediate scans, while periodic polling catches opportunities that don't generate Swap events (e.g., rate changes in Aave).

---

*Report generated by Agent Zero Deep Research. Source files analyzed: 30+ across 3 codebases (trading_bot_v3, defi_mc, flashloan-base).*
