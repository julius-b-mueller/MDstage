//! The cue dialog: the common fields as form controls, and the cue's whole YAML as text
//! for everything else. Both edit the same data; changing one updates the other.

use std::path::Path;

use eframe::egui::{self, RichText, Ui};
use mdstage_core::mic::Cast;
use mdstage_core::yaml::{self, Mapping, Value};

use crate::theme::*;

pub struct CueDialog {
    /// The block being edited, or where the new cue goes.
    pub block: usize,
    pub is_new: bool,
    yaml: Mapping,
    text: String,
    text_error: Option<String>,
    audio_files: Vec<String>,
    /// Other cues use Auto-Mic, so microphones cannot be chosen by hand.
    auto_mic_in_use: bool,
}

fn number(map: &Mapping, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

/// A seconds field that is absent from the YAML while it is zero.
fn seconds(ui: &mut Ui, map: &mut Mapping, key: &str, label: &str) -> bool {
    let mut value = number(map, key).unwrap_or(0.0);
    ui.label(label);
    let changed = ui.add(egui::DragValue::new(&mut value).speed(0.05).range(0.0..=36000.0).suffix(" s")).changed();
    if changed {
        if value > 0.0 {
            map.insert(key.into(), ((value * 1000.0).round() / 1000.0).into());
        } else {
            map.shift_remove(key);
        }
    }
    changed
}

impl CueDialog {
    pub fn new(block: usize, is_new: bool, cue: Option<&Value>, audio_dir: &Path, auto_mic_in_use: bool) -> CueDialog {
        let yaml = cue.and_then(Value::as_mapping).cloned().unwrap_or_default();
        let mut audio_files: Vec<String> = std::fs::read_dir(audio_dir)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| {
                let lower = name.to_lowercase();
                ["mp3", "wav", "aiff", "aif", "flac", "ogg", "aac", "m4a"].iter().any(|ext| lower.ends_with(&format!(".{ext}")))
            })
            .collect();
        audio_files.sort();
        let text = yaml::dump(&Value::Mapping(yaml.clone()), true);
        CueDialog { block, is_new, text: if yaml.is_empty() { String::new() } else { text }, yaml, text_error: None, audio_files, auto_mic_in_use }
    }

    /// The cue as edited.
    pub fn value(&self) -> Value {
        Value::Mapping(self.yaml.clone())
    }

    fn sync_text(&mut self) {
        self.text = if self.yaml.is_empty() { String::new() } else { yaml::dump(&Value::Mapping(self.yaml.clone()), true) };
        self.text_error = None;
    }

    /// The `music` entry as a mapping, converting the short form `music: file.wav`.
    fn music(&mut self) -> Option<&mut Mapping> {
        if let Some(file) = self.yaml.get("music").and_then(Value::as_str).map(str::to_string) {
            let mut music = Mapping::new();
            music.insert("file".into(), file.into());
            self.yaml.insert("music".into(), Value::Mapping(music));
        }
        self.yaml.get_mut("music").and_then(Value::as_mapping_mut)
    }

    fn fields(&mut self, ui: &mut Ui, cast: &Cast) -> bool {
        let mut changed = false;

        ui.horizontal(|ui| {
            ui.label("Notiz");
            let mut note = self.yaml.get("note").and_then(Value::as_str).unwrap_or_default().to_string();
            if ui.add(egui::TextEdit::singleline(&mut note).desired_width(f32::INFINITY)).changed() {
                changed = true;
                if note.is_empty() {
                    self.yaml.shift_remove("note");
                } else {
                    self.yaml.insert("note".into(), note.into());
                }
            }
        });

        ui.add_space(6.0);
        let mut auto = self.yaml.get("auto_mic").and_then(Value::as_bool) == Some(true);
        if ui.checkbox(&mut auto, "Auto-Mic: Mikrofone aus dem folgenden Text bestimmen").changed() {
            changed = true;
            if auto {
                self.yaml.insert("auto_mic".into(), true.into());
            } else {
                self.yaml.shift_remove("auto_mic");
            }
        }
        if auto || self.auto_mic_in_use {
            ui.label(RichText::new("Sobald ein Cue Auto-Mic nutzt, werden Mikrofone nirgends mehr von Hand gewählt.").color(MUTED));
        } else {
            let mut open: Vec<String> = match self.yaml.get("mic") {
                Some(Value::String(name)) => vec![name.clone()],
                Some(Value::Sequence(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                _ => Vec::new(),
            };
            let mute_all = open == ["muteall"];
            let mut mode = if mute_all { 1 } else if open.is_empty() { 0 } else { 2 };
            ui.horizontal(|ui| {
                ui.label("Mikrofone");
                changed |= ui.radio_value(&mut mode, 0, "unverändert").changed();
                changed |= ui.radio_value(&mut mode, 1, "alle aus").changed();
                changed |= ui.radio_value(&mut mode, 2, "Auswahl").changed();
            });
            if mode == 2 {
                open.retain(|n| n != "muteall");
                ui.horizontal_wrapped(|ui| {
                    let names = cast.groups.iter().map(|g| (&g.name, g.color.as_deref())).chain(cast.roles.iter().map(|r| (&r.name, r.color.as_deref())));
                    for (name, colour) in names {
                        let mut on = open.contains(name);
                        let label = RichText::new(name).color(named(colour).unwrap_or(BRIGHT));
                        if ui.checkbox(&mut on, label).changed() {
                            changed = true;
                            if on {
                                open.push(name.clone());
                            } else {
                                open.retain(|n| n != name);
                            }
                        }
                    }
                });
            }
            if changed {
                match mode {
                    1 => drop(self.yaml.insert("mic".into(), "muteall".into())),
                    2 if !open.is_empty() => drop(self.yaml.insert("mic".into(), Value::Sequence(open.into_iter().map(Value::String).collect()))),
                    // "Auswahl" with nothing ticked yet keeps the entry out of the file.
                    _ => drop(self.yaml.shift_remove("mic")),
                }
            }
        }

        ui.add_space(6.0);
        let several = self.yaml.get("music").is_some_and(|m| m.get("audios").is_some());
        if several {
            ui.label(RichText::new("♬ Mehrere Audios mit Patch — bitte unten im YAML bearbeiten.").color(MUTED));
        } else {
            let current = match self.yaml.get("music") {
                Some(Value::String(file)) => file.clone(),
                Some(music) => music.get("file").and_then(Value::as_str).unwrap_or_default().to_string(),
                None => String::new(),
            };
            let mut file = current.clone();
            ui.horizontal(|ui| {
                ui.label("♬ Audio");
                egui::ComboBox::from_id_salt("cue-audio").selected_text(if file.is_empty() { "— keines —" } else { file.as_str() }).width(320.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut file, String::new(), "— keines —");
                    for name in &self.audio_files {
                        ui.selectable_value(&mut file, name.clone(), name);
                    }
                });
                if !file.is_empty() && !self.audio_files.contains(&file) {
                    ui.label(RichText::new("nicht im Ordner audio/").color(RED));
                }
            });
            if file != current {
                changed = true;
                if file.is_empty() {
                    self.yaml.shift_remove("music");
                } else if let Some(music) = self.music() {
                    music.insert("file".into(), file.into());
                } else {
                    self.yaml.insert("music".into(), file.into());
                }
            }
            if self.yaml.contains_key("music") {
                if let Some(music) = self.music() {
                    ui.horizontal(|ui| {
                        let mut volume = number(music, "volume").unwrap_or(mdstage_core::cues::DEFAULT_VOLUME);
                        ui.label("Lautstärke");
                        if ui.add(egui::Slider::new(&mut volume, 0.0..=1.0).show_value(true)).changed() {
                            changed = true;
                            music.insert("volume".into(), ((volume * 100.0).round() / 100.0).into());
                        }
                        let mut looped = music.get("loop").and_then(Value::as_bool) == Some(true);
                        if ui.checkbox(&mut looped, "Loop").changed() {
                            changed = true;
                            if looped {
                                music.insert("loop".into(), true.into());
                            } else {
                                music.shift_remove("loop");
                            }
                        }
                    });
                    ui.horizontal(|ui| {
                        changed |= seconds(ui, music, "fadein", "Einblenden");
                        changed |= seconds(ui, music, "fadeout", "Ausblenden");
                        changed |= seconds(ui, music, "fading_point", "Loop-Punkt");
                    });
                    ui.label(RichText::new("Start und Ende: Marker an der Wellenform mit Shift ziehen.").color(MUTED));
                }
            }
        }

        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.label("Start-Timecode");
            let mut tc = self.yaml.get("start_tc").and_then(Value::as_str).unwrap_or_default().to_string();
            if ui.add(egui::TextEdit::singleline(&mut tc).hint_text("HH:MM:SS:FF").desired_width(110.0)).changed() {
                changed = true;
                if tc.is_empty() {
                    self.yaml.shift_remove("start_tc");
                } else {
                    self.yaml.insert("start_tc".into(), tc.into());
                }
            }
        });
        changed
    }

    /// Draw the dialog. Returns `Some(true)` on Save, `Some(false)` on Cancel.
    pub fn show(&mut self, ui: &mut Ui, cast: &Cast) -> Option<bool> {
        let mut result = None;
        egui::ScrollArea::vertical().auto_shrink([false, false]).max_height(ui.available_height() - 44.0).show(ui, |ui| {
            if self.fields(ui, cast) {
                self.sync_text();
            }
            ui.add_space(10.0);
            ui.separator();
            ui.label(RichText::new("YAML — alle Felder des Cues (S/L/F, Auto-Cue, Adjust, cue_midi, cue_osc, cue_http, cue_display …)").color(MUTED));
            let editor = egui::TextEdit::multiline(&mut self.text).code_editor().desired_width(f32::INFINITY).desired_rows(10);
            if ui.add(editor).changed() {
                match serde_yaml_from(&self.text) {
                    Ok(map) => {
                        self.yaml = map;
                        self.text_error = None;
                    }
                    Err(e) => self.text_error = Some(e),
                }
            }
            if let Some(error) = &self.text_error {
                ui.label(RichText::new(error).color(RED));
            }
        });
        ui.separator();
        ui.horizontal(|ui| {
            if ui.add_enabled(self.text_error.is_none(), egui::Button::new("Speichern")).clicked() {
                result = Some(true);
            }
            if ui.button("Abbrechen").clicked() {
                result = Some(false);
            }
        });
        result
    }
}

/// Parse cue YAML typed by the operator: a mapping, or nothing at all.
fn serde_yaml_from(text: &str) -> Result<Mapping, String> {
    if text.trim().is_empty() {
        return Ok(Mapping::new());
    }
    match mdstage_core::Script::parse(&format!("```yaml\n{text}\n```\n")).blocks.into_iter().next() {
        Some(mdstage_core::Block::Cue(cue)) if !cue.invalid => cue.yaml.as_mapping().cloned().ok_or_else(|| "Ein Cue besteht aus Feldern (name: wert).".to_string()),
        Some(mdstage_core::Block::Config(_)) => Err("Das ist ein Config-Block, kein Cue.".into()),
        _ => Err("YAML nicht lesbar.".into()),
    }
}
