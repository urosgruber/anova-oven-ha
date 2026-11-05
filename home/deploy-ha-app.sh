#!/usr/bin/env bash
# Copy the Home Assistant app (ha-app/ + the crates it builds from) to the
# HA host's local apps folder. Home Assistant then builds it there.
#
# Usage:
#   home/deploy-ha-app.sh /Volumes/addons     # Samba share "addons", mounted
#   home/deploy-ha-app.sh ssh:<host>          # SSH app; copies to /addons
#
# Then in Home Assistant: Settings → Apps → App store → ⋮ → Check for
# updates. "Anova Oven" shows under "Local apps". Install it, or rebuild it
# after a redeploy.
set -euo pipefail

TARGET=${1:?usage: $0 </Volumes/addons | ssh:host>}
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP=anova_oven

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp "$REPO"/ha-app/{config.yaml,build.yaml,Dockerfile,run.sh} "$stage/"
[ -f "$REPO/ha-app/DOCS.md" ] && cp "$REPO/ha-app/DOCS.md" "$stage/"
mkdir -p "$stage/src/crates"
cp "$REPO"/Cargo.toml "$REPO"/Cargo.lock "$stage/src/"
# Every workspace member must exist for Cargo, even the ones not built.
for crate in anova-oven-api anova-oven-server anova-oven-cli anova-oven-pico-core; do
  rsync -a --exclude target "$REPO/crates/$crate" "$stage/src/crates/"
done

case "$TARGET" in
  ssh:*)
    host=${TARGET#ssh:}
    tar -C "$stage" -czf - . | ssh "$host" "rm -rf /addons/$APP && mkdir -p /addons/$APP && tar -xzf - -C /addons/$APP"
    ;;
  *)
    [ -d "$TARGET" ] || { echo "$TARGET is not a folder. Mount the Samba share 'addons' first." >&2; exit 1; }
    rm -rf "${TARGET:?}/$APP"
    mkdir -p "$TARGET/$APP"
    cp -R "$stage"/. "$TARGET/$APP/"
    ;;
esac

echo "Copied to $TARGET/$APP. In Home Assistant: Apps → App store → ⋮ → Check for updates, then install or rebuild 'Anova Oven'."
