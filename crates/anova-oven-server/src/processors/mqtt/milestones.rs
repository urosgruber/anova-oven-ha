//! Milestone events for Home Assistant: edges, not states.
//!
//! [`milestones`] is a pure function of two [`Snapshot`]s, the previous one
//! and the new one. The first snapshot after a start is the baseline and
//! fires nothing, so a server restart mid-cook doesn't announce
//! `cook_started` again. One edge, one event: a preheat whose next stage
//! waits for the user ends with `stage_waiting`, and `preheat_done` follows
//! only when the user starts that stage.
//!
//! The stage comes from the server's cook progress, which in local mode
//! follows the oven's own `activeStageIndex` and
//! `stageTransitionPendingUserAction`. In cloud mode it's inferred, so
//! `stage_waiting` can be late or missed, and since cloud mode never sets
//! `cook_done`, every end of a cook there is `cook_stopped`.
//!
//! `temp_reached` needs a memory: the oven reached the stage's target once,
//! so a dip (the door opened) does not announce it again. [`Snapshot::carry`]
//! copies that flag from the previous snapshot while the stage stays the
//! same.

use anova_oven_api::{CurrentCook, OvenStatus, Stage};

use super::recipes;

/// What the milestones are worked out from.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    /// The oven's connection to the server.
    pub connected: bool,
    pub cooking: bool,
    /// The oven's `cookId`, which identifies the cook. Not the current
    /// cook's start time: in local mode that moves from the state machine's
    /// placeholder to the journal's once, mid-cook.
    pub cook_key: Option<String>,
    pub recipe_title: Option<String>,
    pub stage_index: Option<usize>,
    pub stages: Vec<Stage>,
    pub next_stage_ready: bool,
    pub cook_done: bool,
    /// The oven's display unit, for the stage summaries.
    pub unit: String,
    /// The reading the oven cooks to: the wet bulb in sous vide, else the
    /// dry bulb.
    pub temperature_c: Option<f32>,
    /// The running stage's target for that reading.
    pub target_c: Option<f32>,
    /// Sous vide (wet bulb).
    pub wet: bool,
    /// The running stage uses water: sous vide or steam.
    pub uses_water: bool,
    pub water_tank_empty: bool,
    /// The running stage has a timer or a probe target, so it ends.
    pub has_end: bool,
    /// The oven has been at the target in this stage. Set by [`Self::carry`].
    pub reached: bool,
    /// `water_empty` was announced in this stage. Set by [`Self::carry`], so
    /// a tank flag that flaps does not announce it again and again.
    pub tank_warned: bool,
    /// The faults the oven reports now (see `protocol::faults`).
    pub faults: Vec<String>,
    /// The faults already announced. Set by [`Self::carry`]: kept until the
    /// oven is idle with no fault, so a flag that flaps announces once.
    pub faults_warned: Vec<String>,
}

/// The running stage ends by itself: its timer or probe target, or a timer
/// that runs (set on the oven during the stage). Not the oven's raw timer
/// total: during a preheat it shows the next stage's timer.
fn has_end(status: Option<&OvenStatus>, stage: Option<&Stage>) -> bool {
    let running = status.is_some_and(|s| s.timer_mode == "running" && s.timer_total_secs > 0);
    running
        || match stage {
            Some(st) => {
                (st.timer_added == Some(true) && st.duration_secs.is_some_and(|d| d > 0))
                    || (st.probe_added == Some(true) && st.probe_target_c.is_some())
            }
            None => status.is_some_and(|s| s.probe_target_temperature_c.is_some()),
        }
}

impl Snapshot {
    /// From the full `/status` (with `cook_progress` attached) and the
    /// current cook.
    pub fn new(status: Option<&OvenStatus>, cook: Option<&CurrentCook>, connected: bool) -> Self {
        let progress = status.and_then(|s| s.cook_progress.as_ref());
        let stage_index = progress
            .map(|p| p.current_stage_index)
            .or_else(|| status.and_then(|s| s.active_stage_index));
        let stages = cook.map(|c| c.stages.clone()).unwrap_or_default();
        let stage = stage_index.and_then(|i| stages.get(i));
        let wet = status.is_some_and(|s| s.temperature_bulbs_mode == "wet");
        Snapshot {
            connected,
            cooking: status.is_some_and(OvenStatus::is_cooking),
            cook_key: status.and_then(|s| s.cook_id.clone()),
            recipe_title: cook.map(|c| c.recipe_title.clone()),
            stage_index,
            next_stage_ready: progress.is_some_and(|p| p.next_stage_ready),
            cook_done: status.is_some_and(|s| s.cook_done),
            unit: status.map_or_else(|| "C".into(), |s| s.temperature_unit.clone()),
            temperature_c: status.map(OvenStatus::current_temperature_c),
            target_c: status.and_then(|s| {
                if s.temperature_bulbs_mode == "wet" {
                    s.wet_target_temperature_c
                } else {
                    s.target_temperature_c
                }
            }),
            wet,
            // The running stage's steam setting. The oven reports the steam
            // target only in relative-humidity mode, and the server starts
            // steam stages in steam-percentage mode.
            uses_water: wet
                || match stage {
                    Some(st) => st.steam_pct > 0.0,
                    None => status.is_some_and(|s| s.steam_target_pct.is_some_and(|p| p > 0.0)),
                },
            water_tank_empty: status.is_some_and(|s| s.water_tank_empty),
            has_end: has_end(status, stage),
            reached: false,
            tank_warned: false,
            faults: status.map(|s| s.faults.clone()).unwrap_or_default(),
            faults_warned: Vec::new(),
            stages,
        }
    }
    /// Take over `reached` from the previous snapshot while the cook and
    /// its stage stay the same. Call it before [`milestones`].
    pub fn carry(&mut self, prev: &Snapshot) {
        let same = self.same_stage(prev);
        self.reached = self.near_target() || (same && prev.reached);
        self.tank_warned = same && (prev.tank_warned || prev.dry_tank());
        self.faults_warned = if !self.cooking && self.faults.is_empty() {
            Vec::new()
        } else {
            let mut w = prev.faults_warned.clone();
            for f in &prev.faults {
                if !w.contains(f) {
                    w.push(f.clone());
                }
            }
            w
        };
    }

    /// A fault that has not been announced yet.
    fn new_fault(&self, prev: &Snapshot) -> bool {
        self.faults
            .iter()
            .any(|f| !prev.faults.contains(f) && !self.faults_warned.contains(f))
    }

    /// The tank is empty during a stage that needs water.
    fn dry_tank(&self) -> bool {
        self.cooking && self.uses_water && self.water_tank_empty
    }

    /// Within 2 °C of the target (0.5 °C in sous vide), from above or below.
    fn near_target(&self) -> bool {
        let tolerance = if self.wet { 0.5 } else { 2.0 };
        self.cooking
            && matches!((self.temperature_c, self.target_c),
                (Some(t), Some(target)) if (t - target).abs() <= tolerance)
    }

    /// Both snapshots show the same cook on the same stage. A cook ID that
    /// arrives late does not make a new cook.
    fn same_stage(&self, prev: &Snapshot) -> bool {
        prev.cooking
            && self.cooking
            && prev.stage_index == self.stage_index
            && !matches!((&prev.cook_key, &self.cook_key), (Some(a), Some(b)) if a != b)
    }

    /// The cook runs dry and nothing ends it: no timer and no probe, or the
    /// last timer ended and the oven holds the temperature. The safety
    /// limit stops such a cook. Sous vide is never limited: it runs 24 h+.
    pub fn unbounded(&self) -> bool {
        self.cooking && !self.wet && (self.cook_done || !self.has_end)
    }

    fn stage(&self, index: Option<usize>) -> Option<&Stage> {
        self.stages.get(index?)
    }

    /// The event's payload: what a notification needs to say which cook and
    /// stage it's about.
    pub fn payload(&self, kind: &str) -> serde_json::Value {
        serde_json::json!({
            "event_type": kind,
            "cook_id": self.cook_key,
            "recipe_title": self.recipe_title,
            "stage_index": self.stage_index,
            "stage_count": self.stages.len(),
            "current_stage": self.stage(self.stage_index).map(|s| recipes::summary(s, &self.unit)),
            "next_stage": self
                .stage(self.stage_index.map(|i| i + 1))
                .map(|s| recipes::summary(s, &self.unit)),
            "target_c": self.target_c,
            "wet": self.wet,
            "unit": self.unit,
            "faults": self.faults,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Milestone {
    CookStarted,
    PreheatDone,
    StageStarted,
    StageWaiting,
    CookDone,
    CookStopped,
    OvenLost,
    TempReached,
    WaterEmpty,
    Fault,
}

impl Milestone {
    pub fn as_str(self) -> &'static str {
        match self {
            Milestone::CookStarted => "cook_started",
            Milestone::PreheatDone => "preheat_done",
            Milestone::StageStarted => "stage_started",
            Milestone::StageWaiting => "stage_waiting",
            Milestone::CookDone => "cook_done",
            Milestone::CookStopped => "cook_stopped",
            Milestone::OvenLost => "oven_lost",
            Milestone::TempReached => "temp_reached",
            Milestone::WaterEmpty => "water_empty",
            Milestone::Fault => "oven_fault",
        }
    }

    /// Whether the event is about the cook as it was (it has just gone).
    pub fn describes_previous(self) -> bool {
        matches!(self, Milestone::CookStopped | Milestone::OvenLost)
    }
}

/// Every `event_type` the event entity announces.
pub const EVENT_TYPES: [&str; 11] = [
    "cook_started",
    "preheat_done",
    "stage_started",
    "stage_waiting",
    "cook_done",
    "cook_stopped",
    "command_failed",
    "oven_lost",
    "temp_reached",
    "water_empty",
    "oven_fault",
];

/// The milestones between two snapshots.
pub fn milestones(prev: &Snapshot, next: &Snapshot) -> Vec<Milestone> {
    let mut out = Vec::new();

    if prev.connected && !next.connected && prev.cooking {
        out.push(Milestone::OvenLost);
    }
    // While the oven is away its last state stands; nothing else to say.
    if !next.connected {
        return out;
    }

    match (prev.cooking, next.cooking) {
        (false, true) => out.push(Milestone::CookStarted),
        (true, false) => {
            // A cook that reached its end already said `cook_done`.
            if !prev.cook_done {
                out.push(Milestone::CookStopped);
            }
        }
        (true, true) => {
            let new_cook = matches!(
                (&prev.cook_key, &next.cook_key),
                (Some(a), Some(b)) if a != b
            );
            if new_cook {
                out.push(Milestone::CookStarted);
            } else if let (Some(before), Some(after)) = (prev.stage_index, next.stage_index) {
                if before != after {
                    let was_preheat = prev
                        .stage(Some(before))
                        .is_some_and(|s| s.kind == "preheat");
                    out.push(if was_preheat {
                        Milestone::PreheatDone
                    } else {
                        Milestone::StageStarted
                    });
                }
            }
            // A preheat stage says `preheat_done` instead.
            let preheat = next
                .stage(next.stage_index)
                .is_some_and(|s| s.kind == "preheat");
            if !new_cook && next.same_stage(prev) && !prev.reached && next.reached && !preheat {
                out.push(Milestone::TempReached);
            }
            if !new_cook && !prev.next_stage_ready && next.next_stage_ready {
                out.push(Milestone::StageWaiting);
            }
            if !new_cook && !prev.cook_done && next.cook_done {
                out.push(Milestone::CookDone);
            }
        }
        (false, false) => {}
    }

    // The tank runs empty during a stage that needs water, or a cook starts
    // (or reaches such a stage) with the tank empty. Once per stage. After
    // `cook_started`, so the processor knows who started the cook first.
    if next.dry_tank() && !next.tank_warned && !(next.same_stage(prev) && prev.dry_tank()) {
        out.push(Milestone::WaterEmpty);
    }
    // A part failed or overheated, in a cook or not. Once per fault.
    if next.new_fault(prev) {
        out.push(Milestone::Fault);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::mqtt::recipes::tests::stage;

    fn cooking(stage_index: usize) -> Snapshot {
        Snapshot {
            connected: true,
            cooking: true,
            cook_key: Some("cook-1".into()),
            recipe_title: Some("Bread".into()),
            stage_index: Some(stage_index),
            stages: vec![stage("preheat"), stage("cook"), stage("cook")],
            unit: "C".into(),
            ..Default::default()
        }
    }

    fn idle() -> Snapshot {
        Snapshot {
            connected: true,
            ..Default::default()
        }
    }

    fn sequence(snapshots: &[Snapshot]) -> Vec<&'static str> {
        snapshots
            .windows(2)
            .flat_map(|w| milestones(&w[0], &w[1]))
            .map(Milestone::as_str)
            .collect()
    }

    #[test]
    fn a_multi_stage_cook_produces_each_milestone_once() {
        let waiting = Snapshot {
            next_stage_ready: true,
            ..cooking(1)
        };
        let done = Snapshot {
            cook_done: true,
            ..cooking(2)
        };
        assert_eq!(
            sequence(&[
                idle(),
                cooking(0),
                cooking(0), // a repeat report: nothing
                cooking(1), // the preheat ended
                waiting.clone(),
                waiting,    // still waiting: nothing
                cooking(2), // the user started stage 3
                done.clone(),
                done,
                idle(), // stopped after the end: no cook_stopped
            ]),
            [
                "cook_started",
                "preheat_done",
                "stage_waiting",
                "stage_started",
                "cook_done"
            ]
        );
    }

    #[test]
    fn a_preheat_waiting_for_the_user_says_waiting_then_done() {
        let waiting = Snapshot {
            next_stage_ready: true,
            ..cooking(0)
        };
        assert_eq!(
            sequence(&[cooking(0), waiting, cooking(1)]),
            ["stage_waiting", "preheat_done"]
        );
    }

    #[test]
    fn stopping_early_is_cook_stopped() {
        assert_eq!(sequence(&[cooking(1), idle()]), ["cook_stopped"]);
    }

    #[test]
    fn a_new_cook_over_a_running_one_is_cook_started() {
        let replaced = Snapshot {
            cook_key: Some("cook-2".into()),
            ..cooking(0)
        };
        assert_eq!(sequence(&[cooking(1), replaced]), ["cook_started"]);
        // A cook whose record arrives late is the same cook.
        let unknown = Snapshot {
            cook_key: None,
            ..cooking(0)
        };
        assert!(sequence(&[unknown, cooking(0)]).is_empty());
    }

    #[test]
    fn losing_the_oven_mid_cook_is_oven_lost_and_nothing_else() {
        let lost = Snapshot {
            connected: false,
            ..cooking(1)
        };
        assert_eq!(
            sequence(&[cooking(1), lost.clone(), cooking(1)]),
            ["oven_lost"]
        );
        let idle_lost = Snapshot {
            connected: false,
            ..idle()
        };
        assert!(sequence(&[idle(), idle_lost]).is_empty());
    }

    /// `carry` each snapshot from the one before, as the processor does.
    fn carried(snapshots: &[Snapshot]) -> Vec<&'static str> {
        let mut out: Vec<Snapshot> = Vec::new();
        for s in snapshots {
            let mut s = s.clone();
            if let Some(prev) = out.last() {
                s.carry(prev);
            }
            out.push(s);
        }
        sequence(&out)
    }

    fn heating(stage_index: usize, temp: f32) -> Snapshot {
        Snapshot {
            temperature_c: Some(temp),
            target_c: Some(200.0),
            has_end: false,
            ..cooking(stage_index)
        }
    }

    #[test]
    fn temp_reached_once_per_stage() {
        assert_eq!(
            carried(&[
                heating(1, 20.0),
                heating(1, 150.0),
                heating(1, 198.5), // within 2 °C
                heating(1, 201.0),
                heating(1, 180.0), // the door opened: no new event
                heating(1, 199.0),
            ]),
            ["temp_reached"]
        );
    }

    #[test]
    fn temp_reached_not_for_a_preheat_stage_nor_a_hot_start() {
        // Stage 0 is a preheat: preheat_done says it.
        assert!(carried(&[heating(0, 20.0), heating(0, 199.0)]).is_empty());
        // The next stage starts at its target already: nothing to announce.
        assert_eq!(
            carried(&[heating(1, 20.0), heating(1, 200.0), heating(2, 200.0)]),
            ["temp_reached", "stage_started"]
        );
        // `reached` does not leak into the next stage: it heats again first.
        assert_eq!(
            carried(&[heating(1, 20.0), heating(1, 200.0), heating(2, 150.0), heating(2, 199.0)]),
            ["temp_reached", "stage_started", "temp_reached"]
        );
        // Sous vide uses 0.5 °C.
        let wet = |t| Snapshot { wet: true, target_c: Some(56.0), ..heating(1, t) };
        assert!(carried(&[wet(50.0), wet(55.0)]).is_empty());
        assert_eq!(carried(&[wet(50.0), wet(55.6)]), ["temp_reached"]);
    }

    #[test]
    fn water_empty_only_when_the_stage_needs_water() {
        let steam = |empty| Snapshot { uses_water: true, water_tank_empty: empty, ..cooking(1) };
        let dry = Snapshot { water_tank_empty: true, ..cooking(1) };
        // A flag that flaps announces it once per stage.
        assert_eq!(
            carried(&[steam(false), steam(true), steam(true), steam(false), steam(true)]),
            ["water_empty"]
        );
        // A new stage that needs water announces it again.
        assert_eq!(
            carried(&[steam(true), Snapshot { stage_index: Some(2), ..steam(true) }]),
            ["stage_started", "water_empty"]
        );
        assert!(sequence(&[cooking(1), dry.clone()]).is_empty());
        // A cook that starts with the tank empty.
        assert_eq!(sequence(&[idle(), steam(true)]), ["cook_started", "water_empty"]);
        // A dry stage, then a steam stage with the tank empty.
        assert_eq!(
            sequence(&[dry, Snapshot { stage_index: Some(2), ..steam(true) }]),
            ["stage_started", "water_empty"]
        );
    }

    #[test]
    fn unbounded_is_a_dry_cook_with_no_end() {
        assert!(heating(1, 200.0).unbounded());
        assert!(!Snapshot { has_end: true, ..heating(1, 200.0) }.unbounded());
        assert!(Snapshot { has_end: true, cook_done: true, ..heating(1, 200.0) }.unbounded());
        assert!(!Snapshot { wet: true, ..heating(1, 56.0) }.unbounded());
        assert!(!idle().unbounded());
    }

    #[test]
    fn a_new_cook_over_a_running_one_is_only_cook_started() {
        let done = Snapshot { cook_done: true, ..cooking(2) };
        let replaced = Snapshot { cook_key: Some("cook-2".into()), cook_done: true, ..cooking(0) };
        assert_eq!(sequence(&[cooking(2), replaced.clone()]), ["cook_started"]);
        assert_eq!(sequence(&[done, replaced]), ["cook_started"]);
    }

    fn status(timer_mode: &str, total: u64) -> OvenStatus {
        let mut s: OvenStatus = serde_json::from_value(serde_json::json!({
            "mode": "cook", "temperature_unit": "C", "temperature_c": 20.0,
            "temperature_bulbs_mode": "dry", "dry_top_temperature_c": 20.0,
            "dry_bottom_temperature_c": 20.0, "wet_bulb_temperature_c": 20.0,
            "timer_current_secs": total, "timer_total_secs": total, "timer_mode": timer_mode,
            "steam_pct": 0.0, "steam_generator_mode": "idle", "boiler_celsius": 20.0,
            "boiler_watts": 0.0, "boiler_descale_required": false, "evaporator_celsius": 20.0,
            "evaporator_watts": 0.0, "fan_speed": 0, "heating_element_top_on": false,
            "heating_element_top_watts": 0.0, "heating_element_rear_on": false,
            "heating_element_rear_watts": 0.0, "heating_element_bottom_on": false,
            "heating_element_bottom_watts": 0.0, "lamp_on": false, "lamp_preference": "off",
            "vent_open": false, "door_open": false, "water_tank_empty": false,
        }))
        .unwrap();
        s.active_stage_index = Some(0);
        s
    }

    #[test]
    fn a_fault_is_announced_once() {
        let mut prev = cooking(1);
        prev.carry(&cooking(1));
        let mut next = Snapshot { faults: vec!["triacs_failed".into()], ..cooking(1) };
        next.carry(&prev);
        assert_eq!(milestones(&prev, &next), [Milestone::Fault]);
        // The flag flaps: off, then on again. No second message.
        let mut off = cooking(1);
        off.carry(&next);
        assert!(milestones(&next, &off).is_empty());
        let mut again = Snapshot { faults: vec!["triacs_failed".into()], ..cooking(1) };
        again.carry(&off);
        assert!(milestones(&off, &again).is_empty());
        // A second fault is new.
        let mut more = Snapshot { faults: vec!["triacs_failed".into(), "fan_failed".into()], ..cooking(1) };
        more.carry(&again);
        assert_eq!(milestones(&again, &more), [Milestone::Fault]);
        // Idle with no fault forgets them; the next one is announced again.
        let idle = Snapshot { connected: true, ..Snapshot::default() };
        let mut clear = idle.clone();
        clear.carry(&more);
        let mut back = Snapshot { faults: vec!["triacs_failed".into()], ..idle };
        back.carry(&clear);
        assert_eq!(milestones(&clear, &back), [Milestone::Fault]);
    }

    #[test]
    fn a_descale_is_not_a_cook() {
        // Seen on firmware 2.1.16: mode "descale", timer idle, no stages.
        let mut s = status("idle", 0);
        s.mode = "descale".into();
        s.active_stage_index = None;
        assert!(!s.is_cooking() && s.is_descaling());
        assert_eq!(s.phase(), "Descaling");
        let snap = Snapshot::new(Some(&s), None, true);
        assert!(!snap.cooking && !snap.unbounded(), "no safety stop, no auto stop");
        let mut i = status("idle", 0);
        i.mode = "idle".into();
        i.active_stage_index = None;
        let idle = Snapshot::new(Some(&i), None, true);
        assert!(milestones(&idle, &snap).is_empty(), "no cook_started");
        assert!(milestones(&snap, &idle).is_empty(), "no cook_stopped");
    }

    #[test]
    fn the_end_and_the_water_come_from_the_running_stage() {
        let mut timed = stage("cook");
        timed.timer_added = Some(true);
        timed.duration_secs = Some(1200);
        let mut steam = stage("cook");
        steam.steam_pct = 30.0;
        // A preheat shows the next stage's timer in the raw timer: no end.
        assert!(!has_end(Some(&status("idle", 1200)), Some(&stage("preheat"))));
        assert!(has_end(Some(&status("idle", 1200)), Some(&timed)));
        // A timer set on the oven during a stage with no timer.
        assert!(has_end(Some(&status("running", 600)), Some(&stage("cook"))));
        // Steam from the stage: the oven's steam target stays empty.
        let cook = |st: &Stage| CurrentCook {
            recipe_title: "Manual cook".into(),
            recipe_id: None,
            started_at: "2026-11-06T10:00:00Z".into(),
            stages: vec![st.clone()],
            cook_stage_count: 1,
            total_stage_count: 1,
        };
        let s = status("idle", 0);
        assert!(Snapshot::new(Some(&s), Some(&cook(&steam)), true).uses_water);
        assert!(!Snapshot::new(Some(&s), Some(&cook(&stage("cook"))), true).uses_water);
    }

    #[test]
    fn payload_names_the_cook_and_stages() {
        let p = cooking(0).payload("cook_started");
        assert_eq!(p["event_type"], "cook_started");
        assert_eq!(p["cook_id"], "cook-1");
        assert_eq!(p["stage_count"], 3);
        assert_eq!(p["current_stage"], "Preheat · 220 °C dry");
        assert_eq!(p["next_stage"], "Cook · 220 °C dry");
    }
}
