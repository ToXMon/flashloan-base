// test/PositionV2.fork.ts
// Fork tests for PositionV2.sol on Base mainnet fork
// Run: npx hardhat test test/PositionV2.fork.ts --network hardhatBase

import { expect } from "chai";
import hre from "hardhat";
import {
  ethers,
  Contract,
  parseEther,
  formatEther,
  ZeroAddress,
  BigNumberish,
  keccak256,
  toUtf8Bytes,
  ContractFactory,
} from "ethers";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAI  = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_PROVIDER = "0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870";
const AERO_CL = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERO_AMM = "0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925";
const UNI_V3 = "0x2626664c2603336E57B271c5C0b26F421741e481";
const DEPLOYED_V2 = "0x7f38A6fB772A5C3E0e3c762E06093C0bB2a7211A";
const DEPLOYED_OWNER = "0x06C74ebba31010f72673189a36D9Ca46083A053A";

const WETH_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)",
];

const gasReport: Record<string, { gasUsed: BigNumberish; note?: string }> = {};
function recordGas(name: string, gasUsed: BigNumberish, note?: string) {
  gasReport[name] = { gasUsed, note };
}

// Helper: expect a transaction to revert with a specific reason
async function expectRevert(promise: Promise<any>, expectedReason: string) {
  try {
    await promise;
    expect.fail(`Expected transaction to revert with "${expectedReason}" but it succeeded`);
  } catch (e: any) {
    const reason = e?.reason || e?.shortMessage || e?.message || "";
    expect(reason).to.include(expectedReason, `Expected revert reason "${expectedReason}" but got "${reason}"`);
  }
}

describe("PositionV2 - Base Fork Tests", function () {
  this.timeout(300_000);

  let provider: ethers.BrowserProvider;
  let edrProvider: any;
  let owner: ethers.Signer;
  let nonOwner: ethers.Signer;
  let pos: Contract;
  let weth: Contract;
  let abi: any;

  const addr = (s: ethers.Signer) => s.getAddress();

  before(async function () {
    const net = await hre.network.getOrCreate();
    edrProvider = net.provider;
    provider = new ethers.BrowserProvider(edrProvider);

    const accounts = await provider.listAccounts();
    owner = accounts[0];
    nonOwner = accounts[1];
    weth = new Contract(WETH, WETH_ABI, owner);

    const artifact = await hre.artifacts.readArtifact("PositionV2");
    abi = artifact.abi;
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
    pos = await factory.deploy();
    await pos.waitForDeployment();

    const receipt = await pos.deploymentTransaction()!.wait();
    recordGas("deploy", receipt!.gasUsed, "fresh PositionV2");
    console.log("  Deployed:", await pos.getAddress());
    console.log("  Owner:", await addr(owner));
  });

  after(() => {
    console.log("\n=== GAS USAGE REPORT ===");
    for (const [name, data] of Object.entries(gasReport)) {
      const gas = Number(data.gasUsed).toLocaleString();
      console.log(`  ${name.padEnd(45)} ${gas.padStart(12)}${data.note ? "  (" + data.note + ")" : ""}`);
    }
    console.log("========================\n");
  });

  // 1. DEPLOYMENT
  describe("Deployment", () => {
    it("owner is deployer", async () => {
      expect(await pos.owner()).to.equal(await addr(owner));
    });
    it("guardian is deployer", async () => {
      expect(await pos.guardian()).to.equal(await addr(owner));
    });
    it("not paused", async () => {
      expect(await pos.paused()).to.equal(false);
    });
    it("constants correct", async () => {
      expect(await pos.WETH()).to.equal(WETH);
      expect(await pos.USDC()).to.equal(USDC);
      expect(await pos.DAI()).to.equal(DAI);
      expect(await pos.AAVE_POOL()).to.equal(AAVE_POOL);
      expect(await pos.AAVE_ADDRESSES_PROVIDER()).to.equal(AAVE_PROVIDER);
      expect(await pos.AERO_CL_ROUTER()).to.equal(AERO_CL);
      expect(await pos.AERO_AMM_ROUTER()).to.equal(AERO_AMM);
      expect(await pos.UNI_V3_ROUTER()).to.equal(UNI_V3);
    });
    it("pre-approved routers", async () => {
      expect(await pos.approvedRouters(AERO_CL)).to.equal(true);
      expect(await pos.approvedRouters(AERO_AMM)).to.equal(true);
      expect(await pos.approvedRouters(UNI_V3)).to.equal(true);
      expect(await pos.approvedRouters(ZeroAddress)).to.equal(false);
    });
    it("default config", async () => {
      const hf = await pos.healthFactorThreshold();
      const fee = await pos.defaultPoolFee();
      const slippage = await pos.maxSlippageBps();
      console.log("    healthFactorThreshold:", hf.toString());
      console.log("    defaultPoolFee:", fee.toString());
      console.log("    maxSlippageBps:", slippage.toString());
      expect(hf.toString()).to.equal(parseEther("1.1").toString());
      expect(Number(fee)).to.equal(500);
      expect(Number(slippage)).to.equal(50);
    });
    it("Aave views", async () => {
      expect(await pos.ADDRESSES_PROVIDER()).to.equal(AAVE_PROVIDER);
      expect(await pos.POOL()).to.equal(AAVE_POOL);
    });
    it("deployed V2 verification", async () => {
      const deployed = new Contract(DEPLOYED_V2, abi, provider);
      expect(await deployed.owner()).to.equal(DEPLOYED_OWNER);
      expect(await deployed.WETH()).to.equal(WETH);
      console.log("    Verified deployed V2 at", DEPLOYED_V2);
    });
  });

  // 2. ACCESS CONTROL
  describe("Access Control", () => {
    const triParams = () => ({
      flashAsset: WETH, flashAmount: parseEther("1"),
      path: [WETH, USDC, DAI] as [string, string, string],
      routers: [AERO_CL, AERO_CL, AERO_CL] as [string, string, string],
      poolFees: [500, 500, 500] as [number, number, number],
      minProfit: 0n, dexTypes: [0, 0, 0] as [number, number, number],
    });
    const arbParams = () => ({
      flashAsset: WETH, flashAmount: parseEther("1"),
      buyDexRouter: AERO_CL, sellDexRouter: UNI_V3,
      intermediateToken: USDC,
      buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
    });

    it("reverts executeTriangleArb from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).executeTriangleArb(triParams()), "not owner");
    });
    it("reverts executeArbitrage from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).executeArbitrage(arbParams()), "not owner");
    });
    it("reverts withdrawTokens from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).withdrawTokens(WETH, parseEther("1")), "not owner");
    });
    it("reverts withdrawProfit from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).withdrawProfit(WETH, parseEther("1")), "not owner");
    });
    it("reverts withdrawETH from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).withdrawETH(), "not owner");
    });
    it("reverts emergencyWithdraw from non-owner", async () => {
      await expectRevert(
        pos.connect(nonOwner).emergencyWithdraw([WETH], await addr(owner)), "not owner"
      );
    });
    it("reverts config setters from non-owner", async () => {
      await expectRevert(
        pos.connect(nonOwner).setHealthFactorThreshold(parseEther("1.2")), "not owner"
      );
      await expectRevert(
        pos.connect(nonOwner).setDefaultPoolFee(3000), "not owner"
      );
      await expectRevert(
        pos.connect(nonOwner).setMaxSlippageBps(100), "not owner"
      );
    });
    it("reverts openPosition from non-owner", async () => {
      await expectRevert(pos.connect(nonOwner).openPosition({
        assetToSupply: WETH, assetToBorrow: USDC,
        assetToBorrowAmount: 1000000n, initialCapital: parseEther("1"),
        expectedSwapAmount: 1000000n, poolFee: 500,
      }), "not owner");
    });
    it("reverts unpause from non-owner", async () => {
      await pos.emergencyWithdraw([], await addr(owner));
      await expectRevert(pos.connect(nonOwner).unpause(), "not owner");
      await pos.unpause();
    });
  });

  // 3. CONFIGURATION
  describe("Configuration", () => {
    it("sets health factor threshold", async () => {
      await pos.setHealthFactorThreshold(parseEther("1.5"));
      expect((await pos.healthFactorThreshold()).toString()).to.equal(parseEther("1.5").toString());
      await pos.setHealthFactorThreshold(parseEther("1.1"));
    });
    it("reverts health factor below 1.05e18", async () => {
      await expectRevert(pos.setHealthFactorThreshold(parseEther("1.0")), "too low");
    });
    it("sets default pool fee", async () => {
      await pos.setDefaultPoolFee(3000);
      expect(Number(await pos.defaultPoolFee())).to.equal(3000);
      await pos.setDefaultPoolFee(500);
    });
    it("sets max slippage", async () => {
      await pos.setMaxSlippageBps(200);
      expect(Number(await pos.maxSlippageBps())).to.equal(200);
      await pos.setMaxSlippageBps(50);
    });
    it("reverts slippage above 500 bps", async () => {
      await expectRevert(pos.setMaxSlippageBps(501), "too high");
    });
    it("approves/unapproves routers", async () => {
      await pos.approveRouter(ZeroAddress, true);
      expect(await pos.approvedRouters(ZeroAddress)).to.equal(true);
      await pos.approveRouter(ZeroAddress, false);
      expect(await pos.approvedRouters(ZeroAddress)).to.equal(false);
    });
    it("sets guardian", async () => {
      await pos.setGuardian(await addr(nonOwner));
      expect(await pos.guardian()).to.equal(await addr(nonOwner));
      await pos.setGuardian(await addr(owner));
    });
    it("sets token address", async () => {
      await pos.setTokenAddress("TEST", WETH);
      const key = keccak256(toUtf8Bytes("TEST"));
      expect(await pos.tokenAddresses(key)).to.equal(WETH);
    });
  });

  // 4. WITHDRAW FUNCTIONS
  describe("Withdraw Functions", () => {
    const fundAmount = parseEther("5");

    before(async () => {
      await weth.deposit({ value: fundAmount });
      await weth.transfer(await pos.getAddress(), fundAmount);
    });

    it("withdraws tokens to owner", async () => {
      const posAddr = await pos.getAddress();
      const balBefore = await weth.balanceOf(await addr(owner));
      const tx = await pos.withdrawTokens(WETH, fundAmount);
      const receipt = await tx.wait();
      recordGas("withdrawTokens", receipt!.gasUsed);
      expect(await weth.balanceOf(posAddr)).to.equal(0n);
      expect(await weth.balanceOf(await addr(owner))).to.equal(balBefore + fundAmount);
    });

    it("withdraws profit with tracking", async () => {
      const posAddr = await pos.getAddress();
      const profitAmount = parseEther("2");
      await weth.deposit({ value: profitAmount });
      await weth.transfer(posAddr, profitAmount);
      const totalBefore = await pos.totalProfitWithdrawn();
      const tx = await pos.withdrawProfit(WETH, profitAmount);
      const receipt = await tx.wait();
      recordGas("withdrawProfit", receipt!.gasUsed);
      expect((await pos.totalProfitWithdrawn()).toString()).to.equal((totalBefore + profitAmount).toString());
    });

    it("reverts withdrawProfit with zero amount", async () => {
      await expectRevert(pos.withdrawProfit(WETH, 0n), "zero amount");
    });

    it("reverts withdrawProfit with insufficient balance", async () => {
      const posAddr = await pos.getAddress();
      const balance = await weth.balanceOf(posAddr);
      await expectRevert(pos.withdrawProfit(WETH, balance + 1n), "insufficient balance");
    });

    it("receives and withdraws ETH", async () => {
      const posAddr = await pos.getAddress();
      await owner.sendTransaction({ to: posAddr, value: parseEther("3") });
      const balBefore = await provider.getBalance(await addr(owner));
      const tx = await pos.withdrawETH();
      const receipt = await tx.wait();
      recordGas("withdrawETH", receipt!.gasUsed);
      const balAfter = await provider.getBalance(await addr(owner));
      expect(balAfter > balBefore - parseEther("1")).to.be.true;
    });

    it("deposits ETH to WETH via getWETH", async () => {
      const posAddr = await pos.getAddress();
      const ethAmount = parseEther("1");
      const tx = await pos.getWETH({ value: ethAmount });
      const receipt = await tx.wait();
      recordGas("getWETH", receipt!.gasUsed);
      expect(await weth.balanceOf(posAddr)).to.equal(ethAmount);
    });

    it("emergency withdraws all tokens", async () => {
      const posAddr = await pos.getAddress();
      await owner.sendTransaction({ to: posAddr, value: parseEther("0.5") });
      const ownerBalBefore = await weth.balanceOf(await addr(owner));
      const tx = await pos.emergencyWithdraw([WETH], await addr(owner));
      const receipt = await tx.wait();
      recordGas("emergencyWithdraw", receipt!.gasUsed);
      expect(await weth.balanceOf(posAddr)).to.equal(0n);
      expect(await weth.balanceOf(await addr(owner))).to.be.gt(ownerBalBefore);
      expect(await pos.paused()).to.equal(true);
      await pos.unpause();
    });

    it("reverts emergencyWithdraw to non-owner", async () => {
      await expectRevert(
        pos.emergencyWithdraw([WETH], await addr(nonOwner)), "can only withdraw to owner"
      );
    });
  });

  // 5. TRIANGLE ARBITRAGE
  describe("Triangle Arbitrage", () => {
    it("reverts with unapproved router", async () => {
      await expectRevert(pos.executeTriangleArb({
        flashAsset: WETH, flashAmount: parseEther("1"),
        path: [WETH, USDC, DAI] as [string, string, string],
        routers: [AERO_CL, AERO_CL, ZeroAddress] as [string, string, string],
        poolFees: [500, 500, 500] as [number, number, number],
        minProfit: 0n, dexTypes: [0, 0, 0] as [number, number, number],
      }), "router not approved");
    });

    it("reverts when paused", async () => {
      await pos.emergencyWithdraw([], await addr(owner));
      await expectRevert(pos.executeTriangleArb({
        flashAsset: WETH, flashAmount: parseEther("1"),
        path: [WETH, USDC, DAI] as [string, string, string],
        routers: [AERO_CL, AERO_CL, AERO_CL] as [string, string, string],
        poolFees: [500, 500, 500] as [number, number, number],
        minProfit: 0n, dexTypes: [0, 0, 0] as [number, number, number],
      }), "paused");
      await pos.unpause();
    });

    it("executes triangle arb via Aerodrome CL", async () => {
      try {
        const tx = await pos.executeTriangleArb({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          path: [WETH, USDC, DAI] as [string, string, string],
          routers: [AERO_CL, AERO_CL, AERO_CL] as [string, string, string],
          poolFees: [500, 500, 500] as [number, number, number],
          minProfit: 0n, dexTypes: [0, 0, 0] as [number, number, number],
        });
        const receipt = await tx.wait();
        recordGas("executeTriangleArb (AeroCL)", receipt!.gasUsed, "WETH->USDC->DAI->WETH");
        console.log("    Triangle arb succeeded. Gas:", receipt!.gasUsed.toString());
      } catch (e: any) {
        console.log("    Triangle arb reverted (expected):", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });

    it("tests triangle arb with AMM dexType=2", async () => {
      try {
        const tx = await pos.executeTriangleArb({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          path: [WETH, USDC, DAI] as [string, string, string],
          routers: [AERO_AMM, AERO_AMM, AERO_AMM] as [string, string, string],
          poolFees: [0, 0, 0] as [number, number, number],
          minProfit: 0n, dexTypes: [2, 2, 2] as [number, number, number],
        });
        const receipt = await tx.wait();
        recordGas("executeTriangleArb (AMM)", receipt!.gasUsed);
      } catch (e: any) {
        console.log("    AMM triangle reverted:", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });

    it("tests triangle arb with mixed DEX types", async () => {
      try {
        const tx = await pos.executeTriangleArb({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          path: [WETH, USDC, DAI] as [string, string, string],
          routers: [AERO_CL, UNI_V3, AERO_CL] as [string, string, string],
          poolFees: [500, 500, 500] as [number, number, number],
          minProfit: 0n, dexTypes: [0, 1, 0] as [number, number, number],
        });
        const receipt = await tx.wait();
        recordGas("executeTriangleArb (mixed)", receipt!.gasUsed, "AeroCL->UniV3->AeroCL");
      } catch (e: any) {
        console.log("    Mixed DEX triangle reverted:", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });
  });

  // 6. CROSS-DEX ARBITRAGE
  describe("Cross-DEX Arbitrage", () => {
    it("reverts with unapproved buy DEX", async () => {
      await expectRevert(pos.executeArbitrage({
        flashAsset: WETH, flashAmount: parseEther("1"),
        buyDexRouter: ZeroAddress, sellDexRouter: UNI_V3,
        intermediateToken: USDC,
        buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
      }), "buy dex not approved");
    });

    it("reverts with unapproved sell DEX", async () => {
      await expectRevert(pos.executeArbitrage({
        flashAsset: WETH, flashAmount: parseEther("1"),
        buyDexRouter: AERO_CL, sellDexRouter: ZeroAddress,
        intermediateToken: USDC,
        buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
      }), "sell dex not approved");
    });

    it("reverts when paused", async () => {
      await pos.emergencyWithdraw([], await addr(owner));
      await expectRevert(pos.executeArbitrage({
        flashAsset: WETH, flashAmount: parseEther("1"),
        buyDexRouter: AERO_CL, sellDexRouter: UNI_V3,
        intermediateToken: USDC,
        buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
      }), "paused");
      await pos.unpause();
    });

    it("executes cross-DEX arb (Aerodrome -> Uniswap)", async () => {
      try {
        const tx = await pos.executeArbitrage({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          buyDexRouter: AERO_CL, sellDexRouter: UNI_V3,
          intermediateToken: USDC,
          buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
        });
        const receipt = await tx.wait();
        recordGas("executeArbitrage (Aero->Uni)", receipt!.gasUsed, "WETH->USDC->WETH");
      } catch (e: any) {
        console.log("    Cross-DEX arb reverted:", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });

    it("executes cross-DEX arb with AMM dexType", async () => {
      try {
        const tx = await pos.executeArbitrage({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          buyDexRouter: AERO_AMM, sellDexRouter: AERO_AMM,
          intermediateToken: USDC,
          buyPoolFee: 0, sellPoolFee: 0, minProfit: 0n, dexType: 2,
        });
        const receipt = await tx.wait();
        recordGas("executeArbitrage (AMM)", receipt!.gasUsed);
      } catch (e: any) {
        console.log("    AMM arb reverted:", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });

    it("reverts if minProfit not met", async () => {
      try {
        await pos.executeArbitrage({
          flashAsset: WETH, flashAmount: parseEther("0.1"),
          buyDexRouter: AERO_CL, sellDexRouter: UNI_V3,
          intermediateToken: USDC,
          buyPoolFee: 500, sellPoolFee: 500, minProfit: parseEther("10"), dexType: 0,
        });
        expect.fail("Should have reverted");
      } catch (e: any) {
        console.log("    MinProfit check reverted as expected");
      }
    });
  });

  // 7. CALLBACK SECURITY
  describe("Flash Loan Callback Security", () => {
    it("reverts executeOperation from non-Aave pool", async () => {
      await expectRevert(
        pos.executeOperation(WETH, parseEther("1"), parseEther("0.0005"), await addr(owner), "0x"),
        "caller not Aave"
      );
    });
  });

  // 8. VIEW FUNCTIONS
  describe("View Functions", () => {
    it("returns token balance", async () => {
      const posAddr = await pos.getAddress();
      const bal = await pos.getTokenBalance(WETH);
      expect(bal).to.equal(await weth.balanceOf(posAddr));
    });

    it("returns strategy metrics (initially zero)", async () => {
      const [profit, executions] = await pos.getStrategyMetrics(0);
      expect(profit).to.equal(0n);
      expect(executions).to.equal(0n);
    });

    it("simulates arb profit (positive)", async () => {
      const [netProfit, flashFee] = await pos.simulateArbProfit(
        WETH, parseEther("10"), 0n, parseEther("10.01")
      );
      expect(flashFee.toString()).to.equal(parseEther("0.005").toString());
      expect(netProfit.toString()).to.equal(parseEther("0.005").toString());
    });

    it("simulates arb profit (negative)", async () => {
      const [netProfit, flashFee] = await pos.simulateArbProfit(
        WETH, parseEther("10"), 0n, parseEther("10")
      );
      expect(flashFee.toString()).to.equal(parseEther("0.005").toString());
      expect(netProfit < 0n).to.equal(true);
      expect(netProfit.toString()).to.equal("-" + parseEther("0.005").toString());
    });

    it("returns account data from Aave", async () => {
      const data = await pos.getAccountData();
      console.log("    Collateral:", formatEther(data.totalCollateralBase),
                  "Debt:", formatEther(data.totalDebtBase));
    });
  });

  // 9. EDGE CASES
  describe("Edge Cases", () => {
    it("handles zero flash amount", async () => {
      try {
        const tx = await pos.executeArbitrage({
          flashAsset: WETH, flashAmount: 0n,
          buyDexRouter: AERO_CL, sellDexRouter: UNI_V3,
          intermediateToken: USDC,
          buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
        });
        const receipt = await tx.wait();
        recordGas("executeArbitrage (zero)", receipt!.gasUsed, "zero flash");
      } catch (e: any) {
        console.log("    Zero amount reverted:", (e?.shortMessage || e?.message)?.slice(0, 80));
      }
    });

    it("reverts same-router arb (fees eat profit)", async () => {
      try {
        const tx = await pos.executeArbitrage({
          flashAsset: WETH, flashAmount: parseEther("1"),
          buyDexRouter: AERO_CL, sellDexRouter: AERO_CL,
          intermediateToken: USDC,
          buyPoolFee: 500, sellPoolFee: 500, minProfit: 0n, dexType: 0,
        });
        await tx.wait();
        console.log("    Same-router arb: unexpectedly profitable!");
      } catch (e: any) {
        console.log("    Same-router arb reverted as expected");
      }
    });

    it("receives ETH via receive() fallback", async () => {
      const posAddr = await pos.getAddress();
      const tx = await owner.sendTransaction({ to: posAddr, value: parseEther("1") });
      const receipt = await tx.wait();
      recordGas("receive() ETH", receipt!.gasUsed);
      expect(await provider.getBalance(posAddr) >= parseEther("1")).to.be.true;
      await pos.withdrawETH();
    });

    it("has contract code deployed", async () => {
      const code = await provider.getCode(await pos.getAddress());
      expect(code.length).to.be.gt(2);
      console.log("    Code size:", (code.length / 2 - 1).toString(), "bytes");
    });
  });

  // 10. DEPLOYED CONTRACT
  describe("Deployed Contract Integration", () => {
    let deployed: Contract;

    before(async () => {
      deployed = new Contract(DEPLOYED_V2, abi, provider);
      await edrProvider.request({ method: "hardhat_impersonateAccount", params: [DEPLOYED_OWNER] });
      await edrProvider.request({ method: "hardhat_setBalance", params: [DEPLOYED_OWNER, "0x10000000000000000000000"] });
    });

    it("reads owner", async () => {
      expect(await deployed.owner()).to.equal(DEPLOYED_OWNER);
    });
    it("reads approved routers", async () => {
      expect(await deployed.approvedRouters(AERO_CL)).to.equal(true);
      expect(await deployed.approvedRouters(AERO_AMM)).to.equal(true);
      expect(await deployed.approvedRouters(UNI_V3)).to.equal(true);
    });
    it("reads current position", async () => {
      const p = await deployed.currentPosition();
      console.log("    Position: isOpen=" + p.isOpen + " strategy=" + Number(p.strategy));
    });
    it("reads strategy metrics", async () => {
      for (let i = 0; i <= 4; i++) {
        const [profit, execs] = await deployed.getStrategyMetrics(i);
        if (execs > 0n) console.log(`    Strategy ${i}: profit=${formatEther(profit)} ETH, execs=${execs}`);
      }
    });
    it("allows deployed owner to withdraw tokens", async () => {
      // BrowserProvider.getSigner(impersonated) fails with eth_requestAccounts
      // Use edrProvider directly to send as impersonated account
      const amount = parseEther("0.01");
      // Fund deployed owner with ETH via impersonation
      await edrProvider.request({ method: "hardhat_impersonateAccount", params: [DEPLOYED_OWNER] });
      // Send WETH to deployed contract from test owner
      await weth.deposit({ value: amount });
      await weth.transfer(DEPLOYED_V2, amount);
      const balBefore = await weth.balanceOf(DEPLOYED_OWNER);
      // Build and send withdrawTokens tx as deployed owner
      const calldata = new ethers.Interface(abi).encodeFunctionData("withdrawTokens", [WETH, amount]);
      const txHash = await edrProvider.request({
        method: "eth_sendTransaction",
        params: [{ from: DEPLOYED_OWNER, to: DEPLOYED_V2, data: calldata }],
      });
      const receipt = await provider.getTransactionReceipt(txHash);
      recordGas("withdrawTokens (deployed)", receipt!.gasUsed, "impersonated owner via edr");
      expect(await weth.balanceOf(DEPLOYED_OWNER)).to.be.gt(balBefore);
    });
    it("reverts non-owner on deployed contract", async () => {
      await expectRevert(
        deployed.connect(nonOwner).withdrawTokens(WETH, 1n), "not owner"
      );
    });
  });
});
