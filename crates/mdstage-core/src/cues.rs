//! Cue navigation: variants, S/L/F chains, Go/Back and the state implied by the history.
//!
//! Cues are addressed by their position among the script's cues (0-based), not by block
//! index. Everything here is pure: `History` records what fired and answers what that
//! means for microphones, output devices and audio — the engine does the actual sending.

use std::collections::BTreeMap;

use serde_yaml_ng::Value;

use crate::mic::{Cast, Mic};
use crate::{Block, Cue, Script};

/// MIDI channel and note that identify a cue (`trigger_note`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Note {
    pub ch: u64,
    pub note: u64,
}

impl Note {
    fn from_yaml(v: &Value) -> Option<Note> {
        Some(Note { ch: v.get("ch")?.as_u64()?, note: v.get("note")?.as_u64()? })
    }
}

impl std::fmt::Display for Note {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.ch, self.note)
    }
}

/// When an auto-cue fires relative to its source cue.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AutoWhen {
    /// The source's audio reaches this position (seconds).
    At(f64),
    /// This many seconds after the source fires.
    Delay(f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoTrigger {
    pub source: Note,
    pub when: AutoWhen,
}

/// What a cue does to another cue's audio when it fires (`music.adjust`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adjust {
    pub target: Note,
    pub fadeout: bool,
    pub volume: Option<f64>,
    pub fadetime: Option<f64>,
}

impl Cue {
    fn note_field(&self, key: &str) -> Option<Note> {
        Note::from_yaml(self.field(key)?)
    }

    pub fn note(&self) -> Option<Note> {
        self.note_field("trigger_note")
    }

    /// A variant of the preceding cue (`sibling: true`).
    pub fn is_variant(&self) -> bool {
        self.field("sibling").and_then(Value::as_bool) == Some(true)
    }

    /// The cue started seamlessly when this cue's audio ends.
    pub fn chain_end(&self) -> Option<Note> {
        self.note_field("chain_end")
    }

    /// The outro (devamp) this loop hands off to at its next loop end.
    pub fn loop_outro(&self) -> Option<Note> {
        self.note_field("loop_outro")
    }

    pub fn auto_trigger(&self) -> Option<AutoTrigger> {
        let at = self.field("auto_trigger")?;
        let number = |key: &str| at.get(key).and_then(Value::as_f64);
        let when = match (number("at"), number("delay")) {
            (Some(at), _) => AutoWhen::At(at),
            (None, Some(delay)) => AutoWhen::Delay(delay),
            (None, None) => return None,
        };
        Some(AutoTrigger { source: Note::from_yaml(at.get("trigger_note")?)?, when })
    }

    pub fn adjust(&self) -> Option<Adjust> {
        let adjust = self.field("music")?.get("adjust")?;
        Some(Adjust {
            target: Note::from_yaml(adjust.get("trigger_note")?)?,
            fadeout: adjust.get("fadeout").and_then(Value::as_bool) == Some(true),
            volume: adjust.get("volume").and_then(Value::as_f64),
            fadetime: adjust.get("fadetime").and_then(Value::as_f64),
        })
    }

    /// Start volume of the cue's own audio; `None` if the cue has no audio.
    fn music_volume(&self) -> Option<f64> {
        let music = self.field("music")?;
        Some(music.get("volume").and_then(Value::as_f64).unwrap_or(DEFAULT_VOLUME))
    }

    fn messages(&self, key: &str) -> &[Value] {
        match self.field(key) {
            Some(Value::Sequence(list)) => list,
            _ => &[],
        }
    }
}

/// Volume of audio that does not set one.
pub const DEFAULT_VOLUME: f64 = 0.8;

/// A cue's part in a Start / Loop / Finish structure.
#[derive(Clone, Debug, PartialEq)]
pub enum Slf {
    /// Plays through, then starts `next` seamlessly.
    Start { next: Note },
    /// Loops until `outro` is fired, then hands off at the loop end.
    Loop { outro: Note },
    /// Outro of the loops `from`.
    Finish { from: Vec<usize> },
    /// Outro of the loops `from` that itself chains into `next`.
    Bridge { from: Vec<usize>, next: Note },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeviceKind {
    Midi,
    Osc,
    Http,
    Display,
}

/// The last thing the fired cues told an output device.
#[derive(Clone, Debug, PartialEq)]
pub enum DeviceState {
    /// The `cue_midi` / `cue_osc` / `cue_http` messages of the most recent cue addressing it.
    Messages(Vec<Value>),
    /// The markdown a display shows; empty = cleared.
    Display(String),
}

pub type DeviceStates = BTreeMap<(DeviceKind, String), DeviceState>;

/// The cues of a script, in order.
pub struct Cues<'a> {
    script: &'a Script,
    /// Block index of every cue.
    blocks: Vec<usize>,
}

impl<'a> Cues<'a> {
    pub fn new(script: &'a Script) -> Self {
        let blocks = (0..script.blocks.len()).filter(|&i| matches!(script.blocks[i], Block::Cue(_))).collect();
        Cues { script, blocks }
    }

    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    pub fn get(&self, cue: usize) -> Option<&'a Cue> {
        match self.script.blocks.get(*self.blocks.get(cue)?) {
            Some(Block::Cue(c)) => Some(c),
            _ => None,
        }
    }

    /// Index of the cue's block in the script.
    pub fn block_index(&self, cue: usize) -> Option<usize> {
        self.blocks.get(cue).copied()
    }

    /// The first cue carrying this trigger note.
    pub fn find(&self, note: Note) -> Option<usize> {
        (0..self.len()).find(|&i| self.get(i).and_then(Cue::note) == Some(note))
    }

    fn is_variant(&self, cue: usize) -> bool {
        self.get(cue).is_some_and(Cue::is_variant)
    }

    /// The first cue of the variant group `cue` belongs to.
    pub fn group_root(&self, mut cue: usize) -> usize {
        while cue > 0 && self.is_variant(cue) {
            cue -= 1;
        }
        cue
    }

    /// All cues of the variant group `cue` belongs to: the root and its variants.
    pub fn group(&self, cue: usize) -> std::ops::Range<usize> {
        let root = self.group_root(cue);
        let mut end = root + 1;
        while end < self.len() && self.is_variant(end) {
            end += 1;
        }
        root..end
    }

    /// The cue's S/L/F role, if it is part of such a structure.
    pub fn slf(&self, cue: usize) -> Option<Slf> {
        let me = self.get(cue)?;
        let from: Vec<usize> = (0..self.len())
            .filter(|&i| self.get(i).and_then(Cue::loop_outro).and_then(|n| self.find(n)) == Some(cue))
            .collect();
        match (me.chain_end(), me.loop_outro(), from.is_empty()) {
            (Some(next), _, false) => Some(Slf::Bridge { from, next }),
            (Some(next), _, true) => Some(Slf::Start { next }),
            (None, Some(outro), _) => Some(Slf::Loop { outro }),
            (None, None, false) => Some(Slf::Finish { from }),
            (None, None, true) => None,
        }
    }

    /// The cue a loop or chain source hands off to.
    fn successor(&self, cue: usize) -> Option<usize> {
        let c = self.get(cue)?;
        self.find(c.loop_outro().or(c.chain_end())?)
    }
}

/// The cues fired so far, oldest first. Each entry notes whether it fired automatically
/// (auto-cue or chain transition) rather than by an operator action.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    entries: Vec<(usize, bool)>,
}

/// What a Back undid.
#[derive(Clone, Debug, PartialEq)]
pub struct Undone {
    /// The cues removed from the history, newest first: the operator's last cue and
    /// every automatic cue it had set off.
    pub popped: Vec<usize>,
    /// The cue the operator is on again; `None` if nothing is left.
    pub landed: Option<usize>,
    /// Device states to send again so MIDI/OSC/HTTP devices the undone cues addressed
    /// return to what the remaining history last told them. Devices no earlier cue
    /// addressed are left alone.
    pub resend: DeviceStates,
}

impl History {
    pub fn cues(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries.iter().map(|e| e.0)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn fired(&self, cue: usize) -> bool {
        self.cues().any(|c| c == cue)
    }

    /// The cues fired in the operator's current pass through the script: since the last
    /// jump back. These are the ones Go steps over.
    pub fn this_pass(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries[self.pass_start()..].iter().map(|e| e.0)
    }

    /// Record that a cue fired.
    pub fn push(&mut self, cue: usize, auto: bool) {
        self.entries.push((cue, auto));
    }

    /// The operator's position: the most recent manually fired cue. Automatic cues do
    /// not move it, so it stays put while a loop keeps firing.
    pub fn last_manual(&self) -> Option<usize> {
        self.entries.iter().rev().find(|e| !e.1).map(|e| e.0)
    }

    /// Where the operator's current pass through the script begins in the history: at
    /// the last cue fired by hand that was not further down than the one fired by hand
    /// before it — the last jump back — or at the very start.
    fn pass_start(&self) -> usize {
        let manual: Vec<(usize, usize)> = self.entries.iter().enumerate().filter(|(_, e)| !e.1).map(|(at, e)| (at, e.0)).collect();
        manual.windows(2).rev().find(|pair| pair[1].1 <= pair[0].1).map_or(0, |pair| pair[1].0)
    }

    /// The cue Go fires next and the live view focuses: the first cue after the
    /// operator's position that is not a variant and has not fired in this pass.
    ///
    /// Cues that fired by themselves since (a loop the start chained into, an auto-cue)
    /// are stepped over, so Go does not fire them a second time. What fired before the
    /// operator jumped back does not count: going through a stretch again, every cue
    /// in it is due again.
    pub fn next(&self, cues: &Cues) -> Option<usize> {
        let from = self.last_manual().map_or(0, |c| c + 1);
        let this_pass = &self.entries[self.pass_start()..];
        (from..cues.len()).find(|&i| !cues.is_variant(i) && !this_pass.iter().any(|e| e.0 == i))
    }

    /// The cue a Go fires. An armed cue wins; otherwise the next cue, or the selected
    /// variant if it belongs to that cue's group. The caller fires it and calls `push`.
    pub fn go(&self, cues: &Cues, armed: Option<usize>, selected_variant: Option<usize>) -> Option<usize> {
        if armed.is_some() {
            return armed;
        }
        let next = self.next(cues)?;
        Some(selected_variant.filter(|v| cues.group(next).contains(v)).unwrap_or(next))
    }

    /// Undo the operator's last Go: remove that cue and every automatic cue it set off.
    pub fn back(&mut self, cues: &Cues) -> Option<Undone> {
        let mut popped = Vec::new();
        while let Some((cue, auto)) = self.entries.pop() {
            popped.push(cue);
            if !auto {
                break;
            }
        }
        if popped.is_empty() {
            return None;
        }
        let touched = History { entries: popped.iter().map(|&c| (c, false)).collect() }.device_states(cues);
        let mut resend = self.device_states(cues);
        resend.retain(|key, _| key.0 != DeviceKind::Display && touched.contains_key(key));
        Some(Undone { popped, landed: self.last_manual(), resend })
    }

    /// The microphones as the fired cues left them: the most recent cue that sets them.
    pub fn mic(&self, cues: &Cues, cast: &Cast) -> Mic {
        self.entries
            .iter()
            .rev()
            .filter_map(|&(cue, _)| cues.block_index(cue))
            .map(|block| cues.script.mic_for_cue(block, cast))
            .find(|mic| *mic != Mic::Unchanged)
            .unwrap_or(Mic::Unchanged)
    }

    /// What every output device was last told. Per device the most recent cue addressing
    /// it wins. For displays, markdown sets the content, an empty message clears it and an
    /// announce-only message holds whatever an earlier cue set.
    pub fn device_states(&self, cues: &Cues) -> DeviceStates {
        let mut states = DeviceStates::new();
        for cue in self.entries.iter().rev().filter_map(|&(c, _)| cues.get(c)) {
            for (kind, key) in [(DeviceKind::Midi, "cue_midi"), (DeviceKind::Osc, "cue_osc"), (DeviceKind::Http, "cue_http")] {
                let mut by_device: Vec<(String, Vec<Value>)> = Vec::new();
                for message in cue.messages(key) {
                    let Some(device) = message.get("device").and_then(Value::as_str) else { continue };
                    match by_device.iter_mut().find(|(d, _)| d == device) {
                        Some((_, list)) => list.push(message.clone()),
                        None => by_device.push((device.to_string(), vec![message.clone()])),
                    }
                }
                for (device, messages) in by_device {
                    states.entry((kind, device)).or_insert(DeviceState::Messages(messages));
                }
            }
            for message in cue.messages("cue_display") {
                let Some(device) = message.get("device").and_then(Value::as_str) else { continue };
                let key = (DeviceKind::Display, device.to_string());
                if states.contains_key(&key) {
                    continue;
                }
                let filled = |field: &str| message.get(field).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
                if filled("markdown") {
                    let markdown = message.get("markdown").and_then(Value::as_str).unwrap_or_default();
                    states.insert(key, DeviceState::Display(markdown.to_string()));
                } else if !filled("announce") {
                    states.insert(key, DeviceState::Display(String::new()));
                }
            }
        }
        states
    }

    /// Whether `target`'s audio should be playing, and at which volume, given the fired
    /// cues: its own start, every adjust aimed at it, and the handoff to its successor.
    /// Back uses this to restore audio the undone cues had ducked or faded out.
    pub fn audio_state(&self, cues: &Cues, target: usize) -> (bool, f64) {
        let mut volume = cues.get(target).and_then(Cue::music_volume).unwrap_or(DEFAULT_VOLUME);
        let mut playing = false;
        let successor = cues.successor(target);
        for fired in self.cues() {
            let Some(cue) = cues.get(fired) else { continue };
            if fired == target && cue.music_volume().is_some() {
                playing = true;
                volume = cue.music_volume().unwrap_or(DEFAULT_VOLUME);
            } else if Some(fired) == successor && playing {
                playing = false;
            }
            if let Some(adjust) = cue.adjust().filter(|a| cues.find(a.target) == Some(target)) {
                if adjust.fadeout {
                    playing = false;
                    volume = 0.0;
                } else if let Some(v) = adjust.volume {
                    volume = v;
                }
            }
        }
        (playing, volume)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(n: u64) -> Note {
        Note { ch: 1, note: n }
    }

    /// Build a show from YAML cue bodies; cue `i` gets trigger note `1/i`.
    fn show(cues: &[&str]) -> Script {
        let mut text = String::from("```yaml\nconfig:\n    roles:\n        Anna: {}\n        Ben: {}\n```\n");
        for (i, body) in cues.iter().enumerate() {
            text.push_str(&format!("\n```yaml\ntrigger_note: {{ch: 1, note: {i}}}\n{body}\n```\n"));
        }
        Script::parse(&text)
    }

    #[test]
    fn reads_cue_links() {
        let script = show(&[
            "chain_end: {ch: 1, note: 1}",
            "loop_outro: {ch: 1, note: 2}\nauto_trigger: {trigger_note: {ch: 1, note: 0}, at: 4.5}",
            "auto_trigger: {trigger_note: {ch: 1, note: 1}, delay: 8}\nmusic:\n    file: a.wav\n    adjust: {trigger_note: {ch: 1, note: 1}, fadeout: true, fadetime: 2.0}",
            "sibling: true",
        ]);
        let cues = Cues::new(&script);
        assert_eq!(cues.len(), 4);
        assert_eq!(cues.get(0).unwrap().note(), Some(note(0)));
        assert_eq!(cues.get(0).unwrap().chain_end(), Some(note(1)));
        assert_eq!(cues.get(1).unwrap().auto_trigger(), Some(AutoTrigger { source: note(0), when: AutoWhen::At(4.5) }));
        assert_eq!(cues.get(2).unwrap().auto_trigger(), Some(AutoTrigger { source: note(1), when: AutoWhen::Delay(8.0) }));
        assert_eq!(
            cues.get(2).unwrap().adjust(),
            Some(Adjust { target: note(1), fadeout: true, volume: None, fadetime: Some(2.0) })
        );
        assert!(cues.get(3).unwrap().is_variant());
        assert_eq!(cues.find(note(2)), Some(2));
        assert_eq!(cues.find(note(9)), None);
        assert_eq!(note(7).to_string(), "1/7");
    }

    #[test]
    fn classifies_start_loop_finish_and_bridge() {
        let script = show(&[
            "chain_end: {ch: 1, note: 1}",  // start → loop
            "loop_outro: {ch: 1, note: 2}", // loop → bridge
            "chain_end: {ch: 1, note: 3}",  // bridge → second loop
            "loop_outro: {ch: 1, note: 4}", // second loop → finish
            "music: out.wav",               // finish
            "light: Day",                   // unrelated
        ]);
        let cues = Cues::new(&script);
        assert_eq!(cues.slf(0), Some(Slf::Start { next: note(1) }));
        assert_eq!(cues.slf(1), Some(Slf::Loop { outro: note(2) }));
        assert_eq!(cues.slf(2), Some(Slf::Bridge { from: vec![1], next: note(3) }));
        assert_eq!(cues.slf(3), Some(Slf::Loop { outro: note(4) }));
        assert_eq!(cues.slf(4), Some(Slf::Finish { from: vec![3] }));
        assert_eq!(cues.slf(5), None);
    }

    #[test]
    fn go_walks_the_cues_and_honours_variants_and_arming() {
        // Cues 1–3 form a variant group (root 1), cue 4 follows.
        let script = show(&["light: A", "light: B", "sibling: true", "sibling: true", "light: C"]);
        let cues = Cues::new(&script);
        assert_eq!(cues.group_root(3), 1);
        assert_eq!(cues.group(2), 1..4);
        assert_eq!(cues.group(4), 4..5);

        let mut history = History::default();
        assert_eq!(history.go(&cues, None, None), Some(0));
        history.push(0, false);
        // A selected variant of the next group replaces its root; one from elsewhere is ignored.
        assert_eq!(history.go(&cues, None, Some(3)), Some(3));
        assert_eq!(history.go(&cues, None, Some(4)), Some(1));
        history.push(3, false);
        // The rest of the group is skipped.
        assert_eq!(history.next(&cues), Some(4));
        // An armed cue wins over everything.
        assert_eq!(history.go(&cues, Some(0), Some(2)), Some(0));
        history.push(4, false);
        assert_eq!(history.go(&cues, None, None), None, "end of show");
    }

    #[test]
    fn automatic_cues_do_not_move_the_operator() {
        let script = show(&["light: A", "light: B", "light: C", "light: D"]);
        let cues = Cues::new(&script);
        let mut history = History::default();
        history.push(0, false);
        history.push(2, true); // an auto-cue further down fires
        assert_eq!(history.last_manual(), Some(0));
        assert_eq!(history.next(&cues), Some(1), "the manual cue in between is not skipped");
        history.push(1, false);
        assert_eq!(history.next(&cues), Some(3), "the auto-cue that already fired is skipped");
    }

    #[test]
    fn back_follows_the_history_and_undoes_automatic_cues_with_their_go() {
        let script = show(&["light: A", "light: B", "light: C", "light: D", "light: E"]);
        let cues = Cues::new(&script);
        let mut history = History::default();
        history.push(0, false);
        history.push(3, false); // jump
        history.push(4, true); // chained automatically from 3
        history.push(2, true);

        let undone = history.back(&cues).unwrap();
        assert_eq!(undone.popped, [2, 4, 3]);
        assert_eq!(undone.landed, Some(0), "back to where the jump came from, not to cue 2");
        assert_eq!(history.next(&cues), Some(1));

        let undone = history.back(&cues).unwrap();
        assert_eq!((undone.popped, undone.landed), (vec![0], None));
        assert_eq!(history.back(&cues), None);
    }

    #[test]
    fn mic_state_comes_from_the_most_recent_cue_that_sets_it() {
        let script = show(&["mic: Anna", "light: B", "mic: [Anna, Ben]", "mic: muteall"]);
        let cues = Cues::new(&script);
        let cast = Cast::from_script(&script, false);
        let mut history = History::default();
        assert_eq!(history.mic(&cues, &cast), Mic::Unchanged);
        history.push(0, false);
        history.push(1, false);
        assert_eq!(history.mic(&cues, &cast), Mic::Open(vec!["Anna".into()]));
        history.push(2, false);
        history.push(3, false);
        assert_eq!(history.mic(&cues, &cast), Mic::MuteAll);
        history.back(&cues);
        assert_eq!(history.mic(&cues, &cast), Mic::Open(vec!["Anna".into(), "Ben".into()]));
    }

    #[test]
    fn device_states_and_what_back_resends() {
        let script = show(&[
            "cue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 1}\ncue_osc:\n    - {device: QLab, path: /a}",
            "cue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 2}\n    - {device: Licht, type: cc, ch: 1, cc: 7, value: 9}\n    - {type: note, ch: 1, note: 5}",
            "cue_http:\n    - {device: Pult, path: /x}\ncue_osc:\n    - {device: QLab, path: /b}",
        ]);
        let cues = Cues::new(&script);
        let mut history = History::default();
        for cue in 0..3 {
            history.push(cue, false);
        }
        let program = |state: &DeviceState| match state {
            DeviceState::Messages(m) => m.iter().filter_map(|v| v.get("program").and_then(Value::as_u64)).collect::<Vec<_>>(),
            _ => panic!("expected messages"),
        };
        let path = |state: &DeviceState| match state {
            DeviceState::Messages(m) => m[0].get("path").and_then(Value::as_str).unwrap().to_string(),
            _ => panic!("expected messages"),
        };
        let licht = (DeviceKind::Midi, "Licht".to_string());
        let qlab = (DeviceKind::Osc, "QLab".to_string());

        let states = history.device_states(&cues);
        assert_eq!(states.len(), 3);
        // Cue 1's two addressed messages; the one without a device is not tracked.
        assert_eq!(program(&states[&licht]), [2]);
        assert!(matches!(&states[&licht], DeviceState::Messages(m) if m.len() == 2));
        assert_eq!(path(&states[&qlab]), "/b");

        // Undo cue 2: QLab goes back to /a; the HTTP device was never addressed before, so
        // nothing is sent to it; the MIDI device was not touched by cue 2 at all.
        let undone = history.back(&cues).unwrap();
        assert_eq!(undone.resend.keys().collect::<Vec<_>>(), [&qlab]);
        assert_eq!(path(&undone.resend[&qlab]), "/a");

        // Undo cue 1: the MIDI device gets cue 0's program again.
        let undone = history.back(&cues).unwrap();
        assert_eq!(program(&undone.resend[&licht]), [1]);
    }

    #[test]
    fn display_content_persists_holds_and_clears() {
        let script = show(&[
            "cue_display:\n    - {device: Foyer, markdown: \"# One\"}\n    - {device: Stage, markdown: Hello}",
            "cue_display:\n    - {device: Foyer, announce: Standby}", // hold
            "cue_display:\n    - {device: Stage}",                    // clear
            "cue_display:\n    - {device: Foyer, markdown: \"# Two\"}",
        ]);
        let cues = Cues::new(&script);
        let foyer = (DeviceKind::Display, "Foyer".to_string());
        let stage = (DeviceKind::Display, "Stage".to_string());
        let mut history = History::default();
        let mut shown = |cue: usize| {
            history.push(cue, false);
            let s = history.device_states(&cues);
            (s.get(&foyer).cloned(), s.get(&stage).cloned())
        };
        let display = |s: &str| Some(DeviceState::Display(s.to_string()));
        assert_eq!(shown(0), (display("# One"), display("Hello")));
        assert_eq!(shown(1), (display("# One"), display("Hello")), "announce only: content stays");
        assert_eq!(shown(2), (display("# One"), display("")), "empty message clears");
        assert_eq!(shown(3), (display("# Two"), display("")));

        // Back recomputes display content from the history; it is never part of `resend`.
        let undone = history.back(&cues).unwrap();
        assert!(undone.resend.is_empty());
        assert_eq!(history.device_states(&cues).get(&foyer), display("# One").as_ref());
    }

    #[test]
    fn audio_state_follows_adjusts_and_handoffs() {
        let script = show(&[
            "music:\n    file: loop.wav\n    volume: 0.6\nloop_outro: {ch: 1, note: 3}",
            "music:\n    file: talk.wav\n    adjust: {trigger_note: {ch: 1, note: 0}, volume: 0.2}",
            "music:\n    file: sting.wav\n    adjust: {trigger_note: {ch: 1, note: 0}, fadeout: true}",
            "music: outro.wav",
        ]);
        let cues = Cues::new(&script);
        let mut history = History::default();
        assert_eq!(history.audio_state(&cues, 0), (false, 0.6));
        history.push(0, false);
        assert_eq!(history.audio_state(&cues, 0), (true, 0.6));
        history.push(1, false);
        assert_eq!(history.audio_state(&cues, 0), (true, 0.2), "ducked");
        history.push(2, false);
        assert_eq!(history.audio_state(&cues, 0), (false, 0.0), "faded out");
        history.back(&cues);
        assert_eq!(history.audio_state(&cues, 0), (true, 0.2), "back restores the ducked level");
        history.back(&cues);
        history.push(3, false);
        assert_eq!(history.audio_state(&cues, 0), (false, 0.6), "handed off to its outro");
        assert_eq!(history.audio_state(&cues, 3), (true, DEFAULT_VOLUME), "short form uses the default volume");
    }

    #[test]
    fn after_a_jump_back_go_fires_every_cue_again() {
        let script = Script::parse(&(0..8).map(|n| format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n```\n\n")).collect::<String>());
        let cues = Cues::new(&script);
        let mut history = History::default();
        let go = |history: &mut History| {
            let next = history.next(&cues);
            if let Some(cue) = next {
                history.push(cue, false);
            }
            next
        };
        // Clicked through 4, 5 and 6, then back to 2: Go goes 3, 4, 5, 6, 7 — nothing skipped.
        for cue in [4, 5, 6, 2] {
            history.push(cue, false);
        }
        assert_eq!((0..6).map(|_| go(&mut history)).collect::<Vec<_>>(), [Some(3), Some(4), Some(5), Some(6), Some(7), None]);

        // Within one pass, what fired by itself is still stepped over: after 1 an
        // auto-cue 3 fires, Go takes 2, and the next Go goes past 3 to 4.
        let mut history = History::default();
        history.push(1, false);
        history.push(3, true);
        assert_eq!(go(&mut history), Some(2));
        assert_eq!(go(&mut history), Some(4));
        // Jumping forward is no new pass; firing the same cue again is.
        let mut history = History::default();
        for (cue, auto) in [(0, false), (1, true), (5, false)] {
            history.push(cue, auto);
        }
        assert_eq!(history.next(&cues), Some(6));
        history.push(0, false);
        assert_eq!(history.next(&cues), Some(1), "the loop that fired by itself in the first pass is due again");
        // Back takes the jump away again.
        history.back(&cues);
        assert_eq!(history.next(&cues), Some(6));
    }
}
