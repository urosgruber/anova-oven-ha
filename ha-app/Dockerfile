# The Home Assistant app image. GitHub Actions builds it from the repo root:
#   docker build -f ha-app/Dockerfile .
# and pushes it to ghcr.io/urosgruber/anova-oven-ha-amd64:<version>.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm

FROM rust:1-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# Every workspace member must exist for Cargo, even the ones not built.
COPY crates/anova-oven-api crates/anova-oven-api
COPY crates/anova-oven-server crates/anova-oven-server
COPY crates/anova-oven-cli crates/anova-oven-cli
COPY crates/anova-oven-pico-core crates/anova-oven-pico-core
RUN cargo build --release --locked -p anova-oven-server

FROM ${BUILD_FROM}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/anova-oven-server /usr/bin/anova-oven-server
COPY ha-app/run.sh /run.sh
RUN chmod a+x /run.sh

ARG BUILD_VERSION=dev
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="amd64" \
      org.opencontainers.image.source="https://github.com/urosgruber/anova-oven-ha"

CMD ["/run.sh"]
