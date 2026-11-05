#!/usr/bin/env bash
# Put an Anova Precision Oven (v1) on your Wi-Fi without the Anova app.
#
# Before you run it: hold the oven's Wi-Fi button for ~5 s until the oven
# shows a 4-digit PIN. The oven then opens the network "Anova Oven <PIN>".
#
# Usage: ./provision.sh <PIN> <home-SSID>
# The script asks for the Wi-Fi password, so it never lands in shell history.
#
# The Mac leaves your home Wi-Fi for about a minute and joins the oven's
# network. At the end it joins your home Wi-Fi again.
#
# API: https://github.com/awkaplan/hacking-the-anova-precision-oven
#      (openapi/provisioning.yaml)
set -euo pipefail

PIN=${1:?usage: $0 <PIN> <home-SSID>}
HOME_SSID=${2:?usage: $0 <PIN> <home-SSID>}
IFACE=${IFACE:-en0}
OVEN=http://192.168.4.1
OVEN_SSID="Anova Oven $PIN"
OVEN_PASS="oven$PIN"

read -rsp "Password for '$HOME_SSID': " HOME_PASS
echo

# The oven reads a JSON string from a form-encoded POST body.
post() { curl -sS --max-time 10 -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-binary "$2" "$OVEN/$1"; }

rejoin_home() {
  echo "Joining '$HOME_SSID' again..."
  networksetup -setairportnetwork "$IFACE" "$HOME_SSID" "$HOME_PASS" || true
}
trap rejoin_home EXIT

echo "Joining '$OVEN_SSID'..."
networksetup -setairportnetwork "$IFACE" "$OVEN_SSID" "$OVEN_PASS"
for _ in $(seq 1 20); do
  curl -s --max-time 2 -o /dev/null "$OVEN/" && break
  sleep 1
done

echo "Firmware:"; post app-info '{}'; echo
echo "Device:";   post prov-identity "$(jq -cn '{user_id: "local"}')"; echo

echo "Sending Wi-Fi credentials..."
post prov-config "$(jq -cn --arg s "$HOME_SSID" --arg p "$HOME_PASS" '{set_wifi: {ssid: $s, passkey: $p}}')"; echo

echo "Waiting for the oven to connect..."
status=""
for _ in $(seq 1 30); do
  status=$(post prov-status '{}' 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true)
  echo "  status: ${status:-?}"
  [ "$status" = "connected" ] && break
  sleep 2
done

if [ "$status" = "connected" ]; then
  post prov-end '{}'; echo
  echo "Done. The oven is on '$HOME_SSID'."
else
  echo "The oven did not report 'connected'. Check the SSID and password, then try again." >&2
  exit 1
fi
