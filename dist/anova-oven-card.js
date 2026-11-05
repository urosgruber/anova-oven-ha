/*
 * anova-oven-card: a Home Assistant dashboard card for the Anova Precision
 * Oven, run locally by anova-oven-server (ha-app/). It reads the MQTT
 * entities the server creates (all named <prefix>_*, default "anova_oven").
 *
 * The card is laid out like the oven's handle: heating mode (four icons),
 * temperature (tap the thermometer for sous vide), timer and steam, each
 * with - and +, then Start. While a cook runs, the same strip shows the
 * live values, and - and + change the running cook.
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

// The handle's four heating modes and the elements each one uses.
const MODES = [
  { key: "top", label: "Top", elements: ["top"] },
  { key: "top_bottom", label: "Top and bottom", elements: ["top", "bottom"] },
  { key: "bottom", label: "Bottom", elements: ["bottom"] },
  { key: "rear", label: "Rear (fan)", elements: ["rear"] },
];
const LIMITS = { dry: [25, 250], wet: [25, 100] };
const DEFAULT_SETUP = { mode: "top_bottom", bulb: "dry", temp: 180, timer: 0, steam: 0 };

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
    if (this._lampPending) {
      const lamp = this._on("light", "lamp");
      if (lamp === this._lampPending.on || Date.now() > this._lampPending.until) this._lampPending = null;
    }
    // A re-render during a held - or + would drop the hold.
    if (!this._holding) this._render();
  }

  getCardSize() {
    return 4;
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

  _start() {
    const s = this._setup;
    const wet = s.bulb === "wet";
    const elements = MODES.find((m) => m.key === s.mode).elements;
    const base = {
      temperature_c: s.temp,
      temperature_bulbs_mode: s.bulb,
      steam_pct: wet ? 100 : s.steam,
      fan_speed: 100,
      heating_element_top: elements.includes("top"),
      heating_element_rear: elements.includes("rear"),
      heating_element_bottom: elements.includes("bottom"),
    };
    const cook = { ...base, kind: "cook" };
    if (s.timer > 0) Object.assign(cook, { timer_added: true, duration_secs: s.timer * 60 });
    // Like the handle: with a timer, the oven preheats first and the timer
    // starts at temperature.
    const stages = s.timer > 0 ? [{ ...base, kind: "preheat" }, cook] : [cook];
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
    setTimeout(() => {
      if (this._lampPending && Date.now() > this._lampPending.until) {
        this._lampPending = null;
        this._render();
      }
    }, LAMP_CONFIRM_MS + 100);
  }

  _update(change) {
    const s = { ...this._setup, ...change };
    const [lo, hi] = LIMITS[s.bulb];
    s.temp = clamp(Math.round(s.temp * 2) / 2, lo, hi);
    if (s.bulb === "dry") s.temp = Math.round(s.temp);
    s.timer = clamp(s.timer, 0, 24 * 60);
    s.steam = s.bulb === "wet" ? 100 : clamp(s.steam, 0, 100);
    this._setup = s;
    saveSetup(s);
    // While - or + is held, only the numbers change: a full render would
    // replace the held button.
    if (this._holding) this._renderValues();
    else this._render();
  }

  _renderValues() {
    const s = this._setup;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if ($("temp-value")) $("temp-value").textContent = fmtTemp(s.temp);
    if ($("timer-value")) $("timer-value").textContent = s.timer ? clock(s.timer * 60) : "OFF";
    if ($("steam-value")) $("steam-value").textContent = s.bulb === "wet" ? "100%" : s.steam ? `${s.steam}%` : "OFF";
  }

  // One step of a - or + button. `dir` is -1 or 1.
  _step(what, dir, m) {
    const s = this._setup;
    if (m.cooking) {
      if (what === "temp" && m.target !== null) {
        this._call("number", "set_value", { entity_id: this._id("number", "set_temperature"),
          value: clamp(Math.round(m.target) + dir * 5, 25, 250) });
      } else if (what === "timer") {
        const total = Math.round((m.timerTotal || 0) / 60);
        this._call("number", "set_value", { entity_id: this._id("number", "set_timer"),
          value: clamp(total + dir * 5, 1, 1440) });
      }
      return;
    }
    if (what === "temp") this._update({ temp: s.temp + dir * (s.bulb === "wet" ? 0.5 : 5) });
    if (what === "timer") this._update({ timer: s.timer + dir * timerStep(s.timer, dir) });
    if (what === "steam") this._update({ steam: s.steam + dir * 10 });
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
      wetTemp: this._number("sensor", "wet_bulb_temperature"),
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
    const s = this._setup;
    const tone = !m.connected ? "error" : m.cooking ? "active" : "idle";
    const armed = Date.now() < this._stopArmedUntil;
    const live = m.cooking;
    const lampShown = this._lampPending ? this._lampPending.on : m.lamp;

    const chips = [];
    if (!m.connected) chips.push(chip("mdi:wifi-off", "Offline", "error"));
    if (m.waterEmpty) chips.push(chip("mdi:water-off", "Water tank empty", "error"));
    if (m.descale) chips.push(chip("mdi:water-alert", "Descale", "warning"));
    if (m.cooking && m.door) chips.push(chip("mdi:door-open", "Door open", "warning"));
    if (m.probe !== null) chips.push(chip("mdi:thermometer-probe", `Probe ${Math.round(m.probe)} °C`));

    const tempValue = live
      ? `${m.temp === null ? "—" : Math.round(m.temp)}°`
      : fmtTemp(s.temp);
    const tempSub = live
      ? (m.target === null ? "" : `→ ${Math.round(m.target)}°`)
      : (s.bulb === "wet" ? "sous vide" : "");
    const timerValue = live ? (m.done ? "0:00" : timeLeft(m) ?? "OFF") : (s.timer ? clock(s.timer * 60) : "OFF");
    const steamValue = live
      ? (m.steam === null ? "—" : `${Math.round(m.steam)}%`)
      : (s.bulb === "wet" ? "100%" : s.steam ? `${s.steam}%` : "OFF");

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="${tone}">
        <div class="row header">
          <div class="shape"><ha-icon icon="${m.cooking ? "mdi:stove" : "mdi:toaster-oven"}"></ha-icon></div>
          <div class="info">
            <div class="primary">${esc(this._config.title || "Oven")}</div>
            <div class="secondary" id="secondary">${secondary(m)}</div>
          </div>
          <div class="status-icon ${m.door ? "warn" : ""}" title="${m.door ? "Door open" : "Door closed"}">
            <ha-icon icon="${m.door ? "mdi:door-open" : "mdi:door-closed"}"></ha-icon>
          </div>
          <button class="status-icon lamp ${lampShown ? "on" : ""} ${this._lampPending ? "pending" : ""}" id="lamp"
            title="${this._lampPending ? "Switching…" : m.lamp ? "Light on" : "Light off"}" ${m.connected ? "" : "disabled"}>
            <ha-icon icon="${lampShown ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}"></ha-icon>
          </button>
        </div>

        ${chips.length ? `<div class="row chips">${chips.join("")}</div>` : ""}
        ${!live && m.presets.length ? `<div class="row presets">${m.presets.map((p, i) => `
          <button class="pill preset" data-i="${i}" ${m.connected ? "" : "disabled"}>
            <ha-icon icon="${esc(p.icon || "mdi:chef-hat")}"></ha-icon>${esc(p.name)}</button>`).join("")}</div>` : ""}

        <div class="strip ${live ? "live" : ""}">
          <div class="modes" role="radiogroup" aria-label="Heating mode">
            ${MODES.map((md) => `
              <button class="mode ${!live && s.mode === md.key ? "on" : ""}" data-mode="${md.key}"
                title="${md.label}" aria-label="${md.label}" ${live ? "disabled" : ""}>${modeIcon(md.key)}</button>`).join("")}
          </div>

          ${segment("temp", s.bulb === "wet" ? "mdi:water-thermometer" : "mdi:thermometer", tempValue, tempSub,
            { iconButton: !live, iconTitle: s.bulb === "wet" ? "Sous vide: tap for bake" : "Bake: tap for sous vide",
              iconOn: !live && s.bulb === "wet" })}
          ${segment("timer", "mdi:timer-outline", timerValue, live && m.timerTotal ? `of ${clock(m.timerTotal)}` : "")}
          ${segment("steam", "mdi:water-percent", steamValue, "", { noButtons: live || s.bulb === "wet" })}

          <div class="go">
            ${live
              ? `<button class="go-btn stop ${armed ? "armed" : ""}" id="stop" title="Stop">
                   <ha-icon icon="mdi:stop"></ha-icon><span>${armed ? "Again" : "Stop"}</span></button>`
              : `<button class="go-btn start" id="start" title="Start" ${m.connected ? "" : "disabled"}>
                   <ha-icon icon="mdi:play"></ha-icon><span>Start</span></button>`}
          </div>
        </div>

        ${live ? `
          <div class="progress">
            <div class="bar"><div class="bar-fill" id="bar" style="width:${pct(progress(m))}"></div></div>
            <div class="bar-label" id="bar-label">${barLabel(m)}</div>
          </div>
          ${m.nextReady ? `<button class="btn" id="next"><ha-icon icon="mdi:skip-next"></ha-icon>Next stage</button>` : ""}
        ` : ""}
      </ha-card>`;
    this._bind(m);
  }

  _bind(m) {
    const root = this.shadowRoot;
    const $ = (id) => root.getElementById(id);
    if ($("lamp")) $("lamp").onclick = () => this._toggleLamp();
    if ($("stop")) $("stop").onclick = () => this._stop();
    if ($("start")) $("start").onclick = () => this._start();
    if ($("next")) $("next").onclick = () => this._call("button", "press", { entity_id: this._id("button", "next_stage") });
    if ($("temp-icon")) $("temp-icon").onclick = () => this._update({ bulb: this._setup.bulb === "wet" ? "dry" : "wet" });
    root.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => this._update({ mode: b.dataset.mode }); });
    root.querySelectorAll(".preset").forEach((b) => { b.onclick = () => this._startRecipe(m.presets[Number(b.dataset.i)].recipe); });
    // - and +: a tap is one step; holding repeats in the setup (not on a
    // running cook, where each step is a command to the oven).
    root.querySelectorAll("[data-step]").forEach((b) => {
      const [what, dir] = b.dataset.step.split(":");
      const step = () => this._step(what, Number(dir), this._model());
      b.onpointerdown = (ev) => {
        ev.preventDefault();
        if (m.cooking) { step(); return; }
        this._holding = true;
        step();
        this._hold = setTimeout(() => { this._repeat = setInterval(step, 120); }, 450);
        const end = () => {
          if (!this._holding) return;
          clearTimeout(this._hold);
          clearInterval(this._repeat);
          this._holding = false;
          this._render();
        };
        window.addEventListener("pointerup", end, { once: true });
        window.addEventListener("pointercancel", end, { once: true });
      };
    });
  }

  _renderLive() {
    if (!this.shadowRoot || !this._hass || this._holding) return;
    const m = this._model();
    const $ = (id) => this.shadowRoot.getElementById(id);
    if ($("secondary")) $("secondary").innerHTML = secondary(m);
    if (m.cooking) {
      if ($("bar")) $("bar").style.width = pct(progress(m));
      if ($("bar-label")) $("bar-label").innerHTML = barLabel(m);
      if ($("timer-value")) $("timer-value").textContent = m.done ? "0:00" : timeLeft(m) ?? "OFF";
    }
  }
}

// --- Pieces -----------------------------------------------------------------

function segment(what, icon, value, sub, opts = {}) {
  const iconEl = opts.iconButton
    ? `<button class="seg-icon ${opts.iconOn ? "on" : ""}" id="${what}-icon" title="${esc(opts.iconTitle || "")}"><ha-icon icon="${icon}"></ha-icon></button>`
    : `<span class="seg-icon"><ha-icon icon="${icon}"></ha-icon></span>`;
  return `
    <div class="seg seg-${what}">
      <div class="seg-top">${iconEl}<span class="seg-value" id="${what}-value">${esc(value)}</span></div>
      <div class="seg-sub">${esc(sub) || "&nbsp;"}</div>
      <div class="seg-buttons">
        ${opts.noButtons ? "" : `
          <button class="pm" data-step="${what}:-1" aria-label="Less"><ha-icon icon="mdi:minus"></ha-icon></button>
          <button class="pm" data-step="${what}:1" aria-label="More"><ha-icon icon="mdi:plus"></ha-icon></button>`}
      </div>
    </div>`;
}

// The handle's mode icons: a square with the heated side drawn bold, and a
// fan for the rear element.
function modeIcon(key) {
  const box = `<rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55"/>`;
  const top = `<rect x="4" y="4" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const bottom = `<rect x="4" y="16.8" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const fan = `<circle cx="12" cy="12" r="5.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M12 12 L12 7.6 M12 12 L15.8 14.2 M12 12 L8.2 14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  const inner = { top: top, bottom: bottom, top_bottom: top + bottom, rear: fan }[key];
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${box}${inner}</svg>`;
}

function setupTitle(s) {
  const mode = MODES.find((m) => m.key === s.mode).label;
  return s.bulb === "wet" ? `Sous vide ${fmtTemp(s.temp)}` : `${mode} ${fmtTemp(s.temp)}${s.steam ? ` · ${s.steam}% steam` : ""}`;
}

function fmtTemp(v) {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}°`;
}

function timerStep(minutes, dir) {
  // 1-minute steps up to 10, then 5 up to 60, then 15, like a kitchen timer.
  const at = dir < 0 ? minutes - 1 : minutes;
  return at < 10 ? 1 : at < 60 ? 5 : 15;
}

function remaining(m) {
  return m.endsAt ? Math.max(0, Math.round((m.endsAt - Date.now()) / 1000)) : null;
}

function timeLeft(m) {
  const left = remaining(m);
  return left === null ? null : clock(left);
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
  return esc(m.recipe ? `${m.recipe} · ${what}` : what);
}

function barLabel(m) {
  const stage = [m.stage && `Stage ${m.stage}`, m.stageDescription].filter(Boolean).join(" · ");
  const right = m.done ? "Done" : m.phase === "Preheating" ? "Preheating" : "";
  return `<span class="stage">${esc(stage)}</span><span class="time">${right}</span>`;
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
    if (saved && typeof saved === "object" && MODES.some((m) => m.key === saved.mode)) {
      return { ...DEFAULT_SETUP, ...saved };
    }
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
  ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; container-type: inline-size; }
  ha-card.active { --tone-rgb: var(--oven-rgb); }
  ha-card.error { --tone-rgb: var(--rgb-error-color, 219, 68, 55); }
  .row { display: flex; align-items: center; gap: 8px; }
  .muted { color: var(--secondary-text-color); }
  button { font: inherit; border: none; cursor: pointer; color: inherit; background: none; padding: 0;
    -webkit-tap-highlight-color: transparent; }
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
  .status-icon.warn { color: var(--warning-color, #e69500); }
  .lamp { background: var(--fill); }
  .lamp.on { color: rgb(var(--rgb-amber-color, 255, 193, 7)); background: rgba(var(--rgb-amber-color, 255, 193, 7), .2); }
  .lamp.pending { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.88); } }

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

  /* The strip: modes, temperature, timer, steam, start - like the handle. */
  .strip { display: grid; grid-template-columns: auto 1.3fr 1fr 1fr auto; grid-template-areas: "modes temp timer steam go";
    align-items: stretch; gap: 8px; }
  .modes { grid-area: modes; } .seg-temp { grid-area: temp; } .seg-timer { grid-area: timer; }
  .seg-steam { grid-area: steam; } .go { grid-area: go; }
  .modes { display: grid; grid-template-columns: 34px 34px; grid-template-rows: 34px 34px; gap: 4px; align-self: center; }
  .mode { border-radius: 9px; display: grid; place-items: center; background: var(--fill); color: var(--secondary-text-color); }
  .mode.on { background: rgba(var(--oven-rgb), .18); color: rgb(var(--oven-rgb)); }
  .strip.live .mode { opacity: .35; }

  .seg { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    padding: 8px 4px 6px; border-radius: 12px; background: var(--fill); min-width: 0; }
  .seg-top { display: flex; align-items: center; gap: 4px; }
  .seg-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--secondary-text-color); }
  .seg-icon ha-icon { --mdc-icon-size: 18px; }
  button.seg-icon { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .06); }
  .seg-icon.on { background: rgba(var(--oven-rgb), .18); color: rgb(var(--oven-rgb)); }
  .seg-value { font-size: 22px; font-weight: 500; line-height: 28px; color: var(--primary-text-color);
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .strip.live .seg-value { color: rgb(var(--tone-rgb)); }
  .seg-sub { font-size: 11px; line-height: 14px; color: var(--secondary-text-color); white-space: nowrap; }
  .seg-buttons { display: flex; gap: 6px; min-height: 30px; }
  .pm { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; touch-action: none; user-select: none;
    background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .07); color: var(--primary-text-color); }
  .pm:active { background: rgba(var(--oven-rgb), .25); }
  .pm ha-icon { --mdc-icon-size: 18px; }

  .go { display: flex; align-items: stretch; }
  .go-btn { width: 64px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; font-size: 12px; font-weight: 600; }
  .go-btn ha-icon { --mdc-icon-size: 26px; }
  .go-btn.start { background: rgb(var(--oven-rgb)); color: #fff; }
  .go-btn.stop { background: rgba(var(--rgb-error-color, 219, 68, 55), .14); color: var(--error-color, #db4437); }
  .go-btn.stop.armed { background: var(--error-color, #db4437); color: #fff; }

  /* Narrow cards: modes and temperature on the first line. */
  @container (max-width: 470px) {
    .strip { grid-template-columns: 1fr 1fr 64px; grid-template-areas: "modes temp temp" "timer steam go"; }
    .modes { justify-self: center; }
  }

  /* Cooking */
  .progress { display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 6px; border-radius: 3px; background: rgba(var(--tone-rgb), .2); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; background: rgb(var(--tone-rgb)); transition: width 1s linear; }
  .bar-label { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--secondary-text-color); }
  .bar-label .stage { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-label .time { flex: none; font-weight: 600; color: rgb(var(--tone-rgb)); }
  .btn { height: 40px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px; font-weight: 500; background: var(--fill); color: var(--primary-text-color); }
  .btn ha-icon { --mdc-icon-size: 20px; }
`;

customElements.define("anova-oven-card", AnovaOvenCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "anova-oven-card",
  name: "Anova Oven",
  description: "Run the Anova Precision Oven like its handle: heating mode, temperature, sous vide, timer, steam.",
  preview: true,
});
console.info(`%c anova-oven-card ${CARD_VERSION} `, "background:#F26B1D;color:#fff;border-radius:4px");
