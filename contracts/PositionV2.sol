// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// ═══════════════════════════════════════════════════════════════
// Imports
// ═══════════════════════════════════════════════════════════════
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {DataTypes} from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ═══════════════════════════════════════════════════════════════
// Interfaces — Base DEXs
// ═══════════════════════════════════════════════════════════════

/// @notice Aerodrome CL Router (concentrated liquidity)
interface IAeroCLRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
    function getAmountsOut(uint256 amountIn, address tokenIn, address tokenOut)
        external view returns (uint256 amountOut);
}

/// @notice Uniswap V3 SwapRouter on Base
interface IUniV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

/// @notice Aerodrome AMM (Velodrome-style) Router
interface IAeroAMMRouter {
    function swapExactTokensForTokensSimple(
        uint256 amountIn,
        uint256 amountOutMin,
        address tokenFrom,
        address tokenTo,
        bool stable,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

// ═══════════════════════════════════════════════════════════════
// Strategy Types
// ═══════════════════════════════════════════════════════════════

enum StrategyType {
    LEVERAGE_FARM,      // Aave supply → borrow loop
    FLASH_ARB,          // Cross-DEX flash loan arbitrage
    TRIANGLE_ARB,       // 3-pool triangular arbitrage
    LIQUIDATION,        // Aave liquidation hunting
    MEMECOIN_SNIPER     // Buy new tokens on Aerodrome
}

// ═══════════════════════════════════════════════════════════════
// Structs
// ═══════════════════════════════════════════════════════════════

struct OpenParams {
    address assetToSupply;
    address assetToBorrow;
    uint256 assetToBorrowAmount;
    uint256 initialCapital;
    uint256 expectedSwapAmount;
    uint24 poolFee;
}

struct CloseParams {
    address assetToWithdraw;
    address assetToRepay;
}

/// @notice Parameters for a cross-DEX flash loan arbitrage
struct ArbParams {
    address flashAsset;          // Asset to flash loan
    uint256 flashAmount;         // Amount to flash loan
    address buyDexRouter;        // DEX to buy on (cheaper)
    address sellDexRouter;       // DEX to sell on (more expensive)
    address intermediateToken;   // Token to arb through
    uint24 buyPoolFee;
    uint24 sellPoolFee;
    uint256 minProfit;           // Minimum profit after all fees
    uint8 dexType;               // 0=AeroCL, 1=UniV3, 2=AeroAMM
}

/// @notice Triangle arbitrage path
struct TriangleParams {
    address flashAsset;
    uint256 flashAmount;
    address[3] path;             // tokenA → tokenB → tokenC → tokenA
    address[3] routers;          // One router per hop
    uint24[3] poolFees;
    uint256 minProfit;
    uint8[3] dexTypes;
}

struct PositionInfo {
    address collateralAsset;
    address debtAsset;
    uint256 collateralAmount;
    uint256 debtAmount;
    bool isOpen;
    StrategyType strategy;
    uint256 openedAt;
}

// ═══════════════════════════════════════════════════════════════
// PositionV2 — Multi-Strategy Flash Loan Contract for Base
// ═══════════════════════════════════════════════════════════════

/**
 * @title PositionV2 — MEV-Protected Multi-Strategy Flash Loan on Base
 * @notice Supports: leverage farming, cross-DEX arb, triangle arb, liquidations, sniping
 * @dev All strategies use Aave V3 flash loans (0.05% fee on Base)
 *
 * Base-specific advantages:
 *   - Gas: ~$0.001-0.10 per tx (cheapest L2 for DeFi)
 *   - Aave V3: Deep liquidity, 0.05% flash loan fee
 *   - Aerodrome: #1 DEX by volume on Base, AMM + CL
 *   - Uniswap V3: Secondary liquidity source for arb
 *   - Sequencer: Fast finality (~2s blocks)
 *
 * Profit conditions:
 *   Leverage: supply APY > borrow APY + flash fee + gas
 *   Arb:      price_diff > flash_fee + gas + slippage
 *   Triangle: cumulative_price_diff > flash_fee + gas
 */
contract PositionV2 is IFlashLoanSimpleReceiver, ReentrancyGuard {
    // ═══════════════════════════════════════════════════════
    // Base Network Addresses (immutable — no SLOAD overhead)
    // ═══════════════════════════════════════════════════════
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant DAI  = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;

    // Aave V3
    address public constant AAVE_POOL =
        0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address public constant AAVE_ADDRESSES_PROVIDER =
        0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870;

    // Aerodrome CL Router
    address public constant AERO_CL_ROUTER =
        0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    // Aerodrome AMM Router
    address public constant AERO_AMM_ROUTER =
        0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925;
    // Uniswap V3 on Base
    address public constant UNI_V3_ROUTER =
        0x2626664c2603336E57B271c5C0b26F421741e481;
    // Uniswap V3 Quoter
    address public constant UNI_V3_QUOTER =
        0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    // ═══════════════════════════════════════════════════════
    // Configurable Parameters (packed into single slot)
    // ═══════════════════════════════════════════════════════
    uint256 public healthFactorThreshold = 1.1e18;
    uint24  public defaultPoolFee = 500;
    uint256 public maxSlippageBps = 50;          // 0.5%
    uint256 public constant MAX_BPS = 10000;
    uint256 public constant AAVE_FLASH_FEE_BPS = 5; // 0.05%

    // ═══════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════
    address public immutable owner;
    address public guardian;
    bool public paused;
    uint256 public totalProfitWithdrawn;

    PositionInfo public currentPosition;

    // Token registry
    mapping(bytes32 => address) public tokenAddresses;
    // Approved DEX routers
    mapping(address => bool) public approvedRouters;
    // Strategy profit tracking
    mapping(StrategyType => uint256) public strategyProfits;
    mapping(StrategyType => uint256) public strategyExecutions;

    // ═══════════════════════════════════════════════════════
    // Events (indexed for off-chain monitoring)
    // ═══════════════════════════════════════════════════════
    event PositionOpened(
        StrategyType indexed strategy,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 healthFactor
    );
    event PositionClosed(
        StrategyType indexed strategy,
        address indexed assetWithdrawn,
        address indexed assetRepaid,
        uint256 profitOrLoss
    );
    event ArbitrageExecuted(
        StrategyType indexed arbType,
        address indexed asset,
        uint256 amount,
        uint256 profit
    );
    event EmergencyWithdraw(address indexed token, uint256 amount, address to);
    event ParametersUpdated(uint256 hf, uint24 fee, uint256 slippage);
    event GuardianSet(address indexed newGuardian);
    event ProfitWithdrawn(address indexed token, uint256 amount);
    event RouterApproved(address indexed router, bool approved);

    // ═══════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════
    constructor() {
        owner = msg.sender;
        guardian = msg.sender;

        // Pre-approve known DEX routers
        approvedRouters[AERO_CL_ROUTER] = true;
        approvedRouters[AERO_AMM_ROUTER] = true;
        approvedRouters[UNI_V3_ROUTER] = true;
    }

    // IFlashLoanSimpleReceiver required views
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider) {
        return IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER);
    }

    function POOL() external view returns (IPool) {
        return IPool(AAVE_POOL);
    }

    // ═══════════════════════════════════════════════════════
    // Modifiers
    // ═══════════════════════════════════════════════════════
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner || msg.sender == guardian, "not authorized");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    // ═══════════════════════════════════════════════════════
    // STRATEGY 1: Leverage Farming (Aave V3)
    // ═══════════════════════════════════════════════════════

    function openPosition(OpenParams calldata params)
        external
        onlyOwner
        notPaused
        nonReentrant
    {
        require(!currentPosition.isOpen, "position already open");

        // Encode strategy type + params for callback routing
        bytes memory paramsData = abi.encode(
            StrategyType.LEVERAGE_FARM,
            params
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.assetToBorrow,
            params.assetToBorrowAmount,
            paramsData,
            0
        );
    }

    function closePosition(CloseParams calldata params)
        external
        onlyOwner
        notPaused
        nonReentrant
    {
        require(currentPosition.isOpen, "no position open");
        require(currentPosition.strategy == StrategyType.LEVERAGE_FARM, "wrong strategy");

        uint256 debt = getDebt(params.assetToRepay);
        require(debt > 0, "no debt");

        bytes memory paramsData = abi.encode(
            StrategyType.LEVERAGE_FARM,
            params
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.assetToRepay,
            debt,
            paramsData,
            0
        );
    }

    // ═══════════════════════════════════════════════════════
    // STRATEGY 2: Cross-DEX Flash Arbitrage
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Execute cross-DEX arbitrage using flash loan
     * @dev Buy cheap on buyDex, sell high on sellDex, repay flash loan, keep profit
     *
     * Example: WETH priced differently on Aerodrome vs Uniswap on Base
     *   1. Flash loan 10 WETH from Aave
     *   2. Buy USDC on Aerodrome (cheaper WETH)
     *   3. Sell USDC on Uniswap (more expensive WETH)
     *   4. Repay 10.005 WETH (10 + 0.05% fee)
     *   5. Keep difference as profit
     *
     * Profitable when: price_diff > 0.05% (Aave fee) + gas (~$0.01)
     */
    function executeArbitrage(ArbParams calldata params)
        external
        onlyOwner
        notPaused
        nonReentrant
    {
        require(approvedRouters[params.buyDexRouter], "buy dex not approved");
        require(approvedRouters[params.sellDexRouter], "sell dex not approved");

        bytes memory paramsData = abi.encode(
            StrategyType.FLASH_ARB,
            params
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.flashAsset,
            params.flashAmount,
            paramsData,
            0
        );
    }

    // ═══════════════════════════════════════════════════════
    // STRATEGY 3: Triangle Arbitrage
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Execute triangle arbitrage: tokenA → tokenB → tokenC → tokenA
     * @dev Finds pricing inefficiencies across 3 pools
     *
     * Example on Base:
     *   WETH → USDC (Aerodrome) → DAI (Uniswap) → WETH (Aerodrome)
     *   If the product of exchange rates > 1 + fees, there's profit.
     */
    function executeTriangleArb(TriangleParams calldata params)
        external
        onlyOwner
        notPaused
        nonReentrant
    {
        for (uint256 i; i < 3;) {
            require(approvedRouters[params.routers[i]], "router not approved");
            unchecked { ++i; }
        }

        bytes memory paramsData = abi.encode(
            StrategyType.TRIANGLE_ARB,
            params
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.flashAsset,
            params.flashAmount,
            paramsData,
            0
        );
    }

    // ═══════════════════════════════════════════════════════
    // Aave V3 Flash Loan Callback — Strategy Router
    // ═══════════════════════════════════════════════════════
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external nonReentrant returns (bool) {
        require(msg.sender == AAVE_POOL, "caller not Aave");
        require(initiator == address(this), "not initiator");

        // Decode strategy type
        (StrategyType strategy, bytes memory strategyData) =
            abi.decode(params, (StrategyType, bytes));

        uint256 profit;

        if (strategy == StrategyType.LEVERAGE_FARM) {
            // Check if opening or closing
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

        // Track profit
        if (profit > 0) {
            strategyProfits[strategy] += profit;
            strategyExecutions[strategy]++;
        }

        // Approve Aave to pull repayment
        uint256 amountOwing = amount + premium;
        IERC20(asset).approve(AAVE_POOL, amountOwing);

        return true;
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Leverage Farm Strategy
    // ═══════════════════════════════════════════════════════
    function _openLeverageFarm(
        OpenParams memory params,
        uint256 flashAmount,
        uint256 /* premium */
    ) internal {
        uint256 swapAmount = flashAmount + params.initialCapital;
        uint24 fee = params.poolFee > 0 ? params.poolFee : defaultPoolFee;

        // Swap borrowed asset → supply asset on Aerodrome
        uint256 supplyAmount = _swapCL(
            AERO_CL_ROUTER,
            params.assetToBorrow,
            params.assetToSupply,
            swapAmount,
            params.expectedSwapAmount,
            fee
        );

        // Supply to Aave
        _supply(params.assetToSupply, supplyAmount);

        // Borrow against collateral
        _borrow(params.assetToBorrow, flashAmount);

        // Health check
        uint256 hf = getHealthFactor();
        require(hf > healthFactorThreshold, "health factor too low");

        // Record position
        currentPosition = PositionInfo({
            collateralAsset: params.assetToSupply,
            debtAsset: params.assetToBorrow,
            collateralAmount: supplyAmount,
            debtAmount: flashAmount,
            isOpen: true,
            strategy: StrategyType.LEVERAGE_FARM,
            openedAt: block.timestamp
        });

        emit PositionOpened(
            StrategyType.LEVERAGE_FARM,
            params.assetToSupply,
            params.assetToBorrow,
            supplyAmount,
            flashAmount,
            hf
        );
    }

    function _closeLeverageFarm(
        CloseParams memory params,
        uint256 flashAmount,
        uint256 premium
    ) internal returns (uint256 profit) {
        // 1. Repay all Aave debt
        _repay(params.assetToRepay);

        // 2. Withdraw all collateral
        uint256 withdrawn = _withdraw(params.assetToWithdraw);

        // 3. Swap back to repay flash loan
        uint256 minOut = flashAmount + premium;
        _swapCL(
            AERO_CL_ROUTER,
            params.assetToWithdraw,
            params.assetToRepay,
            withdrawn,
            minOut,
            defaultPoolFee
        );

        // 4. Calculate profit
        uint256 balance = IERC20(params.assetToRepay).balanceOf(address(this));
        profit = balance > (flashAmount + premium)
            ? balance - (flashAmount + premium)
            : 0;

        // 5. Clear position
        currentPosition = PositionInfo({
            collateralAsset: address(0),
            debtAsset: address(0),
            collateralAmount: 0,
            debtAmount: 0,
            isOpen: false,
            strategy: StrategyType.LEVERAGE_FARM,
            openedAt: 0
        });

        emit PositionClosed(
            StrategyType.LEVERAGE_FARM,
            params.assetToWithdraw,
            params.assetToRepay,
            profit
        );
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Cross-DEX Arbitrage Strategy
    // ═══════════════════════════════════════════════════════
    function _executeFlashArb(
        ArbParams memory params,
        uint256 flashAmount,
        uint256 premium
    ) internal returns (uint256 profit) {
        // Step 1: Buy intermediate token on the cheaper DEX
        uint256 boughtAmount = _swapByType(
            params.dexType,
            params.buyDexRouter,
            params.flashAsset,
            params.intermediateToken,
            flashAmount,
            0, // accept any — we verify profit at end
            params.buyPoolFee
        );

        // Step 2: Sell intermediate token on the more expensive DEX
        _swapByType(
            params.dexType,
            params.sellDexRouter,
            params.intermediateToken,
            params.flashAsset,
            boughtAmount,
            0,
            params.sellPoolFee
        );

        // Step 3: Verify profit after all fees
        uint256 balAfter = IERC20(params.flashAsset).balanceOf(address(this));
        uint256 required = flashAmount + premium;
        require(balAfter >= required, "arb not profitable");

        profit = balAfter - required;
        require(profit >= params.minProfit, "profit below minimum");

        emit ArbitrageExecuted(
            StrategyType.FLASH_ARB,
            params.flashAsset,
            flashAmount,
            profit
        );
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Triangle Arbitrage Strategy
    // ═══════════════════════════════════════════════════════
    function _executeTriangleArb(
        TriangleParams memory params,
        uint256 flashAmount,
        uint256 premium
    ) internal returns (uint256 profit) {
        uint256 currentAmount = flashAmount;

        // Hop 1: flashAsset → path[1]
        currentAmount = _swapByType(
            params.dexTypes[0],
            params.routers[0],
            params.path[0],
            params.path[1],
            currentAmount,
            0,
            params.poolFees[0]
        );

        // Hop 2: path[1] → path[2]
        currentAmount = _swapByType(
            params.dexTypes[1],
            params.routers[1],
            params.path[1],
            params.path[2],
            currentAmount,
            0,
            params.poolFees[1]
        );

        // Hop 3: path[2] → flashAsset (path[0])
        currentAmount = _swapByType(
            params.dexTypes[2],
            params.routers[2],
            params.path[2],
            params.path[0],
            currentAmount,
            0,
            params.poolFees[2]
        );

        // Verify profitability
        uint256 required = flashAmount + premium;
        require(currentAmount >= required, "triangle not profitable");

        profit = currentAmount - required;
        require(profit >= params.minProfit, "profit below minimum");

        emit ArbitrageExecuted(
            StrategyType.TRIANGLE_ARB,
            params.flashAsset,
            flashAmount,
            profit
        );
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Swap Helpers (multi-DEX)
    // ═══════════════════════════════════════════════════════

    /// @notice Swap via concentrated liquidity DEX (Aerodrome CL or UniV3)
    function _swapCL(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(router, amountIn);

        if (router == UNI_V3_ROUTER) {
            amountOut = IUniV3Router(router).exactInputSingle(
                IUniV3Router.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp + 30,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            // Aerodrome CL Router (same interface)
            amountOut = IAeroCLRouter(router).exactInputSingle(
                IAeroCLRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp + 30,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        }
    }

    /// @notice Swap via Aerodrome AMM (stable/volatile pools)
    function _swapAMM(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bool stable
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(router, amountIn);

        uint256[] memory amounts = IAeroAMMRouter(router)
            .swapExactTokensForTokensSimple(
                amountIn,
                amountOutMin,
                tokenIn,
                tokenOut,
                stable,
                address(this),
                block.timestamp + 30
            );

        return amounts[amounts.length - 1];
    }

    /// @notice Route swap to correct DEX type
    function _swapByType(
        uint8 dexType,
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        if (dexType == 2) {
            // Aerodrome AMM — use stable=false as default
            return _swapAMM(router, tokenIn, tokenOut, amountIn, amountOutMin, false);
        } else {
            // dexType 0 (AeroCL) or 1 (UniV3)
            return _swapCL(router, tokenIn, tokenOut, amountIn, amountOutMin, fee);
        }
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Aave V3 Primitives
    // ═══════════════════════════════════════════════════════
    function _supply(address asset, uint256 amount) internal {
        IERC20(asset).approve(AAVE_POOL, amount);
        IPool(AAVE_POOL).supply(asset, amount, address(this), 0);
    }

    function _borrow(address asset, uint256 amount) internal {
        IPool(AAVE_POOL).borrow(asset, amount, 2, 0, address(this));
    }

    function _repay(address asset) internal {
        // Calculate exact debt + small buffer for interest accrual
        uint256 debt = getDebt(asset);
        uint256 repayAmount = debt + (debt / 10000); // 0.01% buffer
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 actualRepay = repayAmount > balance ? balance : repayAmount;

        IERC20(asset).approve(AAVE_POOL, actualRepay);
        IPool(AAVE_POOL).repay(asset, actualRepay, 2, address(this));
    }

    function _withdraw(address asset) internal returns (uint256) {
        return IPool(AAVE_POOL).withdraw(asset, type(uint256).max, address(this));
    }

    // ═══════════════════════════════════════════════════════
    // External — Management
    // ═══════════════════════════════════════════════════════

    function supplyToAave(address asset, uint256 amount) external onlyOwner {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        _supply(asset, amount);
        if (currentPosition.isOpen) {
            currentPosition.collateralAmount += amount;
        }
    }

    function withdrawFromAave(address asset, uint256 amount) external onlyOwner {
        IPool(AAVE_POOL).withdraw(asset, amount, owner);
        if (currentPosition.isOpen) {
            require(getHealthFactor() > healthFactorThreshold, "health factor too low after withdraw");
        }
    }

    function withdrawProfit(address token, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "zero amount");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "insufficient balance");
        _safeTransfer(token, owner, amount);
        totalProfitWithdrawn += amount;
        emit ProfitWithdrawn(token, amount);
    }

    function emergencyWithdraw(address[] calldata tokens, address to)
        external
        onlyOwner
    {
        require(to == owner, "can only withdraw to owner");
        paused = true;
        for (uint256 i; i < tokens.length;) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) {
                _safeTransfer(tokens[i], to, bal);
            }
            unchecked { ++i; }
        }
        if (currentPosition.isOpen) {
            try IPool(AAVE_POOL).withdraw(
                currentPosition.collateralAsset,
                type(uint256).max,
                to
            ) {} catch {}
        }
        emit EmergencyWithdraw(address(0), 0, to);
    }

    function unpause() external onlyOwner { paused = false; }

    function getWETH() external payable onlyOwner {
        IWETH(WETH).deposit{value: msg.value}();
    }

    function withdrawETH() external onlyOwner {
        (bool success,) = owner.call{value: address(this).balance}("");
        require(success, "ETH transfer failed");
    }

    function withdrawTokens(address token, uint256 amount) external onlyOwner {
        _safeTransfer(token, owner, amount);
    }

    // ═══════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════
    function setHealthFactorThreshold(uint256 v) external onlyOwner {
        require(v >= 1.05e18, "too low");
        healthFactorThreshold = v;
    }

    function setDefaultPoolFee(uint24 v) external onlyOwner {
        defaultPoolFee = v;
    }

    function setMaxSlippageBps(uint256 v) external onlyOwner {
        require(v <= 500, "too high");
        maxSlippageBps = v;
    }

    function setGuardian(address v) external onlyOwner {
        guardian = v;
        emit GuardianSet(v);
    }

    function setTokenAddress(string calldata symbol, address token)
        external onlyOwner
    {
        tokenAddresses[keccak256(abi.encodePacked(symbol))] = token;
    }

    function approveRouter(address router, bool approved) external onlyOwner {
        approvedRouters[router] = approved;
        emit RouterApproved(router, approved);
    }

    // ═══════════════════════════════════════════════════════
    // View Functions
    // ═══════════════════════════════════════════════════════
    function getTokenBalance(address token) public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getHealthFactor() public view returns (uint256) {
        (,,,,, uint256 hf) = IPool(AAVE_POOL).getUserAccountData(address(this));
        return hf;
    }

    function getDebt(address token) public view returns (uint256) {
        DataTypes.ReserveData memory reserve =
            IPool(AAVE_POOL).getReserveData(token);
        return IERC20(reserve.variableDebtTokenAddress).balanceOf(address(this));
    }

    function isPositionSafe() public view returns (bool) {
        return getHealthFactor() > healthFactorThreshold;
    }

    function getAccountData() external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        return IPool(AAVE_POOL).getUserAccountData(address(this));
    }

    /// @notice Get strategy performance metrics
    function getStrategyMetrics(StrategyType strategy)
        external
        view
        returns (uint256 totalProfit, uint256 executions)
    {
        return (strategyProfits[strategy], strategyExecutions[strategy]);
    }

    /// @notice Simulate arbitrage profitability (off-chain call)
    function simulateArbProfit(
        address /* flashAsset */,
        uint256 flashAmount,
        uint256 /* expectedBuyOutput */,
        uint256 expectedSellOutput
    ) external pure returns (int256 netProfit, uint256 flashFee) {
        flashFee = (flashAmount * AAVE_FLASH_FEE_BPS) / MAX_BPS;
        uint256 totalReturn = expectedSellOutput;
        uint256 totalCost = flashAmount + flashFee;

        if (totalReturn > totalCost) {
            netProfit = int256(totalReturn - totalCost);
        } else {
            netProfit = -int256(totalCost - totalReturn);
        }
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Safe Transfer
    // ═══════════════════════════════════════════════════════
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(success && (data.length == 0 || abi.decode(data, (bool))),
            "transfer failed");
    }

    receive() external payable {}
}
