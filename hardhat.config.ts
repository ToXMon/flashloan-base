import { HardhatUserConfig } from "hardhat/config";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import "dotenv/config";

const config: HardhatUserConfig = {
  plugins: [hardhatVerify, hardhatMocha],
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Local fork of Base for testing
    hardhatBase: {
      type: "edr-simulated",
      chainId: 8453,
      forking: {
        url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      },
    },
    // Base mainnet
    base: {
      type: "http",
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: [
        process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001",
      ],
    },
    // Base Sepolia testnet
    baseSepolia: {
      type: "http",
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: [
        process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001",
      ],
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
};

export default config;
