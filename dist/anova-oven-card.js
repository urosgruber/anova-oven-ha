/*
 * anova-oven-card: a Home Assistant dashboard card for the Anova Precision
 * Oven, run locally by anova-oven-server (ha-app/). It reads the MQTT
 * entities the server creates (all named <prefix>_*, default "anova_oven").
 *
 * Layout: a tile-card header, then five rows in the style of HA's tile
 * features (42 px high, 12 px radius, 12 px gaps):
 *   1. heating elements: any one or two (six choices; while cooking: progress)
 *   2. temperature: a slider with - and +, and the sous vide toggle
 *   3. steam: a light-blue slider (100 % and locked with sous vide)
 *   4. how the cook ends: until you stop, timer or probe, with its value
 *   5. Preheat and Bake / Cook (while cooking: Next stage and Stop)
 * The same rows show in every state, so the card never changes size. The
 * wrench in the header swaps the rows for a maintenance panel of the same
 * height (heating element prep, descale, water tank).
 *
 *   type: custom:anova-oven-card
 *   title: Oven                 # optional
 *   prefix: anova_oven          # optional, the entity ID prefix
 *   mqtt_prefix: anova/oven     # optional, the server's MQTT topic prefix
 *   power_switch: switch.x      # optional, the smart plug the oven hangs on
 *   power_sensor: sensor.x      # optional, that plug's power in W
 *   power_idle_w: 20            # optional, the most an idle, cool oven draws
 *
 * Power: the card never cuts power during a cook (Stop ends a cook).
 * "Turn off" only when the oven is idle; "Restart power" (for Wi-Fi) only
 * when the oven is offline and the plug reads no more than power_idle_w,
 * because a higher draw means a cook may still run.
 *
 * The HA app installs this file and registers it as a dashboard resource.
 * Start publishes {"stages": [...]} to <mqtt_prefix>/cmd/start with the
 * mqtt.publish service. No external libraries.
 */

const CARD_VERSION = "0.17.2";
const STOP_CONFIRM_MS = 3000;
const LAMP_CONFIRM_MS = 15000;
const NO_END = "Until you stop";
// Restart power: off for this long, then on again.
const RESTART_OFF_MS = 10000;
const SETUP_KEY = "anova-oven-card:setup";
// A cool-down stage: the rear element with a 25 °C target. The heaters stay
// off while the oven is hotter, the fan runs, and the vent is open.
const COOL_C = 25;

// The entities the card reads. It re-renders only when one of them changes.
const WATCHED = [
  "binary_sensor.connected", "binary_sensor.cooking", "binary_sensor.next_stage_ready", "binary_sensor.door",
  "binary_sensor.water_tank_empty", "binary_sensor.descale_required", "light.lamp", "event.cook",
  "sensor.mode", "sensor.temperature", "sensor.target_temperature", "sensor.probe_temperature", "sensor.steam",
  "sensor.stage_ends_at", "sensor.stage", "sensor.stage_description", "sensor.current_recipe", "number.set_timer",
  "sensor.recipes", "switch.auto_stop", "sensor.wet_bulb_temperature",
];

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
  { key: "none", label: NO_END, icon: "mdi:all-inclusive" },
  { key: "timer", label: "Timer", icon: "mdi:timer-outline" },
  { key: "probe", label: "Probe", icon: "mdi:thermometer-probe" },
];
const LIMITS = { dry: [25, 250], wet: [25, 100], probe: [1, 100] };
// A program is a list of steps. Each step is one oven stage; `waits` makes a
// step after the first wait for Next stage. Preheat (before step 1) and the
// selected step are program-wide.
const STEP_KEYS = ["mode", "sousVide", "temp", "steam", "end", "timer", "probe", "waits"];
const DEFAULT_STEP = {
  mode: "top_bottom", sousVide: false, temp: 180, steam: 0,
  end: "none", timer: 30, probe: 55, waits: false,
};
const DEFAULT_SETUP = { steps: [DEFAULT_STEP], sel: 0, preheat: true };
const MAX_STEPS = 8;
// From this card width, steam sits next to the timer: ends 126 + timer 130 +
// steam 90 + two 12 px gaps + 24 px padding.
const WIDE_PX = 394;

class AnovaOvenCard extends HTMLElement {
  static getStubConfig() {
    return { prefix: "anova_oven" };
  }

  setConfig(config) {
    this._config = { prefix: "anova_oven", mqtt_prefix: "anova/oven", power_idle_w: 20, ...config };
    this._watch = [...WATCHED.map((w) => this._id(...w.split("."))),
      this._config.power_switch, this._config.power_sensor].filter(Boolean);
    this._stopArmedUntil = 0;
    this._lampPending = null;
    this._panel = null;
    this._setup = loadSetup();
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      // A tap is a press and a release on the same element. A re-render in
      // between replaces the element, and the browser drops the tap. So no
      // re-render while a pointer is down; a pending one runs on release.
      this.shadowRoot.addEventListener("pointerdown", () => {
        this._pressing = true;
        const release = () => {
          this._pressing = false;
          if (this._dirty && !this._holding) { this._dirty = false; this._render(); }
        };
        window.addEventListener("pointerup", release, { once: true });
        window.addEventListener("pointercancel", release, { once: true });
      }, { capture: true });
    }
    this._render();
  }

  set hass(hass) {
    const before = this._hass;
    this._hass = hass;
    // HA sets hass on every state change in the whole instance. HA replaces
    // a state object when it changes, so comparing references is enough.
    const changed = !before || this._watch.some((id) => before.states[id] !== hass.states[id]);
    if (!changed) return;
    if (this._lampPending) {
      const lamp = this._on("light", "lamp");
      if (lamp === this._lampPending.on || Date.now() > this._lampPending.until) this._lampPending = null;
    }
    // A re-render during a tap, drag or held button would replace that element.
    if (this._holding || this._pressing || this._typing) this._dirty = true;
    else this._render();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 6, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    // The card's width decides the layout. A CSS container query does not
    // reach through ha-card's shadow DOM, so measure it here.
    if (typeof ResizeObserver !== "undefined" && !this._ro) {
      this._ro = new ResizeObserver((entries) => {
        const wide = entries[0].contentRect.width >= WIDE_PX;
        if (wide === this._wide) return;
        this._wide = wide;
        const card = this.shadowRoot && this.shadowRoot.querySelector("ha-card");
        if (card) card.classList.toggle("wide", wide);
      });
      this._ro.observe(this);
    }
    // Tick just after each full second. A plain 1 s interval drifts, and a
    // tick near a second's edge showed the same second twice or skipped one.
    const tick = () => {
      this._renderLive();
      this._tick = setTimeout(tick, 1000 - (Date.now() % 1000) + 20);
    };
    clearTimeout(this._tick);
    this._tick = setTimeout(tick, 1000 - (Date.now() % 1000) + 20);
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    clearTimeout(this._tick);
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

  // The selected step, with the program-wide fields next to it.
  _view() {
    const p = this._setup;
    return { ...p.steps[p.sel], preheat: p.preheat, sel: p.sel, steps: p.steps };
  }

  // --- Actions ------------------------------------------------------------

  _start() {
    if (this._model().descaling) return;
    this._publishStart(programTitle(this._setup), programStages(this._setup));
  }

  // The HA user goes with the start, so the App can notify that person.
  _publishStart(title, stages) {
    const started_by = this._hass.user ? this._hass.user.id : undefined;
    this._call("mqtt", "publish", {
      topic: `${this._config.mqtt_prefix}/cmd/start`,
      payload: JSON.stringify({ title, stages, started_by }),
    });
  }

  // Next stage works at any time while a later stage exists: it skips the
  // rest of the current stage. The button entity is only available while a
  // stage waits, so publish the command directly.
  _nextStage() {
    this._call("mqtt", "publish", { topic: `${this._config.mqtt_prefix}/cmd/next_stage`, payload: "PRESS" });
  }

  _addStep() {
    const p = this._setup;
    if (p.steps.length >= MAX_STEPS) return;
    const steps = p.steps.map((x) => ({ ...x }));
    // A copy of the selected step, so only what differs needs changing.
    steps.splice(p.sel + 1, 0, { ...steps[p.sel], waits: false });
    this._setProgram({ ...p, steps, sel: p.sel + 1 });
  }

  _removeStep() {
    const p = this._setup;
    if (p.steps.length < 2) return;
    const steps = p.steps.filter((_, i) => i !== p.sel);
    this._setProgram({ ...p, steps, sel: Math.min(p.sel, steps.length - 1) });
  }

  // Tap the end value to type it: the timer in minutes, 3m30s, 1h30 or 1:30, or
  // the probe target in °C. Enter or leaving the field commits; Escape
  // cancels. On a running cook it sets the running timer.
  _editEnd(m) {
    const s = this._view();
    const kind = m.cooking ? (m.timerTotal ? "timer" : null) : s.end;
    const btn = this.shadowRoot.getElementById("end-edit");
    if (!btn || (kind !== "timer" && kind !== "probe")) return;
    const input = document.createElement("input");
    input.className = "value-input";
    input.type = "text";
    input.inputMode = kind === "timer" ? "text" : "numeric";
    // On a running cook the field shows the time left. The oven restarts
    // its countdown from what it gets, so the card sends only a change.
    const left = m.cooking ? remaining(m) : null;
    input.value = kind === "timer"
      ? fmtMinutes(m.cooking ? (left !== null ? Math.max(left, 60) : m.timerTotal) / 60 : s.timer)
      : String(s.probe);
    const initial = input.value;
    input.placeholder = kind === "timer" ? "min, 3m30s, 1h30" : "°C";
    input.setAttribute("aria-label", kind === "timer" ? "Timer" : "Probe target");
    btn.replaceWith(input);
    this._typing = true;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this._typing = false;
      if (commit && input.value.trim() !== initial) {
        if (kind === "timer") {
          const min = parseMinutes(input.value);
          // The command topic takes seconds, so a typed 3m30s stays exact.
          if (min !== null && m.cooking) {
            this._call("mqtt", "publish", { topic: `${this._config.mqtt_prefix}/cmd/timer`,
              payload: String(Math.round(clamp(min, 1, 1440) * 60)) });
          } else if (min !== null) this._update({ timer: min });
        } else {
          const t = Number(input.value.replace(",", "."));
          if (Number.isFinite(t)) this._update({ probe: t });
        }
      }
      this._dirty = false;
      this._render();
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
    input.focus();
    input.select();
  }

  _refreshSaveButton() {
    const b = this.shadowRoot.getElementById("save");
    if (!b) return;
    const name = (this._presetName ?? "").trim();
    const exists = this._recipes().some((r) => r.title === name);
    b.disabled = !name || !this._on("binary_sensor", "connected");
    b.classList.toggle("stop", exists);
    b.classList.toggle("save", !exists);
    b.lastChild.textContent = exists ? "Replace" : "Save";
  }

  _setProgram(p) {
    this._setup = p;
    saveSetup(p);
    this._render();
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

  // Sous vide takes 0.1 °C, a dry cook whole degrees. Straight to the App's
  // command topic: the Set temperature number only takes whole degrees.
  _setTarget(value, wet) {
    const t = wet ? clamp(Math.round(value * 10) / 10, ...LIMITS.wet) : clamp(Math.round(value), ...LIMITS.dry);
    this._call("mqtt", "publish", { topic: `${this._config.mqtt_prefix}/cmd/temperature`, payload: String(t) });
  }

  _update(change) {
    const p = { ...this._setup, steps: this._setup.steps.map((x) => ({ ...x })) };
    const st = p.steps[p.sel];
    for (const [k, v] of Object.entries(change)) (STEP_KEYS.includes(k) ? st : p)[k] = v;
    normalizeStep(st);
    this._setup = p;
    saveSetup(p);
    // While a button is held, only the numbers change.
    if (this._holding) this._renderValues();
    else this._render();
  }

  // One step of a - or + button. `dir` is -1 or 1.
  _step(what, dir, m) {
    const s = this._view();
    if (m.cooking) {
      // On a running cook, each step is one command to the oven.
      if (what === "temp" && m.target !== null) this._setTarget(m.target + dir * (m.wet ? 0.1 : 1), m.wet);
      // The oven restarts its countdown from the value it gets, so add to
      // or take from the time left, not the stage's total.
      const left = remaining(m);
      if (what === "end" && left !== null) {
        this._call("mqtt", "publish", { topic: `${this._config.mqtt_prefix}/cmd/timer`,
          payload: String(clamp(left + dir * 300, 60, 1440 * 60)) });
      }
      return;
    }
    if (what === "temp") this._update({ temp: s.temp + dir * (s.sousVide ? 0.1 : 1) });
    // From 3m30s, + goes to 4 and - to 3; then in whole steps.
    if (what === "end" && s.end === "timer") {
      const t = s.timer % 1 ? (dir > 0 ? Math.ceil(s.timer) : Math.floor(s.timer)) : s.timer + dir * timerStep(s.timer, dir);
      this._update({ timer: t });
    }
    if (what === "end" && s.end === "probe") this._update({ probe: s.probe + dir });
    if (what === "steam") this._update({ steam: s.steam + dir * 10 });
  }

  // --- View model ---------------------------------------------------------

  // The server sends the end time in whole seconds, computed at each state
  // update, so it moves back and forth by a second. Keep the one we have
  // unless the new one differs by more than 2 s (a real timer change).
  _stableEnd(t) {
    if (t === null) { this._endsAt = null; return null; }
    if (this._endsAt == null || Math.abs(t - this._endsAt) > 2000) this._endsAt = t;
    return this._endsAt;
  }

  _model() {
    const link = this._state("binary_sensor", "connected");
    // The app runs when its Connected sensor exists and has a state.
    const appUp = !!link && link.state !== "unavailable" && link.state !== "unknown";
    const connected = appUp && link.state === "on";
    // While the oven is offline, the Connected sensor keeps its last state.
    const last = (link && link.attributes) || {};
    const plug = this._config.power_switch ? this._hass.states[this._config.power_switch] : null;
    const plugState = plug && (plug.state === "on" || plug.state === "off") ? plug.state : null;
    const watt = this._config.power_sensor ? this._hass.states[this._config.power_sensor] : null;
    const watts = watt && Number.isFinite(Number(watt.state)) && watt.state !== "" ? Number(watt.state) : null;
    const cooking = connected && this._on("binary_sensor", "cooking");
    const lastEvent = (this._state("event", "cook") || {}).attributes?.event_type;
    const endsAt = this._value("sensor", "stage_ends_at");
    const timerMin = this._number("number", "set_timer");
    // The oven's own descale program (App 0.17.0+). It is not a cook.
    const modeState = this._state("sensor", "mode");
    const descaling = connected && !cooking && !!modeState && modeState.state === "Descaling";
    return {
      appUp,
      connected,
      cooking,
      descaling,
      descaleSince: descaling && modeState.last_changed ? Date.parse(modeState.last_changed) : null,
      offlineSince: !connected && link && link.last_changed ? Date.parse(link.last_changed) : null,
      wasCooking: appUp && !connected && !!last.mode && !["idle", "unknown"].includes(last.mode),
      lastTemp: Number.isFinite(last.temperature_c) ? last.temperature_c : null,
      lastTarget: Number.isFinite(last.target_temperature_c) ? last.target_temperature_c : null,
      lastRecipe: last.recipe_title || null,
      plug: plugState,
      hasPlug: !!this._config.power_switch,
      watts,
      phase: this._value("sensor", "mode") || "Unknown",
      // From the oven's state (App 0.16.0+). The last event can be a later
      // one, such as temp_reached during the hold.
      done: cooking && ("cook_done" in last ? last.cook_done === true : lastEvent === "cook_done"),
      temp: this._number("sensor", "temperature"),
      target: this._number("sensor", "target_temperature"),
      wetTemp: this._number("sensor", "wet_bulb_temperature"),
      // When this browser's clock saw the cook start (HA's last change of
      // the Cooking sensor). An HA restart mid-cook resets it.
      cookStart: cooking ? Date.parse((this._state("binary_sensor", "cooking") || {}).last_changed) || null : null,
      // When the running step started, from the App (0.15.2+). The oven
      // counts up from there, after its preheat. Unknown when the App
      // started during the step.
      stageStart: cooking && last.stage_started_at ? Date.parse(last.stage_started_at) || null : null,
      // null when the App has no Auto stop switch (older App).
      autoStop: this._value("switch", "auto_stop") === null ? null : this._on("switch", "auto_stop"),
      probe: this._number("sensor", "probe_temperature"),
      steam: this._number("sensor", "steam"),
      endsAt: this._stableEnd(endsAt ? Date.parse(endsAt) : null),
      // Exact seconds from the App (0.16.0+); the number entity rounds to
      // whole minutes.
      timerTotal: cooking && Number(last.timer_total_secs) > 0 ? Number(last.timer_total_secs)
        : timerMin ? timerMin * 60 : null,
      stage: this._value("sensor", "stage"),
      stageDescription: this._value("sensor", "stage_description"),
      recipe: this._value("sensor", "current_recipe"),
      // The running cook's stages, from the server (the same on every device).
      stages: (this._state("sensor", "current_recipe") || {}).attributes?.stages,
      nextReady: this._on("binary_sensor", "next_stage_ready"),
      door: this._on("binary_sensor", "door"),
      lamp: this._on("light", "lamp"),
      waterEmpty: this._on("binary_sensor", "water_tank_empty"),
      // null while the sensor is unavailable, for example with the oven offline.
      descale: this._value("binary_sensor", "descale_required") === null ? null : this._on("binary_sensor", "descale_required"),
    };
  }

  // The model, with a sous vide cook's wet-bulb temperature and target in
  // place of the dry ones: the dry setpoint is not what the oven holds.
  _liveModel() {
    const m = this._model();
    const st = m.cooking ? runningStage(m) : null;
    if (st && st.temperature_bulbs_mode === "wet") {
      m.wet = true;
      m.temp = m.wetTemp;
      m.target = st.temperature_c;
    }
    return m;
  }

  // --- Rendering ----------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="secondary">Loading…</div></ha-card>`;
      return;
    }
    const m = this._liveModel();
    const s = this._view();
    const live = m.cooking;
    const off = !m.connected;
    const tone = off ? "error" : live ? "active" : "idle";
    const armed = Date.now() < this._stopArmedUntil;
    const lampShown = this._lampPending ? this._lampPending.on : m.lamp;
    const warning = warningText(m);
    const needsProbe = s.steps.some((st) => st.end === "probe") && m.probe === null;

    // Temperature: the setup's value, or the running cook's target.
    const [tlo, thi] = live ? LIMITS.dry : LIMITS[s.sousVide ? "wet" : "dry"];
    const tValue = live ? m.target : s.temp;
    const tDisabled = off || (live && m.target === null);

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="${tone} ${this._wide ? "wide" : ""}">
        <div class="header">
          <div class="shape"><ha-icon icon="${live ? "mdi:stove" : "mdi:toaster-oven"}"></ha-icon></div>
          <div class="info">
            <div class="primary">${esc(this._config.title || "Oven")}</div>
            <div class="secondary ${warning ? "warn" : ""}" id="secondary">${statusLine(m, warning)}</div>
          </div>
          <div class="icon-state ${off ? "unknown" : m.door ? "warn" : ""}" title="${off ? "Door: unknown (offline)" : m.door ? "Door open" : "Door closed"}">
            <ha-icon icon="${m.door ? "mdi:door-open" : "mdi:door-closed"}"></ha-icon>
          </div>
          <div class="icon-state probe ${off ? "unknown" : m.probe !== null ? "in" : ""}"
            title="${off ? "Probe: unknown (offline)" : m.probe !== null ? `Probe plugged in: ${Math.round(m.probe)} °C` : "Probe not plugged in"}">
            <ha-icon icon="mdi:thermometer-probe"></ha-icon>
          </div>
          <button class="icon-state lamp ${lampShown ? "on" : ""} ${this._lampPending ? "pending" : ""}" id="lamp"
            title="${this._lampPending ? "Switching…" : lampShown ? "Light on" : "Light off"}" ${off ? "disabled" : ""}>
            <ha-icon icon="${lampShown ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}"></ha-icon>
          </button>
          <button class="icon-state tools ${this._panel === "maintenance" ? "on" : ""}" id="tools"
            title="${m.descale ? "Maintenance: descale needed" : m.waterEmpty ? "Maintenance: water tank empty" : "Maintenance"}">
            ${m.descale || m.waterEmpty ? `<span class="badge"></span>` : ""}
            <ha-icon icon="mdi:cog-outline"></ha-icon>
          </button>
        </div>

        <div class="features">
          ${this._panel === "maintenance" ? this._maintenanceView(m) : this._panel === "presets" ? this._presetsView(m) : `
          ${live ? runningChips(m) : stepChips(s, off)}
          ${live ? `
            <div class="feature progress" title="${esc(m.stageDescription || "")}">
              <div class="progress-fill" id="bar" style="width:${pct(progress(m))}"></div>
              <span class="progress-text" id="bar-label">${barLabel(m)}</span>
            </div>` : m.wasCooking ? `
            <div class="feature notice" id="was-cooking">${esc(wasCookingText(m))}</div>`
            : select("mode", MODES.map((md) => ({ key: md.key, label: md.label, html: modeIcon(md.key) })), s.mode, off)}

          <div class="pair wide">
            ${slider("temp", live ? (m.temp === null ? 0 : (m.temp - tlo) / (thi - tlo)) : tValue === null ? 0 : (tValue - tlo) / (thi - tlo),
              live ? liveTempLabel(m) : tValue === null ? "—" : fmtTemp(tValue, " °C"), tDisabled,
              live && tValue !== null ? { mark: (tValue - tlo) / (thi - tlo) } : {})}
            <button class="feature toggle ${!live && s.sousVide ? "on" : ""}" id="sous-vide"
              title="Sous vide ${s.sousVide ? "on" : "off"}" aria-pressed="${s.sousVide}" ${off || live ? "disabled" : ""}>
              <ha-icon icon="mdi:water-thermometer"></ha-icon>
            </button>
          </div>

          <div class="se">
          ${slider("steam", steamFraction(m, s), steamLabel(m, s), off || live || s.sousVide, { buttons: false, tone: "steam" })}

            ${select("end", ENDS.map((e) => ({ key: e.key, label: e.key === "probe" && m.probe === null ? "Probe: plug the probe in to use it" : e.label,
              html: `<ha-icon icon="${e.icon}"></ha-icon>`, disabled: e.key === "probe" && m.probe === null && s.end !== "probe" })),
              live ? liveEnd(m) : s.end, off || live)}
            ${stepper("end", endValue(m, s), endDisabled(m, s, off), null,
              { buttons: (live ? liveEnd(m) !== "none" : s.end !== "none") && !m.done, editable: !endDisabled(m, s, off), editTitle: "Tap to type: minutes (90), 3m30s, 1h30 or 1:30" })}
          </div>

          <div class="pair go">
            ${live ? `
              ${stagePos(m).cur < stagePos(m).total ? `
                <button class="feature action ${m.nextReady ? "start" : ""}" id="next"
                  title="${m.nextReady ? "The next step waits for you" : "Skip the rest of this step"}">
                  <ha-icon icon="${m.nextReady ? "mdi:play" : "mdi:skip-next"}"></ha-icon>${m.nextReady ? `Start step ${stagePos(m).cur + 1}` : `Skip to step ${stagePos(m).cur + 1}`}</button>` : ""}
              <button class="feature action stop ${armed ? "armed" : ""}" id="stop">
                <ha-icon icon="mdi:stop"></ha-icon>${armed ? "Tap again to stop" : "Stop"}</button>` : `
              ${s.sel === 0 ? `
                <button class="feature toggle labeled ${s.preheat ? "on preheat" : ""}" id="preheat"
                  title="${s.preheat ? "Preheat on: the oven heats up first; step 1 and its timer start at temperature"
                    : "Preheat off: step 1 and its timer start now"}" aria-pressed="${s.preheat}" ${off ? "disabled" : ""}>
                  <ha-icon icon="${s.preheat ? "mdi:checkbox-marked-circle-outline" : "mdi:checkbox-blank-circle-outline"}"></ha-icon><span>Preheat</span>
                </button>` : `
                <button class="feature toggle labeled ${s.waits ? "on waits" : ""}" id="waits"
                  title="${s.waits ? `Step ${s.sel + 1} waits until you tap Next stage` : `Step ${s.sel + 1} starts when step ${s.sel} ends`}"
                  aria-pressed="${s.waits}" ${off ? "disabled" : ""}>
                  <ha-icon icon="${s.waits ? "mdi:hand-back-right-outline" : "mdi:arrow-right-bold-outline"}"></ha-icon>
                  <span>${s.waits ? "Wait" : "Auto"}</span>
                </button>`}
              ${off && m.plug === "off" ? `
              <button class="feature action start" id="power-on"><ha-icon icon="mdi:power"></ha-icon>Turn on</button>` : `
              <button class="feature action start" id="start" ${off || needsProbe || m.descaling ? "disabled" : ""}
                ${m.descaling ? `title="The oven descales. Start a cook after the descale."` : ""}>
                <ha-icon icon="mdi:play"></ha-icon>${startLabel(s)}</button>`}`}
          </div>
          `}
        </div>
      </ha-card>`;
    this._bind(m, { lo: tlo, hi: thi, disabled: tDisabled });
  }

  _recipes() {
    const list = (this._state("sensor", "recipes") || {}).attributes?.recipes;
    return Array.isArray(list) ? list.filter((r) => r && r.title && Array.isArray(r.stages)) : [];
  }

  _presetsView(m) {
    const recipes = this._recipes();
    const name = this._presetName ?? programTitle(this._setup);
    const exists = recipes.some((r) => r.title === name.trim());
    const armed = (key) => this._armed && this._armed.key === key && Date.now() < this._armed.until;
    const busy = !m.connected || m.cooking;
    return `
      <div class="panel">
        <div class="panel-head">
          <span>Presets</span>
          <button class="icon-state" id="panel-close" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        ${this._undo ? `
          <div class="item note">
            <div class="item-text"><b>Loaded “${esc(this._undo.title)}”</b><span>The steps are in the editor.</span></div>
            <button class="feature action item-btn" id="undo"><ha-icon icon="mdi:undo"></ha-icon>Undo</button>
          </div>` : ""}
        ${recipes.length ? recipes.map((r, i) => `
          <div class="item preset">
            <div class="item-text"><b>${esc(r.title)}</b><span>${esc(recipeSummary(r))}</span></div>
            <button class="icon-btn" data-load="${i}" title="Load into the editor"><ha-icon icon="mdi:tray-arrow-down"></ha-icon></button>
            <button class="icon-btn danger ${armed(`del:${r.title}`) ? "armed" : ""}" data-del="${i}"
              title="${armed(`del:${r.title}`) ? "Tap again to delete" : "Delete"}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
            <button class="icon-btn go" data-run="${i}" title="Start now" ${busy ? "disabled" : ""}><ha-icon icon="mdi:play"></ha-icon></button>
          </div>`).join("") : `
          <div class="item"><div class="item-text"><b>No presets yet</b>
            <span>Set up the steps, then save them below.</span></div></div>`}
        <div class="save-row">
          <input class="feature name" id="preset-name" type="text" maxlength="60" value="${esc(name)}"
            placeholder="Preset name" aria-label="Preset name">
          <button class="feature action ${exists ? "stop" : "save"} ${armed("save") ? "armed" : ""} item-btn" id="save"
            ${!m.connected || !name.trim() ? "disabled" : ""}>
            <ha-icon icon="mdi:content-save-outline"></ha-icon>${exists ? (armed("save") ? "Tap to replace" : "Replace") : "Save"}</button>
        </div>
      </div>`;
  }

  // Two-tap actions (delete, replace): the first tap arms for 3 s.
  _confirm(key, action) {
    if (this._armed && this._armed.key === key && Date.now() < this._armed.until) {
      this._armed = null;
      action();
    } else {
      this._armed = { key, until: Date.now() + STOP_CONFIRM_MS };
      setTimeout(() => this._render(), STOP_CONFIRM_MS + 50);
    }
    this._render();
  }

  _savePreset() {
    const name = (this._presetName ?? programTitle(this._setup)).trim();
    if (!name) return;
    const exists = this._recipes().some((r) => r.title === name);
    const save = () => {
      this._call("mqtt", "publish", {
        topic: `${this._config.mqtt_prefix}/cmd/save_recipe`,
        payload: JSON.stringify({ title: name, stages: programStages(this._setup), ...(exists ? { replace: name } : {}) }),
      });
      this._presetName = undefined;
    };
    if (exists) this._confirm("save", save);
    else { save(); this._render(); }
  }

  _loadPreset(r) {
    const program = programFromStages(r.stages);
    if (!program) return;
    this._undo = { title: r.title, setup: this._setup };
    this._setProgram(program);
    setTimeout(() => { if (this._undo && this._undo.title === r.title) { this._undo = null; this._render(); } }, 15000);
  }

  _maintenanceView(m) {
    const busy = !m.connected || m.cooking;
    return `
      <div class="panel">
        <div class="panel-head">
          <span>Maintenance</span>
          <span class="head-tags" ${m.descale ? `title="Fill the tank with descaler and water, press the descale symbol on the oven, then Start on the handle."` : ""}>
            Descale <span class="tag ${m.descale ? "warn" : m.descale === null ? "unknown" : ""}">${m.descale ? "needed" : m.descale === null ? "unknown" : "not needed"}</span>
            ${m.waterEmpty ? `Water <span class="tag warn">empty</span>` : ""}
          </span>
          <button class="icon-state" id="tools-close" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <div class="item" title="Runs by itself: rear 176 °C for 15 min, a 15-minute cool-down with the vent open, top and bottom 176 °C for 15 min, then a cool-down until you tap Stop.">
          <div class="item-text">
            <b>Heating element prep</b>
            <span>45 min · ends with a cool-down until Stop</span>
          </div>
          <button class="feature action start item-btn" id="prep" ${busy ? "disabled" : ""}><ha-icon icon="mdi:play"></ha-icon>Start</button>
        </div>
        ${m.hasPlug ? this._powerItem(m) : ""}
        ${m.autoStop === null ? "" : `
        <div class="item">
          <div class="item-text">
            <b>Auto stop <span class="tag ${m.autoStop ? "" : "unknown"}">${m.autoStop ? "on" : "off"}</span></b>
            <span>${m.autoStop ? "Stops the oven when the last timer ends" : "The oven holds the temperature after the last timer"}</span>
          </div>
          <button class="feature toggle labeled item-btn ${m.autoStop ? "on" : ""}" id="auto-stop" aria-pressed="${m.autoStop}">
            <ha-icon icon="${m.autoStop ? "mdi:checkbox-marked-circle-outline" : "mdi:checkbox-blank-circle-outline"}"></ha-icon><span>${m.autoStop ? "On" : "Off"}</span></button>
        </div>`}
      </div>`;
  }

  _powerItem(m) {
    const p = powerAction(m, this._config.power_idle_w);
    const armed = p.action && this._armed && this._armed.key === `power:${p.action}` && Date.now() < this._armed.until;
    const tag = m.plug === null ? "unknown" : `${m.plug}${m.watts !== null ? ` · ${fmtWatts(m.watts)}` : ""}`;
    const label = { on: "Turn on", off: "Turn off", restart: "Restart" }[p.action];
    return `
        <div class="item">
          <div class="item-text">
            <b>Power <span class="tag ${m.plug === "off" ? "warn" : ""}">${esc(tag)}</span></b>
            ${p.action && p.action !== "restart" ? "" : `<span title="${esc(p.why)}">${esc(p.why)}</span>`}
          </div>
          ${p.action ? `<button class="feature action ${p.action === "on" ? "start" : "stop"} item-btn ${armed ? "armed" : ""}" id="power-${p.action}">
            <ha-icon icon="mdi:${p.action === "restart" ? "restart" : "power"}"></ha-icon>${armed ? "Tap again" : label}</button>` : ""}
        </div>`;
  }

  // Turn on is one tap. Turn off and Restart need a second tap.
  _power(action) {
    const id = this._config.power_switch;
    if (!id) return;
    if (action === "on") { this._call("switch", "turn_on", { entity_id: id }); return; }
    this._confirm(`power:${action}`, () => {
      // Check again: the oven may have started or heated since the render.
      if (powerAction(this._model(), this._config.power_idle_w).action !== action) return;
      this._call("switch", "turn_off", { entity_id: id });
      if (action === "restart") setTimeout(() => this._call("switch", "turn_on", { entity_id: id }), RESTART_OFF_MS);
    });
  }

  // Heating element prep, from the oven's manual, fully automatic: rear
  // 176 °C for 15 min, a 15-minute cool-down, top and bottom 176 °C for
  // 15 min, then a cool-down that lasts until Stop, so the oven does not
  // hold 176 °C at the end.
  _startPrep() {
    const stage = (elements, temp, extra = {}) => ({
      kind: "cook", temperature_c: temp, temperature_bulbs_mode: "dry", steam_pct: 0, fan_speed: 100,
      heating_element_top: elements.includes("top"),
      heating_element_rear: elements.includes("rear"),
      heating_element_bottom: elements.includes("bottom"),
      user_action_required: false, ...extra,
    });
    const timed = { timer_added: true, duration_secs: 15 * 60 };
    const cool = { vent_open: true, title: "Cool down" };
    this._publishStart("Element prep", [
      stage(["rear"], 176, { ...timed, title: "Rear 176 °C" }),
      stage(["rear"], COOL_C, { ...timed, ...cool }),
      stage(["top", "bottom"], 176, { ...timed, title: "Top and bottom 176 °C" }),
      stage(["rear"], COOL_C, cool),
    ]);
    this._panel = null;
    this._render();
  }

  _bind(m, temp) {
    const root = this.shadowRoot;
    const $ = (id) => root.getElementById(id);
    if ($("lamp")) $("lamp").onclick = () => this._toggleLamp();
    if ($("stop")) $("stop").onclick = () => this._stop();
    if ($("start")) $("start").onclick = () => this._start();
    if ($("next")) $("next").onclick = () => this._nextStage();
    if ($("sous-vide")) $("sous-vide").onclick = () => this._update({ sousVide: !this._view().sousVide });
    if ($("waits")) $("waits").onclick = () => this._update({ waits: !this._view().waits });
    if ($("step-add")) $("step-add").onclick = () => this._addStep();
    if ($("step-remove")) $("step-remove").onclick = (ev) => { ev.stopPropagation(); this._removeStep(); };
    root.querySelectorAll("[data-chip]").forEach((b) => {
      b.onclick = () => { if (Number(b.dataset.chip) !== this._setup.sel) this._update({ sel: Number(b.dataset.chip) }); };
    });
    if ($("preheat")) $("preheat").onclick = () => this._update({ preheat: !this._setup.preheat });
    if ($("tools")) $("tools").onclick = () => { this._panel = this._panel === "maintenance" ? null : "maintenance"; this._render(); };
    if ($("presets")) $("presets").onclick = () => { this._panel = "presets"; this._undo = null; this._render(); };
    if ($("panel-close")) $("panel-close").onclick = () => { this._panel = null; this._undo = null; this._presetName = undefined; this._render(); };
    if ($("undo")) $("undo").onclick = () => { const u = this._undo; this._undo = null; if (u) this._setProgram(u.setup); };
    if ($("save")) $("save").onclick = () => this._savePreset();
    if ($("end-edit")) $("end-edit").onclick = () => this._editEnd(m);
    const nameInput = $("preset-name");
    if (nameInput) {
      nameInput.oninput = () => { this._presetName = nameInput.value; this._refreshSaveButton(); };
      nameInput.onfocus = () => { this._typing = true; };
      nameInput.onblur = () => { this._typing = false; if (this._dirty) { this._dirty = false; this._render(); } };
      nameInput.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); nameInput.blur(); this._savePreset(); } };
    }
    const recipes = this._panel === "presets" ? this._recipes() : [];
    root.querySelectorAll("[data-load]").forEach((b) => { b.onclick = () => this._loadPreset(recipes[Number(b.dataset.load)]); });
    root.querySelectorAll("[data-run]").forEach((b) => {
      b.onclick = () => {
        const r = recipes[Number(b.dataset.run)];
        this._publishStart(r.title, r.stages);
        this._panel = null;
        this._render();
      };
    });
    root.querySelectorAll("[data-del]").forEach((b) => {
      const r = recipes[Number(b.dataset.del)];
      b.onclick = () => this._confirm(`del:${r.title}`, () => this._call("mqtt", "publish", {
        topic: `${this._config.mqtt_prefix}/cmd/delete_recipe`, payload: r.title }));
    });
    if ($("tools-close")) $("tools-close").onclick = () => { this._panel = null; this._render(); };
    if ($("prep")) $("prep").onclick = () => this._startPrep();
    if ($("auto-stop")) $("auto-stop").onclick = () => this._call("switch", m.autoStop ? "turn_off" : "turn_on",
      { entity_id: this._id("switch", "auto_stop") });
    for (const action of ["on", "off", "restart"]) {
      if ($(`power-${action}`)) $(`power-${action}`).onclick = () => this._power(action);
    }
    root.querySelectorAll("[data-select]").forEach((b) => {
      b.onclick = () => this._update({ [b.dataset.select]: b.dataset.key });
    });

    // - and +: a tap is one step. Holding repeats in the setup, but not on a
    // running cook, where each step is a command to the oven.
    root.querySelectorAll("[data-step]").forEach((b) => {
      const [what, dir] = b.dataset.step.split(":");
      const step = () => this._step(what, Number(dir), this._liveModel());
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

    // Sliders: drag for big changes; the value commits on release.
    this._bindDrag("temp", { ...temp, step: m.cooking ? 1 : this._view().sousVide ? 0.5 : 1,
      label: (v) => (m.cooking ? `${m.temp === null ? "—" : Math.round(m.temp)} → ${Math.round(v)} °C` : fmtTemp(v, " °C")),
      commit: (v) => (m.cooking ? this._setTarget(v, m.wet) : this._update({ temp: v })) });
    this._bindDrag("steam", { lo: 0, hi: 100, step: 10, disabled: m.cooking || !m.connected || this._view().sousVide,
      label: (v) => steamLabel(m, { ...this._view(), steam: v }),
      commit: (v) => this._update({ steam: v }) });
  }

  _bindDrag(what, o) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const track = $(`${what}-track`);
    if (!track || o.disabled) return;
    const valueAt = (ev) => {
      const r = track.getBoundingClientRect();
      const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
      return clamp(Math.round((o.lo + f * (o.hi - o.lo)) / o.step) * o.step, o.lo, o.hi);
    };
    const show = (v) => {
      // While cooking, the fill is the oven's temperature; dragging moves
      // the target mark.
      const mark = $(`${what}-mark`);
      if (mark) mark.style.left = markLeft((v - o.lo) / (o.hi - o.lo));
      else $(`${what}-fill`).style.width = pct((v - o.lo) / (o.hi - o.lo));
      $(`${what}-value`).textContent = o.label(v);
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
        // _update re-renders after the hold ends; skip its own render here.
        this._holding = true;
        o.commit(value);
      });
    };
  }

  // Run `cleanup`, then re-render, when the pointer is released anywhere.
  _endHold(cleanup) {
    const end = () => {
      if (!this._holding) return;
      cleanup();
      this._holding = false;
      this._dirty = false;
      this._render();
    };
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }

  _renderValues() {
    const s = this._view();
    const m = this._liveModel();
    const set = (id, text) => { const el = this.shadowRoot.getElementById(id); if (el) el.textContent = text; };
    const [lo, hi] = LIMITS[s.sousVide ? "wet" : "dry"];
    set("temp-value", fmtTemp(s.temp, " °C"));
    const fill = this.shadowRoot.getElementById("temp-fill");
    if (fill) fill.style.width = pct((s.temp - lo) / (hi - lo));
    set("end-value", endValue(m, s));
    set("steam-value", steamLabel(m, s));
    const steamFill = this.shadowRoot.getElementById("steam-fill");
    if (steamFill) steamFill.style.width = pct(steamFraction(m, s));
  }

  _renderLive() {
    if (!this.shadowRoot || !this._hass || this._holding) return;
    const m = this._liveModel();
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!warningText(m) && $("secondary")) $("secondary").innerHTML = statusLine(m, "");
    if (m.cooking) {
      if ($("bar")) $("bar").style.width = pct(progress(m));
      if ($("bar-label")) $("bar-label").innerHTML = barLabel(m);
      if ($("end-value")) $("end-value").textContent = endValue(m, this._view());
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
          aria-checked="${current === o.key}" title="${o.label}" aria-label="${o.label}" ${disabled || o.disabled ? "disabled" : ""}>${o.html}</button>`).join("")}
    </div>`;
}

// HA's number-buttons feature: [ -   value   + ] in one 42 px row.
function stepper(what, value, disabled, icon, opts = {}) {
  const buttons = opts.buttons !== false;
  return `
    <div class="feature stepper ${disabled ? "disabled" : ""} ${buttons ? "" : "bare"}">
      ${buttons ? `<button class="pm" data-step="${what}:-1" aria-label="Less" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:minus"></ha-icon></button>` : ""}
      ${opts.editable
        ? `<button class="value editable" id="${what}-edit" title="${esc(opts.editTitle || "Tap to type")}">${icon ? `<ha-icon icon="${icon}"></ha-icon>` : ""}<span id="${what}-value">${esc(value)}</span></button>`
        : `<span class="value">${icon ? `<ha-icon icon="${icon}"></ha-icon>` : ""}<span id="${what}-value">${esc(value)}</span></span>`}
      ${buttons ? `<button class="pm" data-step="${what}:1" aria-label="More" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button>` : ""}
    </div>`;
}

// HA's slider feature with - and + at the ends: drag for big changes,
// tap - or + for one step.
function slider(what, f, label, disabled, opts = {}) {
  const buttons = opts.buttons !== false;
  return `
    <div class="feature slider ${opts.tone || ""} ${buttons ? "" : "bare"} ${disabled ? "disabled" : ""}">
      ${buttons ? `<button class="pm" data-step="${what}:-1" aria-label="Lower" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:minus"></ha-icon></button>` : ""}
      <div class="track" id="${what}-track" role="slider" aria-valuetext="${esc(label)}">
        <div class="fill ${opts.mark !== undefined ? "current" : ""}" id="${what}-fill" style="width:${pct(f)}"></div>
        ${opts.mark !== undefined ? `<div class="mark" id="${what}-mark" style="left:${markLeft(opts.mark)}"></div>` : ""}
        <span class="track-value" id="${what}-value">${esc(label)}</span>
      </div>
      ${buttons ? `<button class="pm" data-step="${what}:1" aria-label="Higher" ${disabled ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button>` : ""}
    </div>`;
}

// The mark's centre, kept 6 px inside the track so the track never clips it
// at 0 or 100 %.
function markLeft(f) {
  return `calc(6px + (100% - 12px) * ${clamp(f, 0, 1)})`;
}

// The running step, from the server's stages; null when unknown.
function runningStage(m) {
  const { cur, total } = stagePos(m);
  return Array.isArray(m.stages) && m.stages.length === total ? m.stages[cur - 1] || null : null;
}

// How the running step ends. A finished timer stays "timer".
function liveEnd(m) {
  const st = runningStage(m);
  if (st) return st.probe_added ? "probe" : st.timer_added || st.duration_secs ? "timer" : "none";
  return m.timerTotal || m.done ? "timer" : m.probe !== null ? "probe" : "none";
}

// During a cook, the steam row shows the running step's steam setting. The
// oven reports a humidity reading only in its relative-humidity mode; in
// the steam-percentage mode the card uses, the reading stays 0.
function steamFraction(m, s) {
  if (m.cooking) {
    const st = runningStage(m);
    return (st ? st.steam_pct || 0 : m.steam || 0) / 100;
  }
  return (s.sousVide ? 100 : s.steam) / 100;
}

function steamLabel(m, s) {
  if (m.cooking) {
    const st = runningStage(m);
    if (st) return st.temperature_bulbs_mode === "wet" ? "100 % (sous vide)" : st.steam_pct ? `Steam ${Math.round(st.steam_pct)} %` : "No steam";
    return m.steam === null ? "Steam —" : `Steam ${Math.round(m.steam)} %`;
  }
  if (s.sousVide) return "100 % (sous vide)";
  return s.steam ? `Steam ${s.steam} %` : "No steam";
}

function endValue(m, s) {
  if (m.cooking) {
    if (m.done) return "Done";
    const left = remaining(m);
    if (left !== null) return clock(left);
    if (m.probe !== null) return `Probe ${Math.round(m.probe)} °C`;
    const since = m.stageStart || m.cookStart;
    return since ? `${clock(elapsed(since))} in` : NO_END;
  }
  if (s.end === "timer") return clock(Math.round(s.timer * 60));
  if (s.end === "probe") return m.probe === null ? "Plug in the probe" : `Probe to ${s.probe} °C`;
  return NO_END;
}

function endDisabled(m, s, off) {
  if (off) return true;
  if (m.cooking) return !m.timerTotal; // Only a running timer can change.
  return s.end === "none";
}

// Icons for the element choices, like the handle: a box with the heated
// side drawn bold for top and bottom, and a plain fan for the rear element.
// With the rear, a short line above or below the fan adds top or bottom.
function modeIcon(key) {
  const box = `<rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55"/>`;
  const top = `<rect x="4" y="4" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const bottom = `<rect x="4" y="16.8" width="16" height="3.2" rx="1.2" fill="currentColor"/>`;
  const fan = (cy, r) => `<circle cx="12" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M12 ${cy} L12 ${cy - r * 0.62} M12 ${cy} L${12 + r * 0.54} ${cy + r * 0.31} M12 ${cy} L${12 - r * 0.54} ${cy + r * 0.31}"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  const line = (y) => `<rect x="6" y="${y}" width="12" height="2.6" rx="1.3" fill="currentColor"/>`;
  const inner = {
    top: box + top,
    bottom: box + bottom,
    top_bottom: box + top + bottom,
    rear: fan(12, 7),
    rear_top: line(3) + fan(14, 5.6),
    rear_bottom: fan(10, 5.6) + line(18.4),
  }[key];
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${inner}</svg>`;
}

// The oven stages for a program: an optional preheat, then one cook stage
// per step.
function programStages(p) {
  const stages = [];
  p.steps.forEach((st, i) => {
    const base = stageBase(st);
    if (i === 0 && p.preheat) stages.push({ ...base, kind: "preheat" });
    const cook = { ...base, kind: "cook", user_action_required: i > 0 && st.waits };
    if (st.end === "timer") Object.assign(cook, { timer_added: true, duration_secs: Math.round(st.timer * 60) });
    if (st.end === "probe") Object.assign(cook, { probe_added: true, probe_target_c: st.probe });
    stages.push(cook);
  });
  return stages;
}

// A saved recipe's stages back into steps. A first preheat stage becomes
// "Preheat on"; any later preheat becomes a step that holds until you move on.
function programFromStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return null;
  let preheat = false;
  const steps = [];
  stages.forEach((sg, i) => {
    if (i === 0 && sg.kind === "preheat" && stages.length > 1) { preheat = true; return; }
    const els = ["top", "rear", "bottom"].filter((e) => sg[`heating_element_${e}`]);
    const mode = (MODES.find((md) => md.elements.length === els.length && md.elements.every((e) => els.includes(e))) || MODES[1]).key;
    const st = {
      ...DEFAULT_STEP,
      mode,
      sousVide: sg.temperature_bulbs_mode === "wet",
      temp: Number(sg.temperature_c) || DEFAULT_STEP.temp,
      steam: Math.round((Number(sg.steam_pct) || 0) / 10) * 10,
      end: sg.timer_added && sg.duration_secs ? "timer" : sg.probe_added && sg.probe_target_c ? "probe" : "none",
      timer: sg.duration_secs ? Math.max(1, Math.round(sg.duration_secs) / 60) : DEFAULT_STEP.timer,
      probe: sg.probe_target_c || DEFAULT_STEP.probe,
      waits: steps.length > 0 && !!sg.user_action_required,
    };
    normalizeStep(st);
    steps.push(st);
  });
  return steps.length ? { steps: steps.slice(0, MAX_STEPS), sel: 0, preheat } : null;
}

function recipeSummary(r) {
  const cooks = r.stages.filter((sg) => sg.kind !== "preheat");
  const first = cooks[0] || r.stages[0];
  const temp = first ? `${Math.round(first.temperature_c)}°` : "";
  const sv = r.stages.some((sg) => sg.temperature_bulbs_mode === "wet") ? " · sous vide" : "";
  const n = cooks.length > 1 ? ` · ${cooks.length} steps` : "";
  return `${temp}${sv}${n}`;
}

// Minutes from "90", "3.5", "1h30", "1 h 30 m", "45m", "2h", "1:30" (h:mm),
// "1:30:15" or "1:30.15" (h:mm:ss), "3m30s", "3m30" or "90s". The result can have
// seconds: "3m30s" is 3.5. A number after "h" is minutes; after "m", seconds.
function parseMinutes(text) {
  const t = String(text).trim().toLowerCase().replace(/\s+/g, "").replace(",", ".");
  if (!t) return null;
  const n = (v) => Number(v || 0);
  const secs = (h, m, s) => Math.round(n(h) * 3600 + n(m) * 60 + n(s)) / 60;
  let m;
  // One decimal digit only: "1.30" could mean 1 h 30 or 1 min 30.
  if ((m = /^(\d+(?:\.\d)?)$/.exec(t))) return Math.round(Number(m[1]) * 60) / 60;
  if ((m = /^(\d+):(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(t))) return secs(m[1], m[2], m[3]);
  if ((m = /^(\d+)(?:s|sec)$/.exec(t))) return secs(0, 0, m[1]);
  if ((m = /^(?:(\d+)h)?(\d+)(?:m|min)(?:(\d+)(?:s|sec)?)?$/.exec(t))) return secs(m[1], m[2], m[3]);
  if ((m = /^(\d+)h(?:(\d+)(?:m|min)?)?$/.exec(t))) return secs(m[1], m[2], 0);
  return null;
}

// Minutes as the timer field shows them: "90"; with seconds "3m30s", or
// "1:02.05" from an hour.
function fmtMinutes(min) {
  const total = Math.round(min * 60);
  if (!(total % 60)) return String(total / 60);
  if (total < 3600) return `${Math.floor(total / 60)}m${total % 60}s`;
  const two = (n) => String(n).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${two(Math.floor((total % 3600) / 60))}.${two(total % 60)}`;
}

function stageBase(st) {
  const elements = MODES.find((m) => m.key === st.mode).elements;
  return {
    temperature_c: st.temp,
    temperature_bulbs_mode: st.sousVide ? "wet" : "dry",
    steam_pct: st.sousVide ? 100 : st.steam,
    fan_speed: 100,
    heating_element_top: elements.includes("top"),
    heating_element_rear: elements.includes("rear"),
    heating_element_bottom: elements.includes("bottom"),
  };
}

function normalizeStep(st) {
  const [lo, hi] = LIMITS[st.sousVide ? "wet" : "dry"];
  st.temp = clamp(st.sousVide ? Math.round(st.temp * 10) / 10 : Math.round(st.temp), lo, hi);
  st.timer = clamp(Math.round(st.timer * 60) / 60, 1, 24 * 60);
  st.probe = clamp(Math.round(st.probe), ...LIMITS.probe);
  st.steam = clamp(st.steam, 0, 100);
}

function stepTitle(st) {
  const mode = MODES.find((m) => m.key === st.mode).label;
  return st.sousVide ? `Sous vide ${fmtTemp(st.temp, " °C")}` : `${mode} ${fmtTemp(st.temp, " °C")}${st.steam ? `, ${st.steam} % steam` : ""}`;
}

// Short program names: "180 °C", "Sous vide 56 °C", "220 °C · 30 % steam",
// "220 → 180 °C · 2 steps".
function programTitle(p) {
  const first = p.steps[0];
  if (p.steps.length === 1) {
    if (first.sousVide) return `Sous vide ${fmtTemp(first.temp, " °C")}`;
    return `${fmtTemp(first.temp, " °C")}${first.steam ? ` · ${first.steam} % steam` : ""}`;
  }
  const last = p.steps[p.steps.length - 1];
  const temps = first.temp === last.temp ? fmtTemp(first.temp, " °C") : `${fmtTemp(first.temp, "")} → ${fmtTemp(last.temp, " °C")}`;
  return `${temps} · ${p.steps.length} steps`;
}

function startLabel(s) {
  const verb = s.steps.every((st) => st.sousVide) ? "Cook" : "Bake";
  return s.steps.length > 1 ? `${verb} · ${s.steps.length} steps` : verb;
}

// The steps row: one chip per step (tap to edit it), x on the selected
// chip to remove it, and + to add a copy of the selected step.
function stepChips(s, off) {
  const book = `<button class="chip-step book" id="presets" title="Presets" aria-label="Presets" ${off ? "disabled" : ""}>
    <ha-icon icon="mdi:book-open-variant"></ha-icon></button>`;
  const chip = (st, i) => {
    const on = i === s.sel;
    const icons = `${st.sousVide ? `<ha-icon icon="mdi:water-thermometer"></ha-icon>` : ""}${!st.sousVide && st.steam ? `<ha-icon icon="mdi:water-percent"></ha-icon>` : ""}${st.end === "timer" ? `<ha-icon icon="mdi:timer-outline"></ha-icon>` : st.end === "probe" ? `<ha-icon icon="mdi:thermometer-probe"></ha-icon>` : ""}${i > 0 && st.waits ? `<ha-icon icon="mdi:hand-back-right-outline"></ha-icon>` : ""}`;
    return `
      <button class="chip-step ${on ? "on" : ""}" data-chip="${i}" title="Step ${i + 1}: ${esc(stepTitle(st))}" ${off ? "disabled" : ""}>
        <span class="n">${i + 1}</span><span>${fmtTemp(st.temp)}</span>${icons}
        ${on && s.steps.length > 1 ? `<span class="x" id="step-remove" role="button" title="Remove step ${i + 1}"><ha-icon icon="mdi:close"></ha-icon></span>` : ""}
      </button>`;
  };
  return `
    <div class="feature steps" role="tablist" aria-label="Steps">
      ${book}
      ${s.steps.map(chip).join("")}
      <button class="chip-step add" id="step-add" title="Add a step (a copy of step ${s.sel + 1})"
        ${off || s.steps.length >= MAX_STEPS ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
}

// While cooking: the running cook's stages, done ones ticked.
function runningChips(m) {
  const { cur, total } = stagePos(m);
  const known = Array.isArray(m.stages) && m.stages.length === total ? m.stages : null;
  const chips = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const state = n < cur || (m.done && n === cur) ? "done" : n === cur ? "on" : "";
    const sg = known && known[i];
    const cool = sg && sg.temperature_c <= COOL_C && sg.vent_open;
    const label = !sg ? "" : cool ? `<ha-icon icon="mdi:snowflake"></ha-icon>`
      : `<span>${sg.kind === "preheat" ? "↑" : ""}${Math.round(sg.temperature_c)}°</span>`;
    return `<span class="chip-step ${state}" title="${sg ? esc(sg.title || (sg.kind === "preheat" ? "Preheat" : `${Math.round(sg.temperature_c)} °C`)) : `Stage ${n}`}">
      <span class="n">${state === "done" ? "✓" : n}</span>${label}</span>`;
  }).join("");
  return `<div class="feature steps running" aria-label="Stages">${chips}</div>`;
}

function fmtTemp(v, unit = "°") {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`;
}

function warningText(m) {
  if (!m.appUp) return "The Anova app in Home Assistant is not running";
  if (!m.connected && m.plug === "off") return "Power off";
  if (!m.connected && m.wasCooking && m.offlineSince) return `Offline since ${hhmm(m.offlineSince)}`;
  if (!m.connected) return m.plug === "on" ? "Offline: check the oven's Wi-Fi" : "Offline: check the oven's power and Wi-Fi";
  if (m.waterEmpty) return "Water tank empty";
  if (m.cooking && m.door) return "Door open";
  if (m.descale && !m.descaling) return "Descale needed";
  return "";
}

function timerStep(minutes, dir) {
  // 1-minute steps up to 10, then 5 up to 60, then 15, like a kitchen timer.
  const at = dir < 0 ? minutes - 1 : minutes;
  return at < 10 ? 1 : at < 60 ? 5 : 15;
}

// Seconds left, rounded up: the last second shows 0:01, as on the oven.
function remaining(m) {
  return m.endsAt ? Math.max(0, Math.ceil((m.endsAt - Date.now()) / 1000 - 0.05)) : null;
}

// Whole seconds since `since`, which is moved to its full second first.
// With the tick just after each full second, the value goes up by one each
// tick, never two, and never stays.
function elapsed(since) {
  return Math.max(0, Math.floor((Date.now() - Math.round(since / 1000) * 1000) / 1000));
}

function progress(m) {
  if (m.done) return 1;
  const left = remaining(m);
  if (left !== null && m.timerTotal) return 1 - left / m.timerTotal;
  if (m.temp !== null && m.target) return m.temp / m.target;
  return 0;
}

// The status line: the oven's state when idle, the program's name while
// cooking. Details are in the progress row.
function secondary(m) {
  const temp = m.temp === null ? "—" : `${Math.round(m.temp)} °C`;
  const probe = m.probe !== null ? ` · probe ${Math.round(m.probe)} °C` : "";
  if (m.descaling) return `Descaling${m.descaleSince ? ` since ${hhmm(m.descaleSince)}` : ""} · ${temp}`;
  if (!m.cooking) return `Idle · ${temp}${probe}`;
  return esc(`${m.recipe || "Cooking"}${probe}`);
}

// What the power button may do now, and why. The rule: never cut power
// during a cook, or while an offline oven may still cook.
function powerAction(m, idleW) {
  if (m.plug === null) return { action: null, why: "The plug does not report its state." };
  if (m.plug === "off") return { action: "on", why: "The oven has no power." };
  if (m.connected) {
    if (m.cooking) return { action: null, why: "Stop the cook first." };
    if (m.descaling) return { action: null, why: "The oven descales." };
    return { action: "off", why: "The oven is idle." };
  }
  if (m.watts === null) return { action: null, why: "Offline. Without a power reading, the card cannot tell if the oven still runs." };
  if (m.watts > idleW) return { action: null, why: `Offline, but it draws ${fmtWatts(m.watts)}: the oven may still run.` };
  return { action: "restart", why: "Offline and idle: off for 10 s, then on. This often fixes the Wi-Fi." };
}

// The status line: the text shortens with "…", the power draw never does.
function statusLine(m, warning) {
  const main = warning ? esc(warning) : secondary(m);
  const power = powerText(m);
  return `<span class="sec-main">${main}</span>${power ? `<span class="sec-power">${esc(power)}</span>` : ""}`;
}

function powerText(m) {
  return m.watts === null ? "" : ` · ${fmtWatts(m.watts)}`;
}

function fmtWatts(w) {
  return w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
}

function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function wasCookingText(m) {
  const temp = m.lastTarget !== null ? ` at ${Math.round(m.lastTarget)} °C` : "";
  return `Was cooking${temp} · it may still run`;
}

// "1 of 3" from the Stage sensor.
function stagePos(m) {
  const match = /^(\d+) of (\d+)$/.exec(m.stage || "");
  return match ? { cur: Number(match[1]), total: Number(match[2]) } : { cur: 1, total: 1 };
}

function barLabel(m) {
  const { cur, total } = stagePos(m);
  const step = total > 1 ? `Step ${cur}/${total}` : "";
  const desc = /cool/i.test(m.stageDescription || "") ? "Cooling down" : m.phase === "Preheating" ? "Preheating" : "";
  let left;
  if (m.done) left = `Done · holding ${m.target !== null ? `${Math.round(m.target)} °C` : "the temperature"}`;
  else if (m.nextReady) left = `Step ${cur + 1} waits for you`;
  else left = [step, desc].filter(Boolean).join(" · ") || m.phase;
  const rem = remaining(m);
  const end = m.autoStop && stagePos(m).cur === stagePos(m).total ? "Stops" : "Ends";
  const right = m.done || m.nextReady ? "" : rem !== null ? `${end} ${hhmm(Date.now() + rem * 1000)}`
    : m.stageStart || m.cookStart ? `Since ${hhmm(m.stageStart || m.cookStart)}` : "";
  return `<span>${esc(left)}</span><span>${esc(right)}</span>`;
}

function liveTempLabel(m) {
  const r = (v) => (m.wet ? fmtTemp(Math.round(v * 10) / 10, "") : Math.round(v));
  const now = m.temp === null ? "—" : r(m.temp);
  return m.target === null ? `${now} °C` : `${now} → ${r(m.target)} °C`;
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
    if (saved && Array.isArray(saved.steps) && saved.steps.length) {
      const steps = saved.steps
        .filter((st) => st && MODES.some((m) => m.key === st.mode))
        .slice(0, MAX_STEPS)
        .map((st) => { const x = { ...DEFAULT_STEP, ...st }; normalizeStep(x); return x; });
      if (steps.length) {
        return { steps, sel: clamp(Number(saved.sel) || 0, 0, steps.length - 1), preheat: saved.preheat !== false };
      }
    }
    // A single setup from card 0.3 to 0.7.
    if (saved && typeof saved === "object" && MODES.some((m) => m.key === saved.mode)) {
      const st = { ...DEFAULT_STEP };
      for (const k of STEP_KEYS) if (k in saved) st[k] = saved[k];
      if (saved.bulb === "wet") st.sousVide = true;
      if (!("end" in saved) && saved.timer > 0) st.end = "timer";
      if (!(st.timer > 0)) st.timer = DEFAULT_STEP.timer;
      normalizeStep(st);
      return { steps: [st], sel: 0, preheat: saved.preheat !== false };
    }
  } catch (_) { /* no storage */ }
  return { ...DEFAULT_SETUP, steps: [{ ...DEFAULT_STEP }] };
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
  ha-card { padding: 12px; display: flex; flex-direction: column; gap: var(--gap); height: 100%; box-sizing: border-box;
    }
  /* Colour rule: orange = heat, light blue = water, neutral raised chip =
     selected, amber = needs attention. */
  :host { display: block; --selected-bg: var(--card-background-color, #fff); --selected-shadow: 0 1px 3px rgba(0, 0, 0, .16); }
  ha-card.active { --tone-rgb: var(--oven-rgb); }
  ha-card.error { --tone-rgb: var(--rgb-error-color, 219, 68, 55); }
  button { font: inherit; border: none; cursor: pointer; color: inherit; background: none; padding: 0;
    -webkit-tap-highlight-color: transparent; }
  button:disabled { cursor: default; }

  /* Header: the tile card's icon and two text lines. */
  .header { display: flex; align-items: center; gap: 4px; height: 40px; }
  .header .info { margin: 0 6px 0 6px; }
  .shape { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    background: rgba(var(--tone-rgb), .2); color: rgb(var(--tone-rgb)); }
  .shape ha-icon { --mdc-icon-size: 20px; }
  .info { flex: 1; min-width: 0; }
  .primary { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--primary-text-color); }
  .secondary { font-size: 12px; line-height: 16px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .secondary { display: flex; min-width: 0; }
  .secondary .sec-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .secondary .sec-power { flex: none; white-space: pre; }
  .secondary.warn { color: var(--error-color, #db4437); font-weight: 500; }
  .icon-state { flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
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
  /* Steam sits next to the timer when the row fits: ends 126 + timer 130 +
     steam 90 + two gaps = 370 px inside the card (about 394 px card width).
     The query measures the card's content box, inside its padding. */
  ha-card.wide .se { grid-template-columns: calc(var(--h) * 3) minmax(130px, 1fr) minmax(90px, 1fr);
    grid-template-areas: "ends val steam"; }
  ha-card.wide .panel { height: calc(var(--h) * 5 + var(--gap) * 4); }

  /* Select (HA's select and hvac-modes features). */
  .select { display: flex; background: var(--track); overflow: hidden; }
  .option { flex: 1; min-width: 0; display: grid; place-items: center; color: var(--secondary-text-color); border-radius: var(--r); }
  .option ha-icon { --mdc-icon-size: 20px; }
  .select { padding: 3px; gap: 3px; }
  .option { border-radius: 9px; }
  .option.on { background: var(--selected-bg); color: var(--primary-text-color); box-shadow: var(--selected-shadow); }
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
  .stepper.disabled .pm, .stepper.disabled:not(.bare) .value, .slider.disabled .pm, .slider.disabled .track { opacity: .4; }
  .track { position: relative; flex: 1; align-self: stretch; margin: 6px 0; border-radius: 8px; overflow: hidden;
    background: rgba(var(--oven-rgb), .14); cursor: pointer; touch-action: none; user-select: none; }
  .slider.disabled .track { cursor: default; }
  .slider.bare { background: none; }
  .fill.current { background: linear-gradient(90deg, rgba(var(--oven-rgb), .25), rgba(var(--oven-rgb), .6)); }
  .fill.current::after { display: none; }
  .mark { position: absolute; top: 50%; width: 4px; height: 22px; margin: -11px 0 0 -2px; border-radius: 2px;
    background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .25), 0 0 3px rgba(0, 0, 0, .3); }
  .slider.bare .track { margin: 0; border-radius: var(--r); }
  .slider.bare .track-value { line-height: var(--h); }
  .slider.steam .track { background: rgba(var(--rgb-light-blue-color, 3, 169, 244), .14); }
  .slider.steam .fill { background: rgba(var(--rgb-light-blue-color, 3, 169, 244), .45); }
  .fill { position: absolute; inset: 0 auto 0 0; background: rgba(var(--oven-rgb), .45); border-radius: 8px 0 0 8px; }
  .fill::after { content: ""; position: absolute; right: 4px; top: 50%; width: 4px; height: 16px; margin-top: -8px;
    border-radius: 2px; background: #fff; box-shadow: 0 0 2px rgba(0, 0, 0, .3); }
  .track-value { position: relative; display: block; line-height: 30px; padding: 0 8px; text-align: center; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; height: 100%; font-size: 14px; font-weight: 500;
    color: var(--primary-text-color); font-variant-numeric: tabular-nums; pointer-events: none; }

  /* Toggles (sous vide, preheat) and actions. */
  .toggle { display: grid; place-items: center; background: var(--track); color: var(--secondary-text-color); }
  .toggle.on { background: rgb(var(--rgb-blue-color, 33, 150, 243)); color: #fff; }
  .toggle.on.preheat { background: rgb(var(--oven-rgb)); }
  .toggle.on.waits { background: rgb(var(--rgb-purple-color, 146, 107, 199)); }

  /* Steps row: chips in one 42 px row; it scrolls sideways if needed. */
  .steps { display: flex; align-items: center; gap: 6px; padding: 0 5px; background: var(--track);
    overflow-x: auto; scrollbar-width: none; }
  .steps::-webkit-scrollbar { display: none; }
  .chip-step { flex: none; height: 32px; padding: 0 10px; border-radius: 9px; display: inline-flex; align-items: center; gap: 4px;
    font-size: 13px; font-weight: 500; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .chip-step ha-icon { --mdc-icon-size: 14px; }
  .chip-step .n { min-width: 16px; height: 16px; border-radius: 8px; display: inline-grid; place-items: center; font-size: 11px;
    font-weight: 700; background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .1); }
  .chip-step.on { background: var(--selected-bg); color: var(--primary-text-color);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .14); }
  .chip-step.on .n { background: var(--primary-text-color); color: var(--card-background-color, #fff); }
  .chip-step.done { color: var(--secondary-text-color); }
  .chip-step.done .n { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .18); color: var(--primary-text-color); }
  .chip-step .x { display: grid; place-items: center; width: 20px; height: 20px; margin-right: -4px; border-radius: 50%;
    color: var(--secondary-text-color); }
  .chip-step .x:hover { background: rgba(var(--rgb-error-color, 219, 68, 55), .15); color: var(--error-color, #db4437); }
  .chip-step.add { padding: 0 8px; color: var(--primary-text-color); }
  .chip-step.add ha-icon { --mdc-icon-size: 18px; }
  .chip-step:disabled { opacity: .4; }
  .steps.running .chip-step { padding: 0 6px; }
  /* A fixed width, so Bake / Cook keeps its size when the label changes. */
  .pair.go > .toggle.labeled { flex: 0 0 calc(var(--h) * 3); display: inline-flex; align-items: center; justify-content: center;
    gap: 6px; padding: 0 10px; white-space: nowrap; overflow: hidden;
    font-size: 14px; font-weight: 500; }

  /* Probe status: orange while plugged in. */
  .icon-state.probe { opacity: .4; }
  .icon-state.unknown, .icon-state.probe.unknown { opacity: .25; color: var(--secondary-text-color); }
  .notice { display: flex; align-items: center; justify-content: center; padding: 0 12px; font-size: 14px; font-weight: 500;
    background: rgba(var(--rgb-warning-color, 230, 149, 0), .18); color: var(--primary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icon-state.probe.in { opacity: 1; color: var(--primary-text-color); background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .1); }
  .icon-state.tools { background: var(--track); }
  .icon-state.tools { position: relative; }
  .icon-state.tools.on { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .16); color: var(--primary-text-color); }
  .badge { position: absolute; top: 3px; right: 3px; width: 9px; height: 9px; border-radius: 50%;
    background: var(--warning-color, #e69500); box-shadow: 0 0 0 2px var(--card-background-color, #fff); }

  /* Maintenance panel: exactly the height of the five rows. */
  .chip-step.book { padding: 0 8px; color: var(--secondary-text-color); }
  .chip-step.book ha-icon { --mdc-icon-size: 18px; }
  .item.preset { padding: 6px 6px 6px 12px; gap: 4px; }
  .item.note { background: rgba(var(--oven-rgb), .12); }
  .icon-btn { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
    color: var(--primary-text-color); }
  .icon-btn ha-icon { --mdc-icon-size: 20px; }
  .icon-btn:hover:not(:disabled) { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .08); }
  .icon-btn.go { color: rgb(var(--oven-rgb)); }
  .icon-btn.danger { color: var(--secondary-text-color); }
  .icon-btn.danger.armed { background: var(--error-color, #db4437); color: #fff; }
  .icon-btn:disabled { opacity: .4; }
  .save-row { display: flex; gap: 8px; margin-top: auto; }
  .name { flex: 1; min-width: 0; border: none; padding: 0 12px; background: var(--track); color: var(--primary-text-color);
    font: inherit; font-size: 14px; outline: none; }
  .name:focus { box-shadow: inset 0 0 0 2px rgba(var(--oven-rgb), .6); }
  .se { display: grid; gap: var(--gap); grid-template-columns: calc(var(--h) * 3) minmax(0, 1fr);
    grid-template-areas: "steam steam" "ends val"; }
  .se > .slider { grid-area: steam; } .se > .select { grid-area: ends; } .se > .stepper { grid-area: val; }
  .value.editable { cursor: text; border-radius: 8px; height: 32px; }
  .value.editable:hover { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), .06); }
  .value.editable span { text-decoration: underline dotted rgba(var(--rgb-primary-text-color, 33, 33, 33), .35); text-underline-offset: 4px; }
  .value-input { flex: 1; min-width: 0; height: 32px; border: none; border-radius: 8px; text-align: center; font: inherit;
    font-size: 14px; font-weight: 500; color: var(--primary-text-color); background: var(--card-background-color, #fff);
    box-shadow: inset 0 0 0 2px var(--primary-color, #03a9f4); outline: none; }
  .panel { height: calc(var(--h) * 6 + var(--gap) * 5); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600;
    color: var(--primary-text-color); }
  .item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--r); background: var(--track); }
  .item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .item-text b { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
  .item-text > span { font-size: 12px; line-height: 16px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item-text b .gap { display: inline-block; width: 12px; }
  .head-tags { flex: 1; text-align: right; padding-right: 8px; font-size: 12px; font-weight: 500;
    color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item-btn { flex: none; padding: 0 14px; }
  .tag { margin-left: 4px; padding: 1px 8px; border-radius: 9px; font-size: 11px; font-weight: 600;
    background: rgba(var(--rgb-success-color, 67, 160, 71), .15); color: var(--success-color, #43a047); }
  .tag.unknown { background: var(--track); color: var(--secondary-text-color); }
  .tag.warn { background: rgba(var(--rgb-error-color, 219, 68, 55), .15); color: var(--error-color, #db4437); }
  .toggle:disabled { opacity: .4; }
  .toggle ha-icon { --mdc-icon-size: 20px; }
  .action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; font-weight: 500;
    background: var(--track); color: var(--primary-text-color); }
  .action ha-icon { --mdc-icon-size: 20px; }
  .action.start { background: rgb(var(--oven-rgb)); color: #fff; }
  .action.save { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .action.save:disabled { opacity: .4; }
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
