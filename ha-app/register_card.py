#!/usr/bin/env python3
"""Install the dashboard card that ships with this app.

Copies anova-oven-card.js to /homeassistant/www/anova-oven/ (served as
/local/anova-oven/anova-oven-card.js) and registers it as a Lovelace
resource. The URL carries ?v=<app version>, so after an app update the
browsers load the new card instead of a cached one.

Runs at every app start. A failure is logged and the server starts anyway.
"""
import json
import os
import shutil
import sys

import websocket

SOURCE = "/usr/share/anova-oven/anova-oven-card.js"
TARGET_DIR = "/homeassistant/www/anova-oven"
URL = "/local/anova-oven/anova-oven-card.js"


def log(msg):
    print(f"[card] {msg}", flush=True)


def main():
    version = os.environ.get("CARD_VERSION", "dev")
    os.makedirs(TARGET_DIR, exist_ok=True)
    shutil.copyfile(SOURCE, os.path.join(TARGET_DIR, "anova-oven-card.js"))
    log(f"copied the card ({version}) to {TARGET_DIR}")

    ws = websocket.create_connection("ws://supervisor/core/websocket", timeout=15)
    ws.recv()  # auth_required
    ws.send(json.dumps({"type": "auth", "access_token": os.environ["SUPERVISOR_TOKEN"]}))
    if json.loads(ws.recv()).get("type") != "auth_ok":
        log("Home Assistant refused the login; add the resource by hand")
        return 1

    next_id = iter(range(1, 100))

    def call(payload):
        payload["id"] = next(next_id)
        ws.send(json.dumps(payload))
        while True:
            reply = json.loads(ws.recv())
            if reply.get("id") == payload["id"]:
                return reply

    listing = call({"type": "lovelace/resources"})
    if not listing.get("success"):
        log("dashboards use YAML mode; add this resource by hand: "
            f"{URL}?v={version} (type: module)")
        return 0

    url = f"{URL}?v={version}"
    ours = [r for r in listing["result"] if r["url"].split("?")[0] == URL]
    if not ours:
        reply = call({"type": "lovelace/resources/create", "res_type": "module", "url": url})
        log(f"registered the resource {url}" if reply.get("success") else f"could not register: {reply}")
    elif ours[0]["url"] != url:
        reply = call({"type": "lovelace/resources/update", "resource_id": ours[0]["id"],
                      "res_type": "module", "url": url})
        log(f"updated the resource to {url}" if reply.get("success") else f"could not update: {reply}")
    else:
        log(f"the resource is current ({url})")
    ws.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # The server must start even if this fails.
        log(f"failed: {e}")
        sys.exit(1)
