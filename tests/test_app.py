"""Tests for the Home Assistant app's Python scripts and for rules that
span several files. Standard library only:

    python3 -m unittest discover -s tests -v

CI runs them on every push.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def load(name, path):
    """Import an app script. Its `websocket` import gets a stub."""
    sys.modules.setdefault("websocket", types.ModuleType("websocket"))
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.log = lambda msg: None
    return module


notify = load("notify", "ha-app/notify.py")
register_card = load("register_card", "ha-app/register_card.py")


def event_types():
    """The event types the server announces, from milestones.rs."""
    src = read("crates/anova-oven-server/src/processors/mqtt/milestones.rs")
    block = re.search(r"pub const EVENT_TYPES: \[&str; \d+\] = \[(.*?)\];", src, re.S).group(1)
    return re.findall(r'"([a-z_]+)"', block)


# --- notify.py ---------------------------------------------------------------

class FakeHass:
    """The websocket calls notify.py makes, answered from fixed data."""

    def __init__(self, people=(), phones=(), auto_stop="on"):
        self.states = [
            {"entity_id": f"person.{name}",
             "attributes": {"user_id": user, "device_trackers": trackers}}
            for name, user, trackers in people
        ]
        self.states.append({"entity_id": notify.AUTO_STOP, "state": auto_stop, "attributes": {}})
        self.services = {"notify": {name: {} for name in phones}}
        self.sent = []

    def call(self, payload):
        if payload["type"] == "get_states":
            return {"success": True, "result": self.states}
        if payload["type"] == "get_services":
            return {"success": True, "result": self.services}
        if payload["type"] == "call_service":
            self.sent.append((payload["service"], payload["service_data"]["message"]))
            return {"success": True}
        raise AssertionError(payload)


FAMILY = dict(
    people=[("me", "user-me", ["device_tracker.my_phone"]),
            ("mom", "user-mom", ["device_tracker.moms_phone", "device_tracker.moms_tablet"]),
            ("guest", "user-guest", [])],
    # The tablet has no Companion app notify service.
    phones=["mobile_app_my_phone", "mobile_app_moms_phone", "persistent_notification"],
)


def trigger(attributes, old="2026-11-06T10:00:00Z", new="2026-11-06T10:05:00Z"):
    return {"type": "event", "event": {"variables": {"trigger": {
        "from_state": {"state": old},
        "to_state": {"state": new, "attributes": attributes},
    }}}}


class NotifyTargets(unittest.TestCase):
    def test_a_card_cook_goes_to_the_person_who_started_it(self):
        self.assertEqual(notify.targets(FakeHass(**FAMILY), "user-mom"), ["mobile_app_moms_phone"])

    def test_a_cook_started_on_the_oven_goes_to_everyone(self):
        self.assertEqual(notify.targets(FakeHass(**FAMILY), None),
                         ["mobile_app_moms_phone", "mobile_app_my_phone"])

    def test_a_person_without_a_phone_falls_back_to_everyone(self):
        self.assertEqual(notify.targets(FakeHass(**FAMILY), "user-guest"),
                         ["mobile_app_moms_phone", "mobile_app_my_phone"])

    def test_no_people_means_every_companion_app(self):
        hass = FakeHass(phones=["mobile_app_a", "mobile_app_b", "persistent_notification"])
        self.assertEqual(notify.targets(hass, None), ["mobile_app_a", "mobile_app_b"])


class NotifyMessages(unittest.TestCase):
    def test_every_server_event_has_a_decision(self):
        """A new event type needs a text in message() or a place in QUIET."""
        hass = FakeHass()
        for kind in event_types():
            with self.subTest(kind=kind):
                text = notify.message(hass, {"event_type": kind, "step_index": 0, "step_count": 2})
                self.assertTrue(bool(text) != (kind in notify.QUIET),
                                f"{kind}: has a text and is QUIET, or neither")

    def test_texts(self):
        hass = FakeHass()
        cases = [
            ({"event_type": "temp_reached", "target_c": 200.0}, "The oven is at 200 °C."),
            ({"event_type": "temp_reached", "target_c": 56.5, "wet": True}, "The oven is at 56.5 °C."),
            ({"event_type": "temp_reached", "target_c": 204.4, "unit": "F"}, "The oven is at 400 °F."),
            ({"event_type": "command_failed", "command": "safety_limit", "reason": "timeout"},
             "The App could not stop the oven. Stop it on the oven. (timeout)"),
            ({"event_type": "water_empty"}, "The water tank is empty. Fill it to keep the steam going."),
            ({"event_type": "cook_stopped"}, "The cook stopped."),
            ({"event_type": "cook_stopped", "reason": {"kind": "safety_limit", "hours": 4.0}},
             "Safety stop: the oven ran 4 h with no timer, so the App stopped it."),
            ({"event_type": "stage_started", "step_index": 1, "step_count": 3, "current_step": "Cook"},
             "Step 2 of 3 started: Cook"),
            ({"event_type": "stage_waiting", "step_index": 0, "step_count": 2, "next_step": "Cook · 180 °C dry"},
             "Step 2 waits for you. Tap Start step 2. Next: Cook · 180 °C dry"),
            ({"event_type": "stage_waiting", "step_index": 0, "step_count": 2, "preheat": True,
              "next_step_prompt": "Load the loaf"},
             "Preheat done. Step 1 waits for you. Tap Start cooking. Note: Load the loaf"),
            ({"event_type": "oven_fault", "faults": ["triacs_failed", "fan_failed"]},
             "The oven reports a fault. Heating element switch (triac) failed, fan failed. "
             "Stop the oven and check it. Do not leave it on alone."),
        ]
        for attributes, text in cases:
            with self.subTest(text=text):
                self.assertEqual(notify.message(hass, attributes)[1], text)

    def test_every_server_fault_has_a_text(self):
        source = read("crates/anova-oven-server/src/protocol/mod.rs")
        body = source.split("pub fn faults(", 1)[1].split("\n}\n", 1)[0]
        # Each fault is `(condition, "name")`, on one line or (rustfmt) several.
        names = re.findall(r'"(\w+)",?\s*\)', body)
        self.assertGreater(len(names), 10)
        self.assertEqual(sorted(names), sorted(notify.FAULTS))

    def test_other_failed_commands_stay_quiet(self):
        self.assertIsNone(notify.message(FakeHass(), {"event_type": "command_failed", "command": "lamp"}))

    def test_timer_done_says_whether_the_oven_stopped(self):
        done = {"event_type": "cook_done"}
        self.assertIn("The oven stopped", notify.message(FakeHass(auto_stop="on"), done)[1])
        self.assertIn("until you tap Stop", notify.message(FakeHass(auto_stop="off"), done)[1])

    def test_a_scheduled_cook_says_when_in_the_local_time(self):
        now = notify.datetime(2026, 11, 9, 8, 0, tzinfo=notify.timezone.utc)
        with mock.patch.dict(os.environ, {"TZ": "Europe/Ljubljana"}):
            self.assertEqual(notify.local_time("2026-11-09T15:30:00Z", now), "at 16:30")
            self.assertEqual(notify.local_time("2026-11-10T15:30:00Z", now), "on 10 Nov at 16:30")
        self.assertEqual(notify.local_time(None, now), "later")
        text = notify.message(FakeHass(), {"event_type": "cook_scheduled", "recipe_title": "Bread",
                                           "at": "2026-11-09T15:30:00Z"})
        self.assertEqual(text[0], "Bread")
        self.assertIn("starts by itself", text[1])

    def test_a_scheduled_cook_that_did_not_start_notifies(self):
        text = notify.message(FakeHass(), {"event_type": "command_failed", "command": "scheduled_start",
                                           "reason": "the oven is offline"})
        self.assertEqual(text[1], "The scheduled cook did not start. Check the oven. (the oven is offline)")

    def test_the_recipe_is_the_title(self):
        self.assertEqual(notify.message(FakeHass(), {"event_type": "water_empty", "recipe_title": "Bread"})[0], "Bread")


class NotifyHandle(unittest.TestCase):
    def test_an_event_goes_to_its_person(self):
        hass = FakeHass(**FAMILY)
        sent = notify.handle(hass, trigger({"event_type": "temp_reached", "target_c": 200.0,
                                            "started_by": "user-mom"}))
        self.assertEqual(sent, ["mobile_app_moms_phone"])
        self.assertEqual(hass.sent, [("mobile_app_moms_phone", "The oven is at 200 °C.")])

    def test_a_fault_goes_to_everyone(self):
        hass = FakeHass(**FAMILY)
        sent = notify.handle(hass, trigger({"event_type": "oven_fault", "faults": ["fan_failed"],
                                            "started_by": "user-mom"}))
        self.assertEqual(sent, ["mobile_app_moms_phone", "mobile_app_my_phone"])

    def test_a_scheduled_cook_goes_to_everyone(self):
        hass = FakeHass(**FAMILY)
        sent = notify.handle(hass, trigger({"event_type": "cook_scheduled", "at": "2026-11-09T15:30:00Z"}))
        self.assertEqual(sent, ["mobile_app_moms_phone", "mobile_app_my_phone"])

    def test_the_entity_coming_back_is_not_an_event(self):
        hass = FakeHass(**FAMILY)
        for old, new in [("unavailable", "2026-11-06T10:05:00Z"), ("2026-11-06T10:00:00Z", "unavailable"),
                         ("unknown", "2026-11-06T10:05:00Z")]:
            self.assertEqual(notify.handle(hass, trigger({"event_type": "cook_stopped"}, old, new)), [])
        self.assertEqual(hass.sent, [])

    def test_quiet_events_and_other_messages_send_nothing(self):
        hass = FakeHass(**FAMILY)
        self.assertEqual(notify.handle(hass, trigger({"event_type": "cook_started"})), [])
        self.assertEqual(notify.handle(hass, {"type": "result", "id": 1}), [])
        self.assertEqual(hass.sent, [])


class GuardHass(FakeHass):
    """FakeHass with the oven's sensors, a plug, and service calls kept whole."""

    def __init__(self, connected="off", cooking="on", plug="on", watts="1800"):
        super().__init__(**FAMILY)
        self.states[0]["attributes"]["friendly_name"] = "Me"
        self.values = {notify.CONNECTED: connected, notify.COOKING: cooking,
                       "switch.oven_plug": plug, "sensor.oven_plug_power": watts}
        self.calls = []

    def set(self, entity, value):
        self.values[entity] = value

    def call(self, payload):
        if payload["type"] == "get_states":
            extra = [{"entity_id": e, "state": v, "attributes": {}} for e, v in self.values.items()]
            return {"success": True, "result": self.states + extra}
        if payload["type"] == "call_service":
            self.calls.append(payload)
            if payload["domain"] == "switch" and payload["service"] == "turn_off":
                self.values[payload["service_data"]["entity_id"]] = "off"
            return {"success": True}
        return super().call(payload)

    def notes(self):
        return [c["service_data"]["message"] for c in self.calls if c["domain"] == "notify"
                and c["service"] == "mobile_app_my_phone"]

    def cuts(self):
        return [c for c in self.calls if c["domain"] == "switch"]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def guard(clock, minutes=60):
    return notify.Guard("switch.oven_plug", "sensor.oven_plug_power", minutes, now=clock)


def action(name, nonce, user="user-me"):
    return {"type": "event", "event": {"event_type": notify.ACTION_EVENT,
                                       "data": {"action": f"{name}_{nonce}"},
                                       "context": {"user_id": user}}}


class NotifyGuard(unittest.TestCase):
    STOP_FAILED = {"event_type": "command_failed", "command": "safety_limit", "reason": "timeout"}

    def test_a_failed_stop_alarms_everyone_with_buttons(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock)
        self.assertEqual(notify.handle(hass, trigger(self.STOP_FAILED), g), [])
        notes = [c for c in hass.calls if c["domain"] == "notify"]
        self.assertEqual(sorted(c["service"] for c in notes), ["mobile_app_moms_phone", "mobile_app_my_phone"])
        data = notes[0]["service_data"]["data"]
        self.assertEqual([a["title"] for a in data["actions"]], ["Turn off power", "I am here"])
        self.assertTrue(data["actions"][0]["authenticationRequired"])
        self.assertIn("in 60 min", notes[0]["service_data"]["message"])

    def test_nobody_answers_so_the_power_goes_off(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        clock.t += 59 * 60
        g.tick(hass, force=True)
        self.assertEqual(hass.cuts(), [])
        clock.t += 60
        g.tick(hass, force=True)
        self.assertEqual(hass.cuts()[0]["service_data"], {"entity_id": "switch.oven_plug"})
        self.assertIn("Nobody answered in 60 min", hass.notes()[-1])

    def test_zero_minutes_never_cuts_by_itself(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock, minutes=0)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        self.assertNotIn("min, the App", hass.notes()[0])
        clock.t += 24 * 3600
        g.tick(hass, force=True)
        self.assertEqual(hass.cuts(), [])

    def test_turn_off_power_cuts_at_once_and_tells_the_others(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        nonce = g.alarm["nonce"]
        notify.handle(hass, action(notify.POWER_OFF, nonce), g)
        self.assertEqual(len(hass.cuts()), 1)
        self.assertIn("Me tapped Turn off power", hass.notes()[-1])
        notify.handle(hass, action(notify.POWER_OFF, nonce), g)
        self.assertEqual(len(hass.cuts()), 1, "a second tap on an old button does nothing")

    def test_i_am_here_ends_the_alarm_until_the_oven_is_idle(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        notify.handle(hass, action(notify.HERE, g.alarm["nonce"]), g)
        self.assertIn("Me is at the oven", hass.notes()[-1])
        clock.t += 2 * 3600
        g.tick(hass, force=True)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        self.assertEqual(hass.cuts(), [])
        self.assertIsNone(g.alarm, "the safety limit's next try starts no new alarm")
        hass.set(notify.COOKING, "off")
        g.tick(hass, force=True)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        self.assertIsNotNone(g.alarm, "after the oven was idle, a new alarm can start")

    def test_a_short_drop_wakes_nobody(self):
        hass, clock = GuardHass(), Clock()
        g = guard(clock)
        notify.handle(hass, trigger({"event_type": "oven_lost"}), g)
        clock.t += 4 * 60
        g.tick(hass, force=True)
        hass.set(notify.CONNECTED, "on")
        clock.t += 2 * 60
        g.tick(hass, force=True)
        self.assertEqual(hass.calls, [])
        self.assertIsNone(g.alarm)

    def test_a_lost_oven_that_heats_alarms_after_the_grace(self):
        hass, clock = GuardHass(), Clock()
        g = guard(clock)
        notify.handle(hass, trigger({"event_type": "oven_lost"}), g)
        clock.t += notify.LOST_GRACE
        g.tick(hass, force=True)
        self.assertIn("lost contact", hass.notes()[0])
        self.assertIn("1800 W", hass.notes()[0])
        hass.set(notify.CONNECTED, "on")
        g.tick(hass, force=True)
        self.assertIn("back online", hass.notes()[-1])
        self.assertIsNone(g.alarm)

    def test_a_lost_oven_at_idle_power_waits(self):
        hass, clock = GuardHass(watts="1"), Clock()
        g = guard(clock)
        notify.handle(hass, trigger({"event_type": "oven_lost"}), g)
        clock.t += 3 * 3600
        g.tick(hass, force=True)
        self.assertEqual(hass.calls, [])

    def test_the_plug_turned_off_by_hand_ends_the_alarm(self):
        hass, clock = GuardHass(connected="on"), Clock()
        g = guard(clock)
        notify.handle(hass, trigger(self.STOP_FAILED), g)
        hass.set("switch.oven_plug", "off")
        g.tick(hass, force=True)
        self.assertIsNone(g.alarm)
        self.assertIn("power is off", hass.notes()[-1])

    def test_without_a_plug_the_plain_notification_stays(self):
        hass = FakeHass(**FAMILY)
        sent = notify.handle(hass, trigger(self.STOP_FAILED), None)
        self.assertEqual(sent, ["mobile_app_moms_phone", "mobile_app_my_phone"])

    def test_settings_from_run_sh(self):
        for env, expected in [({}, None), ({"ANOVA_POWER_SWITCH": ""}, None),
                              ({"ANOVA_POWER_SWITCH": "light.oven"}, None),
                              ({"ANOVA_POWER_SWITCH": "switch.oven_plug", "ANOVA_POWER_CUT_MINUTES": "90"}, 5400),
                              ({"ANOVA_POWER_SWITCH": "switch.oven_plug", "ANOVA_POWER_CUT_MINUTES": "0"}, 0)]:
            g = notify.Guard.from_env(env)
            self.assertEqual(g.cut_secs if g else None, expected, env)
        g = notify.Guard.from_env({"ANOVA_POWER_SWITCH": "switch.p", "ANOVA_POWER_SENSOR": "switch.x"})
        self.assertIsNone(g.sensor)


# --- register_card.py --------------------------------------------------------

class FakeSocket:
    """Home Assistant's websocket for register_card.py."""

    def __init__(self, resources, yaml_mode=False, auth="auth_ok"):
        self.resources = resources
        self.yaml_mode = yaml_mode
        self.replies = [{"type": "auth_required"}, {"type": auth}]
        self.requests = []

    def send(self, text):
        msg = json.loads(text)
        self.requests.append(msg)
        if msg["type"] == "lovelace/resources":
            result = {"success": False} if self.yaml_mode else {"success": True, "result": self.resources}
            self.replies.append({"id": msg["id"], "type": "result", **result})
        elif msg["type"] != "auth":
            self.replies.append({"id": msg["id"], "type": "result", "success": True})

    def recv(self):
        return json.dumps(self.replies.pop(0))

    def close(self):
        pass


class RegisterCard(unittest.TestCase):
    URL = "/local/anova-oven/anova-oven-card.js"

    def run_with(self, sock):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "card.js")
            with open(source, "w") as f:
                f.write("// card")
            register_card.SOURCE = source
            register_card.TARGET_DIR = os.path.join(tmp, "www", "anova-oven")
            register_card.websocket.create_connection = lambda *a, **k: sock
            with mock.patch.dict(os.environ, SUPERVISOR_TOKEN="token", CARD_VERSION="1.2.3"):
                code = register_card.main()
            copied = os.path.exists(os.path.join(register_card.TARGET_DIR, "anova-oven-card.js"))
        writes = [r for r in sock.requests if r["type"].startswith("lovelace/resources/")]
        return code, copied, writes

    def test_a_new_install_registers_the_resource(self):
        code, copied, writes = self.run_with(FakeSocket([]))
        self.assertEqual((code, copied), (0, True))
        self.assertEqual([(w["type"], w["url"]) for w in writes],
                         [("lovelace/resources/create", f"{self.URL}?v=1.2.3")])

    def test_an_update_changes_the_version_in_the_url(self):
        old = [{"id": "r1", "url": f"{self.URL}?v=1.2.2"}, {"id": "r2", "url": "/local/other.js"}]
        _, _, writes = self.run_with(FakeSocket(old))
        self.assertEqual([(w["type"], w["resource_id"], w["url"]) for w in writes],
                         [("lovelace/resources/update", "r1", f"{self.URL}?v=1.2.3")])

    def test_a_current_resource_stays(self):
        _, _, writes = self.run_with(FakeSocket([{"id": "r1", "url": f"{self.URL}?v=1.2.3"}]))
        self.assertEqual(writes, [])

    def test_yaml_dashboards_get_no_write(self):
        code, copied, writes = self.run_with(FakeSocket([], yaml_mode=True))
        self.assertEqual((code, copied, writes), (0, True, []))

    def test_a_refused_login_fails_after_the_copy(self):
        code, copied, _ = self.run_with(FakeSocket([], auth="auth_invalid"))
        self.assertEqual((code, copied), (1, True))


# --- Rules across files --------------------------------------------------------

def app_version():
    return re.search(r'^version: "([^"]+)"$', read("ha-app/config.yaml"), re.M).group(1)


class Consistency(unittest.TestCase):
    def test_app_card_and_changelog_have_one_version(self):
        card = re.search(r'const CARD_VERSION = "([^"]+)";', read("dist/anova-oven-card.js")).group(1)
        changelog = re.search(r"^## (\S+)$", read("ha-app/CHANGELOG.md"), re.M).group(1)
        self.assertEqual({app_version(), card, changelog}, {app_version()},
                         "raise ha-app/config.yaml, CARD_VERSION and the CHANGELOG together")

    def test_run_sh_reads_every_option(self):
        config = read("ha-app/config.yaml")
        options = re.search(r"^options:\n((?:  .*\n)+)", config, re.M).group(1)
        schema = re.search(r"^schema:\n((?:  .*\n)+)", config, re.M).group(1)
        names = re.findall(r"^  (\w+):", options, re.M)
        self.assertEqual(names, re.findall(r"^  (\w+):", schema, re.M), "options and schema differ")
        run_sh = read("ha-app/run.sh")
        for name in names:
            with self.subTest(option=name):
                self.assertRegex(run_sh, rf"bashio::config(\.true)? '{name}'")

    def test_the_image_ships_every_script_run_sh_starts(self):
        dockerfile = read("ha-app/Dockerfile")
        for script in re.findall(r"python3 (/\w+\.py)", read("ha-app/run.sh")):
            with self.subTest(script=script):
                self.assertIn(f"ha-app{script} {script}", dockerfile)

    def test_web_page_api_paths_start_with_a_slash(self):
        # api() puts "api" in front of the path, so "recipes/x" would ask for
        # "apirecipes/x".
        ui = os.path.join(ROOT, "crates/anova-oven-server/src/processors/http/ui")
        for name in sorted(os.listdir(ui)):
            if not name.endswith((".html", ".js")):
                continue
            for path in re.findall(r'\bapi\("[A-Z]+",\s*[`"\']([^`"\']*)', read(f"{ui}/{name}")):
                with self.subTest(page=name, path=path):
                    self.assertTrue(path.startswith("/"), path)

    def test_the_docs_list_every_notification(self):
        docs = read("ha-app/DOCS.md")
        hass = FakeHass()
        for kind in event_types():
            if kind in notify.QUIET or kind in ("stage_started", "stage_waiting"):
                continue  # Their texts depend on the step; the table shows an example.
            with self.subTest(kind=kind):
                text = notify.message(hass, {"event_type": kind, "target_c": 200.0})[1]
                self.assertIn(text.split(".")[0], docs)


# --- Leaks -------------------------------------------------------------------------

# The repo is public. These generic patterns catch a home address or a secret
# in any tracked file. The exact home names (domains, hosts, the public IP)
# must not be listed here, because this file is public too: a local git hook
# checks them (see home/README.md).
PRIVATE_IP = re.compile(r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
                        r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
                        r"|192\.168\.\d{1,3}\.\d{1,3})\b")
SECRET = re.compile(r"BEGIN [A-Z ]*PRIVATE KEY"
                    r"|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}"  # a JWT
                    r"|AIza[0-9A-Za-z_-]{35}"  # a Google API key
                    r"|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}"
                    r"|xox[abp]-[A-Za-z0-9-]{10,}")
ALLOWED = {
    "192.168.4.1",  # the oven's own setup network, the same on every oven
    "192.168.1.10",  # upstream: a test value in the Pico's URL parser
    "10.0.1.42", "10.0.1.34",  # upstream: example addresses in the docs
    # Anova's public Firebase web keys. Their app ships them; upstream
    # documents them.
    "AIzaSyCGJwHXUhkNBdPkH3OAkjc9-3xMMjvanfU",
    "AIzaSyB0VNqmJVAeR1fn_NbqqhwSytyMOZ_JO9c",
}


class NoLeaks(unittest.TestCase):
    def test_no_private_address_or_secret_in_a_tracked_file(self):
        try:
            files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True,
                                   capture_output=True).stdout.decode().split("\0")
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        found = []
        for path in filter(None, files):
            if path.endswith(("Cargo.lock", ".png")):
                continue
            try:
                text = read(path)
            except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
                continue
            for pattern in (PRIVATE_IP, SECRET):
                for m in pattern.finditer(text):
                    if m.group(0) not in ALLOWED:
                        line = text.count("\n", 0, m.start()) + 1
                        found.append(f"{path}:{line}: {m.group(0)[:12]}…")
        self.assertEqual(found, [], "a home address or a secret in a tracked file")



# --- adapter.py --------------------------------------------------------------

adapter = load("adapter", "ha-app/adapter.py")


class FakeServer:
    """The server's HTTP API, from a dict of recipes."""

    def __init__(self, recipes=(), stages=None, down=False):
        self.store = {r["id"]: dict(r) for r in recipes}
        self.stages = stages
        self.down = down
        self.calls = []

    def request(self, method, path, body=None):
        if self.down:
            raise OSError("connection refused")
        self.calls.append((method, path, body))
        if (method, path) == ("GET", "/recipes"):
            return list(self.store.values())
        if (method, path) == ("GET", "/current-cook"):
            return None if self.stages is None else {"stages": self.stages}
        if method == "POST" and path == "/recipes":
            if not body["stages"]:
                raise adapter.HttpError(422, "a recipe needs at least one stage")
            rid = f"new{len(self.store)}"
            self.store[rid] = {"id": rid, **body}
            return self.store[rid]
        rid = path.rsplit("/", 1)[-1]
        if rid not in self.store:
            raise adapter.HttpError(404, "recipe not found")
        if method == "PATCH":
            self.store[rid].update(body)
            return self.store[rid]
        if method == "DELETE":
            del self.store[rid]
            return None
        raise AssertionError((method, path))

    recipes = adapter.Server.recipes
    cook_stages = adapter.Server.cook_stages


STAGE = {"kind": "cook", "temperature_c": 200.0}
BREADS = [
    {"id": "b2", "title": "Bread", "stages": [STAGE]},
    {"id": "a1", "title": "Bread", "stages": [STAGE, STAGE]},
    {"id": "p", "title": "Pizza", "stages": [STAGE]},
]


def make_adapter(server):
    sent = []
    a = adapter.Adapter(adapter.Topics("anova/oven", "homeassistant"), server,
                        lambda topic, payload, retain: sent.append((topic, payload, retain)))
    return a, sent


def published(sent, topic):
    return [json.loads(p) for t, p, _ in sent if t == topic]


class AdapterRecipes(unittest.TestCase):
    def test_options_match_the_servers_select(self):
        # Sorted by title, then ID; a duplicate title gets a suffix.
        self.assertEqual(adapter.options(BREADS),
                         [("Bread", "a1"), ("Bread (2)", "b2"), ("Pizza", "p")])

    def test_options_rule_is_the_servers(self):
        src = read("crates/anova-oven-server/src/processors/mqtt/recipes.rs")
        self.assertIn('format!("{} ({nth})", recipe.title)', src)
        self.assertIn("a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id))", src)

    def test_the_sensor_lists_every_recipe_with_its_stages_once(self):
        a, sent = make_adapter(FakeServer(BREADS))
        a.refresh_recipes()
        a.refresh_recipes()
        payloads = published(sent, "anova/oven/ha/recipes")
        self.assertEqual(len(payloads), 1, "an unchanged list is not sent again")
        self.assertEqual([r["title"] for r in payloads[0]["recipes"]], ["Bread", "Bread (2)", "Pizza"])
        self.assertEqual(len(payloads[0]["recipes"][0]["stages"]), 2)
        self.assertNotIn("a1", json.dumps(payloads[0]), "recipe IDs stay in the App")

    def test_a_reconnect_sends_everything_again(self):
        a, sent = make_adapter(FakeServer(BREADS, stages=[STAGE]))
        a.refresh_recipes()
        a.refresh_cook()
        a.on_connect()
        a.refresh_recipes()
        a.refresh_cook()
        self.assertEqual(len(published(sent, "anova/oven/ha/recipes")), 2)
        self.assertEqual(len(published(sent, "anova/oven/ha/cook")), 2)
        retained = {t for t, _, r in sent if r}
        self.assertIn("anova/oven/ha/availability", retained)
        # The server's old retained topics are cleared.
        self.assertIn(("anova/oven/cook/attributes", "", True), sent)
        self.assertIn(("anova/oven/recipes/attributes", "", True), sent)

    def test_cook_stages_are_empty_without_a_cook(self):
        server = FakeServer(stages=[STAGE])
        a, sent = make_adapter(server)
        a.refresh_cook()
        server.stages = None
        a.refresh_cook()
        self.assertEqual(published(sent, "anova/oven/ha/cook"), [{"stages": [STAGE]}, {"stages": []}])

    def test_a_server_error_does_not_stop_the_adapter(self):
        server = FakeServer(BREADS)
        def refuse(method, path, body=None):
            raise adapter.HttpError(500, "store error")
        server.request = refuse
        a, sent = make_adapter(server)
        self.assertFalse(a.refresh_recipes())
        a.refresh_cook()
        self.assertEqual(sent, [])

    def test_the_api_is_under_api(self):
        self.assertIn('.nest("/api", api)', read("crates/anova-oven-server/src/processors/http.rs"))
        self.assertIn('Server(f"http://127.0.0.1:{port}/api")', read("ha-app/adapter.py"))

    def test_a_server_that_does_not_answer_changes_nothing(self):
        server = FakeServer(BREADS, stages=[STAGE], down=True)
        a, sent = make_adapter(server)
        a.refresh_recipes()
        a.refresh_cook()
        self.assertEqual(sent, [])
        server.down = False
        a.refresh_recipes()
        self.assertEqual(len(published(sent, "anova/oven/ha/recipes")), 1)


class AdapterCommands(unittest.TestCase):
    def failures(self, sent):
        return [p for p in published(sent, "anova/oven/event") if p["event_type"] == "command_failed"]

    def test_save_creates_a_new_recipe(self):
        server = FakeServer(BREADS)
        a, sent = make_adapter(server)
        a.command("save_recipe", json.dumps({"title": "Toast", "stages": [STAGE]}).encode())
        self.assertIn(("POST", "/recipes", {"title": "Toast", "stages": [STAGE]}), server.calls)
        self.assertIn("Toast", [r["title"] for r in published(sent, "anova/oven/ha/recipes")[-1]["recipes"]])
        self.assertEqual(self.failures(sent), [])

    def test_save_with_replace_overwrites_the_recipe_behind_that_title(self):
        server = FakeServer(BREADS)
        a, sent = make_adapter(server)
        body = {"title": "Bread (2)", "stages": [STAGE], "replace": "Bread (2)"}
        a.command("save_recipe", json.dumps(body).encode())
        self.assertIn(("PATCH", "/recipes/b2", {"title": "Bread (2)", "stages": [STAGE]}), server.calls)

    def test_save_with_an_unknown_replace_saves_a_new_recipe(self):
        server = FakeServer(BREADS)
        a, _ = make_adapter(server)
        a.command("save_recipe", json.dumps({"title": "X", "stages": [STAGE], "replace": "Gone"}).encode())
        self.assertEqual([c[0] for c in server.calls if c[0] != "GET"], ["POST"])

    def test_delete_removes_the_recipe_behind_that_title(self):
        server = FakeServer(BREADS)
        a, sent = make_adapter(server)
        a.command("delete_recipe", b"Bread")
        self.assertNotIn("a1", server.store)
        self.assertIn("b2", server.store)
        titles = [r["title"] for r in published(sent, "anova/oven/ha/recipes")[-1]["recipes"]]
        self.assertEqual(titles, ["Bread", "Pizza"])

    def test_failures_are_command_failed_events_with_the_servers_reason(self):
        server = FakeServer(BREADS)
        a, sent = make_adapter(server)
        a.command("delete_recipe", b"Nothing")
        a.command("save_recipe", b"{not json")
        a.command("save_recipe", json.dumps({"title": "Empty", "stages": []}).encode())
        a.command("save_recipe", b"\xff")
        a.command("save_recipe", b"x" * (adapter.MAX_COMMAND_BYTES + 1))
        a.command("rename", b"x")
        reasons = [(f["command"], f["reason"]) for f in self.failures(sent)]
        self.assertEqual(reasons[0], ("delete_recipe", "no recipe with that title"))
        self.assertTrue(reasons[1][1].startswith("bad payload"))
        self.assertEqual(reasons[2], ("save_recipe", "a recipe needs at least one stage"))
        self.assertEqual(reasons[3], ("save_recipe", "bad payload: not UTF-8"))
        self.assertEqual(reasons[4], ("save_recipe", "the command is too large"))
        self.assertEqual(reasons[5], ("rename", "unknown command"))
        self.assertTrue(all(not r for t, _, r in sent if t == "anova/oven/event"))

    def test_a_server_that_does_not_answer_fails_the_command(self):
        a, sent = make_adapter(FakeServer(BREADS, down=True))
        a.command("delete_recipe", b"Bread")
        self.assertTrue(self.failures(sent)[0]["reason"].startswith("the server does not answer"))

    def test_command_failed_is_a_server_event_type(self):
        self.assertIn("command_failed", event_types())


class AdapterDiscovery(unittest.TestCase):
    def test_the_recipes_sensor_keeps_its_entity(self):
        configs = dict(adapter.discovery(adapter.Topics("anova/oven", "homeassistant")))
        recipes = configs["homeassistant/sensor/anova_oven/recipes/config"]
        self.assertEqual(recipes["unique_id"], "anova_oven_recipes")
        self.assertEqual(recipes["device"], {"identifiers": ["anova_oven"]})
        self.assertEqual(recipes["state_topic"], "anova/oven/ha/recipes")
        stages = configs["homeassistant/sensor/anova_oven/cook_stages/config"]
        self.assertEqual(stages["value_template"], "{{ value_json.stages | length }}")
        # Unavailable when the server or the adapter is away.
        self.assertEqual({a["topic"] for a in stages["availability"]},
                         {"anova/oven/availability", "anova/oven/ha/availability"})

    def test_the_server_no_longer_announces_the_adapters_sensors(self):
        snapshot = read("crates/anova-oven-server/testdata/mqtt-discovery.json")
        self.assertNotIn("sensor/anova_oven/recipes/config", snapshot)
        self.assertNotIn("cook_stages", snapshot)

    def test_the_card_uses_the_adapters_topics_and_sensor(self):
        card = read("dist/anova-oven-card.js")
        for name in ("save_recipe", "delete_recipe"):
            self.assertIn(f"mqtt_prefix}}/ha/cmd/{name}`", card)
            self.assertNotIn(f"mqtt_prefix}}/cmd/{name}`", card)
        self.assertIn('this._state("sensor", "cook_stages")', card)

    def test_the_app_runs_the_adapter(self):
        self.assertIn("python3 /adapter.py", read("ha-app/run.sh"))
        dockerfile = read("ha-app/Dockerfile")
        self.assertIn("COPY ha-app/adapter.py /adapter.py", dockerfile)
        self.assertIn("python3-paho-mqtt", dockerfile)

    def test_the_broker_address(self):
        self.assertEqual(adapter.broker("mqtt://core-mosquitto:1883"), ("core-mosquitto", 1883))
        self.assertEqual(adapter.broker("mqtt://broker"), ("broker", 1883))


if __name__ == "__main__":
    unittest.main()
