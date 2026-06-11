import { ethers } from "ethers";

// Correct checksummed addresses
const GITLAWB = "0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3";
const WETH    = "0x4200000000000000000000000000000000000006";
const USDC    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const UNI_V3_QUOTER  = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNI_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const AERO_CL_FACTORY = "0x5e7bB104D8537C394D0260E7ebb93829aFfD0Cd3";
const AERO_CL_QUOTER  = "0x511884D802a2e7CA0C489abeE66E2bd10f0A5A86";
const AERO_V2_FACTORY = "0x420DD381b31AEf6683DB6F9029093e8Ea1e4c2B1";
const AERO_V2_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const PC_V3_FACTORY   = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const PC_V3_QUOTER    = "0x4d2Ed76f20c12B2caed7E28b9A72Cb5950EB1f7d";

// Try multiple RPCs
const RPCS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base.meowrpc.com",
  "https://base.drpc.org"
];

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX16) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];
const QUOTER_V1_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
];
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)"
];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const AERO_CL_FACTORY_ABI = ["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"];
const AERO_V2_FACTORY_ABI = ["function getPool(address tokenA, address tokenB, bool stable) view returns (address)"];
const AERO_V2_ROUTER_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut, address factory, address pool) external view returns (uint256 amountOut)"];
const AERO_CL_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX16, bytes hookData) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

async function connectProvider() {
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
      const block = await p.getBlockNumber();
      console.log(`  Connected to ${rpc} (block ${block})`);
      return p;
    } catch (e) {
      console.log(`  Failed ${rpc}: ${e.message.slice(0, 60)}`);
    }
  }
  throw new Error("All RPCs failed");
}

async function main() {
  console.log("=".repeat(80));
  console.log("GITLAWB CROSS-DEX ARBITRAGE ANALYSIS ON BASE");
  console.log("=".repeat(80));
  console.log(`Token: ${GITLAWB}`);
  console.log(`Time:  ${new Date().toISOString()}\n`);

  console.log("Connecting to Base...");
  const provider = await connectProvider();

  // Token info
  let gitlawbDec = 18n, wethDec = 18n, usdcDec = 6n;
  try {
    [gitlawbDec, wethDec, usdcDec] = await Promise.all([
      new ethers.Contract(GITLAWB, ERC20_ABI, provider).decimals(),
      new ethers.Contract(WETH, ERC20_ABI, provider).decimals(),
      new ethers.Contract(USDC, ERC20_ABI, provider).decimals()
    ]);
  } catch {}
  console.log(`Decimals: GITLAWB=${gitlawbDec}, WETH=${wethDec}, USDC=${usdcDec}\n`);

  const feeTiers = [100, 500, 3000, 10000];
  const testAmountsRaw = [1000, 10000, 50000, 100000];
  const testAmounts = testAmountsRaw.map(a => ethers.parseUnits(a.toString(), Number(gitlawbDec)));

  // ============================================================
  // STEP 1: Uniswap V3 Pool Discovery
  // ============================================================
  console.log("-".repeat(80));
  console.log("STEP 1: UNISWAP V3 POOLS");
  console.log("-".repeat(80));
  const uniFactory = new ethers.Contract(UNI_V3_FACTORY, FACTORY_ABI, provider);
  const uniPools = {};

  for (const fee of feeTiers) {
    try {
      const pool = await uniFactory.getPool(GITLAWB, WETH, fee);
      if (pool !== ethers.ZeroAddress) {
        console.log(`  fee=${fee}: ${pool}`);
        uniPools[fee] = pool;
        try {
          const pc = new ethers.Contract(pool, POOL_ABI, provider);
          const [s0, liq] = await Promise.all([pc.slot0(), pc.liquidity()]);
          console.log(`    tick=${s0.tick} liquidity=${liq.toString()}`);
        } catch {}
      } else {
        console.log(`  fee=${fee}: no pool`);
      }
    } catch (e) {
      console.log(`  fee=${fee}: ${e.message.slice(0, 80)}`);
    }
  }

  // ============================================================
  // STEP 2: Uniswap V3 Quotes
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 2: UNISWAP V3 QUOTES (SELL GITLAWB for WETH)");
  console.log("-".repeat(80));
  const quoterV2 = new ethers.Contract(UNI_V3_QUOTER, QUOTER_V2_ABI, provider);
  const quoterV1 = new ethers.Contract(UNI_V3_QUOTER, QUOTER_V1_ABI, provider);
  const uniV3Quotes = {};

  for (let i = 0; i < testAmounts.length; i++) {
    const amt = testAmountsRaw[i];
    console.log(`\n  ${amt.toLocaleString()} GITLAWB:`);
    for (const fee of feeTiers) {
      if (!uniPools[fee]) continue;
      let success = false;
      // Try V2 quoter
      try {
        const r = await quoterV2.quoteExactInputSingle.staticCall({
          tokenIn: GITLAWB, tokenOut: WETH, amountIn: testAmounts[i], fee, sqrtPriceLimitX16: 0
        });
        const w = ethers.formatEther(r.amountOut);
        console.log(`    fee=${fee}: ${w} WETH (gas=${r.gasEstimate})`);
        if (!uniV3Quotes[fee]) uniV3Quotes[fee] = {};
        uniV3Quotes[fee][amt] = { wethOut: parseFloat(w) };
        success = true;
      } catch {}
      if (!success) {
        try {
          const r = await quoterV1.quoteExactInputSingle.staticCall(GITLAWB, WETH, fee, testAmounts[i], 0);
          const w = ethers.formatEther(r);
          console.log(`    fee=${fee}: ${w} WETH (V1)`);
          if (!uniV3Quotes[fee]) uniV3Quotes[fee] = {};
          uniV3Quotes[fee][amt] = { wethOut: parseFloat(w) };
        } catch (e) { console.log(`    fee=${fee}: FAILED`); }
      }
    }
  }

  // ============================================================
  // STEP 3: Aerodrome CL Pools
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 3: AERODROME CL POOLS");
  console.log("-".repeat(80));
  const aeroFactory = new ethers.Contract(AERO_CL_FACTORY, AERO_CL_FACTORY_ABI, provider);
  const aeroCLPools = {};

  for (const ts of [1, 10, 50, 100, 200]) {
    try {
      let p = await aeroFactory.getPool(GITLAWB, WETH, ts);
      if (p === ethers.ZeroAddress) p = await aeroFactory.getPool(WETH, GITLAWB, ts);
      if (p !== ethers.ZeroAddress) {
        console.log(`  tickSpacing=${ts}: ${p}`);
        aeroCLPools[ts] = p;
        try {
          const pc = new ethers.Contract(p, POOL_ABI, provider);
          const [s0, liq] = await Promise.all([pc.slot0(), pc.liquidity()]);
          console.log(`    tick=${s0.tick} liquidity=${liq.toString()}`);
        } catch {}
      } else {
        console.log(`  tickSpacing=${ts}: no pool`);
      }
    } catch (e) { console.log(`  ts=${ts}: ${e.message.slice(0, 80)}`); }
  }

  // ============================================================
  // STEP 4: Aerodrome CL Quotes
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 4: AERODROME CL QUOTES (SELL GITLAWB for WETH)");
  console.log("-".repeat(80));
  const aeroQuoter = new ethers.Contract(AERO_CL_QUOTER, AERO_CL_QUOTER_ABI, provider);
  const aeroCLQuotes = {};

  for (let i = 0; i < testAmounts.length; i++) {
    const amt = testAmountsRaw[i];
    console.log(`\n  ${amt.toLocaleString()} GITLAWB:`);
    // Aerodrome CL uses fee values; try common ones
    // Fee is derived from the pool's tickSpacing. Common mappings:
    // ts=1 -> fee=100, ts=10 -> fee=500, ts=50 -> fee=2500, ts=100 -> fee=10000
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      try {
        const r = await aeroQuoter.quoteExactInputSingle.staticCall({
          tokenIn: GITLAWB, tokenOut: WETH, amountIn: testAmounts[i], fee, sqrtPriceLimitX16: 0, hookData: "0x"
        });
        const w = ethers.formatEther(r.amountOut);
        console.log(`    fee=${fee}: ${w} WETH (gas=${r.gasEstimate})`);
        if (!aeroCLQuotes[fee]) aeroCLQuotes[fee] = {};
        aeroCLQuotes[fee][amt] = { wethOut: parseFloat(w) };
      } catch (e) { console.log(`    fee=${fee}: FAILED - ${e.message.slice(0, 60)}`); }
    }
  }

  // ============================================================
  // STEP 5: Aerodrome V2
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 5: AERODROME V2 POOLS & QUOTES");
  console.log("-".repeat(80));
  const aeroV2Factory = new ethers.Contract(AERO_V2_FACTORY, AERO_V2_FACTORY_ABI, provider);
  const aeroV2Router = new ethers.Contract(AERO_V2_ROUTER, AERO_V2_ROUTER_ABI, provider);
  const aeroV2Quotes = {};

  for (const stable of [false, true]) {
    const label = stable ? "stable" : "volatile";
    try {
      const p = await aeroV2Factory.getPool(GITLAWB, WETH, stable);
      if (p !== ethers.ZeroAddress) {
        console.log(`\n  ${label} pool: ${p}`);
        for (let i = 0; i < testAmounts.length; i++) {
          const amt = testAmountsRaw[i];
          try {
            const out = await aeroV2Router.getAmountOut(testAmounts[i], GITLAWB, WETH, AERO_V2_FACTORY, p);
            const w = ethers.formatEther(out);
            console.log(`    ${amt.toLocaleString()} GITLAWB -> ${w} WETH`);
            if (!aeroV2Quotes[label]) aeroV2Quotes[label] = {};
            aeroV2Quotes[label][amt] = { wethOut: parseFloat(w) };
          } catch (e) { console.log(`    ${amt.toLocaleString()}: FAILED - ${e.message.slice(0, 60)}`); }
        }
      } else { console.log(`  No ${label} pool`); }
    } catch (e) { console.log(`  ${label}: ${e.message.slice(0, 80)}`); }
  }

  // GITLAWB/USDC on Aero V2
  console.log("\n  GITLAWB/USDC:");
  for (const stable of [false, true]) {
    const label = stable ? "stable" : "volatile";
    try {
      const p = await aeroV2Factory.getPool(GITLAWB, USDC, stable);
      if (p !== ethers.ZeroAddress) {
        console.log(`  ${label} pool: ${p}`);
        for (let i = 0; i < testAmounts.length; i++) {
          try {
            const out = await aeroV2Router.getAmountOut(testAmounts[i], GITLAWB, USDC, AERO_V2_FACTORY, p);
            console.log(`    ${testAmountsRaw[i].toLocaleString()} GITLAWB -> ${ethers.formatUnits(out, 6)} USDC`);
          } catch {}
        }
      }
    } catch {}
  }

  // ============================================================
  // STEP 6: PancakeSwap V3
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 6: PANCAKESWAP V3");
  console.log("-".repeat(80));
  const pcFactory = new ethers.Contract(PC_V3_FACTORY, FACTORY_ABI, provider);
  const pcQuoter = new ethers.Contract(PC_V3_QUOTER, QUOTER_V2_ABI, provider);
  const pcQuotes = {};

  for (const fee of feeTiers) {
    try {
      const p = await pcFactory.getPool(GITLAWB, WETH, fee);
      if (p !== ethers.ZeroAddress) {
        console.log(`  fee=${fee}: ${p}`);
        try {
          const pc = new ethers.Contract(p, POOL_ABI, provider);
          const [s0, liq] = await Promise.all([pc.slot0(), pc.liquidity()]);
          console.log(`    tick=${s0.tick} liquidity=${liq.toString()}`);
        } catch {}

        for (let i = 0; i < testAmounts.length; i++) {
          const amt = testAmountsRaw[i];
          try {
            const r = await pcQuoter.quoteExactInputSingle.staticCall({
              tokenIn: GITLAWB, tokenOut: WETH, amountIn: testAmounts[i], fee, sqrtPriceLimitX16: 0
            });
            const w = ethers.formatEther(r.amountOut);
            console.log(`    ${amt.toLocaleString()} GITLAWB -> ${w} WETH`);
            if (!pcQuotes[fee]) pcQuotes[fee] = {};
            pcQuotes[fee][amt] = { wethOut: parseFloat(w) };
          } catch (e) { console.log(`    ${amt.toLocaleString()}: FAILED - ${e.message.slice(0, 60)}`); }
        }
      } else { console.log(`  fee=${fee}: no pool`); }
    } catch (e) { console.log(`  fee=${fee}: ${e.message.slice(0, 80)}`); }
  }

  // ============================================================
  // STEP 7: WETH price
  // ============================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 7: WETH/USDC PRICE");
  console.log("-".repeat(80));
  let ethPrice = 2500; // fallback
  try {
    const wethUsdcPool = await uniFactory.getPool(WETH, USDC, 500);
    if (wethUsdcPool !== ethers.ZeroAddress) {
      const r = await quoterV2.quoteExactInputSingle.staticCall({
        tokenIn: WETH, tokenOut: USDC, amountIn: ethers.parseEther("1"), fee: 500, sqrtPriceLimitX16: 0
      });
      ethPrice = parseFloat(ethers.formatUnits(r.amountOut, 6));
      console.log(`  1 WETH = ${ethPrice} USDC (~$${ethPrice.toFixed(2)})`);
    }
  } catch (e) { console.log(`  Using fallback $${ethPrice}: ${e.message.slice(0, 60)}`); }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(80));
  console.log("ARBITRAGE ANALYSIS SUMMARY");
  console.log("=".repeat(80));

  const allQuotes = [];

  const collect = (obj, prefix) => {
    for (const [tier, amounts] of Object.entries(obj)) {
      for (const [amt, data] of Object.entries(amounts)) {
        allQuotes.push({ dex: `${prefix}(${tier})`, amountIn: parseInt(amt), wethOut: data.wethOut });
      }
    }
  };

  collect(uniV3Quotes, "UniV3");
  collect(aeroCLQuotes, "AeroCL");
  collect(pcQuotes, "PCV3");

  for (const [label, amounts] of Object.entries(aeroV2Quotes)) {
    for (const [amt, data] of Object.entries(amounts)) {
      allQuotes.push({ dex: `AeroV2(${label})`, amountIn: parseInt(amt), wethOut: data.wethOut });
    }
  }

  if (allQuotes.length === 0) {
    console.log("\n  NO VALID QUOTES OBTAINED.");
    console.log("  The token may not have active liquidity, or all pools may be empty.");
    console.log("  This could mean:");
    console.log("  - All liquidity has been removed");
    console.log("  - Token is paused or blacklisted in pools");
    console.log("  - RPC issues (try a paid RPC)");

    // Try one more thing: direct low-level call to see if the contract exists
    console.log("\n  Checking if GITLAWB contract exists...");
    const code = await provider.getCode(GITLAWB);
    console.log(`  Contract code size: ${code.length} chars (${(code.length - 2) / 2} bytes)`);
    return;
  }

  allQuotes.sort((a, b) => a.amountIn - b.amountIn || b.wethOut - a.wethOut);

  console.log("\nAll SELL quotes (GITLAWB -> WETH):");
  console.log(`${"DEX".padEnd(28)} ${"Tokens".padStart(10)} ${"WETH Out".padStart(20)} ${"Price/Token".padStart(18)}`);
  console.log("-".repeat(80));
  for (const q of allQuotes) {
    const price = q.wethOut / q.amountIn;
    console.log(`${q.dex.padEnd(28)} ${q.amountIn.toLocaleString().padStart(10)} ${q.wethOut.toFixed(12).padStart(20)} ${price.toExponential(6).padStart(18)}`);
  }

  // Spread analysis per amount
  console.log("\n" + "=".repeat(80));
  console.log("CROSS-DEX SPREAD ANALYSIS");
  console.log("=".repeat(80));

  const uniqueAmounts = [...new Set(allQuotes.map(q => q.amountIn))].sort((a, b) => a - b);

  for (const amt of uniqueAmounts) {
    const quotes = allQuotes.filter(q => q.amountIn === amt);
    if (quotes.length < 2) {
      console.log(`\n  ${amt.toLocaleString()} tokens: Only 1 DEX, no comparison`);
      continue;
    }

    const best = quotes.reduce((a, b) => a.wethOut > b.wethOut ? a : b);
    const worst = quotes.reduce((a, b) => a.wethOut < b.wethOut ? a : b);
    const spreadPct = ((best.wethOut - worst.wethOut) / worst.wethOut) * 100;
    const spreadEth = best.wethOut - worst.wethOut;
    const spreadUsd = spreadEth * ethPrice;

    console.log(`\n  === ${amt.toLocaleString()} GITLAWB ===`);
    console.log(`  Best SELL:  ${best.dex}  -> ${best.wethOut.toPrecision(10)} WETH`);
    console.log(`  Worst SELL: ${worst.dex} -> ${worst.wethOut.toPrecision(10)} WETH`);
    console.log(`  Spread:     ${spreadPct.toFixed(4)}% = ${spreadEth.toPrecision(6)} WETH ($${spreadUsd.toFixed(4)})`);

    // Cost breakdown
    const flFee = worst.wethOut * 0.0005; // 0.05% flash loan fee
    const gas = 0.0003;
    const totalCost = flFee + gas;
    const profit = spreadEth - totalCost;
    const profitUsd = profit * ethPrice;

    console.log(`  --- Costs ---`);
    console.log(`  Flash loan fee (0.05%): ${flFee.toPrecision(6)} WETH`);
    console.log(`  Est. gas:               ${gas} WETH (~$${(gas * ethPrice).toFixed(2)})`);
    console.log(`  Total cost:             ${totalCost.toPrecision(6)} WETH ($${(totalCost * ethPrice).toFixed(4)})`);
    console.log(`  Net profit:             ${profit.toPrecision(6)} WETH ($${profitUsd.toFixed(4)})`);
    console.log(`  PROFITABLE:             ${profit > 0 ? ">>> YES <<<" : "NO"}`);

    // Liquidity depth check
    console.log(`  --- Liquidity Depth ---`);
    const basePrice = quotes[0].wethOut / amt;
    for (const q of quotes) {
      const p = q.wethOut / amt;
      const impact = ((basePrice - p) / basePrice) * 100;
      console.log(`    ${q.dex}: price=${p.toExponential(4)} impact=${impact.toFixed(2)}%`);
    }
  }

  // Final verdict
  console.log("\n" + "=".repeat(80));
  console.log("FINAL VERDICT");
  console.log("=".repeat(80));

  let anyProfitable = false;
  for (const amt of uniqueAmounts) {
    const quotes = allQuotes.filter(q => q.amountIn === amt);
    if (quotes.length < 2) continue;
    const best = quotes.reduce((a, b) => a.wethOut > b.wethOut ? a : b);
    const worst = quotes.reduce((a, b) => a.wethOut < b.wethOut ? a : b);
    const spread = best.wethOut - worst.wethOut;
    const cost = worst.wethOut * 0.0005 + 0.0003;
    if (spread > cost) {
      anyProfitable = true;
      console.log(`  ${amt.toLocaleString()} tokens: SPREAD ${((spread / worst.wethOut) * 100).toFixed(4)}% > COST ${((cost / worst.wethOut) * 100).toFixed(4)}% -- ARBITRAGE OPPORTUNITY`);
    }
  }
  if (!anyProfitable) {
    console.log("  No profitable arbitrage found at any trade size.");
    console.log("  Spreads do not exceed flash loan fees + gas costs.");
  }

  console.log("\n" + "=".repeat(80));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
