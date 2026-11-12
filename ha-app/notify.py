#!/usr/bin/env python3
"""Send the oven's events to the phones of the people in Home Assistant.

Watches the "Cook" event entity (event.anova_oven_cook). Each event goes
to the person who started the cook from the dashboard card (the event's
started_by, an HA user ID). A cook started on the oven has no such person,
so its events go to everyone.

A person's phones are the Companion app's notify services that belong to
their device trackers: device_tracker.<name> -> notify.mobile_app_<name>.

With a smart plug set in the App options (power_switch), a failed stop
or a lost oven during a cook starts an alarm (see Guard): a notification
to everyone with "Turn off power" and "I am here". If nobody answers in
power_cut_minutes, the App turns the plug off.

Runs for as long as the app runs; run.sh starts it again if it ends.
"""
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import websocket

EVENT_ENTITY = "event.anova_oven_cook"
AUTO_STOP = "switch.anova_oven_auto_stop"
CONNECTED = "binary_sensor.anova_oven_connected"
COOKING = "binary_sensor.anova_oven_cooking"
URL = "ws://supervisor/core/websocket"
# Every wait on Home Assistant has a limit. Without one, a connection that
# Core accepts during its start but never answers blocks forever: the
# process does not end, so run.sh does not start it again.
CONNECT_TIMEOUT = 30
# With no message for this long, ask Home Assistant for a pong. No pong
# within the same time: the connection is dead and the process ends.
IDLE_TIMEOUT = 60


def log(msg):
    print(f"[notify] {msg}", flush=True)


def is_timeout(error):
    return isinstance(error, TimeoutError) or type(error).__name__ == "WebSocketTimeoutException"


class Hass:
    """One websocket: replies by ID, events in between kept for later."""

    def __init__(self, ws=None, token=None):
        if ws is None:
            ws = websocket.create_connection(URL, timeout=CONNECT_TIMEOUT)
            token = os.environ["SUPERVISOR_TOKEN"]
        self.ws = ws
        self.next_id = 0
        self.pending = []
        self.ws.settimeout(CONNECT_TIMEOUT)
        if self._recv().get("type") != "auth_required":
            raise RuntimeError("Home Assistant did not ask for a login")
        self.ws.send(json.dumps({"type": "auth", "access_token": token}))
        if self._recv().get("type") != "auth_ok":
            raise RuntimeError("Home Assistant refused the login")

    def _recv(self):
        raw = self.ws.recv()
        if not raw:
            raise ConnectionError("Home Assistant closed the connection")
        return json.loads(raw)

    def send(self, payload):
        self.next_id += 1
        payload["id"] = self.next_id
        self.ws.send(json.dumps(payload))
        return self.next_id

    def call(self, payload):
        msg_id = self.send(payload)
        while True:
            msg = self._recv()
            if msg.get("id") == msg_id and msg.get("type") == "result":
                return msg
            self.pending.append(msg)

    def ping(self):
        """Wait for the pong; a timeout here ends the process."""
        msg_id = self.send({"type": "ping"})
        while True:
            msg = self._recv()
            if msg.get("id") == msg_id and msg.get("type") == "pong":
                return
            self.pending.append(msg)

    def receive(self):
        """The next message, or None after a quiet period. A quiet
        connection is checked with a ping."""
        if self.pending:
            return self.pending.pop(0)
        try:
            return self._recv()
        except Exception as e:
            if not is_timeout(e):
                raise
        self.ping()
        return None


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
    # Steps, as the card counts them: a preheat and its cook are one step.
    index = a.get("step_index")
    count = a.get("step_count") or 0
    current = a.get("current_step") or ""
    upcoming = a.get("next_step") or ""
    prompt = (a.get("next_step_prompt") or "").strip()
    note = f" Note: {prompt}" if prompt else ""
    if kind == "preheat_done":
        return title, f"Preheat done. The oven is at temperature. Now: {current}"
    if kind == "stage_started" and index is not None:
        return title, f"Step {index + 1} of {count} started: {current}"
    if kind == "stage_waiting" and index is not None:
        if a.get("preheat"):
            return title, f"Preheat done. Step {index + 1} waits for you. Tap Start cooking.{note}"
        return title, f"Step {index + 2} waits for you. Tap Start step {index + 2}. Next: {upcoming}{note}"
    if kind == "cook_done":
        if auto_stop_on(hass):
            return title, "Timer done. The oven stopped."
        return title, "Timer done. The oven holds the temperature until you tap Stop."
    if kind == "temp_reached":
        target = a.get("target_c")
        if target is None:
            return title, "The oven is at temperature."
        # The oven's display unit, as in the step texts.
        unit = "°F" if a.get("unit") == "F" else "°C"
        if unit == "°F":
            target = target * 9 / 5 + 32
        degrees = f"{target:.1f}" if a.get("wet") else f"{round(target)}"
        return title, f"The oven is at {degrees} {unit}."
    if kind == "command_failed" and a.get("command") in STOPS:
        return title, ("The App could not stop the oven. Stop it on the oven. "
                       f"({a.get('reason') or 'no reason'})")
    if kind == "cook_scheduled":
        return title, (f"Scheduled cook. The oven starts by itself {local_time(a.get('at'))}. "
                       "To cancel, use Cancel scheduled start on the Anova Oven device.")
    if kind == "command_failed" and a.get("command") == "scheduled_start":
        return title, ("The scheduled cook did not start. Check the oven. "
                       f"({a.get('reason') or 'no reason'})")
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
    if kind == "oven_fault":
        names = ", ".join(FAULTS.get(f, f) for f in a.get("faults") or []) or "unknown part"
        return title, (f"The oven reports a fault. {names[0].upper()}{names[1:]}. "
                       "Stop the oven and check it. Do not leave it on alone.")
    return None


def local_time(at, now=None):
    """'at 16:30', or 'on 10 Nov at 16:30' when it is not today.

    The server sends UTC. The App's TZ is the Home Assistant time zone.
    """
    try:
        zone = ZoneInfo(os.environ.get("TZ") or "UTC")
    except Exception:
        zone = timezone.utc
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00")).astimezone(zone)
    except ValueError:
        return "later"
    today = (now or datetime.now(timezone.utc)).astimezone(zone).date()
    clock = t.strftime("%H:%M")
    if t.date() == today:
        return f"at {clock}"
    return f"on {t.day} {t.strftime('%b')} at {clock}"


# The server's fault names (see protocol::faults), as the phone shows them.
FAULTS = {
    "triacs_failed": "heating element switch (triac) failed",
    "top_element_failed": "top heating element failed",
    "bottom_element_failed": "bottom heating element failed",
    "rear_element_failed": "rear heating element failed",
    "fan_failed": "fan failed",
    "boiler_failed": "steam boiler failed",
    "boiler_overheated": "steam boiler overheated",
    "evaporator_failed": "evaporator failed",
    "evaporator_overheated": "evaporator overheated",
    "top_overheated": "top of the oven overheated",
    "bottom_overheated": "bottom of the oven overheated",
    "lamp_failed": "lamp failed",
    "display_link_failed": "handle display lost contact",
}


# Events that make no notification. Every event type the server announces
# is either here or has a text in message(); a test checks it. One
# exception: a failed stop (Auto stop or the safety limit) does notify.
QUIET = {"cook_started", "command_failed"}
STOPS = {"auto_stop", "safety_limit"}


def handle(hass, msg, guard=None):
    """Notify for one websocket message; return the services it went to."""
    if msg.get("type") != "event":
        return []
    event = msg.get("event") or {}
    if event.get("event_type") == ACTION_EVENT:
        if guard:
            guard.on_action(hass, event)
        return []
    trigger = (msg.get("event") or {}).get("variables", {}).get("trigger") or {}
    old, new = trigger.get("from_state"), trigger.get("to_state")
    # A new event changes the state (its time). Skip the entity becoming
    # available or unavailable.
    if not old or not new or new.get("state") in ("unavailable", "unknown") \
            or old.get("state") in ("unavailable", "unknown"):
        return []
    attributes = new.get("attributes") or {}
    if guard and guard.takes(hass, attributes):
        return []
    text = message(hass, attributes)
    if not text:
        return []
    title, body = text
    sent = []
    # A fault concerns everyone in the home, not only the cook's owner.
    owner = None if attributes.get("event_type") == "oven_fault" else attributes.get("started_by")
    for service in targets(hass, owner):
        reply = hass.call({
            "type": "call_service", "domain": "notify", "service": service,
            "service_data": {"title": title, "message": body, "data": {"group": "anova-oven"}},
        })
        log(f"{attributes.get('event_type')} -> {service}: {'sent' if reply.get('success') else reply}")
        sent.append(service)
    return sent


# --- Emergency power cut -------------------------------------------------

ACTION_EVENT = "mobile_app_notification_action"
POWER_OFF = "ANOVA_POWER_OFF"
HERE = "ANOVA_HERE"
TAG = "anova-oven-power"
# The plug reads at most this when the oven does not heat (idle: about 1 W).
IDLE_W = 20
# A lost oven gets this long to come back before the alarm. A short Wi-Fi
# drop must not wake everyone.
LOST_GRACE = 5 * 60
# How often the alarm checks the oven and the plug.
TICK = 30


class Guard:
    """The alarm for an oven that the App cannot stop.

    It starts on a failed stop (Auto stop or the safety limit) or when the
    oven goes offline during a cook. A lost oven gets LOST_GRACE first.
    Then everyone gets a notification with two buttons:

    - "Turn off power" turns the plug off at once.
    - "I am here" ends the alarm. No new alarm starts until the oven is
      idle again.

    If nobody answers in cut_secs, and the plug still reads more than
    IDLE_W (or reads nothing), the App turns the plug off. cut_secs 0
    means: notify only, never turn off by itself. The alarm ends by itself
    when the oven is back (online, or stopped) or the plug is off. Every
    notification has the same tag, so the last one replaces the others
    on every phone, and only the newest buttons work.
    """

    def __init__(self, switch, sensor=None, cut_minutes=60, now=time.time):
        self.switch = switch
        self.sensor = sensor
        self.cut_secs = max(0, int(cut_minutes * 60))
        self.now = now
        self.alarm = None
        self.muted = False
        self.last_tick = 0

    @classmethod
    def from_env(cls, env=os.environ):
        """The guard from run.sh's ANOVA_POWER_* variables, or None with no plug."""
        switch = (env.get("ANOVA_POWER_SWITCH") or "").strip()
        if not switch:
            return None
        if not switch.startswith("switch."):
            log(f"power_switch must be a switch entity, not {switch}; no emergency power cut")
            return None
        sensor = (env.get("ANOVA_POWER_SENSOR") or "").strip() or None
        if sensor and not sensor.startswith("sensor."):
            log(f"power_sensor must be a sensor entity, not {sensor}; the App ignores it")
            sensor = None
        try:
            minutes = float(env.get("ANOVA_POWER_CUT_MINUTES") or 60)
        except ValueError:
            minutes = 60
        return cls(switch, sensor, minutes)

    def takes(self, hass, attributes):
        """Whether this event belongs to the alarm instead of a plain notification."""
        kind = attributes.get("event_type")
        if kind == "oven_lost":
            why = "lost"
        elif kind == "command_failed" and attributes.get("command") in STOPS:
            why = "stop_failed"
        else:
            return False
        if self.muted or self.alarm:
            return True
        self.alarm = {"why": why, "since": self.now(), "sent": None,
                      "nonce": uuid.uuid4().hex[:8], "title": attributes.get("recipe_title") or "Oven",
                      "reason": attributes.get("reason")}
        log(f"alarm: {why}")
        if why == "stop_failed":
            self._send_alarm(hass)
        return True

    def tick(self, hass, force=False):
        if not force and self.now() - self.last_tick < TICK:
            return
        self.last_tick = self.now()
        if not self.alarm and not self.muted:
            return
        states = {s["entity_id"]: s for s in hass.call({"type": "get_states"}).get("result") or []}
        state = lambda e: (states.get(e) or {}).get("state")
        connected, cooking = state(CONNECTED) == "on", state(COOKING) == "on"
        if self.muted and connected and not cooking:
            self.muted = False
        if not self.alarm:
            return
        why = self.alarm["why"]
        if state(self.switch) == "off":
            return self._end(hass, "The oven's power is off.")
        if why == "lost" and connected:
            return self._end(hass, "The oven is back online. No action needed.")
        if why == "stop_failed" and connected and not cooking:
            return self._end(hass, "The oven stopped. No action needed.")
        try:
            watts = float(state(self.sensor)) if self.sensor else None
        except (TypeError, ValueError):
            watts = None
        heating = watts is None or watts > IDLE_W
        if self.alarm["sent"] is None:
            if self.now() - self.alarm["since"] >= LOST_GRACE and heating:
                self._send_alarm(hass, watts)
            return
        if self.cut_secs and self.now() - self.alarm["sent"] >= self.cut_secs and heating:
            self._cut(hass, f"Nobody answered in {self.cut_secs // 60} min, so the App")

    def on_action(self, hass, event):
        action = (event.get("data") or {}).get("action") or ""
        if not action.startswith(("ANOVA_",)):
            return
        if not self.alarm or not action.endswith("_" + self.alarm["nonce"]):
            log(f"old button {action}: no alarm for it")
            return
        who = person_name(hass, (event.get("context") or {}).get("user_id"))
        if action.startswith(POWER_OFF):
            self._cut(hass, f"{who} tapped Turn off power. The App")
        elif action.startswith(HERE):
            self.alarm = None
            self.muted = True
            self._notify(hass, f"{who} is at the oven. The App does not turn the power off.")

    def _send_alarm(self, hass, watts=None):
        a = self.alarm
        a["sent"] = self.now()
        power = f" The plug reads {watts:.0f} W." if watts is not None else ""
        if a["why"] == "lost":
            text = f"The App lost contact with the oven during a cook.{power}"
        else:
            text = f"The App could not stop the oven ({a['reason'] or 'no reason'}).{power}"
        if self.cut_secs:
            text += f" If nobody answers in {self.cut_secs // 60} min, the App turns the power off."
        actions = [
            {"action": f"{POWER_OFF}_{a['nonce']}", "title": "Turn off power",
             "destructive": True, "authenticationRequired": True},
            {"action": f"{HERE}_{a['nonce']}", "title": "I am here"},
        ]
        self._notify(hass, text, actions)

    def _cut(self, hass, by):
        reply = hass.call({"type": "call_service", "domain": "switch", "service": "turn_off",
                           "service_data": {"entity_id": self.switch}})
        self.alarm = None
        self.muted = True
        if reply.get("success"):
            log(f"power cut: {by}")
            self._notify(hass, f"{by} turned the oven's power off. Check the oven. "
                               "Turn the power on again from the card.")
        else:
            log(f"power cut failed: {reply}")
            self._notify(hass, f"{by} could not turn the oven's power off. "
                               "Turn the oven off yourself.")

    def _end(self, hass, text):
        sent = self.alarm["sent"]
        self.alarm = None
        log(f"alarm ended: {text}")
        if sent is not None:
            self._notify(hass, text)

    def _notify(self, hass, text, actions=None):
        data = {"group": "anova-oven", "tag": TAG}
        if actions:
            data.update({"actions": actions, "priority": "high", "ttl": 0,
                         "push": {"interruption-level": "time-sensitive"}})
        for service in targets(hass, None):
            reply = hass.call({
                "type": "call_service", "domain": "notify", "service": service,
                "service_data": {"title": "Oven power", "message": text, "data": data},
            })
            log(f"power -> {service}: {'sent' if reply.get('success') else reply}")


def person_name(hass, user_id):
    """The person's name for an HA user, for the other phones to read."""
    if user_id:
        for s in hass.call({"type": "get_states"}).get("result") or []:
            if s["entity_id"].startswith("person.") and s["attributes"].get("user_id") == user_id:
                return s["attributes"].get("friendly_name") or s["entity_id"].split(".", 1)[1]
    return "Someone"


def main():
    hass = Hass()
    hass.call({
        "type": "subscribe_trigger",
        "trigger": {"platform": "state", "entity_id": EVENT_ENTITY},
    })
    guard = Guard.from_env()
    # A quiet socket wakes the loop up: for the alarm check (TICK) and for
    # the ping that finds a dead connection (IDLE_TIMEOUT).
    hass.ws.settimeout(TICK if guard else IDLE_TIMEOUT)
    if guard:
        hass.call({"type": "subscribe_events", "event_type": ACTION_EVENT})
        log(f"emergency power cut on {guard.switch}, after {guard.cut_secs // 60} min "
            f"with no answer (0: never by itself)")
    log("watching the oven's events")
    while True:
        msg = hass.receive()
        if msg:
            handle(hass, msg, guard)
        if guard:
            guard.tick(hass)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # run.sh starts it again
        log(f"stopped: {e}")
        sys.exit(1)
