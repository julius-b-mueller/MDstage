//! The settings window: this machine's audio device, routing, output devices, mixers,
//! remote control and display server.

use eframe::egui::{self, RichText, Ui};
use mdstage_core::cues::Note;
use mdstage_engine::inputs::Inputs;
use mdstage_engine::outputs::SystemMidi;
use mdstage_engine::settings::{ArgSetting, CueTriggerSetting, DeviceSetting, EmergencyLightSetting, MixerSetting, NoteSetting, Settings};

use crate::lang::t;
use crate::theme::*;

/// Which note field "MIDI learn" is waiting to fill.
#[derive(Clone, Copy, PartialEq)]
enum Learning {
    Go,
    Back,
}

pub struct SettingsUi {
    /// The settings being edited; applied on "Save".
    pub draft: Settings,
    audio_devices: Vec<String>,
    midi_outputs: Vec<String>,
    midi_inputs: Vec<String>,
    learning: Option<(Learning, Option<Note>)>,
}

/// A text field that takes the remaining room up to `width`.
fn field(ui: &mut Ui, value: &mut String, hint: &str, width: f32) {
    ui.add(egui::TextEdit::singleline(value).hint_text(hint).desired_width(width));
}

/// Choose one of `options`, or type a name that is not present right now.
fn port_picker(ui: &mut Ui, id: impl std::hash::Hash, value: &mut String, options: &[String]) {
    egui::ComboBox::from_id_salt(id).selected_text(if value.is_empty() { "—" } else { value.as_str() }).width(220.0).show_ui(ui, |ui| {
        for option in options {
            ui.selectable_value(value, option.clone(), option);
        }
        if !value.is_empty() && !options.contains(value) {
            ui.label(RichText::new(format!("{value} ({})", t("nicht angeschlossen", "not connected"))).color(RED));
        }
    });
}

/// Type and value of an optional OSC argument.
fn arg_fields(ui: &mut Ui, id: impl std::hash::Hash, arg: &mut ArgSetting) {
    let shown = if arg.kind.is_empty() { "none" } else { arg.kind.as_str() }.to_string();
    egui::ComboBox::from_id_salt(id).selected_text(shown).width(64.0).show_ui(ui, |ui| {
        for kind in ["none", "int", "float", "string"] {
            ui.selectable_value(&mut arg.kind, kind.to_string(), kind);
        }
    });
    if arg.kind != "none" && !arg.kind.is_empty() {
        ui.add(egui::TextEdit::singleline(&mut arg.value).desired_width(50.0));
    }
}

fn note_fields(ui: &mut Ui, note: &mut Option<NoteSetting>) {
    let mut on = note.is_some();
    if ui.checkbox(&mut on, "").changed() {
        *note = on.then_some(NoteSetting { ch: 1, note: 36 });
    }
    if let Some(n) = note {
        ui.label(t("Kanal", "Channel"));
        ui.add(egui::DragValue::new(&mut n.ch).range(1..=16));
        ui.label("Note");
        ui.add(egui::DragValue::new(&mut n.note).range(0..=127));
    }
}

impl SettingsUi {
    pub fn new(settings: &Settings) -> SettingsUi {
        SettingsUi {
            draft: settings.clone(),
            audio_devices: mdstage_engine::device::list_outputs().map(|l| l.into_iter().map(|d| d.name).collect()).unwrap_or_default(),
            midi_outputs: SystemMidi::port_names(),
            midi_inputs: Inputs::port_names(),
            learning: None,
        }
    }

    /// Draw the form. `channels` are the open show's virtual channels, `heard` the last
    /// MIDI note that came in. Returns `Some(true)` on Save, `Some(false)` on Cancel.
    pub fn show(&mut self, ui: &mut Ui, channels: &[String], heard: Option<Note>) -> Option<bool> {
        let mut result = None;
        egui::ScrollArea::vertical().auto_shrink([false, false]).max_height(ui.available_height() - 44.0).show(ui, |ui| {
            let draft = &mut self.draft;
            ui.heading(t("Allgemein", "General"));
            ui.horizontal(|ui| {
                ui.label(t("Sprache", "Language"));
                ui.selectable_value(&mut draft.language, "de".to_string(), "Deutsch");
                ui.selectable_value(&mut draft.language, "en".to_string(), "English");
            });
            ui.checkbox(&mut draft.outputs_blocked, t("Ausgaben an Geräte blockieren (MIDI, OSC, HTTP, Displays)", "Block output to devices (MIDI, OSC, HTTP, displays)"));

            ui.add_space(12.0);
            ui.heading("Audio");
            ui.horizontal(|ui| {
                ui.label(t("Ausgabegerät", "Output device"));
                let current = draft.audio_device.clone().unwrap_or_else(|| t("Systemstandard", "System default").into());
                egui::ComboBox::from_id_salt("audio-device").selected_text(current).width(260.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.audio_device, None, t("Systemstandard", "System default"));
                    for name in &self.audio_devices {
                        ui.selectable_value(&mut draft.audio_device, Some(name.clone()), name);
                    }
                });
            });
            ui.label(RichText::new(t("Ein anderes Gerät wird sofort übernommen, wenn es die Abtastrate der geöffneten Show kann.", "Another device is switched to at once if it can run at the sample rate of the open show.")).color(MUTED));
            if !channels.is_empty() {
                ui.label(t("Virtuelle Kanäle → Ausgang des Geräts", "Virtual channels → output of the device"));
                egui::Grid::new("routing").show(ui, |ui| {
                    for (i, name) in channels.iter().enumerate() {
                        // Shown 1-based, stored 0-based.
                        let mut output = draft.routing.get(name).copied().unwrap_or(i) + 1;
                        ui.label(name);
                        if ui.add(egui::DragValue::new(&mut output).range(1..=64)).changed() {
                            draft.routing.insert(name.clone(), output - 1);
                        }
                        ui.end_row();
                    }
                });
            }

            ui.add_space(12.0);
            ui.heading(t("Ausgabegeräte", "Output devices"));
            ui.label(RichText::new(t("Der Name muss dem Gerätenamen in der Show-Datei entsprechen. Adressen bleiben auf diesem Rechner.", "The name must match the device name in the show file. Addresses stay on this machine.")).color(MUTED));
            let mut remove = None;
            for (i, device) in draft.devices.iter_mut().enumerate() {
                ui.horizontal(|ui| match device {
                    DeviceSetting::Midi { name, port, enabled, trigger_notes, timecode } => {
                        ui.checkbox(enabled, "");
                        ui.label(RichText::new("MIDI").color(BLUE));
                        field(ui, name, "Name", 120.0);
                        port_picker(ui, ("midi-port", i), port, &self.midi_outputs);
                        ui.checkbox(trigger_notes, t("Trigger-Noten", "Trigger notes"));
                        ui.checkbox(timecode, "Timecode");
                        if ui.small_button("✕").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Osc { name, host, port, enabled, trigger_notes } => {
                        ui.checkbox(enabled, "");
                        ui.label(RichText::new("OSC").color(GREEN));
                        field(ui, name, "Name", 120.0);
                        field(ui, host, "Host", 130.0);
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.checkbox(trigger_notes, t("Trigger-Noten", "Trigger notes"));
                        if ui.small_button("✕").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Http { name, url, enabled } => {
                        ui.checkbox(enabled, "");
                        ui.label(RichText::new("HTTP").color(YELLOW));
                        field(ui, name, "Name", 120.0);
                        field(ui, url, "http://192.168.1.50:8080", 260.0);
                        if ui.small_button("✕").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Display { name, style, scroll_seconds, language, repeat } => {
                        ui.label(RichText::new("Display").color(RED));
                        field(ui, name, "Name", 120.0);
                        field(ui, style, t("dark / light / subtitle / datei.css", "dark / light / subtitle / file.css"), 150.0);
                        ui.label(t("Blättern (s)", "Scroll (s)"));
                        ui.add(egui::DragValue::new(scroll_seconds).range(0..=600));
                        field(ui, language, t("Sprache (de, en …)", "Language (de, en …)"), 60.0);
                        ui.checkbox(repeat, t("Durchsage wiederholen", "Repeat announcement"));
                        if ui.small_button("✕").clicked() {
                            remove = Some(i);
                        }
                    }
                });
            }
            if let Some(i) = remove {
                draft.devices.remove(i);
            }
            ui.horizontal(|ui| {
                if ui.button("+ MIDI").clicked() {
                    draft.devices.push(DeviceSetting::Midi { name: String::new(), port: String::new(), enabled: true, trigger_notes: false, timecode: false });
                }
                if ui.button("+ OSC").clicked() {
                    draft.devices.push(DeviceSetting::Osc { name: String::new(), host: "127.0.0.1".into(), port: 8000, enabled: true, trigger_notes: false });
                }
                if ui.button("+ HTTP").clicked() {
                    draft.devices.push(DeviceSetting::Http { name: String::new(), url: String::new(), enabled: true });
                }
                if ui.button("+ Display").clicked() {
                    draft.devices.push(DeviceSetting::Display { name: String::new(), style: "dark".into(), scroll_seconds: 0, language: String::new(), repeat: false });
                }
            });

            ui.add_space(12.0);
            ui.heading("Display-Server");
            ui.horizontal(|ui| {
                ui.label(t("Schnittstelle", "Interface"));
                field(ui, &mut draft.display_host, "127.0.0.1", 130.0);
                ui.label("Port");
                ui.add(egui::DragValue::new(&mut draft.display_port).range(1..=65535));
            });
            ui.label(RichText::new(t("127.0.0.1 = nur dieser Rechner; 0.0.0.0 = im ganzen Netzwerk erreichbar. Gilt ab dem nächsten Öffnen der Show.", "127.0.0.1 = this machine only; 0.0.0.0 = reachable from the whole network. Takes effect the next time the show is opened.")).color(MUTED));

            ui.add_space(12.0);
            ui.heading(t("Mischpult-Fernsteuerung (Mikrofone)", "Mixer remote control (microphones)"));
            let mut remove = None;
            for (i, mixer) in draft.mixers.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(format!("{} {}", t("Pult", "Mixer"), i + 1));
                    // Changing the method keeps the port, where both have one.
                    let kind = match mixer {
                        MixerSetting::X32 { .. } => 0,
                        MixerSetting::MidiNote { .. } => 1,
                        MixerSetting::MidiCc { .. } => 2,
                        MixerSetting::MidiProgram { .. } => 3,
                        MixerSetting::MidiSysex { .. } => 4,
                        MixerSetting::Osc { .. } => 5,
                    };
                    let names = ["X32 MIDI", t("MIDI-Note", "MIDI note"), t("MIDI-CC", "MIDI CC"), t("MIDI-Programm", "MIDI program"), t("MIDI-SysEx", "MIDI SysEx"), "OSC"];
                    let mut chosen = kind;
                    egui::ComboBox::from_id_salt(("mixer-method", i)).selected_text(names[kind]).show_ui(ui, |ui| {
                        for (n, name) in names.iter().enumerate() {
                            ui.selectable_value(&mut chosen, n, *name);
                        }
                    });
                    if chosen != kind {
                        let port = match mixer {
                            MixerSetting::X32 { port } | MixerSetting::MidiNote { port, .. } | MixerSetting::MidiCc { port, .. } => port.clone(),
                            MixerSetting::MidiProgram { port, .. } | MixerSetting::MidiSysex { port, .. } => port.clone(),
                            MixerSetting::Osc { .. } => String::new(),
                        };
                        let ch = || "{ch}".to_string();
                        *mixer = match chosen {
                            0 => MixerSetting::X32 { port },
                            1 => MixerSetting::MidiNote { port, channel: "1".into(), note: ch(), on_velocity: 127, off_velocity: 0 },
                            2 => MixerSetting::MidiCc { port, channel: "1".into(), controller: ch(), on_value: 127, off_value: 0 },
                            3 => MixerSetting::MidiProgram { port, channel: "1".into(), on_program: 0, off_program: 1 },
                            4 => MixerSetting::MidiSysex { port, unmute: String::new(), mute: String::new() },
                            _ => MixerSetting::Osc {
                                host: "192.168.1.1".into(),
                                port: 10023,
                                on_path: "/ch/{ch}/mix/on".into(),
                                on_arg: ArgSetting { kind: "int".into(), value: "1".into() },
                                off_path: "/ch/{ch}/mix/on".into(),
                                off_arg: ArgSetting { kind: "int".into(), value: "0".into() },
                            },
                        };
                    }
                    if ui.small_button("✕").clicked() {
                        remove = Some(i);
                    }
                });
                let byte = |ui: &mut Ui, label: &str, value: &mut u8| {
                    ui.label(label);
                    ui.add(egui::DragValue::new(value).range(0..=127));
                };
                ui.horizontal_wrapped(|ui| {
                    ui.add_space(16.0);
                    match mixer {
                        MixerSetting::X32 { port } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(RichText::new(t("CC auf Kanal 2, Controller = Mic-Kanal − 1", "CC on channel 2, controller = mic channel − 1")).color(MUTED));
                        }
                        MixerSetting::MidiNote { port, channel, note, on_velocity, off_velocity } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "1", 44.0);
                            ui.label("Note");
                            field(ui, note, "{ch}", 54.0);
                            byte(ui, t("an", "on"), on_velocity);
                            byte(ui, t("aus", "off"), off_velocity);
                        }
                        MixerSetting::MidiCc { port, channel, controller, on_value, off_value } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "1", 44.0);
                            ui.label("Controller");
                            field(ui, controller, "{ch}", 54.0);
                            byte(ui, t("an", "on"), on_value);
                            byte(ui, t("aus", "off"), off_value);
                        }
                        MixerSetting::MidiProgram { port, channel, on_program, off_program } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "{ch}", 54.0);
                            byte(ui, t("Programm an", "Program on"), on_program);
                            byte(ui, t("aus", "off"), off_program);
                        }
                        MixerSetting::MidiSysex { port, unmute, mute } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("an", "on"));
                            field(ui, unmute, "F0 … {ch} {val} F7", 190.0);
                            ui.label(t("aus", "off"));
                            field(ui, mute, "F0 … {ch} {val} F7", 190.0);
                        }
                        MixerSetting::Osc { host, port, on_path, on_arg, off_path, off_arg } => {
                            field(ui, host, "Host", 120.0);
                            ui.add(egui::DragValue::new(port).range(1..=65535));
                            for (label, path, arg, id) in [(t("an", "on"), on_path, on_arg, "on"), (t("aus", "off"), off_path, off_arg, "off")] {
                                ui.label(label);
                                field(ui, path, "/ch/{ch}/mix/on", 150.0);
                                arg_fields(ui, ("mixer-arg", i, id), arg);
                            }
                        }
                    }
                });
                if !matches!(mixer, MixerSetting::X32 { .. }) {
                    ui.label(RichText::new(t("    {ch} = Mic-Kanal der Rolle (MIDI: ab 0, OSC: ab 1, zweistellig)", "    {ch} = the role's mic channel (MIDI: from 0, OSC: from 1, two digits)")).color(MUTED));
                }
            }
            if let Some(i) = remove {
                draft.mixers.remove(i);
            }
            if ui.button(t("+ Pult", "+ Mixer")).clicked() {
                draft.mixers.push(MixerSetting::X32 { port: String::new() });
            }

            ui.add_space(12.0);
            ui.heading(t("Notlicht", "Emergency light"));
            let mut enabled = draft.emergency_light.is_some();
            if ui.checkbox(&mut enabled, t("Notlicht-Taste in der Werkzeugleiste", "Emergency light button in the toolbar")).changed() {
                draft.emergency_light = enabled.then(EmergencyLightSetting::default);
            }
            let targets: Vec<(String, bool)> = draft
                .devices
                .iter()
                .filter_map(|d| match d {
                    DeviceSetting::Midi { name, .. } => Some((name.clone(), false)),
                    DeviceSetting::Osc { name, .. } => Some((name.clone(), true)),
                    _ => None,
                })
                .collect();
            if let Some(light) = &mut draft.emergency_light {
                ui.horizontal(|ui| {
                    ui.label(t("Gerät", "Device"));
                    egui::ComboBox::from_id_salt("light-device").selected_text(if light.device.is_empty() { "—" } else { light.device.as_str() }).width(200.0).show_ui(ui, |ui| {
                        for (name, _) in &targets {
                            ui.selectable_value(&mut light.device, name.clone(), name);
                        }
                    });
                });
                let is_osc = targets.iter().any(|(name, osc)| *name == light.device && *osc);
                let hint = if is_osc { t("/pfad", "/path") } else { "90 3C 7F" };
                ui.horizontal(|ui| {
                    ui.label(t("an", "on"));
                    field(ui, &mut light.on, hint, 200.0);
                    if is_osc {
                        arg_fields(ui, "light-on-arg", &mut light.on_arg);
                    }
                });
                ui.horizontal(|ui| {
                    ui.label(t("aus", "off"));
                    field(ui, &mut light.off, hint, 200.0);
                    if is_osc {
                        arg_fields(ui, "light-off-arg", &mut light.off_arg);
                    }
                });
                if !is_osc {
                    ui.label(RichText::new(t("MIDI als Hex-Bytes, z. B. Note an Kanal 1: 90 3C 7F, Note aus: 80 3C 00", "MIDI as hex bytes, e.g. note on, channel 1: 90 3C 7F, note off: 80 3C 00")).color(MUTED));
                }
            }

            ui.add_space(12.0);
            ui.heading(t("Fernsteuerung", "Remote control"));
            if let Some((target, baseline)) = self.learning {
                // The first note that differs from what was last heard is the one to learn.
                if let Some(note) = heard.filter(|n| Some(*n) != baseline) {
                    let learned = Some(NoteSetting { ch: note.ch, note: note.note });
                    match target {
                        Learning::Go => draft.go_note = learned,
                        Learning::Back => draft.back_note = learned,
                    }
                    self.learning = None;
                }
            }
            for (label, target) in [(t("Go-Note", "Go note"), Learning::Go), (t("Back-Note", "Back note"), Learning::Back)] {
                ui.horizontal(|ui| {
                    ui.label(label);
                    note_fields(ui, if target == Learning::Go { &mut draft.go_note } else { &mut draft.back_note });
                    let waiting = self.learning.is_some_and(|(t, _)| t == target);
                    if ui.selectable_label(waiting, if waiting { t("Note spielen …", "Play a note …") } else { t("Lernen", "Learn") }).clicked() {
                        self.learning = if waiting { None } else { Some((target, heard)) };
                    }
                });
            }
            ui.label(RichText::new(t("„Lernen“ braucht eine geöffnete Show.", "“Learn” needs an open show.")).color(MUTED));
            ui.horizontal(|ui| {
                ui.label(t("MIDI-Eingang für Go/Back", "MIDI input for Go/Back"));
                let current = draft.control_port.clone().unwrap_or_else(|| t("alle", "all").into());
                egui::ComboBox::from_id_salt("control-port").selected_text(current).width(220.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.control_port, None, t("alle", "all"));
                    for name in &self.midi_inputs {
                        ui.selectable_value(&mut draft.control_port, Some(name.clone()), name);
                    }
                });
            });
            ui.horizontal(|ui| {
                ui.label(t("Cues per Trigger-Note auslösen", "Fire cues by trigger note"));
                let kind = match draft.cue_trigger {
                    CueTriggerSetting::Off => 0,
                    CueTriggerSetting::Midi { .. } => 1,
                    CueTriggerSetting::Osc { .. } => 2,
                };
                if ui.selectable_label(kind == 0, t("aus", "off")).clicked() {
                    draft.cue_trigger = CueTriggerSetting::Off;
                }
                if ui.selectable_label(kind == 1, "MIDI").clicked() && kind != 1 {
                    draft.cue_trigger = CueTriggerSetting::Midi { port: String::new() };
                }
                if ui.selectable_label(kind == 2, "OSC").clicked() && kind != 2 {
                    draft.cue_trigger = CueTriggerSetting::Osc { port: 8001, network: false };
                }
            });
            match &mut draft.cue_trigger {
                CueTriggerSetting::Off => {}
                CueTriggerSetting::Midi { port } => {
                    ui.horizontal(|ui| {
                        ui.label(t("Eingang", "Input"));
                        port_picker(ui, "cue-trigger-port", port, &self.midi_inputs);
                    });
                }
                CueTriggerSetting::Osc { port, network } => {
                    ui.horizontal(|ui| {
                        ui.label(t("UDP-Port", "UDP port"));
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.checkbox(network, t("aus dem Netzwerk annehmen", "accept from the network"));
                        ui.label(RichText::new(t("Pfad: /cue/<Kanal>/<Note>", "Path: /cue/<channel>/<note>")).color(MUTED));
                    });
                }
            }
        });

        ui.separator();
        ui.horizontal(|ui| {
            if ui.button(t("Speichern", "Save")).clicked() {
                result = Some(true);
            }
            if ui.button(t("Abbrechen", "Cancel")).clicked() {
                result = Some(false);
            }
        });
        result
    }
}
