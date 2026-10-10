//! Writes YAML the way MDstage show files are written: block style, four-space indent,
//! plain scalars where safe and single quotes otherwise, `|` literals for multi-line text.
//!
//! The layout follows what earlier MDstage versions produced, so a cue that is edited
//! and saved looks like its neighbours and existing files do not churn.

pub use serde_yaml_ng::{Mapping, Value};

const INDENT: usize = 4;

/// Note references written on one line (`trigger_note: {ch: 1, note: 42}`) in cue blocks.
const NOTE_KEYS: [&str; 3] = ["trigger_note", "chain_end", "loop_outro"];

/// Serialise `value`. With `inline_notes`, note references are written on one line (used
/// for cue blocks, not for the config block). The result has no trailing newline.
pub fn dump(value: &Value, inline_notes: bool) -> String {
    let mut out = String::new();
    match value {
        Value::Mapping(map) if !map.is_empty() => write_mapping(&mut out, map, 0, inline_notes),
        Value::Sequence(seq) if !seq.is_empty() => write_sequence(&mut out, seq, 0, inline_notes),
        other => {
            write_inline(&mut out, other, 0);
        }
    }
    out.truncate(out.trim_end().len());
    out
}

fn pad(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

fn write_mapping(out: &mut String, map: &Mapping, indent: usize, inline_notes: bool) {
    for (key, value) in map {
        pad(out, indent);
        let name = key.as_str();
        match key {
            Value::String(s) => out.push_str(&scalar(s)),
            other => write_inline(out, other, indent),
        }
        out.push(':');
        let note = name.filter(|n| inline_notes && NOTE_KEYS.contains(n)).and_then(|_| note_fields(value));
        if let Some((ch, note)) = note {
            out.push_str(&format!(" {{ch: {ch}, note: {note}}}\n"));
        } else {
            write_child(out, value, indent, inline_notes);
        }
    }
}

fn write_sequence(out: &mut String, seq: &[Value], indent: usize, inline_notes: bool) {
    for item in seq {
        pad(out, indent);
        out.push('-');
        write_child(out, item, indent, inline_notes);
    }
}

/// Write a value after `key:` or `-`: scalars on the same line, collections below.
fn write_child(out: &mut String, value: &Value, indent: usize, inline_notes: bool) {
    match value {
        Value::Mapping(map) if !map.is_empty() => {
            out.push('\n');
            write_mapping(out, map, indent + INDENT, inline_notes);
        }
        Value::Sequence(seq) if !seq.is_empty() => {
            out.push('\n');
            write_sequence(out, seq, indent + INDENT, inline_notes);
        }
        Value::Tagged(tagged) => write_child(out, &tagged.value, indent, inline_notes),
        other => {
            out.push(' ');
            write_inline(out, other, indent);
            out.push('\n');
        }
    }
}

/// Write a scalar or an empty collection at the current position.
fn write_inline(out: &mut String, value: &Value, indent: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) if s.contains('\n') && is_printable(s) => write_literal(out, s, indent + INDENT),
        Value::String(s) => out.push_str(&scalar(s)),
        Value::Mapping(_) => out.push_str("{}"),
        Value::Sequence(_) => out.push_str("[]"),
        Value::Tagged(tagged) => write_inline(out, &tagged.value, indent),
    }
}

/// `{ch, note}` if the value is exactly a note reference.
fn note_fields(value: &Value) -> Option<(u64, u64)> {
    let map = value.as_mapping()?;
    let mut keys = map.keys().filter_map(Value::as_str);
    let ordered = map.len() == 2 && keys.next() == Some("ch") && keys.next() == Some("note");
    if !ordered {
        return None;
    }
    Some((map.get("ch")?.as_u64()?, map.get("note")?.as_u64()?))
}

fn number(n: &serde_yaml_ng::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_nan() => ".nan".into(),
        Some(f) if f.is_infinite() => if f > 0.0 { ".inf" } else { "-.inf" }.into(),
        // Whole numbers are written without a fraction, as before.
        Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        Some(f) => format!("{f}"),
        None => n.to_string(),
    }
}

/// Multi-line text as a literal block scalar.
fn write_literal(out: &mut String, text: &str, indent: usize) {
    out.push('|');
    if text.starts_with(' ') {
        out.push_str(&INDENT.to_string());
    }
    let body = if text.ends_with("\n\n") || text == "\n" {
        out.push('+');
        &text[..text.len() - 1]
    } else if let Some(clipped) = text.strip_suffix('\n') {
        clipped
    } else {
        out.push('-');
        text
    };
    for line in body.split('\n') {
        out.push('\n');
        if !line.is_empty() {
            pad(out, indent);
            out.push_str(line);
        }
    }
}

fn is_printable(s: &str) -> bool {
    s.chars().all(|c| c == '\n' || c == '\t' || !c.is_control())
}

/// A single-line string: plain if that reads back as the same string, quoted otherwise.
fn scalar(s: &str) -> String {
    if !is_printable(s) || s.contains('\n') {
        let mut quoted = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => quoted.push_str("\\\""),
                '\\' => quoted.push_str("\\\\"),
                '\n' => quoted.push_str("\\n"),
                '\t' => quoted.push_str("\\t"),
                '\r' => quoted.push_str("\\r"),
                c if c.is_control() => quoted.push_str(&format!("\\x{:02X}", c as u32)),
                c => quoted.push(c),
            }
        }
        quoted.push('"');
        return quoted;
    }
    if is_plain_safe(s) { s.to_string() } else { format!("'{}'", s.replace('\'', "''")) }
}

fn is_plain_safe(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let (Some(&first), Some(&last)) = (chars.first(), chars.last()) else { return false };
    if first.is_whitespace() || "-?:,[]{}#&*!|=>'\"%@`".contains(first) {
        return false;
    }
    if last.is_whitespace() || last == ':' {
        return false;
    }
    for pair in chars.windows(2) {
        // `: ` would start a mapping value, ` #` a comment.
        if (pair[0] == ':' && pair[1].is_whitespace()) || (pair[0].is_whitespace() && pair[1] == '#') {
            return false;
        }
    }
    !reads_as_non_string(s)
}

/// Whether a plain scalar with this text would be read as null, a boolean, a number or a
/// date — by current YAML or by the older rules other tools still apply.
fn reads_as_non_string(s: &str) -> bool {
    const WORDS: [&str; 26] = [
        "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE", "y", "Y", "yes", "Yes", "YES",
        "on", "On", "ON", "n", "N", "no", "No", "NO", "off", "Off", "OFF",
    ];
    if WORDS.contains(&s) || s == "<<" {
        return true;
    }
    if !matches!(serde_yaml_ng::from_str::<Value>(s), Ok(Value::String(_))) {
        return true;
    }
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '_');
    let unsigned = s.strip_prefix(['-', '+']).unwrap_or(s);
    // Base-60 numbers such as `01:00:00:00` (old YAML reads them as integers).
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.contains(':') && whole.split(':').all(digits) && (fraction.is_empty() || digits(fraction)) {
        return true;
    }
    // Numbers with digit separators, and dates.
    if digits(whole) && (fraction.is_empty() || digits(fraction)) {
        return true;
    }
    let date: Vec<&str> = s.splitn(3, '-').collect();
    date.len() == 3
        && date[0].len() == 4
        && digits(date[0])
        && digits(date[1])
        && date[2].chars().next().is_some_and(|c| c.is_ascii_digit())
        && date[2].chars().all(|c| c.is_ascii_digit() || "Tt :.Zz+-".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(source: &str, inline_notes: bool) {
        let value: Value = serde_yaml_ng::from_str(source).unwrap();
        let written = dump(&value, inline_notes);
        assert_eq!(written, source.trim_end());
        assert_eq!(serde_yaml_ng::from_str::<Value>(&written).unwrap(), value, "reads back as the same data");
    }

    #[test]
    fn writes_a_cue_like_earlier_versions_did() {
        roundtrip(
            "\
note: 'TODO: Einlassmusik'
mic:
    - Anna
    - Ben
music:
    file: loop a.wav
    volume: 0.8
    start: 2.326
    loop: true
    audios:
        -
            file: band.wav
            patch:
                - Saal L
                -
                    - Sub L
                    - Sub R
    adjust:
        trigger_note: {ch: 1, note: 3}
        fadeout: true
trigger_note: {ch: 1, note: 42}
chain_end: {ch: 2, note: 5}
start_tc: '02:00:00:00'
osc: /light/day
cue_display:
    -
        device: Stage Left
        markdown: |-
            # Scene 3

            Cue in 4 bars
        announce: Scene three, standby
",
            true,
        );
    }

    #[test]
    fn writes_the_config_block_without_inline_notes() {
        roundtrip(
            "\
config:
    roles:
        Anna:
            color: blue
            ch: null
        Mrs. McKee:
            color: '#c678dd'
            ch: 3
    groups: {}
    emLightNote:
        ch: 1
        note: 64
    virtualChannels:
        -
            name: L
    outputDevices: []
    app_version: 1.16.0
",
            false,
        );
    }

    #[test]
    fn quotes_only_what_would_not_read_back_as_the_same_string() {
        let plain = ["Anna", "/cue/42/start", "a, b", "Übergang -> Ausfaden", "it's", "50%", "a:b", "F0 41 F7", "1.16.0"];
        for s in plain {
            assert_eq!(scalar(s), s, "{s:?} should stay plain");
        }
        let quoted = [
            "", " x", "x ", "- x", "#tag", "a: b", "a #b", "x:", "true", "No", "null", "~", "42", "0.5", "1e3", "0x1F",
            "01:00:00:00", "2026-10-10", "{a}", "[a]", "*a", "&a", "!a", "|", ">", "@a", "`a", "%a", "'a", "\"a", "=",
        ];
        for s in quoted {
            let written = scalar(s);
            assert!(written.starts_with('\''), "{s:?} should be quoted, got {written}");
            assert_eq!(serde_yaml_ng::from_str::<Value>(&written).unwrap(), Value::String(s.into()), "{s:?}");
        }
        assert_eq!(scalar("it's: here"), "'it''s: here'");
        assert_eq!(scalar("tab\u{1}"), "\"tab\\x01\"");
    }

    #[test]
    fn writes_numbers_and_literals() {
        let value: Value = serde_yaml_ng::from_str("a: 2.0\nb: 0.097\nc: -3\nd: \"x\\ny\\n\"\ne: \"x\\n\\n\"\nf: \" lead\\nx\"").unwrap();
        assert_eq!(dump(&value, false), "a: 2\nb: 0.097\nc: -3\nd: |\n    x\n    y\ne: |+\n    x\n\nf: |4-\n     lead\n    x");
        assert_eq!(dump(&Value::Null, false), "null");
        assert_eq!(dump(&serde_yaml_ng::from_str("{}").unwrap(), false), "{}");
    }

    #[test]
    fn inlines_only_exact_note_references() {
        let value: Value = serde_yaml_ng::from_str("trigger_note: {ch: 1, note: 2, extra: 3}\nloop_outro: {note: 2, ch: 1}").unwrap();
        assert_eq!(dump(&value, true), "trigger_note:\n    ch: 1\n    note: 2\n    extra: 3\nloop_outro:\n    note: 2\n    ch: 1");
    }
}
