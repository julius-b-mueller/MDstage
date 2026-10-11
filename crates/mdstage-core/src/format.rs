//! The formatting standard applied when a show file is opened: blank lines around
//! headings, stage directions and role names, one sentence per line in dialogue, and no
//! runs of blank lines. YAML blocks are never touched.

const ABBREVIATIONS: [&str; 26] = [
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "inc", "ltd", "co", "gen", "sgt", "lt", "cpt", "nr", "str",
    "bzw", "usw", "etc", "ggf", "bzgl", "ca", "vs", "vgl", "abb",
];

/// Whether the full stop at byte `dot` ends an abbreviation ("Mr.", "bzw.") or an initial
/// ("H.") rather than a sentence.
fn abbreviation_before(text: &str, dot: usize) -> bool {
    let word = text[..dot].rsplit(char::is_whitespace).next().unwrap_or("");
    let mut letters = word.chars();
    let single_letter = matches!((letters.next(), letters.next()), (Some(c), None) if c.is_alphabetic());
    let lower = word.to_lowercase();
    single_letter || ABBREVIATIONS.contains(&lower.as_str()) || lower == "bd"
}

/// Put every sentence on its own line: break after `.`, `!` or `?` (and closing quotes or
/// brackets) when an upper-case letter, opening quote or bracket follows.
fn wrap_sentences(text: &str) -> String {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let (offset, c) = chars[i];
        out.push(c);
        i += 1;
        if !matches!(c, '.' | '!' | '?') {
            continue;
        }
        let mut closers = i;
        while closers < chars.len() && matches!(chars[closers].1, '“' | '”' | '»' | ')') {
            closers += 1;
        }
        let mut next = closers;
        while next < chars.len() && chars[next].1.is_whitespace() {
            next += 1;
        }
        let starts_sentence = chars
            .get(next)
            .is_some_and(|&(_, n)| n.is_ascii_uppercase() || matches!(n, 'Ä' | 'Ö' | 'Ü' | '„' | '”' | '('));
        if next == closers || !starts_sentence || (c == '.' && abbreviation_before(text, offset)) {
            continue;
        }
        out.extend(chars[i..closers].iter().map(|&(_, c)| c));
        out.push('\n');
        i = next;
    }
    out
}

fn is_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    (1..=6).contains(&hashes) && line[hashes..].starts_with(' ')
}

/// `*Stage direction*`, optionally ending in `^`.
fn is_stage(line: &str) -> bool {
    let mut chars = line.chars();
    let opens = chars.next() == Some('*') && chars.next().is_some_and(|c| c != '*');
    opens && (line.ends_with('*') || line.ends_with("*^"))
}

/// `**Role name**` alone on the line.
fn is_role(line: &str) -> bool {
    line.strip_prefix("**").is_some_and(|rest| !rest.starts_with('*') && !rest.is_empty()) && line.ends_with("**")
}

/// Apply the formatting standard. Idempotent: formatting a formatted script changes nothing.
pub fn format_script(text: &str) -> String {
    // Splitting a line at `<br>` can expose a sentence boundary that only the next pass
    // sees, so repeat until nothing changes (two passes in practice).
    let mut formatted = format_once(text);
    for _ in 0..4 {
        let again = format_once(&formatted);
        if again == formatted {
            break;
        }
        formatted = again;
    }
    formatted
}

fn format_once(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_yaml = false;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if (!in_yaml && trimmed == "```yaml") || (in_yaml && trimmed == "```") {
            in_yaml = !in_yaml;
            out.push(line.to_string());
            continue;
        }
        if in_yaml {
            out.push(line.to_string());
            continue;
        }

        let previous = out.last().map_or("", |l| l.trim());
        let after_blank = out.is_empty() || previous.is_empty();
        let before_blank = lines.get(i + 1).is_none_or(|l| l.trim().is_empty());

        if is_heading(trimmed) {
            out.push(line.to_string());
            if !before_blank {
                out.push(String::new());
            }
        } else if is_stage(trimmed) {
            // A stage direction directly under a role name belongs to that role.
            if !is_role(previous) && !after_blank {
                out.push(String::new());
            }
            out.push(line.to_string());
            if !before_blank {
                out.push(String::new());
            }
        } else if is_role(trimmed) {
            if !after_blank {
                out.push(String::new());
            }
            out.push(line.to_string());
        } else if !trimmed.is_empty() {
            // Hard line breaks (`<br>`) with text after them become real line ends.
            let parts = split_br(trimmed);
            let wrapped = if parts.len() > 1 && !parts[parts.len() - 1].trim().is_empty() {
                let segments: Vec<String> =
                    parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).map(wrap_sentences).collect();
                segments.join(" <br>\n")
            } else {
                wrap_sentences(trimmed)
            };
            out.extend(wrapped.split('\n').map(str::to_string));
        } else {
            out.push(line.to_string());
        }
    }

    let mut result: Vec<&str> = Vec::with_capacity(out.len());
    let mut in_yaml = false;
    for line in &out {
        let trimmed = line.trim();
        if (!in_yaml && trimmed == "```yaml") || (in_yaml && trimmed == "```") {
            in_yaml = !in_yaml;
        } else if !in_yaml && trimmed.is_empty() && result.last().is_none_or(|l| l.trim().is_empty()) {
            continue; // leading blank line, or a second blank line in a row
        }
        result.push(line);
    }
    while result.last().is_some_and(|l| l.trim().is_empty()) {
        result.pop();
    }
    result.join("\n") + "\n"
}

/// Split at `<br>`, case-insensitively.
fn split_br(line: &str) -> Vec<&str> {
    let lower = line.to_ascii_lowercase();
    let mut parts = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<br>") {
        parts.push(&line[from..from + at]);
        from += at + 4;
    }
    parts.push(&line[from..]);
    parts
}

pub fn needs_formatting(text: &str) -> bool {
    format_script(text) != text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_dialogue_at_sentence_boundaries() {
        assert_eq!(wrap_sentences("Hello there. How are you? Fine! (Good.) „Ja.“"), "Hello there.\nHow are you?\nFine!\n(Good.)\n„Ja.“");
        assert_eq!(wrap_sentences("He said “Stop.” Then left."), "He said “Stop.”\nThen left.");
        assert_eq!(wrap_sentences("wait... what. no"), "wait... what. no", "lower case does not start a sentence");
        assert_eq!(wrap_sentences("Ende.Anfang"), "Ende.Anfang", "no space, no break");
    }

    #[test]
    fn does_not_break_after_abbreviations_and_initials() {
        let text = "Mr. Gatsby and Dr. Eckleburg met H. Wilson, bzw. Tom. Then they left.";
        assert_eq!(wrap_sentences(text), "Mr. Gatsby and Dr. Eckleburg met H. Wilson, bzw. Tom.\nThen they left.");
        assert_eq!(wrap_sentences("Siehe Bd. Zwei! Los."), "Siehe Bd. Zwei!\nLos.");
        assert_eq!(wrap_sentences("Really Mr! Yes."), "Really Mr!\nYes.", "only a full stop marks an abbreviation");
    }

    #[test]
    fn spaces_out_headings_roles_and_stage_directions() {
        let text = "\n\n# Act 1\n**Anna**\nHello. World.\n*She leaves.*\n**Ben**\n*(quietly)*\nOh.\n\n\n\nPlain text<br>More. Text<br>\n## Scene\n\n";
        let expected = "\
# Act 1

**Anna**
Hello.
World.

*She leaves.*

**Ben**
*(quietly)*

Oh.

Plain text <br>
More.
Text<br>
## Scene
";
        let formatted = format_script(text);
        assert_eq!(formatted, expected);
        assert_eq!(format_script("One<br>Two. Three\n"), "One <br>\nTwo.\nThree\n", "<br> with text after it ends the line");
        assert_eq!(format_script(&formatted), formatted, "formatting is idempotent");
        assert!(needs_formatting(text) && !needs_formatting(expected));
    }

    #[test]
    fn leaves_yaml_blocks_alone() {
        let text = "```yaml\nnote: Hello. World.\n\n\n# not a heading\n**x**\n```\n\n**Anna**\nHi.\n";
        assert_eq!(format_script(text), text);
        assert_eq!(format_script("a\r\nb\r\n"), "a\nb\n");
    }

    #[test]
    fn the_demo_show_is_already_formatted() {
        let text = include_str!("../testdata/demo.md");
        assert!(!needs_formatting(text));
    }
}
