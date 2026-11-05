# Home deployment

This repo is a copy of
[robdimsdale/anova-oven-rs](https://github.com/robdimsdale/anova-oven-rs).
It runs our Anova Precision Oven v1 (hardware `240V1`, firmware `2.1.16`)
with no Anova cloud. Everything in `home/` is ours. The rest is upstream
code plus our own changes.

## Remotes

| Remote | Repo | Use |
|---|---|---|
| `origin` | `urosgruber/anova-oven-ha` | Push our work here. |
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

This repo is also a Home Assistant app repository (`repository.yaml`). The
app is in `ha-app/`.

**Install, once:**

1. In HA: Settings → Apps → App store → ⋮ → Repositories. Add
   `https://github.com/urosgruber/anova-oven-ha`.
2. Install **Anova Oven**.

**Release a new version:**

1. Raise `version` in `ha-app/config.yaml` and commit.
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. GitHub Actions (`.github/workflows/ha-app.yml`) tests the server, builds
   the image and pushes `ghcr.io/urosgruber/anova-oven-ha-amd64:<version>`.
4. HA shows the update. Click **Update**.

The oven still connects on port 443, and HA owns 443. The app listens on
4443. A gateway destination-NAT rule, only for the oven's IP address,
changes 443 to 4443. See `ha-app/DOCS.md`.

## GitHub Actions

Only our workflow `ha-app.yml` runs. `.github/dependabot.yml` is deleted here: dependency updates come from upstream merges. If a merge brings it back, delete it again. Upstream's workflows (`pr.yml`,
`release.yml`, `dependabot-auto-merge.yml`) are disabled on GitHub with
`gh workflow disable`, so upstream merges do not turn them on again.

## Wi-Fi setup without the Anova app

1. Hold the oven's Wi-Fi button for 5 seconds, until it shows a PIN.
2. Run `home/provision.sh <PIN> "<Wi-Fi name>"`.

## Our changes to upstream code

- The web page shows °C by default (`ui/common.js`).
- All page links are relative to a `<base>`. Behind HA ingress, the server sets the base from `X-Ingress-Path` (`http/ui.rs`).
- The light buttons show "Turning on…" until the oven confirms, and lock until then (`ui/index.html`).
