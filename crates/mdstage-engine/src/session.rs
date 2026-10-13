//! A running show: one thread that owns the audio device, the show logic, the outputs,
//! the display server and the remote inputs, and keeps them moving.
//!
//! The UI talks to it with `Request`s and reads a `Snapshot`; it never waits on audio.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use mdstage_core::Script;
use mdstage_core::cues::Note;
use mdstage_core::effects::Effect;
use mdstage_core::mic::{Cast, Mic};

use crate::clock::{ClockDriver, EngineClock};
use crate::device;
use crate::display::{Client, DisplayServer};
use crate::inputs::{Input, Inputs};
use crate::mixer::Mixer;
use crate::mtc::MtcSender;
use crate::outputs::{MidiPorts, Sender as WireSender, SystemMidi};
use crate::player::{ClipCache, Player, Status};
use crate::settings::Settings;
use crate::show::{DelayProgress, Show};

/// How often the show logic runs.
const TICK: Duration = Duration::from_millis(2);
/// How many cues with audio are kept decoded ahead of the operator's position.
const AHEAD: usize = 6;
/// Sample rate of a session that has neither a device nor audio files to take one from.
const FALLBACK_RATE: u32 = 48_000;
const MAX_CHANNELS: usize = 64;
/// How often a missing audio device is looked for.
const DEVICE_RETRY: Duration = Duration::from_secs(3);
/// How often to look whether a MIDI device was plugged in or pulled out.
const MIDI_RESCAN: Duration = Duration::from_secs(2);
/// Holding the Back note this long stops everything (as the red music button does)
/// instead of going back; let go of sooner, it is a Back.
const BACK_HOLD: Duration = Duration::from_millis(1000);
/// A device whose clock has not moved for this long counts as gone.
const DEVICE_STALL: Duration = Duration::from_secs(2);
/// What problems with the audio device start with (they are withdrawn when it is back).
const NO_DEVICE: &str = "Audiogerät: ";
const MAX_PROBLEMS: usize = 20;

pub enum Request {
    Go,
    Back,
    /// Fire a cue directly (a click on it).
    Fire(usize),
    Arm(Option<usize>),
    SelectVariant(Option<usize>),
    /// The transport on a cue's waveform: play the cue's audio by itself, or pause it.
    PlayPause(usize),
    /// Move a cue's audio to a place in its file (seconds).
    Seek(usize, f64),
    /// Stop a cue's audio, fading it out over so many seconds, and put it back to its start.
    StopCue(usize, f64),
    /// Set the level of a cue's audio while it plays.
    Volume(usize, f64),
    /// Play a short tone on a physical output (0-based).
    TestTone(usize),
    /// Emergency: fade all audio out.
    StopAll,
    /// Emergency: mute all microphones.
    MicsOff,
    /// New machine settings, and whether the show file is trusted. A changed audio
    /// device is switched to on the spot if it can run at the session's sample rate.
    Configure(Box<Settings>, bool),
    ClearProblems,
    /// The show file was edited.
    SetScript(Box<Script>),
    /// Switch the emergency light on or off.
    EmergencyLight(bool),
}

/// The audio output in use.
#[derive(Clone, Debug, PartialEq)]
pub struct OutputInfo {
    pub name: String,
    pub sample_rate: u32,
    pub channels: usize,
}

/// What the UI shows about the running show. Cues are numbered from 0.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub fired: Vec<usize>,
    /// The cues fired in the current pass through the script (since the last jump back).
    pub done: Vec<usize>,
    /// The cue that fired last, by the operator or by itself.
    pub latest: Option<usize>,
    /// Microphones an auto-mic cue is leaving on a little longer before they go off.
    pub mic_hold: Option<crate::show::MicHold>,
    pub current: Option<usize>,
    pub next: Option<usize>,
    /// The variant chosen for the next Go, if the operator chose one.
    pub selected_variant: Option<usize>,
    /// `(loop, outro)` pairs waiting for the loop's end.
    pub pending_outros: Vec<(usize, usize)>,
    /// The microphones as the fired cues left them; `None` before any cue set them.
    pub mic: Option<Mic>,
    pub audio: Vec<(usize, Status)>,
    /// Where paused audio stands: `(cue, seconds into its file)`.
    pub paused: Vec<(usize, f64)>,
    pub timecode: Option<f64>,
    pub delays: Vec<DelayProgress>,
    /// The cues waiting to fire by themselves, with how far their wait has got.
    pub waits: Vec<crate::show::Wait>,
    /// Go is held back while a cue is on its way by itself.
    pub go_blocked: bool,
    /// Go is held back until the operator has chosen one of the next cue's variants.
    pub needs_variant: bool,
    pub display_clients: Vec<Client>,
    pub display_address: Option<SocketAddr>,
    /// `None` if no audio device could be opened (the show still runs, silently).
    pub output: Option<OutputInfo>,
    pub problems: Vec<String>,
    /// The last MIDI note that came in, for "MIDI learn".
    pub heard: Option<Note>,
    /// How many audio files are being opened and stretches read in the background right now.
    pub loading: Option<usize>,
    /// Audio held in memory, in megabytes.
    pub audio_memory_mb: f32,
    pub emergency_light: bool,
    /// When each cue last fired (this session only).
    pub fired_at: Vec<(usize, std::time::SystemTime)>,
}

pub struct Session {
    requests: Sender<Request>,
    snapshot: Arc<Mutex<Snapshot>>,
    thread: Option<JoinHandle<()>>,
}

impl Session {
    /// Open the devices and start running `script`. `show_dir` is the folder of the
    /// show file (audio is in its `audio/`, custom display styles in its `css/`).
    pub fn start(script: Script, show_dir: PathBuf, settings: Settings, trusted: bool) -> std::io::Result<Session> {
        let (requests, incoming) = channel();
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        let shared = snapshot.clone();
        let thread = thread::Builder::new()
            .name("mdstage-show".into())
            .spawn(move || run(script, show_dir, settings, trusted, incoming, shared))?;
        Ok(Session { requests, snapshot, thread: Some(thread) })
    }

    pub fn send(&self, request: Request) {
        let _ = self.requests.send(request);
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Closing the channel ends the thread; it fades the audio out on its way.
        let (closed, _) = channel();
        self.requests = closed;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Where the audio of the cues numbered `cues` (0-based, in script order) begins:
/// `(file, seconds)`, without repeats. Cues that chain or hand off to others bring those
/// along, so a transition never waits.
fn audio_starts(script: &Script, cues: std::ops::Range<usize>) -> Vec<(String, f64)> {
    let all = mdstage_core::cues::Cues::new(script);
    let mut starts: Vec<(String, f64)> = Vec::new();
    let mut add = |cue: usize| {
        for part in all.get(cue).and_then(|c| c.audio()).into_iter().flat_map(|a| a.parts) {
            let start = part.start.unwrap_or(0.0);
            for audio in part.audios {
                if !starts.iter().any(|(file, at)| *file == audio.file && *at == start) {
                    starts.push((audio.file, start));
                }
            }
        }
    };
    for cue in cues.start.min(all.len())..cues.end.min(all.len()) {
        add(cue);
        let links = all.get(cue).map(|c| [c.chain_end(), c.loop_outro()]).unwrap_or_default();
        for target in links.into_iter().flatten().filter_map(|note| all.find(note)) {
            add(target);
        }
    }
    starts
}

/// Renders the mixer into nothing, in real time, while no device does — so that
/// transitions, timed cues and the clock carry on, and audio is in the right place when
/// a device (re)appears.
struct Pump {
    driver: ClockDriver,
    rendered: Instant,
    scratch: Vec<f32>,
}

impl Pump {
    fn run(&mut self, mixer: &Mutex<Mixer>, sample_rate: u32) {
        let block = self.scratch.len() / 2;
        let due = (self.rendered.elapsed().as_secs_f64() * sample_rate as f64) as usize / block;
        if due == 0 {
            return;
        }
        let Ok(mut mixer) = mixer.lock() else { return };
        for _ in 0..due {
            mixer.render(&mut self.scratch, 2);
            self.rendered += Duration::from_secs_f64(block as f64 / sample_rate as f64);
        }
        self.driver.publish(mixer.frames());
    }

    /// Take over from a device that has just gone.
    fn take_over(&mut self) {
        self.rendered = Instant::now();
        self.driver.reset();
    }
}

fn run(script: Script, show_dir: PathBuf, mut settings: Settings, mut trusted: bool, requests: Receiver<Request>, snapshot: Arc<Mutex<Snapshot>>) {
    let mut problems: Vec<String> = Vec::new();
    let report = |problems: &mut Vec<String>, problem: String| {
        if !problems.contains(&problem) && problems.len() < MAX_PROBLEMS {
            problems.push(problem);
        }
    };

    // Run the device at the rate most of the show's audio has, if it can.
    let mut rates: Vec<(u32, usize)> = Vec::new();
    for (file, _) in audio_starts(&script, 0..usize::MAX) {
        if let Some(rate) = crate::clip::Clip::probe_rate(&show_dir.join("audio").join(&file)) {
            match rates.iter_mut().find(|(r, _)| *r == rate) {
                Some(entry) => entry.1 += 1,
                None => rates.push((rate, 1)),
            }
        }
    }
    let preferred_rate = rates.iter().max_by_key(|(_, count)| *count).map(|(rate, _)| *rate);

    // The mixer is shared with the device's callback; while there is no device, this
    // thread renders it instead (see `Pump`).
    let (mixer, handle) = Mixer::new();
    let mixer = Arc::new(Mutex::new(mixer.limited()));
    let mut device = match device::open(mixer.clone(), settings.audio_device.as_deref(), MAX_CHANNELS, preferred_rate, None) {
        Ok(out) => Some(out),
        Err(e) => {
            report(&mut problems, format!("{NO_DEVICE}{e}"));
            None
        }
    };
    let sample_rate = device.as_ref().map_or(preferred_rate.unwrap_or(FALLBACK_RATE), |out| out.sample_rate);
    let clock = device.as_ref().map_or_else(|| Arc::new(EngineClock::new(sample_rate)), |out| out.clock.clone());
    let info = |out: &device::Output| OutputInfo { name: out.device_name.clone(), sample_rate: out.sample_rate, channels: out.channels };
    let mut output = device.as_ref().map(info);
    let mut pump = Pump { driver: ClockDriver::new(clock.clone()), rendered: Instant::now(), scratch: vec![0.0; 2 * (sample_rate as usize / 100)] };
    let mut retry_device = Instant::now() + DEVICE_RETRY;
    // When the device's clock last moved, and where it stood.
    let mut alive = (Instant::now(), 0u64);

    let mut cast = Cast::from_script(&script, settings.language == "en");
    let player = Player::new(handle, ClipCache::new(show_dir.join("audio"), sample_rate), settings.routing(&script.virtual_channels()));
    let mut show = Show::new(script, player, Some(clock.clone()), settings.language == "en");
    show.set_mic_off_delay(settings.mic_off_delay);

    let wires = match WireSender::new(SystemMidi::default()) {
        Ok(sender) => Some(sender),
        Err(e) => {
            report(&mut problems, format!("Ausgänge: {e}"));
            None
        }
    };
    let mut outputs = settings.outputs(trusted);

    let display = match DisplayServer::start(&settings.display_host, settings.display_port) {
        Ok(server) => {
            server.set_css_dir(Some(show_dir.join("css")));
            server.set_app_language(&settings.language);
            server.set_devices(&settings.displays());
            Some(server)
        }
        Err(e) => {
            report(&mut problems, format!("Display-Server ({}:{}): {e}", settings.display_host, settings.display_port));
            None
        }
    };

    let (input_events, inputs_incoming) = channel();
    let open_inputs = |settings: &Settings, problems: &mut Vec<String>| match Inputs::open(&settings.inputs(), input_events.clone()) {
        Ok(inputs) => Some(inputs),
        Err(e) => {
            if !problems.iter().any(|p| p.starts_with("Fernsteuerung")) {
                problems.push(format!("Fernsteuerung: {e}"));
            }
            None
        }
    };
    let mut inputs = open_inputs(&settings, &mut problems);
    let mut rescan_midi = Instant::now() + MIDI_RESCAN;
    let mut back_held: Option<Instant> = None;

    // Timecode: the show publishes its position with a timestamp; the MTC thread
    // extrapolates from there, so its pacing does not depend on this loop's.
    let feed: Arc<Mutex<Option<(f64, Instant)>>> = Arc::default();
    let timecode_ports = Arc::new(Mutex::new(settings.timecode_ports()));
    let mtc = {
        let (feed, ports) = (feed.clone(), timecode_ports.clone());
        let mut midi = SystemMidi::default();
        MtcSender::spawn(
            move || feed.lock().unwrap().map(|(seconds, at)| seconds + at.elapsed().as_secs_f64()),
            move |bytes| {
                for port in ports.lock().unwrap().iter() {
                    midi.send(port, bytes);
                }
            },
        )
    };
    if let Err(e) = &mtc {
        report(&mut problems, format!("Timecode: {e}"));
    }

    let mut window_for: Option<(Option<usize>, Option<usize>, usize)> = None;

    let started = Instant::now();
    let mut heard = None;
    let mut emergency_light = false;
    let mut fired_at: Vec<(usize, std::time::SystemTime)> = Vec::new();
    let mut fired_count = 0;
    'show: loop {
        let tick_started = Instant::now();
        loop {
            let request = match requests.try_recv() {
                Ok(request) => request,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'show,
            };
            let result = match request {
                Request::Go => show.go(),
                Request::Back => show.back(),
                Request::Fire(cue) => show.fire(cue, false),
                Request::Arm(cue) => Ok(show.arm(cue)),
                Request::SelectVariant(cue) => Ok(show.select_variant(cue)),
                Request::PlayPause(cue) => show.play_pause(cue),
                Request::Seek(cue, seconds) => show.seek(cue, seconds),
                Request::StopCue(cue, fade) => show.stop_cue(cue, fade),
                Request::Volume(cue, volume) => show.set_volume(cue, volume),
                Request::TestTone(output) => show.player().test_tone(output),
                Request::StopAll => show.stop_all(),
                Request::MicsOff => Ok(show.mics_off()),
                Request::ClearProblems => Ok(problems.clear()),
                Request::EmergencyLight(on) => {
                    emergency_light = on;
                    if let (Some(wires), Some(effect)) = (&wires, settings.emergency_light(on)) {
                        wires.send(outputs.wire(&[effect], &cast));
                    }
                    Ok(())
                }
                Request::SetScript(script) => {
                    cast = Cast::from_script(&script, settings.language == "en");
                    // The cues may have new numbers: the times they fired at follow them.
                    let map = mdstage_core::cues::mapping(show.script(), &script);
                    fired_at = fired_at.iter().filter_map(|&(cue, at)| Some((map.get(cue).copied().flatten()?, at))).collect();
                    let result = show.replace_script(*script);
                    fired_count = show.history().cues().count();
                    result
                }
                Request::Configure(new, now_trusted) => {
                    if new.audio_device != settings.audio_device {
                        // Let go of the old device; the new one is opened further down.
                        device = None;
                        output = None;
                        pump.take_over();
                        retry_device = Instant::now();
                    }
                    settings = *new;
                    trusted = now_trusted;
                    outputs = settings.outputs(trusted);
                    *timecode_ports.lock().unwrap() = settings.timecode_ports();
                    let channels = show.script().virtual_channels();
                    show.player().set_routing(settings.routing(&channels));
                    show.set_mic_off_delay(settings.mic_off_delay);
                    if let Some(display) = &display {
                        display.set_app_language(&settings.language);
                        display.set_devices(&settings.displays());
                    }
                    drop(inputs.take()); // close the old ports before opening them again
                    inputs = open_inputs(&settings, &mut problems);
                    Ok(())
                }
            };
            if let Err(e) = result {
                report(&mut problems, e.to_string());
            }
        }
        while let Ok(input) = inputs_incoming.try_recv() {
            let result = match input {
                Input::Go => show.go(),
                Input::BackPressed => Ok(back_held = Some(Instant::now())),
                // (Not after a hold that has already stopped everything.)
                Input::BackReleased => match back_held.take() {
                    Some(_) => show.back(),
                    None => Ok(()),
                },
                Input::Cue(note) => show.fire_note(note),
                Input::Heard(note) => Ok(heard = Some(note)),
            };
            if let Err(e) = result {
                report(&mut problems, e.to_string());
            }
        }
        if back_held.is_some_and(|since| since.elapsed() >= BACK_HOLD) {
            back_held = None;
            if let Err(e) = show.stop_all() {
                report(&mut problems, e.to_string());
            }
        }
        // A MIDI device that was plugged in after the start is listened to as well.
        if Instant::now() >= rescan_midi {
            rescan_midi = Instant::now() + MIDI_RESCAN;
            match &mut inputs {
                Some(open) if open.ports_changed() => open.rescan_midi(&settings.inputs(), &input_events),
                Some(_) => {}
                // Inputs that could not be opened (an OSC port that was taken) are
                // tried again as well.
                None => inputs = open_inputs(&settings, &mut problems),
            }
        }

        // Keep the audio around the operator's position ready: the current cue and the
        // next few. (What is armed or playing, the player looks after itself.)
        let position = (show.current(), show.next(), show.script().blocks.len());
        if window_for != Some(position) {
            window_for = Some(position);
            // Two stretches: from the operator's cue onwards, and from the next Go onwards
            // (the same place, unless a cue further away has been armed).
            let from = show.current().unwrap_or(0).saturating_sub(1);
            let mut starts = audio_starts(show.script(), from..from + 1 + AHEAD);
            if let Some(next) = show.next() {
                for start in audio_starts(show.script(), next..next + AHEAD) {
                    if !starts.contains(&start) {
                        starts.push(start);
                    }
                }
            }
            show.player().cache().set_window(starts);
        }

        // A device that reports an error, or whose clock stands still, is gone: carry on
        // without it and take it back as soon as it can be opened again.
        if let Some(out) = &device {
            let frames = out.clock.frames();
            if frames != alive.1 {
                alive = (Instant::now(), frames);
            }
            if out.failed.load(std::sync::atomic::Ordering::SeqCst) || alive.0.elapsed() > DEVICE_STALL {
                device = None;
                output = None;
                pump.take_over();
                retry_device = Instant::now() + DEVICE_RETRY;
                report(&mut problems, format!("{NO_DEVICE}Das Ausgabegerät ist weg. Die Show läuft stumm weiter; es wird neu verbunden, sobald es wieder da ist."));
            }
        }
        if device.is_none() && Instant::now() >= retry_device {
            retry_device = Instant::now() + DEVICE_RETRY;
            if let Ok(out) = device::open(mixer.clone(), settings.audio_device.as_deref(), MAX_CHANNELS, None, Some(clock.clone())) {
                problems.retain(|p| !p.starts_with(NO_DEVICE));
                output = Some(info(&out));
                alive = (Instant::now(), out.clock.frames());
                device = Some(out);
            }
        }
        if device.is_none() {
            pump.run(&mixer, sample_rate);
        }

        if let Err(e) = show.tick(started.elapsed().as_secs_f64()) {
            report(&mut problems, e.to_string());
        }
        for problem in show.take_problems() {
            report(&mut problems, problem);
        }

        let effects = show.take_effects();
        if !effects.is_empty() {
            if let Some(wires) = &wires {
                wires.send(outputs.wire(&effects, &cast));
            }
            if let Some(display) = display.as_ref().filter(|_| !outputs.blocked) {
                for effect in &effects {
                    match effect {
                        Effect::Display { device, markdown } => display.set_content(device, markdown),
                        Effect::Announce { device, text } => display.announce(device, text),
                        _ => {}
                    }
                }
            }
        }
        // Timecode drives devices like any other output: none while outputs are blocked
        // or the show file is not trusted.
        *feed.lock().unwrap() = show.timecode_seconds().filter(|_| !outputs.blocked).map(|seconds| (seconds, Instant::now()));

        // Note when cues fired; Back takes the entries of undone cues with it.
        let fired: Vec<usize> = show.history().cues().collect();
        if fired.len() > fired_count {
            for &cue in &fired[fired_count..] {
                fired_at.retain(|(c, _)| *c != cue);
                fired_at.push((cue, std::time::SystemTime::now()));
            }
        } else if fired.len() < fired_count {
            fired_at.retain(|(c, _)| fired.contains(c));
        }
        fired_count = fired.len();

        let mic = show.mic();
        *snapshot.lock().unwrap() = Snapshot {
            fired: show.history().cues().collect(),
            done: show.history().this_pass().collect(),
            latest: show.history().cues().last(),
            mic_hold: show.mic_hold(),
            current: show.current(),
            next: show.next(),
            selected_variant: show.selected_variant(),
            pending_outros: show.pending_outros().to_vec(),
            mic: (mic != Mic::Unchanged).then_some(mic),
            audio: show.audio_status(),
            paused: show.paused(),
            timecode: show.timecode_seconds(),
            delays: show.delay_progress(),
            waits: show.waits(),
            go_blocked: show.go_blocked(),
            needs_variant: show.needs_variant(),
            display_clients: display.as_ref().map(|d| d.clients()).unwrap_or_default(),
            display_address: display.as_ref().map(|d| d.address()),
            output: output.clone(),
            problems: problems.clone(),
            heard,
            loading: Some(show.player().cache().loading()).filter(|n| *n > 0),
            audio_memory_mb: (show.player().cache().held_seconds() * sample_rate as f64 * 4.0 / 1e6) as f32,
            emergency_light,
            fired_at: fired_at.clone(),
        };
        thread::sleep(TICK.saturating_sub(tick_started.elapsed()));
    }

    // The UI is gone: fade out rather than cut, then let the device go.
    let _ = show.stop_all();
    *feed.lock().unwrap() = None;
    let fade_until = Instant::now() + Duration::from_millis(600);
    while Instant::now() < fade_until {
        if device.is_none() {
            pump.run(&mixer, sample_rate);
        }
        thread::sleep(TICK);
    }
    drop(inputs);
    drop(mtc);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wait until the snapshot satisfies `check`, or fail after two seconds.
    fn wait(session: &Session, what: &str, check: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = session.snapshot();
            if check(&snapshot) {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {snapshot:?}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Auto-cues at a place in the audio fire in a running session, with the audio read
    /// from a file and nobody rendering in step with the show's ticks.
    #[test]
    fn position_auto_cues_fire_in_a_running_session() {
        let dir = std::env::temp_dir().join(format!("mdstage-auto-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        crate::stream::write_wav(&dir.join("audio/a.wav"), 48_000, 2, 48_000 * 3);
        let cue = |n: usize, more: &str| format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n{more}\n```\n\n");
        let script = Script::parse(&[
            cue(0, "music: a.wav"),
            cue(1, "music:\n    adjust:\n        trigger_note: {ch: 1, note: 0}\n        volume: 0.8\n        fadetime: 2\nauto_trigger:\n    trigger_note: {ch: 1, note: 0}\n    at: 0.4"),
            cue(2, "auto_trigger:\n    trigger_note: {ch: 1, note: 0}\n    at: 1.2"),
        ].concat());
        let settings: Settings = serde_json::from_str(r#"{"audio_device": "no such device", "display_port": 0, "outputs_blocked": true}"#).unwrap();
        let session = Session::start(script, dir.clone(), settings, true).unwrap();
        wait(&session, "start-up", |s| s.next == Some(0));
        session.send(Request::Go);
        wait(&session, "the first auto-cue", |s| s.fired == [0, 1]);
        let all = wait(&session, "the second auto-cue", |s| s.fired == [0, 1, 2]);
        assert_eq!(all.current, Some(0), "the operator's place stays with the cue they fired");
        assert_eq!(all.latest, Some(2), "and the view is told which cue fired last");
        drop(session);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The same with this machine's real audio device, silently (volume 0). Not run by
    /// default: `cargo test -p mdstage-engine probe_real_device -- --ignored`.
    #[test]
    #[ignore]
    fn probe_real_device() {
        let dir = std::env::temp_dir().join(format!("mdstage-probe-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        crate::stream::write_wav(&dir.join("audio/a.wav"), 48_000, 2, 48_000 * 3);
        let cue = |n: usize, more: &str| format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n{more}\n```\n\n");
        let script = Script::parse(&[
            cue(0, "music:\n    file: a.wav\n    volume: 0"),
            cue(1, "auto_trigger:\n    trigger_note: {ch: 1, note: 0}\n    at: 0.4"),
            cue(2, "auto_trigger:\n    trigger_note: {ch: 1, note: 0}\n    at: 1.2"),
        ].concat());
        let settings: Settings = serde_json::from_str(r#"{"display_port": 0, "outputs_blocked": true}"#).unwrap();
        let session = Session::start(script, dir.clone(), settings, true).unwrap();
        let idle = wait(&session, "start-up", |s| s.next == Some(0));
        std::thread::sleep(Duration::from_millis(500));
        session.send(Request::Go);
        let all = wait(&session, "the auto-cues", |s| s.fired == [0, 1, 2]);
        assert!(all.output.is_some() || !idle.problems.is_empty());
        drop(session);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn runs_a_show_end_to_end() {
        // No audio in this show, a display on a free port, nothing sent to real devices.
        let script = Script::parse(
            "```yaml\nconfig:\n    roles:\n        Anna: {ch: 1}\n```\n\n```yaml\nmic: Anna\ncue_display:\n    - {device: Foyer, markdown: \"# One\"}\n```\n\n```yaml\nlight: B\n```\n\n```yaml\nauto_trigger: {trigger_note: {ch: 1, note: 9}, delay: 0.05}\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 9}\n```\n",
        );
        let settings: Settings = serde_json::from_str(
            r#"{"audio_device": "no such device", "display_port": 0, "outputs_blocked": false,
                "devices": [{"type": "display", "name": "Foyer"}]}"#,
        )
        .unwrap();
        let session = Session::start(script, std::env::temp_dir(), settings, true).unwrap();

        let idle = wait(&session, "start-up", |s| s.display_address.is_some());
        assert_eq!((idle.current, idle.next), (None, Some(0)));
        assert_eq!(idle.output, None);
        assert!(idle.problems.iter().any(|p| p.starts_with("Audiogerät: ")), "the missing device is reported: {:?}", idle.problems);

        session.send(Request::Go);
        let first = wait(&session, "cue 1", |s| s.fired == [0]);
        assert_eq!(first.mic, Some(Mic::Open(vec!["Anna".into()])));
        assert_eq!(first.next, Some(1));

        // The display shows the cue's markdown.
        let mut socket = std::net::TcpStream::connect(idle.display_address.unwrap()).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        std::io::Write::write_all(&mut socket, b"GET /__display/events/foyer?clientId=t HTTP/1.1\r\n\r\n").unwrap();
        let mut reader = std::io::BufReader::new(socket);
        let mut seen = String::new();
        while !seen.contains("data: ") {
            seen.clear();
            assert!(std::io::BufRead::read_line(&mut reader, &mut seen).unwrap() > 0);
        }
        assert!(seen.contains("<h1>One</h1>"), "{seen}");
        wait(&session, "the display client", |s| s.display_clients.len() == 1 && s.display_clients[0].connected);

        // Firing cue 4 arms the delay auto-cue 3, which then fires by itself.
        session.send(Request::Fire(3));
        wait(&session, "the auto-cue", |s| s.fired == [0, 3, 2]);

        session.send(Request::Back);
        let back = wait(&session, "back", |s| s.fired == [0]);
        assert_eq!(back.current, Some(0));

        session.send(Request::Arm(Some(3)));
        wait(&session, "arming", |s| s.next == Some(3));
        session.send(Request::ClearProblems);
        wait(&session, "cleared problems", |s| s.problems.is_empty());
        drop(session);
    }
}
