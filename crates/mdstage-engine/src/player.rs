//! Plays the audio of cues: turns a cue's parts, files and patch into mixer voices and
//! offers the operations the show logic needs (start, queue an outro, fade, stop, resume).
//!
//! Runs on the control thread. Decoding happens here, never in the audio callback.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use mdstage_core::audio::{AudioFile, CueAudio};

use crate::clip::Clip;
use crate::clock::{EngineClock, VoiceShared, VoiceState};
use crate::mixer::{AtTransition, Command, MixerHandle, PAGE, Paged, Route, Source, VoiceId, VoiceSpec};
use crate::stream::{Info, Job, Loaded, Loader};
use crate::{Error, Result};

/// Ramp with which resumed audio comes in, in seconds.
const RESUME_RAMP: f64 = 0.012;
/// Pages kept in memory from the start of every region in reach, so that a cue, a loop's
/// next round or a handoff finds its first samples without waiting for the disk.
const PINNED: u32 = 2;
/// Pages kept from the playback position on, the current one included.
const AHEAD: u32 = 4;

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

/// A file that is read from disk as it plays.
struct Stream {
    key: u64,
    info: Info,
    pages: HashMap<u32, Arc<Clip>>,
    /// Pages asked of the loader and not back yet.
    requested: Vec<u32>,
    /// Pages the loader could not read; not asked for again.
    broken: Vec<u32>,
    starved: Arc<AtomicBool>,
}

enum Entry {
    /// Held in memory as a whole (put there with `ClipCache::insert`).
    Whole(Arc<Clip>),
    Stream(Stream),
    /// The loader is opening the file.
    Opening,
    Failed,
}

/// The audio files of the open show, at the output device's sample rate. Files are read
/// from disk a page at a time by a loader thread; only the pages around the places the
/// show is at, or could be at next, are in memory.
pub struct ClipCache {
    dir: PathBuf,
    sample_rate: u32,
    entries: HashMap<String, Entry>,
    loader: Option<Loader>,
    next_key: u64,
    /// `(file, frame)`: where cues in reach of the operator begin.
    window: Vec<(String, usize)>,
    /// Page commands on their way to the mixer.
    outbox: VecDeque<Command>,
    problems: Vec<String>,
}

impl ClipCache {
    /// `dir` is the show's `audio/` folder.
    pub fn new(dir: PathBuf, sample_rate: u32) -> ClipCache {
        ClipCache { dir, sample_rate, entries: HashMap::new(), loader: None, next_key: 1, window: Vec::new(), outbox: VecDeque::new(), problems: Vec::new() }
    }

    /// Put an already decoded clip into the cache under a file name.
    pub fn insert(&mut self, file: &str, clip: Clip) {
        self.entries.insert(file.to_string(), Entry::Whole(Arc::new(clip)));
    }

    /// Whether a file is ready to play.
    pub fn contains(&self, file: &str) -> bool {
        matches!(self.entries.get(file), Some(Entry::Whole(_) | Entry::Stream(_)))
    }

    fn loader(&mut self) -> Result<&Loader> {
        if self.loader.is_none() {
            let loader = Loader::spawn(self.dir.clone(), self.sample_rate).map_err(|e| Error::Io("audio loader".into(), e))?;
            self.loader = Some(loader);
        }
        Ok(self.loader.as_ref().unwrap())
    }

    fn stream(&mut self, file: &str, info: Info) {
        let stream = Stream { key: self.next_key, info, pages: HashMap::new(), requested: Vec::new(), broken: Vec::new(), starved: Arc::default() };
        self.next_key += 1;
        self.entries.insert(file.to_string(), Entry::Stream(stream));
    }

    /// Take in something the loader has finished.
    fn accept(&mut self, message: Loaded) {
        match message {
            Loaded::Opened { file, info } => match (self.entries.get(&file), info) {
                (Some(Entry::Opening), Ok(info)) => self.stream(&file, info),
                (Some(Entry::Opening), Err(e)) => {
                    self.problems.push(e.to_string());
                    self.entries.insert(file, Entry::Failed);
                }
                // Not wanted any more by the time it was open.
                (None, Ok(_)) => {
                    if let Some(loader) = &self.loader {
                        loader.send(Job::Close { file });
                    }
                }
                _ => {}
            },
            Loaded::Page { file, index, clip } => {
                let Some(Entry::Stream(stream)) = self.entries.get_mut(&file) else { return };
                stream.requested.retain(|i| *i != index);
                match clip {
                    Ok(clip) => {
                        let page = Arc::new(clip);
                        stream.pages.insert(index, page.clone());
                        self.outbox.push_back(Command::Page { key: stream.key, index, page: Some(page) });
                    }
                    Err(e) => {
                        stream.broken.push(index);
                        self.problems.push(e.to_string());
                    }
                }
            }
        }
    }

    /// Block until the loader has finished the job `wanted` describes, taking in whatever
    /// else it delivers on the way.
    fn wait_for(&mut self, wanted: impl Fn(&Loaded) -> bool) -> Result<Loaded> {
        loop {
            let message = self.loader()?.done.recv().map_err(|_| Error::Decode("audio".into(), "the loader thread stopped".into()))?;
            if wanted(&message) {
                return Ok(message);
            }
            self.accept(message);
        }
    }

    /// Length and channel count of a file, opening it now if that has not happened yet.
    fn info(&mut self, file: &str) -> Result<Info> {
        match self.entries.get(file) {
            Some(Entry::Whole(clip)) => return Ok(Info { sample_rate: self.sample_rate, channels: clip.channel_count(), frames: clip.frames() }),
            Some(Entry::Stream(stream)) => return Ok(stream.info),
            _ => {}
        }
        self.loader()?.send(Job::Open { file: file.to_string(), urgent: true });
        self.entries.insert(file.to_string(), Entry::Opening);
        match self.wait_for(|m| matches!(m, Loaded::Opened { file: opened, .. } if opened == file))? {
            Loaded::Opened { info: Ok(info), .. } => {
                self.stream(file, info);
                Ok(info)
            }
            Loaded::Opened { info: Err(e), .. } => {
                self.entries.remove(file);
                Err(e)
            }
            Loaded::Page { .. } => unreachable!(),
        }
    }

    /// Make sure the pages a voice starting at `frame` needs first are in memory, reading
    /// them now if they are not.
    fn ensure(&mut self, file: &str, frame: usize) -> Result<()> {
        let Some(Entry::Stream(stream)) = self.entries.get(file) else { return Ok(()) };
        let first = (frame / PAGE) as u32;
        let missing: Vec<u32> = (first..first + PINNED).filter(|i| (*i as usize) < stream.info.pages() && !stream.pages.contains_key(i)).collect();
        for index in missing {
            self.loader()?.send(Job::Page { file: file.to_string(), index, urgent: true });
            match self.wait_for(|m| matches!(m, Loaded::Page { file: read, index: i, .. } if read == file && *i == index))? {
                Loaded::Page { clip: Err(e), .. } => return Err(e),
                page => self.accept(page),
            }
        }
        Ok(())
    }

    /// What a voice playing `file` reads from.
    fn source(&self, file: &str) -> Option<Source> {
        match self.entries.get(file)? {
            Entry::Whole(clip) => Some(Source::Whole(clip.clone())),
            Entry::Stream(stream) => {
                let mut pages = vec![None; stream.info.pages()];
                for (index, page) in &stream.pages {
                    pages[*index as usize] = Some(page.clone());
                }
                Some(Source::Paged(Paged { key: stream.key, frames: stream.info.frames, channels: stream.info.channels, pages, starved: stream.starved.clone() }))
            }
            Entry::Opening | Entry::Failed => None,
        }
    }

    /// Tell the cache which audio the operator could reach next: `(file, seconds)` for
    /// every place a cue in reach begins. Those files are opened in the background and
    /// their first pages kept ready; files out of reach and not playing are let go.
    pub fn set_window(&mut self, starts: Vec<(String, f64)>) {
        let rate = self.sample_rate as f64;
        self.window = starts.into_iter().map(|(file, seconds)| (file, (seconds.max(0.0) * rate).round() as usize)).collect();
        let unknown: Vec<String> = self.window.iter().map(|(file, _)| file).filter(|file| !self.entries.contains_key(*file)).cloned().collect();
        for file in unknown {
            match self.loader() {
                Ok(loader) => loader.send(Job::Open { file: file.clone(), urgent: false }),
                Err(e) => {
                    self.problems.push(e.to_string());
                    return;
                }
            }
            self.entries.insert(file, Entry::Opening);
        }
    }

    /// Keep the right pages in memory. `voices` are the voices alive in the mixer:
    /// `(file, region start, position)`, in frames.
    fn service(&mut self, voices: &[(&str, usize, usize)]) {
        while let Some(message) = self.loader.as_ref().and_then(|loader| loader.done.try_recv().ok()) {
            self.accept(message);
        }

        let mut wanted: Vec<(&str, u32)> = Vec::new();
        let mut want = |file, frame: usize, pages: u32| {
            let first = (frame / PAGE) as u32;
            wanted.extend((first..first + pages).map(|index| (file, index)));
        };
        for (file, start) in &self.window {
            want(file.as_str(), *start, PINNED);
        }
        for &(file, start, position) in voices {
            want(file, start, PINNED);
            want(file, position, AHEAD);
        }

        for (file, entry) in &mut self.entries {
            let Entry::Stream(stream) = entry else { continue };
            let mine = || wanted.iter().filter(|(f, _)| *f == file.as_str()).map(|(_, index)| *index);
            for index in mine() {
                let known = stream.pages.contains_key(&index) || stream.requested.contains(&index) || stream.broken.contains(&index);
                if !known && (index as usize) < stream.info.pages() {
                    if let Some(loader) = &self.loader {
                        loader.send(Job::Page { file: file.clone(), index, urgent: false });
                        stream.requested.push(index);
                    }
                }
            }
            let stale: Vec<u32> = stream.pages.keys().copied().filter(|index| !mine().any(|w| w == *index)).collect();
            for index in stale {
                stream.pages.remove(&index);
                self.outbox.push_back(Command::Page { key: stream.key, index, page: None });
            }
            if stream.starved.swap(false, Ordering::Relaxed) {
                self.problems.push(format!("Audio: {file} wurde nicht schnell genug von der Platte gelesen (Aussetzer)"));
            }
        }

        // Let go of files nobody can reach any more.
        let (window, loader) = (&self.window, &self.loader);
        self.entries.retain(|file, entry| {
            let needed = matches!(entry, Entry::Whole(_)) || window.iter().any(|(f, _)| f == file) || voices.iter().any(|(f, _, _)| f == file);
            if let Some(loader) = loader.as_ref().filter(|_| !needed) {
                loader.send(Job::Close { file: file.clone() });
            }
            needed
        });
    }

    /// Seconds of audio held in memory, summed over all files and their channels.
    pub fn held_seconds(&self) -> f64 {
        let frames: usize = self
            .entries
            .values()
            .map(|entry| match entry {
                Entry::Whole(clip) => clip.frames() * clip.channel_count(),
                Entry::Stream(stream) => stream.pages.values().map(|page| page.frames() * page.channel_count()).sum(),
                Entry::Opening | Entry::Failed => 0,
            })
            .sum();
        frames as f64 / self.sample_rate as f64
    }

    /// How many files are being opened and pages being read right now.
    pub fn loading(&self) -> usize {
        self.entries
            .values()
            .map(|entry| match entry {
                Entry::Opening => 1,
                Entry::Stream(stream) => stream.requested.len(),
                Entry::Whole(_) | Entry::Failed => 0,
            })
            .sum()
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
    /// The files of the part and, for each, where its voice is.
    files: Vec<String>,
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
    /// Voices of cues that were stopped and are still fading out: `(file, region start, voice)`.
    fading: Vec<(String, usize, Arc<VoiceShared>)>,
}

impl Player {
    pub fn new(handle: MixerHandle, cache: ClipCache, routing: Routing) -> Player {
        let sample_rate = cache.sample_rate;
        Player { handle, cache, routing, sample_rate, active: HashMap::new(), fading: Vec::new() }
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
    fn routes(&self, audio: &AudioFile, channels: usize) -> Vec<Route> {
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

    /// Send the page commands that are waiting, as far as the mixer takes them.
    fn flush(&mut self) {
        while let Some(command) = self.cache.outbox.pop_front() {
            if let Err(command) = self.handle.send(command) {
                self.cache.outbox.push_front(command);
                break;
            }
        }
    }

    /// Load a cue's audio into the mixer, playing or armed. Audio of the same cue that is
    /// still running is cut off with a short fade.
    pub fn start(&mut self, cue: usize, audio: &CueAudio, start: Start) -> Result<()> {
        // Open everything first, so a missing file leaves the mixer untouched.
        let count = audio.parts.len();
        let (resume_part, resume_at) = start.resume.map_or((0, None), |(p, s)| (p.min(count - 1), Some(s)));
        let mut regions = Vec::with_capacity(count);
        for (index, part) in audio.parts.iter().enumerate() {
            let infos: Result<Vec<Info>> = part.audios.iter().map(|a| self.cache.info(&a.file)).collect();
            let infos = infos?;
            let longest = infos.iter().map(|i| i.frames).max().unwrap_or(0);
            let end = part.end.map_or(longest, |s| self.frames(s));
            let region_start = part.start.map_or(0, |s| self.frames(s)).min(end);
            let transition = part.fading_point.map_or(end, |s| self.frames(s)).clamp(region_start, end);
            let initial = resume_at.filter(|_| index == resume_part).map(|s| self.frames(s));
            for file in &part.audios {
                self.cache.ensure(&file.file, region_start)?;
                if let Some(initial) = initial {
                    self.cache.ensure(&file.file, initial.clamp(region_start, end))?;
                }
            }
            regions.push((region_start, transition, end, initial, infos));
        }
        if self.active.contains_key(&cue) {
            self.stop(cue, 0.005)?;
        }
        self.flush();

        let mut active = ActiveCue { parts: Vec::with_capacity(count), then: start.then, outro_queued: false };
        for (index, (part, (region_start, transition, end, initial, infos))) in audio.parts.iter().zip(regions).enumerate() {
            let id = voice_id(cue, index);
            let (at_transition, rearm) = match start.then {
                _ if count > 1 => (AtTransition::Handoff(voice_id(cue, (index + 1) % count)), true),
                Then::Loop => (AtTransition::Wrap, false),
                Then::Chain(next) => (AtTransition::Handoff(voice_id(next, 0)), false),
                Then::End => (AtTransition::Continue, false),
            };
            let mut shared = Vec::with_capacity(infos.len());
            let mut files = Vec::with_capacity(infos.len());
            for (file, info) in part.audios.iter().zip(&infos) {
                let Some(source) = self.cache.source(&file.file) else { continue };
                let spec = VoiceSpec {
                    start: region_start,
                    transition,
                    end,
                    initial,
                    at_transition,
                    gain: if resume_at.is_some() { 0.0 } else { part.volume as f32 },
                    fade_in: part.fadein.map_or(0, |s| self.frames(s) as u32),
                    fade_out: part.fadeout.map_or(0, |s| self.frames(s) as u32),
                    routes: self.routes(file, info.channels),
                    armed: start.armed || index != resume_part,
                    rearm,
                    ..VoiceSpec::of(id, source)
                };
                // Until the mixer reports for itself: where the voice is going to begin,
                // so that the pages there are not taken for unneeded. A voice that starts
                // right away counts as playing from this moment, not only once the audio
                // device has asked for its next block — whoever looks in between would
                // otherwise take the cue for silent and give up on what hangs on it.
                let state = if spec.armed { VoiceState::Armed } else { VoiceState::Playing };
                // The engine frame is "never": until the mixer has reported, the position
                // stands still instead of being reckoned on from the engine's start.
                spec.shared.publish(u64::MAX, initial.unwrap_or(region_start).clamp(region_start, end) as u64, state);
                shared.push(spec.shared.clone());
                files.push(file.file.clone());
                self.send(Command::Add(spec))?;
            }
            if resume_at.is_some() {
                // Resumed audio comes in mid-waveform: a short ramp instead of a click.
                let frames = self.frames(RESUME_RAMP) as u32;
                self.send(Command::Fade { id, target: part.volume as f32, frames, then_stop: false })?;
            }
            active.parts.push(ActivePart { id, files, shared, start: region_start, transition, end });
        }
        self.active.insert(cue, active);
        Ok(())
    }

    /// The stretch each part of `audio` cycles through, in seconds: `(start, transition)`.
    /// Opens the files if necessary (their length is the default end).
    pub fn spans(&mut self, audio: &CueAudio) -> Result<Vec<(f64, f64)>> {
        let mut spans = Vec::with_capacity(audio.parts.len());
        for part in &audio.parts {
            let mut longest = 0.0f64;
            for file in &part.audios {
                longest = longest.max(self.cache.info(&file.file)?.frames as f64 / self.sample_rate as f64);
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

    /// Play a short tone on one physical output (0-based), to check the wiring.
    pub fn test_tone(&mut self, output: usize) -> Result<()> {
        let rate = self.sample_rate as f32;
        let tone: Vec<f32> = (0..(rate * 0.7) as usize).map(|n| (std::f32::consts::TAU * 440.0 * n as f32 / rate).sin() * 0.25).collect();
        let fade = (rate / 40.0) as u32;
        let spec = VoiceSpec {
            routes: vec![Route { src: 0, out: output as u16, gain: 1.0 }],
            fade_in: fade,
            fade_out: fade,
            ..VoiceSpec::whole(VoiceId::MAX, Arc::new(Clip::from_planar(self.sample_rate, vec![tone])))
        };
        self.send(Command::Add(spec))
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
        if let Some(active) = self.active.remove(&cue) {
            self.let_fade(active);
        }
        Ok(())
    }

    /// Keep an eye on the voices of a cue that is over until they have faded out (their
    /// audio has to stay in memory that long).
    fn let_fade(&mut self, cue: ActiveCue) {
        for part in cue.parts {
            let start = part.start;
            self.fading.extend(part.files.into_iter().zip(part.shared).map(|(file, shared)| (file, start, shared)));
        }
    }

    /// Fade everything out over `seconds` (the emergency "Music Stop").
    pub fn stop_all(&mut self, seconds: f64) -> Result<()> {
        let frames = self.frames(seconds) as u32;
        let cues: Vec<ActiveCue> = self.active.drain().map(|(_, cue)| cue).collect();
        for cue in cues {
            self.let_fade(cue);
        }
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

    /// Where a cue's audio is, part by part: the audible part first (as `status` gives
    /// it), then every other part that is ringing out at the same time.
    pub fn statuses(&self, cue: usize, clock: Option<&EngineClock>) -> Vec<Status> {
        let Some(first) = self.status(cue, clock) else { return Vec::new() };
        let mut all = vec![first];
        let Some(active) = self.active.get(&cue) else { return all };
        for (index, part) in active.parts.iter().enumerate() {
            let Some(voice) = part.shared.first() else { continue };
            let mut ringing = |frames: f64| all.push(Status { state: VoiceState::Tail, part: index, seconds: frames / self.sample_rate as f64, start: self.seconds(part.start), transition: self.seconds(part.transition), end: self.seconds(part.end) });
            // A part that has handed over and rings out beside the one playing …
            if index != first.part && voice.state() == VoiceState::Tail {
                ringing(clock.map_or(voice.clip_frame() as f64, |c| voice.clip_frame_now(c)));
            }
            // … and the tail of a loop's previous pass, ringing out over the new one.
            if let Some(frame) = voice.echo() {
                ringing(frame as f64);
            }
        }
        all
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

    /// Take what went wrong while reading audio since the last call.
    pub fn take_problems(&mut self) -> Vec<String> {
        std::mem::take(&mut self.cache.problems)
    }

    /// Housekeeping; call regularly. Frees finished voices, forgets cues that are over
    /// and keeps the audio around every playing position in memory.
    pub fn tick(&mut self) -> Result<()> {
        self.handle.collect_garbage();
        self.fading.retain(|(_, _, shared)| shared.state() != VoiceState::Done);
        let mut voices: Vec<(&str, usize, usize)> = self.fading.iter().map(|(file, start, shared)| (file.as_str(), *start, shared.clip_frame() as usize)).collect();
        for part in self.active.values().flat_map(|a| &a.parts) {
            for (file, shared) in part.files.iter().zip(&part.shared) {
                if shared.state() != VoiceState::Done {
                    voices.push((file, part.start, shared.clip_frame() as usize));
                    // The tail has to be at hand as well: it rings out from the loop
                    // point while the playback position is back at the start.
                    for at in (part.transition..part.end).step_by(PAGE * AHEAD as usize) {
                        voices.push((file, at, at));
                    }
                }
            }
        }
        self.cache.service(&voices);
        self.flush();
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
        let out = render(&mut mixer, 48, 1);
        let status = player.status(0, None).unwrap();
        assert_eq!((status.start, status.transition, status.end), (0.010, 0.050, 0.080));
        // 48 frames from 10: wrapped once at 50 → 10 + 8.
        assert_eq!(status.seconds, 0.018);
        // Since the wrap (after 40 frames) the tail of the first pass rings out as well,
        // and is reported as such beside the pass that plays.
        assert!(out[..40].iter().all(|&s| s == 2.0) && out[40..].iter().all(|&s| s == 4.0), "{out:?}");
        let ringing: Vec<(VoiceState, f64)> = player.statuses(0, None).into_iter().map(|s| (s.state, s.seconds)).collect();
        assert_eq!(ringing, [(VoiceState::Playing, 0.018), (VoiceState::Tail, 0.058)]);

        player.queue_outro(0, 1).unwrap();
        let out = render(&mut mixer, 80, 1);
        // The first pass's tail lasts 22 frames more. The loop hands off at its fading
        // point (32 frames on); its own tail 50..80 then overlaps the outro.
        assert!(out[..22].iter().all(|&s| s == 4.0));
        assert!(out[22..32].iter().all(|&s| s == 2.0));
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
    fn streamed_files_play_exactly_like_files_held_in_memory() {
        let rate = 48_000;
        let dir = std::env::temp_dir().join(format!("mdstage-player-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::stream::write_wav(&dir.join("loop.wav"), rate, 2, 4 * PAGE + 500);
        crate::stream::write_wav(&dir.join("out.wav"), rate, 1, PAGE + 77);

        let run = |streamed: bool| -> Vec<f32> {
            let (mut mixer, handle) = Mixer::new();
            let mut cache = ClipCache::new(dir.clone(), rate);
            if !streamed {
                for name in ["loop.wav", "out.wav"] {
                    cache.insert(name, Clip::decode_file(&dir.join(name)).unwrap());
                }
            }
            let mut player = Player::new(handle, cache, Routing::positional(&["L".to_string(), "R".to_string()]));
            let looped = CueAudio { parts: vec![Part { start: Some(0.2), fading_point: Some(4.9), ..part(vec![file("loop.wav")]) }], looped: true };
            player.start(0, &looped, Start::now(Then::Loop)).unwrap();
            let mut out = Vec::new();
            let mut buf = vec![0.0f32; 2 * 1024];
            for block in 0..640 {
                match block {
                    // Two rounds of the loop, then its outro; later the loop is resumed mid-way.
                    450 => {
                        player.start(1, &one("out.wav"), Start::armed(Then::End)).unwrap();
                        player.queue_outro(0, 1).unwrap();
                    }
                    560 => player.start(0, &looped, Start { resume: Some((0, 3.0)), ..Start::now(Then::Loop) }).unwrap(),
                    _ => {}
                }
                // Rendering by hand outruns the disk; let the loader catch up first.
                loop {
                    player.tick().unwrap();
                    if player.cache().loading() == 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_micros(200));
                }
                player.tick().unwrap();
                mixer.render(&mut buf, 2);
                out.extend_from_slice(&buf);
            }
            assert_eq!(player.take_problems(), Vec::<String>::new());
            out
        };
        let (streamed, whole) = (run(true), run(false));
        assert!(whole.iter().any(|s| *s != 0.0));
        if let Some(n) = (0..whole.len()).find(|&n| streamed[n] != whole[n]) {
            panic!("sample {n} (frame {}): streamed {}, in memory {}", n / 2, streamed[n], whole[n]);
        }
    }

    #[test]
    fn the_test_tone_comes_out_of_the_output_asked_for() {
        let (mut mixer, mut player) = setup(&[], &["L", "R"]);
        player.test_tone(2).unwrap();
        let mut buf = vec![0.0f32; 4 * 64];
        mixer.render(&mut buf, 4);
        mixer.render(&mut buf, 4);
        for frame in buf.chunks(4) {
            assert_eq!((frame[0], frame[1], frame[3]), (0.0, 0.0, 0.0));
        }
        assert!(buf.chunks(4).any(|frame| frame[2].abs() > 0.05));
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
