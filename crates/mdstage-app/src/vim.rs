//! Vim keys for the inline editor: the basics of moving, changing, copying and undoing,
//! on the text of one block. What reaches beyond a block (`j` past its last line, `o`
//! for a new block) is handed back to the editor as an `Outcome`.
//!
//! Lines are the block's own lines (a role's name, then each line of its text), not the
//! rows a long line wraps into on screen.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// Keys are commands.
    #[default]
    Normal,
    /// Keys are text; only Escape is a command.
    Insert,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Escape,
    Enter,
    Backspace,
}

/// What a key asks of the editor beyond changing the block's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Stay,
    /// Keep the changes and close the editor.
    Close,
    /// Close the editor without the changes.
    Discard,
    /// Close the editor if nothing was changed (`:q`); otherwise stay.
    Quit,
    /// Go on in the text block above / below.
    LeaveUp,
    LeaveDown,
    /// Keep the changes and start a new block below / above.
    OpenBelow,
    OpenAbove,
    /// Remove the whole block (its only line was deleted).
    DeleteBlock,
    /// Move the block one place up / down in the script.
    MoveUp,
    MoveDown,
    /// Copy the whole block; cut it (copy and remove).
    YankBlock,
    CutBlock,
    /// Put the block last copied or cut below / above this one.
    PasteBelow,
    PasteAbove,
}

/// Every key the editor understands, for the operator to look up: sections of
/// `(keys, what they do)`.
pub fn reference() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    use crate::lang::t;
    vec![
        (
            t("Modi", "Modes"),
            vec![
                ("i  a", t("einfügen vor / nach dem Cursor", "insert before / after the cursor")),
                ("I  A", t("einfügen am Zeilenanfang / Zeilenende", "insert at the start / end of the line")),
                ("Esc", t("zurück in den Normalmodus (schließt den Editor nie)", "back to normal mode (never closes the editor)")),
            ],
        ),
        (
            t("Bewegen", "Moving"),
            vec![
                ("h  l", t("ein Zeichen nach links / rechts", "one character left / right")),
                ("j  k", t("eine Zeile nach unten / oben; am Rand in den Textblock darunter / darüber", "one line down / up; at the edge into the text block below / above")),
                ("w  b  e", t("nächstes Wort / Wortanfang zurück / Wortende", "next word / back to the start of a word / end of a word")),
                ("0  ^  $", t("Zeilenanfang / erstes Zeichen / Zeilenende", "start of the line / first character / end of the line")),
                ("gg  G", t("erste / letzte Zeile des Blocks", "first / last line of the block")),
                (t("Zahl davor", "a number first"), t("wiederholt die Bewegung (3j, 2w); 3G springt zu Zeile 3", "repeats the movement (3j, 2w); 3G goes to line 3")),
                (t("Pfeiltasten", "arrow keys"), t("wie h j k l", "like h j k l")),
            ],
        ),
        (
            t("Zeilen und Blöcke anlegen", "New lines and blocks"),
            vec![
                ("o  O", t("neue Zeile im Block darunter / darüber", "new line in the block below / above")),
                ("go  gO", t("neuer Block darunter / darüber", "new block below / above")),
                ("Enter", t("neuer Block darunter (auch im Einfügemodus)", "new block below (in insert mode too)")),
                ("Shift+Enter", t("Zeilenumbruch im Einfügemodus", "line break in insert mode")),
            ],
        ),
        (
            t("Löschen und Ändern", "Deleting and changing"),
            vec![
                ("x", t("Zeichen löschen", "delete the character")),
                ("dw  D", t("bis zum nächsten Wort / bis zum Zeilenende löschen", "delete up to the next word / to the end of the line")),
                ("dd", t("Zeile löschen; die einzige Zeile: den ganzen Block", "delete the line; the only line: the whole block")),
                ("cw  C  cc", t("Wort / Rest der Zeile / ganze Zeile ersetzen", "change the word / the rest of the line / the whole line")),
                ("J", t("Zeile mit der nächsten verbinden", "join the line with the next")),
                ("u", t("rückgängig", "undo")),
            ],
        ),
        (
            t("Kopieren und Einfügen", "Copying and pasting"),
            vec![
                ("yy  yw", t("Zeile / Wort kopieren", "copy the line / the word")),
                ("p  P", t("dahinter / davor einfügen (bleibt von Block zu Block erhalten)", "paste after / before (kept from block to block)")),
            ],
        ),
        (
            t("Ganzer Block", "The whole block"),
            vec![
                ("gK  gJ", t("Block nach oben / unten verschieben", "move the block up / down")),
                ("yab  dab", t("Block kopieren / ausschneiden", "copy / cut the block")),
                ("gp  gP", t("kopierten Block darunter / darüber einfügen", "put the copied block below / above")),
            ],
        ),
        (
            t("Rollennamen", "Role names"),
            vec![
                ("x  dw  D", t("die Rolle unter dem Cursor entfernen", "remove the role under the cursor")),
                ("cw  C", t("die Rolle unter dem Cursor ersetzen", "change the role under the cursor")),
                ("cc  dd", t("alle Namen leeren / die Namenszeile entfernen", "empty all names / remove the line of names")),
            ],
        ),
        (
            t("Editor verlassen", "Leaving the editor"),
            vec![
                (":w  :wq  :x  ZZ", t("speichern und schließen", "save and close")),
                (t("Klick daneben", "click beside it"), t("speichern und schließen", "save and close")),
                (":q!  ZQ", t("Änderung verwerfen und schließen", "discard the change and close")),
                (":q", t("schließen, wenn nichts geändert wurde", "close if nothing was changed")),
            ],
        ),
    ]
}

#[derive(Default)]
pub struct Vim {
    pub mode: Mode,
    /// The first key of a two-key command (`d`, `c`, `y`, `g`, `Z`), or a command line
    /// being typed (`:w`).
    pending: String,
    /// What was last deleted or yanked, and whether it was whole lines. Kept from block
    /// to block.
    register: Option<(String, bool)>,
    /// Earlier states of the text, with the cursor, for `u`.
    undo: Vec<(String, usize)>,
    /// Set when something was yanked or deleted: text for the system clipboard.
    pub copied: Option<String>,
    /// A number typed before a movement: how many times to make it. 0 = none typed.
    count: usize,
    /// Lines still to go when `j` or `k` with a number ran out of block: the editor
    /// carries on in the next one.
    pub carry: usize,
}

fn line_start(text: &[char], at: usize) -> usize {
    text[..at.min(text.len())].iter().rposition(|c| *c == '\n').map_or(0, |newline| newline + 1)
}

fn line_end(text: &[char], at: usize) -> usize {
    let at = at.min(text.len());
    text[at..].iter().position(|c| *c == '\n').map_or(text.len(), |offset| at + offset)
}

/// Words, punctuation and space are told apart as Vim does.
fn class(c: char) -> u8 {
    match c {
        c if c.is_whitespace() => 0,
        c if c.is_alphanumeric() || c == '_' => 1,
        _ => 2,
    }
}

fn next_word(text: &[char], at: usize) -> usize {
    let mut i = at;
    if let Some(first) = text.get(i).map(|c| class(*c)).filter(|c| *c != 0) {
        while i < text.len() && class(text[i]) == first {
            i += 1;
        }
    }
    while i < text.len() && class(text[i]) == 0 {
        i += 1;
    }
    i
}

fn previous_word(text: &[char], at: usize) -> usize {
    let mut i = at.min(text.len());
    while i > 0 && class(text[i - 1]) == 0 {
        i -= 1;
    }
    if i > 0 {
        let word = class(text[i - 1]);
        while i > 0 && class(text[i - 1]) == word {
            i -= 1;
        }
    }
    i
}

fn word_end(text: &[char], at: usize) -> usize {
    let mut i = (at + 1).min(text.len());
    while i < text.len() && class(text[i]) == 0 {
        i += 1;
    }
    if i < text.len() {
        let word = class(text[i]);
        while i + 1 < text.len() && class(text[i + 1]) == word {
            i += 1;
        }
    }
    i.min(text.len().saturating_sub(1))
}

/// The names in the first line of a role block (`**Anna/Ben**`), as the ranges of
/// characters they take up. `None` if the text does not begin with such a line.
pub fn role_names(text: &[char]) -> Option<Vec<std::ops::Range<usize>>> {
    let end = line_end(text, 0);
    let line = &text[..end];
    let marked = end > 4 && line.starts_with(&['*', '*']) && line.ends_with(&['*', '*']) && !line[2..end - 2].contains(&'*');
    if !marked {
        return None;
    }
    let mut names = Vec::new();
    let mut from = 2;
    for at in 2..=end - 2 {
        if at == end - 2 || line[at] == '/' {
            names.push(from..at);
            from = at + 1;
        }
    }
    Some(names)
}

/// Take the role at `at` out of a role block's first line, with the slash beside it.
/// Returns where the cursor belongs afterwards; `None` (and nothing removed) if `at` is
/// not in such a line or the role is the only one.
pub fn remove_role(text: &mut Vec<char>, at: usize) -> Option<usize> {
    let names = role_names(text)?;
    if names.len() < 2 || at > line_end(text, 0) {
        return None;
    }
    let which = names.iter().position(|name| at <= name.end).unwrap_or(names.len() - 1);
    let name = names[which].clone();
    // The last role takes the slash before it, any other the one after it.
    let gone = if which + 1 == names.len() { name.start - 1..name.end } else { name.start..name.end + 1 };
    let cursor = gone.start;
    text.drain(gone);
    Some(cursor)
}

impl Vim {
    /// A block is opened for editing.
    pub fn begin(&mut self, mode: Mode) {
        self.mode = mode;
        self.pending.clear();
        self.undo.clear();
        self.count = 0;
    }

    /// What has been typed of a command that is not complete yet: a number, the first
    /// key of a two-key command, or a command line.
    pub fn pending(&self) -> String {
        match self.count {
            0 => self.pending.clone(),
            count => format!("{count}{}", self.pending),
        }
    }

    fn yank(&mut self, text: &[char], linewise: bool) {
        let text: String = text.iter().collect();
        self.copied = Some(text.clone());
        self.register = Some((text, linewise));
    }

    fn insert(&mut self, text: &[char], at: usize) {
        self.undo.push((text.iter().collect(), at));
        self.mode = Mode::Insert;
    }

    /// Carry out a key. `cursor` is counted in characters.
    pub fn key(&mut self, key: Key, buffer: &mut String, cursor: &mut usize) -> Outcome {
        let mut text: Vec<char> = buffer.chars().collect();
        let mut at = (*cursor).min(text.len());
        let outcome = match (self.mode, key) {
            (Mode::Insert, Key::Escape) => {
                self.mode = Mode::Normal;
                // As in Vim, the cursor steps back onto the last character typed.
                if at > line_start(&text, at) {
                    at -= 1;
                }
                Outcome::Stay
            }
            (Mode::Insert, _) => Outcome::Stay,
            // Escape only ever leads back to plain normal mode; it never closes the editor.
            (Mode::Normal, Key::Escape) => {
                self.pending.clear();
                self.count = 0;
                Outcome::Stay
            }
            // A command line: `:w` and its relatives are how the editor is left.
            (Mode::Normal, key) if self.pending.starts_with(':') => match key {
                Key::Char(c) => {
                    self.pending.push(c);
                    Outcome::Stay
                }
                Key::Backspace => {
                    self.pending.pop();
                    Outcome::Stay
                }
                _ => match std::mem::take(&mut self.pending).as_str() {
                    ":w" | ":wq" | ":x" => Outcome::Close,
                    ":q!" => Outcome::Discard,
                    ":q" => Outcome::Quit,
                    _ => Outcome::Stay,
                },
            },
            // Enter goes on in a new block below, as it does while typing.
            (Mode::Normal, Key::Enter) => {
                self.pending.clear();
                Outcome::OpenBelow
            }
            (Mode::Normal, Key::Backspace) => self.command('h', &mut text, &mut at),
            // A number before a movement (a lone 0 is the movement to the line's start).
            (Mode::Normal, Key::Char(c)) if c.is_ascii_digit() && (c != '0' || self.count > 0) && !matches!(self.pending.as_str(), "d" | "c" | "y" | "da" | "ya" | "Z") => {
                self.count = (self.count * 10 + c as usize - '0' as usize).min(9999);
                Outcome::Stay
            }
            (Mode::Normal, Key::Char(c)) => {
                let outcome = self.command(c, &mut text, &mut at);
                // The number belongs to the command just carried out, unless that was only
                // the first key of one.
                if self.pending.is_empty() {
                    self.count = 0;
                }
                outcome
            }
        };
        if self.mode == Mode::Normal {
            // In normal mode the cursor sits on a character, not behind the last one.
            let (start, end) = (line_start(&text, at), line_end(&text, at));
            if at >= end && end > start {
                at = end - 1;
            }
        }
        *buffer = text.into_iter().collect();
        *cursor = at;
        outcome
    }

    fn command(&mut self, c: char, text: &mut Vec<char>, at: &mut usize) -> Outcome {
        let pending = std::mem::take(&mut self.pending);
        let (start, end) = (line_start(text, *at), line_end(text, *at));
        let save = |vim: &mut Vim, text: &Vec<char>, at: usize| vim.undo.push((text.iter().collect(), at));
        let first_letter = |text: &Vec<char>| start + text[start..end].iter().take_while(|c| c.is_whitespace()).count();
        let times = self.count.max(1);
        // In the line of a role block's names only whole roles go (or the whole line,
        // with `dd`): the asterisks around them are not to be picked apart.
        if start == 0 {
            if let Some(names) = role_names(text) {
                let name = names.iter().find(|name| *at <= name.end).or(names.last()).cloned().unwrap_or(2..2);
                match (pending.as_str(), c) {
                    ("", 'x' | 'D') | ("d", 'w') => {
                        let before: String = text.iter().collect();
                        if let Some(cursor) = remove_role(text, *at) {
                            self.undo.push((before, *at));
                            *at = cursor;
                        }
                        return Outcome::Stay;
                    }
                    // Changing a role: its name goes, the cursor waits in its place.
                    ("", 'C') | ("c", 'w') => {
                        save(self, text, *at);
                        text.drain(name.clone());
                        *at = name.start;
                        self.mode = Mode::Insert;
                        return Outcome::Stay;
                    }
                    ("c", 'c') => {
                        save(self, text, *at);
                        text.drain(2..end - 2);
                        *at = 2;
                        self.mode = Mode::Insert;
                        return Outcome::Stay;
                    }
                    // Nothing is joined onto the names, pasted into them or put above them.
                    ("", 'J' | 'P' | 'O') => return Outcome::Stay,
                    ("", 'p') if !self.register.as_ref().is_some_and(|(_, linewise)| *linewise) => return Outcome::Stay,
                    _ => {}
                }
            }
        }
        match (pending.as_str(), c) {
            // Moving; a number typed before says how many times.
            ("", 'h') => *at = at.saturating_sub(times).max(start),
            ("", 'l') => *at = (*at + times).min(end),
            ("", 'j') => {
                for done in 0..times {
                    let (start, end) = (line_start(text, *at), line_end(text, *at));
                    if end == text.len() {
                        self.carry = times - done - 1;
                        return Outcome::LeaveDown;
                    }
                    let below = end + 1;
                    *at = (below + (*at - start)).min(line_end(text, below));
                }
            }
            ("", 'k') => {
                for done in 0..times {
                    let start = line_start(text, *at);
                    if start == 0 {
                        self.carry = times - done - 1;
                        return Outcome::LeaveUp;
                    }
                    let above = line_start(text, start - 1);
                    *at = (above + (*at - start)).min(start - 1);
                }
            }
            ("", '0') => *at = start,
            ("", '^') => *at = first_letter(text),
            ("", '$') => *at = end,
            ("", 'w') => (0..times).for_each(|_| *at = next_word(text, *at)),
            ("", 'b') => (0..times).for_each(|_| *at = previous_word(text, *at)),
            ("", 'e') => (0..times).for_each(|_| *at = word_end(text, *at)),
            // With a number, G and gg go to that line of the block.
            ("", 'G') | ("g", 'g') if self.count > 0 => {
                *at = 0;
                for _ in 1..times {
                    let end = line_end(text, *at);
                    if end == text.len() {
                        break;
                    }
                    *at = end + 1;
                }
            }
            ("", 'G') => *at = line_start(text, text.len()),
            ("g", 'g') => *at = 0,

            // Typing.
            ("", 'i') => self.insert(text, *at),
            ("", 'a') => {
                self.insert(text, *at);
                *at = (*at + 1).min(end);
            }
            ("", 'I') => {
                self.insert(text, *at);
                *at = first_letter(text);
            }
            ("", 'A') => {
                self.insert(text, *at);
                *at = end;
            }
            // A new line in the block, below or above the cursor's.
            ("", 'o') => {
                self.insert(text, *at);
                text.insert(end, '\n');
                *at = end + 1;
            }
            ("", 'O') => {
                self.insert(text, *at);
                text.insert(start, '\n');
                *at = start;
            }
            // A new block, below or above this one.
            ("g", 'o') => return Outcome::OpenBelow,
            ("g", 'O') => return Outcome::OpenAbove,
            // The block as a whole: move it, copy or cut it ("a block"), put it elsewhere.
            ("g", 'J') => return Outcome::MoveDown,
            ("g", 'K') => return Outcome::MoveUp,
            ("y", 'a') | ("d", 'a') => self.pending = format!("{pending}a"),
            ("ya", 'b') => return Outcome::YankBlock,
            ("da", 'b') => return Outcome::CutBlock,
            ("g", 'p') => return Outcome::PasteBelow,
            ("g", 'P') => return Outcome::PasteAbove,

            // Deleting and changing.
            ("", 'x') if *at < end => {
                save(self, text, *at);
                let gone = text.remove(*at);
                self.yank(&[gone], false);
            }
            ("", 'D' | 'C') => {
                save(self, text, *at);
                self.yank(&text[*at..end].to_vec(), false);
                text.drain(*at..end);
                if c == 'C' {
                    self.mode = Mode::Insert;
                }
            }
            ("d", 'd') => {
                self.yank(&text[start..end].to_vec(), true);
                if start == 0 && end == text.len() {
                    return Outcome::DeleteBlock;
                }
                save(self, text, *at);
                // The line goes with one of the line breaks around it.
                if end < text.len() {
                    text.drain(start..=end);
                    *at = start;
                } else {
                    text.drain(start - 1..end);
                    *at = line_start(text, start - 1);
                }
            }
            ("d", 'w') => {
                save(self, text, *at);
                let to = next_word(text, *at).min(end);
                self.yank(&text[*at..to].to_vec(), false);
                text.drain(*at..to);
            }
            ("c", 'c') => {
                save(self, text, *at);
                self.yank(&text[start..end].to_vec(), true);
                text.drain(start..end);
                *at = start;
                self.mode = Mode::Insert;
            }
            ("c", 'w') => {
                save(self, text, *at);
                let to = (word_end(text, at.saturating_sub(1)) + 1).clamp(*at, end);
                self.yank(&text[*at..to].to_vec(), false);
                text.drain(*at..to);
                self.mode = Mode::Insert;
            }
            ("", 'J') if end < text.len() => {
                save(self, text, *at);
                text[end] = ' ';
                *at = end;
            }

            // Copying and pasting.
            ("y", 'y') => self.yank(&text[start..end].to_vec(), true),
            ("y", 'w') => self.yank(&text[*at..next_word(text, *at).min(end)].to_vec(), false),
            ("", 'p' | 'P') => {
                let Some((pasted, linewise)) = self.register.clone() else { return Outcome::Stay };
                save(self, text, *at);
                let pasted: Vec<char> = pasted.chars().collect();
                match (linewise, c) {
                    (true, 'p') => {
                        text.splice(end..end, std::iter::once('\n').chain(pasted));
                        *at = end + 1;
                    }
                    (true, _) => {
                        text.splice(start..start, pasted.into_iter().chain(std::iter::once('\n')));
                        *at = start;
                    }
                    (false, 'p') => {
                        let place = (*at + 1).min(end);
                        *at = place + pasted.len().saturating_sub(1);
                        text.splice(place..place, pasted);
                    }
                    (false, _) => {
                        let place = *at;
                        text.splice(place..place, pasted);
                    }
                }
            }
            ("", 'u') => {
                if let Some((before, cursor)) = self.undo.pop() {
                    *text = before.chars().collect();
                    *at = cursor;
                }
            }

            // Leaving.
            ("Z", 'Z') => return Outcome::Close,
            ("Z", 'Q') => return Outcome::Discard,

            // The first key of a two-key command.
            ("", 'd' | 'c' | 'y' | 'g' | 'Z' | ':') => self.pending.push(c),
            _ => {}
        }
        Outcome::Stay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Type `keys` in normal mode on `text` with the cursor at `cursor`; `<` is Escape
    /// and a line break is Enter.
    fn run(vim: &mut Vim, text: &str, cursor: usize, keys: &str) -> (String, usize, Outcome) {
        let (mut text, mut cursor) = (text.to_string(), cursor);
        let mut outcome = Outcome::Stay;
        for c in keys.chars() {
            let key = match c {
                '<' => Key::Escape,
                '\n' => Key::Enter,
                c => Key::Char(c),
            };
            outcome = vim.key(key, &mut text, &mut cursor);
            if outcome != Outcome::Stay {
                break;
            }
        }
        (text, cursor, outcome)
    }

    fn normal(text: &str, cursor: usize, keys: &str) -> (String, usize, Outcome) {
        run(&mut Vim::default(), text, cursor, keys)
    }

    const TEXT: &str = "**Anna**\nHallo, du da.\nUnd weiter";

    #[test]
    fn moves_within_the_block_and_leaves_it_at_the_edges() {
        assert_eq!(normal(TEXT, 9, "ll").1, 11);
        assert_eq!(normal(TEXT, 9, "h").1, 9, "not past the start of the line");
        assert_eq!(normal(TEXT, 9, "$").1, 21, "on the last character");
        assert_eq!(normal(TEXT, 9, "$l").1, 21);
        assert_eq!(normal(TEXT, 15, "0").1, 9);
        assert_eq!(normal(TEXT, 12, "j").1, 26, "same column, one line down");
        assert_eq!(normal(TEXT, 20, "j").1, 32, "or the end of a shorter line");
        assert_eq!(normal(TEXT, 12, "k").1, 3);
        assert_eq!(normal(TEXT, 3, "k").2, Outcome::LeaveUp);
        assert_eq!(normal(TEXT, 25, "j").2, Outcome::LeaveDown);
        assert_eq!(normal(TEXT, 30, "gg").1, 0);
        assert_eq!(normal(TEXT, 0, "G").1, 23);
        // Words: "Hallo" "," "du" "da" "."
        assert_eq!(normal(TEXT, 9, "w").1, 14);
        assert_eq!(normal(TEXT, 9, "ww").1, 16);
        assert_eq!(normal(TEXT, 9, "e").1, 13);
        assert_eq!(normal(TEXT, 16, "b").1, 14);
        assert_eq!(normal("  eingerückt", 8, "^").1, 2);
    }

    #[test]
    fn a_number_repeats_a_movement() {
        const LINES: &str = "eins zwei drei vier\nb\nc\nd\ne";
        assert_eq!(normal(LINES, 0, "3l").1, 3);
        assert_eq!(normal(LINES, 0, "2w").1, 10);
        assert_eq!(normal(LINES, 0, "3wb").1, 10);
        assert_eq!(normal(LINES, 0, "12l").1, 12, "two digits");
        assert_eq!(normal(LINES, 5, "10l0").1, 0, "a lone 0 is still the start of the line");
        assert_eq!(normal(LINES, 0, "2j").1, 22);
        assert_eq!(normal(LINES, 26, "3k").1, 20);
        assert_eq!(normal(LINES, 0, "3G").1, 22);
        assert_eq!(normal(LINES, 26, "2gg").1, 20);
        // Past the block's edge the rest is carried into the next block.
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, LINES, 22, "5j").2, Outcome::LeaveDown);
        assert_eq!(vim.carry, 2, "two lines in this block, one to step over, two left");
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, LINES, 0, "2k").2, Outcome::LeaveUp);
        assert_eq!(vim.carry, 1);
        // A number does not multiply anything else, and does not linger.
        assert_eq!(normal(LINES, 0, "3x").0, "ins zwei drei vier\nb\nc\nd\ne");
        assert_eq!(normal(LINES, 0, "3xl").1, 1);
        assert_eq!(normal(LINES, 0, "3<l").1, 1, "Escape drops the number");
    }

    #[test]
    fn the_block_as_a_whole_is_moved_copied_cut_and_put() {
        assert_eq!(normal(TEXT, 12, "gJ").2, Outcome::MoveDown);
        assert_eq!(normal(TEXT, 12, "gK").2, Outcome::MoveUp);
        assert_eq!(normal(TEXT, 12, "yab").2, Outcome::YankBlock);
        assert_eq!(normal(TEXT, 12, "dab").2, Outcome::CutBlock);
        assert_eq!(normal(TEXT, 12, "gp").2, Outcome::PasteBelow);
        assert_eq!(normal(TEXT, 12, "gP").2, Outcome::PasteAbove);
        assert_eq!(normal(TEXT, 12, "da<x").0, "**Anna**\nHalo, du da.\nUnd weiter");
    }

    #[test]
    fn deletes_changes_and_undoes() {
        assert_eq!(normal(TEXT, 9, "x").0, "**Anna**\nallo, du da.\nUnd weiter");
        assert_eq!(normal(TEXT, 14, "D"), ("**Anna**\nHallo\nUnd weiter".to_string(), 13, Outcome::Stay));
        assert_eq!(normal(TEXT, 12, "dd"), ("**Anna**\nUnd weiter".to_string(), 9, Outcome::Stay));
        assert_eq!(normal(TEXT, 30, "dd"), ("**Anna**\nHallo, du da.".to_string(), 9, Outcome::Stay), "the last line takes the break before it");
        assert_eq!(normal("Nur eine Zeile", 3, "dd").2, Outcome::DeleteBlock);
        assert_eq!(normal(TEXT, 16, "dw").0, "**Anna**\nHallo, da.\nUnd weiter");
        assert_eq!(normal(TEXT, 9, "J").0, "**Anna**\nHallo, du da. Und weiter");
        assert_eq!(normal(TEXT, 12, "ddxu").0, "**Anna**\nUnd weiter", "one step back");
        assert_eq!(normal(TEXT, 12, "ddxuu").0, TEXT, "and another");
        assert_eq!(normal(TEXT, 12, "d<x").0, "**Anna**\nHalo, du da.\nUnd weiter", "Escape drops a half-typed command");

        let mut vim = Vim::default();
        let (text, cursor, _) = run(&mut vim, TEXT, 16, "cw");
        assert_eq!((text.as_str(), cursor, vim.mode), ("**Anna**\nHallo,  da.\nUnd weiter", 16, Mode::Insert));
        let mut vim = Vim::default();
        let (text, cursor, _) = run(&mut vim, TEXT, 12, "cc");
        assert_eq!((text.as_str(), cursor, vim.mode), ("**Anna**\n\nUnd weiter", 9, Mode::Insert));
    }

    #[test]
    fn yanks_and_pastes_lines_and_words() {
        assert_eq!(normal(TEXT, 12, "yyp"), ("**Anna**\nHallo, du da.\nHallo, du da.\nUnd weiter".to_string(), 23, Outcome::Stay));
        assert_eq!(normal(TEXT, 30, "yyggjP").0, "**Anna**\nUnd weiter\nHallo, du da.\nUnd weiter");
        assert_eq!(normal(TEXT, 30, "ddp").0, "**Anna**\nHallo, du da.\nUnd weiter", "a deleted line can be put back");
        assert_eq!(normal(TEXT, 16, "yw$p").0, "**Anna**\nHallo, du da.du \nUnd weiter");
        // The register is kept from one block to the next, and offered to the clipboard.
        let mut vim = Vim::default();
        run(&mut vim, TEXT, 30, "yy");
        assert_eq!(vim.copied.as_deref(), Some("Und weiter"));
        vim.begin(Mode::Normal);
        assert_eq!(run(&mut vim, "Anderer Block", 0, "p").0, "Anderer Block\nUnd weiter");
    }

    #[test]
    fn enters_and_leaves_insert_mode() {
        for (keys, cursor) in [("i", 12), ("a", 13), ("I", 9), ("A", 22)] {
            let mut vim = Vim::default();
            assert_eq!(run(&mut vim, TEXT, 12, keys).1, cursor, "{keys}");
            assert_eq!(vim.mode, Mode::Insert);
        }
        let mut vim = Vim::default();
        let (mut text, mut cursor) = (TEXT.to_string(), 12);
        vim.key(Key::Char('A'), &mut text, &mut cursor);
        // In insert mode letters are not commands (the text field takes them).
        assert_eq!(vim.key(Key::Char('x'), &mut text, &mut cursor), Outcome::Stay);
        assert_eq!(text, TEXT);
        vim.key(Key::Escape, &mut text, &mut cursor);
        assert_eq!((vim.mode, cursor), (Mode::Normal, 21));
        assert_eq!(normal(TEXT, 12, "ZZ").2, Outcome::Close);
        assert_eq!(normal(TEXT, 12, "ZQ").2, Outcome::Discard);
    }

    #[test]
    fn o_adds_a_line_to_the_block_and_go_a_block() {
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, TEXT, 12, "o"), ("**Anna**\nHallo, du da.\n\nUnd weiter".to_string(), 23, Outcome::Stay));
        assert_eq!(vim.mode, Mode::Insert);
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, TEXT, 12, "O"), ("**Anna**\n\nHallo, du da.\nUnd weiter".to_string(), 9, Outcome::Stay));
        assert_eq!(vim.mode, Mode::Insert);
        assert_eq!(normal(TEXT, 30, "o").0, "**Anna**\nHallo, du da.\nUnd weiter\n");
        assert_eq!(normal("Licht aus.", 3, "o"), ("Licht aus.\n".to_string(), 11, Outcome::Stay));
        assert_eq!(normal("Licht aus.", 3, "O"), ("\nLicht aus.".to_string(), 0, Outcome::Stay));
        // Above a role's names there is no line of the role.
        assert_eq!(normal(TEXT, 3, "O"), (TEXT.to_string(), 3, Outcome::Stay));
        assert_eq!(normal(TEXT, 3, "o").0, "**Anna**\n\nHallo, du da.\nUnd weiter");
        // New blocks: go and gO, and Enter for one below.
        assert_eq!(normal(TEXT, 12, "go").2, Outcome::OpenBelow);
        assert_eq!(normal(TEXT, 12, "gO").2, Outcome::OpenAbove);
        assert_eq!(normal(TEXT, 12, "\n").2, Outcome::OpenBelow);
    }

    #[test]
    fn a_roles_names_only_go_whole() {
        const TRIO: &str = "**Anna/Ben/Clara**\nHallo.";
        let chars = |text: &str| text.chars().collect::<Vec<char>>();
        assert_eq!(role_names(&chars(TRIO)), Some(vec![2..6, 7..10, 11..16]));
        assert_eq!(role_names(&chars("**Anna*\nHallo.")), None);
        assert_eq!(role_names(&chars("Licht aus.")), None);

        // x, dw and D take the role the cursor is on; the asterisks stay.
        assert_eq!(normal(TRIO, 0, "x"), ("**Ben/Clara**\nHallo.".to_string(), 2, Outcome::Stay));
        assert_eq!(normal(TRIO, 8, "x").0, "**Anna/Clara**\nHallo.");
        assert_eq!(normal(TRIO, 17, "x").0, "**Anna/Ben**\nHallo.", "on the closing asterisks: the last role");
        assert_eq!(normal(TRIO, 8, "dw").0, "**Anna/Clara**\nHallo.");
        assert_eq!(normal(TRIO, 8, "D").0, "**Anna/Clara**\nHallo.");
        assert_eq!(normal(TRIO, 8, "xu").0, TRIO);
        assert_eq!(normal(TEXT, 3, "x").0, TEXT, "the only role stays; dd takes the line");
        assert_eq!(normal(TEXT, 3, "dd").0, "Hallo, du da.\nUnd weiter");
        // Changing puts the cursor where the name was.
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, TRIO, 8, "cw"), ("**Anna//Clara**\nHallo.".to_string(), 7, Outcome::Stay));
        assert_eq!(vim.mode, Mode::Insert);
        let mut vim = Vim::default();
        assert_eq!(run(&mut vim, TRIO, 8, "cc"), ("****\nHallo.".to_string(), 2, Outcome::Stay));
        // Nothing is joined onto the names or pasted into them.
        assert_eq!(normal(TRIO, 8, "J").0, TRIO);
        assert_eq!(normal(TRIO, 20, "ywggp").0, TRIO);
        assert_eq!(normal(TRIO, 20, "yyggp").0, "**Anna/Ben/Clara**\nHallo.\nHallo.");
        // Below the names everything is as usual.
        assert_eq!(normal(TRIO, 19, "x").0, "**Anna/Ben/Clara**\nallo.");

        let mut text = chars(TRIO);
        assert_eq!(remove_role(&mut text, 12), Some(10));
        assert_eq!(text.iter().collect::<String>(), "**Anna/Ben**\nHallo.");
        assert_eq!(remove_role(&mut chars("**Anna**\nHallo."), 3), None);
    }

    #[test]
    fn the_editor_is_left_with_a_command_line_and_never_with_escape() {
        assert_eq!(normal(TEXT, 12, "<<<"), (TEXT.to_string(), 12, Outcome::Stay));
        assert_eq!(normal(TEXT, 12, ":w\n").2, Outcome::Close);
        assert_eq!(normal(TEXT, 12, ":wq\n").2, Outcome::Close);
        assert_eq!(normal(TEXT, 12, ":x\n").2, Outcome::Close);
        assert_eq!(normal(TEXT, 12, ":q\n").2, Outcome::Quit);
        assert_eq!(normal(TEXT, 12, ":q!\n").2, Outcome::Discard);
        // While a command line is typed its letters are not commands, and Escape drops it.
        assert_eq!(normal(TEXT, 12, ":dd<"), (TEXT.to_string(), 12, Outcome::Stay));
        assert_eq!(normal(TEXT, 12, ":unsinn\nx").0, "**Anna**\nHalo, du da.\nUnd weiter");
        let mut vim = Vim::default();
        let (mut text, mut cursor) = (TEXT.to_string(), 12);
        for key in [Key::Char(':'), Key::Char('q'), Key::Backspace, Key::Char('w')] {
            vim.key(key, &mut text, &mut cursor);
        }
        assert_eq!(vim.pending(), ":w");
        assert_eq!(vim.key(Key::Enter, &mut text, &mut cursor), Outcome::Close);
    }
}
