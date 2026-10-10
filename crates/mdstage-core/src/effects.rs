//! What firing a cue sends to the outside world, as plain data. The engine delivers it.

use serde_yaml_ng::Value;

use crate::Cue;
use crate::cues::{DeviceKind, DeviceState, DeviceStates, Note};
use crate::mic::Mic;

#[derive(Clone, Debug, PartialEq)]
pub enum OscArg {
    Int(i32),
    Float(f32),
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Set the microphones (group names not yet expanded).
    Mic(Mic),
    /// The cue's trigger note, for every MIDI device that wants trigger notes
    /// (note on, note off 100 ms later).
    TriggerNote(Note),
    /// An OSC message for every OSC device that wants trigger notes.
    TriggerOsc { path: String, args: Vec<OscArg> },
    /// Raw MIDI for one named device. `then_off` follows 100 ms later (the note off).
    Midi { device: String, bytes: Vec<u8>, then_off: Option<Vec<u8>> },
    Osc { device: String, path: String, args: Vec<OscArg> },
    Http { device: String, method: String, path: String, body: Option<String>, content_type: Option<String> },
    /// Text for a display device's clients to speak.
    Announce { device: String, text: String },
    /// A display device's content changed; empty markdown clears it.
    Display { device: String, markdown: String },
}

/// A number from a YAML value that may be written as a number or as text.
fn integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn data_byte(value: Option<&Value>, default: i64) -> u8 {
    integer(value).unwrap_or(default).clamp(0, 127) as u8
}

/// Status-byte channel nibble from a 1-based `ch` field (default channel 1).
fn channel(message: &Value) -> u8 {
    ((integer(message.get("ch")).filter(|&c| c != 0).unwrap_or(1) - 1) & 0x0F) as u8
}

/// MIDI bytes of one `cue_midi` message, and the note off that follows a note.
pub fn midi_bytes(message: &Value) -> Option<(Vec<u8>, Option<Vec<u8>>)> {
    let ch = channel(message);
    match message.get("type")?.as_str()? {
        "note" => {
            let note = data_byte(message.get("note"), 0);
            let velocity = data_byte(message.get("vel"), 100);
            Some((vec![0x90 | ch, note, velocity], Some(vec![0x80 | ch, note, 0])))
        }
        "cc" => Some((vec![0xB0 | ch, data_byte(message.get("cc"), 0), data_byte(message.get("value"), 0)], None)),
        "pc" => Some((vec![0xC0 | ch, data_byte(message.get("program"), 0)], None)),
        "sysex" => {
            let hex = text(message.get("bytes"))?;
            let bytes: Vec<u8> = hex.split_whitespace().filter_map(|h| u8::from_str_radix(h, 16).ok()).collect();
            (!bytes.is_empty()).then_some((bytes, None))
        }
        _ => None,
    }
}

/// A valid OSC address: `/` followed by printable ASCII.
pub fn is_osc_path(path: &str) -> bool {
    path.starts_with('/') && path.chars().all(|c| (' '..='~').contains(&c))
}

fn osc_args(arg: Option<&Value>, kind: Option<&Value>) -> Vec<OscArg> {
    let Some(arg) = text(arg).filter(|a| !a.trim().is_empty()) else { return Vec::new() };
    let arg = arg.trim();
    vec![match kind.and_then(Value::as_str).unwrap_or("string") {
        "int" => OscArg::Int(arg.parse::<f64>().map_or(0, |f| f as i32)),
        "float" => OscArg::Float(arg.parse().unwrap_or(0.0)),
        _ => OscArg::Text(arg.to_string()),
    }]
}

fn device(message: &Value) -> Option<String> {
    message.get("device").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string)
}

/// The effects of a list of per-device messages. Messages without a device, with an
/// invalid OSC path or of an unknown MIDI type send nothing.
pub fn message_effects(kind: DeviceKind, messages: &[Value]) -> Vec<Effect> {
    messages
        .iter()
        .filter_map(|message| {
            let device = device(message)?;
            match kind {
                DeviceKind::Midi => {
                    let (bytes, then_off) = midi_bytes(message)?;
                    Some(Effect::Midi { device, bytes, then_off })
                }
                DeviceKind::Osc => {
                    let path = text(message.get("path"))?.trim().to_string();
                    is_osc_path(&path).then(|| Effect::Osc { device, path, args: osc_args(message.get("arg"), message.get("arg_type")) })
                }
                DeviceKind::Http => Some(Effect::Http {
                    device,
                    method: text(message.get("method")).unwrap_or_else(|| "GET".into()).to_uppercase(),
                    path: text(message.get("path")).unwrap_or_default(),
                    body: text(message.get("body")).filter(|b| !b.is_empty()),
                    content_type: text(message.get("content_type")),
                }),
                DeviceKind::Display => None,
            }
        })
        .collect()
}

impl Cue {
    fn list(&self, key: &str) -> &[Value] {
        match self.field(key) {
            Some(Value::Sequence(list)) => list,
            _ => &[],
        }
    }

    /// Everything the cue sends when it fires, apart from microphones, audio and display
    /// content: trigger note, OSC, and the per-device MIDI/OSC/HTTP messages and announcements.
    pub fn fire_effects(&self) -> Vec<Effect> {
        let mut effects = Vec::new();
        let note = self.note();
        effects.extend(note.map(Effect::TriggerNote));

        // The `osc` field, or failing that the trigger note as an OSC path.
        match text(self.field("osc")) {
            Some(path) => effects.push(Effect::TriggerOsc { path, args: osc_args(self.field("osc_arg"), self.field("osc_arg_type")) }),
            None => effects.extend(note.map(|n| Effect::TriggerOsc { path: format!("/mdstage/triggernote/{}/{}", n.ch, n.note), args: Vec::new() })),
        }

        effects.extend(message_effects(DeviceKind::Midi, self.list("cue_midi")));
        effects.extend(message_effects(DeviceKind::Osc, self.list("cue_osc")));
        effects.extend(message_effects(DeviceKind::Http, self.list("cue_http")));
        for message in self.list("cue_display") {
            let announce = text(message.get("announce")).filter(|a| !a.trim().is_empty());
            if let (Some(device), Some(text)) = (device(message), announce) {
                effects.push(Effect::Announce { device, text });
            }
        }
        effects
    }
}

/// The messages that put devices back into the given states (after a Back). Display
/// states are not included: their content is recomputed, never re-sent as a message.
pub fn resend_effects(states: &DeviceStates) -> Vec<Effect> {
    states
        .iter()
        .flat_map(|((kind, _), state)| match state {
            DeviceState::Messages(messages) => message_effects(*kind, messages),
            DeviceState::Display(_) => Vec::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Block, Script};

    fn cue(yaml: &str) -> Cue {
        match Script::parse(&format!("```yaml\n{yaml}\n```\n")).blocks.remove(0) {
            Block::Cue(cue) => cue,
            other => panic!("expected a cue, got {other:?}"),
        }
    }

    fn value(yaml: &str) -> Value {
        serde_yaml_ng::from_str(yaml).unwrap()
    }

    #[test]
    fn encodes_midi_messages() {
        assert_eq!(midi_bytes(&value("{type: note, ch: 1, note: 42, vel: 100}")), Some((vec![0x90, 42, 100], Some(vec![0x80, 42, 0]))));
        assert_eq!(midi_bytes(&value("{type: note, ch: 16, note: 200}")), Some((vec![0x9F, 127, 100], Some(vec![0x8F, 127, 0]))), "clamped; velocity defaults to 100");
        assert_eq!(midi_bytes(&value("{type: cc, ch: 2, cc: 7, value: 64}")), Some((vec![0xB1, 7, 64], None)));
        assert_eq!(midi_bytes(&value("{type: cc, cc: '7'}")), Some((vec![0xB0, 7, 0], None)), "text numbers, default channel and value");
        assert_eq!(midi_bytes(&value("{type: pc, ch: 1, program: 5}")), Some((vec![0xC0, 5], None)));
        assert_eq!(midi_bytes(&value("{type: sysex, bytes: 'F0 41 zz F7'}")), Some((vec![0xF0, 0x41, 0xF7], None)));
        assert_eq!(midi_bytes(&value("{type: sysex, bytes: ''}")), None);
        assert_eq!(midi_bytes(&value("{type: bend}")), None);
    }

    #[test]
    fn a_cue_fires_its_trigger_note_and_messages() {
        let cue = cue("\
trigger_note: {ch: 1, note: 42}
cue_midi:
    - {device: Licht, type: pc, ch: 1, program: 5}
    - {type: note, ch: 1, note: 1}
cue_osc:
    - {device: QLab, path: /cue/42/start}
    - {device: QLab, path: /volume/set, arg: 0.8, arg_type: float}
    - {device: QLab, path: no-slash}
cue_http:
    - {device: Pult, method: post, path: /api/scene/3, body: '{\"fade\": 2.0}', content_type: application/json}
    - {device: Pult}
cue_display:
    - {device: Stage, markdown: Hi, announce: Standby}
    - {device: Foyer, markdown: Hi}");
        assert_eq!(
            cue.fire_effects(),
            [
                Effect::TriggerNote(Note { ch: 1, note: 42 }),
                Effect::TriggerOsc { path: "/mdstage/triggernote/1/42".into(), args: vec![] },
                Effect::Midi { device: "Licht".into(), bytes: vec![0xC0, 5], then_off: None },
                Effect::Osc { device: "QLab".into(), path: "/cue/42/start".into(), args: vec![] },
                Effect::Osc { device: "QLab".into(), path: "/volume/set".into(), args: vec![OscArg::Float(0.8)] },
                Effect::Http {
                    device: "Pult".into(),
                    method: "POST".into(),
                    path: "/api/scene/3".into(),
                    body: Some("{\"fade\": 2.0}".into()),
                    content_type: Some("application/json".into()),
                },
                Effect::Http { device: "Pult".into(), method: "GET".into(), path: String::new(), body: None, content_type: None },
                Effect::Announce { device: "Stage".into(), text: "Standby".into() },
            ]
        );
    }

    #[test]
    fn the_osc_field_replaces_the_trigger_note_path() {
        let effects = cue("osc: /show/go\nosc_arg: 3\nosc_arg_type: int\ntrigger_note: {ch: 1, note: 2}").fire_effects();
        assert_eq!(effects[1], Effect::TriggerOsc { path: "/show/go".into(), args: vec![OscArg::Int(3)] });
        let effects = cue("osc: /show/go\nosc_arg: hello").fire_effects();
        assert_eq!(effects, [Effect::TriggerOsc { path: "/show/go".into(), args: vec![OscArg::Text("hello".into())] }]);
        assert!(cue("light: Day").fire_effects().is_empty());
    }

    #[test]
    fn resending_states_skips_displays() {
        let mut states = DeviceStates::new();
        states.insert((DeviceKind::Midi, "Licht".into()), DeviceState::Messages(vec![value("{device: Licht, type: pc, program: 1}")]));
        states.insert((DeviceKind::Display, "Foyer".into()), DeviceState::Display("# Hi".into()));
        assert_eq!(resend_effects(&states), [Effect::Midi { device: "Licht".into(), bytes: vec![0xC0, 1], then_off: None }]);
    }
}
