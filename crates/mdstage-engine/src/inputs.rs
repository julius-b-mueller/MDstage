//! Remote control coming in: MIDI notes for Go and Back, and cues fired by their trigger
//! note over MIDI or OSC (`/cue/<ch>/<note>`).

use std::net::UdpSocket;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use mdstage_core::cues::Note;

use crate::outputs::osc_cue_trigger;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Go,
    Back,
    /// The Back note was let go of. Held for a while instead, it stops everything.
    BackReleased,
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InputSettings {
    pub go: Option<Note>,
    pub back: Option<Note>,
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
                inputs.push(Input::Back);
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

        let running = Arc::new(AtomicBool::new(true));
        if let CueTrigger::Osc { port, network } = settings.cue_trigger {
            let socket = UdpSocket::bind((if network { "0.0.0.0" } else { "127.0.0.1" }, port))?;
            socket.set_read_timeout(Some(Duration::from_millis(200)))?;
            let flag = running.clone();
            thread::Builder::new().name("mdstage-osc-in".into()).spawn(move || {
                let mut packet = [0u8; 1024];
                while flag.load(SeqCst) {
                    if let Ok((len, _)) = socket.recv_from(&mut packet) {
                        if let Some(note) = osc_cue_trigger(&packet[..len]) {
                            let _ = events.send(Input::Cue(note));
                        }
                    }
                }
            })?;
        }
        Ok(Inputs { _midi: connections, ports, running })
    }

    /// A MIDI device was plugged in or pulled out since these inputs were opened: they
    /// have to be opened again to hear the new one.
    pub fn ports_changed(&self) -> bool {
        Self::port_names() != self.ports
    }
}

impl Drop for Inputs {
    fn drop(&mut self) {
        self.running.store(false, SeqCst);
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
        };
        assert_eq!(settings.midi("Pedal", &[0x90, 36, 100]), [Input::Heard(note(1, 36)), Input::Go]);
        assert_eq!(settings.midi("Pedal", &[0x90, 37, 1]), [Input::Heard(note(1, 37)), Input::Back]);
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
