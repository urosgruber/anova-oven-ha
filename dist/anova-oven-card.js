/*
 * anova-oven-card: a Home Assistant dashboard card for the Anova Precision
 * Oven, run locally by anova-oven-server (ha-app/). It reads the MQTT
 * entities the server creates (all named <prefix>_*, default "anova_oven").
 *
 *   type: custom:anova-oven-card
 *   title: Oven                 # optional
 *   prefix: anova_oven          # optional
 *   max_temperature: 250        # optional, the ring's full scale in °C
 *   presets:                    # optional; default: the recipes the server knows
 *     - name: Pizza
 *       recipe: Pizza           # an option of select.<prefix>_recipe
 *       icon: mdi:pizza
 *
 * No external libraries: a plain custom element with a shadow root.
 */

const CARD_VERSION = "0.1.0";
const STOP_CONFIRM_MS = 3000;

class AnovaOvenCard extends HTMLElement {
  static getStubConfig() {
    return { prefix: "anova_oven" };
  }

  setConfig(config) {
    this._config = {
      prefix: "anova_oven",
      max_temperature: 250,
      ...config,
    };
    this._stopArmedUntil = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    // The countdown runs between state updates.
    this._tick = setInterval(() => this._renderCountdown(), 1000);
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

  async _start(recipe) {
    await this._call("select", "select_option", {
      entity_id: this._id("select", "recipe"),
      option: recipe,
    });
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

  _nextStage() {
    this._call("button", "press", { entity_id: this._id("button", "next_stage") });
  }

  _toggleLamp() {
    this._call("light", "toggle", { entity_id: this._id("light", "lamp") });
  }

  // --- View model ---------------------------------------------------------

  _model() {
    const connected = this._on("binary_sensor", "connected");
    const phase = this._value("sensor", "mode") || "Unknown";
    const cooking = connected && this._on("binary_sensor", "cooking");
    const temp = this._number("sensor", "temperature");
    const target = this._number("sensor", "target_temperature");
    const probe = this._number("sensor", "probe_temperature");
    const steam = this._number("sensor", "steam");
    const endsAt = this._value("sensor", "stage_ends_at");
    const nextReady = this._on("binary_sensor", "next_stage_ready");
    const recipeOptions = (this._state("select", "recipe") || {}).attributes?.options || [];
    const presets = this._config.presets && this._config.presets.length
      ? this._config.presets
      : recipeOptions.map((r) => ({ name: r, recipe: r }));
    return {
      connected,
      phase,
      cooking,
      temp,
      target,
      probe,
      steam,
      endsAt: endsAt ? Date.parse(endsAt) : null,
      stage: this._value("sensor", "stage"),
      stageDescription: this._value("sensor", "stage_description"),
      recipe: this._value("sensor", "current_recipe"),
      nextReady,
      // The oven holds the setpoint after the last timer ends: "done" means
      // waiting on the last stage with no next stage to start.
      waiting: cooking && nextReady,
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
      this.shadowRoot.innerHTML = `<ha-card><div class="empty">Loading…</div></ha-card>`;
      return;
    }
    const m = this._model();
    const title = this._config.title || "Oven";
    const statusText = !m.connected ? "Offline" : m.waiting ? "Waiting" : m.phase;
    const statusClass = !m.connected ? "offline" : m.cooking ? "active" : "idle";
    const armed = Date.now() < this._stopArmedUntil;

    const alerts = [];
    if (!m.connected) alerts.push(["mdi:wifi-off", "The oven is not connected to the server."]);
    if (m.waterEmpty) alerts.push(["mdi:water-off", "The water tank is empty."]);
    if (m.descale) alerts.push(["mdi:water-alert", "The oven needs a descale."]);
    if (m.cooking && m.door) alerts.push(["mdi:door-open", "The door is open."]);

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <div class="title">
            <ha-icon icon="mdi:stove"></ha-icon>
            <span>${esc(title)}</span>
          </div>
          <div class="header-right">
            <span class="chip ${statusClass}">${esc(statusText)}</span>
            <button class="icon-btn ${m.lamp ? "on" : ""}" id="lamp"
              title="Light" ${m.connected ? "" : "disabled"}>
              <ha-icon icon="${m.lamp ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}"></ha-icon>
            </button>
          </div>
        </div>

        <div class="hero">
          ${ring(m, this._config.max_temperature)}
          <div class="facts">
            ${m.cooking ? `
              <div class="recipe">${esc(m.recipe || "Cooking")}</div>
              <div class="stage">${esc([m.stage && `Stage ${m.stage}`, m.stageDescription].filter(Boolean).join(" · "))}</div>
              <div class="countdown" id="countdown">${countdown(m)}</div>
            ` : `
              <div class="recipe muted">${m.connected ? "Ready" : "Not connected"}</div>
              <div class="stage">${m.connected ? "Choose a preset to start." : "Check the oven's power and Wi-Fi."}</div>
            `}
            <div class="minis">
              ${mini("mdi:water-percent", m.steam === null ? "—" : `${Math.round(m.steam)}%`, "Steam")}
              ${m.probe !== null ? mini("mdi:thermometer-probe", `${Math.round(m.probe)}°`, "Probe") : ""}
              ${mini(m.door ? "mdi:door-open" : "mdi:door-closed", m.door ? "Open" : "Closed", "Door")}
            </div>
          </div>
        </div>

        ${alerts.length ? `<div class="alerts">${alerts.map(([icon, text]) =>
          `<div class="alert"><ha-icon icon="${icon}"></ha-icon><span>${esc(text)}</span></div>`).join("")}</div>` : ""}

        ${m.cooking ? `
          <div class="actions">
            ${m.nextReady ? `<button class="btn" id="next"><ha-icon icon="mdi:skip-next"></ha-icon>Next stage</button>` : ""}
            <button class="btn danger ${armed ? "armed" : ""}" id="stop">
              <ha-icon icon="mdi:stop"></ha-icon>${armed ? "Tap again to stop" : "Stop"}
            </button>
          </div>
        ` : `
          <div class="presets">
            ${m.presets.length ? m.presets.map((p, i) => `
              <button class="preset" data-i="${i}" ${m.connected ? "" : "disabled"}>
                <ha-icon icon="${esc(p.icon || "mdi:chef-hat")}"></ha-icon>
                <span>${esc(p.name)}</span>
              </button>`).join("") : `<div class="muted small">No recipes yet. Add them on the app's web page, or set <code>presets</code>.</div>`}
          </div>
        `}
      </ha-card>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    if ($("lamp")) $("lamp").onclick = () => this._toggleLamp();
    if ($("stop")) $("stop").onclick = () => this._stop();
    if ($("next")) $("next").onclick = () => this._nextStage();
    this.shadowRoot.querySelectorAll(".preset").forEach((b) => {
      b.onclick = () => this._start(m.presets[Number(b.dataset.i)].recipe);
    });
  }

  _renderCountdown() {
    const el = this.shadowRoot && this.shadowRoot.getElementById("countdown");
    if (el && this._hass) el.innerHTML = countdown(this._model());
  }
}

// --- Pieces -----------------------------------------------------------------

function ring(m, maxTemp) {
  // A 270° gauge: the arc fills to the current temperature, a dot marks the
  // target. Preheat progress reads as the gap between them.
  const r = 52, cx = 64, cy = 64, sweep = 270, start = 135;
  const frac = (t) => Math.max(0, Math.min(1, (t || 0) / maxTemp));
  const point = (f) => {
    const a = ((start + sweep * f) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (f) => {
    const [x0, y0] = point(0);
    const [x1, y1] = point(f);
    const large = sweep * f > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };
  const showTarget = m.cooking && m.target !== null;
  const [tx, ty] = point(frac(m.target));
  return `
    <div class="ring">
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <defs>
          <linearGradient id="heat" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="#FFB547"/>
            <stop offset="1" stop-color="#F26B1D"/>
          </linearGradient>
        </defs>
        <path d="${arc(1)}" class="track"/>
        ${m.temp !== null ? `<path d="${arc(frac(m.temp))}" class="fill ${m.cooking ? "" : "cold"}"/>` : ""}
        ${showTarget ? `<circle cx="${tx}" cy="${ty}" r="5.5" class="target"/>` : ""}
      </svg>
      <div class="ring-center">
        <div class="temp">${m.temp === null ? "—" : Math.round(m.temp)}<span>°</span></div>
        <div class="target-text">${showTarget ? `→ ${Math.round(m.target)}°` : "&nbsp;"}</div>
      </div>
    </div>`;
}

function countdown(m) {
  if (m.waiting) return `<span class="done">Timer done · oven still heating</span>`;
  if (!m.endsAt) return m.phase === "Preheating" ? `<span class="muted">Preheating…</span>` : "";
  const secs = Math.max(0, Math.round((m.endsAt - Date.now()) / 1000));
  const h = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  const text = h ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  return `<ha-icon icon="mdi:timer-outline"></ha-icon><span class="time">${text}</span><span class="muted"> left</span>`;
}

function mini(icon, value, label) {
  return `<div class="mini" title="${esc(label)}"><ha-icon icon="${icon}"></ha-icon><span>${esc(value)}</span></div>`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const STYLE = `
  :host { --oven: #F26B1D; --oven-soft: rgba(242, 107, 29, 0.14); }
  ha-card { padding: 16px; overflow: hidden; }
  .empty { padding: 24px; color: var(--secondary-text-color); }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
  .title ha-icon { color: var(--oven); }
  .header-right { display: flex; align-items: center; gap: 8px; }
  .chip { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; letter-spacing: .02em; }
  .chip.idle { background: var(--secondary-background-color, rgba(127,127,127,.15)); color: var(--secondary-text-color); }
  .chip.active { background: var(--oven-soft); color: var(--oven); }
  .chip.offline { background: rgba(219, 68, 55, .14); color: var(--error-color, #db4437); }
  .icon-btn { border: none; background: var(--secondary-background-color, rgba(127,127,127,.15)); color: var(--secondary-text-color);
    width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; }
  .icon-btn.on { background: rgba(255, 193, 7, .2); color: #f2a900; }
  .icon-btn:disabled { opacity: .4; cursor: default; }

  .hero { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
  .ring { position: relative; width: 148px; height: 148px; flex: none; }
  .ring svg { width: 100%; height: 100%; }
  .track { fill: none; stroke: var(--divider-color, rgba(127,127,127,.25)); stroke-width: 10; stroke-linecap: round; }
  .fill { fill: none; stroke: url(#heat); stroke-width: 10; stroke-linecap: round; transition: d .6s; }
  .fill.cold { stroke: var(--secondary-text-color); opacity: .45; }
  .target { fill: var(--card-background-color, #fff); stroke: var(--oven); stroke-width: 3; }
  .ring-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
  .temp { font-size: 40px; font-weight: 700; line-height: 1; color: var(--primary-text-color); }
  .temp span { font-size: 22px; vertical-align: top; color: var(--secondary-text-color); }
  .target-text { margin-top: 4px; font-size: 14px; font-weight: 600; color: var(--oven); }

  .facts { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .recipe { font-size: 20px; font-weight: 600; color: var(--primary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage { font-size: 14px; color: var(--secondary-text-color); }
  .countdown { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 15px; color: var(--primary-text-color); }
  .countdown ha-icon { --mdc-icon-size: 18px; color: var(--oven); }
  .countdown .time { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .countdown .done { color: var(--oven); font-weight: 600; }
  .minis { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .mini { display: flex; align-items: center; gap: 4px; font-size: 13px; padding: 4px 8px; border-radius: 8px;
    background: var(--secondary-background-color, rgba(127,127,127,.12)); color: var(--primary-text-color); }
  .mini ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: 13px; }

  .alerts { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .alert { display: flex; align-items: center; gap: 8px; font-size: 14px; padding: 8px 10px; border-radius: 10px;
    background: rgba(219, 68, 55, .1); color: var(--error-color, #db4437); }
  .alert ha-icon { --mdc-icon-size: 18px; }

  .actions { display: flex; gap: 8px; margin-top: 16px; }
  .btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 44px; border-radius: 12px;
    border: none; cursor: pointer; font-size: 15px; font-weight: 600;
    background: var(--secondary-background-color, rgba(127,127,127,.15)); color: var(--primary-text-color); }
  .btn.danger { background: rgba(219, 68, 55, .12); color: var(--error-color, #db4437); }
  .btn.danger.armed { background: var(--error-color, #db4437); color: #fff; }

  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin-top: 16px; }
  .preset { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 6px; border-radius: 12px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.25)); background: transparent; cursor: pointer;
    color: var(--primary-text-color); font-size: 14px; font-weight: 500; }
  .preset ha-icon { color: var(--oven); }
  .preset:hover:not(:disabled) { background: var(--oven-soft); border-color: var(--oven); }
  .preset:disabled { opacity: .45; cursor: default; }
  code { font-size: 12px; }

  @media (max-width: 420px) {
    .hero { flex-direction: column; align-items: stretch; }
    .ring { margin: 0 auto; }
  }
`;

customElements.define("anova-oven-card", AnovaOvenCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "anova-oven-card",
  name: "Anova Oven",
  description: "Status, countdown and presets for the Anova Precision Oven (local control).",
  preview: true,
});
console.info(`%c anova-oven-card ${CARD_VERSION} `, "background:#F26B1D;color:#fff;border-radius:4px");
