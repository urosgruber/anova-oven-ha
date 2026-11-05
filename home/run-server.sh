#!/usr/bin/env bash
# Run the local Anova server on this Mac.
#   Oven connects to port 443 (TLS, self-signed cert made at start).
#   Web app for the family: http://<this-mac-ip>:8080
# caffeinate keeps the Mac awake while the server runs.
# Data (recipes, history, current cook) lives in home/data, outside Git.
set -euo pipefail
HOME_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HOME_DIR")"

# Local settings (MQTT broker, logins) live in home/.env, which Git ignores.
# See home/.env.example.
if [ -f "$HOME_DIR/.env" ]; then
  set -a; . "$HOME_DIR/.env"; set +a
fi

export ANOVA_MODE=local
export ANOVA_DATA_DIR="${ANOVA_DATA_DIR:-$HOME_DIR/data}"
mkdir -p "$ANOVA_DATA_DIR"

# Home Assistant over MQTT is off unless ANOVA_MQTT_URL is set. With it, the
# server creates the "Anova Oven" device by MQTT discovery.

echo "Web app: http://$(ipconfig getifaddr en0):8080"
exec caffeinate -i "$REPO/target/release/anova-oven-server"
