//! Show-file model for MDstage. Pure: no file or device access.
//!
//! Spike scope: split a script into blocks and read the cue fields the UI displays.
//! Serialising back to Markdown and the cue logic follow in the next phase.

pub mod cues;
pub mod edit;
pub mod format;
pub mod mic;
pub mod yaml;

use serde_yaml_ng::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    /// The `config:` YAML block (roles, groups, show-level settings).
    Config(Config),
    Heading { level: u8, text: String },
    /// `*Stage direction*`
    Stage(String),
    /// `**Role**` or `**Role1/Role2**`, followed by dialogue lines.
    Role { names: Vec<String>, text: String },
    Cue(Cue),
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub yaml: Value,
    /// The YAML exactly as it stands in the file, written back unchanged until edited.
    pub source: String,
}

/// A cue (trigger): a YAML block other than the config block.
#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub yaml: Value,
    /// The YAML could not be parsed; `source` holds it verbatim.
    pub invalid: bool,
    pub source: String,
}

/// Transport of a cue's audio, in seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Music {
    pub file: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub volume: f64,
    pub looped: bool,
}

impl Cue {
    fn field(&self, key: &str) -> Option<&Value> {
        self.yaml.get(key)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.field(key)?.as_str()
    }

    /// Role or group names of the `mic` field (a single name or a list).
    pub fn mics(&self) -> Vec<&str> {
        match self.field("mic") {
            Some(Value::String(s)) => vec![s.as_str()],
            Some(Value::Sequence(list)) => list.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        }
    }

    /// `(channel, note)` of the cue's trigger note.
    pub fn trigger_note(&self) -> Option<(u64, u64)> {
        let note = self.field("trigger_note")?;
        Some((note.get("ch")?.as_u64()?, note.get("note")?.as_u64()?))
    }

    /// The cue's audio: `music: file.wav`, or the object form with `file`.
    pub fn music(&self) -> Option<Music> {
        let music = self.field("music")?;
        if let Some(file) = music.as_str() {
            return Some(Music { file: file.into(), start: None, end: None, volume: 1.0, looped: false });
        }
        let number = |key: &str| music.get(key).and_then(Value::as_f64);
        Some(Music {
            file: music.get("file")?.as_str()?.into(),
            start: number("start"),
            end: number("end"),
            volume: number("volume").unwrap_or(1.0),
            looped: music.get("loop").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Script {
    pub blocks: Vec<Block>,
}

impl Script {
    /// Split a show file into blocks. Blocks are separated by blank lines; YAML fences
    /// may contain blank lines.
    pub fn parse(text: &str) -> Script {
        let mut blocks = Vec::new();
        let mut paragraph: Vec<&str> = Vec::new();
        let mut lines = text.lines();
        while let Some(line) = lines.next() {
            if line.trim_start().starts_with("```yaml") {
                flush(&mut paragraph, &mut blocks);
                let source: Vec<&str> = lines.by_ref().take_while(|l| !l.trim_start().starts_with("```")).collect();
                blocks.push(yaml_block(&source.join("\n")));
            } else if line.trim().is_empty() {
                flush(&mut paragraph, &mut blocks);
            } else {
                paragraph.push(line);
            }
        }
        flush(&mut paragraph, &mut blocks);
        Script { blocks }
    }

    /// Write the script back as a show file: one blank line between blocks. YAML blocks
    /// keep their original text, so an unedited file survives a round trip byte for byte
    /// (provided it already follows that spacing).
    pub fn to_markdown(&self) -> String {
        let blocks: Vec<String> = self
            .blocks
            .iter()
            .map(|block| match block {
                Block::Config(Config { source, .. }) | Block::Cue(Cue { source, .. }) => {
                    format!("```yaml\n{source}\n```")
                }
                Block::Heading { level, text } => format!("{} {text}", "#".repeat(*level as usize)),
                Block::Stage(text) => format!("*{text}*"),
                Block::Role { names, text } if text.is_empty() => format!("**{}**", names.join("/")),
                Block::Role { names, text } => format!("**{}**\n{text}", names.join("/")),
                Block::Text(text) => text.clone(),
            })
            .collect();
        blocks.join("\n\n") + "\n"
    }

    pub fn config(&self) -> Option<&Value> {
        self.blocks.iter().find_map(|b| match b {
            Block::Config(c) => c.yaml.get("config"),
            _ => None,
        })
    }

    /// `(role name, colour)` pairs from the config block, in file order.
    pub fn roles(&self) -> Vec<(String, String)> {
        let Some(Value::Mapping(roles)) = self.config().and_then(|c| c.get("roles")) else {
            return Vec::new();
        };
        roles
            .iter()
            .filter_map(|(name, role)| {
                let colour = role.get("color").and_then(Value::as_str).unwrap_or_default();
                Some((name.as_str()?.to_string(), colour.to_string()))
            })
            .collect()
    }
}

fn yaml_block(source: &str) -> Block {
    match serde_yaml_ng::from_str::<Value>(source) {
        Ok(yaml) if yaml.get("config").is_some() => Block::Config(Config { yaml, source: source.into() }),
        Ok(yaml) => Block::Cue(Cue { yaml, invalid: false, source: source.into() }),
        Err(_) => Block::Cue(Cue { yaml: Value::Null, invalid: true, source: source.into() }),
    }
}

fn flush(paragraph: &mut Vec<&str>, blocks: &mut Vec<Block>) {
    if paragraph.is_empty() {
        return;
    }
    blocks.push(text_block(paragraph));
    paragraph.clear();
}

fn text_block(lines: &[&str]) -> Block {
    let first = lines[0].trim();
    if let Some(rest) = first.strip_prefix('#') {
        let level = 1 + rest.chars().take_while(|&c| c == '#').count();
        let text = rest.trim_start_matches('#').trim();
        if level <= 6 && lines.len() == 1 {
            return Block::Heading { level: level as u8, text: text.into() };
        }
    }
    if let Some(names) = first.strip_prefix("**").and_then(|s| s.strip_suffix("**")) {
        if !names.is_empty() && !names.contains("**") {
            return Block::Role {
                names: names.split('/').map(|n| n.trim().to_string()).collect(),
                text: lines[1..].join("\n"),
            };
        }
    }
    let joined = lines.join("\n");
    let trimmed = joined.trim();
    let is_stage = trimmed.len() > 2
        && trimmed.starts_with('*')
        && trimmed.ends_with('*')
        && !trimmed.starts_with("**")
        && !trimmed[1..trimmed.len() - 1].contains('*');
    if is_stage {
        return Block::Stage(trimmed[1..trimmed.len() - 1].into());
    }
    Block::Text(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
```yaml
config:
    roles:
        Anna:
            color: blue
        Ben:
            color: green
```

# Act 1

## Scene 1

*The stage is dark.*

```yaml
mic:
    - Anna
light: Night

music:
    file: ambience.mp3
    volume: 0.8
    start: 2.5
    loop: true
trigger_note:
    ch: 1
    note: 3
```

**Anna**
Hello.
How are *(quietly)* you?

**Anna/Ben**
Together!

Plain text.
```yaml
music: drumroll.mp3
```
";

    #[test]
    fn splits_a_script_into_blocks() {
        let script = Script::parse(SAMPLE);
        let kinds: Vec<&str> = script
            .blocks
            .iter()
            .map(|b| match b {
                Block::Config(_) => "config",
                Block::Heading { .. } => "heading",
                Block::Stage(_) => "stage",
                Block::Role { .. } => "role",
                Block::Cue(_) => "cue",
                Block::Text(_) => "text",
            })
            .collect();
        assert_eq!(kinds, ["config", "heading", "heading", "stage", "cue", "role", "role", "text", "cue"]);

        assert_eq!(script.blocks[1], Block::Heading { level: 1, text: "Act 1".into() });
        assert_eq!(script.blocks[2], Block::Heading { level: 2, text: "Scene 1".into() });
        assert_eq!(script.blocks[3], Block::Stage("The stage is dark.".into()));
        assert_eq!(
            script.blocks[5],
            Block::Role { names: vec!["Anna".into()], text: "Hello.\nHow are *(quietly)* you?".into() }
        );
        assert_eq!(
            script.blocks[6],
            Block::Role { names: vec!["Anna".into(), "Ben".into()], text: "Together!".into() }
        );
        assert_eq!(script.roles(), [("Anna".to_string(), "blue".to_string()), ("Ben".to_string(), "green".to_string())]);
    }

    #[test]
    fn reads_cue_fields() {
        let script = Script::parse(SAMPLE);
        let Block::Cue(cue) = &script.blocks[4] else { panic!("expected a cue") };
        assert_eq!(cue.mics(), ["Anna"]);
        assert_eq!(cue.text("light"), Some("Night"));
        assert_eq!(cue.trigger_note(), Some((1, 3)));
        assert_eq!(
            cue.music(),
            Some(Music { file: "ambience.mp3".into(), start: Some(2.5), end: None, volume: 0.8, looped: true })
        );

        let Block::Cue(short) = &script.blocks[8] else { panic!("expected a cue") };
        assert_eq!(short.music().unwrap().file, "drumroll.mp3");
        assert_eq!(short.trigger_note(), None);
    }

    #[test]
    fn keeps_broken_yaml_as_an_invalid_cue() {
        let script = Script::parse("```yaml\nmic: [Anna\n```\n");
        let Block::Cue(cue) = &script.blocks[0] else { panic!("expected a cue") };
        assert!(cue.invalid);
        assert_eq!(cue.source, "mic: [Anna");
    }

    #[test]
    fn demo_show_survives_a_round_trip_unchanged() {
        let text = include_str!("../../../website/preview/script.md");
        assert_eq!(Script::parse(text).to_markdown(), text);
    }

    #[test]
    fn writing_normalises_spacing_and_is_stable() {
        let written = Script::parse(SAMPLE).to_markdown();
        assert!(written.contains("Plain text.\n\n```yaml\nmusic: drumroll.mp3\n```\n"));
        assert!(written.contains("light: Night\n\nmusic:"), "blank lines inside YAML are kept");
        assert_eq!(Script::parse(&written).to_markdown(), written);
        assert_eq!(Script::parse(&written), Script::parse(SAMPLE));
    }

    #[test]
    fn parses_the_demo_show() {
        let text = include_str!("../../../website/preview/script.md");
        let script = Script::parse(text);
        let cues = script.blocks.iter().filter(|b| matches!(b, Block::Cue(_))).count();
        let invalid = script.blocks.iter().filter(|b| matches!(b, Block::Cue(c) if c.invalid)).count();
        assert_eq!(script.roles().len(), 6);
        assert!(cues >= 5, "{cues} cues");
        assert_eq!(invalid, 0);
        assert!(script.blocks.iter().any(|b| matches!(b, Block::Stage(_))));
    }
}
