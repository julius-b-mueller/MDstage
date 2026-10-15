//! Remote control coming in: MIDI notes and OSC messages for Go, Back and the live view's
//! ▲ ▼, and cues fired by their trigger note over MIDI or OSC (`/cue/<ch>/<note>`).

use std::net::UdpSocket;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use mdstage_core::cues::Note;

use crate::outputs::{osc_address, osc_cue_trigger, osc_first_number};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Go,
    /// The Back note was pressed. Nothing happens yet: Back is what letting go of it
    /// does, and held for a while instead it stops everything.
    BackPressed,
    BackReleased,
    /// Back at once (an OSC command: it has no holding).
    Back,
    /// Arm the cue before or after the next Go (the live view's ▲ ▼).
    Up,
    Down,
    /// Fire the cue with this trigger note, whatever the position.
    Cue(Note),
    /// Any note that came in, for "MIDI learn" in the settings.
    Heard(Note),
}

/// Where cue triggers are accepted from.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum CueTrigger {
    #[default]
    Off,
    /// Note-ons on this MIDI input port.
    Midi { port: String },
    /// OSC on this UDP port; `network` listens on all interfaces instead of only locally.
    Osc { port: u16, network: bool },
}

/// Go, Back, ▲ and ▼ over OSC: the UDP port to listen on and the address of each command
/// (an empty one is not listened for).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OscControl {
    pub port: u16,
    /// Listen on all interfaces instead of only on this computer.
    pub network: bool,
    pub go: String,
    pub back: String,
    pub up: String,
    pub down: String,
}

impl OscControl {
    /// What an OSC packet means. A command with a number of 0 as its first argument is
    /// a button being let go of (as many controllers send it) and does nothing.
    pub fn input(&self, packet: &[u8]) -> Option<Input> {
        let address = osc_address(packet)?;
        if osc_first_number(packet) == Some(0.0) {
            return None;
        }
        [(&self.go, Input::Go), (&self.back, Input::Back), (&self.up, Input::Up), (&self.down, Input::Down)]
            .into_iter()
            .find(|(path, _)| !path.trim().is_empty() && path.trim() == address)
            .map(|(_, input)| input)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InputSettings {
    pub go: Option<Note>,
    pub back: Option<Note>,
    /// Notes for the live view's ▲ and ▼.
    pub up: Option<Note>,
    pub down: Option<Note>,
    pub osc_control: Option<OscControl>,
    /// MIDI input port for Go/Back; `None` listens on all ports.
    pub control_port: Option<String>,
    pub cue_trigger: CueTrigger,
}

/// The note of a note-off message (or a note-on with velocity zero), with a 1-based channel.
fn note_off(bytes: &[u8]) -> Option<Note> {
    match bytes {
        [status, note, velocity, ..] if status & 0xF0 == 0x80 || (status & 0xF0 == 0x90 && *velocity == 0) => {
            Some(Note { ch: (status & 0x0F) as u64 + 1, note: *note as u64 })
        }
        _ => None,
    }
}

/// The note of a note-on message (velocity above zero), with a 1-based channel.
fn note_on(bytes: &[u8]) -> Option<Note> {
    match bytes {
        [status, note, velocity, ..] if status & 0xF0 == 0x90 && *velocity > 0 => {
            Some(Note { ch: (status & 0x0F) as u64 + 1, note: *note as u64 })
        }
        _ => None,
    }
}

impl InputSettings {
    /// What a MIDI message arriving on `port` means.
    pub fn midi(&self, port: &str, bytes: &[u8]) -> Vec<Input> {
        let from_control = self.control_port.as_deref().is_none_or(|p| p == port);
        if note_off(bytes).is_some_and(|note| from_control && self.back == Some(note)) {
            return vec![Input::BackReleased];
        }
        let Some(note) = note_on(bytes) else { return Vec::new() };
        let mut inputs = vec![Input::Heard(note)];
        if self.control_port.as_deref().is_none_or(|p| p == port) {
            if self.go == Some(note) {
                inputs.push(Input::Go);
            } else if self.back == Some(note) {
                inputs.push(Input::BackPressed);
            } else if self.up == Some(note) {
                inputs.push(Input::Up);
            } else if self.down == Some(note) {
                inputs.push(Input::Down);
            }
        }
        if matches!(&self.cue_trigger, CueTrigger::Midi { port: p } if p == port) {
            inputs.push(Input::Cue(note));
        }
        inputs
    }
}

/// Open inputs. Dropping this closes them.
pub struct Inputs {
    _midi: Vec<midir::MidiInputConnection<()>>,
    /// The MIDI input ports that were there when these inputs were opened.
    ports: Vec<String>,
    running: Arc<AtomicBool>,
    /// The threads that listen for OSC: cue triggers and control commands (one, if they
    /// share a port).
    osc: Vec<thread::JoinHandle<()>>,
}

impl Inputs {
    /// Names of the MIDI input ports currently present.
    pub fn port_names() -> Vec<String> {
        let Ok(midi) = midir::MidiInput::new("MDstage") else { return Vec::new() };
        midi.ports().iter().filter_map(|p| midi.port_name(p).ok()).collect()
    }

    /// Listen as configured and send what comes in to `events`. Ports that cannot be
    /// opened are skipped; an OSC port that cannot be bound is reported as an error.
    pub fn open(settings: &InputSettings, events: Sender<Input>) -> std::io::Result<Inputs> {
        let (connections, ports) = Self::connect_midi(settings, &events);

        let running = Arc::new(AtomicBool::new(true));
        let mut inputs = Inputs { _midi: connections, ports, running: running.clone(), osc: Vec::new() };
        // The ports to listen on, and on each whether cue triggers and which commands
        // come in there.
        let mut listen: Vec<(u16, bool, bool, Option<OscControl>)> = Vec::new();
        if let CueTrigger::Osc { port, network } = settings.cue_trigger {
            listen.push((port, network, true, None));
        }
        if let Some(control) = settings.osc_control.clone().filter(|c| c.port > 0) {
            match listen.iter_mut().find(|(port, ..)| *port == control.port) {
                Some(shared) => {
                    shared.1 |= control.network;
                    shared.3 = Some(control);
                }
                None => listen.push((control.port, control.network, false, Some(control))),
            }
        }
        for (port, network, cues, control) in listen {
            // (Should binding fail, the inputs opened so far close again when dropped.)
            let socket = UdpSocket::bind((if network { "0.0.0.0" } else { "127.0.0.1" }, port))?;
            socket.set_read_timeout(Some(Duration::from_millis(50)))?;
            let (flag, events) = (running.clone(), events.clone());
            inputs.osc.push(thread::Builder::new().name("mdstage-osc-in".into()).spawn(move || {
                let mut packet = [0u8; 1024];
                while flag.load(SeqCst) {
                    let Ok((len, _)) = socket.recv_from(&mut packet) else { continue };
                    let packet = &packet[..len];
                    let input = control.as_ref().and_then(|c| c.input(packet)).or_else(|| osc_cue_trigger(packet).filter(|_| cues).map(Input::Cue));
                    if let Some(input) = input {
                        let _ = events.send(input);
                    }
                }
            })?);
        }
        Ok(inputs)
    }

    /// A MIDI device was plugged in or pulled out: listen on the ports that are there
    /// now. Only the MIDI side is opened again; the OSC port stays as it is.
    pub fn rescan_midi(&mut self, settings: &InputSettings, events: &Sender<Input>) {
        self._midi.clear(); // close the old ports before opening them again
        (self._midi, self.ports) = Self::connect_midi(settings, events);
    }

    /// Open every MIDI input port that is there; returns the connections and the names
    /// of the ports that were found.
    fn connect_midi(settings: &InputSettings, events: &Sender<Input>) -> (Vec<midir::MidiInputConnection<()>>, Vec<String>) {
        let mut connections = Vec::new();
        let ports = Self::port_names();
        for name in ports.clone() {
            let Ok(mut midi) = midir::MidiInput::new("MDstage") else { continue };
            midi.ignore(midir::Ignore::All);
            let Some(port) = midi.ports().into_iter().find(|p| midi.port_name(p).is_ok_and(|n| n == name)) else { continue };
            let (settings, events, port_name) = (settings.clone(), events.clone(), name.clone());
            let connection = midi.connect(
                &port,
                "MDstage",
                move |_, bytes, _| {
                    for input in settings.midi(&port_name, bytes) {
                        let _ = events.send(input);
                    }
                },
                (),
            );
            connections.extend(connection.ok());
        }
        (connections, ports)
    }

    /// A MIDI device was plugged in or pulled out since these inputs were opened (see
    /// [`Inputs::rescan_midi`]).
    pub fn ports_changed(&self) -> bool {
        Self::port_names() != self.ports
    }
}

impl Drop for Inputs {
    fn drop(&mut self) {
        self.running.store(false, SeqCst);
        // Wait for the OSC thread to let go of its port, so that inputs opened right
        // after these can bind it again (it looks at the flag every 50 ms).
        for thread in self.osc.drain(..) {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outputs::osc_packet;
    use std::sync::mpsc::channel;

    fn note(ch: u64, note: u64) -> Note {
        Note { ch, note }
    }

    #[test]
    fn classifies_midi() {
        let settings = InputSettings {
            go: Some(note(1, 36)),
            back: Some(note(1, 37)),
            control_port: None,
            cue_trigger: CueTrigger::Midi { port: "Pult".into() },
            ..Default::default()
        };
        assert_eq!(settings.midi("Pedal", &[0x90, 36, 100]), [Input::Heard(note(1, 36)), Input::Go]);
        assert_eq!(settings.midi("Pedal", &[0x90, 37, 1]), [Input::Heard(note(1, 37)), Input::BackPressed]);
        assert_eq!(settings.midi("Pedal", &[0x91, 36, 100]), [Input::Heard(note(2, 36))], "other channel");
        assert!(settings.midi("Pedal", &[0x90, 36, 0]).is_empty(), "velocity 0 is a note off");
        assert!(settings.midi("Pedal", &[0x80, 36, 64]).is_empty());
        // Letting go of Back is told apart, so that holding it can be noticed.
        assert_eq!(settings.midi("Pedal", &[0x80, 37, 0]), [Input::BackReleased]);
        assert_eq!(settings.midi("Pedal", &[0x90, 37, 0]), [Input::BackReleased]);
        assert!(settings.midi("Pedal", &[0xB0, 36, 127]).is_empty());
        // On the cue-trigger port a note fires its cue — and still works as Go if it is the Go note.
        assert_eq!(settings.midi("Pult", &[0x93, 42, 90]), [Input::Heard(note(4, 42)), Input::Cue(note(4, 42))]);
        assert_eq!(settings.midi("Pult", &[0x90, 36, 90]), [Input::Heard(note(1, 36)), Input::Go, Input::Cue(note(1, 36))]);

        let filtered = InputSettings { control_port: Some("Pedal".into()), ..settings };
        assert_eq!(filtered.midi("Keyboard", &[0x90, 36, 100]), [Input::Heard(note(1, 36))], "Go only from the chosen port");
    }

    #[test]
    fn go_back_up_and_down_over_midi_and_osc() {
        let settings = InputSettings { up: Some(note(1, 40)), down: Some(note(1, 41)), ..Default::default() };
        assert_eq!(settings.midi("Pedal", &[0x90, 40, 100]), [Input::Heard(note(1, 40)), Input::Up]);
        assert_eq!(settings.midi("Pedal", &[0x90, 41, 100]), [Input::Heard(note(1, 41)), Input::Down]);

        let control = OscControl { port: 1, network: false, go: "/go".into(), back: "/back".into(), up: "/up".into(), down: String::new() };
        assert_eq!(control.input(&osc_packet("/go", &[])), Some(Input::Go));
        assert_eq!(control.input(&osc_packet("/back", &[mdstage_core::effects::OscArg::Float(1.0)])), Some(Input::Back));
        assert_eq!(control.input(&osc_packet("/up", &[mdstage_core::effects::OscArg::Int(1)])), Some(Input::Up));
        assert_eq!(control.input(&osc_packet("/go", &[mdstage_core::effects::OscArg::Float(0.0)])), None, "a button let go of");
        assert_eq!(control.input(&osc_packet("/go/more", &[])), None);
        assert_eq!(control.input(&osc_packet("/", &[])), None, "an empty command is not listened for");
    }

    #[test]
    fn control_commands_share_the_port_of_cue_triggers() {
        let port = UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (events, received) = channel();
        let control = OscControl { port, network: false, go: "/mdstage/go".into(), ..Default::default() };
        let settings = InputSettings { cue_trigger: CueTrigger::Osc { port, network: false }, osc_control: Some(control), ..Default::default() };
        let inputs = Inputs::open(&settings, events).unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(&osc_packet("/mdstage/go", &[]), ("127.0.0.1", port)).unwrap();
        sender.send_to(&osc_packet("/cue/1/5", &[]), ("127.0.0.1", port)).unwrap();
        let got: Vec<Input> = std::iter::from_fn(|| received.recv_timeout(Duration::from_secs(2)).ok()).take(2).collect();
        assert_eq!(got, [Input::Go, Input::Cue(note(1, 5))]);
        drop(inputs);
    }

    #[test]
    fn receives_cue_triggers_over_osc() {
        // Find a free port, then listen on it.
        let port = UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (events, received) = channel();
        let settings = InputSettings { cue_trigger: CueTrigger::Osc { port, network: false }, ..Default::default() };
        let inputs = Inputs::open(&settings, events).unwrap();

        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(&osc_packet("/something/else", &[]), ("127.0.0.1", port)).unwrap();
        sender.send_to(&osc_packet("/cue/2/42", &[]), ("127.0.0.1", port)).unwrap();
        let first_cue = std::iter::from_fn(|| received.recv_timeout(Duration::from_secs(2)).ok()).find(|i| matches!(i, Input::Cue(_)));
        assert_eq!(first_cue, Some(Input::Cue(note(2, 42))));
        drop(inputs);
    }
}
