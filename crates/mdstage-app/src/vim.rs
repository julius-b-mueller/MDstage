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
}

/// What a key asks of the editor beyond changing the block's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Stay,
    /// Keep the changes and close the editor.
    Close,
    /// Close the editor without the changes.
    Discard,
    /// Go on in the text block above / below.
    LeaveUp,
    LeaveDown,
    /// Keep the changes and start a new block below / above.
    OpenBelow,
    OpenAbove,
    /// Remove the whole block (its only line was deleted).
    DeleteBlock,
}

#[derive(Default)]
pub struct Vim {
    pub mode: Mode,
    /// The first key of a two-key command (`d`, `c`, `y`, `g`, `Z`).
    pending: String,
    /// What was last deleted or yanked, and whether it was whole lines. Kept from block
    /// to block.
    register: Option<(String, bool)>,
    /// Earlier states of the text, with the cursor, for `u`.
    undo: Vec<(String, usize)>,
    /// Set when something was yanked or deleted: text for the system clipboard.
    pub copied: Option<String>,
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

impl Vim {
    /// A block is opened for editing.
    pub fn begin(&mut self, mode: Mode) {
        self.mode = mode;
        self.pending.clear();
        self.undo.clear();
    }

    /// The first key of a command that waits for its second.
    pub fn pending(&self) -> &str {
        &self.pending
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
            (Mode::Normal, Key::Escape) if !self.pending.is_empty() => {
                self.pending.clear();
                Outcome::Stay
            }
            (Mode::Normal, Key::Escape | Key::Enter) => Outcome::Close,
            (Mode::Normal, Key::Char(c)) => self.command(c, &mut text, &mut at),
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
        match (pending.as_str(), c) {
            // Moving.
            ("", 'h') => *at = at.saturating_sub(1).max(start),
            ("", 'l') => *at = (*at + 1).min(end),
            ("", 'j') => {
                if end == text.len() {
                    return Outcome::LeaveDown;
                }
                let below = end + 1;
                *at = (below + (*at - start)).min(line_end(text, below));
            }
            ("", 'k') => {
                if start == 0 {
                    return Outcome::LeaveUp;
                }
                let above = line_start(text, start - 1);
                *at = (above + (*at - start)).min(start - 1);
            }
            ("", '0') => *at = start,
            ("", '^') => *at = first_letter(text),
            ("", '$') => *at = end,
            ("", 'w') => *at = next_word(text, *at),
            ("", 'b') => *at = previous_word(text, *at),
            ("", 'e') => *at = word_end(text, *at),
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
            ("", 'o') => return Outcome::OpenBelow,
            ("", 'O') => return Outcome::OpenAbove,

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
            ("", 'd' | 'c' | 'y' | 'g' | 'Z') => self.pending.push(c),
            _ => {}
        }
        Outcome::Stay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Type `keys` in normal mode on `text` with the cursor at `cursor`; `<` is Escape.
    fn run(vim: &mut Vim, text: &str, cursor: usize, keys: &str) -> (String, usize, Outcome) {
        let (mut text, mut cursor) = (text.to_string(), cursor);
        let mut outcome = Outcome::Stay;
        for c in keys.chars() {
            outcome = vim.key(if c == '<' { Key::Escape } else { Key::Char(c) }, &mut text, &mut cursor);
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
        assert_eq!(normal(TEXT, 12, "o").2, Outcome::OpenBelow);
        assert_eq!(normal(TEXT, 12, "O").2, Outcome::OpenAbove);
        assert_eq!(normal(TEXT, 12, "ZZ").2, Outcome::Close);
        assert_eq!(normal(TEXT, 12, "ZQ").2, Outcome::Discard);
        assert_eq!(normal(TEXT, 12, "<").2, Outcome::Close);
    }
}
