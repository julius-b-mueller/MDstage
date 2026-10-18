//! The remote live view: the live view in a browser elsewhere in the local network, at
//! `http://<address>:<port>/`, with Go, Back, ▲ and ▼.
//!
//! The page asks for the PIN set on this computer and sends it with every request. It is
//! sent in the clear (there is no HTTPS): it keeps out whoever happens to be on the same
//! network, not someone listening in. Wrong PINs from one address are slowed down.
//!
//! What the page shows comes in two parts over Server-Sent Events: the script as the
//! app lays it out (`model`, sent again when it changes) and the state of the show
//! (`live`, sent whenever it changes).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mdstage_core::Script;
use mdstage_core::cues::{Cues, DeviceKind, DeviceState, History};
use mdstage_core::mic::Mic;
use mdstage_core::yaml::Value as YamlValue;
use serde_json::{Value, json};

use crate::clock::VoiceState;
use crate::display::{query, respond};
use crate::inputs::Input;
use crate::session::Snapshot;
use crate::show::TrackItem;

const PAGE: &str = include_str!("../remote/index.html");
const SCRIPT: &str = include_str!("../remote/app.js");

const KEEP_ALIVE: Duration = Duration::from_secs(20);
const MAX_REQUEST: usize = 8192;
/// Each connection has a thread; more than this at once are turned away.
const MAX_CONNECTIONS: usize = 64;
/// Wrong PINs from one address before it has to wait, and how long.
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct State {
    pin: String,
    /// Whether Go, Back, ▲ and ▼ are taken (they can be switched off in the Devices menu;
    /// the page then still shows the show).
    controls: bool,
    model: String,
    live: String,
    streams: Vec<TcpStream>,
    /// Wrong PINs by address: how many, and since when.
    failures: HashMap<IpAddr, (u32, Instant)>,
}

impl State {
    /// Send an event to every stream; streams that fail are dropped.
    fn push(&mut self, event: &str, data: &str) {
        let message = format!("event: {event}\ndata: {data}\n\n");
        self.streams.retain_mut(|stream| stream.write_all(message.as_bytes()).is_ok());
    }

    /// Whether `pin` is right. An address with too many wrong ones is not even asked.
    fn admits(&mut self, from: IpAddr, pin: Option<&String>) -> Result<(), &'static str> {
        if let Some((count, since)) = self.failures.get(&from).copied() {
            if since.elapsed() > LOCKOUT {
                self.failures.remove(&from);
            } else if count >= MAX_FAILURES {
                return Err("429 Too Many Requests");
            }
        }
        let right = !self.pin.is_empty() && pin.is_some_and(|pin| same(pin.as_bytes(), self.pin.as_bytes()));
        if right {
            self.failures.remove(&from);
            return Ok(());
        }
        let entry = self.failures.entry(from).or_insert((0, Instant::now()));
        entry.0 += 1;
        Err("403 Forbidden")
    }
}

/// Compare without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(mut socket: TcpStream, state: &Arc<Mutex<State>>, running: &AtomicBool, events: &Sender<Input>) {
    let _ = socket.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(peer) = socket.peer_addr() else { return };
    let mut request_line = String::new();
    {
        let mut reader = BufReader::new((&socket).take(MAX_REQUEST as u64));
        if reader.read_line(&mut request_line).is_err() {
            return;
        }
        let mut header = String::new();
        while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
            header.clear();
        }
    }
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return };
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let params = query(raw_query);

    match (method, path) {
        ("GET", "/") => respond(&mut socket, "200 OK", "text/html; charset=utf-8", PAGE),
        ("GET", "/__remote/app.js") => respond(&mut socket, "200 OK", "application/javascript; charset=utf-8", SCRIPT),
        ("GET", "/__remote/events") => {
            let admitted = state.lock().unwrap().admits(peer.ip(), params.get("pin"));
            match admitted {
                Ok(()) => stream(socket, state, running),
                Err(status) => respond(&mut socket, status, "text/plain", ""),
            }
        }
        ("POST", "/__remote/check") => {
            let admitted = state.lock().unwrap().admits(peer.ip(), params.get("pin"));
            match admitted {
                Ok(()) => drop(socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")),
                Err(status) => respond(&mut socket, status, "text/plain", ""),
            }
        }
        ("POST", command) => {
            let input = match command {
                "/__remote/go" => Some(Input::Go),
                "/__remote/back" => Some(Input::Back),
                "/__remote/up" => Some(Input::Up),
                "/__remote/down" => Some(Input::Down),
                "/__remote/variant" => params.get("cue").and_then(|cue| cue.parse().ok()).map(Input::Variant),
                _ => None,
            };
            let Some(input) = input else { return respond(&mut socket, "404 Not Found", "text/plain", "") };
            let mut state = state.lock().unwrap();
            if let Err(status) = state.admits(peer.ip(), params.get("pin")) {
                drop(state);
                return respond(&mut socket, status, "text/plain", "");
            }
            if !state.controls {
                drop(state);
                return respond(&mut socket, "409 Conflict", "text/plain", "");
            }
            drop(state);
            let _ = events.send(input);
            let _ = socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        }
        ("GET", _) => respond(&mut socket, "404 Not Found", "text/plain", ""),
        _ => respond(&mut socket, "405 Method Not Allowed", "text/plain", ""),
    }
}

/// Serve one page's event stream until it goes or the server stops.
fn stream(mut socket: TcpStream, state: &Arc<Mutex<State>>, running: &AtomicBool) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    {
        let mut state = state.lock().unwrap();
        let hello = format!("{head}event: model\ndata: {}\n\nevent: live\ndata: {}\n\n", state.model, state.live);
        let Ok(writer) = socket.try_clone() else { return };
        if socket.write_all(hello.as_bytes()).is_err() {
            return;
        }
        state.streams.push(writer);
    }
    let _ = socket.set_read_timeout(Some(KEEP_ALIVE));
    let mut scratch = [0u8; 64];
    loop {
        match socket.read(&mut scratch) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if !running.load(SeqCst) || socket.write_all(b": keep-alive\n\n").is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
        if !running.load(SeqCst) {
            break;
        }
    }
    let _ = socket.shutdown(std::net::Shutdown::Both);
}

/// The microphones as JSON: `null` (none set yet), `"muteall"`, or the open ones' names.
fn mic_json(mic: Option<&Mic>) -> Value {
    match mic {
        None | Some(Mic::Unchanged) => Value::Null,
        Some(Mic::MuteAll) => json!("muteall"),
        Some(Mic::Open(names)) => json!(names),
    }
}

/// What a device was last told, in a few words (as the live view's info bar says it).
fn device_summary(state: &DeviceState, kind: DeviceKind) -> String {
    let text = |value: Option<&YamlValue>| match value {
        Some(YamlValue::String(s)) => s.clone(),
        Some(YamlValue::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    match state {
        DeviceState::Display(markdown) => markdown.lines().find(|l| !l.trim().is_empty()).unwrap_or("—").trim_start_matches(['#', ' ']).to_string(),
        DeviceState::Messages(messages) => {
            let one = |m: &YamlValue| {
                let comment = text(m.get("comment"));
                if !comment.is_empty() {
                    return comment;
                }
                if kind != DeviceKind::Midi {
                    return format!("{} {}", text(m.get("path")), text(m.get("arg"))).trim().to_string();
                }
                match m.get("type").and_then(YamlValue::as_str).unwrap_or("note") {
                    "cc" => format!("CC{}={}", text(m.get("cc")), text(m.get("value"))),
                    "pc" => format!("PC{}", text(m.get("program"))),
                    "sysex" => "SysEx".to_string(),
                    _ => format!("N{}", text(m.get("note"))),
                }
            };
            messages.iter().map(one).collect::<Vec<_>>().join(", ")
        }
    }
}

/// The state of the show for the page, as JSON: what the live view shows that changes
/// while the show runs. `controls`: whether the page's buttons are taken.
pub fn live_state(snapshot: &Snapshot, script: &Script, controls: bool) -> String {
    let cues = Cues::new(script);
    let pending = snapshot.pending_outros.first().map(|&(_, outro)| outro);
    let count = cues.len();
    // (As the live view's ▲ ▼: a group of variants counts as one cue.)
    let (up, down) = match snapshot.next {
        Some(next) => (cues.group_root(next).checked_sub(1).is_some(), cues.group(next).end < count),
        None => (count > 0, false),
    };
    let mut history = History::default();
    snapshot.fired.iter().for_each(|&cue| history.push(cue, false));
    let devices: Vec<Value> = history.device_states(&cues).iter().map(|((kind, device), state)| json!([device, device_summary(state, *kind)])).collect();
    let audio = &snapshot.audio;
    let own_tail = |cue: usize, s: &crate::player::Status| s.state == VoiceState::Tail && audio.iter().any(|(c, o)| *c == cue && o.part == s.part && o.state == VoiceState::Playing);
    let playing: Vec<Value> = audio
        .iter()
        .filter(|(cue, s)| matches!(s.state, VoiceState::Playing | VoiceState::Tail) && !own_tail(*cue, s))
        .map(|(cue, status)| {
            let looped = cues.get(*cue).is_some_and(|c| c.loop_outro().is_some() || c.audio().is_some_and(|a| a.looped || a.parts.len() > 1));
            let tail = status.state == VoiceState::Tail;
            let (from, to) = if tail { (status.transition, status.end) } else { (status.start, status.transition) };
            let fraction = if to > from { ((status.seconds - from) / (to - from)).clamp(0.0, 1.0) } else { 0.0 };
            let time = if tail { String::new() } else { format!("{:.1} / {:.1} s", status.seconds - from, to - from) };
            json!({ "cue": cue, "looped": looped, "tail": tail, "fraction": fraction, "time": time })
        })
        .collect();
    let tracking: Vec<Value> = snapshot
        .tracking
        .iter()
        .map(|item| match item {
            TrackItem::Start(cue) => json!({ "kind": "start", "cue": cue }),
            TrackItem::Stop(cue) => json!({ "kind": "stop", "cue": cue }),
            TrackItem::Volume(cue, level) => json!({ "kind": "volume", "cue": cue, "level": level }),
            TrackItem::Mic(mic) => json!({ "kind": "mic", "mic": mic_json(Some(mic)) }),
            TrackItem::Device { kind, device, from } => json!({ "kind": "device", "type": format!("{kind:?}").to_lowercase(), "device": device, "from": from }),
        })
        .collect();
    json!({
        "timecode": snapshot.timecode.map(|seconds| snapshot.frame_rate.show(seconds)),
        "current": snapshot.current,
        "next": pending.or(snapshot.next),
        "fired": snapshot.fired,
        "selected": snapshot.selected_variant,
        "ready": snapshot.next.is_some() && pending.is_none() && !snapshot.go_blocked && !snapshot.needs_variant,
        "blocked": snapshot.go_blocked,
        "needsVariant": snapshot.needs_variant,
        "up": up,
        "down": down,
        "controls": controls,
        "mic": mic_json(snapshot.mic.as_ref()),
        "leaving": snapshot.mic_hold.as_ref().map(|hold| hold.leaving.clone()).unwrap_or_default(),
        "devices": devices,
        "audio": playing,
        "waits": snapshot.waits.iter().map(|wait| json!([wait.cue, wait.fraction])).collect::<Vec<_>>(),
        "tracking": tracking,
        "question": snapshot.question.is_some(),
    })
    .to_string()
}

/// The running server. Dropping it closes all streams and stops listening.
pub struct RemoteServer {
    state: Arc<Mutex<State>>,
    running: Arc<AtomicBool>,
    address: SocketAddr,
}

impl RemoteServer {
    /// Listen on `host:port`; Go, Back, ▲, ▼ and variant choices go to `events`.
    pub fn start(host: &str, port: u16, pin: &str, events: Sender<Input>) -> std::io::Result<RemoteServer> {
        let listener = TcpListener::bind((host, port))?;
        let address = listener.local_addr()?;
        let state = Arc::new(Mutex::new(State { pin: pin.to_string(), controls: true, model: "null".into(), live: "null".into(), ..Default::default() }));
        let running = Arc::new(AtomicBool::new(true));
        let (shared, flag) = (state.clone(), running.clone());
        let open = Arc::new(AtomicUsize::new(0));
        thread::Builder::new().name("mdstage-remote".into()).spawn(move || {
            for socket in listener.incoming() {
                if !flag.load(SeqCst) {
                    break;
                }
                let Ok(socket) = socket else { continue };
                if open.fetch_add(1, SeqCst) >= MAX_CONNECTIONS {
                    open.fetch_sub(1, SeqCst);
                    continue;
                }
                let (state, running, open, events) = (shared.clone(), flag.clone(), open.clone(), events.clone());
                let spawned = thread::Builder::new().name("mdstage-remote-client".into()).spawn({
                    let open = open.clone();
                    move || {
                        handle(socket, &state, &running, &events);
                        open.fetch_sub(1, SeqCst);
                    }
                });
                if spawned.is_err() {
                    open.fetch_sub(1, SeqCst);
                }
            }
        })?;
        Ok(RemoteServer { state, running, address })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn set_pin(&self, pin: &str) {
        self.state.lock().unwrap().pin = pin.to_string();
    }

    /// Whether Go, Back, ▲ and ▼ are taken from the page.
    pub fn set_controls(&self, on: bool) {
        self.state.lock().unwrap().controls = on;
    }

    /// The script as laid out for the page (JSON); sent on when it changed.
    pub fn set_model(&self, model: &str) {
        let mut state = self.state.lock().unwrap();
        if state.model != model {
            state.model = model.to_string();
            state.push("model", model);
        }
    }

    /// The state of the show (JSON); sent on when it changed.
    pub fn set_live(&self, live: &str) {
        let mut state = self.state.lock().unwrap();
        if state.live != live {
            state.live = live.to_string();
            state.push("live", live);
        }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.running.store(false, SeqCst);
        for stream in self.state.lock().unwrap().streams.drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        let wake = if self.address.ip().is_unspecified() { SocketAddr::from(([127, 0, 0, 1], self.address.port())) } else { self.address };
        let _ = TcpStream::connect_timeout(&wake, Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn request(address: SocketAddr, line: &str) -> String {
        let mut socket = TcpStream::connect(address).unwrap();
        socket.write_all(format!("{line} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
        let mut answer = String::new();
        let _ = socket.read_to_string(&mut answer);
        answer
    }

    #[test]
    fn commands_need_the_pin_and_the_controls() {
        let (events, received) = channel();
        let server = RemoteServer::start("127.0.0.1", 0, "4711", events).unwrap();
        let address = server.address();
        assert!(request(address, "GET /").contains("200 OK"), "the page itself needs no PIN");
        assert!(request(address, "POST /__remote/go?pin=1234").starts_with("HTTP/1.1 403"));
        assert!(request(address, "POST /__remote/go").starts_with("HTTP/1.1 403"));
        assert!(request(address, "GET /__remote/go?pin=4711").starts_with("HTTP/1.1 404"), "commands are POSTs");
        assert!(request(address, "POST /__remote/check?pin=4711").starts_with("HTTP/1.1 204"));
        assert!(request(address, "POST /__remote/go?pin=4711").starts_with("HTTP/1.1 204"));
        assert!(request(address, "POST /__remote/variant?pin=4711&cue=3").starts_with("HTTP/1.1 204"));
        assert_eq!(received.try_iter().collect::<Vec<_>>(), [Input::Go, Input::Variant(3)]);
        server.set_controls(false);
        assert!(request(address, "POST /__remote/back?pin=4711").starts_with("HTTP/1.1 409"));
        assert!(received.try_iter().next().is_none());
    }

    #[test]
    fn wrong_pins_lock_an_address_out() {
        let (events, _received) = channel();
        let server = RemoteServer::start("127.0.0.1", 0, "4711", events).unwrap();
        for _ in 0..MAX_FAILURES {
            assert!(request(server.address(), "POST /__remote/go?pin=0000").starts_with("HTTP/1.1 403"));
        }
        assert!(request(server.address(), "POST /__remote/go?pin=4711").starts_with("HTTP/1.1 429"), "even the right PIN waits");
    }

    #[test]
    fn the_stream_brings_the_model_and_the_state() {
        let (events, _received) = channel();
        let server = RemoteServer::start("127.0.0.1", 0, "4711", events).unwrap();
        server.set_model("{\"cues\":[]}");
        server.set_live("{\"next\":1}");
        let mut socket = TcpStream::connect(server.address()).unwrap();
        socket.write_all(b"GET /__remote/events?pin=4711 HTTP/1.1\r\n\r\n").unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut reader = BufReader::new(socket);
        let mut seen = String::new();
        while !seen.contains("{\"next\":1}") {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        assert!(seen.contains("event: model\ndata: {\"cues\":[]}"));
        server.set_live("{\"next\":2}");
        let mut line = String::new();
        while !line.contains("next\":2") {
            line.clear();
            reader.read_line(&mut line).unwrap();
        }
    }
}
