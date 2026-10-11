//! Delivers a show's effects to the outside world: MIDI ports, OSC and HTTP devices and
//! the mixer's microphone mutes.
//!
//! Two steps, so the first can be tested without any hardware: `Outputs::wire` turns
//! effects into addressed messages using this machine's device settings, and `Sender`
//! puts those on the wire.
//!
//! Device addresses are machine-local. A message for a device that is not configured
//! here sends nothing — there is no fallback to some other device.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::mpsc::{Sender as Channel, channel};
use std::thread;
use std::time::{Duration, Instant};

use mdstage_core::effects::{Effect, OscArg};
use mdstage_core::mic::{Cast, Mic};

/// How long a note stays on before its note off.
const NOTE_LENGTH: Duration = Duration::from_millis(100);
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq)]
pub enum Address {
    Midi { port: String },
    Osc { host: String, port: u16 },
    Http { url: String },
}

/// One output device as configured on this machine.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub name: String,
    pub address: Address,
    pub enabled: bool,
    /// Receives every cue's trigger note (MIDI) or trigger OSC message.
    pub trigger_notes: bool,
}

/// One value of a custom mute message: fixed, or computed from the microphone channel.
/// `{ch}` in a template is replaced by the channel (see each use for 0- or 1-based).
pub type Template = String;

/// How a mixer's microphone channels are muted and unmuted.
#[derive(Clone, Debug, PartialEq)]
pub enum MuteMethod {
    /// Behringer X32 / Midas M32: CC on MIDI channel 2, controller = channel − 1,
    /// value 0 = on, 127 = muted.
    X32,
    /// A note per channel; `{ch}` is the 0-based channel.
    MidiNote { channel: Template, note: Template, on_velocity: u8, off_velocity: u8 },
    /// A controller per channel; `{ch}` is the 0-based channel.
    MidiCc { channel: Template, controller: Template, on_value: u8, off_value: u8 },
    /// A program change per channel; `{ch}` is the 0-based channel.
    MidiProgram { channel: Template, on_program: u8, off_program: u8 },
    /// Hex bytes; `{ch}` is the 0-based channel, `{val}` 0 (on) or 7F (muted).
    MidiSysex { unmute: Template, mute: Template },
    /// Separate OSC messages for on and off; `{ch}` is the 1-based channel, two digits.
    Osc { on_path: Template, on_arg: Option<OscArg>, off_path: Template, off_arg: Option<OscArg> },
}

/// A mixer whose microphone channels MDstage switches.
#[derive(Clone, Debug, PartialEq)]
pub struct MicMixer {
    /// MIDI port, or OSC host and port, depending on the method.
    pub address: Address,
    pub method: MuteMethod,
}

/// A message with its destination, ready to send.
#[derive(Clone, Debug, PartialEq)]
pub enum Wire {
    Midi { port: String, bytes: Vec<u8>, then_off: Option<Vec<u8>> },
    Osc { host: String, port: u16, path: String, args: Vec<OscArg> },
    Http { url: String, method: String, body: Option<String>, content_type: Option<String> },
}

/// This machine's output settings.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outputs {
    pub devices: Vec<Device>,
    pub mixers: Vec<MicMixer>,
    /// Hold back everything: outputs are blocked by the operator, or the show file is
    /// not trusted yet (it could otherwise drive arbitrary devices on the network).
    pub blocked: bool,
}

fn fill(template: &str, channel: u64) -> String {
    template.replace("{ch}", &channel.to_string())
}

fn number(template: &str, channel: u64) -> Option<u8> {
    fill(template, channel).trim().parse::<i64>().ok().map(|n| n as u8)
}

fn hex_bytes(template: &str, channel: u64, value: u8) -> Vec<u8> {
    let filled = template.replace("{ch}", &format!("{channel:X}")).replace("{val}", &format!("{value:X}"));
    filled.split_whitespace().filter_map(|b| u8::from_str_radix(b, 16).ok()).collect()
}

impl Outputs {
    fn device(&self, name: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.name == name && d.enabled)
    }

    /// Mute messages for one mixer: every microphone channel on it, switched on if one
    /// of the roles in `open` uses it, muted otherwise.
    fn mixer_messages(&self, index: usize, mixer: &MicMixer, cast: &Cast, open: &[String]) -> Vec<Wire> {
        let mut channels: Vec<(u64, bool)> = Vec::new();
        for role in cast.roles.iter().filter(|r| r.mixer == index) {
            let Some(channel) = role.channel.filter(|&c| c > 0) else { continue };
            let is_open = open.contains(&role.name);
            match channels.iter_mut().find(|(c, _)| *c == channel) {
                Some(entry) => entry.1 |= is_open,
                None => channels.push((channel, is_open)),
            }
        }
        let mut wires = Vec::new();
        for (channel, on) in channels {
            let zero_based = channel - 1;
            let midi = |bytes: Vec<u8>, then_off: Option<Vec<u8>>| match &mixer.address {
                Address::Midi { port } => Some(Wire::Midi { port: port.clone(), bytes, then_off }),
                _ => None,
            };
            let wire = match &mixer.method {
                MuteMethod::X32 => midi(vec![0xB1, (zero_based & 0x7F) as u8, if on { 0 } else { 127 }], None),
                MuteMethod::MidiNote { channel: ch, note, on_velocity, off_velocity } => {
                    let status = number(ch, zero_based).map(|c| c.wrapping_sub(1) & 0x0F);
                    let velocity = if on { on_velocity } else { off_velocity } & 0x7F;
                    status.zip(number(note, zero_based)).and_then(|(c, n)| {
                        let off = (velocity > 0).then(|| vec![0x80 | c, n & 0x7F, 0]);
                        midi(vec![0x90 | c, n & 0x7F, velocity], off)
                    })
                }
                MuteMethod::MidiCc { channel: ch, controller, on_value, off_value } => {
                    let status = number(ch, zero_based).map(|c| c.wrapping_sub(1) & 0x0F);
                    let value = if on { on_value } else { off_value } & 0x7F;
                    status.zip(number(controller, zero_based)).and_then(|(c, n)| midi(vec![0xB0 | c, n & 0x7F, value], None))
                }
                MuteMethod::MidiProgram { channel: ch, on_program, off_program } => {
                    let program = if on { on_program } else { off_program } & 0x7F;
                    number(ch, zero_based).and_then(|c| midi(vec![0xC0 | (c.wrapping_sub(1) & 0x0F), program], None))
                }
                MuteMethod::MidiSysex { unmute, mute } => {
                    let bytes = hex_bytes(if on { unmute } else { mute }, zero_based, if on { 0x00 } else { 0x7F });
                    if bytes.is_empty() { None } else { midi(bytes, None) }
                }
                MuteMethod::Osc { on_path, on_arg, off_path, off_arg } => match &mixer.address {
                    Address::Osc { host, port } => Some(Wire::Osc {
                        host: host.clone(),
                        port: *port,
                        path: (if on { on_path } else { off_path }).replace("{ch}", &format!("{channel:02}")),
                        args: (if on { on_arg } else { off_arg }).clone().into_iter().collect(),
                    }),
                    _ => None,
                },
            };
            wires.extend(wire);
        }
        wires
    }

    /// The messages that carry out `effects` on this machine, in order. Display content
    /// and announcements are not wire messages; the display server takes those.
    pub fn wire(&self, effects: &[Effect], cast: &Cast) -> Vec<Wire> {
        if self.blocked {
            return Vec::new();
        }
        let mut wires = Vec::new();
        for effect in effects {
            match effect {
                Effect::Mic(mic) => {
                    let open = match cast.expand(mic) {
                        Mic::Open(names) => names,
                        Mic::MuteAll => Vec::new(),
                        Mic::Unchanged => continue,
                    };
                    for (index, mixer) in self.mixers.iter().enumerate() {
                        wires.extend(self.mixer_messages(index, mixer, cast, &open));
                    }
                }
                Effect::TriggerNote(note) => {
                    let ch = ((note.ch.clamp(1, 16) - 1) as u8) & 0x0F;
                    let key = note.note.min(127) as u8;
                    for device in self.devices.iter().filter(|d| d.enabled && d.trigger_notes) {
                        if let Address::Midi { port } = &device.address {
                            wires.push(Wire::Midi { port: port.clone(), bytes: vec![0x90 | ch, key, 100], then_off: Some(vec![0x80 | ch, key, 0]) });
                        }
                    }
                }
                Effect::TriggerOsc { path, args } => {
                    for device in self.devices.iter().filter(|d| d.enabled && d.trigger_notes) {
                        if let Address::Osc { host, port } = &device.address {
                            wires.push(Wire::Osc { host: host.clone(), port: *port, path: path.clone(), args: args.clone() });
                        }
                    }
                }
                Effect::Midi { device, bytes, then_off } => {
                    if let Some(Address::Midi { port }) = self.device(device).map(|d| &d.address) {
                        wires.push(Wire::Midi { port: port.clone(), bytes: bytes.clone(), then_off: then_off.clone() });
                    }
                }
                Effect::Osc { device, path, args } => {
                    if let Some(Address::Osc { host, port }) = self.device(device).map(|d| &d.address) {
                        wires.push(Wire::Osc { host: host.clone(), port: *port, path: path.clone(), args: args.clone() });
                    }
                }
                Effect::Http { device, method, path, body, content_type } => {
                    // The show file supplies method, path and content type: only real
                    // methods, and nothing that could break out of its line of the request.
                    let known = matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE");
                    let clean = |text: &str| !text.chars().any(char::is_control);
                    if !known || !clean(path) || !content_type.as_deref().is_none_or(clean) {
                        continue;
                    }
                    if let Some(Address::Http { url }) = self.device(device).map(|d| &d.address) {
                        let separator = if path.is_empty() || path.starts_with('/') { "" } else { "/" };
                        wires.push(Wire::Http {
                            url: format!("{}{separator}{path}", url.trim_end_matches('/')),
                            method: method.clone(),
                            // A body only goes out with methods that carry one.
                            body: body.clone().filter(|_| !matches!(method.as_str(), "GET" | "HEAD")),
                            content_type: content_type.clone(),
                        });
                    }
                }
                Effect::Announce { .. } | Effect::Display { .. } => {}
            }
        }
        wires
    }
}

/// Encode an OSC message: address, type tags and arguments, each padded to four bytes.
pub fn osc_packet(path: &str, args: &[OscArg]) -> Vec<u8> {
    fn padded(out: &mut Vec<u8>, text: &str) {
        out.extend_from_slice(text.as_bytes());
        out.push(0);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    let mut packet = Vec::new();
    padded(&mut packet, path);
    let tags: String = std::iter::once(',')
        .chain(args.iter().map(|a| match a {
            OscArg::Int(_) => 'i',
            OscArg::Float(_) => 'f',
            OscArg::Text(_) => 's',
        }))
        .collect();
    padded(&mut packet, &tags);
    for arg in args {
        match arg {
            OscArg::Int(i) => packet.extend_from_slice(&i.to_be_bytes()),
            OscArg::Float(f) => packet.extend_from_slice(&f.to_be_bytes()),
            OscArg::Text(s) => padded(&mut packet, s),
        }
    }
    packet
}

/// The address of an incoming OSC packet, if it is a plain message.
pub fn osc_address(packet: &[u8]) -> Option<&str> {
    if packet.first() != Some(&b'/') {
        return None;
    }
    let end = packet.iter().position(|&b| b == 0)?;
    let address = std::str::from_utf8(&packet[..end]).ok()?;
    address.chars().all(|c| (' '..='~').contains(&c)).then_some(address)
}

/// The cue a remote-trigger OSC packet asks for: `/cue/<ch>/<note>`.
pub fn osc_cue_trigger(packet: &[u8]) -> Option<mdstage_core::cues::Note> {
    let mut parts = osc_address(packet)?.strip_prefix("/cue/")?.split('/');
    let ch: u64 = parts.next()?.parse().ok()?;
    let note: u64 = parts.next()?.parse().ok()?;
    (parts.next().is_none() && (1..=16).contains(&ch) && note <= 127).then_some(mdstage_core::cues::Note { ch, note })
}

/// A MIDI destination; `midir` in the app, a recorder in tests.
pub trait MidiPorts: Send {
    /// Send bytes to the named port. Unknown or disconnected ports are ignored.
    fn send(&mut self, port: &str, bytes: &[u8]);
}

/// MIDI output ports of this machine, opened on first use.
#[derive(Default)]
pub struct SystemMidi {
    /// Open connections, and for ports that could not be opened when that was last tried.
    open: HashMap<String, std::result::Result<midir::MidiOutputConnection, Instant>>,
}

/// How long to wait before looking again for a port that was not there.
const PORT_RETRY: Duration = Duration::from_secs(2);

impl SystemMidi {
    /// Names of the MIDI output ports currently present.
    pub fn port_names() -> Vec<String> {
        let Ok(midi) = midir::MidiOutput::new("MDstage") else { return Vec::new() };
        midi.ports().iter().filter_map(|p| midi.port_name(p).ok()).collect()
    }

    /// Forget all connections (after devices were plugged or unplugged).
    pub fn reconnect(&mut self) {
        self.open.clear();
    }
}

impl MidiPorts for SystemMidi {
    fn send(&mut self, port: &str, bytes: &[u8]) {
        let connect = || {
            let midi = midir::MidiOutput::new("MDstage").ok()?;
            let found = midi.ports().into_iter().find(|p| midi.port_name(p).is_ok_and(|n| n == port))?;
            midi.connect(&found, "MDstage").ok()
        };
        // A device plugged in after the show started is picked up on a later send.
        let retry = match self.open.get(port) {
            None => true,
            Some(Err(tried)) => tried.elapsed() >= PORT_RETRY,
            Some(Ok(_)) => false,
        };
        if retry {
            self.open.insert(port.to_string(), connect().ok_or_else(Instant::now));
        }
        if let Some(Ok(connection)) = self.open.get_mut(port) {
            if connection.send(bytes).is_err() {
                // The device went away; look for it again next time.
                self.open.remove(port);
            }
        }
    }
}

/// Puts wire messages on the wire. Sending never blocks the caller: MIDI and OSC go out
/// from a worker thread in order, note offs follow after their delay, and every HTTP
/// request gets a thread of its own.
pub struct Sender {
    queue: Channel<Wire>,
}

impl Sender {
    pub fn new(mut midi: impl MidiPorts + 'static) -> std::io::Result<Sender> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        let (queue, incoming) = channel::<Wire>();
        thread::Builder::new().name("mdstage-outputs".into()).spawn(move || {
            let mut note_offs: Vec<(Instant, String, Vec<u8>)> = Vec::new();
            loop {
                let wait = note_offs.iter().map(|n| n.0).min().map(|due| due.saturating_duration_since(Instant::now()));
                let wire = match wait {
                    Some(wait) => match incoming.recv_timeout(wait) {
                        Ok(wire) => Some(wire),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    },
                    None => match incoming.recv() {
                        Ok(wire) => Some(wire),
                        Err(_) => break,
                    },
                };
                match wire {
                    Some(Wire::Midi { port, bytes, then_off }) => {
                        midi.send(&port, &bytes);
                        if let Some(off) = then_off {
                            note_offs.push((Instant::now() + NOTE_LENGTH, port, off));
                        }
                    }
                    Some(Wire::Osc { host, port, path, args }) => {
                        let _ = socket.send_to(&osc_packet(&path, &args), (host.as_str(), port));
                    }
                    Some(Wire::Http { url, method, body, content_type }) => {
                        let _ = thread::Builder::new().name("mdstage-http".into()).spawn(move || {
                            let request = ureq::request(&method, &url).timeout(HTTP_TIMEOUT);
                            let result = match body {
                                Some(body) => request.set("Content-Type", content_type.as_deref().unwrap_or("text/plain")).send_string(&body),
                                None => request.call(),
                            };
                            if let Err(e) = result {
                                eprintln!("http {method} {url}: {e}");
                            }
                        });
                    }
                    None => {}
                }
                let now = Instant::now();
                note_offs.retain(|(due, port, bytes)| {
                    if *due <= now {
                        midi.send(port, bytes);
                    }
                    *due > now
                });
            }
            // Leave no note hanging when the app shuts down.
            for (_, port, bytes) in note_offs {
                midi.send(&port, &bytes);
            }
        })?;
        Ok(Sender { queue })
    }

    pub fn send(&self, wires: Vec<Wire>) {
        for wire in wires {
            let _ = self.queue.send(wire);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdstage_core::Script;
    use mdstage_core::cues::Note;
    use std::sync::{Arc, Mutex};

    fn cast() -> Cast {
        let text = "```yaml\nconfig:\n    roles:\n        Anna: {ch: 3}\n        Ben: {ch: 5}\n        Clara: {ch: 3}\n        Dora: {ch: 2, device: 1}\n        Extra: {}\n    groups:\n        Duo: {roles: [Anna, Ben]}\n```\n";
        Cast::from_script(&Script::parse(text), false)
    }

    fn midi(port: &str) -> Address {
        Address::Midi { port: port.into() }
    }

    fn open(names: &[&str]) -> Effect {
        Effect::Mic(Mic::Open(names.iter().map(|n| n.to_string()).collect()))
    }

    #[test]
    fn x32_mutes_every_channel_that_is_not_open() {
        let outputs = Outputs {
            mixers: vec![MicMixer { address: midi("X32"), method: MuteMethod::X32 }, MicMixer { address: midi("Stagebox"), method: MuteMethod::X32 }],
            ..Default::default()
        };
        let wire = |port: &str, controller: u8, value: u8| Wire::Midi { port: port.into(), bytes: vec![0xB1, controller, value], then_off: None };
        // Ben's channel opens; Anna and Clara share channel 3, which stays muted.
        assert_eq!(outputs.wire(&[open(&["Ben"])], &cast()), [wire("X32", 2, 127), wire("X32", 4, 0), wire("Stagebox", 1, 127)]);
        // A shared channel is open as soon as one of its roles is.
        assert_eq!(outputs.wire(&[open(&["Clara", "Dora"])], &cast()), [wire("X32", 2, 0), wire("X32", 4, 127), wire("Stagebox", 1, 0)]);
        assert_eq!(outputs.wire(&[open(&["Duo"])], &cast())[..2], [wire("X32", 2, 0), wire("X32", 4, 0)]);
        assert_eq!(outputs.wire(&[Effect::Mic(Mic::MuteAll)], &cast()), [wire("X32", 2, 127), wire("X32", 4, 127), wire("Stagebox", 1, 127)]);
        assert!(outputs.wire(&[Effect::Mic(Mic::Unchanged)], &cast()).is_empty());
    }

    #[test]
    fn custom_mute_methods() {
        let one = |method: MuteMethod, address: Address| Outputs { mixers: vec![MicMixer { address, method }], ..Default::default() };
        let cast = cast();
        let anna = [open(&["Anna"])];

        let note = one(MuteMethod::MidiNote { channel: "1".into(), note: "{ch}".into(), on_velocity: 127, off_velocity: 0 }, midi("Desk"));
        assert_eq!(
            note.wire(&anna, &cast),
            [
                Wire::Midi { port: "Desk".into(), bytes: vec![0x90, 2, 127], then_off: Some(vec![0x80, 2, 0]) },
                Wire::Midi { port: "Desk".into(), bytes: vec![0x90, 4, 0], then_off: None },
            ]
        );
        let cc = one(MuteMethod::MidiCc { channel: "2".into(), controller: "{ch}".into(), on_value: 1, off_value: 0 }, midi("Desk"));
        assert_eq!(cc.wire(&anna, &cast)[0], Wire::Midi { port: "Desk".into(), bytes: vec![0xB1, 2, 1], then_off: None });
        let program = one(MuteMethod::MidiProgram { channel: "{ch}".into(), on_program: 0, off_program: 1 }, midi("Desk"));
        assert_eq!(program.wire(&anna, &cast)[1], Wire::Midi { port: "Desk".into(), bytes: vec![0xC3, 1], then_off: None });
        let sysex = one(MuteMethod::MidiSysex { unmute: "F0 {ch} {val} F7".into(), mute: "F0 {ch} {val} F7".into() }, midi("Desk"));
        assert_eq!(sysex.wire(&anna, &cast)[1], Wire::Midi { port: "Desk".into(), bytes: vec![0xF0, 4, 0x7F, 0xF7], then_off: None });

        let osc = one(
            MuteMethod::Osc { on_path: "/ch/{ch}/mix/on".into(), on_arg: Some(OscArg::Int(1)), off_path: "/ch/{ch}/mix/on".into(), off_arg: Some(OscArg::Int(0)) },
            Address::Osc { host: "192.168.1.1".into(), port: 10023 },
        );
        assert_eq!(
            osc.wire(&anna, &cast),
            [
                Wire::Osc { host: "192.168.1.1".into(), port: 10023, path: "/ch/03/mix/on".into(), args: vec![OscArg::Int(1)] },
                Wire::Osc { host: "192.168.1.1".into(), port: 10023, path: "/ch/05/mix/on".into(), args: vec![OscArg::Int(0)] },
            ]
        );
        // A method that does not match the address sends nothing.
        assert!(one(MuteMethod::X32, Address::Osc { host: "h".into(), port: 1 }).wire(&anna, &cast).is_empty());
    }

    #[test]
    fn addresses_cue_messages_to_configured_devices() {
        let device = |name: &str, address: Address, enabled: bool, trigger_notes: bool| Device { name: name.into(), address, enabled, trigger_notes };
        let mut outputs = Outputs {
            devices: vec![
                device("Licht", midi("DMX Interface"), true, true),
                device("Ton", midi("Desk"), true, false),
                device("Aus", midi("Off"), false, true),
                device("QLab", Address::Osc { host: "10.0.0.5".into(), port: 53000 }, true, true),
                device("Pult", Address::Http { url: "http://10.0.0.9:8080/".into() }, true, false),
            ],
            ..Default::default()
        };
        let http = |method: &str, path: &str, body: Option<&str>| Effect::Http { device: "Pult".into(), method: method.into(), path: path.into(), body: body.map(str::to_string), content_type: None };
        let effects = [
            Effect::TriggerNote(Note { ch: 2, note: 42 }),
            Effect::TriggerOsc { path: "/mdstage/triggernote/2/42".into(), args: vec![] },
            Effect::Midi { device: "Ton".into(), bytes: vec![0xC0, 5], then_off: None },
            Effect::Midi { device: "Aus".into(), bytes: vec![0xC0, 6], then_off: None },
            Effect::Midi { device: "Unbekannt".into(), bytes: vec![0xC0, 7], then_off: None },
            Effect::Osc { device: "QLab".into(), path: "/go".into(), args: vec![OscArg::Float(0.5)] },
            Effect::Osc { device: "Licht".into(), path: "/wrong-kind".into(), args: vec![] },
            http("POST", "api/scene/3", Some("x")),
            http("GET", "/status", Some("ignored")),
            Effect::Announce { device: "Foyer".into(), text: "Hi".into() },
            Effect::Display { device: "Foyer".into(), markdown: "Hi".into() },
        ];
        let osc = |path: &str, args: Vec<OscArg>| Wire::Osc { host: "10.0.0.5".into(), port: 53000, path: path.into(), args };
        assert_eq!(
            outputs.wire(&effects, &cast()),
            [
                Wire::Midi { port: "DMX Interface".into(), bytes: vec![0x91, 42, 100], then_off: Some(vec![0x81, 42, 0]) },
                osc("/mdstage/triggernote/2/42", vec![]),
                Wire::Midi { port: "Desk".into(), bytes: vec![0xC0, 5], then_off: None },
                osc("/go", vec![OscArg::Float(0.5)]),
                Wire::Http { url: "http://10.0.0.9:8080/api/scene/3".into(), method: "POST".into(), body: Some("x".into()), content_type: None },
                Wire::Http { url: "http://10.0.0.9:8080/status".into(), method: "GET".into(), body: None, content_type: None },
            ]
        );
        // What a show file must not smuggle into a request: made-up methods, line breaks.
        let odd_type = Effect::Http { device: "Pult".into(), method: "POST".into(), path: "/a".into(), body: Some("x".into()), content_type: Some("text/plain\r\nX-Evil: 1".into()) };
        assert!(outputs.wire(&[http("GET\r\nX-Evil: 1", "/a", None), http("TRACE", "/a", None), http("GET", "/a\r\nX-Evil: 1", None), odd_type], &cast()).is_empty());
        outputs.blocked = true;
        assert!(outputs.wire(&effects, &cast()).is_empty(), "blocked outputs send nothing at all");
    }

    #[test]
    fn encodes_and_reads_osc() {
        assert_eq!(osc_packet("/go", &[]), b"/go\0,\0\0\0");
        assert_eq!(
            osc_packet("/cue/1", &[OscArg::Int(1), OscArg::Float(0.5), OscArg::Text("hey".into())]),
            b"/cue/1\0\0,ifs\0\0\0\0\0\0\0\x01\x3f\0\0\0hey\0"
        );
        assert_eq!(osc_address(&osc_packet("/cue/1/42", &[OscArg::Int(7)])), Some("/cue/1/42"));
        assert_eq!(osc_address(b"cue"), None);
        assert_eq!(osc_address(b"/unterminated"), None);

        let note = |path: &str| osc_cue_trigger(&osc_packet(path, &[]));
        assert_eq!(note("/cue/1/42"), Some(Note { ch: 1, note: 42 }));
        assert_eq!(note("/cue/16/0"), Some(Note { ch: 16, note: 0 }));
        for bad in ["/cue/0/1", "/cue/17/1", "/cue/1/128", "/cue/1", "/cue/1/2/3", "/cue/a/b", "/go"] {
            assert_eq!(note(bad), None, "{bad}");
        }
    }

    struct Recorder(Arc<Mutex<Vec<(Instant, String, Vec<u8>)>>>);

    impl MidiPorts for Recorder {
        fn send(&mut self, port: &str, bytes: &[u8]) {
            self.0.lock().unwrap().push((Instant::now(), port.to_string(), bytes.to_vec()));
        }
    }

    #[test]
    fn sender_delivers_osc_and_times_note_offs() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = receiver.local_addr().unwrap().port();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sender = Sender::new(Recorder(sent.clone())).unwrap();

        sender.send(vec![
            Wire::Midi { port: "Desk".into(), bytes: vec![0x90, 60, 100], then_off: Some(vec![0x80, 60, 0]) },
            Wire::Midi { port: "Desk".into(), bytes: vec![0xC0, 5], then_off: None },
            Wire::Osc { host: "127.0.0.1".into(), port, path: "/cue/1/42".into(), args: vec![OscArg::Int(3)] },
        ]);
        let mut buf = [0u8; 64];
        let (len, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..len], osc_packet("/cue/1/42", &[OscArg::Int(3)]));
        assert_eq!(osc_cue_trigger(&buf[..len]), Some(Note { ch: 1, note: 42 }));

        thread::sleep(Duration::from_millis(250));
        let sent = sent.lock().unwrap();
        let bytes: Vec<&[u8]> = sent.iter().map(|(_, _, b)| b.as_slice()).collect();
        assert_eq!(bytes, [&[0x90, 60, 100][..], &[0xC0, 5], &[0x80, 60, 0]], "in order, the note off last");
        let held = sent[2].0 - sent[0].0;
        assert!(held >= NOTE_LENGTH && held < NOTE_LENGTH * 2, "note held for {held:?}");
    }
}
