import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL, 8453, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Deploying PositionV2 — Multi-Strategy Flash Loan        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Deployer:", wallet.address);
  console.log("  Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");
  console.log("  Network: Base Mainnet (8453)");
  console.log("");

  // Get compiled artifact
  const artifact = await import("../artifacts/contracts/PositionV2.sol/PositionV2.json", {
    assert: { type: "json" }
  }).then(m => m.default).catch(() => {
    // Fallback: read JSON directly
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'PositionV2.sol', 'PositionV2.json'), 'utf8'));
  });

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log("  Deploying PositionV2...");
  const contract = await factory.deploy({
    maxFeePerGas: ethers.parseUnits("0.15", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
  });

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  // Get deployment tx
  const deployTx = contract.deploymentTransaction();
  const txHash = deployTx?.hash || 'unknown';
  const receipt = await deployTx?.wait();

  console.log("");
  console.log("  ✅ PositionV2 deployed to:", address);
  console.log("  📝 TX Hash:", txHash);
  if (receipt) {
    console.log("  ⛽ Gas used:", receipt.gasUsed.toString());
    console.log("  📦 Block:", receipt.blockNumber.toString());
  }
  console.log("");
  console.log("  ┌─ STRATEGIES ENABLED ─────────────────────────────────────┐");
  console.log("  │ 0: LEVERAGE_FARM  — Aave V3 supply/borrow loop           │");
  console.log("  │ 1: FLASH_ARB      — Cross-DEX flash loan arbitrage       │");
  console.log("  │ 2: TRIANGLE_ARB   — 3-pool triangular arbitrage          │");
  console.log("  │ 3: LIQUIDATION    — Aave liquidation hunting              │");
  console.log("  │ 4: MEMECOIN_SNIPER — Buy new tokens on Aerodrome          │");
  console.log("  └──────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("  Next steps:");
  console.log("  1. Verify:    npx hardhat verify --network base", address);
  console.log("  2. Set POSITION_V2_ADDRESS=" + address + " in .env");
  console.log("  3. Fund the contract with WETH or USDC");
  console.log("  4. Start the dashboard: npx tsx src/scanner/dashboard.ts monitor");
  console.log("");

  return { address, txHash, gasUsed: receipt?.gasUsed?.toString() };
}

main()
  .then((result) => {
    // Output machine-readable result
    if (result) {
      console.log("DEPLOY_RESULT=" + JSON.stringify(result));
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
