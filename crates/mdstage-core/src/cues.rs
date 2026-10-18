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
        write!(f, "{}.{}", self.ch, self.note)
    }
}

/// When an auto-cue fires relative to its source cue.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AutoWhen {
    /// The source's audio reaches this position (seconds).
    At(f64),
    /// This many seconds after the source fires (0: with it).
    Delay(f64),
    /// When the source's audio has played to its end by itself (`at: end`). Audio that
    /// is stopped or faded out does not count; a source without audio counts as ended.
    End,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoTrigger {
    pub source: Note,
    pub when: AutoWhen,
    /// For a delay on a source that has variants: fire whichever of the variants was
    /// fired (`group: true`), not only the one the note names.
    pub group: bool,
}

/// A cue that breaks the rules for variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VariantProblem {
    /// A cue of a variant group that is set to fire by itself.
    AutoCue { cue: usize },
    /// A cue that carries straight on (`chain_end`) into a variant group.
    ChainedInto { from: usize, to: usize },
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
        // (Times that are no times — negative, infinite, not a number — are not taken: a
        // delay without end would hold Go back for good.)
        let number = |key: &str| at.get(key).and_then(Value::as_f64).filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
        let when = match (number("at"), number("delay")) {
            _ if at.get("at").and_then(Value::as_str) == Some("end") => AutoWhen::End,
            (Some(at), _) => AutoWhen::At(at),
            (None, Some(delay)) => AutoWhen::Delay(delay),
            (None, None) => return None,
        };
        let group = at.get("group").and_then(Value::as_bool) == Some(true);
        Some(AutoTrigger { source: Note::from_yaml(at.get("trigger_note")?)?, when, group })
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

    /// What a cue is called: "Cue 1.47", after its trigger note (channel.note). The
    /// name stays the same when cues are added or moved; variants of a cue share it.
    pub fn name(&self, cue: usize) -> String {
        match self.get(cue).and_then(Cue::note) {
            Some(note) => format!("Cue {note}"),
            None => "Cue ?".to_string(),
        }
    }

    /// The auto-cues that fire when `source` does, in the order they stand in the
    /// script, each with when it fires. An auto-cue hangs on the cue its note names; one
    /// with a delay can instead hang on that cue's whole variant group (`group: true`)
    /// and then fires whichever of the variants was fired.
    pub fn autos_of(&self, source: usize) -> Vec<(usize, AutoWhen)> {
        (0..self.len())
            .filter_map(|cue| {
                let auto = self.get(cue)?.auto_trigger()?;
                let named = self.find(auto.source)?;
                let whole_group = auto.group && matches!(auto.when, AutoWhen::Delay(_)) && self.group_root(named) == self.group_root(source);
                (named == source || whole_group).then_some((cue, auto.when))
            })
            .collect()
    }

    /// Whether a cue is one of several variants (the root of such a group included).
    pub fn in_group(&self, cue: usize) -> bool {
        self.group(cue).len() > 1
    }

    /// Whether a reference to `note` means `cue`: it names the cue itself or, since a
    /// reference to a variant means its whole group, another variant of the same group.
    pub fn refers_to(&self, note: Note, cue: usize) -> bool {
        self.find(note).is_some_and(|named| self.group_root(named) == self.group_root(cue))
    }

    /// The volume of a variant group as a whole (`group_volume` on its first cue), by
    /// which each variant's own volume is multiplied. 1 for a cue that has no variants.
    pub fn group_volume(&self, cue: usize) -> f64 {
        if !self.in_group(cue) {
            return 1.0;
        }
        self.get(self.group_root(cue)).and_then(|root| root.field("group_volume")).and_then(Value::as_f64).map_or(1.0, |v| v.clamp(0.0, 1.0))
    }

    /// What breaks the rules for variants: a variant cannot fire by itself, because the
    /// operator has to choose which one is taken. So no cue of a variant group may be an
    /// auto-cue, and no cue may carry straight on into one.
    pub fn variant_problems(&self) -> Vec<VariantProblem> {
        let mut problems = Vec::new();
        for cue in 0..self.len() {
            let Some(c) = self.get(cue) else { continue };
            if self.in_group(cue) && c.auto_trigger().is_some() {
                problems.push(VariantProblem::AutoCue { cue });
            }
            if let Some(next) = c.chain_end().and_then(|note| self.find(note)).filter(|&next| self.in_group(next)) {
                problems.push(VariantProblem::ChainedInto { from: cue, to: next });
            }
        }
        problems
    }

    /// Whether a cue's audio plays through once (no loop of any kind) and where in its
    /// file it begins. Without audio: once, from 0.
    fn plays_once_from(&self, cue: usize) -> (bool, f64) {
        let Some(c) = self.get(cue) else { return (true, 0.0) };
        match c.audio() {
            Some(audio) => (!(audio.looped || audio.parts.len() > 1 || c.loop_outro().is_some()), audio.parts.first().and_then(|part| part.start).unwrap_or(0.0)),
            None => (true, 0.0),
        }
    }

    /// When an auto-cue fires, as seconds after its source began, if that can be set
    /// beside one of the kind `as_place` (a place in the audio, or a delay). In audio
    /// that plays once a place is a time like a delay is. In a loop a place comes round
    /// on every pass and a delay only once: there the two kinds are not compared.
    fn auto_time(once: bool, start: f64, when: AutoWhen, as_place: bool) -> Option<f64> {
        match when {
            AutoWhen::At(at) if once || as_place => Some(at - start),
            AutoWhen::Delay(delay) if once || !as_place => Some(delay),
            // (How long the audio is, the script does not say.)
            _ => None,
        }
    }

    /// The values an auto-cue may have so that the auto-cues of its source fire in the
    /// order they stand in the script: not before the one before it, not after the one
    /// after it. For a place in the audio (`as_place`) these are seconds into the file,
    /// for a delay seconds after the source fires. `None` at an end that is open.
    pub fn auto_range(&self, target: usize, source: usize, as_place: bool) -> (Option<f64>, Option<f64>) {
        let (once, start) = self.plays_once_from(source);
        let others: Vec<(usize, f64)> =
            self.autos_of(source).into_iter().filter(|(cue, _)| *cue != target).filter_map(|(cue, when)| Some((cue, Self::auto_time(once, start, when, as_place)?))).collect();
        let unit = |time: f64| if as_place { time + start } else { time };
        let before = others.iter().rev().find(|(cue, _)| *cue < target).map(|(_, time)| unit(*time));
        let after = others.iter().find(|(cue, _)| *cue > target).map(|(_, time)| unit(*time));
        (before, after)
    }

    /// Pairs of auto-cues of one source that stand in the script in another order than
    /// they fire in: `(the earlier in the script, the later)`.
    pub fn auto_order_conflicts(&self) -> Vec<(usize, usize)> {
        // Which auto-cues fire with which source, worked out in one pass over the
        // auto-cues (a show file may hold a great many cues).
        let mut by_source: Vec<Vec<(usize, AutoWhen)>> = vec![Vec::new(); self.len()];
        for cue in 0..self.len() {
            let Some(auto) = self.get(cue).and_then(Cue::auto_trigger) else { continue };
            let Some(named) = self.find(auto.source) else { continue };
            let whole_group = auto.group && matches!(auto.when, AutoWhen::Delay(_));
            for source in if whole_group { self.group(named) } else { named..named + 1 } {
                by_source[source].push((cue, auto.when));
            }
        }
        let mut conflicts = Vec::new();
        for (source, autos) in by_source.iter().enumerate() {
            if autos.len() < 2 {
                continue;
            }
            let (once, start) = self.plays_once_from(source);
            // In audio that plays once there is one order; in a loop one for the places
            // and one for the delays.
            for as_place in [true, false] {
                let times: Vec<(usize, f64)> = autos.iter().filter_map(|&(cue, when)| Some((cue, Self::auto_time(once, start, when, as_place)?))).collect();
                for pair in times.windows(2) {
                    if pair[1].1 < pair[0].1 - 1e-9 && !conflicts.contains(&(pair[0].0, pair[1].0)) {
                        conflicts.push((pair[0].0, pair[1].0));
                    }
                }
            }
        }
        conflicts
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

    /// The cue's S/L/F role, if it is part of such a structure. (A loop whose outro is a
    /// variant has every variant of that group as its outro.)
    pub fn slf(&self, cue: usize) -> Option<Slf> {
        let me = self.get(cue)?;
        let from: Vec<usize> = (0..self.len())
            .filter(|&i| i != cue && self.get(i).and_then(Cue::loop_outro).is_some_and(|n| self.refers_to(n, cue)))
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

/// Where the cues of a script are after it was edited: for every cue of `old`, its
/// number in `new`, or `None` if it is gone. Cues are known again by their trigger note
/// (where one note means one cue on both sides), else by having stayed word for word
/// the same; and if no cue came or went, a cue still standing in its place is the same
/// cue, edited.
pub fn mapping(old: &Script, new: &Script) -> Vec<Option<usize>> {
    let (before, after) = (Cues::new(old), Cues::new(new));
    let mut map = vec![None; before.len()];
    let mut taken = vec![false; after.len()];
    // (In one pass each, whatever the size of the file: a script is edited while the
    // show runs.)
    let notes = |cues: &Cues| {
        let mut places: BTreeMap<Note, Vec<usize>> = BTreeMap::new();
        for cue in 0..cues.len() {
            if let Some(note) = cues.get(cue).and_then(Cue::note) {
                places.entry(note).or_default().push(cue);
            }
        }
        places
    };
    let (noted_before, noted_after) = (notes(&before), notes(&after));
    for (note, places) in &noted_before {
        if let ([cue], Some([there])) = (places.as_slice(), noted_after.get(note).map(Vec::as_slice)) {
            map[*cue] = Some(*there);
            taken[*there] = true;
        }
    }
    // Word for word the same: the first such cue that is still free, in order.
    let wording = |cue: &Cue| format!("{:?}", cue.yaml);
    let mut same: BTreeMap<String, std::collections::VecDeque<usize>> = BTreeMap::new();
    for there in (0..after.len()).filter(|&t| !taken[t]) {
        if let Some(cue) = after.get(there) {
            same.entry(wording(cue)).or_default().push_back(there);
        }
    }
    for cue in 0..before.len() {
        if map[cue].is_some() {
            continue;
        }
        let there = before.get(cue).and_then(|c| same.get_mut(&wording(c))).and_then(|free| free.pop_front());
        if let Some(there) = there {
            map[cue] = Some(there);
            taken[there] = true;
        }
    }
    // Edited in its place (even its note may be another now): no cue came or went, and
    // the one that stands where it stood is not known as any other.
    if before.len() == after.len() {
        for cue in 0..before.len() {
            if map[cue].is_none() && !taken[cue] {
                map[cue] = Some(cue);
                taken[cue] = true;
            }
        }
    }
    map
}

/// The cues that going through the script up to `target` would have fired, in order
/// (the target and its own variants not included): every cue that is not part of a
/// variant group and, of each group, the variant `chosen` names for the group's first cue
/// (a group with none chosen is left out). Cues that fire by themselves are part of it
/// as they stand in the script.
pub fn tracked_sequence(cues: &Cues, target: usize, chosen: impl Fn(usize) -> Option<usize>) -> Vec<usize> {
    let own = cues.group(target);
    let mut sequence = Vec::new();
    for cue in (0..target.min(cues.len())).filter(|cue| !own.contains(cue)) {
        if !cues.in_group(cue) {
            sequence.push(cue);
        } else if cues.group_root(cue) == cue {
            sequence.extend(chosen(cue).filter(|variant| cues.group(cue).contains(variant)));
        }
    }
    sequence
}

/// How a cue came into the history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fired {
    /// By the operator (Go, a click, a remote trigger note).
    Manual,
    /// By itself: an auto-cue or a chain transition.
    Auto,
    /// Not fired at all: put in by tracking when the operator jumped, so that the state of
    /// the show is what going through the script up to there would have left. `full`:
    /// for everything (audio, devices with tracking on, microphones); otherwise for the
    /// microphones only (tracking is off for the project). Such entries do not count as
    /// fired anywhere the operator sees it.
    Tracked { full: bool },
}

/// The cues fired so far, oldest first, each with how it came in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    entries: Vec<(usize, Fired)>,
}

/// What a Back undid.
#[derive(Clone, Debug, PartialEq)]
pub struct Undone {
    /// The cues removed from the history, newest first: the operator's last cue and
    /// every automatic cue it had set off.
    pub popped: Vec<usize>,
    /// The entries tracking had put in before that cue (when it was a jump).
    pub tracked: Vec<usize>,
    /// The cue the operator is on again; `None` if nothing is left.
    pub landed: Option<usize>,
    /// Device states to send again so MIDI/OSC/HTTP devices the undone cues addressed
    /// return to what the remaining history last told them. Devices no earlier cue
    /// addressed are left alone, and so are devices with tracking off.
    pub resend: DeviceStates,
}

impl History {
    /// The cues that fired (by the operator or by themselves), oldest first: not what
    /// tracking put in.
    pub fn cues(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries.iter().filter(|e| !matches!(e.1, Fired::Tracked { .. })).map(|e| e.0)
    }

    /// Every entry's cue, those tracking put in included.
    pub fn all(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries.iter().map(|e| e.0)
    }

    /// The script was edited: follow the cues to their new numbers (see [`mapping`]).
    /// Cues that are gone leave the history.
    pub fn remap(&mut self, map: &[Option<usize>]) {
        self.entries = self.entries.iter().filter_map(|&(cue, how)| Some((map.get(cue).copied().flatten()?, how))).collect();
    }

    /// Start a history from the cues as they were fired (all by the operator).
    pub fn of(cues: impl IntoIterator<Item = usize>) -> History {
        History { entries: cues.into_iter().map(|cue| (cue, Fired::Manual)).collect() }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// How many entries there are (a cue that fired twice counts twice; what tracking
    /// put in counts too).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn fired(&self, cue: usize) -> bool {
        self.cues().any(|c| c == cue)
    }

    /// The cues fired in the operator's current pass through the script: since the last
    /// jump back. These are the ones Go steps over.
    pub fn this_pass(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries[self.pass_start()..].iter().filter(|e| !matches!(e.1, Fired::Tracked { .. })).map(|e| e.0)
    }

    /// Record that a cue fired.
    pub fn push(&mut self, cue: usize, auto: bool) {
        self.entries.push((cue, if auto { Fired::Auto } else { Fired::Manual }));
    }

    /// Record what tracking puts in before a jump's cue (see [`Fired::Tracked`]).
    pub fn push_tracked(&mut self, cue: usize, full: bool) {
        self.entries.push((cue, Fired::Tracked { full }));
    }

    /// The operator's position: the most recent manually fired cue. Automatic cues do
    /// not move it, so it stays put while a loop keeps firing.
    pub fn last_manual(&self) -> Option<usize> {
        self.entries.iter().rev().find(|e| e.1 == Fired::Manual).map(|e| e.0)
    }

    /// Where the operator's current pass through the script begins in the history: at
    /// the last cue fired by hand that was not further down than the one fired by hand
    /// before it — the last jump back — or at the very start.
    fn pass_start(&self) -> usize {
        let manual: Vec<(usize, usize)> = self.entries.iter().enumerate().filter(|(_, e)| e.1 == Fired::Manual).map(|(at, e)| (at, e.0)).collect();
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
        let this_pass: Vec<usize> = self.this_pass().collect();
        (from..cues.len()).find(|&i| !cues.is_variant(i) && !this_pass.contains(&i))
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
        self.back_with(cues, &|_| true)
    }

    /// [`History::back`], sending again only to devices for which `tracks` is true. What
    /// tracking put in before the cue goes with it.
    pub fn back_with(&mut self, cues: &Cues, tracks: &dyn Fn(&str) -> bool) -> Option<Undone> {
        let mut popped = Vec::new();
        while let Some(&(cue, how)) = self.entries.last() {
            if matches!(how, Fired::Tracked { .. }) && !popped.is_empty() {
                break;
            }
            self.entries.pop();
            popped.push(cue);
            if how == Fired::Manual {
                break;
            }
        }
        if popped.is_empty() {
            return None;
        }
        let mut tracked = Vec::new();
        while let Some(&(cue, Fired::Tracked { .. })) = self.entries.last() {
            self.entries.pop();
            tracked.push(cue);
        }
        let undone = History { entries: popped.iter().chain(&tracked).map(|&c| (c, Fired::Manual)).collect() };
        let touched = undone.device_states(cues);
        let mut resend = self.device_states_with(cues, tracks);
        resend.retain(|key, _| key.0 != DeviceKind::Display && touched.contains_key(key) && tracks(&key.1));
        Some(Undone { popped, tracked, landed: self.last_manual(), resend })
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
        self.device_states_with(cues, &|_| true)
    }

    /// [`History::device_states`], where what tracking put in counts only for devices
    /// for which `tracks` is true.
    pub fn device_states_with(&self, cues: &Cues, tracks: &dyn Fn(&str) -> bool) -> DeviceStates {
        let mut states = DeviceStates::new();
        for &(c, how) in self.entries.iter().rev() {
            let Some(cue) = cues.get(c) else { continue };
            let counts = |device: &str| match how {
                Fired::Tracked { full } => full && tracks(device),
                _ => true,
            };
            for (kind, key) in [(DeviceKind::Midi, "cue_midi"), (DeviceKind::Osc, "cue_osc"), (DeviceKind::Http, "cue_http")] {
                let mut by_device: Vec<(String, Vec<Value>)> = Vec::new();
                for message in cue.messages(key) {
                    let Some(device) = message.get("device").and_then(Value::as_str).filter(|d| counts(d)) else { continue };
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
                let Some(device) = message.get("device").and_then(Value::as_str).filter(|d| counts(d)) else { continue };
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

    /// The entry whose cue last set what `device` (a display) shows — what tracking put
    /// in counting only where `tracks` says so — if any.
    pub fn display_source(&self, cues: &Cues, device: &str, tracks: &dyn Fn(&str) -> bool) -> Option<usize> {
        self.entries.iter().enumerate().rev().find_map(|(at, &(c, how))| {
            let counts = match how {
                Fired::Tracked { full } => full && tracks(device),
                _ => true,
            };
            let sets = cues.get(c)?.messages("cue_display").iter().any(|message| {
                let filled = |field: &str| message.get(field).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
                message.get("device").and_then(Value::as_str) == Some(device) && (filled("markdown") || !filled("announce"))
            });
            (counts && sets).then_some(at)
        })
    }

    /// Whether `target`'s audio should be playing, and at which volume, given the fired
    /// cues: its own start, every adjust aimed at it, and the handoff to its successor.
    /// Back uses this to restore audio the undone cues had ducked or faded out.
    pub fn audio_state(&self, cues: &Cues, target: usize) -> (bool, f64) {
        // A variant's own volume counts times its group's; an adjust aimed at the group
        // sets the group's share anew.
        let own = cues.get(target).and_then(Cue::music_volume).unwrap_or(DEFAULT_VOLUME);
        let grouped = cues.in_group(target);
        let mut volume = own * cues.group_volume(target);
        let mut playing = false;
        let successor = cues.successor(target);
        // (What tracking put in for the microphones only does not count.)
        let counted = self.entries.iter().filter(|e| e.1 != Fired::Tracked { full: false }).map(|e| e.0);
        for fired in counted {
            let Some(cue) = cues.get(fired) else { continue };
            if fired == target && cue.music_volume().is_some() {
                playing = true;
                volume = own * cues.group_volume(target);
            } else if successor.is_some_and(|s| cues.group_root(s) == cues.group_root(fired)) && playing {
                playing = false;
            }
            if let Some(adjust) = cue.adjust().filter(|a| cues.refers_to(a.target, target)) {
                if adjust.fadeout {
                    playing = false;
                    volume = 0.0;
                } else if let Some(v) = adjust.volume {
                    volume = if grouped { own * v } else { v };
                }
            }
        }
        (playing, volume)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cues_are_found_again_after_an_edit() {
        let cue = |note: u32, body: &str| format!("```yaml\ntrigger_note: {{ch: 1, note: {note}}}\n{body}\n```\n\n");
        let plain = |body: &str| format!("```yaml\n{body}\n```\n\n");
        let old = Script::parse(&[cue(1, "note: a"), plain("note: no note"), cue(2, "note: b"), cue(3, "note: c")].concat());
        // A cue put in at the top, one taken out, two swapped, and one edited.
        let new = Script::parse(&[cue(9, "note: new"), cue(3, "note: c"), cue(1, "note: a, edited"), plain("note: no note")].concat());
        assert_eq!(mapping(&old, &new), [Some(2), Some(3), None, Some(1)]);
        // With as many cues as before, one without a note that was edited is still itself.
        let edited = Script::parse(&[cue(1, "note: a"), plain("note: other words"), cue(2, "note: b"), cue(3, "note: c")].concat());
        assert_eq!(mapping(&old, &edited), [Some(0), Some(1), Some(2), Some(3)]);
        let mut history = History::of([0, 2, 3]);
        history.remap(&mapping(&old, &new));
        assert_eq!(history.cues().collect::<Vec<_>>(), [2, 1]);
    }

    fn note(n: u64) -> Note {
        Note { ch: 1, note: n }
    }

    #[test]
    fn what_tracking_puts_in_counts_for_the_state_but_not_as_fired() {
        let script = show(&[
            "mic: Anna\ncue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 1}\n    - {device: Effekte, type: pc, ch: 1, program: 7}",
            "light: B",
            "sibling: true\nmic: Ben",
            "music: {file: a.wav, loop: true}",
            "light: D",
        ]);
        let cues = Cues::new(&script);
        // Up to cue 4: everything but the variants, of which only a chosen one.
        assert_eq!(tracked_sequence(&cues, 4, |_| None), [0, 3]);
        assert_eq!(tracked_sequence(&cues, 4, |root| (root == 1).then_some(2)), [0, 2, 3]);
        assert_eq!(tracked_sequence(&cues, 2, |_| Some(1)), [0], "not the target's own group");

        let mut history = History::default();
        for cue in tracked_sequence(&cues, 4, |_| Some(2)) {
            history.push_tracked(cue, true);
        }
        history.push(4, false);
        assert_eq!(history.cues().collect::<Vec<_>>(), [4], "only the jump's cue counts as fired");
        assert!(!history.fired(0));
        assert_eq!(history.last_manual(), Some(4));
        assert_eq!(history.audio_state(&cues, 3), (true, DEFAULT_VOLUME), "the loop plays");
        let cast = Cast::from_script(&script, false);
        assert_eq!(history.mic(&cues, &cast), Mic::Open(vec!["Ben".into()]));
        // Devices with tracking off take nothing from what tracking put in.
        let states = history.device_states_with(&cues, &|device| device != "Effekte");
        assert!(states.contains_key(&(DeviceKind::Midi, "Licht".into())) && !states.contains_key(&(DeviceKind::Midi, "Effekte".into())));

        // Back takes the cue and what tracking put in for it.
        let undone = history.back_with(&cues, &|_| true).unwrap();
        assert_eq!((undone.popped, undone.tracked), (vec![4], vec![3, 2, 0]));
        assert!(history.is_empty());

        // Tracking for the microphones only: the loop does not count.
        let mut mics_only = History::default();
        mics_only.push_tracked(3, false);
        assert!(!mics_only.audio_state(&cues, 3).0);
    }

    #[test]
    fn back_sends_again_only_to_devices_that_track() {
        let script = show(&[
            "cue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 1}\n    - {device: Effekte, type: pc, ch: 1, program: 7}",
            "cue_midi:\n    - {device: Licht, type: pc, ch: 1, program: 2}\n    - {device: Effekte, type: pc, ch: 1, program: 8}",
        ]);
        let cues = Cues::new(&script);
        let mut history = History::of([0, 1]);
        let undone = history.back_with(&cues, &|device| device != "Effekte").unwrap();
        assert_eq!(undone.resend.keys().map(|(_, device)| device.as_str()).collect::<Vec<_>>(), ["Licht"]);
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
        assert_eq!(cues.get(1).unwrap().auto_trigger(), Some(AutoTrigger { source: note(0), when: AutoWhen::At(4.5), group: false }));
        assert_eq!(cues.get(2).unwrap().auto_trigger(), Some(AutoTrigger { source: note(1), when: AutoWhen::Delay(8.0), group: false }));
        let end = show(&["music: a.wav", "auto_trigger: {trigger_note: {ch: 1, note: 0}, at: end}"]);
        assert_eq!(Cues::new(&end).get(1).unwrap().auto_trigger().unwrap().when, AutoWhen::End);
        assert_eq!(
            cues.get(2).unwrap().adjust(),
            Some(Adjust { target: note(1), fadeout: true, volume: None, fadetime: Some(2.0) })
        );
        assert!(cues.get(3).unwrap().is_variant());
        assert_eq!(cues.find(note(2)), Some(2));
        assert_eq!(cues.find(note(9)), None);
        assert_eq!(note(7).to_string(), "1.7");
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

    #[test]
    fn auto_cues_of_one_source_fire_in_script_order() {
        let cue = |n: usize, more: &str| format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n{more}\n```\n\n");
        let auto = |what: &str| format!("auto_trigger: {{trigger_note: {{ch: 1, note: 0}}, {what}}}");
        // Audio that plays once, beginning 2 s into its file: a place at 7 s is 5 s in.
        let once = [cue(0, "music: {file: a.wav, start: 2}"), cue(1, &auto("at: 7")), cue(2, &auto("delay: 8")), cue(3, &auto("at: 14"))].concat();
        let script = Script::parse(&once);
        let cues = Cues::new(&script);
        assert!(cues.auto_order_conflicts().is_empty());
        // Cue 2 as a delay: between 5 s (cue 1's place) and 12 s (cue 3's).
        assert_eq!(cues.auto_range(2, 0, false), (Some(5.0), Some(12.0)));
        // As a place in the file: between 7 and 14.
        assert_eq!(cues.auto_range(2, 0, true), (Some(7.0), Some(14.0)));
        assert_eq!(cues.auto_range(1, 0, true), (None, Some(10.0)));
        assert_eq!(cues.auto_range(3, 0, true), (Some(10.0), None));

        let wrong = [cue(0, "music: a.wav"), cue(1, &auto("delay: 9")), cue(2, &auto("at: 4")), cue(3, &auto("delay: 12"))].concat();
        let script = Script::parse(&wrong);
        assert_eq!(Cues::new(&script).auto_order_conflicts(), [(1, 2)]);

        // In a loop places and delays are each in order among themselves, not with each other.
        let looped = [cue(0, "music: {file: a.wav, loop: true}"), cue(1, &auto("delay: 9")), cue(2, &auto("at: 4")), cue(3, &auto("at: 6")), cue(4, &auto("delay: 20"))].concat();
        let script = Script::parse(&looped);
        let cues = Cues::new(&script);
        assert!(cues.auto_order_conflicts().is_empty());
        assert_eq!(cues.auto_range(2, 0, true), (None, Some(6.0)));
        assert_eq!(cues.auto_range(4, 0, false), (Some(9.0), None));
        // A cue that has no auto-cue yet gets the range of the place it stands in.
        let script = Script::parse(&[looped, cue(5, "note: neu")].concat());
        assert_eq!(Cues::new(&script).auto_range(5, 0, false), (Some(20.0), None));
    }

    #[test]
    fn times_that_are_no_times_make_no_auto_cue() {
        let cue = |when: &str| Script::parse(&format!("```yaml\ntrigger_note: {{ch: 1, note: 1}}\nauto_trigger: {{trigger_note: {{ch: 1, note: 0}}, {when}}}\n```\n"));
        let auto = |script: &Script| Cues::new(script).get(0).unwrap().auto_trigger().map(|a| a.when);
        assert_eq!(auto(&cue("delay: 5")), Some(AutoWhen::Delay(5.0)));
        assert_eq!(auto(&cue("delay: .inf")), None, "a delay without end would hold Go back for good");
        assert_eq!(auto(&cue("delay: .nan")), None);
        assert_eq!(auto(&cue("delay: -3")), None);
        assert_eq!(auto(&cue("at: -1")), None);
        assert_eq!(auto(&cue("at: 0")), Some(AutoWhen::At(0.0)));
    }

    /// Checking the order of auto-cues stays quick in a show with very many cues.
    #[test]
    fn the_order_check_copes_with_many_cues() {
        let mut text = String::from("```yaml\ntrigger_note: {ch: 1, note: 0}\nmusic: a.wav\n```\n\n");
        for n in 1..=1500 {
            let (ch, note) = (1 + n / 120, n % 120);
            text.push_str(&format!("```yaml\ntrigger_note: {{ch: {ch}, note: {note}}}\nauto_trigger: {{trigger_note: {{ch: 1, note: 0}}, delay: {}}}\n```\n\n", 3000 - n));
        }
        let script = Script::parse(&text);
        let started = std::time::Instant::now();
        let conflicts = Cues::new(&script).auto_order_conflicts();
        assert_eq!(conflicts.len(), 1499, "every one of them fires before the one above it");
        assert!(started.elapsed().as_secs_f64() < 5.0, "{:?}", started.elapsed());
    }
}
