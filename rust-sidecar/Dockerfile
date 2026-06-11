# ── Single stage: Copy pre-compiled binary only ──────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# Copy pre-compiled binary
COPY rust-sidecar/target/debug/flashloan-sidecar /app/flashloan-sidecar

# Copy config if exists
COPY rust-sidecar/config /app/config

# Download grpc_health_probe for health check
RUN GRPC_HEALTH_PROBE_VERSION=v0.4.28 && \
    wget -qO /usr/local/bin/grpc_health_probe \
      https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/${GRPC_HEALTH_PROBE_VERSION}/grpc_health_probe-linux-amd64 && \
    chmod +x /usr/local/bin/grpc_health_probe

RUN chown -R appuser:appuser /app && \
    chmod +x /app/flashloan-sidecar

USER appuser

EXPOSE 50051

ENV RUST_LOG=info
ENV GRPC_BIND=0.0.0.0:50051

CMD ["/app/flashloan-sidecar"]
