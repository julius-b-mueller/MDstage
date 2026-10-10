//! The settings window: this machine's audio device, routing, output devices, mixers,
//! remote control and display server.

use eframe::egui::{self, RichText, Ui};
use mdstage_core::cues::Note;
use mdstage_engine::inputs::Inputs;
use mdstage_engine::outputs::SystemMidi;
use mdstage_engine::settings::{CueTriggerSetting, DeviceSetting, MixerSetting, NoteSetting, Settings};

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
            ui.label(RichText::new(format!("{value} (nicht angeschlossen)")).color(RED));
        }
    });
}

fn note_fields(ui: &mut Ui, note: &mut Option<NoteSetting>) {
    let mut on = note.is_some();
    if ui.checkbox(&mut on, "").changed() {
        *note = on.then_some(NoteSetting { ch: 1, note: 36 });
    }
    if let Some(n) = note {
        ui.label("Kanal");
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
            ui.heading("Allgemein");
            ui.horizontal(|ui| {
                ui.label("Sprache");
                ui.selectable_value(&mut draft.language, "de".to_string(), "Deutsch");
                ui.selectable_value(&mut draft.language, "en".to_string(), "English");
            });
            ui.checkbox(&mut draft.outputs_blocked, "Ausgaben an Geräte blockieren (MIDI, OSC, HTTP, Displays)");

            ui.add_space(12.0);
            ui.heading("Audio");
            ui.horizontal(|ui| {
                ui.label("Ausgabegerät");
                let current = draft.audio_device.clone().unwrap_or_else(|| "Systemstandard".into());
                egui::ComboBox::from_id_salt("audio-device").selected_text(current).width(260.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.audio_device, None, "Systemstandard");
                    for name in &self.audio_devices {
                        ui.selectable_value(&mut draft.audio_device, Some(name.clone()), name);
                    }
                });
            });
            ui.label(RichText::new("Ein anderes Gerät gilt ab dem nächsten Öffnen der Show.").color(MUTED));
            if !channels.is_empty() {
                ui.label("Virtuelle Kanäle → Ausgang des Geräts");
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
            ui.heading("Ausgabegeräte");
            ui.label(RichText::new("Der Name muss dem Gerätenamen in der Show-Datei entsprechen. Adressen bleiben auf diesem Rechner.").color(MUTED));
            let mut remove = None;
            for (i, device) in draft.devices.iter_mut().enumerate() {
                ui.horizontal(|ui| match device {
                    DeviceSetting::Midi { name, port, enabled, trigger_notes, timecode } => {
                        ui.checkbox(enabled, "");
                        ui.label(RichText::new("MIDI").color(BLUE));
                        field(ui, name, "Name", 120.0);
                        port_picker(ui, ("midi-port", i), port, &self.midi_outputs);
                        ui.checkbox(trigger_notes, "Trigger-Noten");
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
                        ui.checkbox(trigger_notes, "Trigger-Noten");
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
                        field(ui, style, "dark / light / subtitle / datei.css", 150.0);
                        ui.label("Blättern (s)");
                        ui.add(egui::DragValue::new(scroll_seconds).range(0..=600));
                        field(ui, language, "Sprache (de, en …)", 60.0);
                        ui.checkbox(repeat, "Durchsage wiederholen");
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
                ui.label("Schnittstelle");
                field(ui, &mut draft.display_host, "127.0.0.1", 130.0);
                ui.label("Port");
                ui.add(egui::DragValue::new(&mut draft.display_port).range(1..=65535));
            });
            ui.label(RichText::new("127.0.0.1 = nur dieser Rechner; 0.0.0.0 = im ganzen Netzwerk erreichbar. Gilt ab dem nächsten Öffnen der Show.").color(MUTED));

            ui.add_space(12.0);
            ui.heading("Mischpult-Fernsteuerung (Mikrofone)");
            let mut remove = None;
            for (i, mixer) in draft.mixers.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(format!("Pult {}", i + 1));
                    match mixer {
                        MixerSetting::X32 { port } => {
                            ui.label("X32 MIDI");
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                        }
                        other => {
                            let kind = match other {
                                MixerSetting::Osc { .. } => "eigenes OSC",
                                _ => "eigenes MIDI",
                            };
                            ui.label(RichText::new(format!("{kind} — Details in settings.json")).color(MUTED));
                        }
                    }
                    if ui.small_button("✕").clicked() {
                        remove = Some(i);
                    }
                });
            }
            if let Some(i) = remove {
                draft.mixers.remove(i);
            }
            if ui.button("+ X32-Pult").clicked() {
                draft.mixers.push(MixerSetting::X32 { port: String::new() });
            }

            ui.add_space(12.0);
            ui.heading("Fernsteuerung");
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
            for (label, target) in [("Go-Note", Learning::Go), ("Back-Note", Learning::Back)] {
                ui.horizontal(|ui| {
                    ui.label(label);
                    note_fields(ui, if target == Learning::Go { &mut draft.go_note } else { &mut draft.back_note });
                    let waiting = self.learning.is_some_and(|(t, _)| t == target);
                    if ui.selectable_label(waiting, if waiting { "Note spielen …" } else { "Lernen" }).clicked() {
                        self.learning = if waiting { None } else { Some((target, heard)) };
                    }
                });
            }
            ui.label(RichText::new("„Lernen“ braucht eine geöffnete Show.").color(MUTED));
            ui.horizontal(|ui| {
                ui.label("MIDI-Eingang für Go/Back");
                let current = draft.control_port.clone().unwrap_or_else(|| "alle".into());
                egui::ComboBox::from_id_salt("control-port").selected_text(current).width(220.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.control_port, None, "alle");
                    for name in &self.midi_inputs {
                        ui.selectable_value(&mut draft.control_port, Some(name.clone()), name);
                    }
                });
            });
            ui.horizontal(|ui| {
                ui.label("Cues per Trigger-Note auslösen");
                let kind = match draft.cue_trigger {
                    CueTriggerSetting::Off => 0,
                    CueTriggerSetting::Midi { .. } => 1,
                    CueTriggerSetting::Osc { .. } => 2,
                };
                if ui.selectable_label(kind == 0, "aus").clicked() {
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
                        ui.label("Eingang");
                        port_picker(ui, "cue-trigger-port", port, &self.midi_inputs);
                    });
                }
                CueTriggerSetting::Osc { port, network } => {
                    ui.horizontal(|ui| {
                        ui.label("UDP-Port");
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.checkbox(network, "aus dem Netzwerk annehmen");
                        ui.label(RichText::new("Pfad: /cue/<Kanal>/<Note>").color(MUTED));
                    });
                }
            }
        });

        ui.separator();
        ui.horizontal(|ui| {
            if ui.button("Speichern").clicked() {
                result = Some(true);
            }
            if ui.button("Abbrechen").clicked() {
                result = Some(false);
            }
        });
        result
    }
}
