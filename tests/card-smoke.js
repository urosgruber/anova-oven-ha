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
  check("status line is only the program name", /id="secondary"><span class="sec-main">Element prep<\/span><\/div>/.test(o));
  check("progress row shows the step and when it ends", o.includes("Step 1/4") && /Ends \d\d:\d\d/.test(o));
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
  check("idle status line shows the power draw", c.shadowRoot.innerHTML.includes('<span class="sec-main">Idle · 23 °C</span><span class="sec-power"> · 2 W</span>'));
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
  check("plug off: Power off, and Turn on in place of Bake", o.includes('>Power off</span><span class="sec-power"> · 0 W<') && o.includes('id="power-on"') && !o.includes('id="start"'));
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

// --- 0.12.4: - and + on the temperature are 1 °C ---
{
  const c = new Card(); store["anova-oven-card:setup"] = null; c.setConfig({}); c.hass = hass();
  c._step("temp", 1, c._model());
  check("+ on the temperature adds 1 °C", c._view().temp === 181);
  const h = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.target_temperature": "176" }); c.hass = h;
  c._step("temp", -1, c._model());
  check("- on a running cook sets the target 1 °C lower", h.calls.at(-1).data.topic === "anova/oven/cmd/temperature" && h.calls.at(-1).data.payload === "175");
}

// --- 0.12.4: test findings: finished timer, steam setting, stable end ---
{
  const stages = [{ kind: "cook", temperature_c: 100, steam_pct: 100, timer_added: true, duration_secs: 300 }];
  const h = hass({ "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "1 of 1", "sensor.steam": "0",
    "sensor.target_temperature": "100", "sensor.current_recipe": "x", event: "cook_done" });
  h.states[`sensor.${P}_current_recipe`].attributes = { stages };
  const c = new Card(); c.setConfig({}); c.hass = h;
  const o = c.shadowRoot.innerHTML;
  check("finished timer: the timer stays selected, Done without - and +", /class="option on"[^>]*data-key="timer"/.test(o) && o.includes(">Done<") && !o.includes('data-step="end:'));
  check("done: the bar says what the oven does", o.includes("Done · holding 100 °C"));
  check("steam row shows the step's steam setting, not the 0 reading", o.includes("Steam 100 %"));
  const t = Date.parse("2026-11-06T15:40:00Z");
  c._endsAt = null; c._stableEnd(t);
  check("end time ignores a 1 s wobble", c._stableEnd(t + 1000) === t && c._stableEnd(t - 1000) === t);
  check("end time follows a real change", c._stableEnd(t + 300000) === t + 300000);
}

// --- 0.13: auto stop, count-up, sous vide in 0.1 °C ---
{
  const at = (v) => ({ state: v, attributes: {}, last_changed: new Date(Date.now() - 754000).toISOString() });
  const base = { "binary_sensor.cooking": "on", "sensor.mode": "Cooking", "sensor.stage": "1 of 1", "sensor.current_recipe": "x",
    "switch.auto_stop": "on", "sensor.target_temperature": "180", "sensor.temperature": "150" };
  // A timer cook with Auto stop on says "Stops".
  let h = hass({ ...base, "sensor.stage_ends_at": new Date(Date.now() + 600000).toISOString(), "number.set_timer": "20" });
  h.states[`sensor.${P}_current_recipe`].attributes = { stages: [{ kind: "cook", temperature_c: 180, timer_added: true, duration_secs: 1200 }] };
  let c = new Card(); c.setConfig({}); c.hass = h;
  check("auto stop on: the last step says Stops HH:MM", /Stops \d\d:\d\d/.test(c.shadowRoot.innerHTML));
  c._panel = "maintenance"; c._render();
  check("cog panel: Auto stop item, descale in the head", c.shadowRoot.innerHTML.includes('id="auto-stop"') && c.shadowRoot.innerHTML.includes('class="head-tags"'));
  c.shadowRoot.getElementById = () => null;
  c._call("switch", "turn_off", { entity_id: "switch.anova_oven_auto_stop" });
  // No end: the time counts up from the cook's start.
  h = hass({ ...base });
  h.states[`binary_sensor.${P}_cooking`] = at("on");
  h.states[`sensor.${P}_current_recipe`].attributes = { stages: [{ kind: "cook", temperature_c: 180 }] };
  c = new Card(); c.setConfig({}); c.hass = h;
  let o = c.shadowRoot.innerHTML;
  check("no end: the time counts up", /12:3\d in/.test(o) && /Since \d\d:\d\d/.test(o) && !o.includes('data-step="end:'));
  // After the oven's own preheat: count from the step's start, as the oven does.
  h.states[`binary_sensor.${P}_connected`].attributes = { stage_started_at: new Date(Date.now() - 157000).toISOString() };
  c = new Card(); c.setConfig({}); c.hass = h; o = c.shadowRoot.innerHTML;
  check("no end: counts from the step's start", /2:3[67] in/.test(o));
  // Sous vide: the wet bulb and the stage's target, in 0.1 °C steps.
  h = hass({ ...base, "sensor.wet_bulb_temperature": "55.43", "sensor.target_temperature": "unknown" });
  h.states[`sensor.${P}_current_recipe`].attributes = { stages: [{ kind: "cook", temperature_c: 56.5, temperature_bulbs_mode: "wet", steam_pct: 100 }] };
  c = new Card(); c.setConfig({}); c.hass = h;
  check("sous vide cook: wet bulb → stage target", c.shadowRoot.innerHTML.includes("55.4 → 56.5 °C"));
  c._step("temp", 1, c._liveModel());
  check("sous vide cook: + adds 0.1 °C", h.calls.at(-1).data.payload === "56.6");
  const c2 = new Card(); store["anova-oven-card:setup"] = null; c2.setConfig({}); c2.hass = hass();
  c2._update({ sousVide: true, temp: 56 }); c2._step("temp", 1, c2._model());
  check("sous vide setup: + adds 0.1 °C", c2._view().temp === 56.1);
}

// --- 0.14: the start says who started it ---
{
  const h = hass(); h.user = { id: "user-123", name: "U" };
  const c = new Card(); store["anova-oven-card:setup"] = null; c.setConfig({}); c.hass = h;
  c._start();
  check("start carries the HA user", JSON.parse(h.calls.at(-1).data.payload).started_by === "user-123");
}

// --- 0.15: the timer takes seconds ---
{
  const src = require("fs").readFileSync(require("path").resolve(process.argv[2]), "utf8");
  const a = src.indexOf("function parseMinutes"), b = src.indexOf("\nfunction stageBase");
  const lib = new Function(`${src.slice(a, b)}; return { parseMinutes, fmtMinutes };`)();
  const cases = { "3m30s": 3.5, "3m30": 3.5, "3 min 30 s": 3.5, "3.5": 3.5, "3,5": 3.5, "210s": 3.5,
    "1h30": 90, "1:30": 90, "1:02:30": 62.5, "3:30.40": 210 + 40 / 60, "3:30,40": 210 + 40 / 60, "1h2m30s": 62.5, "45": 45 };
  const bad = Object.entries(cases).filter(([t, v]) => Math.abs(lib.parseMinutes(t) - v) > 1e-9);
  check("typed timer takes seconds", bad.length === 0);
  if (bad.length) console.log(bad, bad.map(([t]) => lib.parseMinutes(t)));
  check("timer field shows seconds", lib.fmtMinutes(3.5) === "3m30s" && lib.fmtMinutes(90) === "90");
  const h = hass(); const c = new Card(); store["anova-oven-card:setup"] = null; c.setConfig({}); c.hass = h;
  c._update({ end: "timer", timer: 3.5 });
  c._start();
  const stages = JSON.parse(h.calls.at(-1).data.payload).stages;
  check("3m30s starts as 210 s", stages.at(-1).duration_secs === 210);
  check("3m30s shows 3:30", c.shadowRoot.innerHTML.includes("3:30"));
  c._step("end", 1, c._model());
  check("+ from 3m30s goes to 4 min", c._view().timer === 4);
  c._update({ timer: 3.5 }); c._step("end", -1, c._model());
  check("- from 3m30s goes to 3 min", c._view().timer === 3);
}

// --- The re-render rule: HA sets hass for every state change in the whole
// instance. The card renders only for a watched entity, and never while the
// user types, taps or drags (that would replace the element under the finger).
{
  const c = new Card(); store["anova-oven-card:setup"] = null; c.setConfig({});
  let h = hass(); c.hass = h;
  let renders = 0; const render = c._render.bind(c); c._render = () => { renders++; render(); };
  const next = (over) => ({ ...h, states: { ...h.states, ...over } });
  h = next({ "sensor.living_room_temperature": st("21") }); c.hass = h;
  check("an unrelated entity does not re-render", renders === 0);
  h = next({ [`sensor.${P}_temperature`]: st("150") }); c.hass = h;
  check("a watched entity re-renders", renders === 1);
  c._typing = true;
  h = next({ [`sensor.${P}_temperature`]: st("160") }); c.hass = h;
  check("no re-render while typing; it waits", renders === 1 && c._dirty === true);
  c._typing = false; c._holding = true;
  h = next({ [`sensor.${P}_temperature`]: st("170") }); c.hass = h;
  check("no re-render while a button is held", renders === 1);
}

// --- 0.15.3: the time ticks one second per tick ---
{
  const src = require("fs").readFileSync(require("path").resolve(process.argv[2]), "utf8");
  const a = src.indexOf("// Seconds left, rounded up"), b = src.indexOf("function progress");
  const lib = new Function(`${src.slice(a, b)}; return { remaining, elapsed };`)();
  const real = Date.now;
  const base = Math.floor(real() / 1000) * 1000;
  const endsAt = base + 600000, since = base - 100000 + 437; // a cook start with milliseconds
  let downs = [], ups = [];
  for (let k = 1; k <= 300; k++) {
    // Ticks 20 ms after each second, with up to ±15 ms of delay.
    const t = base + k * 1000 + 20 + Math.round(Math.sin(k * 7.3) * 15);
    Date.now = () => t;
    downs.push(lib.remaining({ endsAt })); ups.push(lib.elapsed(since));
  }
  Date.now = real;
  const steps = (xs) => xs.slice(1).map((x, i) => x - xs[i]);
  check("the countdown goes down by 1 s at every tick", steps(downs).every((d) => d === -1));
  check("the count-up goes up by 1 s at every tick", steps(ups).every((d) => d === 1));
  Date.now = () => endsAt - 400; check("the last second shows 1, not 0", lib.remaining({ endsAt }) === 1);
  Date.now = real;
}
{
  // The card schedules its tick 20 ms after the next full second.
  const realTimeout = global.setTimeout, realNow = Date.now;
  const delays = [];
  global.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
  Date.now = () => 1700000000000 + 730;
  const c = new Card(); c.setConfig({}); c.hass = hass(); c.connectedCallback();
  global.setTimeout = realTimeout; Date.now = realNow;
  check("the tick lands just after the next full second", delays.at(-1) === 290);
}
