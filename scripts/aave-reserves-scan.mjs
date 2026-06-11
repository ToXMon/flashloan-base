import { ethers } from "ethers";

const RPC_URL = "https://mainnet.base.org";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

// Aave V3 Pool ABI — getReserveData returns a tuple
const POOL_ABI = [
  "function getReservesList() external view returns (address[])",
  "function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint40 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))"
];

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)"
];

const RAY = BigInt("1000000000000000000000000000"); // 1e27
const SECONDS_PER_YEAR = 31536000n;
const WAD = 10000n; // basis points

// Convert ray rate (1e27) to APY using BigInt-safe math
// APY = (1 + rate/RAY) ^ SECONDS_PER_YEAR - 1
// We compute it as: rate_per_second = rate / RAY (as a fraction)
// Then use log/exp approximation or just do APR = rate * SECONDS_PER_YEAR / RAY
function rayToAPR(rayRateBigInt) {
  if (rayRateBigInt === 0n) return 0;
  // APR = rate * seconds_per_year / RAY
  // This gives us the linear (non-compounded) rate
  const apr = (rayRateBigInt * SECONDS_PER_YEAR * 10000n) / RAY;
  return Number(apr) / 100; // percentage with 2 decimal places
}

function rayToAPY(rayRateBigInt) {
  if (rayRateBigInt === 0n) return 0;
  // More precise: APY = (1 + r)^n - 1
  // where r = rate / RAY, n = SECONDS_PER_YEAR
  // For display we use APR which is close enough for comparison
  const ratePerSecondFraction = Number(rayRateBigInt) / Number(RAY);
  const apy = (Math.pow(1 + ratePerSecondFraction, Number(SECONDS_PER_YEAR)) - 1) * 100;
  if (!isFinite(apy)) {
    // Fallback to APR for extreme values
    return rayToAPR(rayRateBigInt);
  }
  return apy;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    batchMaxCount: 1,
    staticNetwork: true
  });

  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);

  console.log("=".repeat(80));
  console.log("AAVE V3 BASE — RESERVE RATE SCANNER");
  console.log("=".repeat(80));
  console.log(`Pool: ${AAVE_POOL}`);
  console.log(`RPC:  ${RPC_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("=".repeat(80));

  let reserves;
  try {
    reserves = await pool.getReservesList();
    console.log(`\nFound ${reserves.length} reserves\n`);
  } catch (err) {
    console.error("ERROR: Failed to fetch reserves list:", err.message);
    process.exit(1);
  }

  const results = [];

  for (let i = 0; i < reserves.length; i++) {
    const reserve = reserves[i];
    try {
      // Add delay between calls to avoid rate limiting
      if (i > 0) await sleep(500);

      const token = new ethers.Contract(reserve, ERC20_ABI, provider);
      let symbol = "UNKNOWN";
      let decimals = 18;
      try {
        [symbol, decimals] = await Promise.all([
          token.symbol(),
          token.decimals()
        ]);
      } catch {
        symbol = reserve.slice(0, 6) + "...";
      }

      await sleep(300);

      const data = await pool.getReserveData(reserve);

      const supplyAPY = rayToAPY(data.currentLiquidityRate);
      const varBorrowAPY = rayToAPY(data.currentVariableBorrowRate);
      const stableBorrowAPY = rayToAPY(data.currentStableBorrowRate);

      const FLASH_FEE_PCT = 0.05;
      const netSpread = supplyAPY - varBorrowAPY - FLASH_FEE_PCT;

      results.push({
        address: reserve,
        symbol,
        decimals: Number(decimals),
        supplyAPY,
        varBorrowAPY,
        stableBorrowAPY,
        netSpread,
        profitable: netSpread > 0,
        aToken: data.aTokenAddress,
        id: Number(data.id),
        lastUpdate: Number(data.lastUpdateTimestamp),
        liquidityIndex: data.liquidityIndex.toString(),
        currentLiquidityRate: data.currentLiquidityRate.toString(),
        currentVariableBorrowRate: data.currentVariableBorrowRate.toString()
      });

      const profitMarker = netSpread > 0 ? " *** PROFITABLE ***" : "";
      console.log(
        `[${String(i+1).padStart(2)}/${reserves.length}] ` +
        `${symbol.padEnd(10)} | Supply: ${supplyAPY.toFixed(4).padStart(10)}% | ` +
        `Borrow(Var): ${varBorrowAPY.toFixed(4).padStart(10)}% | ` +
        `Net Spread: ${netSpread.toFixed(4).padStart(10)}%${profitMarker}`
      );
    } catch (err) {
      console.log(`[${String(i+1).padStart(2)}/${reserves.length}] ERROR ${reserve}: ${err.message.slice(0, 80)}`);
    }
  }

  // Summary sections
  console.log("\n" + "=".repeat(80));
  console.log("PROFITABLE LEVERAGE SPREADS (Supply APY > Var Borrow APY + 0.05%)");
  console.log("=".repeat(80));

  const profitable = results.filter(r => r.profitable);
  if (profitable.length === 0) {
    console.log("\nNo profitable leverage spreads found.");
    console.log("Aave rates self-equilibrate: high utilization raises borrow APY above supply APY.");
    console.log("Profitable spreads are rare and transient when they occur.");
  } else {
    for (const p of profitable) {
      console.log(
        `\n  *** ${p.symbol} (${p.address})\n` +
        `      Supply APY:      ${p.supplyAPY.toFixed(4)}%\n` +
        `      Borrow APY:      ${p.varBorrowAPY.toFixed(4)}%\n` +
        `      Flash Fee:       0.0500%\n` +
        `      NET SPREAD:      +${p.netSpread.toFixed(4)}%\n` +
        `      aToken:          ${p.aToken}\n` +
        `      Annual on $10k:  $${(p.netSpread / 100 * 10000).toFixed(2)}\n` +
        `      Annual on $50k:  $${(p.netSpread / 100 * 50000).toFixed(2)}\n` +
        `      Annual on $100k: $${(p.netSpread / 100 * 100000).toFixed(2)}`
      );
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("ALL RESERVES RANKED BY SUPPLY APY (highest first)");
  console.log("=".repeat(80));
  const bySupply = [...results].sort((a, b) => b.supplyAPY - a.supplyAPY);
  for (const t of bySupply) {
    console.log(
      `  ${t.symbol.padEnd(10)} Supply: ${t.supplyAPY.toFixed(4).padStart(10)}% | ` +
      `Borrow: ${t.varBorrowAPY.toFixed(4).padStart(10)}% | ` +
      `Spread: ${(t.supplyAPY - t.varBorrowAPY).toFixed(4).padStart(10)}%`
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("CHEAPEST BORROW RATES (for leverage / short strategies)");
  console.log("=".repeat(80));
  const cheapBorrow = [...results].sort((a, b) => a.varBorrowAPY - b.varBorrowAPY).slice(0, 7);
  for (const c of cheapBorrow) {
    console.log(
      `  ${c.symbol.padEnd(10)} Borrow: ${c.varBorrowAPY.toFixed(4).padStart(10)}% | ` +
      `Supply: ${c.supplyAPY.toFixed(4).padStart(10)}%`
    );
  }

  // Raw rate data for verification
  console.log("\n" + "=".repeat(80));
  console.log("RAW RATE DATA (for verification — rates in ray = 1e27)");
  console.log("=".repeat(80));
  for (const r of results) {
    console.log(
      `  ${r.symbol.padEnd(10)} liqRate: ${r.currentLiquidityRate.padEnd(30)} | ` +
      `varBorrowRate: ${r.currentVariableBorrowRate}`
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("SCAN COMPLETE — " + results.length + " reserves processed");
  console.log("=".repeat(80));
}

main().catch(console.error);
