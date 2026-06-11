# Q1: Balancer V2 on Base & Alternative Flash Loan Providers

> Research Date: 2026-06-06 | Source: DeFiLlama API, Protocol Docs, On-Chain Data

---

## Part A: Is Balancer V2 Deployed on Base?

### Answer: YES — Both Balancer V2 and V3 are deployed on Base, but with minimal TVL.

| Protocol | Base TVL | Chains | Status |
|----------|----------|--------|--------|
| **Balancer V2** | $242,795 | Ethereum, Polygon, Arbitrum, Base, Avalanche, Polygon zkEVM, Mode, Fraxtal | Deployed, low adoption |
| **Balancer V3** | $1,125,953 | Ethereum, Arbitrum, Base, Avalanche, Optimism, Monad, others | Deployed, newer version |
| Balancer CoW AMM | $4,955 | Ethereum, Arbitrum, Base, xDai | Minimal |

### Key Observations

1. **Both versions are live on Base** but combined TVL is only ~$1.37M — extremely small compared to Aerodrome ($256M) or Uniswap V3 ($263M)
2. **Beets (Balancer fork)** is primarily on Sonic, NOT on Base — confirmed Beets has no meaningful Base presence
3. **Flash loan feasibility**: Balancer supports flash loans on V2 (Vault) and V3, but the tiny TVL on Base means:
   - Limited pool depth for arbitrage
   - High slippage risk on large borrows
   - Not viable as a primary flash loan source on Base
4. **Verdict**: Balancer on Base is technically available but **not practical** for flash loan strategies. Aave V3 remains the best flash loan provider on Base by far.

### Balancer Flash Loan Mechanics

- **V2 Vault**: `flashLoan(address recipient, IERC20[] tokens, uint256[] amounts, bytes calldata userData)` — 0% fee on V2 (protocol subsidized)
- **V3**: Updated architecture with similar flash loan capability
- **Limitation on Base**: Pool TVL too small to support profitable strategies

---

## Part B: Alternative Flash Loan Providers on Base

### Summary Matrix

| Provider | Type | Base TVL | Fee | Flash Loan? | Practical? |
|----------|------|----------|-----|-------------|------------|
| **Aave V3** | Lending | $349.6M | 0.05% | Full support | PRIMARY |
| **Uniswap V3** | DEX | $263.3M | 0% (gas only) | Flash swaps | YES |
| **Uniswap V4** | DEX | $41.6M | 0% (gas only) | Flash swaps | YES |
| **Morpho Blue** | Lending | $2,447M | Variable | Isolated lending | LIMITED |
| **Compound V3** | Lending | $19.0M | Variable | Absorb function | LIMITED |
| **Moonwell** | Lending | $38.6M | Variable | Standard lending | NO flash |
| **dYdX** | Perps | N/A | N/A | **NOT on Base** | NO |
| **Balancer V2** | DEX | $0.24M | 0% | Yes but tiny TVL | IMPRACTICAL |

---

### 1. Aave V3 (Primary — Already Integrated)

| Detail | Value |
|--------|-------|
| Pool Address | `0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb` |
| PoolAddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| Fee | 0.05% (5 basis points) |
| Base TVL | $349,562,202 |

**Top reserves on Aave V3 Base:**

| Asset | TVL | Address |
|-------|-----|---------|
| cbBTC | $127.0M | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
| weETH | $40.6M | `0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A` |
| USDC | $29.7M | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | $29.2M | `0x4200000000000000000000000000000000000006` |
| cbETH | $29.1M | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` |
| wstETH | $26.1M | `0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452` |

**Flash loan function**: `flashLoanSimple()` or `flashLoan()` on the Pool contract.

---

### 2. Uniswap V3 Flash Swaps (Secondary — Recommended Integration)

| Detail | Value |
|--------|-------|
| Factory | `0x33128a8fC17869897dcE68Ed026d594DD2788a13` |
| SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| Fee | 0% (pay only the pool swap fee on return) |
| Base TVL | $263,287,960 |
| 24h Volume | $356,725,662 |

**How flash swaps work:**

1. Call `exactInputSingle()` or `exactOutputSingle()` on the SwapRouter
2. Alternatively, use the low-level `Pool.swap()` callback pattern
3. Receive tokens first, must return equivalent value within the same transaction
4. No explicit fee — just the pool's swap fee (typically 0.05%, 0.3%, or 1%)
5. If you don't return enough tokens, the transaction reverts

**Advantages over Aave V3 for arb:**
- 0% flash loan fee (only pay the swap fee on return)
- Can borrow any token in any Uniswap V3 pool
- Higher liquidity in WETH/USDC pools than Aave on Base
- Already deployed and well-tested on Base

**Integration complexity**: Medium — requires implementing the `IUniswapV3FlashCallback` or using the router's built-in flash swap functionality

---

### 3. Uniswap V4 Flash (Emerging)

| Detail | Value |
|--------|-------|
| PoolManager | `0x498581fF718922c3f8e6A244956aF099A266748a` |
| Base TVL | $41,629,016 |
| 24h Volume | $176,326,519 |

- V4 supports flash via the `unlock` and `settle` pattern
- Growing rapidly on Base (7-day volume: $1.99B)
- Worth monitoring but V3 is more established for current use

---

### 4. Morpho Blue (Largest TVL on Base — Isolated Lending)

| Detail | Value |
|--------|-------|
| Morpho Contract | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Base TVL | $2,447,081,318 |
| Model | Isolated lending markets (not pooled) |

**Top markets on Base:**

| Market | TVL | APY |
|--------|-----|-----|
| cbBTC | $1,967.5M | 0.00% |
| USDC (various vaults) | $438M+ | 3.1-4.7% |
| WETH | $99.6M | 0.00% |
| cbXRP | $68.5M | 0.00% |

**Flash loan capability**: Morpho Blue does NOT have native flash loan support like Aave. It uses an isolated lending market model where:
- Each market is a pair (collateral + loan token) with independent params
- No shared liquidity pool across markets
- Borrowing requires collateral upfront

**Verdict**: Not useful for flash loans directly, but could serve as an **arbitrage route target** (borrow to exploit price differences between Morpho and other protocols).

---

### 5. Compound V3 (Comet)

| Detail | Value |
|--------|-------|
| Comet (USDC) | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` |
| Comet (WETH) | `0x46e6B214B524310239732D51387075E0e70970Bf` |
| ConfiguratorProxy | `0x316f670Fe2B68B8C2c31e830D3Ece4C5A78EFc7e` |
| Base TVL | $18,975,188 |

**Top markets:**

| Asset | TVL | APY |
|-------|-----|-----|
| cbBTC | $6.2M | 0.00% |
| WETH | $4.2M | 0.00% |
| USDC | $1.1M | 3.16% |
| weETH | $1.0M | 0.00% |

**Flash loan capability**: Compound V3 (Comet) does NOT support traditional flash loans. It has an `absorb()` function that liquidates underwater accounts, and a `withdraw()` function, but no atomic borrow-and-repay mechanism.

**Verdict**: Not useful for flash loans. Too small for meaningful arbitrage routing.

---

### 6. dYdX — NOT on Base

dYdX operates as an appchain (dYdX Chain / v4) built on the Cosmos SDK. It does NOT have any deployment on Base or any EVM L2. dYdX v3 flash loans (which were free) are deprecated. dYdX v4 does not offer flash loans at all.

**Verdict**: Not available on Base. Eliminate from consideration.

---

### 7. Moonwell (Lending)

| Detail | Value |
|--------|-------|
| Comptroller | `0xfBb21d0380beE3312Ba6A1a77875Bd37B37b26eE` |
| Base TVL | $38,643,420 |

- Fork of Compound V2 (not V3)
- Standard borrow/lend, NO flash loan support
- Could be an arbitrage route target for rate differences

---

### Flash Loan Provider Recommendations for Base

| Priority | Provider | Use Case | Action |
|----------|----------|----------|--------|
| 1 | Aave V3 | General flash loans, all strategies | ALREADY INTEGRATED |
| 2 | Uniswap V3 | Flash swaps for arb (0% fee) | INTEGRATE NEXT |
| 3 | Uniswap V4 | Emerging, high volume | MONITOR |
| 4 | Aerodrome | Could implement flash swaps | EVALUATE |

---

## Part C: DEX Ecosystem on Base for Arbitrage Routes

### Overall Base DEX Market

- **Total 24h Volume**: $1,926,853,320
- **Total 7d Volume**: $10,236,646,649
- **Total Protocols**: 804 on Base

### Top DEXes by Volume

| Rank | DEX | 24h Volume | 7d Volume | Base TVL | Flash Swaps? |
|------|-----|-----------|-----------|----------|-------------|
| 1 | **Aerodrome Slipstream** | $761.4M | $5,007M | $148.7M | Yes (CL pools) |
| 2 | **Uniswap V3** | $356.7M | $1,138M | $263.3M | Yes (native) |
| 3 | **PancakeSwap V3** | $211.5M | $1,121M | $17.5M | Yes (Uniswap fork) |
| 4 | **Uniswap V4** | $176.3M | $1,990M | $41.6M | Yes (native) |
| 5 | Aerodrome V1 | $15.6M | $84.2M | $108.0M | Yes (AMM) |
| 6 | Curve DEX | $6.7M | $9.7M | $8.0M | Yes (native) |
| 7 | SushiSwap V3 | Low | Low | $1.3M | Yes (Uniswap fork) |

### Detailed DEX Profiles

#### Aerodrome (Slipstream + V1) — #1 on Base

| Detail | Value |
|--------|-------|
| Slipstream Router | `0xcF77a3Ba9A5CA399B7187e09400e8fA3A3cCBb1e` |
| V1 Factory | `0x420DD381b31aEf6683db6B902084cB0FFecE40Da` |
| Slipstream Factory | `0x5e7BB104BB853c002256C4b7C1ad0c47786b5C26` |
| Combined TVL | $256.8M |
| Combined 24h Vol | $777M |
| Model | Velodrome fork (vote-locked emissions, gauges) |
| Flash Support | Concentrated liquidity pools support flash swaps via callback |

Aerodrome dominates Base DEX volume. Slipstream (CL) handles ~98% of volume. V1 (AMM) is legacy.

#### Uniswap V3 — #2 on Base

| Detail | Value |
|--------|-------|
| Factory | `0x33128a8fC17869897dcE68Ed026d594DD2788a13` |
| SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| TVL | $263.3M |
| 24h Vol | $356.7M |
| Flash Support | Native flash swaps (callback pattern) |

Highest TVL on Base, strong WETH/USDC pairs. Critical for arbitrage routes.

#### PancakeSwap V3 — #3 on Base

| Detail | Value |
|--------|-------|
| V3 Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| V3 Router | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` |
| TVL | $17.5M |
| 24h Vol | $211.5M |
| Flash Support | Yes (Uniswap V3 fork, same callback pattern) |

High volume relative to TVL (efficient capital). Good for small-amount arb.

#### Uniswap V4 — #4 on Base

| Detail | Value |
|--------|-------|
| PoolManager | `0x498581fF718922c3f8e6A244956aF099A266748a` |
| TVL | $41.6M |
| 24h Vol | $176.3M |
| Flash Support | Yes (unlock/settle pattern) |

Growing fast. Hooks architecture enables custom pool logic. 7-day volume already exceeds Uniswap V3.

#### Curve DEX

| Detail | Value |
|--------|-------|
| Router | `0x4c3A70BCCfaD7Ff6FAFfb789A78D6e42AC2E7c45` |
| TVL | $7.96M |
| 24h Vol | $6.7M |
| Flash Support | Yes (native flash loans via Curve pools) |

Small on Base. Useful for stablecoin-to-stablecoin arb routes (crvUSD, USDC, DAI).

#### SushiSwap

| Detail | Value |
|--------|-------|
| V3 Factory | `0x433cEbb0E0c6f79395F92E2cE655E3f0C918C2Ea` |
| Combined TVL | ~$2.4M |
| Flash Support | Yes (V3 has same callback as Uniswap) |

Minimal presence on Base. Not worth integrating for arb.

---

## Arbitrage Route Recommendations

### Primary Routes (Implement Now)

```
1. Aerodrome CL ←→ Uniswap V3    (highest volume pair)
2. Aerodrome CL ←→ PancakeSwap V3 (good volume, different LP base)
3. Uniswap V3 ←→ PancakeSwap V3   (classic cross-DEX arb)
```

### Secondary Routes (Monitor + Evaluate)

```
4. Aerodrome CL ←→ Uniswap V4    (growing fast)
5. Uniswap V3 ←→ Curve            (stablecoin arb)
6. Aerodrome V1 ←→ Aerodrome CL  (internal arb possible)
```

### Flash Loan Strategy Matrix

| Strategy | Flash Source | Arb Route | Min Profit Threshold |
|----------|-------------|-----------|---------------------|
| Cross-DEX Arb | Aave V3 (0.05%) | Aero CL → Uni V3 | >0.07% spread |
| Cross-DEX Arb | Uni V3 Flash (0%+pool fee) | Uni V3 → PCS V3 | >0.05% spread |
| Triangle Arb | Aave V3 | Aero CL WETH/USDC → USDC/cbBTC → cbBTC/WETH | >0.07% total |
| Leverage Farm | Aave V3 | Supply collateral → borrow → loop | Health factor >1.1 |

### Integration Priority

1. **Add Uniswap V3 flash swaps** as alternative to Aave V3 — saves 0.05% fee on routes starting from Uni V3
2. **Add PancakeSwap V3 routing** — third largest volume on Base
3. **Monitor Uniswap V4** — may surpass V3 volume soon
4. **Evaluate Aerodrome internal arb** — CL vs V1 pool price differences

---

## Appendix: Key Contract Addresses on Base

### Flash Loan Providers

| Contract | Address |
|----------|---------|
| Aave V3 Pool | `0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb` |
| Aave V3 PoolAddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| Balancer V2 Vault | (check DeFiLlama for exact address) |

### DEX Routers

| Contract | Address |
|----------|---------|
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7187e09400e8fA3A3cCBb1e` |
| Uniswap V3 SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap V4 PoolManager | `0x498581fF718922c3f8e6A244956aF099A266748a` |
| PancakeSwap V3 Router | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` |
| Curve Router | `0x4c3A70BCCfaD7Ff6FAFfb789A78D6e42AC2E7c45` |

### DEX Factories

| Contract | Address |
|----------|---------|
| Aerodrome V1 Factory | `0x420DD381b31aEf6683db6B902084cB0FFecE40Da` |
| Aerodrome Slipstream Factory | `0x5e7BB104BB853c002256C4b7C1ad0c47786b5C26` |
| Uniswap V3 Factory | `0x33128a8fC17869897dcE68Ed026d594DD2788a13` |
| PancakeSwap V3 Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| SushiSwap V3 Factory | `0x433cEbb0E0c6f79395F92E2cE655E3f0C918C2Ea` |

### Lending Protocols

| Contract | Address |
|----------|---------|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Compound V3 USDC Comet | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` |
| Compound V3 WETH Comet | `0x46e6B214B524310239732D51387075E0e70970Bf` |
| Moonwell Comptroller | `0xfBb21d0380beE3312Ba6A1a77875Bd37B37b26eE` |

---

## Data Sources

- DeFiLlama API: `api.llama.fi/protocols`, `api.llama.fi/protocol/{slug}`, `yields.llama.fi/pools`
- DeFiLlama DEX overview: `api.llama.fi/overview/dexs/Base`
- All data queried live on 2026-06-06
