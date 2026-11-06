#!/usr/bin/env python3
"""Send the oven's events to the phones of the people in Home Assistant.

Watches the "Cook" event entity (event.anova_oven_cook). Each event goes
to the person who started the cook from the dashboard card (the event's
started_by, an HA user ID). A cook started on the oven has no such person,
so its events go to everyone.

A person's phones are the Companion app's notify services that belong to
their device trackers: device_tracker.<name> -> notify.mobile_app_<name>.

Runs for as long as the app runs; run.sh starts it again if it ends.
"""
import json
import os
import sys

import websocket

EVENT_ENTITY = "event.anova_oven_cook"
AUTO_STOP = "switch.anova_oven_auto_stop"


def log(msg):
    print(f"[notify] {msg}", flush=True)


class Hass:
    """One websocket: replies by ID, events in between kept for later."""

    def __init__(self):
        self.ws = websocket.create_connection("ws://supervisor/core/websocket", timeout=None)
        self.ws.recv()  # auth_required
        self.ws.send(json.dumps({"type": "auth", "access_token": os.environ["SUPERVISOR_TOKEN"]}))
        if json.loads(self.ws.recv()).get("type") != "auth_ok":
            raise RuntimeError("Home Assistant refused the login")
        self.next_id = 0
        self.pending = []

    def send(self, payload):
        self.next_id += 1
        payload["id"] = self.next_id
        self.ws.send(json.dumps(payload))
        return self.next_id

    def call(self, payload):
        msg_id = self.send(payload)
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == msg_id and msg.get("type") == "result":
                return msg
            self.pending.append(msg)

    def receive(self):
        if self.pending:
            return self.pending.pop(0)
        return json.loads(self.ws.recv())


def targets(hass, user_id):
    """The notify services for this user's phones, or for everyone."""
    states = hass.call({"type": "get_states"}).get("result") or []
    services = hass.call({"type": "get_services"}).get("result") or {}
    mobile = set(services.get("notify", {}))

    def phones(person):
        out = []
        for tracker in person["attributes"].get("device_trackers") or []:
            name = "mobile_app_" + tracker.split(".", 1)[1]
            if name in mobile:
                out.append(name)
        return out

    people = [s for s in states if s["entity_id"].startswith("person.")]
    if user_id:
        mine = [p for p in people if p["attributes"].get("user_id") == user_id]
        found = [n for p in mine for n in phones(p)]
        if found:
            return found
        log(f"no phone found for user {user_id}; sending to everyone")
    everyone = sorted({n for p in people for n in phones(p)})
    return everyone or sorted(n for n in mobile if n.startswith("mobile_app_"))


def auto_stop_on(hass):
    states = hass.call({"type": "get_states"}).get("result") or []
    return any(s["entity_id"] == AUTO_STOP and s["state"] == "on" for s in states)


def message(hass, a):
    """(title, text) for an event, or None for events that stay quiet."""
    kind = a.get("event_type")
    title = a.get("recipe_title") or "Oven"
    index = a.get("stage_index")
    count = a.get("stage_count") or 0
    current = a.get("current_stage") or ""
    upcoming = a.get("next_stage") or ""
    if kind == "preheat_done":
        return title, f"Preheat done. The oven is at temperature. Now: {current}"
    if kind == "stage_started" and index is not None:
        return title, f"Step {index + 1} of {count} started: {current}"
    if kind == "stage_waiting" and index is not None:
        return title, f"Step {index + 2} waits for you. Tap Start step {index + 2}. Next: {upcoming}"
    if kind == "cook_done":
        if auto_stop_on(hass):
            return title, "Timer done. The oven stopped."
        return title, "Timer done. The oven holds the temperature until you tap Stop."
    if kind == "temp_reached":
        target = a.get("target_c")
        if target is None:
            return title, "The oven is at temperature."
        degrees = f"{target:.1f}" if a.get("wet") else f"{round(target)}"
        return title, f"The oven is at {degrees} °C."
    if kind == "water_empty":
        return title, "The water tank is empty. Fill it to keep the steam going."
    if kind == "cook_stopped":
        reason = a.get("reason") or {}
        if reason.get("kind") == "safety_limit":
            hours = reason.get("hours") or 0
            return title, (f"Safety stop: the oven ran {hours:g} h with no timer, "
                           "so the App stopped it.")
        return title, "The cook stopped."
    if kind == "oven_lost":
        return title, "The oven went offline during a cook. It may still run."
    return None


def main():
    hass = Hass()
    hass.call({
        "type": "subscribe_trigger",
        "trigger": {"platform": "state", "entity_id": EVENT_ENTITY},
    })
    log("watching the oven's events")
    while True:
        msg = hass.receive()
        if msg.get("type") != "event":
            continue
        trigger = (msg.get("event") or {}).get("variables", {}).get("trigger") or {}
        old, new = trigger.get("from_state"), trigger.get("to_state")
        # A new event changes the state (its time). Skip the entity becoming
        # available or unavailable.
        if not old or not new or new.get("state") in ("unavailable", "unknown") \
                or old.get("state") in ("unavailable", "unknown"):
            continue
        attributes = new.get("attributes") or {}
        text = message(hass, attributes)
        if not text:
            continue
        title, body = text
        for service in targets(hass, attributes.get("started_by")):
            reply = hass.call({
                "type": "call_service", "domain": "notify", "service": service,
                "service_data": {"title": title, "message": body, "data": {"group": "anova-oven"}},
            })
            log(f"{attributes.get('event_type')} -> {service}: {'sent' if reply.get('success') else reply}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # run.sh starts it again
        log(f"stopped: {e}")
        sys.exit(1)
