//! MQTT processor: the oven in Home Assistant, through MQTT discovery.
//!
//! Off unless `ANOVA_MQTT_URL` is set. It reads what the HTTP API serves
//! (the read model, cook progress and the oven's connection) and sends
//! commands through the same state-machine paths, so the two can't drift
//! apart. See "Home Assistant over MQTT" in `docs/oven-offline-plan.md`,
//! and `docs/mqtt-ha-split.md` for which topics are generic and which are
//! Home Assistant's, before adding one.
//!
//! Not critical: a broker outage must not take the server down. The client
//! reconnects with backoff, and every connect republishes discovery and the
//! retained state.

mod discovery;
mod manual;
mod milestones;
mod recipes;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anova_oven_api::{CookProgress, OvenStatus, Recipe};
use rumqttc::{AsyncClient, Event, LastWill, MqttOptions, Packet, QoS};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tracing::{debug, info, warn};

use crate::liveness::Liveness;
use crate::processors::local_store::{RecipeDraft, RecipeError, RecipeFiles, RecipePatch};
use crate::read_model::ReadModel;
use crate::runtime::types::{CommandFailure, ControlRequest, StateMachineCommand};

pub use discovery::Topics;
use milestones::{Milestone, Snapshot};

/// How often to look at things nothing announces: the oven's connection,
/// and how long it has been away.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How long a publish may wait for room in the client's queue.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(1);
/// After a safety stop that failed, the next try.
const SAFETY_RETRY: Duration = Duration::from_secs(5 * 60);

pub struct MqttConfig {
    /// `mqtt://host:1883`; the port defaults to 1883.
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub topics: Topics,
    /// Local mode: announce the controls only it can drive.
    pub local: bool,
    /// The broker drops one of two clients with the same ID, so a second
    /// server on the same broker (a test run beside the real one) needs
    /// its own.
    pub client_id: String,
    /// Stop a dry cook that nothing ends after this long; `None` is off.
    pub safety_limit: Option<Duration>,
}

/// The safety limit when `ANOVA_SAFETY_LIMIT_HOURS` is not set.
const DEFAULT_SAFETY_LIMIT_HOURS: f64 = 4.0;

/// `ANOVA_SAFETY_LIMIT_HOURS`: hours, `0` for off. Unset or unreadable is
/// the default; a typo must not turn the limit off.
fn safety_limit(value: Option<&str>) -> Option<Duration> {
    let hours = match value.map(|v| v.trim().parse::<f64>()) {
        Some(Ok(h)) if h.is_finite() && h >= 0.0 => h,
        Some(_) => {
            warn!(value = ?value, "[mqtt] bad ANOVA_SAFETY_LIMIT_HOURS; using the default");
            DEFAULT_SAFETY_LIMIT_HOURS
        }
        None => DEFAULT_SAFETY_LIMIT_HOURS,
    };
    let default = Duration::from_secs_f64(DEFAULT_SAFETY_LIMIT_HOURS * 3600.0);
    (hours > 0.0).then(|| Duration::try_from_secs_f64(hours * 3600.0).unwrap_or(default))
}

/// `ANOVA_MQTT_CLIENT_ID`, or `anova-oven-server` when it's unset or blank.
fn client_id(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("anova-oven-server")
        .to_string()
}

impl MqttConfig {
    /// From `ANOVA_MQTT_*`; `None` when `ANOVA_MQTT_URL` isn't set.
    pub fn from_env(local: bool) -> Option<Self> {
        let url = std::env::var("ANOVA_MQTT_URL").ok()?;
        Some(Self {
            url,
            username: std::env::var("ANOVA_MQTT_USERNAME").ok(),
            password: std::env::var("ANOVA_MQTT_PASSWORD").ok(),
            topics: Topics {
                prefix: std::env::var("ANOVA_MQTT_TOPIC_PREFIX")
                    .unwrap_or_else(|_| "anova/oven".into()),
                discovery: std::env::var("ANOVA_MQTT_DISCOVERY_PREFIX")
                    .unwrap_or_else(|_| "homeassistant".into()),
            },
            local,
            client_id: client_id(std::env::var("ANOVA_MQTT_CLIENT_ID").ok().as_deref()),
            safety_limit: safety_limit(std::env::var("ANOVA_SAFETY_LIMIT_HOURS").ok().as_deref()),
        })
    }

    fn options(&self) -> Result<MqttOptions, String> {
        let (host, port) = broker_address(&self.url)?;
        let mut options = MqttOptions::new(self.client_id.clone(), host, port);
        if let (Some(user), Some(pass)) = (&self.username, &self.password) {
            options.set_credentials(user, pass);
        }
        options.set_keep_alive(Duration::from_secs(30));
        // Discovery for the recipe select and the selected recipe's steps
        // can outgrow rumqttc's 10 KiB default.
        options.set_max_packet_size(256 * 1024, 256 * 1024);
        options.set_last_will(LastWill::new(
            self.topics.availability(),
            "offline",
            QoS::AtLeastOnce,
            true,
        ));
        Ok(options)
    }
}

/// What the HTTP API serves, for the processor to read.
pub struct Sources {
    pub read_model: watch::Receiver<ReadModel>,
    pub cook_progress: watch::Receiver<Option<CookProgress>>,
    pub liveness: Arc<Liveness>,
    pub failures: broadcast::Receiver<CommandFailure>,
    pub sm_cmd_tx: mpsc::Sender<StateMachineCommand>,
    /// The recipe files, for the save and delete commands (local mode).
    pub recipe_files: Option<RecipeFiles>,
}

/// From the client's event loop to the processor.
enum Incoming {
    Connected,
    Command { topic: String, payload: Vec<u8> },
}

pub async fn run(config: MqttConfig, mut sources: Sources) {
    let options = match config.options() {
        Ok(options) => options,
        Err(e) => {
            warn!(error = %e, "[mqtt] bad ANOVA_MQTT_URL; MQTT is off");
            return;
        }
    };
    let (client, eventloop) = AsyncClient::new(options, 64);
    let (incoming_tx, mut incoming_rx) = mpsc::channel(32);
    tokio::spawn(drive(eventloop, incoming_tx));

    let mut processor = Processor {
        client,
        topics: config.topics,
        local: config.local,
        recipes: Vec::new(),
        options: Vec::new(),
        selected: None,
        manual: manual::Draft::default(),
        last_manual: None,
        last_state: None,
        auto_stop: true,
        pending_started_by: None,
        started_by: None,
        last_cook: None,
        last_recipes: None,
        unit: None,
        discovered_unit: None,
        last_snapshot: None,
        next_stage_ready: None,
        safety: SafetyClock::new(config.safety_limit),
        stop_reason: None,
        end_anchor: None,
        stage_clock: StageClock::default(),
    };
    let mut poll = tokio::time::interval(POLL_INTERVAL);

    loop {
        tokio::select! {
            incoming = incoming_rx.recv() => match incoming {
                Some(Incoming::Connected) => processor.on_connected(&sources).await,
                Some(Incoming::Command { topic, payload }) => {
                    processor.on_command(&topic, &payload, &sources).await;
                }
                None => return,
            },
            changed = sources.read_model.changed() => {
                if changed.is_err() {
                    return;
                }
                processor.on_change(&sources, false).await;
            }
            changed = sources.cook_progress.changed() => {
                if changed.is_err() {
                    return;
                }
                processor.on_change(&sources, false).await;
            }
            failure = sources.failures.recv() => match failure {
                Ok(failure) => processor.command_failed(&failure.command, &failure.reason).await,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(missed = n, "[mqtt] missed command failures");
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            _ = poll.tick() => processor.on_change(&sources, false).await,
        }
    }
}

/// Run the client's event loop, reporting connects and commands. On an
/// error rumqttc reconnects at the next poll, so this only paces it.
async fn drive(mut eventloop: rumqttc::EventLoop, incoming_tx: mpsc::Sender<Incoming>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                info!("[mqtt] connected to the broker");
                backoff = Duration::from_secs(1);
                if incoming_tx.send(Incoming::Connected).await.is_err() {
                    return;
                }
            }
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                let command = Incoming::Command {
                    topic: publish.topic,
                    payload: publish.payload.to_vec(),
                };
                if incoming_tx.send(command).await.is_err() {
                    return;
                }
            }
            Ok(_) => {}
            Err(e) => {
                warn!(error = %e, retry_secs = backoff.as_secs(), "[mqtt] broker connection failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

struct Processor {
    client: AsyncClient,
    topics: Topics,
    local: bool,
    recipes: Vec<Recipe>,
    /// The select's options, each with its recipe ID.
    options: Vec<(String, String)>,
    /// The selected recipe's ID. Lives here, not in Home Assistant, so it
    /// survives an HA restart and a stale select can't start the wrong one.
    selected: Option<String>,
    /// The manual cook being set up. Here for the same reasons.
    manual: manual::Draft,
    last_manual: Option<String>,
    last_state: Option<String>,
    /// Stop the oven at `cook_done`. On until the retained command says
    /// otherwise.
    auto_stop: bool,
    /// The Home Assistant user of the last `start` command, until the cook
    /// it started begins.
    pending_started_by: Option<String>,
    /// Who started the running cook; `None` for a cook started on the oven.
    /// Every event carries it, so a notification can go to that person.
    started_by: Option<String>,
    /// The running cook's stages payload last published.
    last_cook: Option<String>,
    /// The recipes-with-stages payload last published.
    last_recipes: Option<String>,
    /// The oven's display unit, from the last status that had one: the
    /// temperature numbers' unit, and the summaries'. Kept while the oven
    /// is away, so their discovery doesn't flip to °C and back.
    unit: Option<String>,
    /// The unit the discovery configs went out in.
    discovered_unit: Option<String>,
    /// `None` until the first snapshot, which is the baseline: a restart
    /// mid-cook announces nothing.
    last_snapshot: Option<Snapshot>,
    next_stage_ready: Option<bool>,
    /// The safety limit for dry cooks that nothing ends.
    safety: SafetyClock,
    /// Why the server stopped the cook, for the `cook_stopped` that follows.
    stop_reason: Option<serde_json::Value>,
    /// The timer value last seen and when it arrived. See [`EndAnchor`].
    end_anchor: Option<EndAnchor>,
    /// When the running stage started. See [`StageClock`].
    stage_clock: StageClock,
}

/// When the running stage started. The oven counts up on its display from
/// the start of a stage with no timer (after its preheat), but it does not
/// report that count. So the server notes when it sees a stage begin, and
/// the card counts from there, as the oven does.
#[derive(Debug, Default)]
struct StageClock {
    /// The cook and stage last seen; `None` while idle.
    key: Option<(Option<String>, Option<usize>)>,
    started_at: Option<i64>,
    /// The clock has seen at least one status. A stage that already runs
    /// at the first status started at an unknown time.
    watched: bool,
}

impl StageClock {
    /// The running stage's start, in Unix seconds; `None` while idle, and
    /// for a stage that already ran when the App started.
    fn update(&mut self, status: Option<&OvenStatus>, connected: bool, now: i64) -> Option<i64> {
        // Before the oven's first report, the status says nothing yet.
        if !connected {
            return self.started_at;
        }
        let watched = std::mem::replace(&mut self.watched, true);
        // A descale counts too: the card shows how long it has run.
        let Some(status) = status.filter(|s| s.is_cooking() || s.is_descaling()) else {
            self.key = None;
            self.started_at = None;
            return None;
        };
        let index = status
            .cook_progress
            .as_ref()
            .map(|p| p.current_stage_index)
            .or(status.active_stage_index);
        let key = (status.cook_id.clone(), index);
        match &self.key {
            // The same stage. A cook ID that arrives late is the same cook.
            Some(k) if *k == key || (k.0.is_none() && k.1 == key.1) => {}
            Some(_) => self.started_at = Some(now),
            None => self.started_at = watched.then_some(now),
        }
        self.key = Some(key);
        self.started_at
    }
}

/// The safety limit: how long a dry cook that nothing ends has run.
#[derive(Debug)]
struct SafetyClock {
    limit: Option<Duration>,
    /// Since when, for which cook, stage and done state. A change of any of
    /// them starts the clock again.
    since: Option<(UnboundedKey, Instant)>,
    /// When the limit last fired for this clock.
    fired: Option<Instant>,
}

type UnboundedKey = (Option<String>, Option<usize>, bool);

/// The same cook, stage and done state. A cook ID that arrives late, or
/// one frame without it, is the same cook.
fn same_key(a: &UnboundedKey, b: &UnboundedKey) -> bool {
    a.1 == b.1 && a.2 == b.2 && (a.0 == b.0 || a.0.is_none() || b.0.is_none())
}

impl SafetyClock {
    fn new(limit: Option<Duration>) -> Self {
        SafetyClock { limit, since: None, fired: None }
    }

    /// The limit, once the cook in `s` has been unbounded that long at
    /// `now`. The clock starts again for a new cook, a new stage, or the end
    /// of the last timer. It keeps running while the oven is offline (the
    /// oven may still heat), but only an online oven can be stopped. If the
    /// cook still runs after the limit fired (the stop failed), it fires
    /// again every [`SAFETY_RETRY`].
    fn check(&mut self, s: &Snapshot, now: Instant) -> Option<Duration> {
        let limit = self.limit?;
        if !s.connected {
            return None;
        }
        if !s.unbounded() {
            self.since = None;
            self.fired = None;
            return None;
        }
        let key: UnboundedKey = (s.cook_key.clone(), s.stage_index, s.cook_done);
        let since = match &self.since {
            Some((k, t)) if same_key(k, &key) => *t,
            _ => {
                self.fired = None;
                now
            }
        };
        self.since = Some((key, since));
        if now.duration_since(since) < limit {
            return None;
        }
        if self.fired.is_some_and(|f| now.duration_since(f) < SAFETY_RETRY) {
            return None;
        }
        self.fired = Some(now);
        Some(limit)
    }
}

/// The oven reports the time left only now and then, but the state is
/// published every 5 s. `now + time left` with an old report moves the end
/// time later at every publish, then back when a new report arrives: the
/// card's progress bar jumped. So the end time is worked out once per new
/// report, from the moment that report arrived.
#[derive(Clone, Copy, Debug, PartialEq)]
struct EndAnchor {
    current: u64,
    total: u64,
    /// The end time, in Unix seconds.
    ends_at: i64,
}

impl EndAnchor {
    /// The end time for `remaining` seconds left (of `total`), at `now`.
    /// The same report again keeps the end time it gave the first time.
    fn update(anchor: &mut Option<EndAnchor>, remaining: Option<u64>, total: u64, now: i64) -> Option<i64> {
        let Some(current) = remaining else {
            *anchor = None;
            return None;
        };
        if let Some(a) = *anchor {
            if a.current == current && a.total == total {
                return Some(a.ends_at);
            }
        }
        let a = EndAnchor { current, total, ends_at: now + current as i64 };
        *anchor = Some(a);
        Some(a.ends_at)
    }
}

impl Processor {
    /// Publish, but wait at most [`PUBLISH_TIMEOUT`]. While the broker is
    /// away, the client's queue fills and a publish would wait until it
    /// returns; the safety limit and Auto stop run after the publishes, so
    /// they must not wait with it. A reconnect publishes every retained
    /// topic again (`on_connected`).
    async fn publish(&self, topic: String, retain: bool, payload: impl Into<Vec<u8>>) {
        let send = self
            .client
            .publish(topic.clone(), QoS::AtLeastOnce, retain, payload);
        match tokio::time::timeout(PUBLISH_TIMEOUT, send).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => warn!(topic, error = %e, "[mqtt] publish failed"),
            Err(_) => debug!(topic, "[mqtt] publish dropped: the broker is away"),
        }
    }

    /// Discovery, availability and every retained topic, then the
    /// subscription. On every connect, since the broker may have lost them.
    async fn on_connected(&mut self, sources: &Sources) {
        let model = sources.read_model.borrow().clone();
        self.recipes = model.recipes;
        self.options = recipes::options(&self.recipes);
        if let Some(status) = &model.status {
            self.unit = Some(status.temperature_unit.clone());
        }
        self.publish_discovery().await;
        self.publish(self.topics.availability(), true, "online")
            .await;
        if let Err(e) = self
            .client
            .subscribe(self.topics.commands(), QoS::AtLeastOnce)
            .await
        {
            warn!(error = %e, "[mqtt] subscribe failed");
        }
        self.publish_auto_stop().await;
        self.last_recipes = None;
        self.publish_recipes().await;
        self.last_state = None;
        self.last_cook = None;
        self.last_manual = None;
        self.next_stage_ready = None;
        self.on_change(sources, true).await;
    }

    async fn publish_discovery(&mut self) {
        let unit = self.unit();
        for (topic, payload) in discovery::configs(&self.topics, self.local, &self.titles(), &unit)
        {
            self.publish(topic, true, payload).await;
        }
        self.discovered_unit = Some(unit);
    }

    fn titles(&self) -> Vec<String> {
        self.options
            .iter()
            .map(|(title, _)| title.clone())
            .collect()
    }

    /// The recipe list, the select's options and the selected recipe.
    async fn publish_recipes(&mut self) {
        if !self
            .selected
            .as_ref()
            .is_some_and(|id| self.options.iter().any(|(_, o)| o == id))
        {
            self.selected = self.options.first().map(|(_, id)| id.clone());
        }
        let titles = self.titles();
        self.publish(
            self.topics.recipes(),
            true,
            serde_json::to_vec(&titles).unwrap_or_default(),
        )
        .await;
        self.publish_recipe_list().await;
        self.publish_selected().await;
    }

    /// Every recipe, by its select option, with its stages. Only when it
    /// changed, since it can be large.
    async fn publish_recipe_list(&mut self) {
        let list: Vec<serde_json::Value> = self
            .options
            .iter()
            .filter_map(|(title, id)| {
                let recipe = self.recipes.iter().find(|r| &r.id == id)?;
                Some(serde_json::json!({ "title": title, "stages": recipe.stages }))
            })
            .collect();
        let payload = serde_json::json!({ "recipes": list }).to_string();
        if self.last_recipes.as_deref() != Some(payload.as_str()) {
            self.publish(self.topics.recipes_attributes(), true, payload.clone())
                .await;
            self.last_recipes = Some(payload);
        }
    }

    fn option_id(&self, title: &str) -> Option<String> {
        self.options
            .iter()
            .find(|(t, _)| t == title)
            .map(|(_, id)| id.clone())
    }

    /// `{"title": "…", "stages": […]}` saves a new recipe; with
    /// `"replace": "<option>"` it overwrites the recipe behind that option.
    async fn save_recipe(&mut self, text: &str, sources: &Sources) {
        let Some(files) = &sources.recipe_files else {
            self.command_failed("save_recipe", "recipes are read-only in cloud mode")
                .await;
            return;
        };
        let request: SaveRecipe = match serde_json::from_str(text) {
            Ok(r) => r,
            Err(e) => {
                self.command_failed("save_recipe", &format!("bad payload: {e}"))
                    .await;
                return;
            }
        };
        let result = match request.replace.as_deref().and_then(|t| self.option_id(t)) {
            Some(id) => files.update(
                &id,
                RecipePatch {
                    title: Some(request.title),
                    stages: Some(request.stages),
                },
            ),
            None => files.create(RecipeDraft {
                title: request.title,
                stages: request.stages,
            }),
        };
        match result {
            Ok(recipe) => {
                info!(title = %recipe.title, "[mqtt] saved recipe");
                refresh_recipes(sources).await;
            }
            Err(e) => self.command_failed("save_recipe", &recipe_error_text(e)).await,
        }
    }

    /// The payload is the recipe's select option.
    async fn delete_recipe(&mut self, text: &str, sources: &Sources) {
        let Some(files) = &sources.recipe_files else {
            self.command_failed("delete_recipe", "recipes are read-only in cloud mode")
                .await;
            return;
        };
        let Some(id) = self.option_id(text) else {
            self.command_failed("delete_recipe", "no recipe with that title")
                .await;
            return;
        };
        match files.delete(&id) {
            Ok(()) => {
                info!(title = %text, "[mqtt] deleted recipe");
                refresh_recipes(sources).await;
            }
            Err(e) => self.command_failed("delete_recipe", &recipe_error_text(e)).await,
        }
    }

    async fn publish_selected(&self) {
        let unit = self.unit();
        let selected = self.selected.as_ref().and_then(|id| {
            let title = &self.options.iter().find(|(_, o)| o == id)?.0;
            let recipe = self.recipes.iter().find(|r| &r.id == id)?;
            Some((title.clone(), recipes::attributes(recipe, &unit)))
        });
        let (title, attributes) =
            selected.unwrap_or_else(|| ("No recipes".into(), serde_json::json!({})));
        self.publish(self.topics.selected(), true, title).await;
        self.publish(
            self.topics.selected_attributes(),
            true,
            attributes.to_string(),
        )
        .await;
    }

    /// The manual cook's state, if it changed. Its summary is in the
    /// oven's display unit, so a change of unit counts.
    async fn publish_manual(&mut self) {
        let state = self.manual.state(&self.unit()).to_string();
        if self.last_manual.as_deref() != Some(state.as_str()) {
            self.publish(self.topics.manual(), true, state.clone())
                .await;
            self.last_manual = Some(state);
        }
    }

    fn unit(&self) -> String {
        self.unit.clone().unwrap_or_else(|| "C".into())
    }

    /// Something may have changed: republish what did, and announce any
    /// milestones.
    async fn on_change(&mut self, sources: &Sources, force: bool) {
        let model = sources.read_model.borrow().clone();

        let new_options = recipes::options(&model.recipes);
        if new_options != self.options {
            self.recipes = model.recipes.clone();
            self.options = new_options;
            let (topic, payload) = discovery::select_config(&self.topics, &self.titles());
            self.publish(topic, true, payload).await;
            self.publish_recipes().await;
        } else if model.recipes.len() == self.recipes.len() {
            self.recipes = model.recipes.clone();
            self.publish_recipe_list().await;
        }

        let connected = sources.liveness.connected();
        let status = model.status.clone().map(|mut status| {
            status.cook_progress = sources.cook_progress.borrow().clone();
            status.upstream = Some(anova_oven_api::UpstreamHealth {
                connected,
                disconnected_secs: sources.liveness.disconnected_secs(),
                oven_offline_secs: sources.liveness.oven_offline_secs(),
            });
            status
        });

        if let Some(status) = &status {
            self.unit = Some(status.temperature_unit.clone());
            if self.discovered_unit.is_some() && self.discovered_unit != self.unit {
                self.publish_discovery().await;
            }
        }

        let ends_at = EndAnchor::update(
            &mut self.end_anchor,
            status.as_ref().and_then(OvenStatus::timer_remaining_secs),
            status.as_ref().map_or(0, |s| s.timer_total_secs),
            jiff::Timestamp::now().as_second(),
        );
        let stage_started_at =
            self.stage_clock
                .update(status.as_ref(), connected, jiff::Timestamp::now().as_second());
        let state = state_json(status.as_ref(), model.current_cook.as_ref(), connected, ends_at, stage_started_at)
            .to_string();
        if force || self.last_state.as_deref() != Some(state.as_str()) {
            self.publish(self.topics.state(), true, state.clone()).await;
            self.last_state = Some(state);
        }

        // Every dashboard shows the stages, not only the one that started
        // the cook. An empty list when no cook runs.
        let stages = model.current_cook.as_ref().map_or(&[][..], |c| &c.stages[..]);
        let cook = serde_json::json!({ "stages": stages }).to_string();
        if force || self.last_cook.as_deref() != Some(cook.as_str()) {
            self.publish(self.topics.cook_attributes(), true, cook.clone()).await;
            self.last_cook = Some(cook);
        }

        // A recipe whose last stage says `turn_off_at_end`: the state
        // machine stops it at the end. Auto stop must not stop it a second
        // time, or the second stop fails and the phones get a false alarm.
        let machine_stops = model
            .current_cook
            .as_ref()
            .and_then(|c| c.stages.last())
            .is_some_and(|s| s.turn_off_at_end == Some(true));
        let mut snapshot = Snapshot::new(status.as_ref(), model.current_cook.as_ref(), connected);
        if let Some(prev) = &self.last_snapshot {
            snapshot.carry(prev);
        }
        let ready = snapshot.next_stage_ready && snapshot.connected;
        if force || self.next_stage_ready != Some(ready) {
            let availability = if ready { "online" } else { "offline" };
            self.publish(self.topics.next_stage_availability(), true, availability)
                .await;
            self.next_stage_ready = Some(ready);
        }

        let mut done = false;
        let had_baseline = self.last_snapshot.is_some();
        if let Some(prev) = self.last_snapshot.take() {
            let mut stopped = false;
            for milestone in milestones::milestones(&prev, &snapshot) {
                stopped |= milestone == Milestone::CookStopped;
                done |= milestone == Milestone::CookDone;
                if milestone == Milestone::CookStarted {
                    self.started_by = self.pending_started_by.take();
                    self.stop_reason = None;
                }
                let source = if milestone.describes_previous() {
                    &prev
                } else {
                    &snapshot
                };
                let mut payload = source.payload(milestone.as_str());
                if milestone == Milestone::CookStopped {
                    if let Some(reason) = self.stop_reason.take() {
                        payload["reason"] = reason;
                    }
                }
                self.event(milestone, payload).await;
            }
            // A cook that held after its last timer ends without
            // `cook_stopped` (it said `cook_done`). When the server stopped
            // it, say so.
            if prev.cooking && !snapshot.cooking && snapshot.connected && !stopped {
                if let Some(reason) = self.stop_reason.take() {
                    let mut payload = prev.payload(Milestone::CookStopped.as_str());
                    payload["reason"] = reason;
                    self.event(Milestone::CookStopped, payload).await;
                }
            }
        }
        let unbounded_too_long = self.safety.check(&snapshot, Instant::now());
        // The baseline is the oven's first report. Before it, the status says
        // idle, and a restart mid-cook would announce the cook again.
        if had_baseline || (connected && status.is_some()) {
            self.last_snapshot = Some(snapshot);
        }
        if done && self.auto_stop && !machine_stops {
            self.stop_cook(sources, "auto_stop").await;
        } else if let Some(limit) = unbounded_too_long {
            info!(hours = limit.as_secs_f64() / 3600.0, "[mqtt] safety limit: stopping the cook");
            self.stop_reason = Some(serde_json::json!({
                "kind": "safety_limit",
                "hours": limit.as_secs_f64() / 3600.0,
            }));
            if !self.stop_cook(sources, "safety_limit").await {
                // The next stop of this cook is not a safety stop.
                self.stop_reason = None;
            }
        }
        self.publish_manual().await;
    }

    async fn publish_auto_stop(&self) {
        let state = if self.auto_stop { "ON" } else { "OFF" };
        self.publish(self.topics.auto_stop(), true, state).await;
    }

    /// The oven holds the temperature after its last timer; neither it nor
    /// Anova's cloud stops the cook. With Auto stop on, the server does. The
    /// safety limit stops a dry cook that nothing ends. `why` names the
    /// command in a `command_failed` event.
    /// Whether the oven took the stop. A failure is a `command_failed`
    /// event; the phones get it for `auto_stop` and `safety_limit`.
    async fn stop_cook(&self, sources: &Sources, why: &str) -> bool {
        info!(why, "[mqtt] stopping the cook");
        let (reply_tx, reply_rx) = oneshot::channel();
        if sources
            .sm_cmd_tx
            .send(StateMachineCommand::StopCook { reply: reply_tx })
            .await
            .is_err()
        {
            self.command_failed(why, "the state machine is gone").await;
            return false;
        }
        match reply_rx.await {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                self.command_failed(why, &e.to_string()).await;
                false
            }
            Err(_) => {
                self.command_failed(why, "state machine dropped the reply")
                    .await;
                false
            }
        }
    }

    async fn event(&self, milestone: Milestone, mut payload: serde_json::Value) {
        info!(event = milestone.as_str(), "[mqtt] milestone");
        payload["started_by"] = self.started_by.clone().into();
        self.publish(self.topics.event(), false, payload.to_string())
            .await;
    }

    async fn command_failed(&self, command: &str, reason: &str) {
        warn!(command, reason, "[mqtt] command failed");
        let mut payload = self
            .last_snapshot
            .clone()
            .unwrap_or_default()
            .payload("command_failed");
        payload["command"] = command.into();
        payload["reason"] = reason.into();
        self.publish(self.topics.event(), false, payload.to_string())
            .await;
    }

    async fn on_command(&mut self, topic: &str, payload: &[u8], sources: &Sources) {
        let Some(name) = topic
            .strip_prefix(&self.topics.command(""))
            .map(str::to_string)
        else {
            return;
        };
        let text = String::from_utf8_lossy(payload).trim().to_string();
        debug!(command = %name, payload = %text, "[mqtt] command");

        let (reply_tx, reply_rx) = oneshot::channel();
        let cmd = match name.as_str() {
            "select_recipe" => {
                match self.options.iter().find(|(title, _)| *title == text) {
                    Some((_, id)) => {
                        self.selected = Some(id.clone());
                        self.publish_selected().await;
                    }
                    None => warn!(title = %text, "[mqtt] no recipe with that title"),
                }
                return;
            }
            "start" => {
                // `{"stages": […], "title": "…"}` for a manual cook (the
                // dashboard card), `{"recipe_id": "…"}`, or anything else (a
                // button's `PRESS`) for the selected recipe.
                let json = serde_json::from_str::<serde_json::Value>(&text).ok();
                self.pending_started_by = json
                    .as_ref()
                    .and_then(|v| v.get("started_by")?.as_str().map(String::from));
                if let Some(json) = json.as_ref().filter(|v| v.get("stages").is_some()) {
                    match manual_cook(json) {
                        Ok((title, stages)) => StateMachineCommand::StartManualCook {
                            title,
                            stages,
                            reply: reply_tx,
                        },
                        Err(e) => {
                            self.command_failed("start", &e).await;
                            return;
                        }
                    }
                } else {
                    let recipe_id = json
                        .as_ref()
                        .and_then(|v| v.get("recipe_id")?.as_str().map(String::from))
                        .or_else(|| self.selected.clone());
                    let Some(recipe_id) = recipe_id else {
                        self.command_failed("start", "no recipe selected").await;
                        return;
                    };
                    StateMachineCommand::StartCook {
                        recipe_id,
                        reply: reply_tx,
                    }
                }
            }
            "start_manual" => {
                // `{"title": "…", "stages": [...]}` for any manual cook, or
                // anything else (a button's `PRESS`) for the one set up in
                // the manual entities.
                let recipe = match serde_json::from_str::<ManualStart>(&text) {
                    Ok(start) => manual::check(start.title, start.stages),
                    Err(_) => self.manual.recipe(),
                };
                match recipe {
                    Ok(recipe) => StateMachineCommand::StartManualCook {
                        title: recipe.title,
                        stages: recipe.stages,
                        reply: reply_tx,
                    },
                    Err(e) => {
                        self.command_failed("start_manual", &e).await;
                        return;
                    }
                }
            }
            field if field.starts_with("manual/") => {
                if let Err(e) = self.manual.set(&field["manual/".len()..], &text) {
                    self.command_failed(field, &e).await;
                }
                self.publish_manual().await;
                return;
            }
            "stop" => StateMachineCommand::StopCook { reply: reply_tx },
            "auto_stop" => {
                match text.as_str() {
                    "ON" => self.auto_stop = true,
                    "OFF" => self.auto_stop = false,
                    _ => {
                        self.command_failed("auto_stop", "wants ON or OFF").await;
                        return;
                    }
                }
                self.publish_auto_stop().await;
                return;
            }
            "save_recipe" => {
                self.save_recipe(&text, sources).await;
                return;
            }
            "delete_recipe" => {
                self.delete_recipe(&text, sources).await;
                return;
            }
            other => {
                let request = match control_request(other, &text) {
                    Ok(request) => request,
                    Err(e) => {
                        self.command_failed(other, &e).await;
                        return;
                    }
                };
                StateMachineCommand::Control {
                    request,
                    reply: reply_tx,
                }
            }
        };
        if sources.sm_cmd_tx.send(cmd).await.is_err() {
            return;
        }
        match reply_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if name == "start" {
                    self.pending_started_by = None;
                }
                self.command_failed(&name, &e.to_string()).await
            }
            Err(_) => {
                self.command_failed(&name, "state machine dropped the reply")
                    .await
            }
        }
    }
}

/// A manual cook given in full, as `POST /start` takes one.
#[derive(serde::Deserialize)]
struct ManualStart {
    #[serde(default)]
    title: Option<String>,
    stages: Vec<anova_oven_api::Stage>,
}

/// Host and port from `mqtt://host[:port]`. TLS (`mqtts://`) isn't supported
/// yet, so the client doesn't bring a second TLS stack.
fn broker_address(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("mqtt://")
        .or_else(|| url.strip_prefix("tcp://"))
        .ok_or_else(|| format!("`{url}` must start with mqtt:// (mqtts:// isn't supported yet)"))?;
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(format!(
            "`{url}` needs a host, and credentials go in ANOVA_MQTT_USERNAME/PASSWORD"
        ));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port.parse().map_err(|_| format!("bad port in `{url}`"))?;
            Ok((host.to_string(), port))
        }
        None => Ok((authority.to_string(), 1883)),
    }
}

/// A control command from its topic name and payload.
/// The `save_recipe` command's payload.
#[derive(serde::Deserialize)]
struct SaveRecipe {
    title: String,
    stages: Vec<anova_oven_api::Stage>,
    #[serde(default)]
    replace: Option<String>,
}

fn recipe_error_text(e: RecipeError) -> String {
    match e {
        RecipeError::Invalid(msg) => msg,
        RecipeError::NotFound => "recipe not found".into(),
        other => format!("{other:?}"),
    }
}

/// Ask the state machine to re-read the recipes, so the select and the
/// Recipes sensor follow a save or a delete.
async fn refresh_recipes(sources: &Sources) {
    let (reply_tx, _reply_rx) = oneshot::channel();
    if sources
        .sm_cmd_tx
        .send(StateMachineCommand::RefreshRecipes { reply: reply_tx })
        .await
        .is_err()
    {
        warn!("[mqtt] couldn't refresh recipes after a write");
    }
}

/// A manual cook from the `start` command's `{"stages": […], "title": "…"}`,
/// with the same checks as a saved recipe.
fn manual_cook(json: &serde_json::Value) -> Result<(String, Vec<anova_oven_api::Stage>), String> {
    let stages: Vec<anova_oven_api::Stage> = serde_json::from_value(json["stages"].clone())
        .map_err(|e| format!("bad stages: {e}"))?;
    let title = json
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("Manual cook")
        .to_string();
    let recipe = crate::processors::local_store::normalize(Recipe {
        id: String::new(),
        title,
        stage_count: 0,
        stages,
        source: Default::default(),
    })
    .map_err(|e| match e {
        crate::processors::local_store::RecipeError::Invalid(msg) => msg,
        other => format!("{other:?}"),
    })?;
    Ok((recipe.title, recipe.stages))
}

fn control_request(name: &str, payload: &str) -> Result<ControlRequest, String> {
    match name {
        "next_stage" => Ok(ControlRequest::NextStage),
        "lamp" => match payload.to_ascii_uppercase().as_str() {
            "ON" => Ok(ControlRequest::Lamp { on: true }),
            "OFF" => Ok(ControlRequest::Lamp { on: false }),
            _ => Err(format!("lamp wants ON or OFF, not `{payload}`")),
        },
        "timer" => match payload.parse::<f64>() {
            Ok(secs) if secs >= 1.0 => Ok(ControlRequest::Timer { secs: secs as u64 }),
            _ => Err(format!("timer wants seconds, not `{payload}`")),
        },
        "temperature" => match payload.parse::<f32>() {
            Ok(celsius) if (25.0..=250.0).contains(&celsius) => {
                Ok(ControlRequest::Temperature { celsius })
            }
            _ => Err(format!("temperature wants 25–250 °C, not `{payload}`")),
        },
        "descale" => match payload.trim().to_ascii_uppercase().as_str() {
            "START" => Ok(ControlRequest::Descale { start: true }),
            "ABORT" => Ok(ControlRequest::Descale { start: false }),
            _ => Err(format!("descale wants START or ABORT, not `{payload}`")),
        },
        other => Err(format!("unknown command `{other}`")),
    }
}

/// The state topic: the `/status` JSON plus what Home Assistant can't
/// work out without templating every field: `connected`, `phase`,
/// `recipe_title`, `timer_remaining_secs` and `stage_ends_at` (so the phone
/// counts down without an update every second).
fn state_json(
    status: Option<&OvenStatus>,
    cook: Option<&anova_oven_api::CurrentCook>,
    connected: bool,
    ends_at: Option<i64>,
    stage_started_at: Option<i64>,
) -> serde_json::Value {
    let Some(status) = status else {
        return serde_json::json!({ "connected": connected, "mode": "unknown" });
    };
    let mut state = serde_json::to_value(status).unwrap_or_default();
    let remaining = status.timer_remaining_secs();
    state["connected"] = connected.into();
    // The stage's own kind, when the server knows the stages. The guess
    // from the timer says "Preheating" for any stage whose timer does not
    // run, such as a stage with no timer after the oven's own preheat.
    state["phase"] = match status.cook_progress.as_ref() {
        Some(p) if status.is_cooking() => {
            if p.current_stage_kind == "preheat" {
                "Preheating"
            } else {
                "Cooking"
            }
        }
        _ => status.phase(),
    }
    .into();
    state["recipe_title"] = cook.map(|c| c.display_name().to_string()).into();
    state["timer_remaining_secs"] = remaining.into();
    let iso = |t: Option<i64>| {
        t.and_then(|t| jiff::Timestamp::from_second(t).ok())
            .map(|t| t.to_string())
    };
    state["stage_ends_at"] = iso(ends_at).into();
    state["stage_started_at"] = iso(stage_started_at).into();
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_cook_takes_the_cards_stages() {
        let json = serde_json::json!({
            "title": " Pizza ",
            "stages": [
                { "kind": "preheat", "temperature_c": 220.0, "steam_pct": 0.0, "fan_speed": 100,
                  "heating_element_top": true, "heating_element_bottom": true },
                { "kind": "cook", "temperature_c": 220.0, "steam_pct": 30.0, "fan_speed": 100,
                  "heating_element_top": true, "heating_element_bottom": true,
                  "timer_added": true, "duration_secs": 600 },
            ],
        });
        let (title, stages) = manual_cook(&json).unwrap();
        assert_eq!(title, "Pizza");
        assert_eq!(stages.len(), 2);
        assert!(stages.iter().all(|s| s.id.is_some()));
    }

    #[test]
    fn manual_cook_refuses_what_the_oven_cant_run() {
        let stage = |extra: serde_json::Value| {
            let mut s = serde_json::json!({ "kind": "cook", "temperature_c": 180.0,
                "steam_pct": 0.0, "fan_speed": 100, "heating_element_rear": true });
            s.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            serde_json::json!({ "stages": [s] })
        };
        // Sous vide above 100 °C.
        assert!(manual_cook(&stage(serde_json::json!({
            "temperature_bulbs_mode": "wet", "steam_pct": 100.0 }))).is_err());
        // All three elements.
        assert!(manual_cook(&stage(serde_json::json!({
            "heating_element_top": true, "heating_element_bottom": true }))).is_err());
        // Not stages at all.
        assert!(manual_cook(&serde_json::json!({ "stages": "pizza" })).is_err());
        // No title: the default.
        assert_eq!(manual_cook(&stage(serde_json::json!({}))).unwrap().0, "Manual cook");
    }

    #[test]
    fn control_payloads() {
        assert_eq!(
            control_request("lamp", "on"),
            Ok(ControlRequest::Lamp { on: true })
        );
        assert_eq!(
            control_request("timer", "90"),
            Ok(ControlRequest::Timer { secs: 90 })
        );
        assert_eq!(
            control_request("timer", "5400.0"),
            Ok(ControlRequest::Timer { secs: 5400 })
        );
        assert_eq!(
            control_request("temperature", "180"),
            Ok(ControlRequest::Temperature { celsius: 180.0 })
        );
        assert!(control_request("temperature", "500").is_err());
        assert!(control_request("lamp", "dim").is_err());
        assert!(control_request("timer", "0").is_err());
        assert!(control_request("bogus", "").is_err());
        assert_eq!(
            control_request("descale", "start"),
            Ok(ControlRequest::Descale { start: true })
        );
        assert_eq!(
            control_request("descale", "ABORT"),
            Ok(ControlRequest::Descale { start: false })
        );
        assert!(control_request("descale", "").is_err());
    }

    #[test]
    fn state_without_a_status_is_still_published() {
        let v = state_json(None, None, false, None, None);
        assert_eq!(v["connected"], false);
    }

    #[test]
    fn broker_addresses() {
        assert_eq!(
            broker_address("mqtt://broker.lan"),
            Ok(("broker.lan".into(), 1883))
        );
        assert_eq!(
            broker_address("mqtt://192.0.2.5:1884/"),
            Ok(("192.0.2.5".into(), 1884))
        );
        assert!(broker_address("mqtts://broker.lan").is_err());
        assert!(broker_address("mqtt://u:p@broker.lan").is_err());
        assert!(broker_address("broker.lan").is_err());
    }

    #[test]
    fn options_parse_the_url() {
        let config = MqttConfig {
            url: "mqtt://broker.lan:1883".into(),
            username: Some("u".into()),
            password: Some("p".into()),
            topics: Topics {
                prefix: "anova/oven".into(),
                discovery: "homeassistant".into(),
            },
            local: true,
            client_id: "anova-oven-test".into(),
            safety_limit: None,
        };
        let options = config.options().unwrap();
        assert_eq!(options.broker_address(), ("broker.lan".to_string(), 1883));
        assert_eq!(options.client_id(), "anova-oven-test");
    }

    #[test]
    fn safety_limit_hours() {
        assert_eq!(safety_limit(None), Some(Duration::from_secs(4 * 3600)));
        assert_eq!(safety_limit(Some("2.5")), Some(Duration::from_secs(9000)));
        assert_eq!(safety_limit(Some("0")), None);
        // A typo keeps the default; it must not turn the limit off.
        assert_eq!(safety_limit(Some("four")), Some(Duration::from_secs(4 * 3600)));
        assert_eq!(safety_limit(Some("-1")), Some(Duration::from_secs(4 * 3600)));
    }

    /// A dry cook with no timer, stage 1 of cook `id`.
    fn unbounded(id: Option<&str>) -> Snapshot {
        Snapshot {
            connected: true,
            cooking: true,
            cook_key: id.map(String::from),
            stage_index: Some(1),
            ..Default::default()
        }
    }

    #[test]
    fn safety_clock_stops_a_dry_cook_with_no_end_after_the_limit() {
        let hour = Duration::from_secs(3600);
        let t0 = Instant::now();
        let mut clock = SafetyClock::new(Some(4 * hour));
        let cook = unbounded(Some("a"));
        assert_eq!(clock.check(&cook, t0), None);
        assert_eq!(clock.check(&cook, t0 + 3 * hour), None);
        assert_eq!(clock.check(&cook, t0 + 4 * hour), Some(4 * hour));
        // The stop failed: again after SAFETY_RETRY, not at every poll.
        assert_eq!(clock.check(&cook, t0 + 4 * hour + Duration::from_secs(5)), None);
        assert_eq!(clock.check(&cook, t0 + 4 * hour + SAFETY_RETRY), Some(4 * hour));
    }

    #[test]
    fn safety_clock_starts_again_for_a_new_stage_cook_or_end() {
        let hour = Duration::from_secs(3600);
        let t0 = Instant::now();
        let mut clock = SafetyClock::new(Some(4 * hour));
        clock.check(&unbounded(Some("a")), t0);
        let next_stage = Snapshot { stage_index: Some(2), ..unbounded(Some("a")) };
        assert_eq!(clock.check(&next_stage, t0 + 3 * hour), None);
        assert_eq!(clock.check(&next_stage, t0 + 5 * hour), None, "3 h → 5 h on stage 2 is 2 h");
        // The last timer ended and the oven holds: counts from that moment.
        let holding = Snapshot { has_end: true, cook_done: true, ..next_stage.clone() };
        assert_eq!(clock.check(&holding, t0 + 6 * hour), None);
        assert_eq!(clock.check(&holding, t0 + 10 * hour), Some(4 * hour));
        // A new cook.
        let mut clock = SafetyClock::new(Some(4 * hour));
        clock.check(&unbounded(Some("a")), t0);
        assert_eq!(clock.check(&unbounded(Some("b")), t0 + 4 * hour), None);
    }

    #[test]
    fn safety_clock_keeps_counting_through_offline_and_a_late_cook_id() {
        let hour = Duration::from_secs(3600);
        let t0 = Instant::now();
        let mut clock = SafetyClock::new(Some(4 * hour));
        clock.check(&unbounded(None), t0);
        let offline = Snapshot { connected: false, ..unbounded(Some("a")) };
        assert_eq!(clock.check(&offline, t0 + 2 * hour), None);
        assert_eq!(clock.check(&unbounded(Some("a")), t0 + 4 * hour), Some(4 * hour));
    }

    #[test]
    fn safety_clock_keeps_counting_when_a_frame_lacks_the_cook_id() {
        let hour = Duration::from_secs(3600);
        let t0 = Instant::now();
        let mut clock = SafetyClock::new(Some(4 * hour));
        clock.check(&unbounded(Some("a")), t0);
        assert_eq!(clock.check(&unbounded(None), t0 + hour), None);
        assert_eq!(clock.check(&unbounded(Some("a")), t0 + 4 * hour), Some(4 * hour));
    }

    #[test]
    fn safety_limit_hours_never_panic() {
        assert_eq!(safety_limit(Some("1e300")), Some(Duration::from_secs(4 * 3600)));
    }

    #[test]
    fn safety_clock_leaves_bounded_and_wet_cooks_alone() {
        let hour = Duration::from_secs(3600);
        let t0 = Instant::now();
        for cook in [
            Snapshot { has_end: true, ..unbounded(Some("a")) }, // a timer runs
            Snapshot { wet: true, ..unbounded(Some("a")) },     // sous vide
            Snapshot { cooking: false, ..unbounded(Some("a")) },
        ] {
            let mut clock = SafetyClock::new(Some(4 * hour));
            assert_eq!(clock.check(&cook, t0), None);
            assert_eq!(clock.check(&cook, t0 + 30 * hour), None);
        }
        // Off.
        let mut clock = SafetyClock::new(None);
        clock.check(&unbounded(Some("a")), t0);
        assert_eq!(clock.check(&unbounded(Some("a")), t0 + 30 * hour), None);
    }

    fn oven(mode: &str, cook_id: Option<&str>, stage: Option<usize>) -> OvenStatus {
        let mut s: OvenStatus = serde_json::from_value(serde_json::json!({
            "mode": mode, "temperature_unit": "C", "temperature_c": 20.0,
            "temperature_bulbs_mode": "dry", "dry_top_temperature_c": 20.0,
            "dry_bottom_temperature_c": 20.0, "wet_bulb_temperature_c": 20.0,
            "timer_current_secs": 0, "timer_total_secs": 0, "timer_mode": "idle",
            "steam_pct": 0.0, "steam_generator_mode": "idle", "boiler_celsius": 20.0,
            "boiler_watts": 0.0, "boiler_descale_required": false, "evaporator_celsius": 20.0,
            "evaporator_watts": 0.0, "fan_speed": 0, "heating_element_top_on": false,
            "heating_element_top_watts": 0.0, "heating_element_rear_on": false,
            "heating_element_rear_watts": 0.0, "heating_element_bottom_on": false,
            "heating_element_bottom_watts": 0.0, "lamp_on": false, "lamp_preference": "off",
            "vent_open": false, "door_open": false, "water_tank_empty": false,
        }))
        .unwrap();
        s.cook_id = cook_id.map(String::from);
        s.active_stage_index = stage;
        s
    }

    #[test]
    fn the_stage_clock_starts_with_each_stage_it_sees() {
        let mut clock = StageClock::default();
        assert_eq!(clock.update(Some(&oven("idle", None, None)), true, 100), None);
        // The cook starts; its ID arrives a moment later.
        assert_eq!(clock.update(Some(&oven("cook", None, Some(0))), true, 110), Some(110));
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(0))), true, 115), Some(110));
        // The preheat ends: stage 2 starts.
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(1))), true, 400), Some(400));
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(1))), true, 900), Some(400));
        assert_eq!(clock.update(Some(&oven("idle", None, None)), true, 950), None);
    }

    #[test]
    fn the_stage_clock_does_not_guess_a_start_it_did_not_see() {
        let mut clock = StageClock::default();
        // Before the oven's first report: nothing is known or decided.
        assert_eq!(clock.update(None, false, 90), None);
        assert_eq!(clock.update(Some(&oven("idle", None, None)), false, 95), None);
        // The App starts during a cook: the stage's start is unknown.
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(1))), true, 100), None);
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(1))), true, 200), None);
        // The next stage starts while it watches.
        assert_eq!(clock.update(Some(&oven("cook", Some("a"), Some(2))), true, 300), Some(300));
    }

    #[test]
    fn stage_clock_times_a_descale() {
        let mut clock = StageClock::default();
        assert_eq!(clock.update(Some(&oven("idle", None, None)), true, 100), None);
        let mut d = oven("idle", None, None);
        d.mode = "descale".into();
        assert_eq!(clock.update(Some(&d), true, 200), Some(200));
        assert_eq!(clock.update(Some(&d), true, 900), Some(200));
        assert_eq!(clock.update(Some(&oven("idle", None, None)), true, 3000), None);
        // A descale that already runs when the App starts: start unknown.
        let mut fresh = StageClock::default();
        assert_eq!(fresh.update(Some(&d), true, 50), None);
        assert_eq!(fresh.update(Some(&d), true, 60), None);
    }

    #[test]
    fn a_stage_without_a_timer_after_the_preheat_is_cooking() {
        let mut status = oven("cook", Some("a"), Some(1));
        assert_eq!(status.phase(), "Preheating", "the timer guess");
        status.cook_progress = Some(CookProgress {
            recipe_title: "Manual cook".into(),
            current_stage_index: 1,
            total_stage_count: 2,
            current_stage_description: "Cook".into(),
            current_stage_kind: "cook".into(),
            next_stage_ready: false,
            next_stage_description: None,
            next_stage_prompt: None,
            // The preheat and its cook: one step.
            current_step_index: 0,
            step_count: 1,
        });
        let v = state_json(Some(&status), None, true, None, Some(400));
        assert_eq!(v["phase"], "Cooking");
        assert_eq!(v["stage_started_at"], "1970-01-01T00:06:40Z");
        status.cook_progress.as_mut().unwrap().current_stage_kind = "preheat".into();
        assert_eq!(state_json(Some(&status), None, true, None, None)["phase"], "Preheating");
    }

    #[test]
    fn the_end_time_stays_put_between_oven_reports() {
        let mut anchor = None;
        // 600 s left at t=1000: ends at 1600.
        assert_eq!(EndAnchor::update(&mut anchor, Some(600), 900, 1000), Some(1600));
        // The same report, published again 5 s and 10 s later.
        assert_eq!(EndAnchor::update(&mut anchor, Some(600), 900, 1005), Some(1600));
        assert_eq!(EndAnchor::update(&mut anchor, Some(600), 900, 1010), Some(1600));
        // A new report: 588 s left at t=1012.
        assert_eq!(EndAnchor::update(&mut anchor, Some(588), 900, 1012), Some(1600));
        // No timer: no end, and the anchor goes.
        assert_eq!(EndAnchor::update(&mut anchor, None, 0, 1013), None);
        assert_eq!(anchor, None);
    }

    #[test]
    fn client_id_defaults_when_unset_or_blank() {
        assert_eq!(client_id(None), "anova-oven-server");
        assert_eq!(client_id(Some("  ")), "anova-oven-server");
        assert_eq!(client_id(Some(" oven-test ")), "oven-test");
    }
}
