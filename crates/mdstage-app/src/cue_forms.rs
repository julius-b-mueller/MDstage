//! The longer forms of the cue dialog: several audios with their channel patch, the
//! further files of a multi-part loop, and the messages a cue sends to devices.
//!
//! Every function edits the cue's YAML in place and returns whether it changed anything.

use std::ops::RangeInclusive;

use eframe::egui::{self, RichText, Ui};
use mdstage_core::yaml::{Mapping, Value};

use crate::lang::t;
use crate::theme::*;

/// The names of the output devices set up on this machine, by kind.
#[derive(Clone, Default)]
pub struct Devices {
    pub midi: Vec<String>,
    pub osc: Vec<String>,
    pub http: Vec<String>,
    pub display: Vec<String>,
}

/// The lists of messages a cue sends.
pub const MESSAGE_KEYS: [&str; 4] = ["cue_midi", "cue_osc", "cue_http", "cue_display"];

/// Messages copied from a cue, for pasting into another: `(list, message)`. They are
/// kept as long as the program runs, whichever show is open.
pub fn copied_messages(ctx: &egui::Context) -> Vec<(String, Value)> {
    ctx.data(|data| data.get_temp(egui::Id::new("copied-messages"))).unwrap_or_default()
}

pub fn copy_messages(ctx: &egui::Context, messages: Vec<(String, Value)>) {
    ctx.data_mut(|data| data.insert_temp(egui::Id::new("copied-messages"), messages));
}

/// All messages a cue sends, in the order of its lists.
pub fn messages_of(yaml: &Mapping) -> Vec<(String, Value)> {
    MESSAGE_KEYS.iter().flat_map(|key| yaml.get(*key).and_then(Value::as_sequence).into_iter().flatten().map(|message| (key.to_string(), message.clone()))).collect()
}

/// Add copied messages to a cue, each to the end of its list.
pub fn paste_messages(yaml: &mut Mapping, messages: &[(String, Value)]) {
    for (key, message) in messages {
        match yaml.get_mut(key.as_str()).and_then(Value::as_sequence_mut) {
            Some(list) => list.push(message.clone()),
            None => drop(yaml.insert(key.as_str().into(), Value::Sequence(vec![message.clone()]))),
        }
    }
}

/// How many messages, in words.
pub fn count_messages(count: usize) -> String {
    match (count, crate::lang::english()) {
        (1, true) => "1 message".to_string(),
        (1, false) => "1 Nachricht".to_string(),
        (n, true) => format!("{n} messages"),
        (n, false) => format!("{n} Nachrichten"),
    }
}

fn mapping(pairs: &[(&str, Value)]) -> Mapping {
    let mut map = Mapping::new();
    for (key, value) in pairs {
        map.insert((*key).into(), value.clone());
    }
    map
}

/// A one-line text field for the entry `key`; emptying it removes the entry.
fn text(ui: &mut Ui, map: &mut Mapping, key: &str, hint: &str, width: f32) -> bool {
    let mut value = match map.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    };
    let changed = ui.add(egui::TextEdit::singleline(&mut value).hint_text(hint).desired_width(width)).changed();
    if changed {
        match value.is_empty() {
            true => drop(map.shift_remove(key)),
            false => drop(map.insert(key.into(), value.into())),
        }
    }
    changed
}

fn integer(ui: &mut Ui, map: &mut Mapping, key: &str, label: &str, range: RangeInclusive<i64>) -> bool {
    let mut value = map.get(key).and_then(Value::as_i64).unwrap_or(*range.start());
    ui.label(label);
    let changed = ui.add(egui::DragValue::new(&mut value).range(range)).changed();
    if changed {
        map.insert(key.into(), value.into());
    }
    changed
}

/// Choose one of `options` for the entry `key`.
fn choice(ui: &mut Ui, id: impl std::hash::Hash, map: &mut Mapping, key: &str, options: &[&str], default: &str) -> bool {
    let current = map.get(key).and_then(Value::as_str).unwrap_or(default).to_string();
    let mut picked = current.clone();
    egui::ComboBox::from_id_salt(id).selected_text(picked.clone()).width(84.0).show_ui(ui, |ui| {
        for option in options {
            ui.selectable_value(&mut picked, option.to_string(), *option);
        }
    });
    let changed = picked != current;
    if changed {
        map.insert(key.into(), picked.into());
    }
    changed
}

/// Choose the device a message goes to. Without one it goes to the first of its kind.
fn device(ui: &mut Ui, id: impl std::hash::Hash, map: &mut Mapping, devices: &[String]) -> bool {
    let current = map.get("device").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut picked = current.clone();
    let first = t("— erstes Gerät —", "— first device —");
    egui::ComboBox::from_id_salt(id).selected_text(if picked.is_empty() { first.to_string() } else { picked.clone() }).width(130.0).show_ui(ui, |ui| {
        ui.selectable_value(&mut picked, String::new(), first);
        // A device named in the show file stays selectable even if it is not set up here.
        for name in devices.iter().chain(Some(&current).filter(|c| !c.is_empty() && !devices.contains(c))) {
            ui.selectable_value(&mut picked, name.clone(), name);
        }
    });
    let changed = picked != current;
    if changed {
        match picked.is_empty() {
            true => drop(map.shift_remove("device")),
            false => drop(map.insert("device".into(), picked.into())),
        }
    }
    changed
}

/// Choose an audio file for the entry `file`.
fn file(ui: &mut Ui, id: impl std::hash::Hash, map: &mut Mapping, files: &[String]) -> bool {
    let current = map.get("file").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut picked = current.clone();
    let none = t("— Datei wählen —", "— choose a file —");
    egui::ComboBox::from_id_salt(id).selected_text(if picked.is_empty() { none.to_string() } else { picked.clone() }).width(260.0).show_ui(ui, |ui| {
        for name in files.iter().chain(Some(&current).filter(|c| !c.is_empty() && !files.contains(c))) {
            ui.selectable_value(&mut picked, name.clone(), name);
        }
    });
    let changed = picked != current;
    if changed {
        map.insert("file".into(), picked.into());
    }
    changed
}

/// Edit the list under `key`: one row per entry, drawn by `row`, each with a remove
/// button (and, for messages, one to copy it); `fresh` makes the entry the add button
/// appends. An emptied list is removed.
fn list(ui: &mut Ui, yaml: &mut Mapping, key: &str, add: &str, fresh: impl Fn() -> Mapping, mut row: impl FnMut(&mut Ui, usize, &mut Mapping) -> bool) -> bool {
    let copyable = MESSAGE_KEYS.contains(&key);
    let mut entries: Vec<Value> = yaml.get(key).and_then(Value::as_sequence).cloned().unwrap_or_default();
    let mut changed = false;
    let mut remove = None;
    for (i, entry) in entries.iter_mut().enumerate() {
        let Some(map) = entry.as_mapping_mut() else { continue };
        ui.horizontal_wrapped(|ui| {
            changed |= row(ui, i, map);
            if copyable && ui.small_button(t("Kopieren", "Copy")).on_hover_text(t("Diese Nachricht kopieren, um sie in einen anderen Cue einzufügen", "Copy this message to paste it into another cue")).clicked() {
                copy_messages(ui.ctx(), vec![(key.to_string(), Value::Mapping(map.clone()))]);
            }
            if ui.small_button("×").on_hover_text(t("Entfernen", "Remove")).clicked() {
                remove = Some(i);
            }
        });
    }
    if let Some(i) = remove {
        entries.remove(i);
        changed = true;
    }
    if ui.button(add).clicked() {
        entries.push(Value::Mapping(fresh()));
        changed = true;
    }
    if changed {
        match entries.is_empty() {
            true => drop(yaml.shift_remove(key)),
            false => drop(yaml.insert(key.into(), Value::Sequence(entries))),
        }
    }
    changed
}

/// The audios of one part (the `audios` list of `music` or of a `music_seq` entry): file,
/// mono mix, level, and for every channel of the file the virtual channels it plays on.
/// `channels_of` tells how many channels a file has.
pub fn audios(ui: &mut Ui, id: usize, part: &mut Mapping, files: &[String], channels: &[String], channels_of: &mut dyn FnMut(&str) -> Option<usize>) -> bool {
    list(
        ui,
        part,
        "audios",
        t("+ Audio", "+ Audio"),
        || mapping(&[("file", "".into())]),
        |ui, i, audio| {
            let mut changed = file(ui, ("audio-file", id, i), audio, files);
            let mut mono = audio.get("mono").and_then(Value::as_bool) == Some(true);
            if ui.checkbox(&mut mono, "Mono").on_hover_text(t("Alle Kanäle der Datei zu einem mischen", "Mix all channels of the file down to one")).changed() {
                changed = true;
                match mono {
                    true => drop(audio.insert("mono".into(), true.into())),
                    false => drop(audio.shift_remove("mono")),
                }
                // The patch has one entry per channel; it no longer fits.
                audio.shift_remove("patch");
            }
            let mut volume = audio.get("volume").and_then(Value::as_f64).unwrap_or(1.0);
            ui.label(t("Pegel", "Level"));
            if ui.add(egui::DragValue::new(&mut volume).speed(0.01).range(0.0..=1.0)).changed() {
                changed = true;
                audio.insert("volume".into(), ((volume * 100.0).round() / 100.0).into());
            }

            // The patch as written, or else the default: channel n on the n-th virtual
            // channel, a mono mix on the first two.
            let name = audio.get("file").and_then(Value::as_str).unwrap_or_default().to_string();
            let written: Option<Vec<Vec<String>>> = audio.get("patch").and_then(Value::as_sequence).map(|entries| {
                entries
                    .iter()
                    .map(|entry| match entry {
                        Value::Sequence(names) => names.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                        single => single.as_str().map(str::to_string).into_iter().collect(),
                    })
                    .collect()
            });
            let sources = if mono { 1 } else { channels_of(&name).or(written.as_ref().map(Vec::len)).unwrap_or(2) };
            let mut patch: Vec<Vec<String>> = (0..sources)
                .map(|source| match &written {
                    Some(written) => written.get(source).cloned().unwrap_or_default(),
                    None if mono => channels.iter().take(2).cloned().collect(),
                    None => channels.get(source).cloned().into_iter().collect(),
                })
                .collect();
            let mut patched = false;
            ui.end_row();
            for (source, targets) in patch.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.add_space(24.0);
                    let label = if mono { "Mono →".to_string() } else { format!("{} {} →", t("Kanal", "Channel"), source + 1) };
                    ui.label(RichText::new(label).color(MUTED));
                    for channel in channels {
                        let on = targets.contains(channel);
                        if ui.selectable_label(on, channel).clicked() {
                            patched = true;
                            match on {
                                true => targets.retain(|t| t != channel),
                                false => targets.push(channel.clone()),
                            }
                        }
                    }
                });
                ui.end_row();
            }
            if patched {
                let entries = patch
                    .into_iter()
                    .map(|targets| match targets.len() {
                        1 => Value::String(targets[0].clone()),
                        _ => Value::Sequence(targets.into_iter().map(Value::String).collect()),
                    })
                    .collect();
                audio.insert("patch".into(), Value::Sequence(entries));
            }
            changed | patched
        },
    )
}

/// The further files of a multi-part loop (`music_seq`). Each entry is one file, or
/// several audios with a patch like the main entry, with its own times and level.
pub fn sequence(ui: &mut Ui, yaml: &mut Mapping, files: &[String], channels: &[String], channels_of: &mut dyn FnMut(&str) -> Option<usize>) -> bool {
    list(
        ui,
        yaml,
        "music_seq",
        t("+ Datei hinzufügen", "+ Add file"),
        || mapping(&[("file", "".into())]),
        |ui, i, slot| {
            let mut changed = false;
            if slot.contains_key("audios") {
                ui.vertical(|ui| {
                    changed |= audios(ui, i + 1, slot, files, channels, channels_of);
                });
                ui.end_row();
            } else {
                changed |= file(ui, ("seq-file", i), slot, files);
                if ui.small_button(t("+ Audio", "+ Audio")).on_hover_text(t("Mehrere Audios mit Kanal-Patch in diesem Teil", "Several audios with a channel patch in this part")).clicked() {
                    changed = true;
                    let first = slot.shift_remove("file").unwrap_or_default();
                    slot.insert("audios".into(), Value::Sequence(vec![Value::Mapping(mapping(&[("file", first)])), Value::Mapping(mapping(&[("file", "".into())]))]));
                }
            }
            changed |= crate::cue_dialog::seconds(ui, slot, "start", "Start");
            changed |= crate::cue_dialog::seconds(ui, slot, "end", t("Ende", "End"));
            changed |= crate::cue_dialog::seconds(ui, slot, "fading_point", t("Loop-Punkt", "Loop point"));
            changed |= crate::cue_dialog::seconds(ui, slot, "fadein", t("Einblenden", "Fade in"));
            changed |= crate::cue_dialog::seconds(ui, slot, "fadeout", t("Ausblenden", "Fade out"));
            let mut volume = slot.get("volume").and_then(Value::as_f64).unwrap_or(mdstage_core::cues::DEFAULT_VOLUME);
            ui.label(t("Lautstärke", "Volume"));
            if ui.add(egui::DragValue::new(&mut volume).speed(0.01).range(0.0..=1.0)).changed() {
                changed = true;
                slot.insert("volume".into(), ((volume * 100.0).round() / 100.0).into());
            }
            changed
        },
    )
}

/// The messages a cue sends when it fires: MIDI, OSC, HTTP, display content, and the
/// older single OSC path.
pub fn messages(ui: &mut Ui, yaml: &mut Mapping, devices: &Devices) -> bool {
    let mut changed = false;

    // Copying all of them, and pasting what was copied (here or in another cue).
    let copied = copied_messages(ui.ctx());
    let own = messages_of(yaml);
    ui.horizontal(|ui| {
        if ui.add_enabled(!own.is_empty(), egui::Button::new(t("Alle Nachrichten kopieren", "Copy all messages")).small()).clicked() {
            copy_messages(ui.ctx(), own.clone());
        }
        let paste = if crate::lang::english() { format!("Paste {}", count_messages(copied.len())) } else { format!("{} einfügen", count_messages(copied.len())) };
        if !copied.is_empty() && ui.small_button(paste).clicked() {
            paste_messages(yaml, &copied);
            changed = true;
        }
    });
    ui.add_space(4.0);

    ui.label(RichText::new("MIDI").color(BLUE));
    changed |= list(
        ui,
        yaml,
        "cue_midi",
        "+ MIDI",
        || mapping(&[("type", "note".into()), ("ch", 1.into()), ("note", 60.into()), ("vel", 100.into())]),
        |ui, i, message| {
            let mut changed = device(ui, ("midi-device", i), message, &devices.midi);
            if choice(ui, ("midi-type", i), message, "type", &["note", "cc", "pc", "sysex"], "note") {
                changed = true;
                // What belonged to the previous kind of message goes.
                let kind = message.get("type").and_then(Value::as_str).unwrap_or("note").to_string();
                let keep: &[&str] = match kind.as_str() {
                    "cc" => &["ch", "cc", "value"],
                    "pc" => &["ch", "program"],
                    "sysex" => &["bytes"],
                    _ => &["ch", "note", "vel"],
                };
                for key in ["ch", "note", "vel", "cc", "value", "program", "bytes"] {
                    if !keep.contains(&key) {
                        message.shift_remove(key);
                    }
                }
                if kind != "sysex" && !message.contains_key("ch") {
                    message.insert("ch".into(), 1.into());
                }
            }
            match message.get("type").and_then(Value::as_str).unwrap_or("note") {
                "cc" => {
                    changed |= integer(ui, message, "ch", t("Kanal", "Channel"), 1..=16);
                    changed |= integer(ui, message, "cc", "CC", 0..=127);
                    changed |= integer(ui, message, "value", t("Wert", "Value"), 0..=127);
                }
                "pc" => {
                    changed |= integer(ui, message, "ch", t("Kanal", "Channel"), 1..=16);
                    changed |= integer(ui, message, "program", t("Programm", "Program"), 0..=127);
                }
                "sysex" => changed |= text(ui, message, "bytes", "F0 … F7", 240.0),
                _ => {
                    changed |= integer(ui, message, "ch", t("Kanal", "Channel"), 1..=16);
                    changed |= integer(ui, message, "note", "Note", 0..=127);
                    changed |= integer(ui, message, "vel", "Velocity", 0..=127);
                }
            }
            changed |= text(ui, message, "comment", t("Kommentar", "Comment"), 120.0);
            changed
        },
    );

    ui.add_space(4.0);
    ui.label(RichText::new("OSC").color(GREEN));
    changed |= list(
        ui,
        yaml,
        "cue_osc",
        "+ OSC",
        || mapping(&[("path", "/".into())]),
        |ui, i, message| {
            let mut changed = device(ui, ("osc-device", i), message, &devices.osc);
            changed |= text(ui, message, "path", "/pfad", 200.0);
            changed |= argument(ui, ("osc-arg", i), message, "arg", "arg_type");
            changed |= text(ui, message, "comment", t("Kommentar", "Comment"), 120.0);
            changed
        },
    );

    ui.add_space(4.0);
    ui.label(RichText::new("HTTP").color(YELLOW));
    changed |= list(
        ui,
        yaml,
        "cue_http",
        "+ HTTP",
        || mapping(&[("method", "POST".into()), ("path", "/".into())]),
        |ui, i, message| {
            let mut changed = device(ui, ("http-device", i), message, &devices.http);
            changed |= choice(ui, ("http-method", i), message, "method", &["GET", "POST", "PUT", "DELETE", "PATCH"], "GET");
            changed |= text(ui, message, "path", "/api/…", 170.0);
            changed |= text(ui, message, "body", t("Body (optional)", "Body (optional)"), 170.0);
            changed |= text(ui, message, "content_type", "Content-Type", 130.0);
            changed |= text(ui, message, "comment", t("Kommentar", "Comment"), 120.0);
            changed
        },
    );

    ui.add_space(4.0);
    ui.label(RichText::new("Display").color(RED));
    changed |= list(
        ui,
        yaml,
        "cue_display",
        "+ Display",
        || mapping(&[("markdown", "".into())]),
        |ui, i, message| {
            let mut changed = device(ui, ("display-device", i), message, &devices.display);
            let mut markdown = message.get("markdown").and_then(Value::as_str).unwrap_or_default().to_string();
            if ui.add(egui::TextEdit::multiline(&mut markdown).hint_text("Markdown").desired_rows(2).desired_width(260.0)).changed() {
                changed = true;
                message.insert("markdown".into(), markdown.into());
            }
            changed |= text(ui, message, "announce", t("Durchsage (optional)", "Announcement (optional)"), 180.0);
            changed
        },
    );

    ui.add_space(4.0);
    ui.horizontal_wrapped(|ui| {
        ui.label(RichText::new(t("OSC-Pfad (alt)", "OSC path (legacy)")).color(MUTED));
        changed |= text(ui, yaml, "osc", "/pfad/{ch}", 200.0);
        changed |= argument(ui, "legacy-osc-arg", yaml, "osc_arg", "osc_arg_type");
    });
    ui.horizontal_wrapped(|ui| {
        ui.label(RichText::new("QLC+").color(MUTED));
        changed |= text(ui, yaml, "qlcplus", "", 160.0);
        ui.label(RichText::new(t("Projektion", "Projection")).color(MUTED));
        changed |= text(ui, yaml, "projection", "", 160.0);
    });
    changed
}

/// An OSC argument: its type and, unless there is none, its value.
fn argument(ui: &mut Ui, id: impl std::hash::Hash, map: &mut Mapping, value_key: &str, type_key: &str) -> bool {
    let has_value = map.contains_key(value_key);
    let current = map.get(type_key).and_then(Value::as_str).unwrap_or(if has_value { "string" } else { "none" }).to_string();
    let mut kind = current.clone();
    egui::ComboBox::from_id_salt(id).selected_text(kind.clone()).width(70.0).show_ui(ui, |ui| {
        for option in ["none", "int", "float", "string"] {
            ui.selectable_value(&mut kind, option.to_string(), option);
        }
    });
    let mut changed = kind != current;
    if kind == "none" {
        if changed {
            map.shift_remove(value_key);
            map.shift_remove(type_key);
        }
        return changed;
    }
    let mut value = match map.get(value_key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    };
    changed |= ui.add(egui::TextEdit::singleline(&mut value).hint_text(t("Wert", "value")).desired_width(90.0)).changed();
    if changed {
        map.insert(type_key.into(), kind.clone().into());
        // Written as the type says where the text allows it, so the file reads naturally.
        let typed = match kind.as_str() {
            "int" => value.trim().parse::<i64>().map(Value::from).unwrap_or_else(|_| value.clone().into()),
            "float" => value.trim().parse::<f64>().map(Value::from).unwrap_or_else(|_| value.clone().into()),
            _ => value.into(),
        };
        map.insert(value_key.into(), typed);
    }
    changed
}
