/*
 * anova-oven-card: a Home Assistant dashboard card for the Anova Precision
 * Oven, run locally by anova-oven-server (ha-app/). It reads the MQTT
 * entities the server creates (all named <prefix>_*, default "anova_oven").
 *
 * Layout: a tile-card header, then five rows in the style of HA's tile
 * features (42 px high, 12 px radius, 12 px gaps):
 *   1. heating elements: any one or two (six choices; while cooking: progress)
 *   2. temperature: a slider with - and +, and the sous vide toggle
 *   3. how the cook ends: until you stop, timer or probe, with its value
 *   4. steam, and the preheat toggle
 *   5. Start (while cooking: Stop, and Next stage when a stage waits)
 * The same rows show in every state, so the card never changes size.
 *
 *   type: custom:anova-oven-card
 *   title: Oven                 # optional
 *   prefix: anova_oven          # optional, the entity ID prefix
 *   mqtt_prefix: anova/oven     # optional, the server's MQTT topic prefix
 *
 * The HA app installs this file and registers it as a dashboard resource.
 * Start publishes {"stages": [...]} to <mqtt_prefix>/cmd/start with the
 * mqtt.publish service. No external libraries.
 */

const CARD_VERSION = "0.5.0";
const STOP_CONFIRM_MS = 3000;
const LAMP_CONFIRM_MS = 15000;
const SETUP_KEY = "anova-oven-card:setup";

// The oven runs any one or two of its three elements.
const MODES = [
  { key: "top", label: "Top", elements: ["top"] },
  { key: "top_bottom", label: "Top and bottom", elements: ["top", "bottom"] },
  { key: "bottom", label: "Bottom", elements: ["bottom"] },
  { key: "rear", label: "Rear (fan)", elements: ["rear"] },
  { key: "rear_top", label: "Rear and top", elements: ["rear", "top"] },
  { key: "rear_bottom", label: "Rear and bottom", elements: ["rear", "bottom"] },
];
const ENDS = [
  { key: "none", label: "Until you stop", icon: "mdi:all-inclusive" },
  { key: "timer", label: "Timer", icon: "mdi:timer-outline" },
  { key: "probe", label: "Probe", icon: "mdi:thermometer-probe" },
];
const LIMITS = { dry: [25, 250], wet: [25, 100], probe: [1, 100] };
const DEFAULT_SETUP = {
  mode: "top_bottom", sousVide: false, temp: 180, steam: 0,
  end: "none", timer: 30, probe: 55, preheat: true,
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
    if (this._lampPending) {
      const lamp = this._on("light", "lamp");
      if (lamp === this._lampPending.on || Date.now() > this._lampPending.until) this._lampPending = null;
    }
    // A re-render during a drag or a held button would replace that element.
    if (!this._holding) this._render();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 6, min_columns: 6, rows: 6, min_rows: 6 };
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
    const elements = MODES.find((m) => m.key === s.mode).elements;
    const base = {
      temperature_c: s.temp,
      temperature_bulbs_mode: s.sousVide ? "wet" : "dry",
      steam_pct: s.sousVide ? 100 : s.steam,
      fan_speed: 100,
      heating_element_top: elements.includes("top"),
      heating_element_rear: elements.includes("rear"),
      heating_element_bottom: elements.includes("bottom"),
    };
    const cook = { ...base, kind: "cook" };
    if (s.end === "timer") Object.assign(cook, { timer_added: true, duration_secs: s.timer * 60 });
    if (s.end === "probe") Object.assign(cook, { probe_added: true, probe_target_c: s.probe });
    // A preheat ends at temperature; the cook stage then starts by itself.
    const stages = s.preheat
      ? [{ ...base, kind: "preheat" }, { ...cook, user_action_required: false }]
      : [cook];
    this._call("mqtt", "publish", {
      topic: `${this._config.mqtt_prefix}/cmd/start`,
      payload: JSON.stringify({ title: setupTitle(s), stages }),
    });
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

  _setTarget(value) {
    this._call("number", "set_value", { entity_id: this._id("number", "set_temperature"),
      value: clamp(Math.round(value), 25, 250) });
  }

  _update(change) {
    const s = { ...this._setup, ...change };
    const [lo, hi] = LIMITS[s.sousVide ? "wet" : "dry"];
    s.temp = clamp(s.sousVide ? Math.round(s.temp * 2) / 2 : Math.round(s.temp), lo, hi);
    s.timer = clamp(s.timer, 1, 24 * 60);
    s.probe = clamp(Math.round(s.probe), ...LIMITS.probe);
    s.steam = clamp(s.steam, 0, 100);
    this._setup = s;
    saveSetup(s);
    // While a button is held, only the numbers change.
    if (this._holding) this._renderValues();
    else this._render();
  }

  // One step of a - or + button. `dir` is -1 or 1.
  _step(what, dir, m) {
    const s = this._setup;
    if (m.cooking) {
      // On a running cook, each step is one command to the oven.
      if (what === "temp" && m.target !== null) this._setTarget(m.target + dir * 5);
      if (what === "end" && m.timerTotal) {
        this._call("number", "set_value", { entity_id: this._id("number", "set_timer"),
          value: clamp(Math.round(m.timerTotal / 60) + dir * 5, 1, 1440) });
      }
      return;
    }
    if (what === "temp") this._update({ temp: s.temp + dir * (s.sousVide ? 0.5 : 5) });
    if (what === "end" && s.end === "timer") this._update({ timer: s.timer + dir * timerStep(s.timer, dir) });
    if (what === "end" && s.end === "probe") this._update({ probe: s.probe + dir });
    if (what === "steam") this._update({ steam: s.steam + dir * 10 });
  }

  // --- View model ---------------------------------------------------------

  _model() {
    const connected = this._on("binary_sensor", "connected");
    const cooking = connected && this._on("binary_sensor", "cooking");
    const lastEvent = (this._state("event", "cook") || {}).attributes?.event_type;
    const endsAt = this._value("sensor", "stage_ends_at");
    const timerMin = this._number("number", "set_timer");
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
    };
  }

  // --- Rendering ----------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="secondary">Loading…</div></ha-card>`;
      return;
    }
    const m = this._model();
    const s = this._setup;
    const live = m.cooking;
    const off = !m.connected;
    const tone = off ? "error" : live ? "active" : "idle";
    const armed = Date.now() < this._stopArmedUntil;
    const lampShown = this._lampPending ? this._lampPending.on : m.lamp;
    const warning = warningText(m);

    // Temperature: the setup's value, or the running cook's target.
    const [tlo, thi] = live ? LIMITS.dry : LIMITS[s.sousVide ? "wet" : "dry"];
    const tValue = live ? m.target : s.temp;
    const tDisabled = off || (live && m.target === null);

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="${tone}">
        <div class="header">
          <div class="shape"><ha-icon icon="${live ? "mdi:stove" : "mdi:toaster-oven"}"></ha-icon></div>
          <div class="info">
            <div class="primary">${esc(this._config.title || "Oven")}</div>
            <div class="secondary ${warning ? "warn" : ""}" id="secondary">${warning ? esc(warning) : secondary(m)}</div>
          </div>
          <div class="icon-state ${m.door ? "warn" : ""}" title="${m.door ? "Door open" : "Door closed"}">
            <ha-icon icon="${m.door ? "mdi:door-open" : "mdi:door-closed"}"></ha-icon>
          </div>
          <button class="icon-state lamp ${lampShown ? "on" : ""} ${this._lampPending ? "pending" : ""}" id="lamp"
            title="${this._lampPending ? "Switching…" : lampShown ? "Light on" : "Light off"}" ${off ? "disabled" : ""}>
            <ha-icon icon="${lampShown ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}"></ha-icon>
          </button>
        </div>

        <div class="features">
          ${live ? `
            <div class="feature progress" title="${esc(m.stageDescription || "")}">
              <div class="progress-fill" id="bar" style="width:${pct(progress(m))}"></div>
              <span class="progress-text" id="bar-label">${barLabel(m)}</span>
            </div>` : select("mode", MODES.map((md) => ({ key: md.key, label: md.label, html: modeIcon(md.key) })), s.mode, off)}

          <div class="pair wide">
            ${slider("temp", tValue === null ? 0 : (tValue - tlo) / (thi - tlo),
              tValue === null ? "—" : fmtTemp(tValue, " °C"), tDisabled)}
            <button class="feature toggle ${!live && s.sousVide ? "on" : ""}" id="sous-vide"
              title="Sous vide ${s.sousVide ? "on" : "off"}" aria-pressed="${s.sousVide}" ${off || live ? "disabled" : ""}>
              <ha-icon icon="mdi:water-thermometer"></ha-icon>
            </button>
          </div>

          <div class="pair end">
            ${select("end", ENDS.map((e) => ({ key: e.key, label: e.label, html: `<ha-icon icon="${e.icon}"></ha-icon>` })),
              live ? (m.timerTotal ? "timer" : m.probe !== null ? "probe" : "none") : s.end, off || live)}
            ${stepper("end", endValue(m, s), endDisabled(m, s, off))}
          </div>

          <div class="pair wide">
            ${stepper("steam", live ? (m.steam === null ? "—" : `${Math.round(m.steam)} % steam`)
              : (s.sousVide ? "100 % steam" : s.steam ? `${s.steam} % steam` : "No steam"),
              off || live || s.sousVide, "mdi:water-percent")}
            <button class="feature toggle ${!live && s.preheat ? "on preheat" : ""}" id="preheat"
              title="Preheat first: ${s.preheat ? "on" : "off"}" aria-pressed="${s.preheat}" ${off || live ? "disabled" : ""}>
              <ha-icon icon="mdi:thermometer-chevron-up"></ha-icon>
            </button>
          </div>

          <div class="pair">
            ${live && m.nextReady ? `<button class="feature action" id="next"><ha-icon icon="mdi:skip-next"></ha-icon>Next stage</button>` : ""}
            ${live
              ? `<button class="feature action stop ${armed ? "armed" : ""}" id="stop">
                   <ha-icon icon="mdi:stop"></ha-icon>${armed ? "Tap again to stop" : "Stop"}</button>`
              : `<button class="feature action start" id="start" ${off ? "disabled" : ""}>
                   <ha-icon icon="mdi:play"></ha-icon>Start</button>`}
          </div>
        </div>
      </ha-card>`;
    this._bind(m, { lo: tlo, hi: thi, disabled: tDisabled });
  }

  _bind(m, temp) {
    const root = this.shadowRoot;
    const $ = (id) => root.getElementById(id);
    if ($("lamp")) $("lamp").onclick = () => this._toggleLamp();
    if ($("stop")) $("stop").onclick = () => this._stop();
    if ($("start")) $("start").onclick = () => this._start();
    if ($("next")) $("next").onclick = () => this._call("button", "press", { entity_id: this._id("button", "next_stage") });
    if ($("sous-vide")) $("sous-vide").onclick = () => this._update({ sousVide: !this._setup.sousVide });
    if ($("preheat")) $("preheat").onclick = () => this._update({ preheat: !this._setup.preheat });
    root.querySelectorAll("[data-select]").forEach((b) => {
      b.onclick = () => this._update({ [b.dataset.select]: b.dataset.key });
    });

    // - and +: a tap is one step. Holding repeats in the setup, but not on a
    // running cook, where each step is a command to the oven.
    root.querySelectorAll("[data-step]").forEach((b) => {
      const [what, dir] = b.dataset.step.split(":");
      const step = () => this._step(what, Number(dir), this._model());
      b.onpointerdown = (ev) => {
        ev.preventDefault();
        if (b.disabled) return;
        if (m.cooking) { step(); return; }
        this._holding = true;
        step();
        this._hold = setTimeout(() => { this._repeat = setInterval(step, 110); }, 450);
        this._endHold(() => { clearTimeout(this._hold); clearInterval(this._repeat); });
      };
    });

    // The temperature slider: drag for big changes; it commits on release.
    const track = $("temp-track");
    if (track && !temp.disabled) {
      const step = m.cooking ? 1 : this._setup.sousVide ? 0.5 : 1;
      const valueAt = (ev) => {
        const r = track.getBoundingClientRect();
        const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
        return clamp(Math.round((temp.lo + f * (temp.hi - temp.lo)) / step) * step, temp.lo, temp.hi);
      };
      const show = (v) => {
        $("temp-fill").style.width = pct((v - temp.lo) / (temp.hi - temp.lo));
        $("temp-value").textContent = fmtTemp(v, " °C");
      };
      track.onpointerdown = (ev) => {
        ev.preventDefault();
        track.setPointerCapture(ev.pointerId);
        this._holding = true;
        let value = valueAt(ev);
        show(value);
        track.onpointermove = (e) => { value = valueAt(e); show(value); };
        this._endHold(() => {
          track.onpointermove = null;
          if (m.cooking) this._setTarget(value);
          else this._setup = { ...this._setup, temp: value };
          saveSetup(this._setup);
        });
      };
    }
  }

  // Run `cleanup`, then re-render, when the pointer is released anywhere.
  _endHold(cleanup) {
    const end = () => {
      if (!this._holding) return;
      cleanup();
      this._holding = false;
      this._render();
    };
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }

  _renderValues() {
    const s = this._setup;
    const m = this._model();
    const set = (id, text) => { const el = this.shadowRoot.getElementById(id); if (el) el.textContent = text; };
    const [lo, hi] = LIMITS[s.sousVide ? "wet" : "dry"];
    set("temp-value", fmtTemp(s.temp, " °C"));
    const fill = this.shadowRoot.getElementById("temp-fill");
    if (fill) fill.style.width = pct((s.temp - lo) / (hi - lo));
    set("end-value", endValue(m, s));
    set("steam-value", s.sousVide ? "100 % steam" : s.steam ? `${s.steam} % steam` : "No steam");
  }

  _renderLive() {
    if (!this.shadowRoot || !this._hass || this._holding) return;
    const m = this._model();
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!warningText(m) && $("secondary")) $("secondary").innerHTML = secondary(m);
    if (m.cooking) {
      if ($("bar")) $("bar").style.width = pct(progress(m));
      if ($("bar-label")) $("bar-label").innerHTML = barLabel(m);
      if ($("end-value")) $("end-value").textContent = endValue(m, this._setup);
    }
  }
}

// --- Pieces -----------------------------------------------------------------

// HA's select feature: one rounded row of options.
function select(name, options, current, disabled) {
  return `
    <div class="feature select" role="radiogroup">
      ${options.map((o) => `
        <button class="option ${current === o.key ? "on" : ""}" data-select="${name}" data-key="${o.key}" role="radio"
          aria-checked="${current === o.key}" title="${o.label}" aria-label="${o.label}" ${disabled ? "disabled" : ""}>${o.html}</button>`).join("")}
    </div>`;
}

// HA's number-buttons feature: [ -   value   + ] in one 42 px row.
function stepper(what, value, disabled, icon) {
  return `
    <div class="feature stepper ${disabled ? "disabled" : ""}">
      <button class="pm" data-step="${what}:-1" aria-label="Less" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:minus"></ha-icon></button>
      <span class="value">${icon ? `<ha-icon icon="${icon}"></ha-icon>` : ""}<span id="${what}-value">${esc(value)}</span></span>
      <button class="pm" data-step="${what}:1" aria-label="More" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
}

// HA's slider feature with - and + at the ends: drag for big changes,
// tap - or + for one step.
function slider(what, f, label, disabled) {
  return `
    <div class="feature slider ${disabled ? "disabled" : ""}">
      <button class="pm" data-step="${what}:-1" aria-label="Lower" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:minus"></ha-icon></button>
      <div class="track" id="${what}-track" role="slider" aria-valuetext="${esc(label)}">
        <div class="fill" id="${what}-fill" style="width:${pct(f)}"></div>
        <span class="track-value" id="${what}-value">${esc(label)}</span>
      </div>
      <button class="pm" data-step="${what}:1" aria-label="Higher" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
}

function endValue(m, s) {
  if (m.cooking) {
    if (m.done) return "Done";
    const left = remaining(m);
    if (left !== null) return clock(left);
    if (m.probe !== null) return `Probe ${Math.round(m.probe)} °C`;
    return "Until you stop";
  }
  if (s.end === "timer") return clock(s.timer * 60);
  if (s.end === "probe") return `Probe ${s.probe} °C`;
  return "Until you stop";
}

function endDisabled(m, s, off) {
  if (off) return true;
  if (m.cooking) return !m.timerTotal; // Only a running timer can change.
  return s.end === "none";
}

// Icons for the element choices: a square with the heated side drawn bold,
// and a fan for the rear element.
function modeIcon(key) {
  const box = `<rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55"/>`;
  const top = `<rect x="4" y="4" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const bottom = `<rect x="4" y="16.8" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const fan = `<circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M12 12 L12 8.4 M12 12 L15.1 13.8 M12 12 L8.9 13.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
  const inner = { top, bottom, top_bottom: top + bottom, rear: fan, rear_top: fan + top, rear_bottom: fan + bottom }[key];
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${box}${inner}</svg>`;
}

function setupTitle(s) {
  const mode = MODES.find((m) => m.key === s.mode).label;
  return s.sousVide ? `Sous vide ${fmtTemp(s.temp, " °C")}` : `${mode} ${fmtTemp(s.temp, " °C")}${s.steam ? `, ${s.steam} % steam` : ""}`;
}

function fmtTemp(v, unit = "°") {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`;
}

function warningText(m) {
  if (!m.connected) return "Offline: check the oven's power and Wi-Fi";
  if (m.waterEmpty) return "Water tank empty";
  if (m.cooking && m.door) return "Door open";
  if (m.descale) return "Descale needed";
  return "";
}

function timerStep(minutes, dir) {
  // 1-minute steps up to 10, then 5 up to 60, then 15, like a kitchen timer.
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
  const temp = m.temp === null ? "—" : `${Math.round(m.temp)} °C`;
  if (!m.cooking) return `Idle · ${temp}${m.probe !== null ? ` · probe ${Math.round(m.probe)} °C` : ""}`;
  const what = m.done ? "Done, still heating" : m.phase;
  return esc(`${m.recipe ? `${m.recipe} · ` : ""}${what} · ${temp}`);
}

function barLabel(m) {
  const left = m.done ? "Done, still heating" : m.phase === "Preheating" ? "Preheating" : (m.stage ? `Stage ${m.stage}` : m.phase);
  return `<span>${esc(left)}</span><span>${m.temp === null ? "" : `${Math.round(m.temp)} °C`}</span>`;
}

function clock(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pct(f) {
  return `${Math.round(clamp(f, 0, 1) * 1000) / 10}%`;
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
      const s = { ...DEFAULT_SETUP, ...saved };
      if (saved.bulb === "wet") s.sousVide = true; // from card 0.3
      if (!("end" in saved) && saved.timer > 0) s.end = "timer"; // from 0.3 and 0.4
      if (!(s.timer > 0)) s.timer = DEFAULT_SETUP.timer;
      delete s.bulb;
      return s;
    }
  } catch (_) { /* no storage */ }
  return { ...DEFAULT_SETUP };
}

function saveSetup(s) {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(s)); } catch (_) { /* no storage */ }
}

// Sizes follow HA's tile features: --feature-height 42px,
// --feature-border-radius 12px, --feature-button-spacing 12px.
const STYLE = `
  :host {
    --oven-rgb: 242, 107, 29;
    --tone-rgb: var(--rgb-disabled-color, 158, 158, 158);
    --h: var(--feature-height, 42px);
    --r: var(--feature-border-radius, 12px);
    --gap: var(--feature-button-spacing, 12px);
    --track: rgba(var(--rgb-primary-text-color, 33, 33, 33), .06);
  }
  ha-card { padding: 12px; display: flex; flex-direction: column; gap: var(--gap); height: 100%; box-sizing: border-box; }
  ha-card.active { --tone-rgb: var(--oven-rgb); }
  ha-card.error { --tone-rgb: var(--rgb-error-color, 219, 68, 55); }
  button { font: inherit; border: none; cursor: pointer; color: inherit; background: none; padding: 0;
    -webkit-tap-highlight-color: transparent; }
  button:disabled { cursor: default; }

  /* Header: the tile card's icon and two text lines. */
  .header { display: flex; align-items: center; gap: 10px; height: 40px; }
  .shape { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    background: rgba(var(--tone-rgb), .2); color: rgb(var(--tone-rgb)); }
  .shape ha-icon { --mdc-icon-size: 20px; }
  .info { flex: 1; min-width: 0; }
  .primary { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--primary-text-color); }
  .secondary { font-size: 12px; line-height: 16px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .secondary.warn { color: var(--error-color, #db4437); font-weight: 500; }
  .icon-state { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    color: var(--secondary-text-color); }
  .icon-state ha-icon { --mdc-icon-size: 20px; }
  .icon-state.warn { color: var(--warning-color, #e69500); }
  .lamp { background: var(--track); }
  .lamp.on { color: rgb(var(--rgb-amber-color, 255, 193, 7)); background: rgba(var(--rgb-amber-color, 255, 193, 7), .2); }
  .lamp.pending { animation: pulse 1s ease-in-out infinite; }
  .lamp:disabled { opacity: .4; }
  @keyframes pulse { 50% { opacity: .35; } }

  /* Feature rows: always five, always 42 px. */
  .features { display: flex; flex-direction: column; gap: var(--gap); }
  .feature { height: var(--h); border-radius: var(--r); box-sizing: border-box; }
  .pair { display: flex; gap: var(--gap); }
  .pair > * { flex: 1; min-width: 0; }
  .pair.wide > .toggle { flex: 0 0 var(--h); }
  .pair.end > .select { flex: 0 0 calc(var(--h) * 3); }

  /* Select (HA's select and hvac-modes features). */
  .select { display: flex; background: var(--track); overflow: hidden; }
  .option { flex: 1; min-width: 0; display: grid; place-items: center; color: var(--secondary-text-color); border-radius: var(--r); }
  .option ha-icon { --mdc-icon-size: 20px; }
  .option.on { background: rgb(var(--oven-rgb)); color: #fff; }
  .option:disabled { opacity: .4; }
  .option.on:disabled { opacity: .55; }

  /* Progress row: same height, a fill behind the text. */
  .progress { position: relative; overflow: hidden; background: rgba(var(--tone-rgb), .15); }
  .progress-fill { position: absolute; inset: 0 auto 0 0; background: rgba(var(--tone-rgb), .35); transition: width 1s linear; }
  .progress-text { position: relative; display: flex; justify-content: space-between; align-items: center; height: 100%;
    padding: 0 14px; font-size: 14px; font-weight: 500; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }

  /* Stepper (HA's number-buttons feature) and slider. */
  .stepper, .slider { display: flex; align-items: center; background: var(--track); overflow: hidden; }
  .pm { flex: none; width: var(--h); height: var(--h); display: grid; place-items: center; border-radius: var(--r);
    color: var(--primary-text-color); touch-action: none; user-select: none; }
  .pm:active:not(:disabled) { background: rgba(var(--oven-rgb), .2); }
  .pm ha-icon { --mdc-icon-size: 20px; }
  .stepper .value { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 4px;
    font-size: 14px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden;
    font-variant-numeric: tabular-nums; }
  .stepper .value ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); }
  .stepper.disabled .pm, .stepper.disabled .value, .slider.disabled .pm, .slider.disabled .track { opacity: .4; }
  .track { position: relative; flex: 1; align-self: stretch; margin: 6px 0; border-radius: 8px; overflow: hidden;
    background: rgba(var(--oven-rgb), .14); cursor: pointer; touch-action: none; user-select: none; }
  .slider.disabled .track { cursor: default; }
  .fill { position: absolute; inset: 0 auto 0 0; background: rgba(var(--oven-rgb), .45); border-radius: 8px 0 0 8px; }
  .fill::after { content: ""; position: absolute; right: 4px; top: 50%; width: 4px; height: 16px; margin-top: -8px;
    border-radius: 2px; background: #fff; box-shadow: 0 0 2px rgba(0, 0, 0, .3); }
  .track-value { position: relative; display: grid; place-items: center; height: 100%; font-size: 14px; font-weight: 500;
    color: var(--primary-text-color); font-variant-numeric: tabular-nums; pointer-events: none; }

  /* Toggles (sous vide, preheat) and actions. */
  .toggle { display: grid; place-items: center; background: var(--track); color: var(--secondary-text-color); }
  .toggle.on { background: rgb(var(--rgb-blue-color, 33, 150, 243)); color: #fff; }
  .toggle.on.preheat { background: rgb(var(--oven-rgb)); }
  .toggle:disabled { opacity: .4; }
  .toggle ha-icon { --mdc-icon-size: 20px; }
  .action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; font-weight: 500;
    background: var(--track); color: var(--primary-text-color); }
  .action ha-icon { --mdc-icon-size: 20px; }
  .action.start { background: rgb(var(--oven-rgb)); color: #fff; }
  .action.start:disabled { opacity: .4; }
  .action.stop { background: rgba(var(--rgb-error-color, 219, 68, 55), .15); color: var(--error-color, #db4437); }
  .action.stop.armed { background: var(--error-color, #db4437); color: #fff; }
`;

customElements.define("anova-oven-card", AnovaOvenCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "anova-oven-card",
  name: "Anova Oven",
  description: "Run the Anova Precision Oven: elements, temperature slider, sous vide, timer or probe, steam, preheat.",
  preview: true,
});
console.info(`%c anova-oven-card ${CARD_VERSION} `, "background:#F26B1D;color:#fff;border-radius:4px");
