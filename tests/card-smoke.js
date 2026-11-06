// Smoke test for dist/anova-oven-card.js, outside a browser:
//   node tests/card-smoke.js dist/anova-oven-card.js
// It renders the card in several states with fake entities, and checks the
// HTML and the stages Start sends. CI runs it on every push.
// Minimal browser stand-ins: enough to build the card's HTML and run its logic.
const store = {};
global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
global.window = { addEventListener() {}, customCards: [] };
global.HTMLElement = class { dispatchEvent() {} };
let Card;
global.customElements = { define: (_, c) => { Card = c; } };
const root = () => ({ html: "", set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; },
  getElementById: () => null, querySelectorAll: () => [], addEventListener() {} });
HTMLElement.prototype.attachShadow = function () { this.shadowRoot = root(); return this.shadowRoot; };
require(require("path").resolve(process.argv[2]));

const P = "anova_oven";
const st = (v, a = {}) => ({ state: v, attributes: a });
function hass(over = {}) {
  const v = { "binary_sensor.connected": "on", "binary_sensor.cooking": "off", "sensor.mode": "Idle",
    "sensor.temperature": "23", "sensor.probe_temperature": "unknown", "sensor.steam": "40", "light.lamp": "off",
    "binary_sensor.door": "off", ...over };
  const states = {};
  for (const [k, x] of Object.entries(v)) { const [d, n] = k.split("."); states[`${d}.${P}_${n}`] = st(x); }
  states[`event.${P}_cook`] = st("2026-11-05T00:00:00Z", { event_type: over.event || "cook_started" });
  const calls = [];
  return { states, calls, callService: (d, s, data) => { calls.push({ d, s, data }); return Promise.resolve(); } };
}
const c = new Card();
c.setConfig({ type: "custom:anova-oven-card" });
let h = hass(); c.hass = h;
const html = () => c.shadowRoot.innerHTML;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

check("idle renders the steps row with one chip and +", html().includes('data-chip="0"') && html().includes('id="step-add"') && !html().includes('id="step-remove"'));
check("start label is Bake", />\s*Bake<\/button>/.test(html()) || html().includes("</ha-icon>Bake</button>"));
c._addStep();
check("+ adds step 2 and selects it", c._setup.steps.length === 2 && c._setup.sel === 1);
check("step 2 shows the remove x and the Waits toggle", html().includes('id="step-remove"') && html().includes('id="waits"') && html().includes("<span>Auto</span>"));
c._update({ temp: 200, end: "timer", timer: 15 });
check("controls edit only the selected step", c._setup.steps[1].temp === 200 && c._setup.steps[0].temp === 180);
c._update({ waits: true });
c._update({ sel: 0 });
check("step 1 shows Preheat, not Waits", html().includes('id="preheat"') && !html().includes('id="waits"'));
check("start label counts steps", html().includes("Bake · 2 steps"));
c._start();
const payload = JSON.parse(h.calls.at(-1).data.payload);
check("start sends preheat + 2 cook stages", payload.stages.map((x) => x.kind).join(",") === "preheat,cook,cook");
check("step 2 waits and has its timer", payload.stages[2].user_action_required === true && payload.stages[2].duration_secs === 900);
check("step 1 starts by itself", payload.stages[1].user_action_required === false);
c._update({ sel: 1 }); c._removeStep();
check("x removes the selected step", c._setup.steps.length === 1 && c._setup.sel === 0);
c._update({ end: "probe" });
check("probe end without the probe disables Start", /id="start"[^>]*disabled/.test(html()));
h = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "2 of 3", "sensor.target_temperature": "200" });
c.hass = h;
check("cooking shows the running stages (1 done, 2 on)", html().includes("steps running") && html().includes("✓") && html().includes('chip-step on'));
h = hass({ "binary_sensor.connected": "off" }); c.hass = h;
check("offline renders", html().includes("Offline"));
// A saved 0.7 setup migrates into one step.
store["anova-oven-card:setup"] = JSON.stringify({ mode: "rear", sousVide: true, temp: 56, end: "timer", timer: 90, preheat: false });
const c2 = new Card(); c2.setConfig({}); 
check("0.7 setup migrates", c2._setup.steps.length === 1 && c2._setup.steps[0].mode === "rear" && c2._setup.steps[0].temp === 56 && c2._setup.preheat === false);

// --- Presets (0.9) ---
const recipes = [
  { title: "Pizza", stages: [
    { kind: "preheat", temperature_c: 250, temperature_bulbs_mode: "dry", steam_pct: 0, fan_speed: 100, heating_element_top: true, heating_element_bottom: true },
    { kind: "cook", temperature_c: 250, temperature_bulbs_mode: "dry", steam_pct: 20, fan_speed: 100, heating_element_top: true, heating_element_bottom: true, timer_added: true, duration_secs: 600 },
    { kind: "cook", temperature_c: 200, temperature_bulbs_mode: "dry", steam_pct: 0, fan_speed: 100, heating_element_rear: true, timer_added: true, duration_secs: 300, user_action_required: true },
  ] },
  { title: "Salmon", stages: [
    { kind: "cook", temperature_c: 52, temperature_bulbs_mode: "wet", steam_pct: 100, fan_speed: 100, heating_element_rear: true, probe_added: true, probe_target_c: 48 },
  ] },
];
const c3 = new Card();
store["anova-oven-card:setup"] = null;
c3.setConfig({});
h = hass(); h.states[`sensor.${P}_recipes`] = st("2", { recipes }); c3.hass = h;
c3._panel = "presets"; c3._render();
const h3 = () => c3.shadowRoot.innerHTML;
check("presets panel does not mark the cog", !/class="icon-state tools on"/.test(h3()));
check("presets panel lists both recipes", h3().includes("Pizza") && h3().includes("Salmon") && h3().includes('data-run="1"'));
check("summary shows steps and sous vide", h3().includes("250° · 2 steps") && h3().includes("52° · sous vide"));
const before = JSON.stringify(c3._setup);
c3._loadPreset(recipes[0]);
check("load: preheat on, 2 steps, rear for step 2, waits", c3._setup.preheat === true && c3._setup.steps.length === 2
  && c3._setup.steps[1].mode === "rear" && c3._setup.steps[1].waits === true && c3._setup.steps[0].steam === 20);
check("load offers Undo", h3().includes('id="undo"'));
c3._setProgram(c3._undo.setup); c3._undo = null;
check("undo restores the previous steps", JSON.stringify(c3._setup) === before);
c3._loadPreset(recipes[1]);
check("load sous vide + probe", c3._setup.preheat === false && c3._setup.steps[0].sousVide && c3._setup.steps[0].end === "probe" && c3._setup.steps[0].probe === 48);
c3._presetName = "New one"; c3._savePreset();
let call = h.calls.at(-1);
check("save publishes a new recipe", call.data.topic === "anova/oven/cmd/save_recipe" && !JSON.parse(call.data.payload).replace
  && JSON.parse(call.data.payload).title === "New one");
c3._presetName = "Pizza"; const n = h.calls.length; c3._savePreset();
check("replacing an existing name needs a second tap", h.calls.length === n && c3._armed.key === "save");
c3._savePreset();
call = h.calls.at(-1);
check("second tap replaces", JSON.parse(call.data.payload).replace === "Pizza");
// Steps -> stages -> steps is lossless for what the card edits.
c3._loadPreset(recipes[0]);
const again = programFromStagesForTest(c3);
check("round trip keeps the program", JSON.stringify(again.steps) === JSON.stringify(c3._setup.steps) && again.preheat === c3._setup.preheat);

function programFromStagesForTest(card) {
  // Save builds the stages; Load turns them back into steps.
  card._presetName = "rt"; card._savePreset();
  const stages = JSON.parse(h.calls.at(-1).data.payload).stages;
  card._loadPreset({ title: "rt", stages });
  return card._setup;
}

// --- 0.10: typed timer, steam/ends grid, cog badge ---
{
  const src = require("fs").readFileSync(require("path").resolve(process.argv[2]), "utf8");
  const a = src.indexOf("function parseMinutes"), b = src.indexOf("\nfunction stageBase");
  const parseMinutes = new Function(`${src.slice(a, b)}; return parseMinutes;`)();
  const cases = { "90": 90, "1:30": 90, "1h30": 90, "1 h 30 m": 90, "45m": 45, "2h": 120, "0:05": 5, "": null, "abc": null };
  check("typed timer formats parse", Object.entries(cases).every(([t, v]) => parseMinutes(t) === v));
  const c4 = new Card(); store["anova-oven-card:setup"] = null; c4.setConfig({});
  let h4 = hass(); c4.hass = h4;
  c4._update({ end: "timer" });
  const out = c4.shadowRoot.innerHTML;
  check("steam and ends share the grid", out.includes('<div class="se">'));
  check("the timer value is tappable", out.includes('id="end-edit"'));
  check("no badge when nothing is needed", !out.includes('class="badge"'));
  h4 = hass({ "binary_sensor.descale_required": "on" }); c4.hass = h4;
  check("descale needed puts a badge on the cog", c4.shadowRoot.innerHTML.includes('class="badge"'));
  check("mode selection is not orange", !/\.option\.on \{ background: rgb\(var\(--oven-rgb\)\)/.test(src));
}

// --- 0.10.3: the width class comes from a ResizeObserver ---
{
  let observed;
  global.ResizeObserver = class { constructor(cb) { observed = cb; } observe() {} disconnect() {} };
  global.setInterval = () => 0; global.clearInterval = () => {};
  const c5 = new Card(); store["anova-oven-card:setup"] = null; c5.setConfig({});
  c5.shadowRoot.querySelector = () => null;
  c5.connectedCallback(); c5.hass = hass();
  observed([{ contentRect: { width: 450 } }]); c5._render();
  check("a 450 px card gets the wide layout", /<ha-card class="[^"]*\bwide\b/.test(c5.shadowRoot.innerHTML));
  observed([{ contentRect: { width: 360 } }]); c5._render();
  check("a 360 px card keeps steam in its own row", !/<ha-card class="[^"]*\bwide\b/.test(c5.shadowRoot.innerHTML));
  const src = require("fs").readFileSync(require("path").resolve(process.argv[2]), "utf8");
  check("no container query left", !src.includes("@container"));
  c5.disconnectedCallback();
}

// --- 0.11: element prep, next stage, copy, temperature mark, running chips ---
{
  const c6 = new Card(); store["anova-oven-card:setup"] = null; c6.setConfig({});
  let h6 = hass(); c6.hass = h6;
  c6._startPrep();
  const prep = JSON.parse(h6.calls.at(-1).data.payload);
  check("element prep: 4 automatic stages", prep.stages.length === 4 && prep.stages.every((x) => x.user_action_required === false));
  check("element prep: cool-downs at 25 °C with the vent open", [1, 3].every((i) => prep.stages[i].temperature_c === 25 && prep.stages[i].vent_open === true && prep.stages[i].heating_element_rear));
  check("element prep: last cool-down has no timer", !prep.stages[3].timer_added && prep.stages[2].duration_secs === 900);
  check("element prep: short title", prep.title === "Element prep");
  h6 = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "1 of 4", "sensor.temperature": "143",
    "sensor.target_temperature": "176", "sensor.current_recipe": "Element prep", "sensor.stage_ends_at": new Date(Date.now() + 737000).toISOString(),
    "number.set_timer": "15" });
  // The stages come from the server, not from the browser that started the cook.
  h6.states[`sensor.${P}_current_recipe`].attributes = { stages: prep.stages };
  c6.hass = h6;
  const o = c6.shadowRoot.innerHTML;
  check("a later stage exists: Skip to step 2", o.includes("Skip to step 2"));
  check("status line is only the program name", /id="secondary">Element prep</.test(o));
  check("progress row shows step and time left", o.includes("Step 1/4") && /\d+:\d\d left/.test(o));
  check("temperature shows current → target", o.includes("143 → 176 °C") && o.includes('id="temp-mark"'));
  check("running chips show stage temperatures and a snowflake", o.includes("176°") && o.includes("mdi:snowflake"));
  const c8 = new Card(); c8.setConfig({}); c8.hass = h6;
  check("another device shows the same stage temperatures", c8.shadowRoot.innerHTML.includes("176°") && c8.shadowRoot.innerHTML.includes("mdi:snowflake"));
  c6._step("end", 1, c6._model());
  const plus = h6.calls.at(-1).data;
  check("+ on a running timer adds 5 min to the time left", plus.topic === "anova/oven/cmd/timer" && Math.abs(Number(plus.payload) - 1037) <= 2);
  c6._step("end", -1, c6._model());
  check("- on a running timer takes 5 min from the time left", Math.abs(Number(h6.calls.at(-1).data.payload) - 437) <= 2);
  c6.hass = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "4 of 4", "sensor.temperature": "174",
    "sensor.target_temperature": "25", "sensor.current_recipe": "Element prep" });
  const cool = c6.shadowRoot.innerHTML;
  check("no end: no - and + next to Until you stop", cool.includes("Until you stop") && !cool.includes('data-step="end:'));
  check("a 25 °C mark stays inside the bar", /id="temp-mark" style="left:calc\(6px \+ \(100% - 12px\) \* 0\)"/.test(cool));
  c6.hass = h6;
  c6._nextStage();
  check("skip publishes cmd/next_stage", h6.calls.at(-1).data.topic === "anova/oven/cmd/next_stage");
  h6 = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "1 of 2", "binary_sensor.next_stage_ready": "on",
    "sensor.current_recipe": "x" });
  c6.hass = h6;
  check("a waiting step: Start step 2, and the row says so", c6.shadowRoot.innerHTML.includes("Start step 2") && c6.shadowRoot.innerHTML.includes("Step 2 waits for you"));
  const c7 = new Card(); store["anova-oven-card:setup"] = null; c7.setConfig({}); c7.hass = hass();
  c7._addStep(); c7._update({ temp: 220 }); c7._update({ sel: 0 });
  check("short program title", programTitleOf(c7) === "180 → 220 °C · 2 steps");
  function programTitleOf(card) { card._start(); return JSON.parse(card._hass.calls.at(-1).data.payload).title; }
}

// --- 0.12: power plug, offline states ---
{
  const PLUG = { power_switch: "switch.oven_plug", power_sensor: "sensor.oven_plug_power" };
  const withPlug = (over, plug, watts, link) => {
    const h = hass(over);
    h.states["switch.oven_plug"] = st(plug);
    h.states["sensor.oven_plug_power"] = st(String(watts));
    if (link) Object.assign(h.states[`binary_sensor.${P}_connected`], link);
    return h;
  };
  const card = (h) => { const c = new Card(); store["anova-oven-card:setup"] = null; c.setConfig(PLUG); c.hass = h; return c; };
  const tools = (c) => { c._panel = "maintenance"; c._render(); return c.shadowRoot.innerHTML; };

  let c = card(withPlug({}, "on", 2));
  check("idle status line shows the power draw", /id="secondary">Idle · 23 °C · 2 W</.test(c.shadowRoot.innerHTML));
  check("idle: Turn off in the cog panel", tools(c).includes('id="power-off"'));
  c._power("off");
  check("Turn off needs a second tap", !c._hass.calls.some((x) => x.s === "turn_off"));
  c._power("off");
  check("the second tap turns the plug off", c._hass.calls.at(-1).s === "turn_off" && c._hass.calls.at(-1).data.entity_id === "switch.oven_plug");

  c = card(withPlug({ "sensor.temperature": "120" }, "on", 2));
  check("idle but hot: Turn off too", tools(c).includes('id="power-off"'));
  c = card(withPlug({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.temperature": "30" }, "on", 1900));
  check("cooking: no power button, kW in the status line", !tools(c).includes('id="power-') && c.shadowRoot.innerHTML.includes("1.9 kW"));

  c = card(withPlug({ "binary_sensor.connected": "off" }, "off", 0));
  let o = c.shadowRoot.innerHTML;
  check("plug off: Power off, and Turn on in place of Bake", o.includes(">Power off · 0 W<") && o.includes('id="power-on"') && !o.includes('id="start"'));
  c._power("on");
  check("Turn on is one tap", c._hass.calls.at(-1).s === "turn_on");

  c = card(withPlug({ "binary_sensor.connected": "off" }, "on", 3));
  o = c.shadowRoot.innerHTML;
  check("offline, plug on: check the Wi-Fi; door and probe unknown", o.includes("check the oven&#39;s Wi-Fi") || o.includes("check the oven's Wi-Fi"));
  check("offline: header icons show unknown", (o.match(/class="icon-state[^"]*unknown/g) || []).length === 2);
  check("offline and idle draw: Restart in the cog panel", tools(c).includes('id="power-restart"'));
  c = card(withPlug({ "binary_sensor.connected": "off" }, "on", 300));
  check("offline but drawing 300 W: no Restart", !tools(c).includes('id="power-restart"') && tools(c).includes("may still run"));

  c = card(withPlug({ "binary_sensor.connected": "off" }, "on", 300, {
    last_changed: "2026-11-06T11:40:00Z", attributes: { mode: "cook", temperature_c: 171, target_temperature_c: 176, recipe_title: "Pizza" } }));
  o = c.shadowRoot.innerHTML;
  check("offline after a cook: Offline since, and the notice row", o.includes("Offline since") && o.includes("Was cooking at 176 °C · it may still run") && !o.includes('data-select="mode"'));

  const h = hass(); delete h.states[`binary_sensor.${P}_connected`];
  c = card(h);
  check("app not running: says so", c.shadowRoot.innerHTML.includes("The Anova app in Home Assistant is not running"));
  c = new Card(); c.setConfig({}); c.hass = withPlug({}, "on", 2);
  check("no plug configured: no power item, no watts", !tools(c).includes("Power <span") && !c.shadowRoot.innerHTML.includes(" W<"));
}

// --- 0.12.3: descale unknown, water tag only when empty ---
{
  const c = new Card(); c.setConfig({});
  const h = hass({ "binary_sensor.descale_required": "off" }); c.hass = h;
  c._panel = "maintenance"; c._render();
  let o = c.shadowRoot.innerHTML;
  check("descale off: not needed, and no water tag", o.includes(">not needed<") && !o.includes("Water <span"));
  c.hass = hass({ "binary_sensor.descale_required": "unavailable", "binary_sensor.water_tank_empty": "on" });
  o = c.shadowRoot.innerHTML;
  check("descale unavailable: unknown; tank empty: water tag", o.includes(">unknown<") && o.includes('Water <span class="tag warn">empty'));
}
