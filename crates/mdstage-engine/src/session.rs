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
/// Sample rate and block size of the stand-in used when no audio device can be opened.
const NULL_RATE: u32 = 48_000;
const MAX_PROBLEMS: usize = 20;

pub enum Request {
    Go,
    Back,
    /// Fire a cue directly (a click on it).
    Fire(usize),
    Arm(Option<usize>),
    SelectVariant(Option<usize>),
    /// Emergency: fade all audio out.
    StopAll,
    /// Emergency: mute all microphones.
    MicsOff,
    /// New machine settings, and whether the show file is trusted. A changed audio
    /// device takes effect when the session is restarted.
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
    pub current: Option<usize>,
    pub next: Option<usize>,
    /// `(loop, outro)` pairs waiting for the loop's end.
    pub pending_outros: Vec<(usize, usize)>,
    /// The microphones as the fired cues left them; `None` before any cue set them.
    pub mic: Option<Mic>,
    pub audio: Vec<(usize, Status)>,
    pub timecode: Option<f64>,
    pub delays: Vec<DelayProgress>,
    pub display_clients: Vec<Client>,
    pub display_address: Option<SocketAddr>,
    /// `None` if no audio device could be opened (the show still runs, silently).
    pub output: Option<OutputInfo>,
    pub problems: Vec<String>,
    /// The last MIDI note that came in, for "MIDI learn".
    pub heard: Option<Note>,
    /// How many audio files are being decoded in the background right now.
    pub loading: Option<usize>,
    /// Decoded audio held in memory, in megabytes.
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

/// The audio files of the cues numbered `cues` (0-based, in script order), without repeats.
/// Cues that chain or hand off to others bring those along, so a transition never waits.
fn audio_files(script: &Script, cues: std::ops::Range<usize>) -> Vec<String> {
    let all = mdstage_core::cues::Cues::new(script);
    let mut files: Vec<String> = Vec::new();
    let mut add = |cue: usize| {
        for audio in all.get(cue).and_then(|c| c.audio()).into_iter().flat_map(|a| a.parts).flat_map(|p| p.audios) {
            if !files.contains(&audio.file) {
                files.push(audio.file);
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
    files
}

/// Where the mixer's audio goes.
enum Sink {
    Device(device::Output),
    /// No device: the mixer is rendered into nothing, in real time, so that
    /// transitions and timed cues still happen.
    Null { mixer: Mixer, rendered: Instant, scratch: Vec<f32> },
}

impl Sink {
    fn pump(&mut self) {
        if let Sink::Null { mixer, rendered, scratch } = self {
            let frames = (rendered.elapsed().as_secs_f64() * NULL_RATE as f64) as usize;
            for _ in 0..frames / (scratch.len() / 2) {
                mixer.render(scratch, 2);
                *rendered += Duration::from_secs_f64((scratch.len() / 2) as f64 / NULL_RATE as f64);
            }
        }
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
    for file in audio_files(&script, 0..usize::MAX) {
        if let Some(rate) = crate::clip::Clip::probe_rate(&show_dir.join("audio").join(&file)) {
            match rates.iter_mut().find(|(r, _)| *r == rate) {
                Some(entry) => entry.1 += 1,
                None => rates.push((rate, 1)),
            }
        }
    }
    let preferred_rate = rates.iter().max_by_key(|(_, count)| *count).map(|(rate, _)| *rate);

    let (mixer, handle) = Mixer::new();
    let (mut sink, handle, output) = match device::open(mixer.limited(), settings.audio_device.as_deref(), 64, preferred_rate) {
        Ok(out) => {
            let info = OutputInfo { name: out.device_name.clone(), sample_rate: out.sample_rate, channels: out.channels };
            (Sink::Device(out), handle, Some(info))
        }
        Err(e) => {
            report(&mut problems, format!("Audio: {e}"));
            // The first mixer went down with the failed stream; nothing was loaded yet.
            let (mixer, handle) = Mixer::new();
            (Sink::Null { mixer, rendered: Instant::now(), scratch: vec![0.0; 2 * 480] }, handle, None)
        }
    };
    let (sample_rate, clock) = match &sink {
        Sink::Device(out) => (out.sample_rate, Some(out.clock.clone())),
        Sink::Null { .. } => (NULL_RATE, None),
    };

    let mut cast = Cast::from_script(&script, settings.language == "en");
    let player = Player::new(handle, ClipCache::new(show_dir.join("audio"), sample_rate), settings.routing(&script.virtual_channels()));
    let mut show = Show::new(script, player, clock, settings.language == "en");

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

    // Audio is decoded in the background, a few cues ahead of the show, and dropped again
    // once the show has moved on — so memory holds a handful of files, not the whole show,
    // and no cue has to wait for a file when it fires.
    let (wanted_files, loader_requests) = channel::<String>();
    let (decoded, decoded_incoming) = channel();
    let audio_dir = show_dir.join("audio");
    let loader = thread::Builder::new().name("mdstage-audio-loader".into()).spawn(move || {
        for file in loader_requests {
            let clip = crate::clip::Clip::decode_file(&audio_dir.join(&file)).and_then(|c| c.resampled(sample_rate));
            if decoded.send((file, clip)).is_err() {
                break;
            }
        }
    });
    if let Err(e) = &loader {
        report(&mut problems, format!("Audio wird erst beim Auslösen geladen: {e}"));
    }
    // Files asked of the loader and not back yet.
    let mut pending: Vec<String> = Vec::new();
    let mut window_for: Option<(Option<usize>, Option<usize>, usize)> = None;

    let started = Instant::now();
    let mut heard = None;
    let mut emergency_light = false;
    let mut fired_at: Vec<(usize, std::time::SystemTime)> = Vec::new();
    let mut fired_count = 0;
    let mut device_failed = false;
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
                    show.replace_script(*script)
                }
                Request::Configure(new, now_trusted) => {
                    settings = *new;
                    trusted = now_trusted;
                    outputs = settings.outputs(trusted);
                    *timecode_ports.lock().unwrap() = settings.timecode_ports();
                    let channels = show.script().virtual_channels();
                    show.player().set_routing(settings.routing(&channels));
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
                Input::Back => show.back(),
                Input::Cue(note) => show.fire_note(note),
                Input::Heard(note) => Ok(heard = Some(note)),
            };
            if let Err(e) = result {
                report(&mut problems, e.to_string());
            }
        }

        // Keep the audio of the cues around the operator's position decoded: the current
        // cue, the next few, whatever is armed or playing — and forget the rest.
        let position = (show.current(), show.next(), show.script().blocks.len());
        if window_for != Some(position) {
            window_for = Some(position);
            // Two stretches: from the operator's cue onwards, and from the next Go onwards
            // (the same place, unless a cue further away has been armed).
            let from = show.current().unwrap_or(0).saturating_sub(1);
            let mut wanted = audio_files(show.script(), from..from + 1 + AHEAD);
            if let Some(next) = show.next() {
                for file in audio_files(show.script(), next..next + AHEAD) {
                    if !wanted.contains(&file) {
                        wanted.push(file);
                    }
                }
            }
            for cue in show.player().active_cues() {
                wanted.extend(audio_files(show.script(), cue..cue + 1));
            }
            for file in &wanted {
                if !pending.contains(file) && !show.player().cache().contains(file) && wanted_files.send(file.clone()).is_ok() {
                    pending.push(file.clone());
                }
            }
            show.player().cache().retain(|file| wanted.iter().any(|w| w == file));
        }
        while let Ok((file, clip)) = decoded_incoming.try_recv() {
            pending.retain(|p| *p != file);
            match clip {
                // A cue fired in the meantime may already have loaded the file itself.
                Ok(clip) if !show.player().cache().contains(&file) => show.player().cache().insert(&file, clip),
                Ok(_) => {}
                Err(e) => report(&mut problems, e.to_string()),
            }
        }
        if let Sink::Device(out) = &sink {
            if !device_failed && out.failed.load(std::sync::atomic::Ordering::SeqCst) {
                device_failed = true;
                report(&mut problems, "Audio: Das Ausgabegerät meldet einen Fehler (getrennt?). Show neu öffnen, um es wieder zu verbinden.".into());
            }
        }

        sink.pump();
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
        *feed.lock().unwrap() = show.timecode_seconds().map(|seconds| (seconds, Instant::now()));

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
            current: show.current(),
            next: show.next(),
            pending_outros: show.pending_outros().to_vec(),
            mic: (mic != Mic::Unchanged).then_some(mic),
            audio: show.audio_status(),
            timecode: show.timecode_seconds(),
            delays: show.delay_progress(),
            display_clients: display.as_ref().map(|d| d.clients()).unwrap_or_default(),
            display_address: display.as_ref().map(|d| d.address()),
            output: output.clone(),
            problems: problems.clone(),
            heard,
            loading: (!pending.is_empty()).then_some(pending.len()),
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
        sink.pump();
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
        assert!(idle.problems.iter().any(|p| p.starts_with("Audio: ")), "the missing device is reported: {:?}", idle.problems);

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
