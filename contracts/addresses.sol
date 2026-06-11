// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title Base Protocol Addresses — All supported tokens, DEXs, and protocols on Base
/// @notice Central address registry for the flash loan system
library BaseTokens {
    // ═══════════════════════════════════════════════════════
    // Core Tokens (checksummed)
    // ═══════════════════════════════════════════════════════
    address constant WETH  = 0x4200000000000000000000000000000000000006;
    address constant USDC  = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDbC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address constant DAI   = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address constant cbETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;

    // LSTs (Liquid Staking Tokens) — popular for leverage farming
    address constant weETH = 0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A;
    address constant rETH  = 0xb6Fe221Fe9Eef5AbA2fA62AB649aa5cBb5C67b60;
    address constant ezETH = 0x2416092f143378750bb29b79eD961ab195CcEea5;

    // ═══════════════════════════════════════════════════════
    // Aave V3 on Base
    // ═══════════════════════════════════════════════════════
    address constant AAVE_POOL          = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant AAVE_ADDRESSES     = 0x2f9eC37D6dffD6C7a5e2C19bbFC8e04b60e5D870;
    address constant AAVE_PRICE_ORACLE  = 0x7f9C732513Dee9Af2967aDAF3D4607F39e6D8333;
    address constant AAVE_INCENTIVES    = 0x929EC64c34a17401F460460D4B9390518E5B473e;
    address constant AAVE_WETH_GATEWAY  = 0xe944a6AC31e9A3b5E4D1bd94aCFD686E7D930fcC;

    // ═══════════════════════════════════════════════════════
    // Aerodrome (Base's #1 DEX by volume)
    // ═══════════════════════════════════════════════════════
    address constant AERO_CL_ROUTER     = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_AMM_ROUTER    = 0xA132dAB612Db5CB9Fc6ee3466f0e59C8C7A7E925;
    address constant AERO_FACTORY       = 0x420dD381B31AEf6683DB6b902084cB0ffEcFc40e;
    address constant AERO_VOTER         = 0x16613524e02ad97eDfeF371bC883F2F5d6C480A5;
    address constant AERO_GAUGE_FACTORY = 0xD97560b21C1d931Fc87e6c5EABE4A6B087ce4a91;

    // ═══════════════════════════════════════════════════════
    // Uniswap V3 on Base
    // ═══════════════════════════════════════════════════════
    address constant UNI_V3_ROUTER      = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant UNI_V3_QUOTER      = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address constant UNI_V3_FACTORY     = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    // ═══════════════════════════════════════════════════════
    // Other DEXs on Base
    // ═══════════════════════════════════════════════════════
    address constant BASESWAP_ROUTER    = 0x3fd11e3879F0A481280bBcbA2C206331575A65e3;
    address constant SUSHI_ROUTER       = 0x6BDED42c6DA8FBf0D2ba55b2Fa120b5292842b49;

    // ═══════════════════════════════════════════════════════
    // Other Protocols
    // ═══════════════════════════════════════════════════════
    address constant BALANCER_VAULT     = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant SEAMLESS_POOL      = 0x3C2ff90A92a9C0892a6894f1e711cbB1258dcc52;

    // ═══════════════════════════════════════════════════════
    // Flashbots / MEV Protection
    // ═══════════════════════════════════════════════════════
    address constant FLASHBOTS_ENDPOINT = 0x96b41208528485C49b84B3e9122185eac3F2778f;
}
