/*
 * anova-oven-card: a Home Assistant dashboard card for the Anova Precision
 * Oven, run locally by anova-oven-server (ha-app/). It reads the MQTT
 * entities the server creates (all named <prefix>_*, default "anova_oven").
 *
 * It works like the oven's handle: set the temperature on the dial, choose
 * the heating elements, sous vide, steam and a timer, then Start. While a
 * cook runs, it shows progress and lets you change the temperature, add
 * time, go to the next stage, or stop. The style follows Home Assistant's
 * tile card and the Mushroom cards.
 *
 *   type: custom:anova-oven-card
 *   title: Oven                 # optional
 *   prefix: anova_oven          # optional, the entity ID prefix
 *   mqtt_prefix: anova/oven     # optional, the server's MQTT topic prefix
 *   presets:                    # optional, saved recipes as one-tap buttons
 *     - name: Pizza
 *       recipe: Pizza           # an option of select.<prefix>_recipe
 *       icon: mdi:pizza
 *
 * The HA app installs this file and registers it as a dashboard resource.
 * A manual Start publishes {"stages": [...]} to <mqtt_prefix>/cmd/start
 * with the mqtt.publish service. No external libraries.
 */

const CARD_VERSION = "0.3.0";
const STOP_CONFIRM_MS = 3000;
const LAMP_CONFIRM_MS = 15000;
const SETUP_KEY = "anova-oven-card:setup";

const ELEMENTS = [
  { key: "top", icon: "mdi:arrow-collapse-down", label: "Top" },
  { key: "rear", icon: "mdi:fan", label: "Rear" },
  { key: "bottom", icon: "mdi:arrow-collapse-up", label: "Bottom" },
];
const LIMITS = { dry: [25, 250], wet: [25, 100] };
const DEFAULT_SETUP = {
  temp: 180, mode: "dry", elements: ["top", "bottom"], steam: 0, timer: 0, preheat: true,
};

class AnovaOvenCard extends HTMLElement {
  static getStubConfig() {
    return { prefix: "anova_oven" };
  }

  setConfig(config) {
    this._config = { prefix: "anova_oven", mqtt_prefix: "anova/oven", ...config };
    this._stopArmedUntil = 0;
    this._lampPending = null;
    this._setup = loadSetup();
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // A lamp change is confirmed once the state matches, or given up on.
    if (this._lampPending) {
      const lamp = this._on("light", "lamp");
      if (lamp === this._lampPending.on || Date.now() > this._lampPending.until) {
        this._lampPending = null;
      }
    }
    // Re-rendering while the dial is dragged would drop the drag.
    if (!this._dragging) this._render();
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    this._tick = setInterval(() => this._renderLive(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  // --- Entity helpers -----------------------------------------------------

  _id(domain, name) {
    return `${domain}.${this._config.prefix}_${name}`;
  }

  _state(domain, name) {
    return this._hass && this._hass.states[this._id(domain, name)];
  }

  _value(domain, name) {
    const s = this._state(domain, name);
    if (!s || s.state === "unknown" || s.state === "unavailable") return null;
    return s.state;
  }

  _number(domain, name) {
    const v = this._value(domain, name);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  _on(domain, name) {
    return this._value(domain, name) === "on";
  }

  _call(domain, service, data) {
    return this._hass.callService(domain, service, data);
  }

  // --- Actions ------------------------------------------------------------

  _startManual() {
    const s = this._setup;
    const wet = s.mode === "wet";
    const base = {
      temperature_c: s.temp,
      temperature_bulbs_mode: s.mode,
      steam_pct: wet ? 100 : s.steam,
      fan_speed: 100,
      heating_element_top: s.elements.includes("top"),
      heating_element_rear: s.elements.includes("rear"),
      heating_element_bottom: s.elements.includes("bottom"),
    };
    const cook = { ...base, kind: "cook" };
    if (s.timer > 0) Object.assign(cook, { timer_added: true, duration_secs: s.timer * 60 });
    const stages = s.preheat && s.timer > 0 ? [{ ...base, kind: "preheat" }, cook] : [cook];
    this._call("mqtt", "publish", {
      topic: `${this._config.mqtt_prefix}/cmd/start`,
      payload: JSON.stringify({ title: setupTitle(s), stages }),
    });
  }

  async _startRecipe(recipe) {
    await this._call("select", "select_option", { entity_id: this._id("select", "recipe"), option: recipe });
    await this._call("button", "press", { entity_id: this._id("button", "start") });
  }

  _stop() {
    const now = Date.now();
    if (now < this._stopArmedUntil) {
      this._stopArmedUntil = 0;
      this._call("button", "press", { entity_id: this._id("button", "stop") });
    } else {
      // The first tap only arms the button, so a stray tap can't end a cook.
      this._stopArmedUntil = now + STOP_CONFIRM_MS;
      setTimeout(() => this._render(), STOP_CONFIRM_MS + 50);
    }
    this._render();
  }

  _toggleLamp() {
    if (this._lampPending) return;
    const on = !this._on("light", "lamp");
    this._lampPending = { on, until: Date.now() + LAMP_CONFIRM_MS };
    this._call("light", on ? "turn_on" : "turn_off", { entity_id: this._id("light", "lamp") });
    this._render();
    // Clear a change the oven never confirmed.
    setTimeout(() => { if (this._lampPending && Date.now() > this._lampPending.until) { this._lampPending = null; this._render(); } },
      LAMP_CONFIRM_MS + 100);
  }

  _setNumber(name, value) {
    this._call("number", "set_value", { entity_id: this._id("number", name), value });
  }

  _update(change) {
    const s = { ...this._setup, ...change };
    const [lo, hi] = LIMITS[s.mode];
    s.temp = clamp(Math.round(s.temp), lo, hi);
    if (s.mode === "wet") s.steam = 100;
    this._setup = s;
    saveSetup(s);
    this._render();
  }

  _toggleElement(key) {
    const set = new Set(this._setup.elements);
    if (set.has(key)) {
      if (set.size === 1) return; // At least one element.
      set.delete(key);
    } else {
      if (set.size === 2) set.delete([...set].find((k) => k !== key && k !== "rear") || [...set][0]);
      set.add(key);
    }
    this._update({ elements: ELEMENTS.map((e) => e.key).filter((k) => set.has(k)) });
  }

  // --- View model ---------------------------------------------------------

  _model() {
    const connected = this._on("binary_sensor", "connected");
    const cooking = connected && this._on("binary_sensor", "cooking");
    const lastEvent = (this._state("event", "cook") || {}).attributes?.event_type;
    const endsAt = this._value("sensor", "stage_ends_at");
    const timerMin = this._number("number", "set_timer");
    const recipeOptions = ((this._state("select", "recipe") || {}).attributes?.options || [])
      .filter((r) => r && !/^no recipes?/i.test(r));
    const presets = this._config.presets && this._config.presets.length
      ? this._config.presets
      : recipeOptions.map((r) => ({ name: r, recipe: r }));
    return {
      connected,
      cooking,
      phase: this._value("sensor", "mode") || "Unknown",
      done: cooking && lastEvent === "cook_done",
      temp: this._number("sensor", "temperature"),
      target: this._number("sensor", "target_temperature"),
      probe: this._number("sensor", "probe_temperature"),
      steam: this._number("sensor", "steam"),
      endsAt: endsAt ? Date.parse(endsAt) : null,
      timerTotal: timerMin ? timerMin * 60 : null,
      stage: this._value("sensor", "stage"),
      stageDescription: this._value("sensor", "stage_description"),
      recipe: this._value("sensor", "current_recipe"),
      nextReady: this._on("binary_sensor", "next_stage_ready"),
      door: this._on("binary_sensor", "door"),
      lamp: this._on("light", "lamp"),
      waterEmpty: this._on("binary_sensor", "water_tank_empty"),
      descale: this._on("binary_sensor", "descale_required"),
      presets,
    };
  }

  // --- Rendering ----------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="muted">Loading…</div></ha-card>`;
      return;
    }
    const m = this._model();
    const tone = !m.connected ? "error" : m.cooking ? "active" : "idle";

    const chips = [];
    if (!m.connected) chips.push(chip("mdi:wifi-off", "Offline", "error"));
    if (m.waterEmpty) chips.push(chip("mdi:water-off", "Water tank empty", "error"));
    if (m.descale) chips.push(chip("mdi:water-alert", "Descale", "warning"));
    if (m.cooking && m.door) chips.push(chip("mdi:door-open", "Door open", "warning"));

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="${tone}">
        <div class="row header">
          <div class="shape"><ha-icon icon="${m.cooking ? "mdi:stove" : "mdi:toaster-oven"}"></ha-icon></div>
          <div class="info">
            <div class="primary">${esc(this._config.title || "Oven")}</div>
            <div class="secondary" id="secondary">${secondary(m)}</div>
          </div>
          <div class="status-icon ${m.door ? "door-open" : ""}" title="${m.door ? "Door open" : "Door closed"}">
            <ha-icon icon="${m.door ? "mdi:door-open" : "mdi:door-closed"}"></ha-icon>
          </div>
          <button class="status-icon lamp ${m.lamp ? "on" : ""} ${this._lampPending ? "pending" : ""}" id="lamp"
            title="${this._lampPending ? "Switching…" : m.lamp ? "Light on" : "Light off"}" ${m.connected ? "" : "disabled"}>
            <ha-icon icon="${(this._lampPending ? this._lampPending.on : m.lamp) ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}"></ha-icon>
          </button>
        </div>
        ${chips.length ? `<div class="row chips">${chips.join("")}</div>` : ""}
        ${m.cooking ? this._cookingView(m) : this._setupView(m)}
      </ha-card>`;
    this._bind(m);
  }

  _setupView(m) {
    const s = this._setup;
    const wet = s.mode === "wet";
    const [lo, hi] = LIMITS[s.mode];
    return `
      ${m.presets.length ? `<div class="row presets">${m.presets.map((p, i) => `
        <button class="pill preset" data-i="${i}" ${m.connected ? "" : "disabled"}>
          <ha-icon icon="${esc(p.icon || "mdi:chef-hat")}"></ha-icon>${esc(p.name)}</button>`).join("")}</div>` : ""}

      <div class="dial-wrap">
        <button class="round" id="minus" aria-label="Lower"><ha-icon icon="mdi:minus"></ha-icon></button>
        ${dial(s.temp, lo, hi, m.temp)}
        <button class="round" id="plus" aria-label="Higher"><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>

      <div class="segmented">
        <button class="${wet ? "" : "on"}" data-mode="dry"><ha-icon icon="mdi:fire"></ha-icon>Bake</button>
        <button class="${wet ? "on" : ""}" data-mode="wet"><ha-icon icon="mdi:water-thermometer"></ha-icon>Sous vide</button>
      </div>

      <div class="controls">
        <div class="control">
          <span class="label">Elements</span>
          <div class="element-row">${ELEMENTS.map((e) => `
            <button class="element ${s.elements.includes(e.key) ? "on" : ""}" data-el="${e.key}" title="${e.label}">
              <ha-icon icon="${e.icon}"></ha-icon><span>${e.label}</span></button>`).join("")}</div>
        </div>
        <div class="control">
          <span class="label">Steam <b>${wet ? 100 : s.steam}%</b></span>
          <input type="range" id="steam" min="0" max="100" step="10" value="${wet ? 100 : s.steam}" ${wet ? "disabled" : ""}>
        </div>
        <div class="control">
          <span class="label">Timer</span>
          <div class="stepper">
            <button class="round small" id="timer-minus" aria-label="Less time"><ha-icon icon="mdi:minus"></ha-icon></button>
            <span class="value">${s.timer ? clock(s.timer * 60) : "Off"}</span>
            <button class="round small" id="timer-plus" aria-label="More time"><ha-icon icon="mdi:plus"></ha-icon></button>
          </div>
          ${s.timer ? `<label class="check"><input type="checkbox" id="preheat" ${s.preheat ? "checked" : ""}>Start the timer after preheating</label>` : ""}
        </div>
      </div>

      <button class="btn primary" id="start" ${m.connected ? "" : "disabled"}>
        <ha-icon icon="mdi:play"></ha-icon><span>Start · ${esc(setupTitle(s))}</span>
      </button>`;
  }

  _cookingView(m) {
    const armed = Date.now() < this._stopArmedUntil;
    return `
      <div class="progress">
        <div class="bar"><div class="bar-fill" id="bar" style="width:${pct(progress(m))}"></div></div>
        <div class="bar-label" id="bar-label">${barLabel(m)}</div>
      </div>
      <div class="cook-grid">
        <div class="tile">
          <span class="label">Temperature</span>
          <div class="stepper">
            <button class="round small" id="t-minus" aria-label="Lower"><ha-icon icon="mdi:minus"></ha-icon></button>
            <span class="value big">${m.target === null ? "—" : Math.round(m.target)}°</span>
            <button class="round small" id="t-plus" aria-label="Higher"><ha-icon icon="mdi:plus"></ha-icon></button>
          </div>
          <span class="sub">now ${m.temp === null ? "—" : Math.round(m.temp)} °C</span>
        </div>
        <div class="tile">
          <span class="label">Timer</span>
          <div class="stepper">
            <button class="round small" id="add5" aria-label="Add 5 minutes"><ha-icon icon="mdi:timer-plus-outline"></ha-icon></button>
            <span class="value big" id="tile-time">${tileTime(m)}</span>
          </div>
          <span class="sub">${m.timerTotal ? `of ${clock(m.timerTotal)}` : "no timer"}</span>
        </div>
        <div class="tile">
          <span class="label">Steam</span>
          <span class="value big">${m.steam === null ? "—" : Math.round(m.steam)}%</span>
          <span class="sub">${m.probe !== null ? `probe ${Math.round(m.probe)} °C` : "humidity"}</span>
        </div>
      </div>
      <div class="row buttons">
        ${m.nextReady ? `<button class="btn" id="next"><ha-icon icon="mdi:skip-next"></ha-icon><span>Next stage</span></button>` : ""}
        <button class="btn stop ${armed ? "armed" : ""}" id="stop">
          <ha-icon icon="mdi:stop"></ha-icon><span>${armed ? "Tap again to stop" : "Stop"}</span>
        </button>
      </div>`;
  }

  _bind(m) {
    const root = this.shadowRoot;
    const $ = (id) => root.getElementById(id);
    const on = (id, fn) => { if ($(id)) $(id).onclick = fn; };
    on("lamp", () => this._toggleLamp());
    on("stop", () => this._stop());
    on("next", () => this._call("button", "press", { entity_id: this._id("button", "next_stage") }));
    on("start", () => this._startManual());
    on("minus", () => this._update({ temp: this._setup.temp - (this._setup.mode === "wet" ? 0.5 : 5) }));
    on("plus", () => this._update({ temp: this._setup.temp + (this._setup.mode === "wet" ? 0.5 : 5) }));
    on("timer-minus", () => this._update({ timer: Math.max(0, this._setup.timer - stepFor(this._setup.timer, -1)) }));
    on("timer-plus", () => this._update({ timer: Math.min(24 * 60, this._setup.timer + stepFor(this._setup.timer, 1)) }));
    on("t-minus", () => m.target !== null && this._setNumber("set_temperature", Math.round(m.target) - 5));
    on("t-plus", () => m.target !== null && this._setNumber("set_temperature", Math.round(m.target) + 5));
    on("add5", () => this._setNumber("set_timer", Math.round((m.timerTotal || 0) / 60) + 5));
    if ($("steam")) $("steam").onchange = (e) => this._update({ steam: Number(e.target.value) });
    if ($("preheat")) $("preheat").onchange = (e) => this._update({ preheat: e.target.checked });
    root.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => this._update({ mode: b.dataset.mode }); });
    root.querySelectorAll("[data-el]").forEach((b) => { b.onclick = () => this._toggleElement(b.dataset.el); });
    root.querySelectorAll(".preset").forEach((b) => { b.onclick = () => this._startRecipe(m.presets[Number(b.dataset.i)].recipe); });
    this._bindDial();
  }

  _bindDial() {
    const svg = this.shadowRoot.getElementById("dial");
    if (!svg) return;
    const [lo, hi] = LIMITS[this._setup.mode];
    const valueAt = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ev.clientX - (r.left + r.width / 2), y = ev.clientY - (r.top + r.height / 2);
      let deg = (Math.atan2(y, x) * 180) / Math.PI - DIAL_START;
      deg = ((deg % 360) + 360) % 360;
      if (deg > DIAL_SWEEP) deg = deg > DIAL_SWEEP + (360 - DIAL_SWEEP) / 2 ? 0 : DIAL_SWEEP;
      return lo + (deg / DIAL_SWEEP) * (hi - lo);
    };
    const step = this._setup.mode === "wet" ? 0.5 : 1;
    const show = (v) => {
      v = clamp(Math.round(v / step) * step, lo, hi);
      this._dragValue = v;
      const f = (v - lo) / (hi - lo);
      svg.querySelector(".dial-fill").setAttribute("d", arcPath(f));
      const [x, y] = arcPoint(f);
      svg.querySelector(".dial-knob").setAttribute("cx", x);
      svg.querySelector(".dial-knob").setAttribute("cy", y);
      this.shadowRoot.getElementById("dial-value").textContent = fmtTemp(v);
    };
    svg.onpointerdown = (ev) => {
      this._dragging = true;
      svg.setPointerCapture(ev.pointerId);
      show(valueAt(ev));
    };
    svg.onpointermove = (ev) => { if (this._dragging) show(valueAt(ev)); };
    svg.onpointerup = svg.onpointercancel = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._update({ temp: this._dragValue });
    };
  }

  _renderLive() {
    if (!this.shadowRoot || !this._hass || this._dragging) return;
    const m = this._model();
    const $ = (id) => this.shadowRoot.getElementById(id);
    if ($("secondary")) $("secondary").innerHTML = secondary(m);
    if ($("bar")) $("bar").style.width = pct(progress(m));
    if ($("bar-label")) $("bar-label").innerHTML = barLabel(m);
    if ($("tile-time")) $("tile-time").textContent = tileTime(m);
  }
}

// --- Dial -------------------------------------------------------------------

const DIAL_START = 135, DIAL_SWEEP = 270, DIAL_R = 70, DIAL_C = 84;

function arcPoint(f) {
  const a = ((DIAL_START + DIAL_SWEEP * f) * Math.PI) / 180;
  return [DIAL_C + DIAL_R * Math.cos(a), DIAL_C + DIAL_R * Math.sin(a)];
}

function arcPath(f) {
  const [x0, y0] = arcPoint(0);
  const [x1, y1] = arcPoint(Math.max(0.0001, f));
  return `M ${x0} ${y0} A ${DIAL_R} ${DIAL_R} 0 ${DIAL_SWEEP * f > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function dial(value, lo, hi, now) {
  const f = (value - lo) / (hi - lo);
  const [kx, ky] = arcPoint(f);
  const nowMark = now === null ? "" : (() => {
    const [nx, ny] = arcPoint(clamp((now - lo) / (hi - lo), 0, 1));
    return `<circle cx="${nx}" cy="${ny}" r="3" class="dial-now"/>`;
  })();
  return `
    <div class="dial">
      <svg id="dial" viewBox="0 0 168 168" role="slider" aria-valuemin="${lo}" aria-valuemax="${hi}" aria-valuenow="${value}">
        <path d="${arcPath(1)}" class="dial-track"/>
        <path d="${arcPath(f)}" class="dial-fill"/>
        ${nowMark}
        <circle cx="${kx}" cy="${ky}" r="9" class="dial-knob"/>
      </svg>
      <div class="dial-center">
        <div class="dial-value" id="dial-value">${fmtTemp(value)}</div>
        <div class="dial-sub">now ${now === null ? "—" : Math.round(now)} °C</div>
      </div>
    </div>`;
}

// --- Pieces -----------------------------------------------------------------

function setupTitle(s) {
  return s.mode === "wet" ? `Sous vide ${fmtTemp(s.temp)}` : `${fmtTemp(s.temp)}${s.steam ? ` · ${s.steam}% steam` : ""}`;
}

function fmtTemp(v) {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}°`;
}

function stepFor(minutes, dir) {
  // 1-minute steps up to 10, then 5 up to 60, then 15.
  const at = dir < 0 ? minutes - 1 : minutes;
  return at < 10 ? 1 : at < 60 ? 5 : 15;
}

function remaining(m) {
  return m.endsAt ? Math.max(0, Math.round((m.endsAt - Date.now()) / 1000)) : null;
}

function progress(m) {
  if (m.done) return 1;
  const left = remaining(m);
  if (left !== null && m.timerTotal) return 1 - left / m.timerTotal;
  if (m.temp !== null && m.target) return m.temp / m.target;
  return 0;
}

function secondary(m) {
  if (!m.connected) return "Offline";
  const temp = m.temp === null ? "—" : `${Math.round(m.temp)} °C`;
  if (!m.cooking) return `Idle · ${temp}`;
  const what = m.done ? "Done, still heating" : m.phase;
  return `${esc(m.recipe ? `${m.recipe} · ${what}` : what)}`;
}

function barLabel(m) {
  const stage = [m.stage && `Stage ${m.stage}`, m.stageDescription].filter(Boolean).join(" · ");
  return `<span class="stage">${esc(stage)}</span><span class="time">${m.done ? "Done" : m.phase === "Preheating" ? "Preheating" : ""}</span>`;
}

function tileTime(m) {
  if (m.done) return "0:00";
  const left = remaining(m);
  return left === null ? "—" : clock(left);
}

function chip(icon, text, tone = "") {
  return `<span class="chip ${tone}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
}

function clock(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pct(f) {
  return `${Math.round(clamp(f, 0, 1) * 100)}%`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function loadSetup() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_KEY) || "null");
    if (saved && typeof saved === "object") return { ...DEFAULT_SETUP, ...saved };
  } catch (_) { /* no storage */ }
  return { ...DEFAULT_SETUP };
}

function saveSetup(s) {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(s)); } catch (_) { /* no storage */ }
}

const STYLE = `
  :host {
    --oven-rgb: 242, 107, 29;
    --tone-rgb: var(--rgb-disabled-color, 158, 158, 158);
    --fill: rgba(var(--rgb-primary-text-color, 33, 33, 33), .05);
  }
  ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  ha-card.active { --tone-rgb: var(--oven-rgb); }
  ha-card.error { --tone-rgb: var(--rgb-error-color, 219, 68, 55); }
  .row { display: flex; align-items: center; gap: 8px; }
  .muted { color: var(--secondary-text-color); }
  button { font: inherit; border: none; cursor: pointer; color: inherit; background: none; }
  button:disabled { opacity: .4; cursor: default; }

  /* Header */
  .shape { flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    background: rgba(var(--tone-rgb), .2); color: rgb(var(--tone-rgb)); }
  .shape ha-icon { --mdc-icon-size: 22px; }
  .info { flex: 1; min-width: 0; }
  .primary { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--primary-text-color); }
  .secondary { font-size: 12px; line-height: 16px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status-icon { flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
    color: var(--secondary-text-color); }
  .status-icon ha-icon { --mdc-icon-size: 20px; }
  .status-icon.door-open { color: var(--warning-color, #e69500); }
  .lamp { background: var(--fill); }
  .lamp.on { color: rgb(var(--rgb-amber-color, 255, 193, 7)); background: rgba(var(--rgb-amber-color, 255, 193, 7), .2); }
  .lamp.pending { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.9); } }

  /* Chips and presets */
  .chips { flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border-radius: 13px;
    font-size: 12px; font-weight: 500; background: var(--fill); color: var(--primary-text-color); }
  .chip ha-icon { --mdc-icon-size: 16px; }
  .chip.error { background: rgba(var(--rgb-error-color, 219, 68, 55), .15); color: var(--error-color, #db4437); }
  .chip.warning { background: rgba(var(--rgb-warning-color, 255, 166, 0), .18); color: var(--warning-color, #e69500); }
  .presets { overflow-x: auto; scrollbar-width: none; }
  .presets::-webkit-scrollbar { display: none; }
  .pill { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px;
    font-size: 13px; font-weight: 500; background: var(--fill); color: var(--primary-text-color); }
  .pill ha-icon { --mdc-icon-size: 18px; color: rgb(var(--oven-rgb)); }

  /* Dial */
  .dial-wrap { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .dial { position: relative; width: 180px; height: 180px; touch-action: none; }
  .dial svg { width: 100%; height: 100%; cursor: pointer; }
  .dial-track { fill: none; stroke: var(--fill); stroke: rgba(var(--rgb-primary-text-color, 33, 33, 33), .08); stroke-width: 14; stroke-linecap: round; }
  .dial-fill { fill: none; stroke: rgb(var(--oven-rgb)); stroke-width: 14; stroke-linecap: round; }
  .dial-knob { fill: var(--card-background-color, #fff); stroke: rgb(var(--oven-rgb)); stroke-width: 4; }
  .dial-now { fill: var(--secondary-text-color); }
  .dial-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; pointer-events: none; }
  .dial-value { font-size: 44px; font-weight: 400; line-height: 1; color: var(--primary-text-color); }
  .dial-sub { margin-top: 6px; font-size: 12px; color: var(--secondary-text-color); }
  .round { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--fill);
    color: var(--primary-text-color); }
  .round.small { width: 32px; height: 32px; }
  .round ha-icon { --mdc-icon-size: 20px; }

  /* Mode */
  .segmented { display: flex; padding: 3px; border-radius: 12px; background: var(--fill); }
  .segmented button { flex: 1; height: 36px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px; font-weight: 500; color: var(--secondary-text-color); }
  .segmented button ha-icon { --mdc-icon-size: 18px; }
  .segmented button.on { background: var(--card-background-color, #fff); color: rgb(var(--oven-rgb));
    box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }

  /* Elements, steam, timer */
  .controls { display: flex; flex-direction: column; gap: 12px; }
  .control { display: flex; flex-direction: column; gap: 6px; }
  .label { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); }
  .label b { color: var(--primary-text-color); font-weight: 600; }
  .element-row { display: flex; gap: 8px; }
  .element { flex: 1; height: 52px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; font-size: 11px; font-weight: 500; background: var(--fill); color: var(--secondary-text-color); }
  .element ha-icon { --mdc-icon-size: 20px; }
  .element.on { background: rgba(var(--oven-rgb), .18); color: rgb(var(--oven-rgb)); }
  input[type=range] { width: 100%; accent-color: rgb(var(--oven-rgb)); }
  .stepper { display: flex; align-items: center; gap: 12px; }
  .stepper .value { min-width: 56px; text-align: center; font-size: 16px; font-weight: 500; font-variant-numeric: tabular-nums;
    color: var(--primary-text-color); }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--secondary-text-color); }
  .check input { accent-color: rgb(var(--oven-rgb)); }

  /* Cooking */
  .progress { display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 6px; border-radius: 3px; background: rgba(var(--tone-rgb), .2); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; background: rgb(var(--tone-rgb)); transition: width 1s linear; }
  .bar-label { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--secondary-text-color); }
  .bar-label .stage { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-label .time { flex: none; font-weight: 600; color: rgb(var(--tone-rgb)); }
  .cook-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 12px; background: var(--fill); }
  .tile .stepper { gap: 6px; }
  .value.big { font-size: 20px; font-weight: 600; min-width: 0; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
  .tile .sub { font-size: 11px; color: var(--secondary-text-color); }

  /* Buttons */
  .buttons { gap: 8px; }
  .btn { flex: 1; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px; font-weight: 500; background: var(--fill); color: var(--primary-text-color); }
  .btn ha-icon { --mdc-icon-size: 20px; }
  .btn.primary { width: 100%; background: rgb(var(--oven-rgb)); color: #fff; }
  .btn.primary span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn.stop { background: rgba(var(--rgb-error-color, 219, 68, 55), .12); color: var(--error-color, #db4437); }
  .btn.stop.armed { background: var(--error-color, #db4437); color: #fff; }

  @media (max-width: 380px) { .cook-grid { grid-template-columns: 1fr 1fr; } }
`;

customElements.define("anova-oven-card", AnovaOvenCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "anova-oven-card",
  name: "Anova Oven",
  description: "Set up and run the Anova Precision Oven like its handle: dial, elements, sous vide, steam, timer.",
  preview: true,
});
console.info(`%c anova-oven-card ${CARD_VERSION} `, "background:#F26B1D;color:#fff;border-radius:4px");
