# Built on the Home Assistant host from the sources that
# home/deploy-ha-app.sh copies into src/.
ARG BUILD_FROM

FROM rust:1-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY src/ .
RUN cargo build --release --locked -p anova-oven-server

FROM ${BUILD_FROM}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/anova-oven-server /usr/bin/anova-oven-server
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD ["/run.sh"]
