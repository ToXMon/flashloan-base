# ── Multi-stage build: compile Rust in CI ──────────────────────────
FROM rust:1.80-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache dependencies by copying Cargo manifests first
COPY rust-sidecar/Cargo.toml rust-sidecar/Cargo.lock ./
COPY rust-sidecar/build.rs ./
COPY rust-sidecar/proto proto/

# Create dummy main.rs so cargo can resolve deps
RUN mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs

# Build dependencies only (cached layer)
RUN cargo build --release 2>&1 || true

# Remove dummy source and copy real source
RUN rm -rf src
COPY rust-sidecar/src ./src
COPY rust-sidecar/build.rs ./

# Touch main.rs to force rebuild of the binary (deps unchanged)
RUN touch src/main.rs && cargo build --release

# Download grpc_health_probe
RUN GRPC_HEALTH_PROBE_VERSION=v0.4.28 && \
    wget -qO /usr/local/bin/grpc_health_probe \
      https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/${GRPC_HEALTH_PROBE_VERSION}/grpc_health_probe-linux-amd64 && \
    chmod +x /usr/local/bin/grpc_health_probe

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /build/target/release/flashloan-sidecar /app/flashloan-sidecar

# Copy config if exists
COPY rust-sidecar/config /app/config

# Copy grpc_health_probe
COPY --from=builder /usr/local/bin/grpc_health_probe /usr/local/bin/grpc_health_probe

RUN chown -R appuser:appuser /app && \
    chmod +x /app/flashloan-sidecar

USER appuser

EXPOSE 50051

ENV RUST_LOG=info
ENV GRPC_BIND=0.0.0.0:50051

CMD ["/app/flashloan-sidecar"]
