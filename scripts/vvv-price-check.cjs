const { ethers } = require("ethers");

const RPC_URL = "https://mainnet.base.org";
const VVV = "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const UNISWAP_QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERODROME_CL_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERODROME_AMM_ROUTER = "0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925";

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Uniswap V3 QuoterV2 - tuple-based interface
const quoterV2ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

// Aerodrome CL Router - try exactInputSingle
const aeroCLABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)"
];

// Aerodrome AMM Router - classic getAmountsOut
const aeroAMMABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

async function main() {
  console.log("============================================================");
  console.log("  VVV (Venice Token) Cross-DEX Price Analysis on Base");
  console.log("============================================================");
  const blockNum = await provider.getBlockNumber();
  console.log("Block:", blockNum, "  Time:", new Date().toISOString());
  console.log("VVV:", VVV);
  console.log("WETH:", WETH);
  console.log("USDC:", USDC);
  console.log("");

  const VVV_AMOUNT = ethers.parseUnits("1000", 18);
  console.log("Query: 1000 VVV (= " + VVV_AMOUNT.toString() + " wei) into WETH and USDC");
  console.log("");

  const quotes = []; // {dex, pair, fee, amountOut, raw, outToken}

  // ========================================
  // 1. Uniswap V3 QuoterV2
  // ========================================
  console.log("--- Uniswap V3 QuoterV2 ---");

  const uniQuoter = new ethers.Contract(UNISWAP_QUOTER_V2, quoterV2ABI, provider);

  // VVV -> WETH at all fee tiers
  for (const fee of [100, 500, 3000, 10000]) {
    await delay(350);
    try {
      const result = await uniQuoter.quoteExactInputSingle.staticCall({
        tokenIn: VVV, tokenOut: WETH, amountIn: VVV_AMOUNT, fee: fee, sqrtPriceLimitX96: 0
      });
      const wethOut = ethers.formatUnits(result.amountOut, 18);
      console.log("  VVV->WETH fee=" + fee + ": " + wethOut + " WETH  (raw=" + result.amountOut.toString() + ")");
      quotes.push({ dex: "UniswapV3", pair: "VVV/WETH", fee, amountOut: parseFloat(wethOut), raw: result.amountOut.toString(), outToken: "WETH" });
    } catch (e) {
      const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
      console.log("  VVV->WETH fee=" + fee + ": FAILED - " + msg);
    }
  }

  // VVV -> USDC at all fee tiers
  for (const fee of [100, 500, 3000, 10000]) {
    await delay(350);
    try {
      const result = await uniQuoter.quoteExactInputSingle.staticCall({
        tokenIn: VVV, tokenOut: USDC, amountIn: VVV_AMOUNT, fee: fee, sqrtPriceLimitX96: 0
      });
      const usdcOut = ethers.formatUnits(result.amountOut, 6);
      console.log("  VVV->USDC fee=" + fee + ": " + usdcOut + " USDC  (raw=" + result.amountOut.toString() + ")");
      quotes.push({ dex: "UniswapV3", pair: "VVV/USDC", fee, amountOut: parseFloat(usdcOut), raw: result.amountOut.toString(), outToken: "USDC" });
    } catch (e) {
      const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
      console.log("  VVV->USDC fee=" + fee + ": FAILED - " + msg);
    }
  }

  console.log("");

  // ========================================
  // 2. Aerodrome CL Router
  // ========================================
  console.log("--- Aerodrome CL Router ---");
  const aeroCL = new ethers.Contract(AERODROME_CL_ROUTER, aeroCLABI, provider);

  for (const fee of [100, 500, 3000, 10000]) {
    await delay(350);
    try {
      const result = await aeroCL.exactInputSingle.staticCall({
        tokenIn: VVV, tokenOut: WETH, fee, recipient: "0x0000000000000000000000000000000000000001",
        amountIn: VVV_AMOUNT, amountOutMinimum: 0, sqrtPriceLimitX96: 0
      });
      const wethOut = ethers.formatUnits(result, 18);
      console.log("  VVV->WETH fee=" + fee + ": " + wethOut + " WETH  (raw=" + result.toString() + ")");
      quotes.push({ dex: "AerodromeCL", pair: "VVV/WETH", fee, amountOut: parseFloat(wethOut), raw: result.toString(), outToken: "WETH" });
    } catch (e) {
      const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
      console.log("  VVV->WETH fee=" + fee + ": FAILED - " + msg);
    }

    await delay(350);
    try {
      const result = await aeroCL.exactInputSingle.staticCall({
        tokenIn: VVV, tokenOut: USDC, fee, recipient: "0x0000000000000000000000000000000000000001",
        amountIn: VVV_AMOUNT, amountOutMinimum: 0, sqrtPriceLimitX96: 0
      });
      const usdcOut = ethers.formatUnits(result, 6);
      console.log("  VVV->USDC fee=" + fee + ": " + usdcOut + " USDC  (raw=" + result.toString() + ")");
      quotes.push({ dex: "AerodromeCL", pair: "VVV/USDC", fee, amountOut: parseFloat(usdcOut), raw: result.toString(), outToken: "USDC" });
    } catch (e) {
      const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
      console.log("  VVV->USDC fee=" + fee + ": FAILED - " + msg);
    }
  }

  console.log("");

  // ========================================
  // 3. Aerodrome AMM Router
  // ========================================
  console.log("--- Aerodrome AMM Router ---");
  const aeroAMM = new ethers.Contract(AERODROME_AMM_ROUTER, aeroAMMABI, provider);

  // Direct: VVV -> WETH
  await delay(350);
  try {
    const amounts = await aeroAMM.getAmountsOut(VVV_AMOUNT, [VVV, WETH]);
    const wethOut = ethers.formatUnits(amounts[1], 18);
    console.log("  VVV->WETH: " + wethOut + " WETH  (raw=" + amounts[1].toString() + ")");
    quotes.push({ dex: "AerodromeAMM", pair: "VVV/WETH", fee: 0, amountOut: parseFloat(wethOut), raw: amounts[1].toString(), outToken: "WETH" });
  } catch (e) {
    const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
    console.log("  VVV->WETH: FAILED - " + msg);
  }

  // Direct: VVV -> USDC
  await delay(350);
  try {
    const amounts = await aeroAMM.getAmountsOut(VVV_AMOUNT, [VVV, USDC]);
    const usdcOut = ethers.formatUnits(amounts[1], 6);
    console.log("  VVV->USDC: " + usdcOut + " USDC  (raw=" + amounts[1].toString() + ")");
    quotes.push({ dex: "AerodromeAMM", pair: "VVV/USDC", fee: 0, amountOut: parseFloat(usdcOut), raw: amounts[1].toString(), outToken: "USDC" });
  } catch (e) {
    const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
    console.log("  VVV->USDC: FAILED - " + msg);
  }

  // Multihop: VVV -> WETH -> USDC
  await delay(350);
  try {
    const amounts = await aeroAMM.getAmountsOut(VVV_AMOUNT, [VVV, WETH, USDC]);
    const usdcOut = ethers.formatUnits(amounts[2], 6);
    console.log("  VVV->WETH->USDC: " + usdcOut + " USDC  (raw=" + amounts[2].toString() + ")");
    quotes.push({ dex: "AerodromeAMM", pair: "VVV/WETH/USDC", fee: 0, amountOut: parseFloat(usdcOut), raw: amounts[2].toString(), outToken: "USDC", route: "multihop" });
  } catch (e) {
    const msg = e.shortMessage || (e.info?.error?.message) || e.message?.substring(0, 100);
    console.log("  VVV->WETH->USDC: FAILED - " + msg);
  }

  console.log("");

  // ========================================
  // 4. Analysis
  // ========================================
  console.log("============================================================");
  console.log("  CROSS-DEX PRICE COMPARISON");
  console.log("============================================================");
  console.log("");

  // WETH quotes
  const wethQuotes = quotes.filter(q => q.outToken === "WETH");
  const usdcQuotes = quotes.filter(q => q.outToken === "USDC");

  function analyzePair(label, quoteList) {
    if (quoteList.length < 2) {
      console.log(label + ": Only " + quoteList.length + " quote(s) found. Cannot compare.");
      if (quoteList.length === 1) {
        console.log("  " + quoteList[0].dex + " (fee=" + quoteList[0].fee + "): " + quoteList[0].amountOut);
      }
      console.log("");
      return null;
    }

    quoteList.sort((a, b) => b.amountOut - a.amountOut);
    console.log(label + " (1000 VVV in, ranked best to worst):");
    for (const q of quoteList) {
      console.log("  " + q.dex.padEnd(15) + " fee=" + String(q.fee).padStart(5) + "  =>  " + q.amountOut);
    }

    const best = quoteList[0];
    const worst = quoteList[quoteList.length - 1];
    const spread = best.amountOut - worst.amountOut;
    const spreadPct = (spread / worst.amountOut) * 100;
    const spreadBps = spreadPct * 100;

    console.log("");
    console.log("  BEST:  " + best.dex + " (fee=" + best.fee + ") = " + best.amountOut + " " + best.outToken);
    console.log("  WORST: " + worst.dex + " (fee=" + worst.fee + ") = " + worst.amountOut + " " + worst.outToken);
    console.log("  SPREAD: " + spreadPct.toFixed(6) + "% (" + spreadBps.toFixed(2) + " bps)");
    console.log("");
    return { best, worst, spreadPct, spreadBps };
  }

  const wethResult = analyzePair("VVV/WETH Quotes", wethQuotes);
  const usdcResult = analyzePair("VVV/USDC Quotes", usdcQuotes);

  // ========================================
  // 5. Arbitrage Profitability
  // ========================================
  console.log("============================================================");
  console.log("  FLASH LOAN ARBITRAGE PROFITABILITY");
  console.log("============================================================");
  console.log("");

  const results = [];
  if (wethResult) results.push({ ...wethResult, token: "WETH" });
  if (usdcResult) results.push({ ...usdcResult, token: "USDC" });

  if (results.length === 0) {
    console.log("Insufficient data for arbitrage analysis (need >= 2 quotes per pair).");
  } else {
    const aaveFeeBps = 5; // 0.05%
    const gasCostUsd = 0.01; // Base L2 gas

    for (const r of results) {
      console.log("--- Arb via " + r.token + " (spread=" + r.spreadBps.toFixed(2) + " bps) ---");
      console.log("  Buy cheap at:  " + r.worst.dex + " (fee=" + r.worst.fee + ")");
      console.log("  Sell dear at:  " + r.best.dex + " (fee=" + r.best.fee + ")");
      console.log("  Spread:        " + r.spreadBps.toFixed(2) + " bps");
      console.log("  Aave fee:      " + aaveFeeBps + " bps (0.05%)");
      console.log("  Gas (~Base):   $" + gasCostUsd);
      console.log("");

      for (const loanSize of [50000, 100000]) {
        const grossProfit = loanSize * (r.spreadBps / 10000);
        const aaveFee = loanSize * (aaveFeeBps / 10000);
        const netProfit = grossProfit - aaveFee - gasCostUsd;
        const netBps = r.spreadBps - aaveFeeBps;
        console.log("  $" + loanSize.toLocaleString() + " flash loan:");
        console.log("    Gross spread:     $" + grossProfit.toFixed(2));
        console.log("    Aave fee (0.05%):  $" + aaveFee.toFixed(2));
        console.log("    Gas cost:         $" + gasCostUsd.toFixed(2));
        console.log("    NET PROFIT:       $" + netProfit.toFixed(2));
        console.log("    Net spread after costs: " + netBps.toFixed(2) + " bps");
        console.log("    PROFITABLE:       " + (netProfit > 0 ? "YES" : "NO"));
        console.log("");
      }
    }

    // Final verdict
    console.log("============================================================");
    console.log("  VERDICT");
    console.log("============================================================");
    for (const r of results) {
      const netBps = r.spreadBps - aaveFeeBps;
      if (netBps > 0) {
        console.log("  " + r.token + ": ARBITRAGE OPPORTUNITY EXISTS");
        console.log("    Spread: " + r.spreadBps.toFixed(2) + " bps > Aave fee " + aaveFeeBps + " bps");
        console.log("    Route: Buy VVV on " + r.worst.dex + " -> Sell on " + r.best.dex);
      } else {
        console.log("  " + r.token + ": NO profitable arbitrage");
        console.log("    Spread: " + r.spreadBps.toFixed(2) + " bps <= Aave fee " + aaveFeeBps + " bps");
      }
    }
  }

  console.log("");
  console.log("============================================================");
  console.log("  RAW DATA (for verification)");
  console.log("============================================================");
  for (const q of quotes) {
    console.log(JSON.stringify(q));
  }
}

main().catch(console.error);
