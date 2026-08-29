# Build the self-contained binary, then ship it on a small base image.
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun build --compile --target=bun-linux-x64 --minify ./src/index.ts --outfile /out/4read-abs

FROM debian:bookworm-slim
LABEL org.opencontainers.image.title="4read-abs" \
      org.opencontainers.image.description="4read.org audiobook metadata for Audiobookshelf" \
      org.opencontainers.image.source="https://github.com/kriakiku/4read-abs"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/4read-abs /usr/local/bin/4read-abs
COPY config.example.yaml /app/config.example.yaml

# Writable state; mount volumes over these in production.
RUN mkdir -p /data /staging /config
ENV CONFIG_FILE=/config/config.yaml \
    DATA_DIR=/data \
    STAGING_DIR=/staging \
    HOST=0.0.0.0 \
    PORT=8480

EXPOSE 8480
VOLUME ["/data", "/staging", "/config", "/library"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/usr/local/bin/4read-abs", "--version"]

ENTRYPOINT ["/usr/local/bin/4read-abs"]
CMD ["serve"]
