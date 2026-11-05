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
check("step 2 shows the remove x and the Waits toggle", html().includes('id="step-remove"') && html().includes('id="waits"'));
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
