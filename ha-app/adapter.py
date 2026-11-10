#!/usr/bin/env python3
"""The Home Assistant adapter: what only the dashboard card needs.

The server gives one neutral API. This process runs beside it in the App
and adds the parts that are for Home Assistant only. It talks to the
server's HTTP API on localhost and to the MQTT broker:

- The Recipes sensor: every recipe with its stages, for the card's presets.
- The Cook stages sensor: the running cook's stages, so every dashboard
  shows them, not only the one that started the cook.
- The save_recipe and delete_recipe commands from the card.

Its topics are under `<prefix>/ha/`, apart from the server's own topics:

    <prefix>/ha/availability          online / offline (retained, last will)
    <prefix>/ha/recipes               {"recipes": [{"title", "stages"}]} (retained)
    <prefix>/ha/cook                  {"stages": [...]} (retained)
    <prefix>/ha/cmd/save_recipe       {"title", "stages", "replace"?}
    <prefix>/ha/cmd/delete_recipe     the recipe's title, as the card shows it

A recipe title is the same as the server's recipe select option: a second
recipe with the same title is "Bread (2)". Recipe IDs stay in the App.

Security: the adapter opens no port. Anyone who can publish to the
broker can save or delete a recipe, the same as for the server's own
commands. The server checks every recipe before it writes it.
"""
import json
import os
import queue
import sys
import time
import urllib.error
import urllib.request

# A change to a recipe from the server's web page shows after this long.
RECIPES_EVERY = 10
# The running cook's stages: the server publishes the oven's state at the
# same rate.
COOK_EVERY = 5
HTTP_TIMEOUT = 10
# A recipe is a few kB. A larger command is not from the card.
MAX_COMMAND_BYTES = 256 * 1024


def log(msg):
    print(f"[adapter] {msg}", file=sys.stderr, flush=True)


class Topics:
    def __init__(self, prefix, discovery):
        self.prefix = prefix
        self.discovery = discovery

    def ha(self, path):
        return f"{self.prefix}/ha/{path}"

    @property
    def availability(self):
        return self.ha("availability")

    @property
    def recipes(self):
        return self.ha("recipes")

    @property
    def cook(self):
        return self.ha("cook")

    def command(self, name):
        return self.ha(f"cmd/{name}")

    @property
    def server_availability(self):
        return f"{self.prefix}/availability"

    @property
    def event(self):
        return f"{self.prefix}/event"

    def config(self, component, obj):
        return f"{self.discovery}/{component}/anova_oven/{obj}/config"

    def stale(self):
        """Retained topics that the server published before 0.25.0. The
        adapter clears them, so the broker does not keep old data."""
        return [f"{self.prefix}/recipes/attributes", f"{self.prefix}/cook/attributes"]


def options(recipes):
    """`[(option, id)]`, sorted by title and then ID. The same rule as the
    server's recipe select: a duplicate title gets a suffix, `Bread (2)`."""
    out = []
    previous, nth = None, 0
    for r in sorted(recipes, key=lambda r: (r.get("title", ""), r.get("id", ""))):
        title = r.get("title", "")
        nth = nth + 1 if title == previous else 1
        previous = title
        out.append((title if nth == 1 else f"{title} ({nth})", r.get("id", "")))
    return out


def recipes_payload(recipes):
    """The Recipes sensor's payload: every recipe by its option, with stages."""
    by_id = {r.get("id"): r for r in recipes}
    return {
        "recipes": [
            {"title": option, "stages": by_id[rid].get("stages") or []}
            for option, rid in options(recipes)
        ]
    }


def discovery(topics):
    """`[(topic, config)]` for the adapter's two sensors. They join the
    server's "Anova Oven" device by its identifier. The Recipes sensor keeps
    the `unique_id` that the server gave it before 0.25.0, so the entity and
    its history stay."""
    availability = [
        {"topic": topics.server_availability},
        {"topic": topics.availability},
    ]

    def sensor(obj, name, state_topic, field, icon, extra=None):
        config = {
            "name": name,
            "unique_id": f"anova_oven_{obj}",
            "default_entity_id": f"sensor.anova_oven_{obj}",
            "has_entity_name": True,
            "availability": availability,
            "availability_mode": "all",
            "device": {"identifiers": ["anova_oven"]},
            "origin": {"name": "anova-oven-ha adapter"},
            "state_topic": state_topic,
            "value_template": f"{{{{ value_json.{field} | length }}}}",
            "json_attributes_topic": state_topic,
            "icon": icon,
        }
        config.update(extra or {})
        return topics.config("sensor", obj), config

    return [
        sensor("recipes", "Recipes", topics.recipes, "recipes", "mdi:book-open-variant"),
        sensor(
            "cook_stages",
            "Cook stages",
            topics.cook,
            "stages",
            "mdi:format-list-numbered",
            {"entity_category": "diagnostic"},
        ),
    ]


class HttpError(Exception):
    """The server refused a request. `reason` is the server's own text."""

    def __init__(self, status, reason):
        super().__init__(f"{status}: {reason}")
        self.status = status
        self.reason = reason


class Server:
    """The server's HTTP API."""

    def __init__(self, base):
        self.base = base.rstrip("/")

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            reason = e.read().decode(errors="replace").strip() or e.reason
            raise HttpError(e.code, reason) from None

    def recipes(self):
        return self.request("GET", "/recipes") or []

    def cook_stages(self):
        """The running cook's stages; `[]` when no cook runs."""
        cook = self.request("GET", "/current-cook")
        return (cook or {}).get("stages") or []


class Adapter:
    """The adapter's state. `publish(topic, payload, retain)` sends to MQTT;
    the tests give a fake."""

    def __init__(self, topics, server, publish):
        self.topics = topics
        self.server = server
        self.publish = publish
        self.recipes = []
        self.last_recipes = None
        self.last_cook = None
        self.server_down = False

    def on_connect(self):
        """After every (re)connect: the configs, and the state again."""
        self.publish(self.topics.availability, "online", True)
        for topic in self.topics.stale():
            self.publish(topic, "", True)
        for topic, config in discovery(self.topics):
            self.publish(topic, json.dumps(config), True)
        self.last_recipes = None
        self.last_cook = None

    def _reachable(self, call):
        """Run `call`; log once while the server does not answer."""
        try:
            result = call()
        except (HttpError, OSError, ValueError) as e:
            if not self.server_down:
                log(f"the server does not answer: {e}")
                self.server_down = True
            return None
        if self.server_down:
            log("the server answers again")
            self.server_down = False
        return result

    def refresh_recipes(self):
        """Whether the server answered."""
        recipes = self._reachable(self.server.recipes)
        if recipes is None:
            return False
        self.recipes = recipes
        payload = json.dumps(recipes_payload(recipes), separators=(",", ":"))
        if payload != self.last_recipes:
            self.publish(self.topics.recipes, payload, True)
            self.last_recipes = payload
        return True

    def refresh_cook(self):
        stages = self._reachable(self.server.cook_stages)
        if stages is None:
            return
        payload = json.dumps({"stages": stages}, separators=(",", ":"))
        if payload != self.last_cook:
            self.publish(self.topics.cook, payload, True)
            self.last_cook = payload

    def option_id(self, title):
        return next((rid for option, rid in options(self.recipes) if option == title), None)

    def failed(self, command, reason):
        """The same `command_failed` event that the server sends, so the
        failure shows in Home Assistant's logbook."""
        log(f"{command} failed: {reason}")
        payload = {"event_type": "command_failed", "command": command, "reason": reason}
        self.publish(self.topics.event, json.dumps(payload), False)

    def command(self, name, payload):
        if len(payload) > MAX_COMMAND_BYTES:
            self.failed(name, "the command is too large")
            return
        try:
            text = payload.decode()
        except UnicodeDecodeError:
            self.failed(name, "bad payload: not UTF-8")
            return
        # The newest list, so a title from another device's save is known.
        if not self.refresh_recipes():
            self.failed(name, "the server does not answer")
            return
        try:
            if name == "save_recipe":
                self.save(text)
            elif name == "delete_recipe":
                self.delete(text)
            else:
                self.failed(name, "unknown command")
                return
        except HttpError as e:
            self.failed(name, e.reason)
            return
        except (OSError, ValueError) as e:
            self.failed(name, f"the server does not answer: {e}")
            return
        self.refresh_recipes()

    def save(self, text):
        """`{"title", "stages"}` saves a new recipe. With `"replace":
        "<title>"` it overwrites that recipe. An unknown `replace` saves a
        new one."""
        try:
            request = json.loads(text)
        except ValueError as e:
            raise HttpError(400, f"bad payload: {e}") from None
        if not isinstance(request, dict) or not isinstance(request.get("stages"), list):
            raise HttpError(400, "bad payload: wants a title and stages")
        body = {"title": request.get("title"), "stages": request["stages"]}
        replace = request.get("replace")
        rid = self.option_id(replace) if isinstance(replace, str) else None
        if rid:
            recipe = self.server.request("PATCH", f"/recipes/{rid}", body)
        else:
            recipe = self.server.request("POST", "/recipes", body)
        log(f"saved recipe {(recipe or {}).get('title')!r}")

    def delete(self, title):
        rid = self.option_id(title)
        if not rid:
            raise HttpError(404, "no recipe with that title")
        self.server.request("DELETE", f"/recipes/{rid}")
        log(f"deleted recipe {title!r}")


def broker(url):
    """`mqtt://host:port` to `(host, port)`; the port defaults to 1883."""
    rest = url.split("://", 1)[-1].rstrip("/")
    host, _, port = rest.rpartition(":")
    if not host or not port.isdigit():
        return rest, 1883
    return host, int(port)


def main():
    import paho.mqtt.client as mqtt

    url = os.environ.get("ANOVA_MQTT_URL")
    if not url:
        log("no MQTT broker; the adapter does not run")
        return
    topics = Topics(
        os.environ.get("ANOVA_MQTT_TOPIC_PREFIX") or "anova/oven",
        os.environ.get("ANOVA_MQTT_DISCOVERY_PREFIX") or "homeassistant",
    )
    port = os.environ.get("ANOVA_BIND", "0.0.0.0:8080").rpartition(":")[2]
    server = Server(f"http://127.0.0.1:{port}/api")

    client_id = (os.environ.get("ANOVA_MQTT_CLIENT_ID") or "anova-oven-server") + "-ha"
    if hasattr(mqtt, "CallbackAPIVersion"):  # paho 2
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=client_id)
    else:
        client = mqtt.Client(client_id=client_id)
    if os.environ.get("ANOVA_MQTT_USERNAME"):
        client.username_pw_set(
            os.environ["ANOVA_MQTT_USERNAME"], os.environ.get("ANOVA_MQTT_PASSWORD")
        )
    client.will_set(topics.availability, "offline", qos=1, retain=True)
    client.reconnect_delay_set(1, 60)

    adapter = Adapter(
        topics,
        server,
        lambda topic, payload, retain: client.publish(topic, payload, qos=1, retain=retain),
    )
    # The MQTT thread only queues; the main loop does all the work, so the
    # adapter's state has one owner.
    work = queue.Queue()

    def on_connect(client, userdata, flags, rc):
        if rc != 0:
            log(f"MQTT refused the connection: {rc}")
            return
        log("MQTT connected")
        client.subscribe(topics.command("+"), qos=1)
        work.put(("connected", None))

    def on_message(client, userdata, msg):
        name = msg.topic.rsplit("/", 1)[-1]
        work.put((name, msg.payload))

    client.on_connect = on_connect
    client.on_message = on_message
    host, port = broker(url)
    client.connect_async(host, port, keepalive=60)
    client.loop_start()

    next_recipes = next_cook = 0.0
    while True:
        try:
            name, payload = work.get(timeout=1)
        except queue.Empty:
            name = None
        if name == "connected":
            adapter.on_connect()
            next_recipes = next_cook = 0.0
        elif name is not None:
            adapter.command(name, payload)
        now = time.monotonic()
        if now >= next_recipes:
            adapter.refresh_recipes()
            next_recipes = now + RECIPES_EVERY
        if now >= next_cook:
            adapter.refresh_cook()
            next_cook = now + COOK_EVERY


if __name__ == "__main__":
    main()
