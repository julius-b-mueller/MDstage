//! The cue dialog: every field of a cue as form controls. What it edits is the cue's
//! YAML, but the operator never has to see that.

use std::path::Path;

use eframe::egui::{self, RichText, Ui};
use mdstage_core::cues::Note;
use mdstage_core::mic::Cast;
use mdstage_core::yaml::{Mapping, Value};

use crate::lang::t;
use crate::theme::*;

pub struct CueDialog {
    /// The block being edited, or where the new cue goes.
    pub block: usize,
    pub is_new: bool,
    yaml: Mapping,
    audio_files: Vec<String>,
    /// Other cues use Auto-Mic, so microphones cannot be chosen by hand.
    auto_mic_in_use: bool,
    /// The other cues of the show that can be linked to: trigger note and a label.
    cues: Vec<(Note, String)>,
    /// The names of the show's virtual channels and of the devices set up on this machine.
    channels: Vec<String>,
    devices: crate::cue_forms::Devices,
    audio_dir: std::path::PathBuf,
    /// Channel count and length (seconds) of the audio files looked at so far.
    info: std::collections::HashMap<String, Option<(usize, f64)>>,
    /// Tempo and number of beats for working out the loop point.
    tempo: (f64, f64),
    /// The new name being typed for the cue's audio file.
    renaming: Option<String>,
    /// Set when the operator asked for an audio file to be renamed: `(from, to)`. The
    /// app does it (on disk and in every cue) and answers with `audio_renamed`.
    pub rename_request: Option<(String, String)>,
}

fn note_of(value: Option<&Value>) -> Option<Note> {
    let value = value?;
    Some(Note { ch: value.get("ch")?.as_u64()?, note: value.get("note")?.as_u64()? })
}

fn note_value(note: Note) -> Value {
    let mut map = Mapping::new();
    map.insert("ch".into(), note.ch.into());
    map.insert("note".into(), note.note.into());
    Value::Mapping(map)
}

/// Choose one of the show's cues (or none). Returns the new choice if it changed.
fn cue_picker(ui: &mut Ui, id: &str, cues: &[(Note, String)], current: Option<Note>) -> Option<Option<Note>> {
    let label = |note: Note| cues.iter().find(|(n, _)| *n == note).map_or(format!("{note} ({})", t("kein Cue mit dieser Note", "no cue has this note")), |(_, l)| l.clone());
    let mut choice = current;
    egui::ComboBox::from_id_salt(id).selected_text(current.map_or("—".to_string(), label)).width(300.0).show_ui(ui, |ui| {
        ui.selectable_value(&mut choice, None, "—");
        for (note, text) in cues {
            ui.selectable_value(&mut choice, Some(*note), text);
        }
    });
    (choice != current).then_some(choice)
}

fn number(map: &Mapping, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

/// A seconds field that is absent from the YAML while it is zero.
pub(crate) fn seconds(ui: &mut Ui, map: &mut Mapping, key: &str, label: &str) -> bool {
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
    pub fn new(block: usize, is_new: bool, cue: Option<&Value>, audio_dir: &Path, auto_mic_in_use: bool, cues: Vec<(Note, String)>) -> CueDialog {
        let yaml = cue.and_then(Value::as_mapping).cloned().unwrap_or_default();
        let audio_files = crate::store::audio_files(audio_dir);
        CueDialog { block, is_new, yaml, audio_files, auto_mic_in_use, cues, channels: vec!["L".into(), "R".into()], devices: Default::default(), audio_dir: audio_dir.to_path_buf(), info: Default::default(), tempo: (120.0, 4.0), renaming: None, rename_request: None }
    }

    /// An audio file got a new name: follow it in the file list and in the cue as it
    /// stands in this dialog.
    pub fn audio_renamed(&mut self, from: &str, to: &str) {
        for name in self.audio_files.iter_mut().filter(|name| *name == from) {
            *name = to.to_string();
        }
        self.audio_files.sort();
        let mut cue = Value::Mapping(std::mem::take(&mut self.yaml));
        mdstage_core::edit::rename_audio_in(&mut cue, from, to);
        self.yaml = cue.as_mapping().cloned().unwrap_or_default();
    }

    /// Tell the dialog the show's virtual channels and this machine's devices.
    pub fn with_setup(mut self, channels: Vec<String>, devices: crate::cue_forms::Devices) -> CueDialog {
        self.channels = channels;
        self.devices = devices;
        self
    }

    /// Files were added to the audio folder: list them.
    pub fn refresh_audio(&mut self, audio_dir: &Path) {
        self.audio_files = crate::store::audio_files(audio_dir);
    }

    /// The cue as edited.
    pub fn value(&self) -> Value {
        Value::Mapping(self.yaml.clone())
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
            ui.label(t("Trigger-Note", "Trigger note"));
            match note_of(self.yaml.get("trigger_note")) {
                Some(mut note) => {
                    let hint = t("Die Note, die beim Auslösen gesendet wird und über die andere Cues diesen ansprechen. Verknüpfungen anderer Cues folgen einer Änderung.", "The note sent on firing and by which other cues refer to this one. Links from other cues follow a change.");
                    let mut edited = ui.add(egui::DragValue::new(&mut note.ch).range(1..=16).prefix(t("Kanal ", "Channel "))).on_hover_text(hint).changed();
                    edited |= ui.add(egui::DragValue::new(&mut note.note).range(0..=127).prefix("Note ")).on_hover_text(hint).changed();
                    if edited {
                        changed = true;
                        self.yaml.insert("trigger_note".into(), note_value(note));
                    }
                }
                None => drop(ui.label(RichText::new(t("wird beim Speichern vergeben", "is assigned on saving")).color(MUTED))),
            }
            ui.add_space(12.0);
            let mut variant = self.yaml.get("sibling").and_then(Value::as_bool) == Some(true);
            if ui.checkbox(&mut variant, t("Variante des vorangehenden Cues", "Variant of the cue before")).changed() {
                changed = true;
                match variant {
                    true => drop(self.yaml.insert("sibling".into(), true.into())),
                    false => drop(self.yaml.shift_remove("sibling")),
                }
            }
        });

        ui.horizontal(|ui| {
            ui.label(t("Notiz", "Note"));
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
        if ui.checkbox(&mut auto, t("Auto-Mic: Mikrofone aus dem folgenden Text bestimmen", "Auto mic: work out the microphones from the text that follows")).changed() {
            changed = true;
            if auto {
                self.yaml.insert("auto_mic".into(), true.into());
            } else {
                self.yaml.shift_remove("auto_mic");
            }
        }
        if auto || self.auto_mic_in_use {
            ui.label(RichText::new(t("Sobald ein Cue Auto-Mic nutzt, werden Mikrofone nirgends mehr von Hand gewählt.", "Once any cue uses auto mic, microphones are no longer chosen by hand anywhere.")).color(MUTED));
        } else {
            let mut open: Vec<String> = match self.yaml.get("mic") {
                Some(Value::String(name)) => vec![name.clone()],
                Some(Value::Sequence(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                _ => Vec::new(),
            };
            let mute_all = open == ["muteall"];
            let mut mode = if mute_all { 1 } else if open.is_empty() { 0 } else { 2 };
            ui.horizontal(|ui| {
                ui.label(t("Mikrofone", "Microphones"));
                changed |= ui.radio_value(&mut mode, 0, t("unverändert", "unchanged")).changed();
                changed |= ui.radio_value(&mut mode, 1, t("alle aus", "all off")).changed();
                changed |= ui.radio_value(&mut mode, 2, t("Auswahl", "selection")).changed();
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
                    // t("Auswahl", "selection") with nothing ticked yet keeps the entry out of the file.
                    _ => drop(self.yaml.shift_remove("mic")),
                }
            }
        }

        ui.add_space(6.0);
        let several = self.yaml.get("music").is_some_and(|m| m.get("audios").is_some());
        if several {
            ui.label(t("♬ Audios", "♬ Audios"));
            let (dir, cache) = (self.audio_dir.clone(), &mut self.info);
            let mut channels_of = |file: &str| cache.entry(file.to_string()).or_insert_with(|| probe(&dir, file)).map(|(channels, _)| channels);
            let mut music = self.yaml.get("music").and_then(Value::as_mapping).cloned().unwrap_or_default();
            if crate::cue_forms::audios(ui, 0, &mut music, &self.audio_files, &self.channels, &mut channels_of) {
                changed = true;
                // One plain audio left: back to the short form.
                let entries = music.get("audios").and_then(Value::as_sequence).cloned().unwrap_or_default();
                let plain = entries.len() == 1 && entries[0].as_mapping().is_some_and(|a| a.len() == 1 && a.contains_key("file"));
                match (entries.is_empty(), plain) {
                    (true, _) => drop(music.shift_remove("audios")),
                    (_, true) => {
                        music.shift_remove("audios");
                        music.insert("file".into(), entries[0].get("file").cloned().unwrap_or_default());
                    }
                    _ => {}
                }
                match music.contains_key("audios") || music.contains_key("file") {
                    true => drop(self.yaml.insert("music".into(), Value::Mapping(music))),
                    false => drop(self.yaml.shift_remove("music")),
                }
            }
        } else {
            let current = match self.yaml.get("music") {
                Some(Value::String(file)) => file.clone(),
                Some(music) => music.get("file").and_then(Value::as_str).unwrap_or_default().to_string(),
                None => String::new(),
            };
            let mut file = current.clone();
            let mut more_audios = false;
            ui.horizontal(|ui| {
                ui.label("♬ Audio");
                egui::ComboBox::from_id_salt("cue-audio").selected_text(if file.is_empty() { t("— keines —", "— none —") } else { file.as_str() }).width(320.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut file, String::new(), t("— keines —", "— none —"));
                    for name in &self.audio_files {
                        ui.selectable_value(&mut file, name.clone(), name);
                    }
                });
                if !file.is_empty() && !self.audio_files.contains(&file) {
                    ui.label(RichText::new(t("nicht im Ordner audio/", "not in the audio/ folder")).color(RED));
                } else if !file.is_empty() && self.renaming.is_none() {
                    let hint = t("Audiodatei umbenennen (wirkt in allen Cues)", "Rename audio file (applies to every cue)");
                    if ui.button("✏").on_hover_text(hint).clicked() {
                        self.renaming = Some(file.clone());
                    }
                }
                if !file.is_empty() && ui.button(t("+ Audio", "+ Audio")).on_hover_text(t("Weitere Audios, die zusammen spielen, mit Kanal-Patch", "Further audios that play together, with a channel patch")).clicked() {
                    more_audios = true;
                }
            });
            if let Some(mut name) = self.renaming.take().filter(|_| file == current && !file.is_empty()) {
                let mut keep = true;
                ui.horizontal(|ui| {
                    ui.label(t("Neuer Name", "New name"));
                    let field = ui.add(egui::TextEdit::singleline(&mut name).desired_width(260.0));
                    let entered = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if ui.button(t("Umbenennen", "Rename")).clicked() || entered {
                        let wanted = name.trim();
                        if !wanted.is_empty() && wanted != file {
                            self.rename_request = Some((file.clone(), wanted.to_string()));
                        }
                        keep = false;
                    }
                    if ui.button(t("Abbrechen", "Cancel")).clicked() {
                        keep = false;
                    }
                });
                ui.label(RichText::new(t("Die Datei wird im audio-Ordner umbenannt. Alle Cues, die sie verwenden, werden mit angepasst.", "The file is renamed in the audio folder. Every cue using it is updated as well.")).color(MUTED));
                if keep {
                    self.renaming = Some(name);
                }
            }
            if more_audios {
                changed = true;
                if let Some(music) = self.music() {
                    let first = music.shift_remove("file").unwrap_or_default();
                    let entry = |file: Value| {
                        let mut audio = Mapping::new();
                        audio.insert("file".into(), file);
                        Value::Mapping(audio)
                    };
                    music.insert("audios".into(), Value::Sequence(vec![entry(first), entry("".into())]));
                }
            }
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
        }
        if self.yaml.contains_key("music") {
            // Worked on as a copy, so that the short form `music: file.wav` only becomes
            // the long one when something is actually set.
            let mut copy = match self.yaml.get("music") {
                Some(Value::Mapping(music)) => music.clone(),
                Some(Value::String(file)) => {
                    let mut music = Mapping::new();
                    music.insert("file".into(), file.as_str().into());
                    music
                }
                _ => Mapping::new(),
            };
            let before = changed;
            {
                let music = &mut copy;
                ui.horizontal(|ui| {
                    let mut volume = number(music, "volume").unwrap_or(mdstage_core::cues::DEFAULT_VOLUME);
                    ui.label(t("Lautstärke", "Volume"));
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
                    changed |= seconds(ui, music, "start", "Start");
                    changed |= seconds(ui, music, "end", t("Ende", "End"));
                    changed |= seconds(ui, music, "fadein", t("Einblenden", "Fade in"));
                    changed |= seconds(ui, music, "fadeout", t("Ausblenden", "Fade out"));
                    changed |= seconds(ui, music, "fading_point", t("Loop-Punkt", "Loop point"));
                });
                ui.label(RichText::new(t("Ende 0 = bis zum Dateiende. Alle Zeiten lassen sich auch an der Wellenform mit Shift ziehen.", "End 0 = up to the end of the file. All times can also be dragged on the waveform with Shift.")).color(MUTED));
            }
            if changed && !before {
                self.yaml.insert("music".into(), Value::Mapping(copy));
            }
            // The loop point from the music's tempo: so many beats before the end.
            let first_file = self.yaml.get("music").and_then(|m| m.get("file").or_else(|| m.get("audios")?.get(0)?.get("file"))).and_then(Value::as_str).map(str::to_string);
            let mut loop_point = None;
            ui.horizontal(|ui| {
                ui.label(RichText::new(t("Loop-Punkt aus dem Tempo:", "Loop point from the tempo:")).color(MUTED));
                ui.add(egui::DragValue::new(&mut self.tempo.0).speed(0.5).range(20.0..=400.0).suffix(" BPM"));
                ui.add(egui::DragValue::new(&mut self.tempo.1).speed(0.1).range(0.0..=1024.0).suffix(t(" Schläge vor dem Ende", " beats before the end")));
                if ui.button(t("Setzen", "Set")).clicked() {
                    let (dir, cache) = (self.audio_dir.clone(), &mut self.info);
                    let length = first_file.as_deref().and_then(|file| *cache.entry(file.to_string()).or_insert_with(|| probe(&dir, file))).map(|(_, seconds)| seconds);
                    let end = self.yaml.get("music").and_then(|m| m.get("end")).and_then(Value::as_f64).or(length);
                    loop_point = end.map(|end| end - self.tempo.1 / self.tempo.0 * 60.0).filter(|point| *point > 0.0);
                }
            });
            if let Some(point) = loop_point {
                if let Some(music) = self.music() {
                    changed = true;
                    music.insert("fading_point".into(), ((point * 10000.0).round() / 10000.0).into());
                }
            }
        }

        let has_sequence = self.yaml.contains_key("music_seq");
        egui::CollapsingHeader::new(t("Weitere Dateien (Sequenz)", "Further files (sequence)")).id_salt("cue-sequence").default_open(has_sequence).show(ui, |ui| {
            ui.label(RichText::new(t("Die Dateien spielen nacheinander und beginnen dann wieder von vorn; jede übergibt an ihrem Loop-Punkt.", "The files play one after the other and then start over; each hands on at its loop point.")).color(MUTED));
            let (dir, cache) = (self.audio_dir.clone(), &mut self.info);
            let mut channels_of = |file: &str| cache.entry(file.to_string()).or_insert_with(|| probe(&dir, file)).map(|(channels, _)| channels);
            changed |= crate::cue_forms::sequence(ui, &mut self.yaml, &self.audio_files, &self.channels, &mut channels_of);
        });
        let sends = ["cue_midi", "cue_osc", "cue_http", "cue_display", "osc"].iter().any(|key| self.yaml.contains_key(*key));
        egui::CollapsingHeader::new(t("Nachrichten an Geräte", "Messages to devices")).id_salt("cue-messages").default_open(sends).show(ui, |ui| {
            changed |= crate::cue_forms::messages(ui, &mut self.yaml, &self.devices);
        });

        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.label(t("Start-Timecode", "Start timecode"));
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

        ui.add_space(10.0);
        ui.label(RichText::new(t("VERKNÜPFUNGEN", "LINKS")).size(12.0).color(MUTED));
        let cues = self.cues.clone();
        // S/L/F: either the audio chains into another cue at its end, or it loops until
        // its outro is fired.
        for (key, label) in [("chain_end", t("Am Ende nahtlos weiter mit", "At the end, carry straight on with")), ("loop_outro", t("Loop, bis dieses Outro kommt", "Loop until this outro comes"))] {
            ui.horizontal(|ui| {
                ui.label(label);
                if let Some(choice) = cue_picker(ui, key, &cues, note_of(self.yaml.get(key))) {
                    changed = true;
                    match choice {
                        Some(note) => drop(self.yaml.insert(key.into(), note_value(note))),
                        None => drop(self.yaml.shift_remove(key)),
                    }
                }
            });
        }

        // Auto-cue: this cue fires by itself, tied to another cue.
        let auto = self.yaml.get("auto_trigger").cloned();
        let source = note_of(auto.as_ref().and_then(|a| a.get("trigger_note")));
        let delay = auto.as_ref().and_then(|a| a.get("delay")).and_then(Value::as_f64);
        let mut by_delay = delay.is_some();
        let mut amount = delay.or(auto.as_ref().and_then(|a| a.get("at")).and_then(Value::as_f64)).unwrap_or(0.0);
        let mut new_source = source;
        let mut auto_changed = false;
        ui.horizontal(|ui| {
            ui.label(t("Von selbst auslösen durch", "Fire by itself, triggered by"));
            if let Some(choice) = cue_picker(ui, "auto-source", &cues, source) {
                new_source = choice;
                auto_changed = true;
            }
        });
        if new_source.is_some() {
            ui.horizontal(|ui| {
                ui.add_space(16.0);
                auto_changed |= ui.radio_value(&mut by_delay, false, t("wenn dessen Audio bei", "when its audio is at")).changed();
                auto_changed |= ui.radio_value(&mut by_delay, true, t("nach", "after a delay of")).changed();
                auto_changed |= ui.add(egui::DragValue::new(&mut amount).speed(0.05).range(0.0..=36000.0).suffix(" s")).changed();
                ui.label(if by_delay { t("Verzögerung", "") } else { t("ist", "") });
            });
        }
        if auto_changed {
            changed = true;
            match new_source {
                Some(note) => {
                    let mut map = Mapping::new();
                    map.insert("trigger_note".into(), note_value(note));
                    map.insert(if by_delay { "delay" } else { "at" }.into(), ((amount * 1000.0).round() / 1000.0).into());
                    self.yaml.insert("auto_trigger".into(), Value::Mapping(map));
                }
                None => drop(self.yaml.shift_remove("auto_trigger")),
            }
        }

        // Adjust: what this cue does to another cue's audio. Stored with this cue's audio.
        if self.yaml.contains_key("music") && !self.yaml.get("music").is_some_and(|m| m.get("audios").is_some()) {
            let adjust = self.yaml.get("music").and_then(|m| m.get("adjust")).cloned();
            let target = note_of(adjust.as_ref().and_then(|a| a.get("trigger_note")));
            let mut fade_out = adjust.as_ref().and_then(|a| a.get("fadeout")).and_then(Value::as_bool) == Some(true);
            let mut volume = adjust.as_ref().and_then(|a| a.get("volume")).and_then(Value::as_f64).unwrap_or(0.3);
            let mut fade_time = adjust.as_ref().and_then(|a| a.get("fadetime")).and_then(Value::as_f64).unwrap_or(3.0);
            let mut new_target = target;
            let mut adjust_changed = false;
            ui.horizontal(|ui| {
                ui.label(t("Beim Auslösen anderes Audio anpassen", "On firing, adjust other audio"));
                if let Some(choice) = cue_picker(ui, "adjust-target", &cues, target) {
                    new_target = choice;
                    adjust_changed = true;
                }
            });
            if new_target.is_some() {
                ui.horizontal(|ui| {
                    ui.add_space(16.0);
                    adjust_changed |= ui.radio_value(&mut fade_out, true, t("ausfaden", "fade out")).changed();
                    adjust_changed |= ui.radio_value(&mut fade_out, false, t("auf", "to")).changed();
                    adjust_changed |= ui.add_enabled(!fade_out, egui::Slider::new(&mut volume, 0.0..=1.0)).changed();
                    ui.label(t("in", "over"));
                    adjust_changed |= ui.add(egui::DragValue::new(&mut fade_time).speed(0.05).range(0.0..=600.0).suffix(" s")).changed();
                });
            }
            if adjust_changed {
                changed = true;
                if let Some(music) = self.music() {
                    match new_target {
                        Some(note) => {
                            let mut map = Mapping::new();
                            map.insert("trigger_note".into(), note_value(note));
                            if fade_out {
                                map.insert("fadeout".into(), true.into());
                            } else {
                                map.insert("volume".into(), ((volume * 100.0).round() / 100.0).into());
                            }
                            // 3 s is the default and is not written out.
                            if (fade_time - 3.0).abs() > 1e-9 {
                                map.insert("fadetime".into(), ((fade_time * 1000.0).round() / 1000.0).into());
                            }
                            music.insert("adjust".into(), Value::Mapping(map));
                        }
                        None => drop(music.shift_remove("adjust")),
                    }
                }
            }
        }
        changed
    }

    /// Draw the dialog. Returns `Some(true)` on Save, `Some(false)` on Cancel.
    pub fn show(&mut self, ui: &mut Ui, cast: &Cast) -> Option<bool> {
        let mut result = None;
        egui::ScrollArea::vertical().auto_shrink([false, false]).max_height(ui.available_height() - 44.0).show(ui, |ui| {
            self.fields(ui, cast);
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

/// Channel count and length in seconds of an audio file.
fn probe(audio_dir: &Path, file: &str) -> Option<(usize, f64)> {
    let path = audio_dir.join(file);
    let rate = mdstage_engine::clip::Clip::probe_rate(&path)?;
    let info = mdstage_engine::stream::Reader::open(&path, rate).ok()?.info();
    Some((info.channels, info.duration()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drawing the dialog must not change a cue nobody touched — whatever it holds.
    #[test]
    fn drawing_the_dialog_leaves_the_cue_as_it_is() {
        let text = "```yaml\nconfig:\n    roles:\n        Anna: {ch: 1}\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 1}\nmic: Anna\nnote: Auftritt\nstart_tc: \"01:00:00:00\"\nmusic:\n    loop: true\n    volume: 0.7\n    fadein: 1.5\n    fading_point: 12\n    audios:\n        - file: band.wav\n          patch: [L, [R, Sub]]\n        - file: click.wav\n          mono: true\n          volume: 0.5\n          patch: [Click]\n    adjust:\n        trigger_note: {ch: 1, note: 2}\n        fadeout: true\n        fadetime: 2\nmusic_seq:\n    - file: b.wav\n      fading_point: 28\n    - audios:\n          - file: c.wav\nloop_outro: {ch: 1, note: 2}\nauto_trigger:\n    trigger_note: {ch: 1, note: 2}\n    delay: 3\ncue_midi:\n    - {device: Licht, type: cc, ch: 2, cc: 7, value: 64}\n    - {type: sysex, bytes: F0 41 F7}\ncue_osc:\n    - {device: QLab, path: /go, arg: 0.8, arg_type: float}\ncue_http:\n    - {device: Pult, method: POST, path: /api, body: \"{}\"}\ncue_display:\n    - {device: Foyer, markdown: \"# Eins\", announce: Achtung}\nosc: /alt/{ch}\nosc_arg: 3\nosc_arg_type: int\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 2}\nmusic: out.wav\n```\n";
        let script = mdstage_core::Script::parse(text);
        let cast = Cast::from_script(&script, false);
        for block in [1, 2] {
            let mdstage_core::Block::Cue(cue) = &script.blocks[block] else { panic!("block {block} is a cue") };
            assert!(!cue.invalid);
            let devices = crate::cue_forms::Devices { midi: vec!["Licht".into()], osc: vec!["QLab".into()], ..Default::default() };
            let mut dialog = CueDialog::new(block, false, Some(&cue.yaml), Path::new("/nonexistent"), false, vec![(Note { ch: 1, note: 2 }, "Cue 2".into())]).with_setup(vec!["L".into(), "R".into(), "Sub".into(), "Click".into()], devices);
            let ctx = egui::Context::default();
            for _ in 0..3 {
                let _ = ctx.run(Default::default(), |ctx| {
                    egui::CentralPanel::default().show(ctx, |ui| assert_eq!(dialog.show(ui, &cast), None));
                });
            }
            assert!(dialog.value() == cue.yaml, "the dialog changed block {block}:\n{}", mdstage_core::yaml::dump(&dialog.value(), true));
        }
    }
}
