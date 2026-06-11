// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// Aave V3 (Base) — flash loan + lending + borrowing all in one pool
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {DataTypes} from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";

// Aerodrome Router (Base)
interface IAeroRouter {
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

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/**
 * @title Position — MEV-Protected Leverage Farming on Base
 * @notice Aave V3 flash loan → Aerodrome swap → Aave V3 supply/borrow
 * @dev Uses Aave V3 native flash loans (no Balancer needed on Base)
 *
 * Strategy flow:
 *   1. Flash loan X tokens from Aave V3 (0.05% fee on Base)
 *   2. Swap X + own capital on Aerodrome for supply token
 *   3. Supply to Aave V3 as collateral
 *   4. Borrow X tokens from Aave V3
 *   5. Repay flash loan (X + fee)
 *   6. You're now leveraged: collateral earning APY, debt paying borrow APY
 *
 * Profit when: supply APY > borrow APY + flash loan fee + gas
 * Base gas: ~$0.01-0.10 per tx, so the bar is low.
 */
contract Position is IFlashLoanSimpleReceiver {
    // ═══════════════════════════════════════════════════════
    // Base Network Addresses
    // ═══════════════════════════════════════════════════════
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Aave V3 Pool on Base — handles flash loans + lending
    address public constant AAVE_POOL =
        0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    // Aave V3 Pool Addresses Provider (for ADDRESSES_PROVIDER)
    address public constant AAVE_ADDRESSES_PROVIDER =
        0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870;

    // Aerodrome Router on Base
    address public constant AERO_ROUTER =
        0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    // ═══════════════════════════════════════════════════════
    // Configurable Parameters
    // ═══════════════════════════════════════════════════════
    uint256 public healthFactorThreshold = 1.1e18;
    uint24  public defaultPoolFee = 500;         // 0.05%
    uint256 public constant MAX_BPS = 10000;

    // ═══════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════
    address public immutable owner;
    address public guardian;
    bool public paused;

    struct PositionInfo {
        address collateralAsset;
        address debtAsset;
        uint256 collateralAmount;
        uint256 debtAmount;
        bool isOpen;
    }
    PositionInfo public currentPosition;

    // Custom token addresses (for tokens not hardcoded)
    mapping(bytes32 => address) public tokenAddresses;

    // ═══════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════
    event PositionOpened(
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 healthFactor
    );
    event PositionClosed(
        address indexed assetWithdrawn,
        address indexed assetRepaid,
        uint256 profitOrLoss
    );
    event EmergencyWithdraw(address indexed token, uint256 amount, address to);
    event ParametersUpdated(uint256 hf, uint24 fee, uint256 slippage);
    event GuardianSet(address indexed newGuardian);

    // ═══════════════════════════════════════════════════════
    // Params
    // ═══════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════
    constructor() {
        owner = msg.sender;
        guardian = msg.sender;
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
    // External — Open Position
    // ═══════════════════════════════════════════════════════
    function openPosition(OpenParams calldata params)
        external
        onlyOwner
        notPaused
    {
        require(!currentPosition.isOpen, "position already open");

        // Aave V3 flash loan — much simpler than Balancer on Base
        bytes memory paramsData = abi.encode(params);

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),               // receiver
            params.assetToBorrow,        // asset
            params.assetToBorrowAmount,   // amount
            paramsData,                   // params
            0                             // referralCode
        );
    }

    // ═══════════════════════════════════════════════════════
    // External — Close Position
    // ═══════════════════════════════════════════════════════
    function closePosition(CloseParams calldata params)
        external
        onlyOwner
        notPaused
    {
        require(currentPosition.isOpen, "no position open");

        uint256 debt = getDebt(params.assetToRepay);
        require(debt > 0, "no debt");

        bytes memory paramsData = abi.encode(params);

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.assetToRepay,
            debt,
            paramsData,
            0
        );
    }

    // ═══════════════════════════════════════════════════════
    // Aave V3 Flash Loan Callback
    // ═══════════════════════════════════════════════════════
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == AAVE_POOL, "caller not Aave");
        require(initiator == address(this), "not initiator");

        (bool isOpen, bytes memory decoded) =
            abi.decode(params, (bool, bytes));

        if (isOpen) {
            OpenParams memory op = abi.decode(decoded, (OpenParams));
            _open(op, amount, premium);
        } else {
            CloseParams memory cp = abi.decode(decoded, (CloseParams));
            _close(cp, amount, premium);
        }

        // Approve Aave to pull flash loan repayment (amount + premium)
        uint256 amountOwing = amount + premium;
        IERC20(asset).approve(AAVE_POOL, amountOwing);

        return true;
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Open Logic
    // ═══════════════════════════════════════════════════════
    function _open(OpenParams memory params, uint256 flashAmount, uint256 premium)
        internal
    {
        // 1. Swap flash loan + own capital into supply asset
        uint256 swapAmount = flashAmount + params.initialCapital;
        uint24 fee = params.poolFee > 0 ? params.poolFee : defaultPoolFee;

        uint256 supplyAmount = _swap(
            params.assetToBorrow,
            params.assetToSupply,
            swapAmount,
            params.expectedSwapAmount,
            fee
        );

        // 2. Supply to Aave
        _supply(params.assetToSupply, supplyAmount);

        // 3. Borrow against collateral
        _borrow(params.assetToBorrow, flashAmount);

        // 4. Check health factor
        uint256 hf = getHealthFactor();
        require(hf > healthFactorThreshold, "health factor too low");

        // 5. Record position
        currentPosition = PositionInfo({
            collateralAsset: params.assetToSupply,
            debtAsset: params.assetToBorrow,
            collateralAmount: supplyAmount,
            debtAmount: flashAmount,
            isOpen: true
        });

        emit PositionOpened(
            params.assetToSupply,
            params.assetToBorrow,
            supplyAmount,
            flashAmount,
            hf
        );
    }

    // ═══════════════════════════════════════════════════════
    // Internal — Close Logic
    // ═══════════════════════════════════════════════════════
    function _close(CloseParams memory params, uint256 flashAmount, uint256 premium)
        internal
    {
        // 1. Repay Aave debt
        _repay(params.assetToRepay);

        // 2. Withdraw collateral
        uint256 withdrawn = _withdraw(params.assetToWithdraw);

        // 3. Swap back to repay flash loan
        uint256 minOut = flashAmount + premium;
        _swap(
            params.assetToWithdraw,
            params.assetToRepay,
            withdrawn,
            minOut,
            defaultPoolFee
        );

        // 4. Calculate profit (anything left after flash loan repayment)
        uint256 balance = IERC20(params.assetToRepay).balanceOf(address(this));
        uint256 profit = balance > (flashAmount + premium)
            ? balance - (flashAmount + premium)
            : 0;

        // 5. Clear position
        currentPosition = PositionInfo({
            collateralAsset: address(0),
            debtAsset: address(0),
            collateralAmount: 0,
            debtAmount: 0,
            isOpen: false
        });

        emit PositionClosed(params.assetToWithdraw, params.assetToRepay, profit);
    }

    // ═══════════════════════════════════════════════════════
    // Internal — DeFi Primitives
    // ═══════════════════════════════════════════════════════
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(AERO_ROUTER, amountIn);

        IAeroRouter.ExactInputSingleParams memory params =
            IAeroRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 30,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            });

        amountOut = IAeroRouter(AERO_ROUTER).exactInputSingle(params);
    }

    function _supply(address asset, uint256 amount) internal {
        IERC20(asset).approve(AAVE_POOL, amount);
        IPool(AAVE_POOL).supply(asset, amount, address(this), 0);
    }

    function _borrow(address asset, uint256 amount) internal {
        IPool(AAVE_POOL).borrow(asset, amount, 2, 0, address(this));
    }

    function _repay(address asset) internal {
        IERC20(asset).approve(AAVE_POOL, type(uint256).max);
        IPool(AAVE_POOL).repay(asset, type(uint256).max, 2, address(this));
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
    }

    function emergencyWithdraw(address[] calldata tokens, address to)
        external onlyOwnerOrGuardian
    {
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

    function setGuardian(address v) external onlyOwner {
        guardian = v;
        emit GuardianSet(v);
    }

    function setTokenAddress(string calldata symbol, address token)
        external onlyOwner
    {
        tokenAddresses[keccak256(abi.encodePacked(symbol))] = token;
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

    // ═══════════════════════════════════════════════════════
    // Internal — Safe Transfer
    // ═══════════════════════════════════════════════════════
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(success && (data.length == 0 || abi.decode(data, (bool))),
            "transfer failed");
    }

    // Receive ETH
    receive() external payable {}
}
