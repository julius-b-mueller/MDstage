//! Runs a show: Go, Back and everything a fired cue sets in motion.
//!
//! `Show` joins the cue logic of `mdstage-core` (what should happen) with the `Player`
//! (audio). Everything else a cue does — microphones, MIDI, OSC, HTTP, displays — is
//! collected as `Effect`s for the caller to deliver, so this module needs no devices and
//! runs the same in tests as on stage.
//!
//! Call `tick` every few milliseconds: transitions that happen inside the audio engine
//! (chains, queued outros) and timed auto-cues are noticed there.

use std::collections::HashMap;
use std::sync::Arc;

use mdstage_core::audio::CueAudio;
use mdstage_core::cues::{AutoWhen, Cues, DeviceKind, DeviceState, History, Note};
use mdstage_core::effects::{Effect, resend_effects};
use mdstage_core::mic::{Cast, Mic};
use mdstage_core::{Block, Script};

use crate::Result;
use crate::clock::{EngineClock, VoiceState};
use crate::mtc::{FrameRate, Timecode};
use crate::player::{Player, Start, Then};

/// Fade used when Back stops what the undone cues started.
const BACK_FADE: f64 = 0.5;
/// Shorter fade for an outro whose loop is brought back at the same moment: two long
/// fades of similar material overlapping would sound like a phaser.
const HANDOVER_FADE: f64 = 0.05;
/// Fade of `music.adjust` when the cue does not set one.
const DEFAULT_ADJUST_FADE: f64 = 3.0;

/// How far back a playing position has to jump to count as a new pass of a loop.
const WRAP: f64 = 0.3;

/// A delay auto-cue waiting to fire.
struct Delay {
    target: usize,
    source: usize,
    started: f64,
    due: f64,
}

/// An audio-position auto-cue: fires `target` when `source`'s audio is at or past `at`,
/// once per pass of a loop.
struct Watch {
    target: usize,
    source: usize,
    at: f64,
    /// Done for this pass.
    fired: bool,
    last: Option<f64>,
    /// Where the source's audio stood when the wait for this pass began.
    from: Option<f64>,
}

/// A cue that is waiting to fire by itself, for the UI: how much of the wait is over,
/// from 0 when the wait began to 1 when the cue fires.
#[derive(Clone, Debug, PartialEq)]
pub struct Wait {
    pub cue: usize,
    pub fraction: f64,
}

/// Microphones that an auto-mic cue would have switched off and that stay on a little
/// longer.
struct Hold {
    cue: usize,
    /// What the microphones are set to when the time is up.
    then: Mic,
    leaving: Vec<String>,
    started: f64,
    due: f64,
}

/// Microphones on their way out, for the UI: the cue that sent them off, the roles, and
/// how much of the wait is over (0 to 1).
#[derive(Clone, Debug, PartialEq)]
pub struct MicHold {
    pub cue: usize,
    pub leaving: Vec<String>,
    pub fraction: f64,
}

/// The cue that drives the timecode.
struct TimecodeSource {
    cue: usize,
    /// Timecode (seconds) at the start of the cue's first part.
    base: f64,
    /// `(start, transition)` of each part, to add up the parts already played.
    spans: Vec<(f64, f64)>,
}

/// Where audio stood when a cue (or a second press) stopped it, so that Back can bring
/// it in again where it would be now.
#[derive(Clone, Copy, Debug)]
struct Stopped {
    part: usize,
    seconds: f64,
    /// When it was stopped (show time).
    at: f64,
    /// Where the part ends: audio that would have got there by now stays off.
    end: f64,
}

/// Something the operator did with Go (or by firing a cue by hand) that Back takes back.
struct Step {
    /// How many cues the history held before it.
    entry: usize,
    /// What was armed and which variant chosen before it: Back brings that back.
    armed: Option<usize>,
    variant: Option<usize>,
    /// The cue whose playing audio it stopped (a second press on a playing cue), if
    /// that is what it did.
    stopped: Option<usize>,
}

/// What firing a cue came to.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fired {
    Nothing,
    /// Its audio was playing and was stopped.
    Stopped,
    /// An outro now waits for its loop's end.
    Queued,
    Began,
}

/// Progress of a pending delay auto-cue, for the UI.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DelayProgress {
    pub target: usize,
    /// 0.0 just armed … 1.0 about to fire.
    pub fraction: f64,
}

pub struct Show {
    script: Arc<Script>,
    cast: Cast,
    history: History,
    player: Player,
    clock: Option<Arc<EngineClock>>,
    armed: Option<usize>,
    selected_variant: Option<usize>,
    /// `(loop, outro)`: outros waiting for their loop to reach its end.
    pending_outros: Vec<(usize, usize)>,
    /// `(from, to)`: chained successors loaded and waiting for the handoff.
    chains: Vec<(usize, usize)>,
    delays: Vec<Delay>,
    watches: Vec<Watch>,
    /// `(target, source)`: auto-cues waiting for their source's audio to end by itself.
    ends: Vec<(usize, usize)>,
    /// Seconds an auto-mic cue leaves a microphone on that it switches off.
    mic_off_delay: f64,
    mic_hold: Option<Hold>,
    /// For cues waiting on another's audio to get somewhere (an outro on its loop's end,
    /// a chained cue on its predecessor's): where that audio stood when the wait began.
    waits_from: HashMap<usize, f64>,
    /// When each running loop was (or would have been) at the start of its cycle.
    loop_epochs: HashMap<usize, f64>,
    /// Where audio stood when it was stopped by a cue or a second press, for Back.
    stopped_at: HashMap<usize, Stopped>,
    /// The operator's steps, oldest first, for Back.
    steps: Vec<Step>,
    /// `(entry, cue)`: audio that the cue fired as history entry `entry` stopped (a fade
    /// out by `music.adjust`, a timecode taken over, an auto-cue on playing audio).
    stops: Vec<(usize, usize)>,
    /// Where audio stands that the operator paused or placed by hand on its waveform:
    /// `(part, seconds)`. Playing the cue's audio from the waveform starts there.
    paused: HashMap<usize, (usize, f64)>,
    timecode: Option<TimecodeSource>,
    /// The rate `start_tc` is read at.
    frame_rate: FrameRate,
    effects: Vec<Effect>,
    /// Things that went wrong and the operator should know about.
    problems: Vec<String>,
    /// Display content as last reported, by device.
    shown: HashMap<String, String>,
    now: f64,
}

impl Show {
    pub fn new(script: Script, player: Player, clock: Option<Arc<EngineClock>>, english: bool) -> Show {
        let cast = Cast::from_script(&script, english);
        Show {
            script: Arc::new(script),
            cast,
            history: History::default(),
            player,
            clock,
            armed: None,
            selected_variant: None,
            pending_outros: Vec::new(),
            chains: Vec::new(),
            delays: Vec::new(),
            watches: Vec::new(),
            ends: Vec::new(),
            mic_off_delay: 0.0,
            mic_hold: None,
            waits_from: HashMap::new(),
            loop_epochs: HashMap::new(),
            stopped_at: HashMap::new(),
            steps: Vec::new(),
            stops: Vec::new(),
            paused: HashMap::new(),
            timecode: None,
            frame_rate: FrameRate::default(),
            effects: Vec::new(),
            problems: Vec::new(),
            shown: HashMap::new(),
            now: 0.0,
        }
    }

    pub fn script(&self) -> &Script {
        &self.script
    }

    /// The show's frame rate: what the frames of `start_tc` count.
    pub fn set_frame_rate(&mut self, rate: FrameRate) {
        self.frame_rate = rate;
    }

    pub fn frame_rate(&self) -> FrameRate {
        self.frame_rate
    }

    /// The moment `start_tc` stands for, if it is a timecode at the show's rate.
    fn start_tc(&self, text: Option<&str>) -> Option<f64> {
        self.frame_rate.seconds(Timecode::parse(text?)?)
    }

    /// Swap in an edited script while the show runs. Nothing stops: every cue is found
    /// again under its new number (see [`mdstage_core::cues::mapping`]), with what was
    /// fired, what is armed and what is playing. Only the audio of a cue that is gone
    /// fades out. Audio that plays takes on what was changed about it on the spot.
    pub fn replace_script(&mut self, script: Script) -> Result<()> {
        let map = mdstage_core::cues::mapping(&self.script, &script);
        let to = |cue: usize| map.get(cue).copied().flatten();
        // What the audio that is there was started as, to tell what the edit changed.
        let before: Vec<(usize, Option<CueAudio>, Then)> = self.player.active_cues().into_iter().map(|cue| (cue, self.audio(cue), self.then(cue))).collect();

        // Where each place in the history goes when cues that are gone leave it.
        let mut kept_before = vec![0];
        for cue in self.history.cues() {
            kept_before.push(kept_before.last().unwrap() + usize::from(to(cue).is_some()));
        }
        let entry = |entry: usize| kept_before[entry.min(kept_before.len() - 1)];

        self.cast = Cast::from_script(&script, self.cast.english);
        self.script = Arc::new(script);
        self.player.remap(to)?;
        self.history.remap(&map);
        self.steps = std::mem::take(&mut self.steps)
            .into_iter()
            .filter_map(|step| {
                let stopped = match step.stopped {
                    Some(cue) => Some(to(cue)?),
                    None => None,
                };
                Some(Step { entry: entry(step.entry), armed: step.armed.and_then(to), variant: step.variant.and_then(to), stopped })
            })
            .collect();
        self.stops = self.stops.iter().filter_map(|&(at, cue)| Some((entry(at), to(cue)?))).collect();
        self.armed = self.armed.and_then(to);
        self.selected_variant = self.selected_variant.and_then(to);
        let pairs = |list: &[(usize, usize)]| list.iter().filter_map(|&(a, b)| Some((to(a)?, to(b)?))).collect::<Vec<_>>();
        self.pending_outros = pairs(&self.pending_outros);
        self.chains = pairs(&self.chains);
        self.ends = pairs(&self.ends);
        self.delays = std::mem::take(&mut self.delays).into_iter().filter_map(|d| Some(Delay { target: to(d.target)?, source: to(d.source)?, ..d })).collect();
        self.watches = std::mem::take(&mut self.watches).into_iter().filter_map(|w| Some(Watch { target: to(w.target)?, source: to(w.source)?, ..w })).collect();
        if let Some(hold) = &mut self.mic_hold {
            // (Its cue is only what the countdown is shown at.)
            hold.cue = to(hold.cue).unwrap_or(hold.cue);
        }
        fn rekey<T>(map: &mut HashMap<usize, T>, to: impl Fn(usize) -> Option<usize>) {
            *map = std::mem::take(map).into_iter().filter_map(|(cue, value)| Some((to(cue)?, value))).collect();
        }
        rekey(&mut self.waits_from, to);
        rekey(&mut self.loop_epochs, to);
        rekey(&mut self.stopped_at, to);
        rekey(&mut self.paused, to);
        self.timecode = self.timecode.take().and_then(|t| Some(TimecodeSource { cue: to(t.cue)?, ..t }));

        for (old, audio_before, then_before) in before {
            let Some(cue) = to(old) else { continue };
            let then_before = match then_before {
                Then::Chain(next) => to(next).map_or(Then::End, Then::Chain),
                other => other,
            };
            let (audio, then) = (self.audio(cue), self.then(cue));
            if audio == audio_before && then == then_before {
                continue;
            }
            let Some(status) = self.player.status(cue, self.clock.as_deref()) else { continue };
            let Some(mut audio) = audio else {
                self.player.stop(cue, 0.05)?;
                self.forget_audio_of(&[cue]);
                continue;
            };
            match status.state {
                // Waiting for a handoff: it waits on, as it now is.
                VoiceState::Armed => self.player.start(cue, &audio, Start::armed(then))?,
                VoiceState::Playing => {
                    // The level it plays at is what the fired cues have made of it (an
                    // adjust may have turned it down), not simply what the file says.
                    if self.history.fired(cue) {
                        let level = self.history.audio_state(&Cues::new(&self.script), cue).1;
                        for part in &mut audio.parts {
                            part.volume = level;
                        }
                    }
                    let level = audio.parts[status.part.min(audio.parts.len() - 1)].volume;
                    let but_for_level = |audio: &CueAudio| audio.parts.iter().map(|part| mdstage_core::audio::Part { volume: 1.0, ..part.clone() }).collect::<Vec<_>>();
                    let only_level = then == then_before && audio_before.as_ref().is_some_and(|b| b.looped == audio.looped && but_for_level(b) == but_for_level(&audio));
                    if only_level {
                        self.player.fade(cue, level, 0.05)?;
                        continue;
                    }
                    // Anything else: the audio comes in anew at the place it is at.
                    let part = status.part.min(audio.parts.len() - 1);
                    self.player.start(cue, &audio, Start { armed: false, then, resume: Some((part, status.seconds)) })?;
                    for (looped, outro) in self.pending_outros.clone() {
                        if looped == cue {
                            self.player.queue_outro(looped, outro)?;
                        }
                    }
                    if let Then::Chain(next) = then {
                        self.arm_chain(cue, next);
                    }
                    if then == Then::Loop {
                        let spans = self.player.spans(&audio).unwrap_or_default();
                        let into = spans[..part.min(spans.len())].iter().map(|(a, b)| b - a).sum::<f64>() + (status.seconds - spans.get(part).map_or(0.0, |s| s.0));
                        self.loop_epochs.insert(cue, self.now - into);
                    }
                }
                _ => {}
            }
        }
        // The auto-cues that hang on audio that is there, as the script now has them.
        let sources: Vec<(usize, f64)> = self
            .player
            .active_cues()
            .into_iter()
            .filter_map(|cue| Some((cue, self.player.status(cue, self.clock.as_deref()).filter(|s| s.part == 0 && s.state == VoiceState::Playing)?.seconds)))
            .chain(self.paused.iter().filter(|(_, (part, _))| *part == 0).map(|(cue, (_, seconds))| (*cue, *seconds)))
            .collect();
        for (cue, seconds) in sources {
            self.watches.retain(|w| w.source != cue);
            self.watch(cue, Some(seconds));
        }
        self.report_displays();
        Ok(())
    }

    /// Load the audio of `next` to wait, silent, for `cue` to hand off to it at its end.
    fn arm_chain(&mut self, cue: usize, next: usize) {
        let Some(next_audio) = self.audio(next).filter(|_| !self.chains.contains(&(cue, next))) else { return };
        match self.player.start(next, &next_audio, Start::armed(self.then(next))) {
            Ok(()) => {
                self.chains.push((cue, next));
                if let Some(status) = self.player.status(cue, self.clock.as_deref()) {
                    self.waits_from.insert(next, status.seconds);
                }
            }
            Err(e) => self.problems.push(format!("{}: {e}", Cues::new(&self.script).name(next))),
        }
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    pub fn player(&mut self) -> &mut Player {
        &mut self.player
    }

    /// The cue Go fires next (what the live view focuses).
    pub fn next(&self) -> Option<usize> {
        let cues = Cues::new(&self.script);
        self.history.go(&cues, self.armed, self.selected_variant)
    }

    /// How long an auto-mic cue leaves microphones on that it switches off (seconds).
    pub fn set_mic_off_delay(&mut self, seconds: f64) {
        // (Never longer than ten minutes, whatever the settings file says.)
        self.mic_off_delay = if seconds.is_finite() { seconds.clamp(0.0, 600.0) } else { 0.0 };
    }

    /// The microphones that are staying on a little longer, if any.
    pub fn mic_hold(&self) -> Option<MicHold> {
        let hold = self.mic_hold.as_ref()?;
        let fraction = if hold.due > hold.started { ((self.now - hold.started) / (hold.due - hold.started)).clamp(0.0, 1.0) } else { 1.0 };
        Some(MicHold { cue: hold.cue, leaving: hold.leaving.clone(), fraction })
    }

    /// The cues that are waiting to fire by themselves, each with how far its wait has
    /// got. Every wait runs from 0, wherever the audio it depends on stood when it began:
    /// an outro queued in the middle of its loop starts at 0 and fills the faster.
    pub fn waits(&self) -> Vec<Wait> {
        let mut waits: Vec<Wait> = Vec::new();
        let along = |from: f64, now: f64, to: f64| if to > from { ((now - from) / (to - from)).clamp(0.0, 1.0) } else { 1.0 };
        for delay in &self.delays {
            waits.push(Wait { cue: delay.target, fraction: along(delay.started, self.now, delay.due) });
        }
        // Waiting for another cue's audio to reach its end or loop point.
        for &(source, waiting) in self.pending_outros.iter().chain(&self.chains) {
            if let Some(status) = self.player.status(source, self.clock.as_deref()) {
                let from = self.waits_from.get(&waiting).copied().unwrap_or(status.start).min(status.seconds);
                waits.push(Wait { cue: waiting, fraction: along(from, status.seconds, status.transition) });
            }
        }
        for watch in self.watches.iter().filter(|watch| !watch.fired) {
            if let Some(status) = self.player.status(watch.source, self.clock.as_deref()).filter(|s| s.state == VoiceState::Playing) {
                let from = watch.from.unwrap_or(status.start).min(status.seconds);
                waits.push(Wait { cue: watch.target, fraction: along(from, status.seconds, watch.at) });
            }
        }
        for &(target, source) in &self.ends {
            if let Some(status) = self.player.status(source, self.clock.as_deref()).filter(|s| s.state == VoiceState::Playing && self.then(source) != Then::Loop) {
                waits.push(Wait { cue: target, fraction: along(status.start, status.seconds, status.end) });
            }
        }
        waits.sort_by_key(|wait| wait.cue);
        waits.dedup_by_key(|wait| wait.cue);
        waits
    }

    /// Whether Go is held back because the next cue has variants and the operator has
    /// not chosen one yet. There is no falling back on the first: which variant is
    /// taken is decided live, every time. (A cue armed by hand is a choice.)
    pub fn needs_variant(&self) -> bool {
        if self.armed.is_some() {
            return false;
        }
        let cues = Cues::new(&self.script);
        match self.history.next(&cues) {
            Some(next) if cues.in_group(next) => !self.selected_variant.is_some_and(|chosen| cues.group(next).contains(&chosen)),
            _ => false,
        }
    }

    /// Whether Go is held back because a cue is on its way by itself: a delay is running,
    /// an outro waits for its loop's end, a chained cue for its predecessor's, or an
    /// auto-cue for a place in audio that plays once. (An auto-cue in a loop comes round
    /// on every pass; it does not hold Go back, or the loop could never be left.)
    pub fn go_blocked(&self) -> bool {
        !self.delays.is_empty()
            || !self.pending_outros.is_empty()
            || !self.chains.is_empty()
            || self.watches.iter().any(|watch| !watch.fired && self.is_playing(watch.source) && self.then(watch.source) != Then::Loop)
            || self.ends.iter().any(|&(_, source)| self.is_playing(source) && self.then(source) != Then::Loop)
    }

    /// The operator's current cue.
    pub fn current(&self) -> Option<usize> {
        self.history.last_manual()
    }

    /// Outros waiting for their loop's end, as `(loop, outro)`.
    pub fn pending_outros(&self) -> &[(usize, usize)] {
        &self.pending_outros
    }

    pub fn delay_progress(&self) -> Vec<DelayProgress> {
        self.delays
            .iter()
            .map(|d| {
                let length = d.due - d.started;
                let fraction = if length > 0.0 { ((self.now - d.started) / length).clamp(0.0, 1.0) } else { 1.0 };
                DelayProgress { target: d.target, fraction }
            })
            .collect()
    }

    /// The microphones as the fired cues left them.
    pub fn mic(&self) -> Mic {
        self.history.mic(&Cues::new(&self.script), &self.cast)
    }

    /// Take the effects collected since the last call, in the order they should be sent.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// Take the problems reported since the last call (audio that could not be loaded).
    pub fn take_problems(&mut self) -> Vec<String> {
        std::mem::take(&mut self.problems)
    }

    /// Cues with audio loaded, and where each one is. A cue of several parts appears once
    /// for the part that plays (first) and once for every part that is ringing out.
    pub fn audio_status(&self) -> Vec<(usize, crate::player::Status)> {
        let clock = self.clock.as_deref();
        self.player.active_cues().into_iter().flat_map(|cue| self.player.statuses(cue, clock).into_iter().map(move |status| (cue, status))).collect()
    }

    /// Where paused audio stands: `(cue, seconds)`, for cues paused in their first part.
    pub fn paused(&self) -> Vec<(usize, f64)> {
        let mut paused: Vec<(usize, f64)> = self.paused.iter().filter(|(_, (part, _))| *part == 0).map(|(cue, (_, seconds))| (*cue, *seconds)).collect();
        paused.sort_by_key(|(cue, _)| *cue);
        paused
    }

    fn sounding(&self, cue: usize) -> Option<crate::player::Status> {
        self.player.status(cue, self.clock.as_deref()).filter(|s| matches!(s.state, VoiceState::Playing | VoiceState::Tail))
    }

    /// The transport on a cue's waveform: play the cue's audio by itself, or pause it
    /// where it is. Nothing else of the cue happens — no microphones, no messages, no
    /// entry in the history.
    pub fn play_pause(&mut self, cue: usize) -> Result<()> {
        if let Some(status) = self.sounding(cue) {
            self.paused.insert(cue, (status.part, status.seconds));
            return self.player.stop(cue, 0.02);
        }
        let Some(audio) = self.audio(cue) else { return Ok(()) };
        let resume = self.paused.remove(&cue);
        // On its own the audio does not chain on into another cue.
        let then = match self.then(cue) {
            Then::Chain(_) => Then::End,
            then => then,
        };
        self.player.start(cue, &audio, Start { armed: false, then, resume })
    }

    /// Move a cue's audio to a place in its (first) file: audio that is playing carries
    /// on from there, audio that is not will start there when played from its waveform.
    pub fn seek(&mut self, cue: usize, seconds: f64) -> Result<()> {
        let Some(audio) = self.audio(cue) else { return Ok(()) };
        if self.sounding(cue).is_none() {
            self.paused.insert(cue, (0, seconds.max(0.0)));
            return Ok(());
        }
        self.player.start(cue, &audio, Start { armed: false, then: self.then(cue), resume: Some((0, seconds.max(0.0))) })?;
        // An outro that was waiting for this loop's end still is.
        for (looped, outro) in self.pending_outros.clone() {
            if looped == cue {
                self.player.queue_outro(looped, outro)?;
            }
        }
        Ok(())
    }

    /// Stop a cue's audio, fading it out over `fade` seconds, and put it back to its start.
    pub fn stop_cue(&mut self, cue: usize, fade: f64) -> Result<()> {
        self.paused.remove(&cue);
        self.player.stop(cue, fade.max(0.0))?;
        self.forget_audio_of(&[cue]);
        Ok(())
    }

    /// Set the level of a cue's audio while it plays (the slider on its waveform).
    pub fn set_volume(&mut self, cue: usize, volume: f64) -> Result<()> {
        self.player.fade(cue, volume.clamp(0.0, 1.0), 0.03)
    }

    /// The variant chosen for the next Go, if one was.
    pub fn selected_variant(&self) -> Option<usize> {
        self.selected_variant
    }

    /// Make a cue the next Go, whatever the position (jump, "arm in live view").
    pub fn arm(&mut self, cue: Option<usize>) {
        self.armed = cue;
    }

    /// One cue back or on from the next Go, without firing anything: the cue gone to is
    /// armed (the ▲ ▼ buttons of the live view, and their remote commands). A group of
    /// variants counts as one cue.
    pub fn step(&mut self, forward: bool) {
        let cues = Cues::new(&self.script);
        let count = cues.len();
        let to = match (self.next(), forward) {
            (Some(next), false) => cues.group_root(next).checked_sub(1).map(|cue| cues.group_root(cue)),
            (Some(next), true) => Some(cues.group(next).end).filter(|cue| *cue < count),
            (None, false) => count.checked_sub(1).map(|cue| cues.group_root(cue)),
            (None, true) => None,
        };
        if to.is_some() {
            self.armed = to;
            self.selected_variant = None;
        }
    }

    /// Choose which variant of the next cue Go fires.
    pub fn select_variant(&mut self, cue: Option<usize>) {
        self.selected_variant = cue;
    }

    /// A cue's audio as it is to be played: a variant at its own volume times its group's.
    fn audio(&self, cue: usize) -> Option<CueAudio> {
        let cues = Cues::new(&self.script);
        let mut audio = cues.get(cue)?.audio()?;
        let group = cues.group_volume(cue);
        if group != 1.0 {
            for part in &mut audio.parts {
                part.volume *= group;
            }
        }
        Some(audio)
    }

    /// How a cue's audio ends: loops loop, a `chain_end` with playable audio chains.
    fn then(&self, cue: usize) -> Then {
        let cues = Cues::new(&self.script);
        let (Some(c), Some(audio)) = (cues.get(cue), self.audio(cue)) else { return Then::End };
        if c.loop_outro().is_some() || audio.looped || audio.parts.len() > 1 {
            return Then::Loop;
        }
        // (Nothing carries straight on into a variant: the operator has to choose one.)
        match c.chain_end().and_then(|n| cues.find(n)).filter(|&next| !cues.in_group(next) && self.audio(next).is_some()) {
            Some(next) => Then::Chain(next),
            None => Then::End,
        }
    }

    fn is_playing(&self, cue: usize) -> bool {
        self.player.status(cue, None).is_some_and(|s| s.state == VoiceState::Playing)
    }

    /// Go: fire the armed cue, or the next one.
    pub fn go(&mut self) -> Result<()> {
        // While a cue is on its way by itself, Go does nothing: what is coming comes,
        // and nothing is fired over it by accident.
        if self.go_blocked() || self.needs_variant() {
            return Ok(());
        }
        let cue = self.next();
        let before = (self.armed.take(), self.selected_variant.take());
        match cue {
            Some(cue) => self.by_hand(cue, before),
            None => Ok(()),
        }
    }

    /// Fire the cue carrying this trigger note, whatever the position (remote triggering).
    pub fn fire_note(&mut self, note: Note) -> Result<()> {
        let cue = Cues::new(&self.script).find(note);
        let before = (self.armed.take(), self.selected_variant.take());
        match cue {
            Some(cue) => self.by_hand(cue, before),
            None => Ok(()),
        }
    }

    /// Fire a cue for the operator, and note the step for Back with what was armed before.
    fn by_hand(&mut self, cue: usize, (armed, variant): (Option<usize>, Option<usize>)) -> Result<()> {
        let entry = self.history.len();
        let stopped = match self.fire_cue(cue, false)? {
            Fired::Nothing => return Ok(()),
            Fired::Stopped => Some(cue),
            Fired::Queued | Fired::Began => None,
        };
        self.steps.push(Step { entry, armed, variant, stopped });
        Ok(())
    }

    /// Note where a cue's audio stands before it is stopped, for Back.
    fn note_stop(&mut self, cue: usize) {
        if let Some(status) = self.sounding(cue) {
            self.stopped_at.insert(cue, Stopped { part: status.part, seconds: status.seconds, at: self.now, end: status.end });
        }
    }

    /// Fire a cue. `auto` marks cues not fired by the operator (auto-cues).
    ///
    /// Two cases do not fire: a cue whose audio is playing is stopped instead (a second
    /// press undoes an accidental one), and the outro of a running loop is queued for
    /// the loop's end. While it waits there, firing it again does nothing — a nervous
    /// second Go must not call the transition off; Back does that.
    pub fn fire(&mut self, cue: usize, auto: bool) -> Result<()> {
        match auto {
            true => self.fire_cue(cue, true).map(drop),
            false => self.by_hand(cue, (self.armed, self.selected_variant)),
        }
    }

    fn fire_cue(&mut self, cue: usize, auto: bool) -> Result<Fired> {
        let script = self.script.clone();
        let cues = Cues::new(&script);
        if cues.get(cue).is_none() {
            return Ok(Fired::Nothing);
        }
        if self.is_playing(cue) {
            self.note_stop(cue);
            // (One the operator stopped is a step of its own; one an auto-cue stopped
            // comes back when the cue that set the auto-cue off is taken back.)
            if auto {
                self.stops.push((self.history.len(), cue));
            }
            self.player.stop(cue, 0.0)?;
            self.forget_audio_of(&[cue]);
            return Ok(Fired::Stopped);
        }
        // (A loop whose outro is a variant takes whichever variant of that group is fired.)
        let running_loop = (0..cues.len()).find(|&l| l != cue && cues.get(l).and_then(|c| c.loop_outro()).is_some_and(|n| cues.refers_to(n, cue)) && self.is_playing(l));
        if let (Some(looped), Some(audio)) = (running_loop, self.audio(cue)) {
            if !self.pending_outros.contains(&(looped, cue)) {
                self.player.start(cue, &audio, Start::armed(self.then(cue)))?;
                self.player.queue_outro(looped, cue)?;
                self.pending_outros.push((looped, cue));
                // Its wait begins here, wherever the loop stands.
                if let Some(status) = self.player.status(looped, self.clock.as_deref()) {
                    self.waits_from.insert(cue, status.seconds);
                }
                return Ok(Fired::Queued);
            }
            return Ok(Fired::Nothing);
        }
        // Fired by hand before its chain got there: the operator has taken over, so the
        // handoff must not fire it a second time.
        self.chains.retain(|&(_, to)| to != cue);
        self.begin(cue, auto, false)?;
        Ok(Fired::Began)
    }

    /// Everything a cue does when it fires. `started` means its audio is already running
    /// (it came in through a handoff inside the audio engine).
    fn begin(&mut self, cue: usize, auto: bool, started: bool) -> Result<()> {
        // A cue that fires plays from its start, wherever its waveform was left.
        self.paused.remove(&cue);
        let script = self.script.clone();
        let cues = Cues::new(&script);
        let (Some(c), Some(block)) = (cues.get(cue), cues.block_index(cue)) else { return Ok(()) };

        let mic = script.mic_for_cue(block, &self.cast);
        if mic != Mic::Unchanged {
            // An auto-mic cue switches the new microphones on at once and the ones it
            // no longer needs off a little later: who comes on can be heard, who goes
            // off can finish speaking. A cue that comes in between settles it at once.
            self.mic_hold = None;
            let roles = |mic: &Mic| match self.cast.expand(mic) {
                Mic::Open(names) => names,
                _ => Vec::new(),
            };
            let staying = roles(&mic);
            let leaving: Vec<String> = match c.auto_mic() && self.mic_off_delay > 0.0 {
                true => roles(&self.history.mic(&cues, &self.cast)).into_iter().filter(|role| !staying.contains(role)).collect(),
                false => Vec::new(),
            };
            if leaving.is_empty() {
                self.effects.push(Effect::Mic(mic));
            } else {
                let mut open = match &mic {
                    Mic::Open(names) => names.clone(),
                    _ => Vec::new(),
                };
                open.extend(leaving.iter().cloned());
                self.effects.push(Effect::Mic(Mic::Open(open)));
                self.mic_hold = Some(Hold { cue, then: mic, leaving, started: self.now, due: self.now + self.mic_off_delay });
            }
        }

        // Timecode: a cue with `start_tc` takes it over (and ends the audio that drove it);
        // a cue that continues another's audio continues its timecode.
        // A loop that crossfades has none: two passes sound at once, so there is no one
        // place in the audio a timecode could stand for.
        let crossfaded = c.audio().is_some_and(|audio| audio.crossfade().is_some());
        let start_tc = self.start_tc(c.text("start_tc")).filter(|_| !crossfaded);
        // A handoff happens at the end of the source's stretch, so that is where the
        // count carries on — the source itself may already be gone.
        let hands_off_here = |from: usize| cues.get(from).and_then(|source| source.loop_outro().or(source.chain_end())).is_some_and(|note| cues.refers_to(note, cue));
        let continued = self
            .timecode
            .as_ref()
            .filter(|t| started && start_tc.is_none() && hands_off_here(t.cue))
            .map(|t| t.base + t.spans.iter().map(|(a, b)| b - a).sum::<f64>());
        if start_tc.is_some() {
            if let Some(previous) = self.timecode.take().filter(|t| t.cue != cue) {
                self.note_stop(previous.cue);
                self.stops.push((self.history.len(), previous.cue));
                self.ends.retain(|&(_, source)| source != previous.cue);
                self.player.stop(previous.cue, 0.0)?;
            }
        }

        let audio = c.audio();
        let then = self.then(cue);
        // Audio that cannot be loaded must not hold up the rest of the cue: the show goes
        // on, and the problem is reported.
        let mut audio = audio;
        if let (Some(loaded), false) = (&audio, started) {
            if let Err(e) = self.player.start(cue, loaded, Start::now(then)) {
                self.problems.push(format!("{}: {e}", cues.name(cue)));
                audio = None;
            }
        }
        if let (Some(_), Then::Chain(next)) = (&audio, then) {
            self.arm_chain(cue, next);
        }
        if let Some(audio) = &audio {
            let spans = self.player.spans(audio).unwrap_or_default();
            // Where the audio is in its cycle right now (0 for a fresh start).
            let into = self.player.status(cue, self.clock.as_deref()).filter(|_| started).map_or(0.0, |s| {
                spans[..s.part.min(spans.len())].iter().map(|(a, b)| b - a).sum::<f64>() + (s.seconds - s.start)
            });
            if then == Then::Loop {
                self.loop_epochs.insert(cue, self.now - into);
            }
            // Fired on its own, a cue further down a chain still counts from where its
            // timecode would stand had the chain run up to it.
            let base = start_tc.or(continued).or_else(|| self.derived_timecode(cue, 0));
            if let Some(base) = base.filter(|_| !crossfaded) {
                self.timecode = Some(TimecodeSource { cue, base, spans });
            }
        }

        if let Some(adjust) = c.adjust() {
            // An adjust aimed at a variant means its group: it acts on whichever variant
            // is there, and a volume is the group's share of each variant's own volume.
            let targets: Vec<usize> = cues.find(adjust.target).map(|named| cues.group(named).collect()).unwrap_or_default();
            let grouped = targets.len() > 1;
            for target in targets {
                if grouped && self.player.status(target, None).is_none() {
                    continue;
                }
                let fade = adjust.fadetime.unwrap_or(DEFAULT_ADJUST_FADE);
                if adjust.fadeout {
                    if self.sounding(target).is_some() {
                        self.note_stop(target);
                        self.stops.push((self.history.len(), target));
                    }
                    // (Faded out, it does not end by itself.)
                    self.ends.retain(|&(_, source)| source != target);
                    self.player.stop(target, fade)?;
                } else if let Some(volume) = adjust.volume {
                    let own = cues.get(target).and_then(|t| t.audio()).and_then(|a| a.parts.first().map(|p| p.volume)).unwrap_or(1.0);
                    self.player.fade(target, if grouped { own * volume } else { volume }, fade)?;
                }
            }
        }

        self.effects.extend(c.fire_effects());
        self.history.push(cue, auto);

        // Auto-cues that hang on this cue, or with a delay on its variant group. (A
        // variant is never fired by itself: the operator has to choose one.)
        for (target, when) in cues.autos_of(cue) {
            if cues.in_group(target) {
                continue;
            }
            match when {
                AutoWhen::Delay(seconds) => {
                    self.delays.retain(|d| d.target != target);
                    self.delays.push(Delay { target, source: cue, started: self.now, due: self.now + seconds.max(0.0) });
                }
                AutoWhen::At(_) | AutoWhen::End => {}
            }
        }
        self.watch(cue, None);
        self.report_displays();
        Ok(())
    }

    /// Watch the audio of `cue` for the position auto-cues that hang on it. Audio that
    /// comes back in at `resumed` has the auto-cues before that place behind it.
    fn watch(&mut self, cue: usize, resumed: Option<f64>) {
        let cues = Cues::new(&self.script);
        for (target, when) in cues.autos_of(cue) {
            if cues.in_group(target) {
                continue;
            }
            if when == AutoWhen::End {
                self.ends.retain(|&(t, _)| t != target);
                self.ends.push((target, cue));
                continue;
            }
            let AutoWhen::At(at) = when else { continue };
            self.watches.retain(|w| w.target != target);
            self.watches.push(Watch { target, source: cue, at, fired: resumed.is_some_and(|from| at <= from), last: None, from: None });
        }
    }

    /// Drop timers, watches and timecode that depend on these cues' audio.
    fn forget_audio_of(&mut self, cues: &[usize]) {
        self.delays.retain(|d| !cues.contains(&d.source));
        self.watches.retain(|w| !cues.contains(&w.source));
        self.ends.retain(|(_, source)| !cues.contains(source));
        if self.timecode.as_ref().is_some_and(|t| cues.contains(&t.cue)) {
            self.timecode = None;
        }
    }

    /// Notice what happened inside the audio engine and fire what is due. `now` is a
    /// steadily increasing time in seconds.
    pub fn tick(&mut self, now: f64) -> Result<()> {
        self.now = now;
        self.player.tick()?;
        let problems = self.player.take_problems();
        self.problems.extend(problems);

        // Chained successors that have come in.
        for (from, to) in self.chains.clone() {
            if self.player.is_sounding(to) {
                self.chains.retain(|&c| c != (from, to));
                self.begin(to, true, true)?;
            } else if !self.player.is_sounding(from) {
                // The source was stopped before it got there: the successor will not start.
                self.chains.retain(|&c| c != (from, to));
                self.player.stop(to, 0.0)?;
            }
        }
        // Queued outros that have come in. The operator asked for them, so they count
        // as manual cues.
        for (looped, outro) in self.pending_outros.clone() {
            if self.player.is_sounding(outro) {
                self.pending_outros.retain(|&p| p != (looped, outro));
                self.begin(outro, false, true)?;
            } else if !self.player.is_sounding(looped) {
                self.pending_outros.retain(|&p| p != (looped, outro));
                self.player.stop(outro, 0.0)?;
            }
        }
        // Delay auto-cues.
        let due: Vec<usize> = self.delays.iter().filter(|d| d.due <= now).map(|d| d.target).collect();
        self.delays.retain(|d| d.due > now);
        for target in due {
            self.fire(target, true)?;
        }
        // Waits that are over are forgotten.
        let (outros, chains) = (&self.pending_outros, &self.chains);
        self.waits_from.retain(|cue, _| outros.iter().chain(chains).any(|(_, waiting)| waiting == cue));
        // Microphones that were left on a little longer go off now.
        if self.mic_hold.as_ref().is_some_and(|hold| hold.due <= now) {
            if let Some(hold) = self.mic_hold.take() {
                self.effects.push(Effect::Mic(hold.then));
            }
        }
        // Audio-position auto-cues: fire when the source is at or past the position, once
        // per pass of a loop. Not an edge but a level: an auto-cue at the very start, or
        // one the audio was already past when first looked at, fires all the same.
        let mut reached = Vec::new();
        for watch in &mut self.watches {
            let Some(status) = self.player.status(watch.source, self.clock.as_deref()).filter(|s| s.state == VoiceState::Playing) else {
                continue;
            };
            // The audio jumped back: the loop came round (or the operator moved it).
            if watch.last.is_some_and(|last| status.seconds < last - WRAP) {
                watch.fired = false;
                watch.from = None;
            }
            // The wait for this pass begins where the audio is first seen.
            if watch.from.is_none() {
                watch.from = Some(status.seconds);
            }
            if !watch.fired && status.seconds >= watch.at {
                watch.fired = true;
                reached.push(watch.target);
            }
            watch.last = Some(status.seconds);
        }
        // A watch lasts as long as its audio is there, paused audio included.
        let (player, paused) = (&self.player, &self.paused);
        self.watches.retain(|w| player.status(w.source, None).is_some_and(|s| s.state != VoiceState::Done) || paused.contains_key(&w.source));
        // Audio that has ended by itself (or never began: a source without audio).
        let (player, paused) = (&self.player, &self.paused);
        let ended: Vec<(usize, usize)> = self.ends.iter().filter(|(_, source)| !player.is_sounding(*source) && !paused.contains_key(source)).copied().collect();
        self.ends.retain(|end| !ended.contains(end));
        reached.extend(ended.into_iter().map(|(target, _)| target));
        for target in reached {
            self.fire(target, true)?;
        }
        if self.timecode.as_ref().is_some_and(|t| !self.player.is_sounding(t.cue)) {
            self.timecode = None;
        }
        Ok(())
    }

    /// Timecode position in seconds, while a cue with `start_tc` (or one continuing it)
    /// is playing. A loop's timecode loops with it.
    pub fn timecode_seconds(&self) -> Option<f64> {
        let source = self.timecode.as_ref()?;
        let status = self.player.status(source.cue, self.clock.as_deref())?;
        let earlier: f64 = source.spans[..status.part.min(source.spans.len())].iter().map(|(a, b)| b - a).sum();
        Some(source.base + earlier + (status.seconds - status.start).max(0.0))
    }

    /// Where a loop would be now had it never stopped: `(part, seconds)`.
    fn loop_position(&mut self, cue: usize, audio: &CueAudio) -> Result<(usize, f64)> {
        let spans = self.player.spans(audio)?;
        let cycle: f64 = spans.iter().map(|(a, b)| b - a).sum();
        let Some(epoch) = self.loop_epochs.get(&cue).filter(|_| cycle > 0.0) else {
            return Ok((0, spans.first().map_or(0.0, |s| s.0)));
        };
        let mut into = (self.now - epoch).rem_euclid(cycle);
        for (part, (start, transition)) in spans.iter().enumerate() {
            if into < transition - start {
                return Ok((part, start + into));
            }
            into -= transition - start;
        }
        Ok((0, spans[0].0))
    }

    /// Bring a stopped cue's audio back at `volume` where it would be now had it never
    /// stopped: loops in beat, other audio on from where it was stopped — unless it would
    /// have reached its end by now.
    fn resume(&mut self, cue: usize, volume: f64) -> Result<()> {
        let Some(mut audio) = self.audio(cue) else { return Ok(()) };
        let then = self.then(cue);
        let resume = if then == Then::Loop {
            self.loop_position(cue, &audio)?
        } else {
            match self.stopped_at.get(&cue) {
                Some(stopped) if stopped.seconds + (self.now - stopped.at) < stopped.end => (stopped.part, stopped.seconds + (self.now - stopped.at)),
                _ => return Ok(()),
            }
        };
        for part in &mut audio.parts {
            part.volume = volume;
        }
        self.player.start(cue, &audio, Start { armed: false, then, resume: Some(resume) })?;
        if resume.0 == 0 {
            self.watch(cue, Some(resume.1));
        }
        let script = self.script.clone();
        let tc = self.start_tc(Cues::new(&script).get(cue).and_then(|c| c.text("start_tc")));
        let base = tc.or_else(|| self.derived_timecode(cue, 0));
        if let Some(base) = base.filter(|_| audio.crossfade().is_none()) {
            let spans = self.player.spans(&audio)?;
            self.timecode = Some(TimecodeSource { cue, base, spans });
        }
        Ok(())
    }

    /// The timecode (seconds) a cue without `start_tc` begins at because the cue that
    /// leads into it (chains on with it, or loops until it) has one: that cue's
    /// timecode plus the stretch it plays before it hands over.
    fn derived_timecode(&mut self, cue: usize, depth: usize) -> Option<f64> {
        if depth > 8 {
            return None;
        }
        let script = self.script.clone();
        let cues = Cues::new(&script);
        let note = cues.get(cue)?.note()?;
        let _ = note;
        let before = (0..cues.len()).find(|&p| p != cue && cues.get(p).is_some_and(|c| c.chain_end().or(c.loop_outro()).is_some_and(|n| cues.refers_to(n, cue))))?;
        // Nothing runs on from a crossfading loop: it has no timecode itself.
        if cues.get(before)?.audio().is_some_and(|audio| audio.crossfade().is_some()) {
            return None;
        }
        let base = match self.start_tc(cues.get(before)?.text("start_tc")) {
            Some(seconds) => seconds,
            None => self.derived_timecode(before, depth + 1)?,
        };
        let audio = self.audio(before)?;
        let length: f64 = self.player.spans(&audio).ok()?.iter().map(|(start, transition)| transition - start).sum();
        Some(base + length)
    }

    /// Back: everything as if the last Go had never been pressed. In turn it takes back
    /// a queued outro, then what is armed (or the variant chosen), then the operator's
    /// last step: a second press that stopped audio brings it back; a cue that fired is
    /// undone with every auto-cue it set off — its audio stops, what it stopped or turned
    /// down comes back (loops in beat, other audio where it would be now), microphones and
    /// devices are set as before, and what was armed before that Go is armed again.
    pub fn back(&mut self) -> Result<()> {
        if !self.pending_outros.is_empty() {
            let pending = std::mem::take(&mut self.pending_outros);
            for &(looped, outro) in &pending {
                self.player.cancel_outro(looped)?;
                self.player.stop(outro, 0.0)?;
            }
            // One queued outro stays armed as the next Go; several cannot be.
            self.armed = if pending.len() == 1 { Some(pending[0].1) } else { None };
            // The Go that queued it is taken back with it.
            if self.steps.last().is_some_and(|step| step.entry == self.history.len() && step.stopped.is_none()) {
                self.steps.pop();
            }
            return Ok(());
        }
        if self.armed.is_some() || self.selected_variant.is_some() {
            self.armed = None;
            self.selected_variant = None;
            return Ok(());
        }
        let script = self.script.clone();
        let cues = Cues::new(&script);

        // A second press stopped audio: it comes back.
        if let Some(cue) = self.steps.last().and_then(|step| step.stopped) {
            let step = self.steps.pop().expect("there is a last step");
            let volume = match self.history.fired(cue) {
                true => self.history.audio_state(&cues, cue).1,
                false => self.audio(cue).and_then(|audio| audio.parts.first().map(|part| part.volume)).unwrap_or(1.0),
            };
            self.resume(cue, volume)?;
            (self.armed, self.selected_variant) = (step.armed, step.variant);
            return Ok(());
        }

        let Some(undone) = self.history.back(&cues) else { return Ok(()) };
        let landed = self.history.len();
        // What was armed before the Go is armed again.
        let mut before = None;
        while self.steps.last().is_some_and(|step| step.entry >= landed && step.stopped.is_none()) {
            before = self.steps.pop();
        }
        if let Some(step) = before.filter(|step| step.entry == landed) {
            (self.armed, self.selected_variant) = (step.armed, step.variant);
        }
        let popped = &undone.popped;
        self.forget_audio_of(popped);
        for (from, to) in std::mem::take(&mut self.chains) {
            if popped.contains(&from) {
                self.player.stop(to, 0.0)?;
            } else {
                self.chains.push((from, to));
            }
        }

        // Loops that an undone cue took over from come back in beat.
        // (The outro that took a loop over may have been any variant of its group.)
        let took_over = |looped: usize| -> Vec<usize> {
            cues.get(looped).and_then(|c| c.loop_outro()).and_then(|n| cues.find(n)).map(|named| cues.group(named).filter(|member| popped.contains(member)).collect()).unwrap_or_default()
        };
        let mut returning: Vec<usize> = self
            .history
            .cues()
            .filter(|&cue| self.then(cue) == Then::Loop && !took_over(cue).is_empty())
            .filter(|&cue| !self.player.is_sounding(cue) && self.history.audio_state(&cues, cue).0)
            .collect();
        returning.dedup();
        let handed_over: Vec<usize> = returning.iter().flat_map(|&l| took_over(l)).collect();

        for &cue in popped {
            let fade = if handed_over.contains(&cue) { HANDOVER_FADE } else { BACK_FADE };
            self.player.stop(cue, fade)?;
        }
        for cue in returning {
            let volume = self.history.audio_state(&cues, cue).1;
            self.resume(cue, volume)?;
        }

        // Audio the undone cues stopped comes back: faded out by an adjust, its timecode
        // taken over, stopped by an auto-cue.
        let mut stopped: Vec<usize> = self.stops.iter().rev().filter(|(entry, _)| *entry >= landed).map(|(_, cue)| *cue).collect();
        self.stops.retain(|(entry, _)| *entry < landed);
        stopped.dedup();
        for cue in stopped {
            if popped.contains(&cue) || self.player.is_sounding(cue) {
                continue;
            }
            let volume = match self.history.fired(cue) {
                true => self.history.audio_state(&cues, cue),
                false => (true, self.audio(cue).and_then(|audio| audio.parts.first().map(|part| part.volume)).unwrap_or(1.0)),
            };
            if volume.0 && volume.1 > 0.0 {
                self.resume(cue, volume.1)?;
            }
        }

        // Audio the undone cues turned up or down goes back to what the remaining history
        // implies. `popped` is newest first, so the latest adjust per target wins.
        let mut restored = Vec::new();
        for &cue in popped {
            let Some(named) = cues.get(cue).and_then(|c| c.adjust()).and_then(|a| cues.find(a.target)) else { continue };
            // (An adjust aimed at a variant acted on its whole group.)
            for target in cues.group(named) {
                if restored.contains(&target) {
                    continue;
                }
                restored.push(target);
                let (playing, volume) = self.history.audio_state(&cues, target);
                if playing && volume > 0.0 && self.player.is_sounding(target) {
                    self.player.fade(target, volume, BACK_FADE)?;
                }
            }
        }

        // Microphones as the remaining cues left them. If none of them set any — or
        // nothing is left — the microphones the undone cues opened go off.
        self.mic_hold = None;
        let touched = popped.iter().any(|&cue| cues.block_index(cue).is_some_and(|block| script.mic_for_cue(block, &self.cast) != Mic::Unchanged));
        let mic = match self.history.mic(&cues, &self.cast) {
            Mic::Unchanged if touched || self.history.is_empty() => Mic::MuteAll,
            mic => mic,
        };
        if mic != Mic::Unchanged {
            self.effects.push(Effect::Mic(mic));
        }
        self.effects.extend(resend_effects(&undone.resend));
        self.report_displays();
        Ok(())
    }

    /// Emergency "Music Stop": fade all audio out and stop the timecode.
    pub fn stop_all(&mut self) -> Result<()> {
        self.pending_outros.clear();
        self.chains.clear();
        self.delays.clear();
        self.watches.clear();
        self.ends.clear();
        self.timecode = None;
        self.player.stop_all(BACK_FADE)
    }

    /// Emergency "Mics Off".
    pub fn mics_off(&mut self) {
        self.mic_hold = None;
        self.effects.push(Effect::Mic(Mic::MuteAll));
    }

    /// Report display content that changed since it was last reported.
    fn report_displays(&mut self) {
        let states = self.history.device_states(&Cues::new(&self.script));
        let mut content: HashMap<String, String> = HashMap::new();
        for ((kind, device), state) in &states {
            if let (DeviceKind::Display, DeviceState::Display(markdown)) = (kind, state) {
                content.insert(device.clone(), markdown.clone());
            }
        }
        // A display no remaining cue addresses goes back to empty.
        for device in self.shown.keys() {
            content.entry(device.clone()).or_default();
        }
        let mut changed: Vec<(&String, &String)> = content.iter().filter(|(d, m)| self.shown.get(*d) != Some(m)).collect();
        changed.sort();
        for (device, markdown) in changed {
            self.effects.push(Effect::Display { device: device.clone(), markdown: markdown.clone() });
        }
        self.shown = content;
    }

    /// Blocks that are cues, for callers that map between cue and block numbers.
    pub fn cue_blocks(&self) -> Vec<usize> {
        (0..self.script.blocks.len()).filter(|&i| matches!(self.script.blocks[i], Block::Cue(_))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::Clip;
    use crate::mixer::Mixer;
    use crate::player::{ClipCache, Routing};
    use std::path::PathBuf;

    /// 1000 Hz: one frame is one millisecond.
    const SR: u32 = 1000;

    struct Rig {
        mixer: Mixer,
        show: Show,
        frames: usize,
        /// Everything rendered on output 0 so far.
        out: Vec<f32>,
    }

    /// A show from cue bodies (cue `i` gets trigger note `1/i`) with constant-valued clips.
    fn rig(cues: &[&str], clips: &[(&str, f32, usize)]) -> Rig {
        let mut text = String::from("```yaml\nconfig:\n    roles:\n        Anna: {}\n        Ben: {}\n```\n");
        for (i, body) in cues.iter().enumerate() {
            text.push_str(&format!("\n```yaml\ntrigger_note: {{ch: 1, note: {i}}}\n{body}\n```\n"));
        }
        let (mixer, handle) = Mixer::new();
        let mut cache = ClipCache::new(PathBuf::from("/nonexistent"), SR);
        for &(name, value, frames) in clips {
            cache.insert(name, Clip::from_planar(SR, vec![vec![value; frames]]));
        }
        let player = Player::new(handle, cache, Routing::positional(&["L".to_string()]));
        Rig { mixer, show: Show::new(Script::parse(&text), player, None, false), frames: 0, out: Vec::new() }
    }

    impl Rig {
        /// Let `ms` milliseconds pass: render audio and tick the show every 8 ms.
        fn run(&mut self, ms: usize) {
            let mut buf = [0.0f32; 8];
            for _ in 0..ms / 8 {
                self.mixer.render(&mut buf, 1);
                self.out.extend_from_slice(&buf);
                self.frames += 8;
                self.show.tick(self.frames as f64 / SR as f64).unwrap();
            }
        }

        fn fired(&self) -> Vec<usize> {
            self.show.history().cues().collect()
        }

        /// Trigger notes sent since the last call (one per fired cue).
        fn notes(&mut self) -> Vec<u64> {
            self.show.take_effects().iter().filter_map(|e| match e {
                Effect::TriggerNote(n) => Some(n.note),
                _ => None,
            }).collect()
        }

        fn level(&self) -> f32 {
            *self.out.last().unwrap()
        }
    }

    const SLF: [&str; 3] = [
        "music:\n    file: start.wav\n    volume: 1\nchain_end: {ch: 1, note: 1}",
        "music:\n    file: loop.wav\n    volume: 1\nloop_outro: {ch: 1, note: 2}",
        "music:\n    file: finish.wav\n    volume: 1",
    ];
    const SLF_CLIPS: [(&str, f32, usize); 3] = [("start.wav", 1.0, 40), ("loop.wav", 2.0, 48), ("finish.wav", 4.0, 80)];

    #[test]
    fn start_chains_into_the_loop_and_go_queues_the_finish() {
        let mut rig = rig(&SLF, &SLF_CLIPS);
        rig.show.go().unwrap();
        assert_eq!(rig.notes(), [0]);
        rig.run(64);
        assert_eq!(rig.fired(), [0, 1], "the loop fired by itself when the start ended");
        assert_eq!(rig.notes(), [1], "and sent its trigger note then");
        assert_eq!(rig.show.current(), Some(0), "an automatic cue does not move the operator");
        assert_eq!(rig.show.next(), Some(2));

        // Go on the finish: queued, not fired, until the loop comes round.
        rig.show.go().unwrap();
        assert_eq!(rig.show.pending_outros(), [(1, 2)]);
        assert_eq!(rig.fired(), [0, 1]);
        rig.run(8);
        assert_eq!(rig.level(), 2.0, "the loop is still playing");
        rig.run(56);
        // Loop passes end at 40 + n·48: 88, 136 → the finish comes in at 88.
        assert_eq!(rig.out[87], 2.0);
        assert_eq!(rig.out[88], 4.0);
        assert_eq!(rig.fired(), [0, 1, 2]);
        assert_eq!(rig.notes(), [2]);
        assert!(rig.show.pending_outros().is_empty());
        assert_eq!(rig.show.current(), Some(2), "the queued finish counts as the operator's cue");
    }

    #[test]
    fn the_waveform_transport_plays_pauses_and_seeks() {
        let mut rig = rig(&["music:\n    file: ramp.wav\n    volume: 1"], &[]);
        let ramp: Vec<f32> = (0..400).map(|n| n as f32).collect();
        rig.show.player().cache().insert("ramp.wav", Clip::from_planar(SR, vec![ramp]));

        rig.show.play_pause(0).unwrap();
        rig.run(48);
        assert!(rig.fired().is_empty(), "playing from the waveform is not firing the cue");
        assert!(rig.notes().is_empty());
        rig.show.play_pause(0).unwrap();
        rig.run(64);
        assert_eq!(rig.level(), 0.0);
        let paused = rig.show.paused();
        assert_eq!(paused.len(), 1);
        assert!((paused[0].1 - 0.048).abs() < 0.02, "{paused:?}");

        // Placed by hand while paused, then played on from there.
        rig.show.seek(0, 0.2).unwrap();
        assert_eq!(rig.show.paused(), [(0, 0.2)]);
        rig.show.play_pause(0).unwrap();
        rig.run(48);
        assert!((230.0..260.0).contains(&rig.level()), "{}", rig.level());
        assert!(rig.show.paused().is_empty());

        // Moved while playing: carries on from the new place.
        rig.show.seek(0, 0.3).unwrap();
        rig.run(48);
        assert!((330.0..360.0).contains(&rig.level()), "{}", rig.level());

        rig.show.stop_cue(0, 0.02).unwrap();
        rig.run(64);
        assert_eq!(rig.level(), 0.0);
        assert!(rig.show.paused().is_empty());

        // Stopped with a fade (the live view's ×): quieter and quieter, then gone.
        rig.show.seek(0, 0.0).unwrap();
        rig.show.play_pause(0).unwrap();
        rig.run(48);
        let before = rig.out.len();
        rig.show.stop_cue(0, 0.1).unwrap();
        rig.run(160);
        // The ramp in the file rises by 1 a frame; divided by it, what is left is the fade.
        let fade: Vec<f32> = (8..96).step_by(8).map(|n| rig.out[before + n] / (48 + n) as f32).collect();
        assert!(fade[0] < 1.0 && fade.windows(2).all(|w| w[1] < w[0]), "{fade:?}");
        assert!(rig.out[before + 104..].iter().all(|s| *s == 0.0));
        assert!(rig.show.audio_status().is_empty());
    }

    #[test]
    fn a_loops_tail_rings_out_over_its_outro() {
        // The loop cycles 0–32 ms; 32–48 ms is its tail, heard only when the outro comes.
        let cues = [
            "music:\n    file: loop.wav\n    volume: 1\n    fading_point: 0.032\nloop_outro: {ch: 1, note: 1}",
            "music:\n    file: finish.wav\n    volume: 1",
        ];
        let mut rig = rig(&cues, &[("loop.wav", 2.0, 48), ("finish.wav", 4.0, 80)]);
        rig.show.go().unwrap();
        rig.run(40);
        rig.show.go().unwrap();
        rig.run(60);
        // At every loop point the pass that ends rings out for 16 ms over the next: over the
        // loop's second pass from 32, and from 64 — where the loop hands over — over the outro.
        let changes: Vec<(usize, f32)> = rig.out.iter().enumerate().filter(|(i, v)| *i == 0 || rig.out[i - 1] != **v).map(|(i, v)| (i, *v)).collect();
        assert_eq!(changes, [(0, 2.0), (32, 4.0), (48, 2.0), (64, 6.0), (80, 4.0)], "loop; loop and its tail; loop; tail and outro; outro");
    }

    #[test]
    fn audio_that_rings_out_is_reported_past_its_loop_point() {
        let cues = [
            "music:\n    file: loop.wav\n    volume: 1\n    fading_point: 0.032\nloop_outro: {ch: 1, note: 1}",
            "music:\n    file: finish.wav\n    volume: 1",
        ];
        let mut rig = rig(&cues, &[("loop.wav", 2.0, 48), ("finish.wav", 4.0, 80)]);
        rig.show.go().unwrap();
        rig.run(40);
        rig.show.go().unwrap();
        rig.run(32);
        // 72 ms: the loop handed over at 64 and is 8 ms into its tail.
        let of = |cue: usize| rig.show.audio_status().into_iter().find(|(c, _)| *c == cue).map(|(_, s)| (s.state, s.seconds));
        assert_eq!(of(0), Some((VoiceState::Tail, 0.040)));
        assert_eq!(of(1), Some((VoiceState::Playing, 0.008)));

        // In a loop of several parts, a part that rings out is reported beside the one playing.
        let parts = ["music:\n    file: a.wav\n    volume: 1\n    fading_point: 0.024\nmusic_seq:\n    - file: b.wav\n      volume: 1"];
        let mut two = super::tests::rig(&parts, &[("a.wav", 1.0, 40), ("b.wav", 2.0, 40)]);
        two.show.go().unwrap();
        two.run(32);
        let all: Vec<(usize, VoiceState, f64)> = two.show.audio_status().into_iter().map(|(_, s)| (s.part, s.state, s.seconds)).collect();
        assert_eq!(all, [(1, VoiceState::Playing, 0.008), (0, VoiceState::Tail, 0.032)]);
        assert_eq!(two.level(), 3.0, "the first part's tail under the second part");
    }

    #[test]
    fn a_second_go_leaves_a_waiting_outro_alone() {
        let mut rig = rig(&SLF, &SLF_CLIPS);
        rig.show.go().unwrap();
        rig.run(64);
        rig.show.go().unwrap();
        rig.run(8);
        // Pressed again while the finish waits for the loop's end: nothing changes.
        rig.show.go().unwrap();
        rig.show.go().unwrap();
        assert_eq!(rig.show.pending_outros(), [(1, 2)]);
        assert_eq!(rig.fired(), [0, 1]);
        rig.run(56);
        assert_eq!((rig.out[87], rig.out[88]), (2.0, 4.0), "the finish comes in at the loop's end as planned");
        assert_eq!(rig.fired(), [0, 1, 2]);
    }

    #[test]
    fn back_takes_a_queued_outro_back_first() {
        let mut rig = rig(&SLF, &SLF_CLIPS);
        rig.show.go().unwrap();
        rig.run(64);
        rig.show.go().unwrap();
        rig.show.back().unwrap();
        assert!(rig.show.pending_outros().is_empty());
        assert_eq!(rig.show.next(), Some(2), "the finish stays armed as the next Go");
        rig.run(160);
        assert_eq!(rig.level(), 2.0, "the loop keeps going");
        assert_eq!(rig.fired(), [0, 1]);

        // A second Back clears the arming; a third undoes the Go on the start.
        rig.show.back().unwrap();
        assert_eq!(rig.fired(), [0, 1]);
        rig.show.back().unwrap();
        assert!(rig.fired().is_empty());
        rig.run(640);
        assert_eq!(rig.level(), 0.0, "start and the loop it chained into are faded out");
    }

    #[test]
    fn back_after_the_finish_brings_the_loop_back_in_beat() {
        // A loop whose samples count up, so the resume position can be read off the output.
        let mut rig = rig(
            &["music:\n    file: loop.wav\n    volume: 1\nloop_outro: {ch: 1, note: 1}", "music: finish.wav"],
            &[("finish.wav", 0.0, 4000)],
        );
        let ramp: Vec<f32> = (0..400).map(|n| n as f32).collect();
        rig.show.player().cache().insert("loop.wav", Clip::from_planar(SR, vec![ramp]));

        rig.show.go().unwrap(); // loop
        rig.run(240);
        rig.show.go().unwrap(); // finish queued …
        rig.run(240); // … comes in at 400
        assert_eq!(rig.fired(), [0, 1]);
        rig.run(240);

        rig.show.back().unwrap();
        assert_eq!(rig.fired(), [0]);
        rig.run(80);
        // 800 ms after the loop started it would be 0 ms into its third pass, so 80 ms later
        // it is at 80 — exactly where the resumed loop is (the fade-in ramp is long over).
        assert_eq!(rig.level(), ((rig.frames - 1) % 400) as f32, "resumed in beat");
        assert_eq!(rig.show.next(), Some(1));
    }

    #[test]
    fn firing_a_chained_cue_by_hand_does_not_fire_it_twice() {
        let mut rig = rig(&SLF, &SLF_CLIPS);
        rig.show.go().unwrap();
        rig.run(16);
        // The loop is on its way by itself: Go does nothing in the meantime.
        assert!(rig.show.go_blocked());
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [0]);
        // Clicked by hand, 24 ms before the start would have chained into it.
        rig.show.fire(1, false).unwrap();
        rig.run(160);
        assert_eq!(rig.fired(), [0, 1]);
        assert_eq!(rig.notes(), [0, 1]);
        assert_eq!(rig.level(), 2.0, "only the loop is left");
        assert_eq!(rig.show.current(), Some(1));
    }

    #[test]
    fn a_second_press_stops_a_playing_cue() {
        let mut rig = rig(&["music:\n    file: a.wav\n    volume: 1\n    loop: true"], &[("a.wav", 1.0, 100)]);
        rig.show.fire(0, false).unwrap();
        rig.run(16);
        assert_eq!(rig.level(), 1.0);
        rig.show.fire(0, false).unwrap();
        rig.run(16);
        assert_eq!(rig.level(), 0.0);
        assert_eq!(rig.fired(), [0], "stopping is not a second firing");
    }

    #[test]
    fn delay_and_position_auto_cues() {
        let mut rig = rig(
            &[
                "music: long.wav",
                "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 0.1}",
                "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0.2}",
                "light: manual",
            ],
            &[("long.wav", 1.0, 1000)],
        );
        rig.show.go().unwrap();
        rig.run(96);
        assert_eq!(rig.fired(), [0]);
        let progress = rig.show.delay_progress();
        assert_eq!(progress[0].target, 1);
        assert!((progress[0].fraction - 0.96).abs() < 1e-9);
        rig.run(8);
        assert_eq!(rig.fired(), [0, 1], "100 ms after the source fired");
        rig.run(96);
        assert_eq!(rig.fired(), [0, 1, 2], "when the source's audio reached 0.2 s");
        // Both were automatic: the operator is still on cue 0 and Go takes the manual cue.
        assert_eq!(rig.show.current(), Some(0));
        assert_eq!(rig.show.next(), Some(3));

        // Back undoes the Go together with what it set off.
        rig.show.back().unwrap();
        assert!(rig.fired().is_empty());
    }

    /// The show is looked at far more often than the audio device asks for sound. A cue
    /// that has just been started must not be taken for silent in between.
    #[test]
    fn auto_cues_survive_a_look_before_the_first_sound() {
        let mut rig = rig(
            &["music: long.wav", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0.2}", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0}"],
            &[("long.wav", 1.0, 1000)],
        );
        rig.show.go().unwrap();
        // Several looks before the mixer has rendered anything.
        for _ in 0..5 {
            rig.show.tick(0.0).unwrap();
        }
        assert_eq!(rig.fired(), [0, 2], "the auto-cue at the very start fires at once");
        rig.run(240);
        assert_eq!(rig.fired(), [0, 2, 1]);
    }

    #[test]
    fn position_auto_cues_fire_on_every_pass_and_after_a_pause() {
        let mut rig = rig(&["music: {file: long.wav, loop: true, end: 0.5}", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0.4}"], &[("long.wav", 1.0, 1000)]);
        rig.show.go().unwrap();
        rig.run(200);
        // Paused and played on from the waveform: the auto-cue is still to come.
        rig.show.play_pause(0).unwrap();
        rig.run(80);
        rig.show.play_pause(0).unwrap();
        rig.run(160);
        assert_eq!(rig.fired(), [0]);
        rig.run(160);
        assert_eq!(rig.fired(), [0, 1]);
        rig.run(504);
        assert_eq!(rig.fired(), [0, 1, 1], "again on the loop's next pass");
    }

    /// An auto-mic cue opens the new microphones at once and closes the others later.
    #[test]
    fn auto_mic_switches_off_with_a_delay() {
        let text = "```yaml\nconfig:\n    roles:\n        Anna: {}\n        Ben: {}\n        Clara: {}\n```\n\n\
                    ```yaml\nauto_mic: true\n```\n\n**Anna**\nA.\n\n**Ben**\nB.\n\n\
                    ```yaml\nauto_mic: true\n```\n\n**Ben**\nB.\n\n**Clara**\nC.\n\n\
                    ```yaml\nmic: Anna\n```\n\n\
                    ```yaml\nauto_mic: true\n```\n\n**Clara**\nC.\n\n\
                    ```yaml\nauto_mic: true\n```\n";
        let (_mixer, handle) = Mixer::new();
        let player = Player::new(handle, ClipCache::new(PathBuf::from("/nonexistent"), SR), Routing::positional(&["L".to_string()]));
        let mut show = Show::new(Script::parse(text), player, None, false);
        show.set_mic_off_delay(2.0);
        let open = |names: &[&str]| Effect::Mic(Mic::Open(names.iter().map(|n| n.to_string()).collect()));
        let mics = |show: &mut Show| show.take_effects().into_iter().filter(|e| matches!(e, Effect::Mic(_))).collect::<Vec<_>>();

        show.tick(0.0).unwrap();
        show.go().unwrap();
        assert_eq!(mics(&mut show), [open(&["Anna", "Ben"])], "nobody was on before: nothing to wait for");
        assert_eq!(show.mic_hold(), None);

        show.tick(10.0).unwrap();
        show.go().unwrap();
        assert_eq!(mics(&mut show), [open(&["Ben", "Clara", "Anna"])], "Clara is on, Anna still is");
        show.tick(11.0).unwrap();
        assert_eq!(show.mic_hold(), Some(MicHold { cue: 1, leaving: vec!["Anna".into()], fraction: 0.5 }));
        assert!(mics(&mut show).is_empty());
        show.tick(12.0).unwrap();
        assert_eq!(mics(&mut show), [open(&["Ben", "Clara"])], "two seconds later Anna goes off");
        assert_eq!(show.mic_hold(), None);

        // Back while waiting settles it at once, and a cue that sets its microphones
        // itself does not wait at all.
        show.back().unwrap();
        show.take_effects();
        show.go().unwrap();
        assert!(show.mic_hold().is_some());
        show.back().unwrap();
        assert_eq!(show.mic_hold(), None);
        assert_eq!(mics(&mut show).last(), Some(&open(&["Anna", "Ben"])));
        show.go().unwrap();
        show.go().unwrap();
        assert_eq!(mics(&mut show).last(), Some(&open(&["Anna"])));
        assert_eq!(show.mic_hold(), None);

        // The last auto-mic cue switches everything off: the microphones that were on
        // stay on for the wait, then all go off.
        show.go().unwrap();
        show.tick(20.0).unwrap();
        show.take_effects();
        show.go().unwrap();
        assert_eq!(mics(&mut show), [open(&["Clara"])]);
        show.tick(22.0).unwrap();
        assert_eq!(mics(&mut show), [Effect::Mic(Mic::MuteAll)]);
    }

    #[test]
    fn back_cancels_pending_auto_cues() {
        let mut rig = rig(&["music: long.wav", "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 0.1}"], &[("long.wav", 1.0, 1000)]);
        rig.show.go().unwrap();
        rig.run(48);
        rig.show.back().unwrap();
        rig.run(200);
        assert!(rig.fired().is_empty(), "the delayed cue never fires");
        assert!(rig.show.delay_progress().is_empty());
    }

    #[test]
    fn adjust_ducks_and_back_restores() {
        let mut rig = rig(
            &[
                "music:\n    file: bed.wav\n    volume: 1\n    loop: true",
                "music:\n    file: talk.wav\n    volume: 0\n    adjust: {trigger_note: {ch: 1, note: 0}, volume: 0.25, fadetime: 0.016}",
                "music:\n    file: talk.wav\n    volume: 0\n    adjust: {trigger_note: {ch: 1, note: 0}, fadeout: true, fadetime: 0.016}",
            ],
            &[("bed.wav", 1.0, 100), ("talk.wav", 0.0, 4000)],
        );
        rig.show.go().unwrap();
        rig.run(32);
        assert_eq!(rig.level(), 1.0);
        rig.show.go().unwrap();
        rig.run(48);
        assert_eq!(rig.level(), 0.25, "ducked");
        rig.show.go().unwrap();
        rig.run(48);
        assert_eq!(rig.level(), 0.0, "faded out and stopped");

        rig.show.back().unwrap();
        rig.run(640);
        assert_eq!(rig.level(), 0.25, "the bed is playing again at the ducked level");
        rig.show.back().unwrap();
        rig.run(640);
        assert_eq!(rig.level(), 1.0, "and back at full level");
    }

    #[test]
    fn effects_mics_devices_and_displays() {
        let mut rig = rig(
            &[
                "mic: Anna\ncue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 1}\ncue_display:\n    - {device: Foyer, markdown: One}",
                "mic: [Anna, Ben]\ncue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 2}\ncue_display:\n    - {device: Foyer, markdown: Two, announce: Standby}",
            ],
            &[],
        );
        let open = |names: &[&str]| Effect::Mic(Mic::Open(names.iter().map(|n| n.to_string()).collect()));
        let program = |p: u8| Effect::Midi { device: "Licht".into(), bytes: vec![0xC0, p], then_off: None };
        let display = |m: &str| Effect::Display { device: "Foyer".into(), markdown: m.into() };

        rig.show.go().unwrap();
        let effects = rig.show.take_effects();
        assert_eq!(effects[0], open(&["Anna"]), "microphones first");
        assert!(effects.contains(&program(1)) && effects.contains(&display("One")));

        rig.show.go().unwrap();
        let effects = rig.show.take_effects();
        assert!(effects.contains(&Effect::Announce { device: "Foyer".into(), text: "Standby".into() }));
        assert!(effects.contains(&display("Two")));
        assert_eq!(rig.show.mic(), Mic::Open(vec!["Anna".into(), "Ben".into()]));

        // Back: previous microphones, the device's previous message, the previous display
        // content — and no announcement.
        rig.show.back().unwrap();
        assert_eq!(rig.show.take_effects(), [open(&["Anna"]), program(1), display("One")]);

        // Back to before the first cue: everything muted, display empty, nothing to re-send.
        rig.show.back().unwrap();
        assert_eq!(rig.show.take_effects(), [Effect::Mic(Mic::MuteAll), display("")]);

        rig.show.mics_off();
        assert_eq!(rig.show.take_effects(), [Effect::Mic(Mic::MuteAll)]);
    }

    #[test]
    fn start_tc_counts_frames_at_the_shows_rate() {
        let mut first = rig(&["music: a.wav\nstart_tc: '00:00:10:15'"], &[("a.wav", 1.0, 400)]);
        first.show.set_frame_rate(FrameRate::Fps30);
        first.show.go().unwrap();
        assert_eq!(first.show.timecode_seconds(), Some(10.5), "15 frames at 30 fps");
        let mut other = rig(&["music: a.wav\nstart_tc: '00:00:10:27'"], &[("a.wav", 1.0, 400)]);
        other.show.go().unwrap();
        assert_eq!(other.show.timecode_seconds(), None, "no 27th frame at 25 fps: no timecode");
    }

    #[test]
    fn timecode_follows_the_audio_through_a_chain() {
        let mut rig = rig(
            &[
                "music: start.wav\nstart_tc: '01:00:00:00'\nchain_end: {ch: 1, note: 1}",
                "music:\n    file: loop.wav\n    loop: true",
            ],
            &[("start.wav", 1.0, 400), ("loop.wav", 2.0, 200)],
        );
        assert_eq!(rig.show.timecode_seconds(), None);
        rig.show.go().unwrap();
        rig.run(240);
        assert_eq!(rig.show.timecode_seconds(), Some(3600.24));
        rig.run(240);
        // 480 ms in: the loop took over at 400 and continues the count.
        let tc = rig.show.timecode_seconds().unwrap();
        assert!((tc - 3600.48).abs() < 0.009, "{tc}");
        rig.show.stop_all().unwrap();
        rig.run(640);
        assert_eq!(rig.show.timecode_seconds(), None);
    }

    /// A script of cues given as `(note, body)`.
    fn script_of(cues: &[(u32, &str)]) -> Script {
        let mut text = String::from("```yaml\nconfig:\n    roles:\n        Anna: {}\n        Ben: {}\n```\n");
        for (note, body) in cues {
            text.push_str(&format!("\n```yaml\ntrigger_note: {{ch: 1, note: {note}}}\n{body}\n```\n"));
        }
        Script::parse(&text)
    }

    #[test]
    fn editing_the_script_does_not_stop_the_show() {
        let (long, next) = ("music: {file: long.wav, volume: 1}", "note: next");
        let mut rig = rig(&[long, next], &[("long.wav", 1.0, 4000)]);
        rig.show.go().unwrap();
        rig.run(104);
        // A cue is put in before the one that plays, and one after it.
        rig.show.replace_script(script_of(&[(7, "note: new"), (0, long), (8, "note: newer"), (1, next)])).unwrap();
        rig.run(104);
        assert!(rig.out[8..].iter().all(|&s| s == 1.0), "the audio played on untouched");
        assert_eq!(rig.fired(), [1]);
        assert_eq!(rig.show.current(), Some(1));
        assert_eq!(rig.show.next(), Some(2));
        assert_eq!(rig.show.audio_status()[0].0, 1);
        // Go carries on with the new cue; taking the playing cue out ends its audio.
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [1, 2]);
        rig.show.replace_script(script_of(&[(7, "note: new"), (8, "note: newer"), (1, next)])).unwrap();
        rig.run(104);
        assert_eq!(rig.show.audio_status(), []);
        assert_eq!(rig.fired(), [1]);
        assert_eq!(rig.level(), 0.0);
    }

    #[test]
    fn playing_audio_takes_on_what_is_changed_about_it() {
        let mut rig = rig(&["music: {file: short.wav, volume: 1}"], &[("short.wav", 1.0, 400)]);
        rig.show.go().unwrap();
        rig.run(104);
        // Made a loop while it plays: it does not end at the end of the file.
        rig.show.replace_script(script_of(&[(0, "music: {file: short.wav, volume: 1, loop: true}")])).unwrap();
        rig.run(600);
        let status = rig.show.audio_status()[0].1;
        assert_eq!(status.state, VoiceState::Playing);
        assert_eq!(rig.level(), 1.0);
        // The end moved in: the loop is shorter from now on.
        rig.show.replace_script(script_of(&[(0, "music: {file: short.wav, volume: 1, loop: true, end: 0.1}")])).unwrap();
        rig.run(304);
        let status = rig.show.audio_status()[0].1;
        assert_eq!((status.end, status.state), (0.1, VoiceState::Playing));
        assert!(status.seconds <= 0.1);
        // Only the level: no new start, the position runs on.
        let at = status.seconds;
        rig.show.replace_script(script_of(&[(0, "music: {file: short.wav, volume: 0.5, loop: true, end: 0.1}")])).unwrap();
        rig.run(104);
        assert_eq!(rig.level(), 0.5);
        // And not a loop any more: it plays to its end and is over.
        let _ = at;
        rig.show.replace_script(script_of(&[(0, "music: {file: short.wav, volume: 0.5, end: 0.1}")])).unwrap();
        rig.run(304);
        assert_eq!(rig.show.audio_status(), []);
    }

    #[test]
    fn a_crossfading_loop_has_no_timecode() {
        let mut rig = rig(&["music: {file: noise.wav, loop: true, crossfade: 0.05}\nstart_tc: '01:00:00:00'"], &[("noise.wav", 1.0, 400)]);
        rig.show.go().unwrap();
        rig.run(240);
        assert_eq!(rig.show.timecode_seconds(), None);
        // … and it goes round: 400 ms of audio, wrapping 50 ms before the end.
        rig.run(240);
        assert_eq!(rig.show.audio_status().iter().filter(|(cue, _)| *cue == 0).count(), 1);
        let status = rig.show.audio_status()[0].1;
        assert_eq!((status.start, status.transition, status.end), (0.0, 0.35, 0.4));
        assert!(status.seconds < 0.35, "{}", status.seconds);
    }

    /// A loop fired on its own, without its start having run, counts from where the
    /// start's timecode would have got to.
    #[test]
    fn timecode_is_derived_for_a_cue_fired_in_the_middle_of_a_chain() {
        let mut rig = rig(
            &[
                "music: start.wav\nstart_tc: '01:00:00:00'\nchain_end: {ch: 1, note: 1}",
                "music: loop.wav\nloop_outro: {ch: 1, note: 2}",
                "music: out.wav",
            ],
            &[("start.wav", 1.0, 400), ("loop.wav", 2.0, 200), ("out.wav", 3.0, 400)],
        );
        rig.show.fire(1, false).unwrap();
        rig.run(80);
        let tc = rig.show.timecode_seconds().unwrap();
        assert!((tc - 3600.48).abs() < 0.009, "the start is 400 ms long, the loop 80 ms in: {tc}");
        // The outro on its own: start and one pass of the loop lie before it.
        rig.show.stop_all().unwrap();
        rig.run(640);
        rig.show.fire(2, false).unwrap();
        rig.run(80);
        let tc = rig.show.timecode_seconds().unwrap();
        assert!((tc - 3600.68).abs() < 0.009, "{tc}");
    }

    /// Variants are cues of their own. What points at one of them means the group: a
    /// loop's outro is whichever variant is chosen, an adjust acts on the one that
    /// sounds, and a delayed auto-cue can hang on the group or on one variant.
    #[test]
    fn references_to_a_variant_mean_its_group() {
        let cues = [
            "music:\n    file: loop.wav\n    volume: 1\nloop_outro: {ch: 1, note: 1}",
            "music:\n    file: out_a.wav\n    volume: 1",
            "sibling: true\nmusic:\n    file: out_b.wav\n    volume: 0.5",
            "music:\n    adjust: {trigger_note: {ch: 1, note: 1}, volume: 0.5, fadetime: 0.008}",
            "auto_trigger: {trigger_note: {ch: 1, note: 1}, delay: 0.016, group: true}",
            "auto_trigger: {trigger_note: {ch: 1, note: 1}, delay: 0.016}",
            "auto_trigger: {trigger_note: {ch: 1, note: 2}, delay: 0.016}",
        ];
        let clips = [("loop.wav", 2.0, 48), ("out_a.wav", 3.0, 800), ("out_b.wav", 4.0, 800)];
        let mut rig = rig(&cues, &clips);
        rig.show.go().unwrap();
        rig.run(16);
        // The second variant is chosen as the outro, though the loop names the first.
        rig.show.select_variant(Some(2));
        rig.show.go().unwrap();
        assert_eq!(rig.show.pending_outros(), [(0, 2)]);
        rig.run(48);
        assert_eq!(rig.fired(), [0, 2]);
        assert_eq!(rig.level(), 2.0, "the variant at its own volume: 4 × 0.5");
        // The auto-cue on the group fires, and the one on this variant; not the one on the other.
        rig.run(24);
        assert_eq!(rig.fired(), [0, 2, 4, 6]);
        // The adjust names the first variant and turns down the one that sounds, to half of its own volume.
        rig.show.fire(3, false).unwrap();
        rig.run(40);
        assert_eq!(rig.level(), 1.0);
        // Back restores it.
        rig.show.back().unwrap();
        rig.run(600);
        assert_eq!(rig.level(), 2.0);
    }

    /// A variant is never fired by itself, and nothing carries straight on into one.
    #[test]
    fn variants_do_not_fire_by_themselves() {
        let cues = [
            "music:\n    file: start.wav\n    volume: 1\nchain_end: {ch: 1, note: 1}",
            "music:\n    file: a.wav\n    volume: 1",
            "sibling: true\nmusic:\n    file: b.wav\n    volume: 1\nauto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 0.008}",
        ];
        let mut rig = rig(&cues, &[("start.wav", 1.0, 40), ("a.wav", 2.0, 400), ("b.wav", 3.0, 400)]);
        rig.show.go().unwrap();
        rig.run(120);
        assert_eq!(rig.fired(), [0], "neither the chain nor the auto-cue fired a variant");
        assert!(!rig.show.go_blocked());
        // Nor does Go take one before the operator has chosen.
        assert!(rig.show.needs_variant());
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [0], "no falling back on the first variant");
        rig.show.select_variant(Some(2));
        assert!(!rig.show.needs_variant());
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [0, 2]);
    }

    /// A wait is shown from 0, wherever the audio it hangs on stands when it begins.
    #[test]
    fn waits_run_from_zero_and_hold_go_back() {
        let mut rig = rig(&SLF, &SLF_CLIPS);
        rig.show.go().unwrap();
        // The loop waits for the start's end (40 ms long).
        rig.run(16);
        let waits = rig.show.waits();
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].cue, 1);
        assert!((waits[0].fraction - 0.4).abs() < 0.05, "{waits:?}");
        rig.run(32);
        assert_eq!(rig.fired(), [0, 1]);
        assert!(rig.show.waits().is_empty() && !rig.show.go_blocked());

        // 8 ms into the loop the finish is asked for: its wait starts at 0, though the
        // loop is not at its start, and is half over half-way to the loop's end.
        rig.run(24);
        rig.show.go().unwrap();
        let wait = rig.show.waits().into_iter().find(|w| w.cue == 2).unwrap();
        assert!(wait.fraction < 0.05, "{wait:?}");
        assert!(rig.show.go_blocked());
        let before = rig.fired();
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), before, "Go is held back while the finish waits");
        let left = (1.0 - rig.show.player().status(1, None).map_or(0.0, |s| (s.seconds - s.start) / (s.transition - s.start))) * 48.0;
        rig.run((left / 2.0 / 8.0).round() as usize * 8);
        let wait = rig.show.waits().into_iter().find(|w| w.cue == 2).unwrap();
        assert!((wait.fraction - 0.5).abs() < 0.2, "{wait:?}");
        rig.run(48);
        assert_eq!(rig.fired().last(), Some(&2));
        assert!(!rig.show.go_blocked());
    }

    /// An auto-cue in a loop comes round on every pass: it shows its wait, but Go stays free.
    #[test]
    fn an_auto_cue_in_a_loop_does_not_hold_go_back() {
        let mut looped = rig(&["music: {file: long.wav, loop: true, end: 0.5}", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0.4}", "note: next"], &[("long.wav", 1.0, 1000)]);
        looped.show.go().unwrap();
        looped.run(200);
        assert!(!looped.show.go_blocked());
        let wait = looped.show.waits().into_iter().find(|w| w.cue == 1).unwrap();
        assert!((wait.fraction - 0.5).abs() < 0.05, "{wait:?}");
        // In audio that plays once it does hold Go back, as a delay does.
        let mut once = rig(&["music: long.wav", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: 0.4}", "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 0.6}", "note: next"], &[("long.wav", 1.0, 1000)]);
        once.show.go().unwrap();
        once.run(200);
        assert!(once.show.go_blocked());
        once.run(304);
        assert!(once.show.go_blocked(), "the delay is still running");
        once.run(200);
        assert_eq!(once.fired(), [0, 1, 2]);
        assert!(!once.show.go_blocked());
    }

    #[test]
    fn a_cue_with_missing_audio_still_fires_everything_else() {
        let mut rig = rig(&["music: missing.wav\nmic: Anna\ncue_midi:\n    - {device: Licht, type: pc, program: 3}", "light: next"], &[]);
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [0]);
        let effects = rig.show.take_effects();
        assert!(effects.contains(&Effect::Midi { device: "Licht".into(), bytes: vec![0xC0, 3], then_off: None }));
        assert!(matches!(effects[0], Effect::Mic(_)));
        let problems = rig.show.take_problems();
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("Cue 1.0: ") && problems[0].contains("missing.wav"), "{problems:?}");
        assert_eq!(rig.show.next(), Some(1), "and the show goes on");
    }

    #[test]
    fn auto_cues_with_a_cue_and_after_its_end() {
        let mut rig = rig(
            &[
                "music:\n    file: a.wav\n    volume: 1",
                "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 0}",
                "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: end}",
                "music:\n    file: a.wav\n    volume: 1",
                "auto_trigger: {trigger_note: {ch: 1, note: 3}, at: end}",
                "auto_trigger: {trigger_note: {ch: 1, note: 6}, at: end}",
                "light: no audio",
            ],
            &[("a.wav", 1.0, 200)],
        );
        rig.show.go().unwrap();
        rig.run(16);
        assert_eq!(rig.fired(), [0, 1], "with the cue");
        assert!(rig.show.go_blocked(), "waiting for the end");
        rig.run(160);
        assert_eq!(rig.fired(), [0, 1]);
        rig.run(48);
        assert_eq!(rig.fired(), [0, 1, 2], "after the end");

        // Audio that is stopped does not end by itself.
        rig.show.go().unwrap();
        rig.run(16);
        rig.show.stop_cue(3, 0.0).unwrap();
        rig.run(320);
        assert_eq!(rig.fired(), [0, 1, 2, 3]);
        // A source without audio has ended at once.
        rig.show.arm(Some(6));
        rig.show.go().unwrap();
        rig.run(16);
        assert_eq!(rig.fired(), [0, 1, 2, 3, 6, 5]);
    }

    #[test]
    fn back_after_a_jump_arms_the_jump_again() {
        let mut rig = rig(&["light: A", "light: B", "light: C", "light: D"], &[]);
        rig.show.go().unwrap();
        rig.show.arm(Some(2));
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [0, 2]);
        rig.show.back().unwrap();
        assert_eq!(rig.fired(), [0]);
        assert_eq!(rig.show.next(), Some(2), "as before that Go: the jump is armed");
        rig.show.back().unwrap();
        assert_eq!(rig.show.next(), Some(1), "a second Back clears it");
        assert_eq!(rig.fired(), [0]);
    }

    #[test]
    fn back_after_a_second_press_brings_the_audio_back_where_it_would_be() {
        let ramp: Vec<f32> = (0..2000).map(|n| n as f32).collect();
        let mut rig = rig(&["music:\n    file: ramp.wav\n    volume: 1", "light: B"], &[]);
        rig.show.player().cache().insert("ramp.wav", Clip::from_planar(SR, vec![ramp]));
        rig.show.go().unwrap();
        rig.run(200);
        rig.show.fire(0, false).unwrap();
        rig.run(200);
        assert_eq!(rig.level(), 0.0, "stopped");
        assert_eq!(rig.fired(), [0]);
        rig.show.back().unwrap();
        rig.run(80);
        assert_eq!(rig.fired(), [0], "Back took back the stop, not the cue");
        assert_eq!(rig.level(), (rig.frames - 1) as f32, "on as if it had never stopped");
        assert_eq!(rig.show.next(), Some(1));
    }

    #[test]
    fn back_brings_back_audio_a_cue_faded_out_where_it_would_be() {
        let ramp: Vec<f32> = (0..4000).map(|n| n as f32).collect();
        let mut rig = rig(&["music:\n    file: ramp.wav\n    volume: 1", "music:\n    adjust: {trigger_note: {ch: 1, note: 0}, fadeout: true, fadetime: 0.016}"], &[]);
        rig.show.player().cache().insert("ramp.wav", Clip::from_planar(SR, vec![ramp]));
        rig.show.go().unwrap();
        rig.run(200);
        rig.show.go().unwrap();
        rig.run(400);
        assert_eq!(rig.level(), 0.0);
        rig.show.back().unwrap();
        rig.run(800);
        assert_eq!(rig.level(), (rig.frames - 1) as f32);
    }

    #[test]
    fn back_switches_off_microphones_no_earlier_cue_opened() {
        let mut rig = rig(&["light: A", "mic: Anna"], &[]);
        rig.show.go().unwrap();
        rig.show.go().unwrap();
        rig.show.take_effects();
        rig.show.back().unwrap();
        assert_eq!(rig.show.take_effects(), [Effect::Mic(Mic::MuteAll)]);
    }

    #[test]
    fn stepping_arms_the_cue_before_or_after_the_next_go() {
        let mut rig = rig(&["light: A", "light: B", "sibling: true", "light: C"], &[]);
        rig.show.go().unwrap();
        assert_eq!(rig.show.next(), Some(1));
        rig.show.step(true);
        assert_eq!(rig.show.next(), Some(3), "a group of variants is one cue");
        rig.show.step(true);
        assert_eq!(rig.show.next(), Some(3), "nothing after the last cue");
        rig.show.step(false);
        rig.show.step(false);
        assert_eq!(rig.show.next(), Some(0));
        assert_eq!(rig.fired(), [0], "nothing fired");
    }

    #[test]
    fn remote_trigger_and_arming() {
        let mut rig = rig(&["light: A", "light: B", "light: C"], &[]);
        rig.show.fire_note(Note { ch: 1, note: 2 }).unwrap();
        assert_eq!(rig.fired(), [2]);
        rig.show.fire_note(Note { ch: 9, note: 9 }).unwrap();
        assert_eq!(rig.fired(), [2], "an unknown note fires nothing");
        rig.show.arm(Some(0));
        assert_eq!(rig.show.next(), Some(0));
        rig.show.back().unwrap();
        assert_eq!(rig.show.next(), None, "back only clears the arming; cue 2 was the last cue");
        assert_eq!(rig.fired(), [2]);
        rig.show.arm(Some(0));
        rig.show.go().unwrap();
        assert_eq!(rig.fired(), [2, 0]);
        assert_eq!(rig.show.next(), Some(1));
    }
}
