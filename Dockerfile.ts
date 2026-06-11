# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM node:22-alpine

RUN addgroup --system --gid 1000 appuser && \
    adduser --system --uid 1000 --ingroup appuser appuser

WORKDIR /app

# Copy node_modules and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/hardhat.config.ts ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/contracts ./contracts
COPY --from=builder /app/scripts ./scripts

RUN chown -R appuser:appuser /app

USER appuser

# Default: run scanner in watch mode
CMD ["npx", "tsx", "src/scanner/dashboard.ts", "monitor"]
