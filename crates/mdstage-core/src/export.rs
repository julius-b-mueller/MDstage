//! The script as a printable book: what goes into the PDF and DOCX exports, independent
//! of the file format.

use crate::cues::{AutoWhen, Cues, Slf};
use crate::mic::{Cast, Mic, MicChip};
use crate::{Block, Script};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    /// Include the cue boxes.
    pub cues: bool,
    /// Print role names in their colours.
    pub colours: bool,
    /// Show microphone groups as groups rather than as their member roles.
    pub grouped_mics: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Heading { level: u8, text: String },
    Stage(String),
    /// Role names with their colours (`#rrggbb`, empty without colours) and the dialogue.
    Role { names: Vec<(String, String)>, dialogue: String },
    Cue(CueBox),
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CueBox {
    pub number: usize,
    /// Left of the header: variant mark and S/L/F role.
    pub title: String,
    /// Right of the header: the trigger note.
    pub trigger: String,
    /// Label/value lines.
    pub rows: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Book {
    pub title: String,
    pub items: Vec<Item>,
}

fn colour_hex(name: Option<&str>) -> String {
    let hex = match name {
        Some("red") => "e06c75",
        Some("green") => "98c379",
        Some("yellow") => "e5c07b",
        Some("blue") => "61afef",
        Some("purple") => "c678dd",
        Some("cyan") => "56b6c2",
        Some("darkred") => "b03c45",
        Some("darkgreen") => "68b349",
        Some("darkyellow") => "b5904b",
        Some("darkblue") => "317fbf",
        Some("darkpurple") => "9648ad",
        Some("darkcyan") => "268692",
        Some(other) if other.len() == 7 && other.starts_with('#') => return other.to_string(),
        _ => "888888",
    };
    format!("#{hex}")
}

fn percent(volume: f64) -> String {
    format!("{} %", (volume * 100.0).round())
}

impl Script {
    /// Lay the script out as a book. The title is the first top-level heading. `fired`
    /// gives the time each cue (0-based) was last triggered, for a "Zeit" line in its box.
    pub fn book(&self, cast: &Cast, options: Options, fired: &[(usize, String)]) -> Book {
        let cues = Cues::new(self);
        let note_label = |cue: usize| cues.get(cue).and_then(|c| c.note()).map_or("?".to_string(), |n| n.to_string());
        let mut title = None;
        let mut items = Vec::new();
        let mut number = 0;
        for (index, block) in self.blocks.iter().enumerate() {
            match block {
                Block::Config(_) => {}
                Block::Heading { level, text } => {
                    if *level == 1 && title.is_none() {
                        title = Some(text.clone());
                    }
                    items.push(Item::Heading { level: (*level).min(3), text: text.clone() });
                }
                Block::Stage(text) => items.push(Item::Stage(text.trim_end_matches('^').to_string())),
                Block::Role { names, text } => {
                    let colour = |name: &String| {
                        let named = cast.role(name).and_then(|r| r.color.as_deref()).or(cast.groups.iter().find(|g| g.name == *name).and_then(|g| g.color.as_deref()));
                        if options.colours { colour_hex(named) } else { String::new() }
                    };
                    let names = names.iter().map(|n| (n.clone(), colour(n))).collect();
                    // Hard breaks become real line ends.
                    let dialogue = crate::format::shown(text);
                    items.push(Item::Role { names, dialogue });
                }
                Block::Text(text) => items.push(Item::Text(text.clone())),
                Block::Cue(cue) => {
                    number += 1;
                    if !options.cues || cue.invalid {
                        continue;
                    }
                    let cue_index = number - 1;
                    let mut title_parts = Vec::new();
                    if cue.is_variant() {
                        title_parts.push("[Variante]".to_string());
                    }
                    let from_notes = |from: &[usize]| from.iter().map(|&f| note_label(f)).collect::<Vec<_>>().join(", ");
                    match cues.slf(cue_index) {
                        Some(Slf::Start { next }) => title_parts.push(format!("Start → {next}")),
                        Some(Slf::Loop { outro }) => title_parts.push(format!("Loop ↩ {outro}")),
                        Some(Slf::Finish { from }) => title_parts.push(format!("Finish ← {}", from_notes(&from))),
                        Some(Slf::Bridge { from, next }) => title_parts.push(format!("Bridge ← {} → {next}", from_notes(&from))),
                        None => {}
                    }

                    let mut rows: Vec<(String, String)> = Vec::new();
                    match self.mic_for_cue(index, cast) {
                        Mic::MuteAll => rows.push(("Mic".into(), "alle aus".into())),
                        mic @ Mic::Open(_) => {
                            let chips = cast.chips(&mic, options.grouped_mics);
                            let text: Vec<String> = chips
                                .into_iter()
                                .map(|chip| match chip {
                                    MicChip::Role { name, .. } => name,
                                    MicChip::Group { name, members, .. } => {
                                        format!("{name} ({})", members.into_iter().map(|m| m.0).collect::<Vec<_>>().join(", "))
                                    }
                                })
                                .collect();
                            rows.push(("Mic".into(), text.join(", ")));
                        }
                        Mic::Unchanged => {}
                    }
                    if let Some(audio) = cue.audio() {
                        let part = &audio.parts[0];
                        let mut text = audio.parts.iter().map(|p| p.audios.iter().map(|a| a.file.as_str()).collect::<Vec<_>>().join(" + ")).collect::<Vec<_>>().join(" → ");
                        let mut details = vec![format!("Vol {}", percent(part.volume))];
                        details.extend(part.start.map(|s| format!("Start {} s", crate::format::seconds(s))));
                        details.extend(part.end.map(|e| format!("Ende {} s", crate::format::seconds(e))));
                        details.extend(part.fadein.filter(|f| *f > 0.0).map(|f| format!("Fade-in {} s", crate::format::seconds(f))));
                        details.extend(part.fadeout.filter(|f| *f > 0.0).map(|f| format!("Fade-out {} s", crate::format::seconds(f))));
                        if audio.looped {
                            details.push(audio.crossfade().map_or("Loop".to_string(), |fade| format!("Loop mit Crossfade {} s", crate::format::seconds(fade))));
                        }
                        text.push_str(&format!(" ({})", details.join(", ")));
                        if let Some(adjust) = cue.adjust() {
                            let target = cues.find(adjust.target).map_or("?".to_string(), |c| cues.name(c));
                            match (adjust.fadeout, adjust.volume) {
                                (true, _) => text.push_str(&format!(" → {target} ausfaden")),
                                (false, Some(v)) => text.push_str(&format!(" → {target} auf {}", percent(v))),
                                _ => {}
                            }
                        }
                        rows.push(("♬".into(), text));
                    }
                    for (label, key) in [("QLC+", "qlcplus"), ("Proj.", "projection"), ("Notiz", "note"), ("TC", "start_tc")] {
                        if let Some(value) = cue.text(key) {
                            rows.push((label.into(), value.to_string()));
                        }
                    }
                    if let Some((_, time)) = fired.iter().find(|(c, _)| *c == cue_index) {
                        rows.push(("Zeit".into(), time.clone()));
                    }
                    if let Some(auto) = cue.auto_trigger() {
                        let source = cues.find(auto.source).map_or("?".to_string(), |c| cues.name(c));
                        rows.push((
                            "Auto".into(),
                            match auto.when {
                                AutoWhen::At(at) => format!("bei {} s in {source}", crate::format::seconds(at)),
                                AutoWhen::Delay(delay) => format!("{} s nach {source}", crate::format::seconds(delay)),
                            },
                        ));
                    }
                    let trigger = cue.note().map(|n| format!("{}.{}", n.ch, n.note)).unwrap_or_default();
                    items.push(Item::Cue(CueBox { number, title: title_parts.join("  "), trigger, rows }));
                }
            }
        }
        Book { title: title.unwrap_or_else(|| "Skript".into()), items }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOW: &str = "\
```yaml
config:
    roles:
        Anna: {color: blue, ch: 1}
        Ben: {color: '#123456', ch: 2}
    groups:
        Duo: {color: purple, roles: [Anna, Ben]}
```

# Der Titel

## Szene 1

*Licht aus.*

```yaml
mic: [Duo]
music:
    file: loop.wav
    volume: 0.5
    start: 2
    fadein: 1
    loop: true
loop_outro: {ch: 1, note: 2}
note: Vorsicht
trigger_note: {ch: 1, note: 1}
```

```yaml
sibling: true
music:
    file: out.wav
    adjust: {trigger_note: {ch: 1, note: 1}, volume: 0.2}
auto_trigger: {trigger_note: {ch: 1, note: 1}, delay: 4}
trigger_note: {ch: 1, note: 2}
```

**Anna/Ben**
Hallo. <br> Zweite Zeile *(leise)* <br>
Dritte

Freier Text.
";

    #[test]
    fn lays_out_the_book() {
        let script = Script::parse(SHOW);
        let cast = Cast::from_script(&script, false);
        let book = script.book(&cast, Options { cues: true, colours: true, grouped_mics: true }, &[]);
        assert_eq!(book.title, "Der Titel");
        assert_eq!(book.items.len(), 7);
        assert_eq!(book.items[1], Item::Heading { level: 2, text: "Szene 1".into() });
        assert_eq!(book.items[2], Item::Stage("Licht aus.".into()));
        assert_eq!(
            book.items[3],
            Item::Cue(CueBox {
                number: 1,
                title: "Loop ↩ 1.2".into(),
                trigger: "1.1".into(),
                rows: vec![
                    ("Mic".into(), "Duo (Anna, Ben)".into()),
                    ("♬".into(), "loop.wav (Vol 50 %, Start 2 s, Fade-in 1 s, Loop)".into()),
                    ("Notiz".into(), "Vorsicht".into()),
                ],
            })
        );
        assert_eq!(
            book.items[4],
            Item::Cue(CueBox {
                number: 2,
                title: "[Variante]  Finish ← 1.1".into(),
                trigger: "1.2".into(),
                rows: vec![("♬".into(), "out.wav (Vol 80 %) → Cue 1.1 auf 20 %".into()), ("Auto".into(), "4 s nach Cue 1.1".into())],
            })
        );
        assert_eq!(
            book.items[5],
            Item::Role { names: vec![("Anna".into(), "#61afef".into()), ("Ben".into(), "#123456".into())], dialogue: "Hallo.\nZweite Zeile *(leise)*\nDritte".into() }
        );
        assert_eq!(book.items[6], Item::Text("Freier Text.".into()));
    }

    #[test]
    fn options_leave_out_cues_colours_and_groups() {
        let script = Script::parse(SHOW);
        let cast = Cast::from_script(&script, false);
        let plain = script.book(&cast, Options { cues: false, colours: false, grouped_mics: false }, &[]);
        assert!(!plain.items.iter().any(|i| matches!(i, Item::Cue(_))));
        assert!(matches!(&plain.items[3], Item::Role { names, .. } if names[0].1.is_empty()));
        let flat = script.book(&cast, Options { cues: true, colours: false, grouped_mics: false }, &[(1, "20:15:03".into())]);
        assert!(matches!(&flat.items[3], Item::Cue(c) if c.rows[0] == ("Mic".to_string(), "Anna, Ben".to_string())));
        assert!(matches!(&flat.items[3], Item::Cue(c) if !c.rows.iter().any(|r| r.0 == "Zeit")));
        assert!(matches!(&flat.items[4], Item::Cue(c) if c.rows.contains(&("Zeit".to_string(), "20:15:03".to_string()))));
        assert_eq!(Script::parse("Nur Text.\n").book(&cast, Options { cues: true, colours: true, grouped_mics: true }, &[]).title, "Skript");
    }
}
