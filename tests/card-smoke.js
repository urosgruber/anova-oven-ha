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
check("step 2 shows the remove x and the Waits toggle", html().includes('id="step-remove"') && html().includes('id="waits"') && html().includes("Auto start"));
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
