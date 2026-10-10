//! This machine's settings: which devices a show's named outputs mean here, the audio
//! device and routing, remote control, and the display server.
//!
//! They live in the user's settings folder, never in the show file — a show file carries
//! device names only, so it runs at another venue without editing and holds no addresses.

use std::collections::HashMap;
use std::path::Path;

use mdstage_core::cues::Note;
use mdstage_core::effects::OscArg;
use serde::{Deserialize, Serialize};

use crate::display::DisplayDevice;
use crate::inputs::{CueTrigger, InputSettings};
use crate::outputs::{Address, Device, MicMixer, MuteMethod, Outputs};
use crate::player::Routing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSetting {
    pub ch: u64,
    pub note: u64,
}

impl From<NoteSetting> for Note {
    fn from(n: NoteSetting) -> Note {
        Note { ch: n.ch, note: n.note }
    }
}

impl DeviceSetting {
    pub fn name(&self) -> &str {
        match self {
            DeviceSetting::Midi { name, .. } | DeviceSetting::Osc { name, .. } | DeviceSetting::Http { name, .. } | DeviceSetting::Display { name, .. } => name,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DeviceSetting {
    Midi {
        name: String,
        port: String,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        trigger_notes: bool,
        #[serde(default)]
        timecode: bool,
    },
    Osc {
        name: String,
        host: String,
        port: u16,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        trigger_notes: bool,
    },
    Http {
        name: String,
        url: String,
        #[serde(default = "yes")]
        enabled: bool,
    },
    Display {
        name: String,
        #[serde(default)]
        style: String,
        #[serde(default)]
        scroll_seconds: u32,
        #[serde(default)]
        language: String,
        #[serde(default)]
        repeat: bool,
    },
}

fn yes() -> bool {
    true
}

/// An optional OSC argument as stored: its type and its text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ArgSetting {
    /// `int`, `float`, `string` or `none`.
    pub kind: String,
    pub value: String,
}

impl ArgSetting {
    fn arg(&self) -> Option<OscArg> {
        match self.kind.as_str() {
            _ if self.value.is_empty() => None,
            "int" => Some(OscArg::Int(self.value.trim().parse::<f64>().map_or(0, |f| f as i32))),
            "float" => Some(OscArg::Float(self.value.trim().parse().unwrap_or(0.0))),
            "none" => None,
            _ => Some(OscArg::Text(self.value.clone())),
        }
    }
}

/// How one mixer's microphones are muted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum MixerSetting {
    X32 { port: String },
    MidiNote { port: String, channel: String, note: String, on_velocity: u8, off_velocity: u8 },
    MidiCc { port: String, channel: String, controller: String, on_value: u8, off_value: u8 },
    MidiProgram { port: String, channel: String, on_program: u8, off_program: u8 },
    MidiSysex { port: String, unmute: String, mute: String },
    Osc { host: String, port: u16, on_path: String, on_arg: ArgSetting, off_path: String, off_arg: ArgSetting },
}

/// The emergency-light button: one message to switch it on, one to switch it off, sent
/// to one of the configured MIDI or OSC devices.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmergencyLightSetting {
    /// Name of the output device.
    pub device: String,
    /// For a MIDI device: the message as hex bytes (`90 3C 7F`). For OSC: the path.
    pub on: String,
    pub off: String,
    /// OSC arguments; unused for MIDI.
    pub on_arg: ArgSetting,
    pub off_arg: ArgSetting,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "lowercase")]
pub enum CueTriggerSetting {
    #[default]
    Off,
    Midi {
        port: String,
    },
    Osc {
        port: u16,
        #[serde(default)]
        network: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Output device name; `None` is the system default.
    pub audio_device: Option<String>,
    /// Physical output (0-based) per virtual-channel name; others are positional.
    pub routing: HashMap<String, usize>,
    pub devices: Vec<DeviceSetting>,
    pub mixers: Vec<MixerSetting>,
    /// Hold back all outputs to devices.
    pub outputs_blocked: bool,
    pub go_note: Option<NoteSetting>,
    pub back_note: Option<NoteSetting>,
    /// MIDI input for Go/Back; `None` listens on all.
    pub control_port: Option<String>,
    pub cue_trigger: CueTriggerSetting,
    pub emergency_light: Option<EmergencyLightSetting>,
    /// Interface the display server listens on. `127.0.0.1` keeps it on this computer.
    pub display_host: String,
    pub display_port: u16,
    /// `de` or `en`.
    pub language: String,
    /// The scene list at the left of the window is folded away.
    pub sidebar_hidden: bool,
    /// Show the line of the show file each block begins on.
    pub line_numbers: bool,
    /// Edit text with Vim keys (normal and insert mode) in the inline editor.
    pub vim_keys: bool,
    /// Command that opens a line of the show file in a text editor: `{file}` and
    /// `{line}` are filled in. Empty: no such command.
    pub editor_command: String,
    /// Start with editing locked.
    pub open_locked: bool,
    /// Show microphones bundled into their groups rather than as a flat list of roles.
    pub group_mics: bool,
    pub recent_files: Vec<String>,
    /// SHA-256 of each show file as this machine last wrote it. A file that differs was
    /// changed elsewhere and must be confirmed before it may drive devices.
    pub trusted: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            audio_device: None,
            routing: HashMap::new(),
            devices: Vec::new(),
            mixers: Vec::new(),
            outputs_blocked: false,
            go_note: None,
            back_note: None,
            control_port: None,
            cue_trigger: CueTriggerSetting::Off,
            emergency_light: None,
            display_host: "127.0.0.1".into(),
            display_port: 7590,
            language: "de".into(),
            sidebar_hidden: false,
            line_numbers: false,
            vim_keys: false,
            editor_command: String::new(),
            open_locked: false,
            group_mics: true,
            recent_files: Vec::new(),
            trusted: HashMap::new(),
        }
    }
}

impl Settings {
    /// Read settings from a JSON file. A missing or unreadable file gives the defaults.
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self).map_err(std::io::Error::other)?)
    }

    /// Output routing for a show's virtual channels: configured outputs, the rest by position.
    pub fn routing(&self, channels: &[String]) -> Routing {
        Routing::new(channels.iter().enumerate().map(|(i, name)| (name.clone(), self.routing.get(name).copied().unwrap_or(i))).collect())
    }

    /// The outputs as the engine addresses them. `trusted` is whether the open show file
    /// may drive devices at all.
    pub fn outputs(&self, trusted: bool) -> Outputs {
        let devices = self
            .devices
            .iter()
            .filter_map(|d| {
                Some(match d {
                    DeviceSetting::Midi { name, port, enabled, trigger_notes, .. } => {
                        Device { name: name.clone(), address: Address::Midi { port: port.clone() }, enabled: *enabled, trigger_notes: *trigger_notes }
                    }
                    DeviceSetting::Osc { name, host, port, enabled, trigger_notes } => Device {
                        name: name.clone(),
                        address: Address::Osc { host: host.clone(), port: *port },
                        enabled: *enabled,
                        trigger_notes: *trigger_notes,
                    },
                    DeviceSetting::Http { name, url, enabled } => {
                        Device { name: name.clone(), address: Address::Http { url: url.clone() }, enabled: *enabled, trigger_notes: false }
                    }
                    DeviceSetting::Display { .. } => return None,
                })
            })
            .collect();
        let midi = |port: &String, method| MicMixer { address: Address::Midi { port: port.clone() }, method };
        let mixers = self
            .mixers
            .iter()
            .map(|m| match m.clone() {
                MixerSetting::X32 { port } => midi(&port, MuteMethod::X32),
                MixerSetting::MidiNote { port, channel, note, on_velocity, off_velocity } => {
                    midi(&port, MuteMethod::MidiNote { channel, note, on_velocity, off_velocity })
                }
                MixerSetting::MidiCc { port, channel, controller, on_value, off_value } => {
                    midi(&port, MuteMethod::MidiCc { channel, controller, on_value, off_value })
                }
                MixerSetting::MidiProgram { port, channel, on_program, off_program } => {
                    midi(&port, MuteMethod::MidiProgram { channel, on_program, off_program })
                }
                MixerSetting::MidiSysex { port, unmute, mute } => midi(&port, MuteMethod::MidiSysex { unmute, mute }),
                MixerSetting::Osc { host, port, on_path, on_arg, off_path, off_arg } => MicMixer {
                    address: Address::Osc { host, port },
                    method: MuteMethod::Osc { on_path, on_arg: on_arg.arg(), off_path, off_arg: off_arg.arg() },
                },
            })
            .collect();
        Outputs { devices, mixers, blocked: self.outputs_blocked || !trusted }
    }

    pub fn displays(&self) -> Vec<DisplayDevice> {
        self.devices
            .iter()
            .filter_map(|d| match d {
                DeviceSetting::Display { name, style, scroll_seconds, language, repeat } => Some(DisplayDevice {
                    name: name.clone(),
                    style: style.clone(),
                    scroll_seconds: *scroll_seconds,
                    language: language.clone(),
                    repeat: *repeat,
                }),
                _ => None,
            })
            .collect()
    }

    /// The message that switches the emergency light on or off, if one is configured.
    pub fn emergency_light(&self, on: bool) -> Option<mdstage_core::effects::Effect> {
        use mdstage_core::effects::Effect;
        let light = self.emergency_light.as_ref()?;
        let (message, arg) = if on { (&light.on, &light.on_arg) } else { (&light.off, &light.off_arg) };
        self.devices.iter().find_map(|d| match d {
            DeviceSetting::Midi { name, .. } if *name == light.device => {
                let bytes: Vec<u8> = message.split_whitespace().filter_map(|b| u8::from_str_radix(b, 16).ok()).collect();
                (!bytes.is_empty()).then(|| Effect::Midi { device: name.clone(), bytes, then_off: None })
            }
            DeviceSetting::Osc { name, .. } if *name == light.device => mdstage_core::effects::is_osc_path(message)
                .then(|| Effect::Osc { device: name.clone(), path: message.clone(), args: arg.arg().into_iter().collect() }),
            _ => None,
        })
    }

    /// MIDI ports that receive timecode.
    pub fn timecode_ports(&self) -> Vec<String> {
        self.devices
            .iter()
            .filter_map(|d| match d {
                DeviceSetting::Midi { port, enabled: true, timecode: true, .. } => Some(port.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn inputs(&self) -> InputSettings {
        InputSettings {
            go: self.go_note.map(Note::from),
            back: self.back_note.map(Note::from),
            control_port: self.control_port.clone(),
            cue_trigger: match &self.cue_trigger {
                CueTriggerSetting::Off => CueTrigger::Off,
                CueTriggerSetting::Midi { port } => CueTrigger::Midi { port: port.clone() },
                CueTriggerSetting::Osc { port, network } => CueTrigger::Osc { port: *port, network: *network },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_the_display_server_local() {
        let settings = Settings::default();
        assert_eq!((settings.display_host.as_str(), settings.display_port), ("127.0.0.1", 7590));
        assert!(settings.outputs(true).devices.is_empty());
        assert!(settings.outputs(false).blocked, "an untrusted show file sends nothing");
        assert!(!settings.outputs(true).blocked);
        assert_eq!(settings.routing(&["L".into(), "R".into()]), Routing::positional(&["L".into(), "R".into()]));
    }

    #[test]
    fn emergency_light_messages() {
        use mdstage_core::effects::Effect;
        let mut settings: Settings = serde_json::from_str(
            r#"{"devices": [{"type": "midi", "name": "Licht", "port": "DMX"}, {"type": "osc", "name": "QLab", "host": "h", "port": 1}],
                "emergency_light": {"device": "Licht", "on": "90 3C 7F", "off": "80 3c 00"}}"#,
        )
        .unwrap();
        assert_eq!(settings.emergency_light(true), Some(Effect::Midi { device: "Licht".into(), bytes: vec![0x90, 0x3C, 0x7F], then_off: None }));
        assert_eq!(settings.emergency_light(false), Some(Effect::Midi { device: "Licht".into(), bytes: vec![0x80, 0x3C, 0x00], then_off: None }));

        let light = settings.emergency_light.as_mut().unwrap();
        light.device = "QLab".into();
        light.on = "/light/emergency".into();
        light.on_arg = ArgSetting { kind: "int".into(), value: "1".into() };
        assert_eq!(settings.emergency_light(true), Some(Effect::Osc { device: "QLab".into(), path: "/light/emergency".into(), args: vec![OscArg::Int(1)] }));
        assert_eq!(settings.emergency_light(false), None, "\"80 3c 00\" is not an OSC path");
        settings.emergency_light.as_mut().unwrap().device = "Gone".into();
        assert_eq!(settings.emergency_light(true), None);
        assert_eq!(Settings::default().emergency_light(true), None);
    }

    #[test]
    fn reads_what_it_writes_and_tolerates_missing_fields() {
        let json = r#"{
            "audio_device": "Scarlett 18i20",
            "routing": {"Sub": 4},
            "devices": [
                {"type": "midi", "name": "Licht", "port": "DMX Interface", "trigger_notes": true, "timecode": true},
                {"type": "osc", "name": "QLab", "host": "10.0.0.5", "port": 53000},
                {"type": "http", "name": "Pult", "url": "http://10.0.0.9", "enabled": false},
                {"type": "display", "name": "Foyer", "style": "subtitle", "repeat": true}
            ],
            "mixers": [
                {"method": "x32", "port": "X32"},
                {"method": "osc", "host": "192.168.1.1", "port": 10023, "on_path": "/ch/{ch}/mix/on",
                 "on_arg": {"kind": "int", "value": "1"}, "off_path": "/ch/{ch}/mix/on", "off_arg": {"kind": "int", "value": "0"}}
            ],
            "go_note": {"ch": 1, "note": 36},
            "cue_trigger": {"from": "osc", "port": 8001}
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.language, "de", "fields that are not in the file keep their defaults");
        assert_eq!(settings.routing(&["L".into(), "Sub".into()]), Routing::new(vec![("L".into(), 0), ("Sub".into(), 4)]));

        let outputs = settings.outputs(true);
        assert_eq!(outputs.devices.len(), 3);
        assert!(outputs.devices[0].trigger_notes && outputs.devices[0].enabled);
        assert!(!outputs.devices[2].enabled);
        assert_eq!(outputs.mixers[0], MicMixer { address: Address::Midi { port: "X32".into() }, method: MuteMethod::X32 });
        assert!(matches!(&outputs.mixers[1].method, MuteMethod::Osc { on_arg: Some(OscArg::Int(1)), off_arg: Some(OscArg::Int(0)), .. }));
        assert_eq!(settings.timecode_ports(), ["DMX Interface"]);
        assert_eq!(settings.displays()[0].style, "subtitle");
        assert_eq!(settings.inputs().go, Some(Note { ch: 1, note: 36 }));
        assert_eq!(settings.inputs().cue_trigger, CueTrigger::Osc { port: 8001, network: false });

        let path = std::env::temp_dir().join(format!("mdstage-settings-{}/prefs.json", std::process::id()));
        settings.save(&path).unwrap();
        assert_eq!(Settings::load(&path), settings);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        assert_eq!(Settings::load(&path), Settings::default(), "a missing file gives the defaults");
    }
}
