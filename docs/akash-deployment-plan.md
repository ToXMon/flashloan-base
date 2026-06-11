# Akash Deployment Plan — Flash Loan Base

Deploy the two-service flash loan trading system (Rust sidecar + TypeScript core) to Akash Network (decentralized cloud).

## Overview

| Service | Image | CPU | RAM | Storage | Internal Port |
|---------|-------|-----|-----|---------|---------------|
| `rust-sidecar` | `flashloan-rust-sidecar:v1.0.0` | 1.0 | 512Mi | 2Gi | 50051 (gRPC) |
| `typescript-core` | `flashloan-typescript-core:v1.0.0` | 0.5 | 512Mi | 1Gi | — |

Both services communicate internally over gRPC. No ports are exposed to the public internet.

## Prerequisites

1. **Install provider-services CLI**

   Download the latest binary from GitHub releases:

   ```bash
   # Check latest version at https://github.com/akash-network/node/releases
   export AKASH_VERSION="v0.6.8"  # update to latest
   curl -LO https://github.com/akash-network/node/releases/download/${AKASH_VERSION}/akash_${AKASH_VERSION}_linux_amd64.tar.gz
   tar xzf akash_${AKASH_VERSION}_linux_amd64.tar.gz
   sudo mv provider-services /usr/local/bin/
   provider-services version
   ```

   **Note:** The `provider-services` binary is separate from `akash`. Use `provider-services` for all deployment operations.

2. **Create and fund a wallet**

   ```bash
   provider-services keys add my-deploy-key
   # Save the mnemonic securely
   # Fund the address with AKT for escrow + gas
   ```

3. **Fund escrow account with ACT**

   ACT (Akash Compute Token) is used for deployment payments. Mint ACT from AKT via BME:

   ```bash
   akash tx bme mint-act 5000000uakt --from my-deploy-key -y
   ```

   Or use the generic conversion:

   ```bash
   akash tx bme burn-mint 1000000uakt uact --from my-deploy-key -y
   ```

4. **Create an Akash certificate**

   ```bash
   provider-services tx cert create client --from my-deploy-key
   ```

## Step 1: Build Docker Images

The Rust sidecar uses a **pre-compiled binary** (`rust-sidecar/target/debug/flashloan-sidecar`, 94MB). The Dockerfile copies this binary — it does NOT rebuild from source (cargo is not in PATH at build time).

Build both images:

```bash
# From project root
cd /a0/usr/projects/flashloan-base

# Build Rust sidecar (uses pre-compiled binary)
docker build -t flashloan-rust-sidecar:v1.0.0 -f rust-sidecar/Dockerfile .

# Build TypeScript core
docker build -t flashloan-typescript-core:v1.0.0 -f Dockerfile.ts .
```

Verify:
```bash
docker images | grep flashloan
```

## Step 2: Push Images to Registry

Akash needs access to your Docker images. Push to a public registry:

```bash
# Tag with Docker Hub (or your registry)
docker tag flashloan-rust-sidecar:v1.0.0 yourdockerhub/flashloan-rust-sidecar:v1.0.0
docker tag flashloan-typescript-core:v1.0.0 yourdockerhub/flashloan-typescript-core:v1.0.0

# Log in and push
docker login
docker push yourdockerhub/flashloan-rust-sidecar:v1.0.0
docker push yourdockerhub/flashloan-typescript-core:v1.0.0
```

**Update deploy.yaml** with the pushed image names. Replace `image:` lines in `deploy.yaml`:

```yaml
services:
  rust-sidecar:
    image: yourdockerhub/flashloan-rust-sidecar:v1.0.0
  typescript-core:
    image: yourdockerhub/flashloan-typescript-core:v1.0.0
```

## Step 3: Create Deployment

Generate a unique Deployment Sequence Number (DSEQ):

```bash
export DSEQ=$(date +%s)
echo $DSEQ  # Save this value
```

Create the deployment on Akash:

```bash
provider-services tx deployment create deploy.yaml --dseq $DSEQ --from my-deploy-key -y
```

This sends the SDL to the Akash blockchain. The deployment enters a bidding phase where providers compete for your workload.

## Step 4: Wait for Bids

List active bids:

```bash
provider-services query market bid list --owner $(provider-services keys show my-deploy-key -a) --dseq $DSEQ
```

Wait until at least one bid appears (up to ~30 seconds). Bids include the provider address and price.

## Step 5: Create Lease

Select a provider (prefer lower price) and create a lease:

```bash
export PROVIDER=<provider-address-from-bid>

provider-services tx market lease create --dseq $DSEQ --provider $PROVIDER --from my-deploy-key -y
```

## Step 6: Send Manifest

Send the deployment manifest to the chosen provider:

```bash
provider-services send-manifest deploy.yaml --dseq $DSEQ --provider $PROVIDER --from my-deploy-key
```

## Step 7: Verify Deployment Status

```bash
# Check deployment status
provider-services query deployment get --owner $(provider-services keys show my-deploy-key -a) --dseq $DSEQ

# Check lease status
provider-services query market lease list --owner $(provider-services keys show my-deploy-key -a) --dseq $DSEQ

# List running services (may need to check provider dashboard for detailed logs)
```

## Step 8: Monitor the Services

**Get deployment logs** (if provider supports it):

```bash
# Using kubectl on the provider, or check the Akash Console dashboard
# For detailed logs, the provider's dashboard URL will be shown in lease details
```

**Check service health:** The `typescript-core` service connects to `rust-sidecar:50051` via internal Akash DNS. If the connection succeeds, logs will show opportunity scanning output. If the sidecar is not ready, TypeScript will retry (the gRPC client has reconnection logic).

Since both services log to stdout, enable log retrieval via the provider's monitoring tools.

**Internal communication details:**
- `typescript-core` connects to `rust-sidecar:50051` (internal Akash DNS resolves the service name)
- No external ports are exposed
- All RPC traffic is to a public Alchemy endpoint (no private RPC needed)

## Step 9: Export Environment Variables (Optional)

If you need to pass secrets not in the SDL (e.g., `PRIVATE_KEY`), you can set them when creating the deployment:

```bash
# Pass extra env vars via provider-services flags (requires updating deploy.yaml)
# OR use Akash secrets management
```

**Important:** The `PRIVATE_KEY` from `.env` is NOT included in deploy.yaml for security. Pass it as a deployment secret at deploy time, or add it to deploy.yaml's env section before submitting.

## How to Teardown

To stop the deployment and release all resources:

```bash
# Close the deployment (releases lease and stops container)
provider-services tx deployment close --dseq $DSEQ --from my-deploy-key -y

# Verify closed
provider-services query deployment get --owner $(provider-services keys show my-deploy-key -a) --dseq $DSEQ
```

This stops both services immediately. The escrow balance (if any) is returned.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| No bids received | Resources too large or provider attributes | Reduce CPU/RAM, try a different placement group |
| `ImagePullBackOff` | Image not found or private registry | Push to public registry, verify image name/tag |
| `CrashLoopBackOff` | Service crashes on start | Check logs via provider, test Docker image locally first |
| TypeScript can't reach sidecar | Internal DNS not ready | The gRPC client has retry logic; wait up to 30s for DNS propagation |
| gRPC connection refused | Sidecar not ready | Rust sidecar starts gRPC server immediately; check sidecar logs |

## Cost Estimate

| Service | Compute | Price (uact/block) | Est. Daily Cost |
|---------|---------|-------------------|-----------------|
| rust-sidecar | 1.0 CPU, 512MB, 2GB | 1000 uact | ~0.43 ACT |
| typescript-core | 0.5 CPU, 512MB, 1GB | 1000 uact | ~0.43 ACT |
| **Total** | | **2000 uact/block** | **~0.86 ACT/day** |

Actual costs depend on provider pricing and block time (~6 seconds on Akash).

## SDL File Reference

The deployment configuration is at `/a0/usr/projects/flashloan-base/deploy.yaml`.

Key sections:
- **Image tags**: Use explicit versions (`v1.0.0`), never `:latest`
- **Env vars**: Include all non-secret configuration from `.env`
- **Alchemy API key**: Currently embedded in URLs (public endpoint)
- **Secrets**: `PRIVATE_KEY` is excluded — add manually at deploy time

## Security Notes

1. The Alchemy API key is embedded in deploy.yaml URLs. If this is a concern, add as an Akash deployment secret.
2. The private key MUST be passed as a deploy-time secret, never hardcoded.
3. Both services run as non-root users in their Dockerfiles.
4. Port 50051 is internal-only; no external network exposure.
