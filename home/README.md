# Home deployment

This repo is a copy of
[robdimsdale/anova-oven-rs](https://github.com/robdimsdale/anova-oven-rs).
It runs our Anova Precision Oven v1 (hardware `240V1`, firmware `2.1.16`)
with no Anova cloud. Everything in `home/` is ours. The rest is upstream
code plus our own changes.

## Remotes

| Remote | Repo | Use |
|---|---|---|
| `origin` | `urosgruber/anova-oven` | Push our work here. |
| `upstream` | `robdimsdale/anova-oven-rs` | Fetch only. Push is disabled. |

## Get upstream changes

```bash
git fetch upstream
git merge upstream/main     # resolve conflicts, if any
git push
```

Then rebuild the server and restart it (see below).

## Build

```bash
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#cmake nixpkgs#pkg-config nixpkgs#openssl nixpkgs#perl \
  --command cargo build --release -p anova-oven-server
```

The web page is compiled into the binary. After a change to a UI file,
rebuild the server and restart it.

## Run

```bash
home/run-server.sh
```

- The oven connects on port 443. The web page is on port 8080.
- Runtime data is in `home/data/`. Git ignores this folder.
- To connect Home Assistant, copy `home/.env.example` to `home/.env` and
  fill it in. Git ignores `home/.env`.

## How the oven finds the server

The local DNS server (dnsmasq) has this line in
`/etc/dnsmasq.hosts`:

```
<server-ip> iot-prod.anovaculinary.io
```

`<server-ip>` is the machine that runs the server. To go back to the
Anova cloud, delete the line, run `sudo systemctl reload dnsmasq`, and
unplug the oven for 10 seconds.

## Home Assistant app

`ha-app/` packages the server as a local Home Assistant app (amd64). The
HA host builds it from source.

1. Mount the Samba share `addons`, or use the SSH app.
2. Run `home/deploy-ha-app.sh /Volumes/addons` (or `ssh:<host>`).
3. In HA: Settings → Apps → App store → ⋮ → Check for updates. Install
   "Anova Oven" from "Local apps".

The oven still connects on port 443, and HA owns 443. The app listens on
4443. A UniFi destination-NAT rule (only for the oven's IP address)
changes 443 to 4443. See `ha-app/DOCS.md`.

## Wi-Fi setup without the Anova app

1. Hold the oven's Wi-Fi button for 5 seconds, until it shows a PIN.
2. Run `home/provision.sh <PIN> "<Wi-Fi name>"`.

## Our changes to upstream code

- The web page shows °C by default (`ui/common.js`).
- All page links are relative to a `<base>`. Behind HA ingress, the server sets the base from `X-Ingress-Path` (`http/ui.rs`).
- The light buttons show "Turning on…" until the oven confirms, and lock until then (`ui/index.html`).
