//! Checks a script's cues and reports what the operator should fix (the warning banner).

use serde_yaml_ng::Value;

use crate::cues::Note;
use crate::{Block, Script, yaml};

/// Something wrong with one YAML block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// 1-based number of the YAML block in the file (the config block is 1).
    pub block: usize,
    pub message: String,
}

/// Two cues outside one variant group that share a trigger note.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoteConflict {
    pub note: Note,
    /// YAML block numbers of the first cue with the note and of the clashing one.
    pub first: usize,
    pub second: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub problems: Vec<Problem>,
    pub note_conflicts: Vec<NoteConflict>,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        self.problems.is_empty() && self.note_conflicts.is_empty()
    }
}

fn show(value: &Value) -> String {
    yaml::dump(value, false)
}

/// A finite, non-negative number (optionally at most `max`).
fn is_amount(value: &Value, max: Option<f64>) -> bool {
    value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0 && max.is_none_or(|m| n <= m))
}

fn present<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    value.get(key).filter(|v| !v.is_null())
}

struct Checker<'a> {
    block: usize,
    channels: &'a [String],
    problems: &'a mut Vec<Problem>,
}

impl Checker<'_> {
    fn report(&mut self, message: String) {
        self.problems.push(Problem { block: self.block, message });
    }

    fn timecode(&mut self, cue: &Value) {
        let Some(tc) = present(cue, "start_tc") else { return };
        let text = tc.as_str().map(str::to_string).unwrap_or_else(|| show(tc));
        let parts: Vec<&str> = text.split(':').collect();
        let fields: Vec<u32> = parts.iter().filter(|p| p.len() == 2).filter_map(|p| p.parse().ok()).collect();
        let valid = parts.len() == 4 && fields.len() == 4 && fields[0] <= 23 && fields[1] <= 59 && fields[2] <= 59 && fields[3] <= 24;
        if !valid {
            self.report(format!("Ungültiger Timecode: \"{text}\" (Format HH:MM:SS:FF, Stunden 0–23)"));
        }
    }

    fn osc_path(&mut self, cue: &Value) {
        let Some(osc) = present(cue, "osc") else { return };
        let text = osc.as_str().map(str::to_string).unwrap_or_else(|| show(osc));
        let path = text.replace("{ch}", "00");
        if !path.starts_with('/') || !path.chars().all(|c| (' '..='~').contains(&c)) {
            self.report(format!("Ungültiger OSC-Pfad: \"{text}\""));
        }
    }

    fn trigger_note(&mut self, cue: &Value) {
        let Some(note) = present(cue, "trigger_note") else { return };
        let field = |key: &str| note.get(key).and_then(Value::as_i64);
        let valid = field("ch").is_some_and(|ch| (1..=16).contains(&ch)) && field("note").is_some_and(|n| (0..=127).contains(&n));
        if !valid {
            let text = |key: &str| note.get(key).map_or("undefined".to_string(), show);
            self.report(format!("trigger_note ungültig: ch={} (1–16), note={} (0–127)", text("ch"), text("note")));
        }
    }

    /// Volume and time fields shared by `music` and `music_seq` entries.
    fn transport(&mut self, music: &Value, prefix: &str, with_hints: bool) {
        if let Some(volume) = present(music, "volume").filter(|v| !is_amount(v, Some(1.0))) {
            let hint = if with_hints { " (erwartet 0.0–1.0)" } else { "" };
            self.report(format!("{prefix}.volume ungültig: {}{hint}", show(volume)));
        }
        for key in ["start", "end", "fadein", "fadeout", "fading_point"] {
            if let Some(value) = present(music, key).filter(|v| !is_amount(v, None)) {
                let hint = if with_hints { " (nicht-negative Zahl erwartet)" } else { "" };
                self.report(format!("{prefix}.{key} ungültig: {}{hint}", show(value)));
            }
        }
    }

    fn audios(&mut self, container: &Value, prefix: &str) {
        let Some(audios) = present(container, "audios") else { return };
        let Value::Sequence(list) = audios else {
            self.report(format!("{prefix}.audios muss eine Liste sein"));
            return;
        };
        for (i, audio) in list.iter().enumerate() {
            let prefix = format!("{prefix}.audios[{i}]");
            if audio.get("file").and_then(Value::as_str).is_none_or(str::is_empty) {
                self.report(format!("{prefix}: 'file' (String) fehlt"));
                continue;
            }
            if let Some(volume) = present(audio, "volume").filter(|v| !is_amount(v, Some(1.0))) {
                self.report(format!("{prefix}.volume ungültig: {}", show(volume)));
            }
            match present(audio, "patch") {
                None => {}
                Some(Value::Sequence(patch)) => {
                    let names = patch.iter().flat_map(|entry| match entry {
                        Value::Sequence(fan_out) => fan_out.iter().collect::<Vec<_>>(),
                        single => vec![single],
                    });
                    for name in names.filter(|n| !n.is_null()) {
                        if !name.as_str().is_some_and(|n| self.channels.iter().any(|c| c == n)) {
                            let name = name.as_str().map(str::to_string).unwrap_or_else(|| show(name));
                            self.report(format!(
                                "{prefix}.patch: vKanal „{name}\" existiert nicht (in den Einstellungen definieren oder YAML aufräumen)"
                            ));
                        }
                    }
                }
                Some(_) => self.report(format!("{prefix}.patch muss eine Liste sein")),
            }
        }
    }

    fn cue(&mut self, cue: &Value) {
        if !cue.is_mapping() {
            return;
        }
        self.timecode(cue);
        self.osc_path(cue);
        self.trigger_note(cue);

        if let Some(music) = cue.get("music").filter(|m| m.is_mapping()) {
            self.transport(music, "music", true);
            self.audios(music, "music");
        }
        match present(cue, "music_seq") {
            None => {}
            Some(Value::Sequence(slots)) => {
                for (i, slot) in slots.iter().enumerate() {
                    let prefix = format!("music_seq[{i}]");
                    let has_audios = slot.get("audios").and_then(Value::as_sequence).is_some_and(|a| !a.is_empty());
                    let has_file = slot.get("file").and_then(Value::as_str).is_some_and(|f| !f.is_empty());
                    if !slot.is_mapping() || (!has_audios && !has_file) {
                        self.report(format!("{prefix}: 'file' oder 'audios' fehlt"));
                        continue;
                    }
                    self.transport(slot, &prefix, false);
                    self.audios(slot, &prefix);
                }
            }
            Some(_) => self.report("music_seq muss eine Liste sein".into()),
        }

        if let Some(auto) = cue.get("auto_trigger").filter(|a| a.is_mapping()) {
            for key in ["at", "delay"] {
                if let Some(value) = present(auto, key).filter(|v| !is_amount(v, None)) {
                    self.report(format!("auto_trigger.{key} ungültig: {} (nicht-negative Zahl erwartet)", show(value)));
                }
            }
        }
        for key in ["cue_midi", "cue_osc", "cue_http", "cue_display"] {
            if present(cue, key).is_some_and(|v| !v.is_sequence()) {
                self.report(format!("{key} muss eine Liste sein"));
            }
        }
    }
}

impl Script {
    /// Check every YAML block: unreadable YAML, keys outside the format, invalid field
    /// values, and trigger notes used by more than one variant group.
    pub fn validate(&self) -> Report {
        let channels = self.virtual_channels();
        let mut report = Report::default();
        // (note, block number, variant group) of the first cue seen with each note.
        let mut seen: Vec<(Note, usize, usize)> = Vec::new();
        let mut number = 0;
        let mut group = 0;
        for block in &self.blocks {
            let cue = match block {
                Block::Config(_) => {
                    number += 1;
                    continue;
                }
                Block::Cue(cue) => cue,
                _ => continue,
            };
            number += 1;
            if !cue.is_variant() {
                group += 1;
            }
            if cue.invalid {
                report.problems.push(Problem { block: number, message: "YAML nicht lesbar".into() });
                continue;
            }
            Checker { block: number, channels: &channels, problems: &mut report.problems }.cue(&cue.yaml);

            let Some(note) = cue.note() else { continue };
            match seen.iter().find(|(n, _, _)| *n == note) {
                Some(&(_, first, first_group)) if first_group != group => {
                    report.note_conflicts.push(NoteConflict { note, first, second: number });
                }
                Some(_) => {}
                None => seen.push((note, number, group)),
            }
        }
        for removal in self.cleanup_preview() {
            // Unknown keys only; loop remnants and stale audios are cleanup matters.
            let unknown_key = !removal.key.ends_with(']')
                && !matches!(removal.key.as_str(), "music.fading_point" | "music.loop");
            if unknown_key {
                report.problems.push(Problem { block: removal.block, message: format!("Unbekannter Schlüssel: {}", removal.key) });
            }
        }
        report.problems.sort_by_key(|p| p.block);
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "```yaml\nconfig:\n    roles: {}\n```\n";

    fn messages(cue: &str) -> Vec<String> {
        let script = Script::parse(&format!("{CONFIG}\n```yaml\n{cue}\n```\n"));
        script.validate().problems.into_iter().map(|p| p.message).collect()
    }

    #[test]
    fn a_well_formed_cue_is_clean() {
        let cue = "\
note: Go
mic: [Anna]
start_tc: '01:00:00:24'
osc: /ch/{ch}/mix/on
trigger_note: {ch: 16, note: 0}
music:
    file: a.wav
    volume: 1
    start: 0
    fading_point: 3.5
    loop: true
    audios:
        - {file: b.wav, volume: 0.5, patch: [L, [L, R]]}
music_seq:
    - {file: c.wav, volume: 0.2}
    - {audios: [{file: d.wav}]}
auto_trigger: {trigger_note: {ch: 1, note: 2}, at: 0}
cue_midi: []
cue_display:
    - {device: Foyer, markdown: Hi}";
        assert_eq!(messages(cue), Vec::<String>::new());
    }

    #[test]
    fn reports_invalid_field_values() {
        assert_eq!(messages("start_tc: '24:00:00:00'"), ["Ungültiger Timecode: \"24:00:00:00\" (Format HH:MM:SS:FF, Stunden 0–23)"]);
        assert_eq!(messages("start_tc: '1:00:00:00'").len(), 1);
        assert_eq!(messages("start_tc: '01:00:00:25'").len(), 1);
        assert_eq!(messages("osc: light/day"), ["Ungültiger OSC-Pfad: \"light/day\""]);
        assert_eq!(messages("osc: /bühne").len(), 1);
        assert_eq!(messages("trigger_note: {ch: 17, note: 3}"), ["trigger_note ungültig: ch=17 (1–16), note=3 (0–127)"]);
        assert_eq!(messages("trigger_note: {ch: 1}"), ["trigger_note ungültig: ch=1 (1–16), note=undefined (0–127)"]);
        assert_eq!(
            messages("music:\n    file: a.wav\n    volume: 1.5\n    start: -1\n    end: soon"),
            [
                "music.volume ungültig: 1.5 (erwartet 0.0–1.0)",
                "music.start ungültig: -1 (nicht-negative Zahl erwartet)",
                "music.end ungültig: soon (nicht-negative Zahl erwartet)",
            ]
        );
        assert_eq!(
            messages("music:\n    audios:\n        - {volume: 1}\n        - {file: b.wav, volume: 2, patch: [L, Sub, [R, Click]]}\n        - {file: c.wav, patch: L}"),
            [
                "music.audios[0]: 'file' (String) fehlt",
                "music.audios[1].volume ungültig: 2",
                "music.audios[1].patch: vKanal „Sub\" existiert nicht (in den Einstellungen definieren oder YAML aufräumen)",
                "music.audios[1].patch: vKanal „Click\" existiert nicht (in den Einstellungen definieren oder YAML aufräumen)",
                "music.audios[2].patch muss eine Liste sein",
            ]
        );
        assert_eq!(
            messages("music_seq:\n    - {volume: 0.5}\n    - {file: a.wav, fadein: -2}\n    - {file: b.wav, audios: 3}\nloop_outro: {ch: 1, note: 9}"),
            ["music_seq[0]: 'file' oder 'audios' fehlt", "music_seq[1].fadein ungültig: -2", "music_seq[2].audios muss eine Liste sein"]
        );
        assert_eq!(messages("music_seq: a.wav"), ["music_seq muss eine Liste sein"]);
        assert_eq!(
            messages("auto_trigger: {trigger_note: {ch: 1, note: 1}, at: -1, delay: x}"),
            ["auto_trigger.at ungültig: -1 (nicht-negative Zahl erwartet)", "auto_trigger.delay ungültig: x (nicht-negative Zahl erwartet)"]
        );
        assert_eq!(messages("cue_midi: {device: Licht}\ncue_osc: x"), ["cue_midi muss eine Liste sein", "cue_osc muss eine Liste sein"]);
    }

    #[test]
    fn reports_unreadable_yaml_and_unknown_keys() {
        assert_eq!(messages("mic: [Anna"), ["YAML nicht lesbar"]);
        assert_eq!(messages("foo: 1\nmusic:\n    file: a.wav\n    monitor: true"), ["Unbekannter Schlüssel: foo", "Unbekannter Schlüssel: music.monitor"]);
        // Loop remnants are for "Clean up YAML", not for the warning banner.
        assert_eq!(messages("music:\n    file: a.wav\n    fading_point: 2"), Vec::<String>::new());
    }

    #[test]
    fn finds_trigger_notes_shared_across_variant_groups() {
        let text = format!(
            "{CONFIG}\n```yaml\ntrigger_note: {{ch: 1, note: 1}}\n```\n\n```yaml\nsibling: true\ntrigger_note: {{ch: 1, note: 1}}\n```\n\n```yaml\ntrigger_note: {{ch: 1, note: 2}}\n```\n\n```yaml\ntrigger_note: {{ch: 1, note: 1}}\n```\n"
        );
        let report = Script::parse(&text).validate();
        assert!(report.problems.is_empty());
        // The variant may share its root's note; the later, separate cue may not.
        assert_eq!(report.note_conflicts, [NoteConflict { note: Note { ch: 1, note: 1 }, first: 2, second: 5 }]);
        assert!(!report.is_clean());
    }
}
