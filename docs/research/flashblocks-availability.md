# Flashblocks Availability on Base Chain via Alchemy

> Research Date: 2026-06-10
> Status: CONFIRMED AVAILABLE

## Executive Summary

Alchemy Flashblocks ARE available on Base mainnet. Flashblocks stream partial block updates every 200ms, reducing effective confirmation latency from 2 seconds to 200ms. Alchemy has supported Flashblocks on Base from day one of the mainnet launch.

## Availability Confirmation

| Attribute | Value |
|-----------|-------|
| Available on Base Mainnet | YES |
| Available on Base Sepolia | YES |
| Latency | 200ms (vs 2s standard blocks) |
| Protocol | Out-of-protocol extension (no consensus change) |
| Alchemy Support | Day-one support |
| Status | LIVE on mainnet |

Sources:
- Alchemy official docs: https://www.alchemy.com/docs/reference/base-flashblocks-api-quickstart
- Base official docs: https://docs.base.org/base-chain/flashblocks/overview
- Alchemy announcement (X/Twitter): confirmed live on mainnet with 10x faster effective block times

## How to Access

### WebSocket Connection

```
wss://base-mainnet.g.alchemy.com/v2/<YOUR_API_KEY>      # Mainnet
wss://base-sepolia.g.alchemy.com/v2/<YOUR_API_KEY>      # Testnet
```

Uses the same Alchemy API key and endpoint as standard Base RPC. No separate signup or special endpoint needed.

### HTTP Queries with Flashblock State

Standard JSON-RPC calls work with the `"pending"` block tag to query the latest flashblock state:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_getBlockByNumber",
  "params": ["pending", false],
  "id": 1
}
```

Supported methods with `"pending"` tag:
- `eth_getBlockByNumber`
- `eth_getBalance`
- `eth_call`
- `eth_getStorageAt`
- `eth_getCode`

HTTP endpoint: `https://base-mainnet.g.alchemy.com/v2/<YOUR_API_KEY>`

### WebSocket Subscriptions

Subscribe via `eth_subscribe` with these Flashblocks-specific subscription types:

#### 1. `newFlashblocks`

Receive incremental block state updates every 200ms.

```json
// Subscribe
{
  "jsonrpc": "2.0",
  "method": "eth_subscribe",
  "params": ["newFlashblocks"],
  "id": 1
}

// Response notification
{
  "jsonrpc": "2.0",
  "method": "eth_subscription",
  "params": {
    "subscription": "0x...",
    "result": {
      "number": "0x...",
      "hash": "0x...",
      "parentHash": "0x...",
      "timestamp": "0x...",
      "gasLimit": "0x...",
      "gasUsed": "0x...",
      "transactions": [...]
    }
  }
}
```

#### 2. `newFlashblockTransactions`

Receive pending transactions as they are included in flashblocks.

```json
{
  "jsonrpc": "2.0",
  "method": "eth_subscribe",
  "params": ["newFlashblockTransactions"],
  "id": 1
}
```

#### 3. `pendingLogs`

Receive logs from pending transactions in flashblocks. Supports optional filter:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_subscribe",
  "params": ["pendingLogs", {"address": "0x...", "topics": ["0x..."]}],
  "id": 1
}
```

Notification schema:

```json
{
  "subscription": "0x...",
  "result": {
    "address": "0x...",
    "topics": ["0x..."],
    "data": "0x...",
    "blockNumber": "0x...",
    "transactionHash": "0x...",
    "transactionIndex": "0x...",
    "blockHash": "0x...",
    "logIndex": "0x...",
    "removed": false
  }
}
```

## Plan Tier

The Alchemy documentation does not explicitly state the minimum plan tier for Flashblocks access. Based on the feature being available via standard WebSocket endpoints:

- **Likely available on all tiers** including Free/Developer (same as standard WebSocket subscriptions)
- **Rate limits apply** per tier (Free: 300M compute units/month, Growth: higher)
- **Recommendation**: Test with your current Alchemy API key. If rate-limited, upgrade to Growth tier.

## What Flashblocks Are

Flashblocks are ephemeral sub-blocks streamed every 200ms within a standard 2-second block window. The Base sequencer produces lightweight partial blocks and streams them to nodes in real time. They are NOT full blocks — they are preconfirmations that provide near-instant feedback on transaction inclusion and state changes.

Key properties:
- **Not consensus-level**: Out-of-protocol extension, no chain fork risk
- **Incremental**: Each flashblock builds on the previous one within a 2s window
- **Non-final**: Full block finality still at 2s; flashblocks are pre-confirmations
- **Compatible**: Works with existing JSON-RPC methods via `"pending"` tag

## Integration for Flash Loan Scanner

For the flashloan-base project's scanner upgrade from 15s polling to 200ms WebSocket:

### Recommended Architecture

```
1. Connect WebSocket to Alchemy Base mainnet
2. Subscribe to newFlashblocks for state updates
3. Subscribe to pendingLogs filtered by DEX pair addresses
4. On each flashblock (~200ms):
   - Parse swap events from Aerodrome, Uniswap V3
   - Update local price cache
   - Run arbitrage detection on price deltas
   - If profitable: submit tx (arrives within same 2s block)
```

### ethers.js v6 Integration Pattern

```typescript
import { WebSocketProvider } from 'ethers';

const wsUrl = `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const provider = new WebSocketProvider(wsUrl);

// Subscribe to flashblock-level pending logs for a DEX pool
const filter = {
  address: POOL_ADDRESS,
  topics: [SWAP_EVENT_TOPIC]
};

provider.on(filter, (log) => {
  // Process swap event with ~200ms latency
  // instead of 15s polling
  handleSwapEvent(log);
});
```

## Alternative Low-Latency Data Sources

If Alchemy Flashblocks are unavailable or insufficient:

### 1. Chainstack Flashblocks on Base

- **URL**: https://chainstack.com/flashblocks-base-rpc/
- **Feature**: Flashblocks streaming via WebSocket
- **Latency**: 200ms sub-block updates
- **Confirmed**: Chainstack published dedicated Flashblocks-on-Base guide
- **Pricing**: Available on Growth+ plans

### 2. QuickNode

- **Feature**: Streams / Marketplace for real-time data
- **Confirmed**: Dwellir comparison lists QuickNode as Flashblocks-capable on Base
- **Use case**: Low-latency WebSocket subscriptions with custom filters

### 3. Dwellir

- **Feature**: Flashblocks endpoint on Base
- **Confirmed**: Listed in RPC provider comparison as Flashblocks-compatible
- **Note**: Smaller provider, verify latency independently

### 4. Base Public RPC with Polling

- **URL**: `https://mainnet.base.org`
- **Latency**: 2s blocks, no sub-second updates
- **Use case**: Fallback only, not suitable for arbitrage

## Network Upgrade Note

Base is scheduled for a V1 network upgrade that includes:
- Simplified Flashblocks WebSocket format
- Osaka support
- Multi-proof system for faster withdrawals

This may change the subscription schema. Monitor Alchemy status page and changelog for breaking changes.

## References

| Source | URL |
|--------|-----|
| Alchemy Flashblocks Quickstart | https://www.alchemy.com/docs/reference/base-flashblocks-api-quickstart |
| Base Flashblocks Overview | https://docs.base.org/base-chain/flashblocks/overview |
| Chainstack Flashblocks on Base | https://chainstack.com/flashblocks-base-rpc/ |
| Chainstack What Are Flashblocks | https://chainstack.com/what-are-flashblocks/ |
| Alchemy Status Page | https://status.alchemy.com/ |
| Base Blog: Scaling Capacity | https://blog.base.dev/scaling-base-doubling-capacity-in-30-days |
| Alchemy X Announcement | https://x.com/Alchemy/status/1945626061146132650 |
| RPC Provider Comparison | https://www.dwellir.com/blog/top-6-base-providers-2025 |
