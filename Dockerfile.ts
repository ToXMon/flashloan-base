# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Stage 2: Runtime
FROM node:22-alpine

# Use existing node user (uid 1000) instead of recreating conflicting group/user
RUN mkdir -p /app && chown -R node:node /app

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/hardhat.config.ts ./
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/contracts ./contracts
COPY --from=builder --chown=node:node /app/scripts ./scripts

USER node

CMD ["npx", "tsx", "src/scanner/dashboard.ts", "monitor"]
