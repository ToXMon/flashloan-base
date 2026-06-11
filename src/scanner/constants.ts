/**
 * Shared constants for the Base Flash Loan system.
 *
 * Single source of truth for token addresses, DEX addresses, ABIs, and config.
 * All scanner modules import from here to avoid duplication.
 */

export const BASE_CHAIN_ID = 8453;

// ─── Aave V3 Flash Loan Fee ────────────────────────────────
export const AAVE_FLASH_FEE_BPS = 5; // 0.05%

// ─── Token Addresses (Base, checksummed) ───────────────────
export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export const TOKENS: Record<string, TokenInfo> = {
  WETH:  { symbol: "WETH",  address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC:  { symbol: "USDC",  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  USDbC: { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  DAI:   { symbol: "DAI",   address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  cbETH: { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  weETH: { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18 },
  rETH:  { symbol: "rETH",  address: "0xb6Fe221Fe9Eef5AbA2fA62AB649aa5cBb5C67b60", decimals: 18 },
};

// ─── Protocol Addresses ────────────────────────────────────
export const PROTOCOLS = {
  AAVE_POOL:             "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  AAVE_ADDRESSES:        "0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870",
  AAVE_PRICE_ORACLE:     "0x7f9C732513Dee9Af2967aDAF3D4607F39e6D8333",
  AERO_CL_ROUTER:        "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  AERO_AMM_ROUTER:       "0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925",
  AERO_FACTORY:          "0x420dD381B31AEf6683DB6b902084cB0ffEcFc40e",
  UNI_V3_ROUTER:         "0x2626664c2603336E57B271c5C0b26F421741e481",
  UNI_V3_QUOTER:         "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  UNI_V3_FACTORY:        "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  BASESWAP_ROUTER:       "0x3fd11e3879F0A481280bBcbA2C206331575A65e3",
  BALANCER_VAULT:        "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  SEAMLESS_POOL:         "0x3C2ff90A92a9C0892a6894f1e711cbB1258dcc52",
};

// ─── DEX Definitions ───────────────────────────────────────
export const DEXES = {
  aerodromeCL: {
    name: "Aerodrome CL",
    router: PROTOCOLS.AERO_CL_ROUTER,
    type: 0,
  },
  aerodromeAMM: {
    name: "Aerodrome AMM",
    router: PROTOCOLS.AERO_AMM_ROUTER,
    type: 2,
  },
  uniswapV3: {
    name: "Uniswap V3",
    router: PROTOCOLS.UNI_V3_ROUTER,
    quoter: PROTOCOLS.UNI_V3_QUOTER,
    type: 1,
  },
};

// ─── ABIs (minimal) ────────────────────────────────────────
export const AAVE_POOL_ABI = [
  "function getReserveData(address asset) external view returns (tuple(uint256 data, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint40 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() external view returns (address[])",
];

export const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

export const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function balanceOf(address) external view returns (uint256)",
];

export const POSITION_ABI = [
  "function currentPosition() external view returns (address collateralAsset, address debtAsset, uint256 collateralAmount, uint256 debtAmount, bool isOpen, uint8 strategy, uint256 openedAt)",
  "function getHealthFactor() external view returns (uint256)",
  "function getAccountData() external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function strategyProfits(uint8) external view returns (uint256)",
  "function strategyExecutions(uint8) external view returns (uint256)",
  "function totalProfitWithdrawn() external view returns (uint256)",
  "function getTokenBalance(address) external view returns (uint256)",
];

// ─── Pool Fee Tiers ────────────────────────────────────────
export const POOL_FEE_TIERS = [100, 500, 3000]; // 0.01%, 0.05%, 0.3%

// ─── Safe Token Whitelist ──────────────────────────────────
export const SAFE_TOKENS = new Set(Object.values(TOKENS).map(t => t.address.toLowerCase()));
