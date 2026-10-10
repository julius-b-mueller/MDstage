//! Plays the audio of cues: turns a cue's parts, files and patch into mixer voices and
//! offers the operations the show logic needs (start, queue an outro, fade, stop, resume).
//!
//! Runs on the control thread. Decoding happens here, never in the audio callback.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use mdstage_core::audio::{AudioFile, CueAudio};

use crate::clip::Clip;
use crate::clock::{EngineClock, VoiceShared, VoiceState};
use crate::mixer::{AtTransition, Command, MixerHandle, Route, VoiceId, VoiceSpec};
use crate::{Error, Result};

/// Ramp with which resumed audio comes in, in seconds.
const RESUME_RAMP: f64 = 0.012;

/// Where each virtual channel comes out: name → physical output (0-based).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Routing {
    channels: Vec<(String, usize)>,
}

impl Routing {
    pub fn new(channels: Vec<(String, usize)>) -> Routing {
        Routing { channels }
    }

    /// The default routing: the *i*-th virtual channel on output *i*.
    pub fn positional(names: &[String]) -> Routing {
        Routing { channels: names.iter().cloned().zip(0..).collect() }
    }

    fn output(&self, name: &str) -> Option<usize> {
        self.channels.iter().find(|(n, _)| n == name).map(|(_, out)| *out)
    }

    /// Patch for a file without one: channel *i* to the *i*-th virtual channel; a single
    /// channel goes to the first two so it is not stuck on one side.
    fn default_patch(&self, source_channels: usize) -> Vec<Vec<String>> {
        let name = |i: usize| self.channels.get(i).map(|(n, _)| n.clone());
        if source_channels == 1 {
            return vec![(0..2).filter_map(name).collect()];
        }
        (0..source_channels).map(|i| name(i).into_iter().collect()).collect()
    }
}

/// Decoded audio files of the open show, at the output device's sample rate.
pub struct ClipCache {
    dir: PathBuf,
    sample_rate: u32,
    clips: HashMap<String, Arc<Clip>>,
}

impl ClipCache {
    /// `dir` is the show's `audio/` folder.
    pub fn new(dir: PathBuf, sample_rate: u32) -> ClipCache {
        ClipCache { dir, sample_rate, clips: HashMap::new() }
    }

    /// Put an already decoded clip into the cache under a file name.
    pub fn insert(&mut self, file: &str, clip: Clip) {
        self.clips.insert(file.to_string(), Arc::new(clip));
    }

    /// The clip for a file, decoding and resampling it on first use.
    pub fn get(&mut self, file: &str) -> Result<Arc<Clip>> {
        if let Some(clip) = self.clips.get(file) {
            return Ok(clip.clone());
        }
        let clip = Arc::new(Clip::decode_file(&self.dir.join(file))?.resampled(self.sample_rate)?);
        self.clips.insert(file.to_string(), clip.clone());
        Ok(clip)
    }

    /// Forget all clips (after the show or the output device changed).
    pub fn clear(&mut self) {
        self.clips.clear();
    }
}

/// What a cue's audio does when it reaches its end (or its fading point).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    /// Play out and stop.
    End,
    /// Start over (a loop / vamp), until an outro is queued.
    Loop,
    /// Start the given cue's audio on the same sample (`chain_end`).
    Chain(usize),
}

/// How to bring a cue's audio in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Start {
    /// Stay silent until another cue hands off to this one.
    pub armed: bool,
    pub then: Then,
    /// Begin inside the audio instead of at its start: `(part, seconds)`.
    pub resume: Option<(usize, f64)>,
}

impl Start {
    pub fn now(then: Then) -> Start {
        Start { armed: false, then, resume: None }
    }

    pub fn armed(then: Then) -> Start {
        Start { armed: true, then, resume: None }
    }
}

/// Where a cue's audio is right now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Status {
    pub state: VoiceState,
    /// The part of a multi-part loop that is playing.
    pub part: usize,
    /// Position within that part's file, in seconds.
    pub seconds: f64,
    /// The stretch the part cycles through: region start and transition point, in seconds.
    pub start: f64,
    pub transition: f64,
    pub end: f64,
}

struct ActivePart {
    id: VoiceId,
    shared: Vec<Arc<VoiceShared>>,
    start: usize,
    transition: usize,
    end: usize,
}

struct ActiveCue {
    parts: Vec<ActivePart>,
    then: Then,
    outro_queued: bool,
}

impl ActiveCue {
    fn states(&self) -> impl Iterator<Item = VoiceState> + '_ {
        self.parts.iter().filter_map(|p| p.shared.first()).map(|s| s.state())
    }
}

/// Mixer id of one part of a cue. Stable, so a cue can hand off to one loaded later.
fn voice_id(cue: usize, part: usize) -> VoiceId {
    ((cue as u32) << 6) | (part as u32 & 63)
}

pub struct Player {
    handle: MixerHandle,
    cache: ClipCache,
    routing: Routing,
    sample_rate: u32,
    active: HashMap<usize, ActiveCue>,
}

impl Player {
    pub fn new(handle: MixerHandle, cache: ClipCache, routing: Routing) -> Player {
        let sample_rate = cache.sample_rate;
        Player { handle, cache, routing, sample_rate, active: HashMap::new() }
    }

    pub fn cache(&mut self) -> &mut ClipCache {
        &mut self.cache
    }

    pub fn set_routing(&mut self, routing: Routing) {
        self.routing = routing;
    }

    fn send(&mut self, command: Command) -> Result<()> {
        self.handle.send(command).map_err(|_| Error::Busy)
    }

    fn frames(&self, seconds: f64) -> usize {
        (seconds.max(0.0) * self.sample_rate as f64).round() as usize
    }

    fn seconds(&self, frames: usize) -> f64 {
        frames as f64 / self.sample_rate as f64
    }

    /// Routes of one file: every source channel to the outputs of its patched channels.
    fn routes(&self, audio: &AudioFile, clip: &Clip) -> Vec<Route> {
        let channels = clip.channel_count();
        let patch = audio.patch.clone().unwrap_or_else(|| self.routing.default_patch(if audio.mono { 1 } else { channels }));
        let mut routes = Vec::new();
        for (source, names) in patch.iter().enumerate() {
            for out in names.iter().filter_map(|n| self.routing.output(n)) {
                if audio.mono {
                    // The mono mix: every channel of the file, equally weighted.
                    let gain = (audio.volume / channels.max(1) as f64) as f32;
                    routes.extend((0..channels).map(|src| Route { src: src as u16, out: out as u16, gain }));
                } else if source < channels {
                    routes.push(Route { src: source as u16, out: out as u16, gain: audio.volume as f32 });
                }
            }
            if audio.mono {
                break;
            }
        }
        routes
    }

    /// Load a cue's audio into the mixer, playing or armed. Audio of the same cue that is
    /// still running is cut off with a short fade.
    pub fn start(&mut self, cue: usize, audio: &CueAudio, start: Start) -> Result<()> {
        // Decode everything first, so a missing file leaves the mixer untouched.
        let mut clips = Vec::with_capacity(audio.parts.len());
        for part in &audio.parts {
            let files: Result<Vec<Arc<Clip>>> = part.audios.iter().map(|a| self.cache.get(&a.file)).collect();
            clips.push(files?);
        }
        if self.active.contains_key(&cue) {
            self.stop(cue, 0.005)?;
        }

        let count = audio.parts.len();
        let (resume_part, resume_at) = start.resume.map_or((0, None), |(p, s)| (p.min(count - 1), Some(s)));
        let mut active = ActiveCue { parts: Vec::with_capacity(count), then: start.then, outro_queued: false };
        for (index, (part, files)) in audio.parts.iter().zip(&clips).enumerate() {
            let longest = files.iter().map(|c| c.frames()).max().unwrap_or(0);
            let end = part.end.map_or(longest, |s| self.frames(s));
            let region_start = part.start.map_or(0, |s| self.frames(s)).min(end);
            let transition = part.fading_point.map_or(end, |s| self.frames(s)).clamp(region_start, end);
            let id = voice_id(cue, index);
            let (at_transition, rearm) = match start.then {
                _ if count > 1 => (AtTransition::Handoff(voice_id(cue, (index + 1) % count)), true),
                Then::Loop => (AtTransition::Wrap, false),
                Then::Chain(next) => (AtTransition::Handoff(voice_id(next, 0)), false),
                Then::End => (AtTransition::Continue, false),
            };
            let mut shared = Vec::with_capacity(files.len());
            for (file, clip) in part.audios.iter().zip(files) {
                let spec = VoiceSpec {
                    start: region_start,
                    transition,
                    end,
                    initial: resume_at.filter(|_| index == resume_part).map(|s| self.frames(s)),
                    at_transition,
                    gain: if resume_at.is_some() { 0.0 } else { part.volume as f32 },
                    fade_in: part.fadein.map_or(0, |s| self.frames(s) as u32),
                    fade_out: part.fadeout.map_or(0, |s| self.frames(s) as u32),
                    routes: self.routes(file, clip),
                    armed: start.armed || index != resume_part,
                    rearm,
                    ..VoiceSpec::whole(id, clip.clone())
                };
                shared.push(spec.shared.clone());
                self.send(Command::Add(spec))?;
            }
            if resume_at.is_some() {
                // Resumed audio comes in mid-waveform: a short ramp instead of a click.
                let frames = self.frames(RESUME_RAMP) as u32;
                self.send(Command::Fade { id, target: part.volume as f32, frames, then_stop: false })?;
            }
            active.parts.push(ActivePart { id, shared, start: region_start, transition, end });
        }
        self.active.insert(cue, active);
        Ok(())
    }

    /// The stretch each part of `audio` cycles through, in seconds: `(start, transition)`.
    /// Decodes the files if necessary (their length is the default end).
    pub fn spans(&mut self, audio: &CueAudio) -> Result<Vec<(f64, f64)>> {
        let mut spans = Vec::with_capacity(audio.parts.len());
        for part in &audio.parts {
            let mut longest = 0.0f64;
            for file in &part.audios {
                longest = longest.max(self.cache.get(&file.file)?.duration());
            }
            let end = part.end.unwrap_or(longest);
            let start = part.start.unwrap_or(0.0).min(end);
            spans.push((start, part.fading_point.unwrap_or(end).clamp(start, end)));
        }
        Ok(spans)
    }

    fn part_ids(&self, cue: usize) -> Vec<VoiceId> {
        self.active.get(&cue).map(|a| a.parts.iter().map(|p| p.id).collect()).unwrap_or_default()
    }

    /// Let the loop `cue` hand off to `outro` (which must be loaded armed) the next time
    /// it reaches its loop end or fading point.
    pub fn queue_outro(&mut self, cue: usize, outro: usize) -> Result<()> {
        for id in self.part_ids(cue) {
            self.send(Command::SetTransition { id, at: AtTransition::Handoff(voice_id(outro, 0)) })?;
            self.send(Command::SetRearm { id, rearm: false })?;
        }
        if let Some(active) = self.active.get_mut(&cue) {
            active.outro_queued = true;
        }
        Ok(())
    }

    /// Take a queued outro back: the loop keeps cycling.
    pub fn cancel_outro(&mut self, cue: usize) -> Result<()> {
        let Some(active) = self.active.get(&cue) else { return Ok(()) };
        let count = active.parts.len();
        let then = active.then;
        for (index, id) in self.part_ids(cue).into_iter().enumerate() {
            let (at, rearm) = match then {
                _ if count > 1 => (AtTransition::Handoff(voice_id(cue, (index + 1) % count)), true),
                Then::Chain(next) => (AtTransition::Handoff(voice_id(next, 0)), false),
                Then::Loop => (AtTransition::Wrap, false),
                Then::End => (AtTransition::Continue, false),
            };
            self.send(Command::SetTransition { id, at })?;
            self.send(Command::SetRearm { id, rearm })?;
        }
        if let Some(active) = self.active.get_mut(&cue) {
            active.outro_queued = false;
        }
        Ok(())
    }

    /// Ramp a cue's audio to `volume` over `seconds` and keep it playing.
    pub fn fade(&mut self, cue: usize, volume: f64, seconds: f64) -> Result<()> {
        let frames = self.frames(seconds) as u32;
        for id in self.part_ids(cue) {
            self.send(Command::Fade { id, target: volume as f32, frames, then_stop: false })?;
        }
        Ok(())
    }

    /// Fade a cue's audio out over `seconds` and end it.
    pub fn stop(&mut self, cue: usize, seconds: f64) -> Result<()> {
        let frames = self.frames(seconds) as u32;
        for id in self.part_ids(cue) {
            self.send(Command::Fade { id, target: 0.0, frames, then_stop: true })?;
        }
        self.active.remove(&cue);
        Ok(())
    }

    /// Fade everything out over `seconds` (the emergency "Music Stop").
    pub fn stop_all(&mut self, seconds: f64) -> Result<()> {
        let frames = self.frames(seconds) as u32;
        self.active.clear();
        self.send(Command::StopAll { frames })
    }

    /// Where a cue's audio is. With a clock the position is extrapolated to this instant,
    /// otherwise it is the position at the last block boundary.
    pub fn status(&self, cue: usize, clock: Option<&EngineClock>) -> Option<Status> {
        let active = self.active.get(&cue)?;
        // The part that is audible: playing first, else ringing out, else whatever is first.
        let rank = |state: VoiceState| match state {
            VoiceState::Playing => 0,
            VoiceState::Tail => 1,
            VoiceState::Armed => 2,
            VoiceState::Done => 3,
        };
        let (index, part) = active
            .parts
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.shared.is_empty())
            .min_by_key(|(_, p)| rank(p.shared[0].state()))?;
        let voice = &part.shared[0];
        let frames = clock.map_or(voice.clip_frame() as f64, |c| voice.clip_frame_now(c));
        Some(Status {
            state: voice.state(),
            part: index,
            seconds: frames / self.sample_rate as f64,
            start: self.seconds(part.start),
            transition: self.seconds(part.transition),
            end: self.seconds(part.end),
        })
    }

    /// The cues that have audio loaded (playing, ringing out or armed), in cue order.
    pub fn active_cues(&self) -> Vec<usize> {
        let mut cues: Vec<usize> = self.active.keys().copied().collect();
        cues.sort_unstable();
        cues
    }

    /// Whether a cue's audio is audible (playing or ringing out).
    pub fn is_sounding(&self, cue: usize) -> bool {
        self.active.get(&cue).is_some_and(|a| a.states().any(|s| matches!(s, VoiceState::Playing | VoiceState::Tail)))
    }

    /// Housekeeping; call regularly. Frees finished voices and forgets cues that are over.
    pub fn tick(&mut self) -> Result<()> {
        self.handle.collect_garbage();
        // Once a loop has handed off to its outro, parts that were waiting for their turn
        // will never get one.
        let leftovers: Vec<VoiceId> = self
            .active
            .values()
            .filter(|a| a.outro_queued && !a.states().any(|s| s == VoiceState::Playing))
            .flat_map(|a| a.parts.iter().filter(|p| p.shared.first().is_some_and(|s| s.state() == VoiceState::Armed)))
            .map(|p| p.id)
            .collect();
        for id in leftovers {
            self.send(Command::Discard { id })?;
        }
        self.active.retain(|_, a| a.states().any(|s| s != VoiceState::Done));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mixer::Mixer;
    use mdstage_core::audio::Part;

    /// 1000 Hz, so one frame is one millisecond.
    const SR: u32 = 1000;

    fn file(name: &str) -> AudioFile {
        AudioFile { file: name.into(), mono: false, volume: 1.0, patch: None }
    }

    fn part(audios: Vec<AudioFile>) -> Part {
        Part { audios, volume: 1.0, start: None, end: None, fadein: None, fadeout: None, fading_point: None }
    }

    fn one(name: &str) -> CueAudio {
        CueAudio { parts: vec![part(vec![file(name)])], looped: false }
    }

    /// A player over a mixer rendered by hand, with constant-valued mono test clips.
    fn setup(clips: &[(&str, f32, usize)], channels: &[&str]) -> (Mixer, Player) {
        let (mixer, handle) = Mixer::new();
        let mut cache = ClipCache::new(PathBuf::from("/nonexistent"), SR);
        for &(name, value, frames) in clips {
            cache.insert(name, Clip::from_planar(SR, vec![vec![value; frames]]));
        }
        let names: Vec<String> = channels.iter().map(|c| c.to_string()).collect();
        (mixer, Player::new(handle, cache, Routing::positional(&names)))
    }

    /// Render `frames` frames; returns output channel 0.
    fn render(mixer: &mut Mixer, frames: usize, channels: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut buf = vec![0.0; 16 * channels];
        while out.len() < frames {
            mixer.render(&mut buf, channels);
            out.extend(buf.chunks(channels).map(|f| f[0]));
        }
        out
    }

    #[test]
    fn patches_files_to_virtual_channels() {
        let (mut mixer, mut player) = setup(&[], &["L", "R", "Sub", "Click"]);
        player.cache().insert("band.wav", Clip::from_planar(SR, vec![vec![0.1; 32], vec![0.2; 32], vec![0.3; 32]]));
        player.cache().insert("click.wav", Clip::from_planar(SR, vec![vec![0.4; 32], vec![0.8; 32]]));
        // Custom routing: Sub on output 5, Click on output 4.
        player.set_routing(Routing::new(vec![("L".into(), 0), ("R".into(), 1), ("Sub".into(), 5), ("Click".into(), 4)]));

        let band = AudioFile { patch: Some(vec![vec!["L".into()], vec!["R".into(), "Sub".into()], vec!["Gone".into()]]), ..file("band.wav") };
        let click = AudioFile { mono: true, volume: 0.5, patch: Some(vec![vec!["Click".into()]]), ..file("click.wav") };
        let audio = CueAudio { parts: vec![Part { volume: 0.5, ..part(vec![band, click]) }], looped: false };
        player.start(0, &audio, Start::now(Then::End)).unwrap();

        let mut buf = vec![0.0f32; 6];
        mixer.render(&mut buf, 6);
        let expected = [0.05, 0.1, 0.0, 0.0, 0.15, 0.1];
        for (got, want) in buf.iter().zip(expected) {
            assert!((got - want).abs() < 1e-6, "{buf:?}");
        }
    }

    #[test]
    fn unpatched_files_use_the_default_patch() {
        let (mut mixer, mut player) = setup(&[("mono.wav", 0.5, 16)], &["L", "R", "Sub"]);
        player.cache().insert("wide.wav", Clip::from_planar(SR, vec![vec![0.1; 16], vec![0.2; 16], vec![0.3; 16], vec![0.4; 16]]));
        player.start(0, &one("mono.wav"), Start::now(Then::End)).unwrap();
        player.start(1, &one("wide.wav"), Start::now(Then::End)).unwrap();
        let mut buf = vec![0.0f32; 4];
        mixer.render(&mut buf, 4);
        // Mono on L and R; the four-channel file on L, R, Sub and nowhere.
        for (got, want) in buf.iter().zip([0.6, 0.7, 0.3, 0.0]) {
            assert!((got - want).abs() < 1e-6, "{buf:?}");
        }
    }

    #[test]
    fn start_loop_finish() {
        let (mut mixer, mut player) = setup(&[("start.wav", 1.0, 40), ("loop.wav", 2.0, 50), ("finish.wav", 3.0, 30)], &["L"]);
        // Cue 0 chains into cue 1 (a loop whose outro is cue 2).
        player.start(1, &one("loop.wav"), Start::armed(Then::Loop)).unwrap();
        player.start(0, &one("start.wav"), Start::now(Then::Chain(1))).unwrap();
        let mut out = render(&mut mixer, 160, 1);
        assert!(out[..40].iter().all(|&s| s == 1.0));
        assert!(out[40..].iter().all(|&s| s == 2.0), "the loop starts on the sample the start ends, and keeps going");
        assert_eq!(player.status(1, None).unwrap().state, VoiceState::Playing);
        assert!(!player.is_sounding(0));

        // Go on the outro: load it armed and queue it; it comes in at the loop end.
        player.start(2, &one("finish.wav"), Start::armed(Then::End)).unwrap();
        player.queue_outro(1, 2).unwrap();
        out = render(&mut mixer, 96, 1);
        // 160 frames in, the loop (40 + n·50) next ends at 190.
        assert!(out[..30].iter().all(|&s| s == 2.0));
        assert!(out[30..60].iter().all(|&s| s == 3.0));
        assert!(out[60..].iter().all(|&s| s == 0.0));

        player.tick().unwrap();
        assert!(player.status(0, None).is_none() && player.status(1, None).is_none() && player.status(2, None).is_none());
    }

    #[test]
    fn a_queued_outro_can_be_cancelled() {
        let (mut mixer, mut player) = setup(&[("loop.wav", 2.0, 50), ("finish.wav", 3.0, 30)], &["L"]);
        player.start(0, &one("loop.wav"), Start::now(Then::Loop)).unwrap();
        player.start(1, &one("finish.wav"), Start::armed(Then::End)).unwrap();
        player.queue_outro(0, 1).unwrap();
        render(&mut mixer, 16, 1);
        player.cancel_outro(0).unwrap();
        let out = render(&mut mixer, 160, 1);
        assert!(out.iter().all(|&s| s == 2.0), "back (cancel) leaves the loop running");
        assert_eq!(player.status(1, None).unwrap().state, VoiceState::Armed);
    }

    #[test]
    fn fading_point_tail_and_transport() {
        let (mut mixer, mut player) = setup(&[("loop.wav", 2.0, 100), ("finish.wav", 1.0, 100)], &["L"]);
        let looped = CueAudio {
            parts: vec![Part { start: Some(0.010), fading_point: Some(0.050), end: Some(0.080), ..part(vec![file("loop.wav")]) }],
            looped: true,
        };
        player.start(0, &looped, Start::now(Then::Loop)).unwrap();
        player.start(1, &one("finish.wav"), Start::armed(Then::End)).unwrap();
        render(&mut mixer, 48, 1);
        let status = player.status(0, None).unwrap();
        assert_eq!((status.start, status.transition, status.end), (0.010, 0.050, 0.080));
        // 48 frames from 10: wrapped once at 50 → 10 + 8.
        assert_eq!(status.seconds, 0.018);

        player.queue_outro(0, 1).unwrap();
        let out = render(&mut mixer, 80, 1);
        // Hands off at the fading point (32 frames later); the tail 50..80 overlaps the outro.
        assert!(out[..32].iter().all(|&s| s == 2.0));
        assert!(out[32..62].iter().all(|&s| s == 3.0));
        assert!(out[62..].iter().all(|&s| s == 1.0));
    }

    #[test]
    fn multi_part_loop_and_outro() {
        let (mut mixer, mut player) = setup(&[("a.wav", 1.0, 30), ("b.wav", 2.0, 20), ("out.wav", 3.0, 10)], &["L"]);
        let seq = CueAudio { parts: vec![part(vec![file("a.wav")]), part(vec![file("b.wav")])], looped: false };
        player.start(0, &seq, Start::now(Then::Loop)).unwrap();
        let mut out = render(&mut mixer, 112, 1);
        let expected: Vec<f32> = (0..112).map(|n| if n % 50 < 30 { 1.0 } else { 2.0 }).collect();
        assert_eq!(out, expected);
        assert_eq!(player.status(0, None).unwrap().part, 0);

        player.start(1, &one("out.wav"), Start::armed(Then::End)).unwrap();
        player.queue_outro(0, 1).unwrap();
        out = render(&mut mixer, 48, 1);
        assert!(out[..18].iter().all(|&s| s == 1.0));
        assert!(out[18..28].iter().all(|&s| s == 3.0));
        assert!(out[28..].iter().all(|&s| s == 0.0));

        // Part B never played again and is discarded; then both cues are forgotten.
        player.tick().unwrap();
        render(&mut mixer, 16, 1);
        player.tick().unwrap();
        assert!(player.status(0, None).is_none() && player.status(1, None).is_none());
    }

    #[test]
    fn adjust_stop_and_resume() {
        let (mut mixer, mut player) = setup(&[("loop.wav", 1.0, 1000)], &["L"]);
        player.start(0, &one("loop.wav"), Start::now(Then::Loop)).unwrap();
        render(&mut mixer, 16, 1);
        player.fade(0, 0.25, 0.016).unwrap();
        let out = render(&mut mixer, 32, 1);
        assert!(out[0] < 1.0 && out[0] > out[8], "ramps down");
        assert!(out[16..].iter().all(|&s| s == 0.25), "and stays at the new level");

        player.stop(0, 0.008).unwrap();
        let out = render(&mut mixer, 32, 1);
        assert!(out[16..].iter().all(|&s| s == 0.0));
        assert!(!player.is_sounding(0));

        // Back: bring the loop in again where it would be by now.
        player.start(0, &one("loop.wav"), Start { resume: Some((0, 0.5)), ..Start::now(Then::Loop) }).unwrap();
        render(&mut mixer, 16, 1);
        assert_eq!(player.status(0, None).unwrap().seconds, 0.516);
    }

    #[test]
    fn a_missing_file_fails_without_touching_the_mixer() {
        let (mut mixer, mut player) = setup(&[("a.wav", 1.0, 100)], &["L"]);
        player.start(0, &one("a.wav"), Start::now(Then::Loop)).unwrap();
        let both = CueAudio { parts: vec![part(vec![file("a.wav"), file("missing.wav")])], looped: false };
        assert!(matches!(player.start(0, &both, Start::now(Then::End)), Err(Error::Io(..))));
        let out = render(&mut mixer, 32, 1);
        assert!(out.iter().all(|&s| s == 1.0), "the running audio is untouched");
    }
}
