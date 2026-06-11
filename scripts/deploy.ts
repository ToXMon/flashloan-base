import { network } from "hardhat";
const { ethers } = await network.connect();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Position contract on Base...");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const Position = await ethers.getContractFactory("Position");
  const position = await Position.deploy({
    maxFeePerGas: ethers.parseUnits("0.1", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
  });

  await position.waitForDeployment();
  const address = await position.getAddress();

  console.log("Position deployed to:", address);
  console.log("");
  console.log("Next steps:");
  console.log("1. Verify on Basescan: npx hardhat verify --network base", address);
  console.log("2. Fund the contract with initial capital (USDC or WETH)");
  console.log("3. Call openPosition() with your strategy parameters");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
