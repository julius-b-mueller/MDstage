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
use crate::mtc::Timecode;
use crate::player::{Player, Start, Then};

/// Fade used when Back stops what the undone cues started.
const BACK_FADE: f64 = 0.5;
/// Shorter fade for an outro whose loop is brought back at the same moment: two long
/// fades of similar material overlapping would sound like a phaser.
const HANDOVER_FADE: f64 = 0.05;
/// Fade of `music.adjust` when the cue does not set one.
const DEFAULT_ADJUST_FADE: f64 = 3.0;

/// A delay auto-cue waiting to fire.
struct Delay {
    target: usize,
    source: usize,
    started: f64,
    due: f64,
}

/// An audio-position auto-cue: fires `target` when `source`'s audio passes `at`.
struct Watch {
    target: usize,
    source: usize,
    at: f64,
    last: Option<f64>,
}

/// The cue that drives the timecode.
struct TimecodeSource {
    cue: usize,
    /// Timecode (seconds) at the start of the cue's first part.
    base: f64,
    /// `(start, transition)` of each part, to add up the parts already played.
    spans: Vec<(f64, f64)>,
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
    /// When each running loop was (or would have been) at the start of its cycle.
    loop_epochs: HashMap<usize, f64>,
    /// Where audio stood when a cue faded it out, to pick it up there on Back.
    stopped_at: HashMap<usize, (usize, f64)>,
    timecode: Option<TimecodeSource>,
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
            loop_epochs: HashMap::new(),
            stopped_at: HashMap::new(),
            timecode: None,
            effects: Vec::new(),
            problems: Vec::new(),
            shown: HashMap::new(),
            now: 0.0,
        }
    }

    pub fn script(&self) -> &Script {
        &self.script
    }

    /// Swap in an edited script. The fired cues are kept if the cues are still the same
    /// ones in the same order (text was edited, a cue's fields changed); otherwise the
    /// show starts over, with all audio stopped.
    pub fn replace_script(&mut self, script: Script) -> Result<()> {
        let notes = |s: &Script| Cues::new(s).len();
        let same_cues = notes(&self.script) == notes(&script);
        self.cast = Cast::from_script(&script, self.cast.english);
        self.script = Arc::new(script);
        if !same_cues {
            self.history = History::default();
            self.armed = None;
            self.selected_variant = None;
            self.loop_epochs.clear();
            self.stopped_at.clear();
            self.stop_all()?;
            self.report_displays();
        }
        Ok(())
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

    /// Cues with audio loaded, and where each one is.
    pub fn audio_status(&self) -> Vec<(usize, crate::player::Status)> {
        let clock = self.clock.as_deref();
        self.player.active_cues().into_iter().filter_map(|cue| Some((cue, self.player.status(cue, clock)?))).collect()
    }

    /// Make a cue the next Go, whatever the position (jump, "arm in live view").
    pub fn arm(&mut self, cue: Option<usize>) {
        self.armed = cue;
    }

    /// Choose which variant of the next cue Go fires.
    pub fn select_variant(&mut self, cue: Option<usize>) {
        self.selected_variant = cue;
    }

    fn audio(&self, cue: usize) -> Option<CueAudio> {
        Cues::new(&self.script).get(cue)?.audio()
    }

    /// How a cue's audio ends: loops loop, a `chain_end` with playable audio chains.
    fn then(&self, cue: usize) -> Then {
        let cues = Cues::new(&self.script);
        let (Some(c), Some(audio)) = (cues.get(cue), self.audio(cue)) else { return Then::End };
        if c.loop_outro().is_some() || audio.looped || audio.parts.len() > 1 {
            return Then::Loop;
        }
        match c.chain_end().and_then(|n| cues.find(n)).filter(|&next| self.audio(next).is_some()) {
            Some(next) => Then::Chain(next),
            None => Then::End,
        }
    }

    fn is_playing(&self, cue: usize) -> bool {
        self.player.status(cue, None).is_some_and(|s| s.state == VoiceState::Playing)
    }

    /// Go: fire the armed cue, or the next one.
    pub fn go(&mut self) -> Result<()> {
        let cue = self.next();
        self.armed = None;
        self.selected_variant = None;
        match cue {
            Some(cue) => self.fire(cue, false),
            None => Ok(()),
        }
    }

    /// Fire the cue carrying this trigger note, whatever the position (remote triggering).
    pub fn fire_note(&mut self, note: Note) -> Result<()> {
        let cue = Cues::new(&self.script).find(note);
        self.armed = None;
        self.selected_variant = None;
        match cue {
            Some(cue) => self.fire(cue, false),
            None => Ok(()),
        }
    }

    /// Fire a cue. `auto` marks cues not fired by the operator (auto-cues).
    ///
    /// Two cases do not fire: a cue whose audio is playing is stopped instead (a second
    /// press undoes an accidental one), and the outro of a running loop is queued for
    /// the loop's end (or un-queued by a second press).
    pub fn fire(&mut self, cue: usize, auto: bool) -> Result<()> {
        let script = self.script.clone();
        let cues = Cues::new(&script);
        if cues.get(cue).is_none() {
            return Ok(());
        }
        if self.is_playing(cue) {
            self.player.stop(cue, 0.0)?;
            self.forget_audio_of(&[cue]);
            return Ok(());
        }
        let running_loop = (0..cues.len()).find(|&l| {
            cues.get(l).and_then(|c| c.loop_outro()).and_then(|n| cues.find(n)) == Some(cue) && self.is_playing(l)
        });
        if let (Some(looped), Some(audio)) = (running_loop, self.audio(cue)) {
            if let Some(i) = self.pending_outros.iter().position(|&p| p == (looped, cue)) {
                self.pending_outros.remove(i);
                self.player.cancel_outro(looped)?;
                self.player.stop(cue, 0.0)?;
            } else {
                self.player.start(cue, &audio, Start::armed(self.then(cue)))?;
                self.player.queue_outro(looped, cue)?;
                self.pending_outros.push((looped, cue));
            }
            return Ok(());
        }
        // Fired by hand before its chain got there: the operator has taken over, so the
        // handoff must not fire it a second time.
        self.chains.retain(|&(_, to)| to != cue);
        self.begin(cue, auto, false)
    }

    /// Everything a cue does when it fires. `started` means its audio is already running
    /// (it came in through a handoff inside the audio engine).
    fn begin(&mut self, cue: usize, auto: bool, started: bool) -> Result<()> {
        let script = self.script.clone();
        let cues = Cues::new(&script);
        let (Some(c), Some(block)) = (cues.get(cue), cues.block_index(cue)) else { return Ok(()) };

        let mic = script.mic_for_cue(block, &self.cast);
        if mic != Mic::Unchanged {
            self.effects.push(Effect::Mic(mic));
        }

        // Timecode: a cue with `start_tc` takes it over (and ends the audio that drove it);
        // a cue that continues another's audio continues its timecode.
        let start_tc = c.text("start_tc").and_then(Timecode::parse);
        // A handoff happens at the end of the source's stretch, so that is where the
        // count carries on — the source itself may already be gone.
        let hands_off = |from: usize| {
            let source = cues.get(from)?;
            cues.find(source.loop_outro().or(source.chain_end())?)
        };
        let continued = self
            .timecode
            .as_ref()
            .filter(|t| started && start_tc.is_none() && hands_off(t.cue) == Some(cue))
            .map(|t| t.base + t.spans.iter().map(|(a, b)| b - a).sum::<f64>());
        if start_tc.is_some() {
            if let Some(previous) = self.timecode.take().filter(|t| t.cue != cue) {
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
                self.problems.push(format!("Cue {}: {e}", cue + 1));
                audio = None;
            }
        }
        if let (Some(_), Then::Chain(next)) = (&audio, then) {
            if let Some(next_audio) = self.audio(next).filter(|_| !self.chains.contains(&(cue, next))) {
                match self.player.start(next, &next_audio, Start::armed(self.then(next))) {
                    Ok(()) => self.chains.push((cue, next)),
                    Err(e) => self.problems.push(format!("Cue {}: {e}", next + 1)),
                }
            }
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
            let base = start_tc.map(|tc| tc.to_frames() as f64 / crate::mtc::FPS as f64).or(continued);
            if let Some(base) = base {
                self.timecode = Some(TimecodeSource { cue, base, spans });
            }
        }

        if let Some(adjust) = c.adjust() {
            if let Some(target) = cues.find(adjust.target) {
                let fade = adjust.fadetime.unwrap_or(DEFAULT_ADJUST_FADE);
                if adjust.fadeout {
                    if let Some(status) = self.player.status(target, self.clock.as_deref()) {
                        self.stopped_at.insert(target, (status.part, status.seconds + fade));
                    }
                    self.player.stop(target, fade)?;
                } else if let Some(volume) = adjust.volume {
                    self.player.fade(target, volume, fade)?;
                }
            }
        }

        self.effects.extend(c.fire_effects());
        self.history.push(cue, auto);

        // Auto-cues that hang on this cue (or on a variant of it).
        let root = cues.group_root(cue);
        for target in 0..cues.len() {
            let Some(auto_trigger) = cues.get(target).and_then(|t| t.auto_trigger()) else { continue };
            if cues.find(auto_trigger.source).map(|s| cues.group_root(s)) != Some(root) {
                continue;
            }
            match auto_trigger.when {
                AutoWhen::Delay(seconds) => {
                    self.delays.retain(|d| d.target != target);
                    self.delays.push(Delay { target, source: cue, started: self.now, due: self.now + seconds.max(0.0) });
                }
                AutoWhen::At(at) => {
                    self.watches.retain(|w| w.target != target);
                    self.watches.push(Watch { target, source: cue, at, last: None });
                }
            }
        }
        self.report_displays();
        Ok(())
    }

    /// Drop timers, watches and timecode that depend on these cues' audio.
    fn forget_audio_of(&mut self, cues: &[usize]) {
        self.delays.retain(|d| !cues.contains(&d.source));
        self.watches.retain(|w| !cues.contains(&w.source));
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
        // Audio-position auto-cues: fire when the source passes the position; once per
        // pass of a loop.
        let mut reached = Vec::new();
        for watch in &mut self.watches {
            let Some(status) = self.player.status(watch.source, self.clock.as_deref()).filter(|s| s.state == VoiceState::Playing) else {
                continue;
            };
            if watch.last.is_some_and(|last| last < watch.at && status.seconds >= watch.at) {
                reached.push(watch.target);
            }
            watch.last = Some(status.seconds);
        }
        let player = &self.player;
        self.watches.retain(|w| player.is_sounding(w.source));
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

    /// Bring a stopped cue's audio back at `volume`: loops in beat, other audio where it
    /// was faded out.
    fn resume(&mut self, cue: usize, volume: f64) -> Result<()> {
        let Some(mut audio) = self.audio(cue) else { return Ok(()) };
        let then = self.then(cue);
        let resume = if then == Then::Loop {
            self.loop_position(cue, &audio)?
        } else {
            match self.stopped_at.get(&cue) {
                Some(&position) => position,
                None => return Ok(()),
            }
        };
        for part in &mut audio.parts {
            part.volume = volume;
        }
        self.player.start(cue, &audio, Start { armed: false, then, resume: Some(resume) })?;
        let tc = Cues::new(&self.script).get(cue).and_then(|c| c.text("start_tc")).and_then(Timecode::parse);
        if let Some(tc) = tc {
            let spans = self.player.spans(&audio)?;
            self.timecode = Some(TimecodeSource { cue, base: tc.to_frames() as f64 / crate::mtc::FPS as f64, spans });
        }
        Ok(())
    }

    /// Back: take back a queued outro or an armed cue; otherwise undo the last Go with
    /// everything it set off.
    pub fn back(&mut self) -> Result<()> {
        if !self.pending_outros.is_empty() {
            let pending = std::mem::take(&mut self.pending_outros);
            for &(looped, outro) in &pending {
                self.player.cancel_outro(looped)?;
                self.player.stop(outro, 0.0)?;
            }
            // One queued outro stays armed as the next Go; several cannot be.
            self.armed = if pending.len() == 1 { Some(pending[0].1) } else { None };
            return Ok(());
        }
        if self.armed.take().is_some() {
            self.selected_variant = None;
            return Ok(());
        }
        self.selected_variant = None;

        let script = self.script.clone();
        let cues = Cues::new(&script);
        let Some(undone) = self.history.back(&cues) else { return Ok(()) };
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
        let successor = |cue: usize| cues.get(cue).and_then(|c| c.loop_outro()).and_then(|n| cues.find(n));
        let mut returning: Vec<usize> = self
            .history
            .cues()
            .filter(|&cue| self.then(cue) == Then::Loop && successor(cue).is_some_and(|s| popped.contains(&s)))
            .filter(|&cue| !self.player.is_sounding(cue) && self.history.audio_state(&cues, cue).0)
            .collect();
        returning.dedup();
        let handed_over: Vec<usize> = returning.iter().filter_map(|&l| successor(l)).collect();

        for &cue in popped {
            let fade = if handed_over.contains(&cue) { HANDOVER_FADE } else { BACK_FADE };
            self.player.stop(cue, fade)?;
        }
        for cue in returning {
            let volume = self.history.audio_state(&cues, cue).1;
            self.resume(cue, volume)?;
        }

        // Audio the undone cues ducked or faded out goes back to what the remaining
        // history implies. `popped` is newest first, so the latest adjust per target wins.
        let mut restored = Vec::new();
        for &cue in popped {
            let Some(target) = cues.get(cue).and_then(|c| c.adjust()).and_then(|a| cues.find(a.target)) else { continue };
            if restored.contains(&target) {
                continue;
            }
            restored.push(target);
            let (playing, volume) = self.history.audio_state(&cues, target);
            if !playing || volume <= 0.0 {
                continue;
            }
            if self.player.is_sounding(target) {
                self.player.fade(target, volume, BACK_FADE)?;
            } else {
                self.resume(target, volume)?;
            }
        }

        // Microphones as the remaining cues left them; nothing left means everything off.
        let mic = self.history.mic(&cues, &self.cast);
        self.effects.push(Effect::Mic(if self.history.is_empty() { Mic::MuteAll } else { mic }).clone());
        self.effects.retain(|e| *e != Effect::Mic(Mic::Unchanged));
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
        self.timecode = None;
        self.player.stop_all(BACK_FADE)
    }

    /// Emergency "Mics Off".
    pub fn mics_off(&mut self) {
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
        rig.show.go().unwrap(); // the loop, 24 ms before the start would have chained into it
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
        assert!(problems[0].starts_with("Cue 1: ") && problems[0].contains("missing.wav"), "{problems:?}");
        assert_eq!(rig.show.next(), Some(1), "and the show goes on");
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
