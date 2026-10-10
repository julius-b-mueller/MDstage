//! The script: headings, stage directions, dialogue and cue panels in one long,
//! virtualized view. Only the blocks on screen are laid out and painted; heights are
//! measured once per window width.

use std::collections::HashMap;
use std::path::PathBuf;

use eframe::egui::text::{CCursor, CCursorRange, LayoutJob, TextFormat};
use eframe::egui::{self, Align2, Color32, FontId, Id, Key, Modifiers, Rect, RichText, Sense, Stroke, Ui, UiBuilder, pos2, vec2};
use mdstage_core::audio::Part;
use mdstage_core::cues::{AutoWhen, Cues, Note, Slf};
use mdstage_core::effects::Effect;
use mdstage_core::mic::{Cast, Mic, MicChip};
use mdstage_core::{Block, Cue, Script};
use mdstage_engine::mtc::Timecode;
use mdstage_engine::session::Snapshot;

use crate::lang::t;
use crate::vim::{self, Vim};
use crate::theme::*;
use crate::waveform::{WaveState, Waveforms};

const MARGIN: f32 = 24.0;
const BLOCK_PAD: f32 = 6.0;
const ROW: f32 = 21.0;
const WAVE_HEIGHT: f32 = 64.0;
/// Height of the row of transport controls under a waveform.
const CONTROLS: f32 = 26.0;
const MAX_ZOOM: f32 = 32.0;
/// Width of the column beside the inline editor that holds its move buttons.
const ARROWS: f32 = 30.0;

/// The markers on a waveform, in seconds: where the audio starts and ends, and how long
/// it fades in and out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marks {
    pub start: f64,
    pub end: f64,
    pub fadein: f64,
    pub fadeout: f64,
}

/// A connection from one cue to another, set up by clicking the other cue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    /// The cue changes the other's audio when it fires (`music.adjust`).
    Adjust,
    /// The cue fires by itself, triggered by the other (`auto_trigger`).
    AutoCue,
    /// At its end the cue carries straight on with the other (`chain_end`).
    Chain,
    /// The cue loops until the other, its outro, is fired (`loop_outro`).
    LoopOutro,
}

/// What the operator did in the view; the app carries it out.
pub enum Action {
    /// While setting up a `link` for the cue in `block`, the cue `cue` was clicked.
    Picked { link: Link, block: usize, cue: usize },
    /// Remove a connection from the cue in `block` (`Chain` removes both S/L/F kinds).
    Unlink { link: Link, block: usize },
    /// Switch Auto-Mic on or off for the cue in `block`.
    AutoMic { block: usize, on: bool },
    /// Open the live view with this cue as the next Go.
    ArmLive(usize),
    /// Open an existing text block for editing.
    EditText(usize),
    /// Move a block one place up or down and go on editing it there.
    MoveAndEdit { block: usize, up: bool },
    /// Put a block in before this index and edit it.
    InsertAndEdit { at: usize, block: Block },
    /// Open the show file at this block in the text editor set up in the settings.
    OpenInEditor(usize),
    /// A click on a cue.
    Fire(usize),
    /// A block was edited.
    Replace { block: usize, with: Block },
    /// The markers of a cue's audio were dragged.
    Markers { block: usize, marks: Marks },
    /// The marker of an audio-position auto-cue was dragged: the cue in `block` now
    /// fires `at` seconds into its source.
    AutoCueAt { block: usize, at: f64 },
    /// Play or pause a cue's audio by itself.
    PlayPause(usize),
    /// Stop a cue's audio and put it back to its start.
    StopCue(usize),
    /// The playhead was dragged along a waveform: move the cue's audio there.
    Seek { cue: usize, seconds: f64 },
    /// The volume slider is being moved: the level for audio that is playing.
    LiveVolume { cue: usize, volume: f64 },
    /// The volume slider was let go: the level to save.
    Volume { block: usize, volume: f64 },
    /// Switch a cue's audio to looping or back.
    Loop { block: usize, on: bool },
    /// Make this cue the next Go.
    Arm(usize),
    /// Open the cue dialog for an existing cue.
    EditCue(usize),
    /// Open the cue dialog for a new cue before this block index.
    NewCue(usize),
    /// Insert an empty text block before this index and edit it.
    NewText(usize),
    Move { block: usize, up: bool },
    Delete(usize),
    /// Remember this cue for pasting.
    Copy(usize),
    /// Insert the remembered cue before this block index.
    Paste(usize),
    /// Add a variant of this cue right after it.
    Variant(usize),
}

/// What the view shows; borrowed from the app each frame.
pub struct Context<'a> {
    pub script: &'a Script,
    pub cast: &'a Cast,
    pub snapshot: &'a Snapshot,
    /// Editing is off (show lock).
    pub locked: bool,
    /// Show the line of the show file each block begins on.
    pub line_numbers: bool,
    /// Show microphones bundled into their groups.
    pub group_mics: bool,
    /// A cue has been copied and can be pasted.
    pub can_paste: bool,
    /// An editor command is set up: blocks can be opened in the text editor.
    pub has_editor: bool,
    /// Text is edited with Vim keys.
    pub vim: bool,
}

struct Editing {
    index: usize,
    buffer: String,
    focused: bool,
    /// The block was just inserted; leaving it empty removes it again.
    fresh: bool,
}

/// Full-text search over the script.
#[derive(Default)]
struct Search {
    query: String,
    /// Blocks containing the query, and which of them is the current hit.
    hits: Vec<usize>,
    current: usize,
    focus: bool,
}

/// One coloured piece of a row in a cue panel.
type Span = (String, Color32);

/// A row of a cue panel: a label and coloured spans. `links` says which of the spans
/// name another cue (span index, cue); those can be clicked to go there.
pub(crate) struct Row {
    pub label: &'static str,
    pub spans: Vec<Span>,
    pub links: Vec<(usize, usize)>,
}

impl Row {
    fn plain(label: &'static str, spans: Vec<Span>) -> Row {
        Row { label, spans, links: Vec::new() }
    }

    /// A row of words and references to other cues (`Some(cue)`; `None` inside is a
    /// reference that leads nowhere).
    fn linked(label: &'static str, parts: Vec<(String, Color32, Option<Option<usize>>)>) -> Row {
        let links = parts.iter().enumerate().filter_map(|(i, part)| Some((i, part.2??))).collect();
        let spans = parts.into_iter().map(|(text, colour, target)| (if target.is_some() && text.is_empty() { "?".to_string() } else { text }, colour)).collect();
        Row { label, spans, links }
    }
}

/// What ties one cue to another, as drawn in the margin.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tie {
    /// Carries on with the other, or loops until the other comes (S/L/F).
    Chain,
    /// Fires the other by itself (auto-cue).
    Auto,
    /// Changes the other's audio.
    Adjust,
}

impl Tie {
    fn colour(self) -> Color32 {
        match self {
            Tie::Chain => ORANGE,
            Tie::Auto => PURPLE,
            Tie::Adjust => GREEN,
        }
    }
}

/// A line in the margin from one cue's block to another's, in one of a few lanes.
struct Relation {
    from: usize,
    to: usize,
    tie: Tie,
    lane: usize,
    /// Where on each cue's left edge the line ends: its place among all the line ends
    /// on that cue, and how many there are. Every end has a place of its own.
    from_place: (usize, usize),
    to_place: (usize, usize),
}

/// Each kind of connection has one colour for everything about it — the row in the
/// card, the button, the line in the margin: auto-cues purple, adjusting another cue's
/// audio green, start/loop/finish orange (as the loop point on the waveform).
/// The colour of auto-cues: their marker on the waveform, their row and their line.
const PURPLE: Color32 = Color32::from_rgb(0xc6, 0x78, 0xdd);
/// The colour of start/loop/finish and of a loop's point on its waveform.
const ORANGE: Color32 = Color32::from_rgb(0xd1, 0x9a, 0x66);
/// Height of the line above a waveform that names its auto-cue markers.
const AUTO_NAMES: f32 = 14.0;
/// From a cue's left edge to the first lane: room for an arrowhead and a straight piece
/// of line before the corner.
const FIRST_LANE: f32 = 18.0;
/// Height of the strip under a waveform that one position auto-cue's line runs out in.
const AUTO_STRIP: f32 = 5.0;
/// Distance between two lanes of connection lines in the margin.
const LANE: f32 = 8.0;
const MAX_LANES: usize = 4;
/// How long a cue that was gone to stays outlined, in seconds.
const FLASH: f64 = 1.4;

#[derive(Default)]
pub struct ScriptView {
    /// Height of every block and its top edge (`offsets` has one extra entry: the total).
    heights: Vec<f32>,
    offsets: Vec<f32>,
    layout_width: f32,
    dirty: bool,
    headings: Vec<(usize, u8, String)>,
    /// Cue number of each block (cues only), and the block of each cue.
    cue_of_block: Vec<Option<usize>>,
    block_of_cue: Vec<usize>,
    editing: Option<Editing>,
    /// Markers being dragged, by block.
    dragging: HashMap<usize, Marks>,
    /// Auto-cue markers being dragged: block of the auto-cue → seconds.
    auto_dragging: HashMap<usize, f64>,
    /// Where audio files are being dragged over the window, if they would become cues.
    drop_at: Option<egui::Pos2>,
    /// Playheads being dragged along their waveform: block → seconds.
    scrubbing: HashMap<usize, f64>,
    /// Volume sliders being dragged, by block.
    volumes: HashMap<usize, f64>,
    /// Waveforms that are zoomed in: block → (factor, where the view begins in seconds).
    zoom: HashMap<usize, (f32, f64)>,
    /// Zoomed waveforms whose playback position was in view when last drawn. Only those
    /// follow the position; one the operator has scrolled away from stays where it is.
    following: std::collections::HashSet<usize>,
    /// The line of the show file each block begins on.
    lines: Vec<usize>,
    /// The scene number of each block that is a scene's heading.
    numbers: Vec<Option<usize>>,
    /// A scene number being typed to jump there: the digits so far, and when the last
    /// one came (seconds).
    typed_scene: Option<(usize, f64)>,
    /// Vim keys: the mode, what was yanked, and so on.
    vim: Vim,
    /// The block about to be edited was reached with `k` from the one below: the cursor
    /// belongs on its last line.
    vim_from_below: bool,
    /// The block last copied or cut as a whole (`yab`, `dab`).
    vim_block: Option<Block>,
    /// Whether the block being edited was entered from below (for a carried count).
    vim_came_from_below: bool,
    /// The next block opened is the one just moved: stay in the mode the editor is in.
    vim_keep_mode: bool,
    /// Where the script was drawn last: the screen position of its top left corner
    /// (scrolled along) and the part of the window it shows in.
    drawn_at: Option<(egui::Pos2, Rect)>,
    /// A connection being set up: the next cue clicked completes it.
    picking: Option<(Link, usize)>,
    /// Lengths of the audio files seen so far, in seconds.
    durations: HashMap<String, f64>,
    /// Where the view is scrolling to (it glides there over a few frames).
    scroll_to: Option<f32>,
    scroll_y: f32,
    /// The connections between cues, and how many lanes they take in the margin.
    relations: Vec<Relation>,
    lanes: usize,
    /// The cue block under the pointer in this frame and in the one before.
    hovered: Option<usize>,
    hovered_before: Option<usize>,
    /// The cue block whose buttons were shown last (they stay while a menu of theirs is open).
    buttons_of: Option<usize>,
    /// A cue block that was gone to, and when: it is outlined for a moment.
    flash: Option<(usize, f64)>,
    /// Where the markers of position auto-cues stand on the waveforms drawn in this
    /// frame: block of the auto-cue → the foot of its marker.
    auto_anchors: HashMap<usize, egui::Pos2>,
    waveforms: Option<Waveforms>,
    search: Option<Search>,
}

impl ScriptView {
    /// A show was opened: forget everything about the previous one.
    pub fn reset(&mut self, audio_dir: PathBuf, ctx: &egui::Context) {
        *self = ScriptView { dirty: true, waveforms: Some(Waveforms::new(audio_dir, ctx.clone())), ..Default::default() };
    }

    /// The script changed: measure again.
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub fn is_editing(&self) -> bool {
        self.editing.is_some()
    }

    /// Open the inline editor on a block (a freshly inserted one if `fresh`).
    pub fn edit(&mut self, script: &Script, index: usize, fresh: bool) {
        let Some(block) = script.blocks.get(index) else { return };
        let buffer = match block {
            // A stage direction is edited as what it says; its asterisks are the file's business.
            Block::Stage(text) => text.clone(),
            block => Script { blocks: vec![block.clone()] }.to_markdown().trim_end().to_string(),
        };
        self.editing = Some(Editing { index, buffer, focused: false, fresh });
        self.dirty = true;
    }

    /// Open the search bar (or put the cursor back into it).
    pub fn open_search(&mut self) {
        self.search.get_or_insert_with(Search::default).focus = true;
    }

    /// A digit was typed outside any text field: part of a scene number to jump to.
    /// "2" goes to scene 2, "1" then "7" to scene 17.
    pub fn type_scene_digit(&mut self, digit: usize, now: f64) {
        let so_far = self.typed_scene.map_or(0, |(number, _)| number);
        self.typed_scene = Some(((so_far * 10 + digit).min(9999), now));
    }

    /// Jump to the scene typed, once it is clear that no further digit is coming: after
    /// a short wait, or at once if no scene number could begin with what was typed.
    fn jump_to_typed_scene(&mut self, ui: &Ui) {
        const WAIT: f64 = 0.8;
        let Some((number, at)) = self.typed_scene else { return };
        let scenes = self.numbers.iter().flatten().count();
        let now = ui.input(|i| i.time);
        if number * 10 <= scenes && now - at < WAIT {
            // Show what has been typed while waiting for a possible second digit.
            let corner = ui.clip_rect().right_top() + vec2(-24.0, 18.0);
            let text = ui.painter().layout_no_wrap(number.to_string(), FontId::proportional(34.0), BRIGHT);
            let plate = Rect::from_min_size(corner - vec2(text.size().x + 28.0, 0.0), text.size() + vec2(28.0, 12.0));
            ui.painter().rect_filled(plate, 8.0, PANEL.gamma_multiply(0.95));
            ui.painter().galley(plate.min + vec2(14.0, 6.0), text, BRIGHT);
            ui.ctx().request_repaint();
            return;
        }
        self.typed_scene = None;
        if let Some(block) = self.numbers.iter().position(|n| *n == Some(number)) {
            self.scroll_to = self.offsets.get(block).copied();
            ui.ctx().request_repaint();
        }
    }

    /// What the operator is asked to do while a connection is being set up.
    pub fn picking_hint(&self) -> Option<&'static str> {
        Some(match self.picking?.0 {
            Link::Adjust => t("Bezug: den Cue anklicken, dessen Audio verändert werden soll.", "Adjust: click the cue whose audio is to be changed."),
            Link::AutoCue => t(
                "Auto-Cue: die Quelle anklicken. Steht ihr Audio pausiert an einer Stelle, wird dort ausgelöst, sonst nach einer Verzögerung.",
                "Auto-cue: click the source. If its audio is paused somewhere, the cue fires there, otherwise after a delay.",
            ),
            Link::Chain => t("Start: den Cue anklicken, mit dem es am Ende nahtlos weitergeht.", "Start: click the cue it carries straight on with at the end."),
            Link::LoopOutro => t("Loop: den Cue anklicken, der als Outro den Loop beendet.", "Loop: click the cue that ends the loop as its outro."),
        })
    }

    pub fn cancel_pick(&mut self) {
        self.picking = None;
    }

    /// The search bar, if open. Enter goes to the next hit, Shift+Enter back, Escape closes.
    pub fn search_bar(&mut self, ui: &mut Ui, script: &Script) {
        let Some(search) = &mut self.search else { return };
        let mut close = false;
        let mut step: i64 = 0;
        ui.horizontal(|ui| {
            ui.label(t("Suche", "Search"));
            let response = ui.add(egui::TextEdit::singleline(&mut search.query).desired_width(260.0));
            if std::mem::take(&mut search.focus) {
                response.request_focus();
            }
            if response.changed() {
                let needle = search.query.to_lowercase();
                search.hits = if needle.is_empty() {
                    Vec::new()
                } else {
                    let text = |b: &Block| Script { blocks: vec![b.clone()] }.to_markdown().to_lowercase();
                    (0..script.blocks.len()).filter(|&i| !matches!(script.blocks[i], Block::Config(_)) && text(&script.blocks[i]).contains(&needle)).collect()
                };
                search.current = 0;
                step = 0;
                if !search.hits.is_empty() {
                    self.scroll_to = self.offsets.get(search.hits[0]).map(|y| (y - 80.0).max(0.0));
                }
            }
            if response.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                step = if ui.input(|i| i.modifiers.shift) { -1 } else { 1 };
                response.request_focus();
            }
            if ui.small_button("▲").clicked() {
                step = -1;
            }
            if ui.small_button("▼").clicked() {
                step = 1;
            }
            let count = if search.hits.is_empty() { "0".to_string() } else { format!("{} / {}", search.current + 1, search.hits.len()) };
            ui.label(RichText::new(count).color(MUTED));
            close = ui.small_button("×").clicked() || ui.input(|i| i.key_pressed(Key::Escape));
        });
        if step != 0 && !search.hits.is_empty() {
            let n = search.hits.len() as i64;
            search.current = ((search.current as i64 + step).rem_euclid(n)) as usize;
            self.scroll_to = self.offsets.get(search.hits[search.current]).map(|y| (y - 80.0).max(0.0));
        }
        if close {
            self.search = None;
        }
    }

    /// Bring a cue to the top third of the view.
    pub fn scroll_to_cue(&mut self, cue: usize) {
        if let Some(&block) = self.block_of_cue.get(cue) {
            self.scroll_to = self.offsets.get(block).map(|y| (y - 120.0).max(0.0));
        }
    }

    /// Go to a cue that another one refers to, and outline it for a moment so that the
    /// eye finds it.
    fn go_to_cue(&mut self, cue: usize, now: f64) {
        self.scroll_to_cue(cue);
        self.flash = self.block_of_cue.get(cue).map(|&block| (block, now));
    }

    /// Work out which cues are tied to which, and give every tie a lane in the margin:
    /// short ones innermost, and no two in one lane that would run over each other.
    fn relate(&mut self, script: &Script) {
        let cues = Cues::new(script);
        let mut found = Vec::new();
        for cue in 0..cues.len() {
            let Some(c) = cues.get(cue) else { continue };
            let mut tie = |from: Option<usize>, to: Option<usize>, tie: Tie| {
                if let (Some(from), Some(to)) = (from.and_then(|c| cues.block_index(c)), to.and_then(|c| cues.block_index(c))) {
                    if from != to {
                        found.push(Relation { from, to, tie, lane: 0, from_place: (0, 1), to_place: (0, 1) });
                    }
                }
            };
            tie(Some(cue), c.chain_end().and_then(|n| cues.find(n)), Tie::Chain);
            tie(Some(cue), c.loop_outro().and_then(|n| cues.find(n)), Tie::Chain);
            tie(c.auto_trigger().and_then(|a| cues.find(a.source)), Some(cue), Tie::Auto);
            tie(Some(cue), c.adjust().and_then(|a| cues.find(a.target)), Tie::Adjust);
        }
        found.sort_by_key(|r| r.from.abs_diff(r.to));
        // Per lane: the stretches taken, and whether each runs downwards. Two that run
        // downwards may meet in one cue: one arrives at its top, the other leaves below.
        let mut lanes: Vec<Vec<(usize, usize, bool)>> = Vec::new();
        for relation in &mut found {
            let (low, high, down) = (relation.from.min(relation.to), relation.from.max(relation.to), relation.from < relation.to);
            let clear = |taken: &Vec<(usize, usize, bool)>| taken.iter().all(|&(l, h, d)| if down && d { high <= l || low >= h } else { high < l || low > h });
            let lane = match lanes.iter().position(clear) {
                Some(lane) => lane,
                None if lanes.len() < MAX_LANES => {
                    lanes.push(Vec::new());
                    lanes.len() - 1
                }
                None => MAX_LANES - 1,
            };
            lanes[lane].push((low, high, down));
            relation.lane = lane;
        }
        // Every line end gets a place of its own on its cue's edge, from the top: first
        // the lines that come from or go to cues above, then those below, so that the
        // lines cross as little as possible.
        let mut ends: HashMap<usize, Vec<(usize, bool, usize)>> = HashMap::new();
        for (index, relation) in found.iter().enumerate() {
            ends.entry(relation.from).or_default().push((relation.to, true, index));
            ends.entry(relation.to).or_default().push((relation.from, false, index));
        }
        for (block, mut list) in ends {
            // Above: the nearest cue's line lowest. Below: the nearest cue's line highest.
            list.sort_by_key(|&(other, _, index)| (other > block, if other > block { other } else { usize::MAX - other }, index));
            let count = list.len();
            for (place, (_, leaves, index)) in list.into_iter().enumerate() {
                match leaves {
                    true => found[index].from_place = (place, count),
                    false => found[index].to_place = (place, count),
                }
            }
        }
        self.lanes = lanes.len();
        self.relations = found;
    }

    /// Width of the part of the margin that holds the connection lines.
    fn rail(&self) -> f32 {
        if self.lanes == 0 { 0.0 } else { (self.lanes - 1) as f32 * LANE + FIRST_LANE + 4.0 }
    }

    /// The connections between cues, in the margin left of them: a line from the cue
    /// that acts (a dot) to the one it leads to or changes (an arrow). They are faint
    /// until the pointer is on one of their two cues.
    fn draw_relations(&self, ui: &Ui, origin: egui::Pos2, viewport: Rect) {
        let painter = ui.painter();
        for relation in &self.relations {
            // The ends on one cue are spread down its edge, closer together if there are many.
            let at = |block: usize, (place, count): (usize, usize)| {
                let height = self.heights.get(block).copied().unwrap_or(0.0);
                let apart = if count > 1 { ((height - 34.0) / (count - 1) as f32).clamp(4.0, 11.0) } else { 0.0 };
                origin.y + self.offsets.get(block).copied().unwrap_or(0.0) + 4.0 + 14.0 + place as f32 * apart
            };
            // An auto-cue at a place in its source's audio begins right there: at the foot
            // of its marker, if that is on screen. Its line runs out of the card in a strip
            // of its own under the waveform.
            let marker = self.auto_anchors.get(&relation.to).filter(|_| relation.tie == Tie::Auto).copied();
            let start = marker.unwrap_or(pos2(origin.x - 4.0, at(relation.from, relation.from_place)));
            let (from, to) = (start.y, at(relation.to, relation.to_place));
            if from.max(to) < origin.y + viewport.min.y || from.min(to) > origin.y + viewport.max.y {
                continue;
            }
            // Mixed with the background rather than made transparent: where line, dot and
            // arrowhead lie on each other they must not add up to something darker.
            let strong = self.hovered_before.is_some_and(|h| h == relation.from || h == relation.to);
            let colour = if strong { relation.tie.colour() } else { BACKGROUND.lerp_to_gamma(relation.tie.colour(), 0.5) };
            let x = origin.x - FIRST_LANE - relation.lane as f32 * LANE;
            // Out of the cue, round the corner, along the lane, round the corner, into the
            // other. The line is straight where it leaves the dot and where it enters the
            // arrowhead; the corners lie between.
            let (tip, base) = (origin.x - 1.0, origin.x - 8.0);
            let way = (to - from).signum();
            let radius = 6.0_f32.min((to - from).abs() / 2.0);
            let mut points = vec![start];
            const STEPS: usize = 8;
            for step in 0..=STEPS {
                let angle = step as f32 / STEPS as f32 * std::f32::consts::FRAC_PI_2;
                points.push(pos2(x + radius - radius * angle.sin(), from + way * (radius - radius * angle.cos())));
            }
            for step in 0..=STEPS {
                let angle = step as f32 / STEPS as f32 * std::f32::consts::FRAC_PI_2;
                points.push(pos2(x + radius - radius * angle.cos(), to - way * (radius - radius * angle.sin())));
            }
            points.push(pos2(base + 1.0, to));
            painter.add(egui::epaint::PathShape::line(points, Stroke::new(if strong { 2.0_f32 } else { 1.5_f32 }, colour)));
            painter.circle_filled(start, 2.5, colour);
            painter.add(egui::Shape::convex_polygon(vec![pos2(tip, to), pos2(base, to - 3.5), pos2(base, to + 3.5)], colour, Stroke::NONE));
        }
    }

    fn role_colour(cast: &Cast, name: &str) -> Color32 {
        let role = cast.role(name).and_then(|r| r.color.as_deref());
        let group = cast.groups.iter().find(|g| g.name == name).and_then(|g| g.color.as_deref());
        named(role.or(group)).unwrap_or(BRIGHT)
    }

    /// Text layout of a block; `None` for blocks that are not plain text.
    fn job(cast: &Cast, block: &Block, width: f32, number: Option<usize>) -> Option<LayoutJob> {
        Self::text_job(cast, block, width, 1.0, number)
    }

    /// The number of each scene, by block: the first-level headings are counted from 1,
    /// headings below them have none. A first-level heading that opens the file and is
    /// followed directly by another one is the show's title and is not counted.
    pub(crate) fn scene_numbers(script: &Script) -> Vec<Option<usize>> {
        let is_scene = |block: &Block| matches!(block, Block::Heading { level: 1, .. });
        let first = script.blocks.iter().position(|b| !matches!(b, Block::Config(_)));
        let second = first.and_then(|f| script.blocks[f + 1..].iter().find(|b| !matches!(b, Block::Config(_))));
        let title = first.filter(|f| is_scene(&script.blocks[*f]) && second.is_some_and(is_scene));
        let mut number = 0;
        script
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| {
                (is_scene(block) && Some(index) != title).then(|| {
                    number += 1;
                    number
                })
            })
            .collect()
    }

    /// A text block laid out for a given width; `scale` enlarges the type (the live view
    /// is read from further away).
    /// `number` is the scene's number, set before a heading that has one.
    pub(crate) fn text_job(cast: &Cast, block: &Block, width: f32, scale: f32, number: Option<usize>) -> Option<LayoutJob> {
        let mut job = LayoutJob::default();
        job.wrap.max_width = width;
        let plain = |size: f32, color| TextFormat { font_id: FontId::proportional(size * scale), color, ..Default::default() };
        // Running text gets a little air between its lines.
        let body = |size: f32, color| TextFormat { line_height: Some(size * scale * 1.38), ..plain(size, color) };
        match block {
            Block::Heading { level, text } => {
                let size = match level {
                    1 => 27.0,
                    2 => 21.0,
                    _ => 17.0,
                };
                if let Some(number) = number {
                    job.append(&format!("{number}  "), 0.0, plain(size, MUTED));
                }
                job.append(text, 0.0, plain(size, BRIGHT));
            }
            Block::Stage(text) => job.append(text, 0.0, TextFormat { italics: true, ..body(16.0, MUTED) }),
            Block::Role { names, text } => {
                let colour = names.first().map_or(BRIGHT, |n| Self::role_colour(cast, n));
                for (i, name) in names.iter().enumerate() {
                    if i > 0 {
                        job.append("  /  ", 0.0, plain(13.0, MUTED));
                    }
                    job.append(&name.to_uppercase(), 0.0, plain(13.0, Self::role_colour(cast, name)));
                }
                if !text.is_empty() {
                    job.append("\n", 0.0, plain(13.0, colour));
                    // Inline stage directions `*(…)*` are shown in grey italics.
                    let mut rest = text.as_str();
                    while let Some(open) = rest.find("*(") {
                        let Some(close) = rest[open..].find(")*") else { break };
                        job.append(&rest[..open], 0.0, body(17.0, colour));
                        job.append(&rest[open + 1..open + close + 1], 0.0, TextFormat { italics: true, ..body(17.0, MUTED) });
                        rest = &rest[open + close + 2..];
                    }
                    job.append(rest, 0.0, body(17.0, colour));
                }
            }
            Block::Text(text) => job.append(text, 0.0, body(17.0, TEXT)),
            Block::Config(_) | Block::Cue(_) => return None,
        }
        Some(job)
    }

    /// The rows of a cue panel: a label and coloured spans.
    /// The cue that leads into `cue`: the one that chains on with it or loops until it.
    fn predecessor(cues: &Cues, cue: usize) -> Option<usize> {
        let note = cues.get(cue)?.note()?;
        (0..cues.len()).find(|&p| p != cue && cues.get(p).is_some_and(|c| c.chain_end() == Some(note) || c.loop_outro() == Some(note)))
    }

    /// The timecode a cue without `start_tc` starts at because the timecode of the cue
    /// before it in its chain runs on. `None`: there is none. `Some(None)`: there is,
    /// but an audio file's length is not known yet.
    fn derived_timecode(cues: &Cues, cue: usize, durations: &HashMap<String, f64>, depth: usize) -> Option<Option<f64>> {
        let before = Self::predecessor(cues, cue).filter(|_| depth < 8)?;
        let earlier = cues.get(before)?;
        let base = match earlier.text("start_tc").and_then(Timecode::parse) {
            Some(timecode) => Some(timecode.to_frames() as f64 / mdstage_engine::mtc::FPS as f64),
            None => Self::derived_timecode(cues, before, durations, depth + 1)?,
        };
        // How long the earlier cue plays before it hands over: every part from its start
        // to its transition point.
        let length = earlier.audio().and_then(|audio| {
            audio.parts.iter().try_fold(0.0, |sum, part| {
                let end = match part.fading_point.or(part.end) {
                    Some(end) => end,
                    None => part.audios.iter().map(|a| durations.get(&a.file).copied()).try_fold(0.0f64, |longest, d| Some(longest.max(d?)))?,
                };
                Some(sum + (end - part.start.unwrap_or(0.0)).max(0.0))
            })
        });
        Some(base.zip(length).map(|(base, length)| base + length))
    }

    pub(crate) fn cue_rows(cx: &Context, block: usize, cue_index: usize, cue: &Cue, durations: &HashMap<String, f64>) -> Vec<Row> {
        let mut rows = Vec::new();
        if cue.invalid {
            rows.push(Row::plain("YAML", vec![(t("nicht lesbar", "unreadable").to_string(), RED)]));
            return rows;
        }
        let mic = cx.script.mic_for_cue(block, cx.cast);
        match &mic {
            Mic::MuteAll => rows.push(Row::plain("Mic", vec![(t("alle aus", "all off").to_string(), MUTED)])),
            Mic::Open(_) => {
                let mut spans = Vec::new();
                for chip in cx.cast.chips(&mic, cx.group_mics) {
                    match chip {
                        MicChip::Role { name, color } => spans.push((name, named(color.as_deref()).unwrap_or(BRIGHT))),
                        MicChip::Group { name, color, members } => {
                            spans.push((format!("{name} ["), named(color.as_deref()).unwrap_or(BRIGHT)));
                            spans.extend(members.into_iter().map(|(m, c)| (m, named(c.as_deref()).unwrap_or(BRIGHT))));
                            spans.push(("]".to_string(), MUTED));
                        }
                    }
                }
                if cue.auto_mic() {
                    spans.push(("(auto)".to_string(), MUTED));
                }
                rows.push(Row::plain("Mic", spans));
            }
            Mic::Unchanged if cue.auto_mic() => rows.push(Row::plain("Mic", vec![(t("(auto, niemand spricht)", "(auto, nobody speaks)").to_string(), MUTED)])),
            Mic::Unchanged => {}
        }
        for (label, key) in [(t("Notiz", "Note"), "note"), ("TC", "start_tc"), ("OSC", "osc"), ("Proj.", "projection"), ("QLC+", "qlcplus")] {
            if let Some(value) = cue.text(key) {
                rows.push(Row::plain(label, vec![(value.to_string(), TEXT)]));
            }
        }
        if let Some(audio) = cue.audio() {
            let mut spans: Vec<Span> = Vec::new();
            for (i, part) in audio.parts.iter().enumerate() {
                if i > 0 {
                    spans.push(("→".to_string(), MUTED));
                }
                spans.push((part.audios.iter().map(|a| a.file.as_str()).collect::<Vec<_>>().join(" + "), TEXT));
            }
            if audio.looped || audio.parts.len() > 1 || cue.loop_outro().is_some() {
                spans.push(("⟳".to_string(), ORANGE));
            }
            rows.push(Row::plain("♬", spans));
        }
        let cues = Cues::new(cx.script);
        if cue.text("start_tc").is_none() {
            if let Some(derived) = Self::derived_timecode(&cues, cue_index, durations, 0) {
                let timecode = derived.map_or("--:--:--:--".to_string(), |seconds| Timecode::from_frames((seconds * mdstage_engine::mtc::FPS as f64).round() as u64).to_string());
                rows.push(Row::plain("TC", vec![(timecode, TEXT), (t("(abgeleitet)", "(derived)").to_string(), MUTED)]));
            }
        }
        // Compressed files carry padding at their edges: a handover is not seamless.
        let in_chain = cue.chain_end().is_some() || cue.loop_outro().is_some() || Self::predecessor(&cues, cue_index).is_some();
        let compressed = |file: &str| [".mp3", ".aac", ".m4a", ".ogg"].iter().any(|ext| file.to_lowercase().ends_with(ext));
        if in_chain && cue.audio().is_some_and(|a| a.parts.iter().flat_map(|p| &p.audios).any(|a| compressed(&a.file))) {
            rows.push(Row::plain("!", vec![(t("Kein nahtloser Übergang – MP3/AAC haben Encoder-Padding. WAV verwenden.", "No seamless transition – MP3/AAC carry encoder padding. Use WAV.").to_string(), YELLOW)]));
        }
        // References to other cues: each "Cue N" is a span of its own that can be clicked.
        let word = |text: &str, colour: Color32| (text.to_string(), colour, None);
        let to = |target: Option<usize>| (target.map_or(String::new(), |c| format!("Cue {}", c + 1)), BRIGHT, Some(target));
        match cues.slf(cue_index) {
            Some(Slf::Start { next }) => rows.push(Row::linked("S/L/F", vec![word("Start →", ORANGE), to(cues.find(next))])),
            Some(Slf::Loop { outro }) => rows.push(Row::linked("S/L/F", vec![word("Loop ↩", ORANGE), to(cues.find(outro))])),
            Some(Slf::Finish { from }) => rows.push(Row::linked("S/L/F", vec![word("Finish ←", ORANGE), to(from.first().copied())])),
            Some(Slf::Bridge { from, next }) => rows.push(Row::linked("S/L/F", vec![word("Bridge ←", ORANGE), to(from.first().copied()), word("→", ORANGE), to(cues.find(next))])),
            None => {}
        }
        if let Some(auto) = cue.auto_trigger() {
            let text = match (auto.when, crate::lang::english()) {
                (AutoWhen::At(at), true) => format!("automatically at {at} s into"),
                (AutoWhen::At(at), false) => format!("automatisch bei {at} s in"),
                (AutoWhen::Delay(delay), true) => format!("automatically {delay} s after"),
                (AutoWhen::Delay(delay), false) => format!("automatisch {delay} s nach"),
            };
            rows.push(Row::linked("Auto", vec![word(&text, PURPLE), to(cues.find(auto.source))]));
        }
        if let Some(adjust) = cue.adjust() {
            let target = to(cues.find(adjust.target));
            let seconds = adjust.fadetime.map_or(String::new(), |s| format!(" ({s} s)"));
            rows.push(Row::linked("⇢", match (adjust.fadeout, adjust.volume) {
                (true, _) if crate::lang::english() => vec![word("fade out", GREEN), target, word(seconds.trim(), MUTED)],
                (true, _) => vec![target, word(&format!("ausfaden{seconds}"), GREEN)],
                (false, Some(v)) => vec![target, word(&format!("{} {} %{seconds}", t("auf", "to"), (v * 100.0).round()), GREEN)],
                _ => vec![target],
            }));
        }
        // What the cue sends: one row per device, saying what goes there.
        let mut sends: Vec<(&'static str, String, Vec<String>)> = Vec::new();
        let mut add = |kind: &'static str, device: &str, message: String| match sends.iter_mut().find(|(k, d, _)| *k == kind && d == device) {
            Some(entry) => entry.2.push(message),
            None => sends.push((kind, device.to_string(), vec![message])),
        };
        for effect in cue.fire_effects() {
            match effect {
                Effect::Midi { device, bytes, .. } => add("MIDI", &device, midi_text(&bytes)),
                Effect::Osc { device, path, args } => {
                    let args: Vec<String> = args.iter().map(|arg| match arg {
                        mdstage_core::effects::OscArg::Int(i) => i.to_string(),
                        mdstage_core::effects::OscArg::Float(f) => f.to_string(),
                        mdstage_core::effects::OscArg::Text(text) => format!("\"{text}\""),
                    }).collect();
                    add("OSC", &device, clip(&format!("{path} {}", args.join(" ")), 60));
                }
                Effect::Http { device, method, path, .. } => add("HTTP", &device, clip(&format!("{method} {path}"), 60)),
                Effect::Announce { device, text } => add(t("Ansage", "Announce"), &device, clip(&format!("\"{text}\""), 60)),
                _ => {}
            }
        }
        if let Some(list) = cue.yaml.get("cue_display").and_then(|v| v.as_sequence()) {
            for message in list {
                let Some(device) = message.get("device").and_then(|d| d.as_str()) else { continue };
                let shown = message.get("markdown").and_then(|m| m.as_str()).and_then(|m| m.lines().map(|l| l.trim_start_matches('#').trim()).find(|l| !l.is_empty()));
                match shown {
                    Some(line) => add("Display", device, clip(line, 60)),
                    // Neither content nor an announcement: the display is cleared.
                    None if message.get("announce").is_none() => add("Display", device, t("leeren", "clear").to_string()),
                    None => {}
                }
            }
        }
        // A device can be given a colour where the show file declares it.
        let declared = cx.script.config().and_then(|c| c.get("outputDevices")).and_then(|d| d.as_sequence()).cloned().unwrap_or_default();
        for (kind, device, messages) in sends {
            let entry = declared.iter().find(|d| d.get("name").and_then(|n| n.as_str()) == Some(device.as_str()));
            let colour = named(entry.and_then(|d| d.get("color")).and_then(|c| c.as_str())).unwrap_or(YELLOW);
            let mut spans = vec![(device, colour)];
            spans.extend(messages.into_iter().enumerate().map(|(i, message)| (if i > 0 { format!("· {message}") } else { message }, TEXT)));
            rows.push(Row::plain(kind, spans));
        }
        rows
    }

    /// Set a row's spans one after the other from `left`, going to a new line where the
    /// next would cross `right` (and breaking inside a span that is longer than a line).
    /// With a painter they are drawn; either way the number of lines used comes back.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn flow_spans(ui: &Ui, painter: Option<&egui::Painter>, spans: &[Span], font: &FontId, left: f32, right: f32, top: f32, line: f32) -> usize {
        Self::flow(ui, painter, spans, font, left, right, top, line, None)
    }

    /// As `flow_spans`; `places` is given where each span was set.
    #[allow(clippy::too_many_arguments)]
    fn flow(ui: &Ui, painter: Option<&egui::Painter>, spans: &[Span], font: &FontId, left: f32, right: f32, top: f32, line: f32, mut places: Option<&mut Vec<Rect>>) -> usize {
        let width = (right - left).max(60.0);
        let (mut x, mut lines) = (left, 1usize);
        for (text, colour) in spans {
            let galley = ui.fonts(|f| f.layout_job(LayoutJob::simple(text.clone(), font.clone(), *colour, width)));
            let rows = galley.rows.len().max(1);
            if (rows > 1 || x + galley.size().x > left + width) && x > left {
                lines += 1;
                x = left;
            }
            let place = pos2(x, top + (lines - 1) as f32 * line);
            if let Some(places) = places.as_deref_mut() {
                places.push(Rect::from_min_size(place, galley.size()));
            }
            if let Some(painter) = painter {
                painter.galley(place, galley.clone(), *colour);
            }
            x += galley.size().x + 8.0;
            if rows > 1 {
                // A span that took several lines: what follows starts below it.
                lines += rows - 1;
                x = left + width + 1.0;
            }
        }
        lines
    }

    /// How many lines a cue's rows take when its panel is `width` wide.
    fn cue_lines(ui: &Ui, rows: &[Row], width: f32) -> usize {
        let font = FontId::proportional(15.0);
        rows.iter().map(|row| Self::flow_spans(ui, None, &row.spans, &font, 0.0, width - 16.0 - 56.0 - 12.0, 0.0, ROW)).sum()
    }

    /// The position auto-cues that hang on a cue's audio, in the order of their places:
    /// `(cue, seconds)`.
    fn position_autos(cues: &Cues, note: Option<Note>) -> Vec<(usize, f64)> {
        let Some(note) = note else { return Vec::new() };
        let mut autos: Vec<(usize, f64)> = (0..cues.len())
            .filter_map(|target| match cues.get(target)?.auto_trigger().filter(|a| a.source == note)?.when {
                AutoWhen::At(at) => Some((target, at)),
                AutoWhen::Delay(_) => None,
            })
            .collect();
        autos.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        autos
    }

    /// `autos`: how many position auto-cues hang on the cue's audio. Each gets a strip
    /// of its own under the waveform for its line to run out in.
    fn cue_height(rows: usize, has_audio: bool, autos: usize) -> f32 {
        let names = if autos > 0 { AUTO_NAMES } else { 0.0 };
        let wave = if has_audio { names + WAVE_HEIGHT + 10.0 + autos as f32 * AUTO_STRIP + CONTROLS + 4.0 } else { 0.0 };
        8.0 + 10.0 + ROW + rows as f32 * ROW + wave + 10.0
    }

    /// Room above and below a heading: a new scene stands clear of what came before.
    fn heading_room(block: &Block) -> (f32, f32) {
        match block {
            Block::Heading { level: 1, .. } => (22.0, 10.0),
            Block::Heading { level: 2, .. } => (12.0, 2.0),
            Block::Heading { .. } => (6.0, 0.0),
            _ => (0.0, 0.0),
        }
    }

    /// Measure every block for the given width. Runs once per width change or edit.
    fn measure(&mut self, ui: &Ui, cx: &Context, width: f32) {
        let editing = self.editing.as_ref().map(|e| e.index);
        let blocks = &cx.script.blocks;
        self.heights.resize(blocks.len(), 0.0);
        self.numbers = Self::scene_numbers(cx.script);
        self.lines = cx.script.block_lines();
        self.cue_of_block = vec![None; blocks.len()];
        self.block_of_cue.clear();
        for (i, block) in blocks.iter().enumerate() {
            if let Block::Cue(_) = block {
                self.cue_of_block[i] = Some(self.block_of_cue.len());
                self.block_of_cue.push(i);
            }
        }
        for (i, block) in blocks.iter().enumerate() {
            if editing == Some(i) {
                continue; // the editor reports its own height while open
            }
            self.heights[i] = match block {
                Block::Config(_) => 0.0,
                Block::Cue(cue) => {
                    let rows = Self::cue_rows(cx, i, self.cue_of_block[i].unwrap_or(0), cue, &self.durations);
                    let autos = Self::position_autos(&Cues::new(cx.script), cue.note()).len();
                    Self::cue_height(Self::cue_lines(ui, &rows, width), cue.audio().is_some(), autos)
                }
                block => {
                    let job = Self::job(cx.cast, block, width, self.numbers.get(i).copied().flatten()).unwrap_or_default();
                    let (above, below) = Self::heading_room(block);
                    ui.fonts(|f| f.layout_job(job)).size().y + 2.0 * BLOCK_PAD + above + below
                }
            };
        }
        self.layout_width = width;
        self.reflow();
        self.headings = blocks
            .iter()
            .enumerate()
            .filter_map(|(i, block)| match block {
                // A scene's number goes with its title wherever the title is shown.
                Block::Heading { level, text } if *level <= 3 => Some((i, *level, match self.numbers.get(i).copied().flatten() {
                    Some(number) => format!("{number}  {text}"),
                    None => text.clone(),
                })),
                _ => None,
            })
            .collect();
        self.dirty = false;
    }

    fn reflow(&mut self) {
        self.offsets.clear();
        let mut y = 0.0;
        for h in &self.heights {
            self.offsets.push(y);
            y += h;
        }
        self.offsets.push(y);
    }

    pub fn show(&mut self, ui: &mut Ui, cx: &Context, actions: &mut Vec<Action>) {
        if let Some(waveforms) = &mut self.waveforms {
            waveforms.poll();
        }
        self.hovered_before = self.hovered.take();
        self.auto_anchors.clear();
        if self.dirty || self.heights.len() != cx.script.blocks.len() {
            self.relate(cx.script);
        }
        // The margin holds the connection lines and, if wanted, the line numbers.
        let rail = self.rail();
        let margin = MARGIN + rail + if cx.line_numbers { 30.0 } else { 0.0 };
        let width = (ui.available_width() - margin - MARGIN).max(200.0);
        if self.dirty || self.heights.len() != cx.script.blocks.len() || (width - self.layout_width).abs() > 0.5 {
            self.measure(ui, cx, width);
        }
        let total = self.offsets.last().copied().unwrap_or(0.0);
        let mut area = egui::ScrollArea::vertical().auto_shrink([false, false]);
        // The view glides to where it is sent instead of jumping, so that the eye can
        // follow. Scrolling by hand takes over at once.
        if let Some(target) = self.scroll_to {
            let height = ui.available_height();
            let target = target.clamp(0.0, (total + 200.0 - height).max(0.0));
            let by_hand = ui.input(|i| i.raw_scroll_delta.y != 0.0 || i.pointer.any_pressed());
            let gap = target - self.scroll_y;
            if by_hand {
                self.scroll_to = None;
            } else if gap.abs() < 1.0 {
                area = area.vertical_scroll_offset(target);
                self.scroll_to = None;
            } else {
                // From far away the glide begins a screen and a half before the place.
                let from = if gap.abs() > 1.5 * height { target - gap.signum() * 1.5 * height } else { self.scroll_y };
                let dt = ui.input(|i| i.stable_dt).min(0.05);
                let step = (target - from) * (1.0 - (-dt * 12.0).exp());
                let step = if step.abs() < 2.0 { (target - from).signum() * (target - from).abs().min(2.0) } else { step };
                area = area.vertical_scroll_offset(from + step);
                ui.ctx().request_repaint();
            }
        }
        let output = area.show_viewport(ui, |ui, viewport| {
            ui.set_height(total + 200.0);
            ui.set_width(ui.available_width());
            let origin = ui.min_rect().min + vec2(margin, 0.0);
            let first = self.offsets.partition_point(|&o| o <= viewport.min.y).saturating_sub(1);
            for i in first..cx.script.blocks.len() {
                if self.offsets[i] > viewport.max.y {
                    break;
                }
                let rect = Rect::from_min_size(origin + vec2(0.0, self.offsets[i]), vec2(width, self.heights[i]));
                if let Some(line) = self.lines.get(i).filter(|_| cx.line_numbers && self.heights[i] > 0.0) {
                    let top = if matches!(cx.script.blocks[i], Block::Cue(_)) { 14.0 } else { BLOCK_PAD + 4.0 };
                    let top = top + Self::heading_room(&cx.script.blocks[i]).0;
                    ui.painter().text(pos2(rect.left() - 10.0 - rail, rect.top() + top), Align2::RIGHT_TOP, line.to_string(), FontId::monospace(11.0), WAVE_DIM);
                }
                self.draw_block(ui, cx, i, rect, actions);
            }
            self.draw_relations(ui, origin, viewport);
            self.drawn_at = Some((origin, ui.clip_rect()));
            self.drop_line(ui, cx, origin, width);
            self.jump_to_typed_scene(ui);
            if !cx.locked && self.editing.is_none() && self.picking.is_none() {
                self.insert_zones(ui, cx, origin, viewport, actions);
            }
        });
        self.scroll_y = output.state.offset.y;
    }

    fn draw_block(&mut self, ui: &mut Ui, cx: &Context, index: usize, rect: Rect, actions: &mut Vec<Action>) {
        if self.editing.as_ref().is_some_and(|e| e.index == index) {
            self.draw_editor(ui, cx, index, rect, actions);
            return;
        }
        let block = &cx.script.blocks[index];
        if let Block::Cue(cue) = block {
            self.draw_cue(ui, cx, index, cue, rect, actions);
            return;
        }
        let Some(job) = Self::job(cx.cast, block, rect.width(), self.numbers.get(index).copied().flatten()) else { return };
        let response = ui.interact(rect, Id::new(("block", index)), Sense::click());
        let shift = ui.input(|i| i.modifiers.shift);
        if let Some(search) = &self.search {
            if search.hits.contains(&index) {
                let current = search.hits.get(search.current) == Some(&index);
                let colour = if current { Color32::from_rgb(0x5c, 0x4a, 0x1e) } else { Color32::from_rgb(0x3a, 0x35, 0x26) };
                ui.painter().rect_filled(rect.expand2(vec2(8.0, 0.0)), 4.0, colour);
            }
        }
        if response.hovered() && shift && !cx.locked {
            ui.painter().rect_filled(rect.expand2(vec2(8.0, 0.0)), 4.0, PANEL);
        }
        let galley = ui.fonts(|f| f.layout_job(job));
        let (above, below) = Self::heading_room(block);
        ui.painter().galley(rect.min + vec2(0.0, BLOCK_PAD + above), galley, TEXT);
        if matches!(block, Block::Heading { level: 1, .. }) {
            // A fine line closes a scene's heading off from its text.
            ui.painter().hline(rect.x_range(), rect.bottom() - below / 2.0, Stroke::new(1.0_f32, BORDER));
        }
        if response.clicked() && shift && !cx.locked {
            self.edit(cx.script, index, false);
        }
        if !cx.locked {
            response.context_menu(|ui| {
                if ui.button(t("Bearbeiten", "Edit")).clicked() {
                    self.edit(cx.script, index, false);
                    ui.close_menu();
                }
                Self::block_menu(ui, cx, index, actions);
            });
        }
    }

    /// Between any two blocks, at the left edge: a "+" that shows when the pointer is
    /// there. A click adds a text block at that place, Shift+click a cue; with a cue on
    /// the clipboard there is a paste button beside it.
    fn insert_zones(&mut self, ui: &mut Ui, cx: &Context, origin: egui::Pos2, viewport: Rect, actions: &mut Vec<Action>) {
        let blocks = &cx.script.blocks;
        // Nothing goes before the config block.
        let first = if matches!(blocks.first(), Some(Block::Config(_))) { 1 } else { 0 };
        let shift = ui.input(|i| i.modifiers.shift);
        for at in first..=blocks.len() {
            let y = self.offsets.get(at).copied().unwrap_or(0.0);
            if y < viewport.min.y - 20.0 || y > viewport.max.y + 20.0 {
                continue;
            }
            let zone = Rect::from_min_size(pos2(origin.x - 22.0, origin.y + y - 11.0), vec2(if cx.can_paste { 78.0 } else { 46.0 }, 22.0));
            let response = ui.interact(zone, Id::new(("insert", at)), Sense::hover());
            if !response.hovered() && !ui.rect_contains_pointer(zone) {
                continue;
            }
            let button = Rect::from_center_size(pos2(origin.x - 6.0, origin.y + y), vec2(20.0, 20.0));
            let plus = ui.interact(button, Id::new(("insert-button", at)), Sense::click());
            let colour = if shift { BLUE } else { GREEN };
            ui.painter().circle_filled(button.center(), 10.0, if plus.hovered() { colour } else { colour.gamma_multiply(0.8) });
            ui.painter().text(button.center(), Align2::CENTER_CENTER, "+", FontId::proportional(16.0), Color32::BLACK);
            let plus = plus.on_hover_text(t("Klick: Text hier einfügen · Shift+Klick: Cue hier einfügen", "Click: insert text here · Shift+click: insert a cue here"));
            if plus.clicked() {
                actions.push(if shift { Action::NewCue(at) } else { Action::NewText(at) });
            }
            if cx.can_paste {
                let paste = Rect::from_center_size(pos2(origin.x + 22.0, origin.y + y), vec2(26.0, 20.0));
                let response = ui.interact(paste, Id::new(("insert-paste", at)), Sense::click());
                ui.painter().rect_filled(paste, 10.0, Color32::from_rgb(0x56, 0xb6, 0xc2).gamma_multiply(if response.hovered() { 1.0 } else { 0.8 }));
                Icon::Paste.image(14.0, Color32::BLACK).paint_at(ui, Rect::from_center_size(paste.center(), vec2(14.0, 14.0)));
                if response.on_hover_text(t("Kopierten Cue hier einfügen", "Paste the copied cue here")).clicked() {
                    actions.push(Action::Paste(at));
                }
            }
        }
    }

    /// Audio files are being dragged over the window at this point (or not at all).
    pub fn show_drop_line(&mut self, at: Option<egui::Pos2>) {
        self.drop_at = at;
    }

    /// The line across the script at the place where files dragged over it would be
    /// put in as cues.
    fn drop_line(&self, ui: &Ui, cx: &Context, origin: egui::Pos2, width: f32) {
        let Some(at) = self.drop_at.and_then(|point| self.insert_index_at(point, cx.script)) else { return };
        let y = origin.y + self.offsets.get(at).copied().unwrap_or(0.0);
        let painter = ui.painter();
        painter.hline(origin.x - 14.0..=origin.x + width, y, Stroke::new(3.0_f32, GREEN));
        painter.circle_filled(pos2(origin.x - 14.0, y), 5.0, GREEN);
        let label = painter.layout_no_wrap(t("Hier als Cue einfügen", "Insert as a cue here").to_string(), FontId::proportional(12.0), Color32::BLACK);
        let plate = Rect::from_min_size(pos2(origin.x + 8.0, y - 10.0), label.size() + vec2(12.0, 4.0));
        painter.rect_filled(plate, 4.0, GREEN);
        painter.galley(plate.min + vec2(6.0, 2.0), label, Color32::BLACK);
    }

    /// The place between two blocks nearest to a point on the screen, as the index a
    /// new block would get there. `None` if the point is not on the script.
    pub fn insert_index_at(&self, point: egui::Pos2, script: &Script) -> Option<usize> {
        let (origin, shown) = self.drawn_at?;
        if !shown.contains(point) || self.offsets.len() != script.blocks.len() + 1 {
            return None;
        }
        let y = point.y - origin.y;
        // Before the first block whose middle lies below the point.
        let at = (0..script.blocks.len()).find(|&i| self.offsets[i] + self.heights[i] / 2.0 > y).unwrap_or(script.blocks.len());
        Some(at.max(if matches!(script.blocks.first(), Some(Block::Config(_))) { 1 } else { 0 }))
    }

    /// The menu entries every block has: insert around it, move it, delete it.
    fn block_menu(ui: &mut Ui, cx: &Context, index: usize, actions: &mut Vec<Action>) {
        let mut pick = |ui: &mut Ui, label: &str, action: Action| {
            if ui.button(label).clicked() {
                actions.push(action);
                ui.close_menu();
            }
        };
        ui.separator();
        pick(ui, t("Text davor einfügen", "Insert text before"), Action::NewText(index));
        pick(ui, t("Text danach einfügen", "Insert text after"), Action::NewText(index + 1));
        pick(ui, t("Cue davor einfügen…", "Insert cue before…"), Action::NewCue(index));
        pick(ui, t("Cue danach einfügen…", "Insert cue after…"), Action::NewCue(index + 1));
        if cx.can_paste {
            pick(ui, t("Kopierten Cue davor einfügen", "Paste copied cue before"), Action::Paste(index));
            pick(ui, t("Kopierten Cue danach einfügen", "Paste copied cue after"), Action::Paste(index + 1));
        }
        ui.separator();
        pick(ui, t("Nach oben", "Move up"), Action::Move { block: index, up: true });
        pick(ui, t("Nach unten", "Move down"), Action::Move { block: index, up: false });
        pick(ui, t("Löschen", "Delete"), Action::Delete(index));
        if cx.has_editor {
            ui.separator();
            pick(ui, t("Im Texteditor öffnen", "Open in the text editor"), Action::OpenInEditor(index));
        }
    }

    /// Role name completing what has been typed so far: `(full name, missing rest)`.
    /// The block that text typed into the editor makes. Text with nothing to mark it
    /// (no `#` for a heading, no `**Name**` for a role) is a stage direction: the show
    /// file has no other use for a bare paragraph.
    fn typed_block(buffer: &str) -> Option<Block> {
        // Lines with nothing on them (or only spaces) are dropped, as is space at the edges.
        // (So are the bare asterisks left when all of a role block's names were taken out.)
        let lines: Vec<&str> = buffer.lines().map(str::trim).filter(|line| !line.is_empty() && *line != "****").collect();
        match Script::parse(&lines.join("\n")).blocks.into_iter().next()? {
            // An asterisk inside would end the direction early when the file is read again.
            Block::Text(text) if !text.contains('*') && !text.trim().is_empty() => Some(Block::Stage(text.trim().to_string())),
            block => Some(block),
        }
    }

    /// The role names of a block being typed whose text is still empty or one word:
    /// `(names, what is typed after them)`.
    fn role_header(buffer: &str) -> Option<(Vec<&str>, &str)> {
        let (names, typed) = buffer.strip_prefix("**")?.split_once("**\n")?;
        (!names.is_empty() && !typed.contains(['\n', ' '])).then(|| (names.split('/').collect(), typed))
    }

    /// The role or group name that the line the cursor is at the end of begins:
    /// `(name, the letters still missing)`. Offered in the first line of a block that
    /// has no role yet, and in the line right below a role's names (for a further role) —
    /// whether or not text follows further down.
    fn completion(cast: &Cast, buffer: &str, cursor: usize) -> Option<(String, String)> {
        let lines: Vec<&str> = buffer.split('\n').collect();
        let mut start = 0;
        let (line, typed) = lines.iter().enumerate().find_map(|(line, text)| {
            let end = start + text.chars().count();
            let here = (cursor == end).then_some((line, *text));
            start = end + 1;
            here
        })?;
        let names = vim::role_names(&lines[0].chars().collect::<Vec<_>>()).map(|_| lines[0][2..lines[0].len() - 2].split('/').collect::<Vec<_>>());
        let taken = match (names, line) {
            (None, 0) if !typed.starts_with(['#', '*']) => Vec::new(),
            (Some(names), 1) => names,
            _ => return None,
        };
        if typed.trim().is_empty() {
            return None;
        }
        let lower = typed.to_lowercase();
        let name = cast.roles.iter().map(|r| &r.name).chain(cast.groups.iter().map(|g| &g.name)).find(|n| n.to_lowercase().starts_with(&lower) && !taken.contains(&n.as_str()))?;
        let rest: String = name.chars().skip(typed.chars().count()).collect();
        Some((name.clone(), rest))
    }

    /// Take the completion: the name becomes the block's role, or joins the roles it has.
    /// Returns the text and where the cursor goes — to an empty line below the names,
    /// where a further role or the text can be typed.
    fn complete(buffer: &str, name: &str) -> (String, usize) {
        let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
        if vim::role_names(&lines[0].chars().collect::<Vec<_>>()).is_some() {
            let names = lines[0][..lines[0].len() - 2].to_string();
            lines[0] = format!("{names}/{name}**");
            lines[1] = String::new();
        } else {
            lines[0] = format!("**{name}**");
            lines.insert(1, String::new());
        }
        (lines.join("\n"), lines[0].chars().count() + 1)
    }

    fn draw_editor(&mut self, ui: &mut Ui, cx: &Context, index: usize, rect: Rect, actions: &mut Vec<Action>) {
        let Some(mut editing) = self.editing.take() else { return };
        let id = Id::new("block-editor");

        let cursor = egui::TextEdit::load_state(ui.ctx(), id).and_then(|state| state.cursor.char_range()).map(|range| range.primary.index);
        let is_text = |i: usize| !matches!(cx.script.blocks.get(i), Some(Block::Cue(_) | Block::Config(_)) | None);
        let above = (0..index).rev().find(|&i| is_text(i));
        let below = (index + 1..cx.script.blocks.len()).find(|&i| is_text(i));

        // Vim keys come first: in normal mode they take every key, in insert mode Escape.
        let mut vim_outcome = vim::Outcome::Stay;
        let mut vim_cursor = None;
        // (Not while the keyboard belongs to a field elsewhere, such as a dialog's.)
        let elsewhere = ui.memory(|m| m.focused()).is_some_and(|focused| focused != id);
        if cx.vim && !elsewhere {
            if !editing.focused {
                let keep = std::mem::take(&mut self.vim_keep_mode).then_some(self.vim.mode);
                self.vim.begin(keep.unwrap_or(if editing.fresh { vim::Mode::Insert } else { vim::Mode::Normal }));
            }
            // The text field's cursor is still the previous block's on the first frame.
            let cursor = cursor.filter(|_| editing.focused);
            let mut keys = Vec::new();
            let normal = self.vim.mode == vim::Mode::Normal;
            ui.input_mut(|i| {
                if !normal {
                    if i.consume_key(Modifiers::NONE, Key::Escape) {
                        keys.push(vim::Key::Escape);
                    }
                    return;
                }
                i.events.retain(|event| match event {
                    egui::Event::Text(text) => {
                        keys.extend(text.chars().map(vim::Key::Char));
                        false
                    }
                    // Shortcuts with Cmd/Ctrl (copy, select all, …) stay the text field's.
                    egui::Event::Key { modifiers, .. } if modifiers.command || modifiers.ctrl => true,
                    egui::Event::Key { key, pressed, .. } => {
                        let known = match key {
                            Key::Escape => Some(vim::Key::Escape),
                            Key::Enter => Some(vim::Key::Enter),
                            Key::Backspace => Some(vim::Key::Backspace),
                            Key::ArrowLeft => Some(vim::Key::Char('h')),
                            Key::ArrowRight => Some(vim::Key::Char('l')),
                            Key::ArrowUp => Some(vim::Key::Char('k')),
                            Key::ArrowDown => Some(vim::Key::Char('j')),
                            _ => None,
                        };
                        keys.extend(known.filter(|_| *pressed));
                        false
                    }
                    egui::Event::Paste(_) | egui::Event::Cut => false,
                    _ => true,
                });
            });
            // Where the cursor starts in a block just opened: at its top, or on its last
            // line when it was reached from below; behind the text of a new block.
            let length = editing.buffer.chars().count();
            if cursor.is_none() {
                self.vim_came_from_below = self.vim_from_below;
            }
            let mut at = cursor.unwrap_or_else(|| match (editing.fresh, std::mem::take(&mut self.vim_from_below)) {
                (true, _) => length,
                (false, true) => editing.buffer.rfind('\n').map_or(0, |newline| editing.buffer[..=newline].chars().count()),
                (false, false) => 0,
            });
            // A `5j` that ran out of block in the one before goes on here.
            if cursor.is_none() {
                let rest = std::mem::take(&mut self.vim.carry);
                let direction = if self.vim_came_from_below { 'k' } else { 'j' };
                keys.splice(0..0, std::iter::repeat_n(vim::Key::Char(direction), rest));
            }
            for key in &keys {
                vim_outcome = self.vim.key(*key, &mut editing.buffer, &mut at);
                if vim_outcome != vim::Outcome::Stay {
                    break;
                }
            }
            if !keys.is_empty() || cursor.is_none() {
                let mut state = egui::TextEdit::load_state(ui.ctx(), id).unwrap_or_default();
                state.cursor.set_char_range(Some(CCursorRange::one(CCursor::new(at))));
                state.store(ui.ctx(), id);
            }
            if let Some(text) = self.vim.copied.take() {
                ui.ctx().copy_text(text);
            }
            vim_cursor = (self.vim.mode == vim::Mode::Normal).then_some(at);
        }

        // Keys the editor handles itself must be taken before the text field sees them.
        let tab = ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Tab));
        let mut commit = ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter));
        let mut cancel = !cx.vim && ui.input(|i| i.key_pressed(Key::Escape));
        // Arrow up on the first line and arrow down on the last leave for the text block
        // above or below.
        let before: String = editing.buffer.chars().take(cursor.unwrap_or(0)).collect();
        let after: String = editing.buffer.chars().skip(cursor.unwrap_or(0)).collect();
        let mut leave = if cursor.is_some() && !before.contains('\n') && ui.input(|i| i.key_pressed(Key::ArrowUp)) {
            above
        } else if cursor.is_some() && !after.contains('\n') && ui.input(|i| i.key_pressed(Key::ArrowDown)) {
            below
        } else {
            None
        };
        // What a Vim key asked for beyond the text.
        let (mut close, mut open_above, mut delete_block) = (false, false, false);
        // Moving the block (the arrow buttons, `gK`/`gJ`) and putting a copied one beside it.
        let mut moved: Option<bool> = None;
        let mut put: Option<usize> = None;
        match vim_outcome {
            vim::Outcome::MoveUp => moved = Some(true),
            vim::Outcome::MoveDown => moved = Some(false),
            vim::Outcome::YankBlock => self.vim_block = Self::typed_block(&editing.buffer),
            vim::Outcome::CutBlock => {
                self.vim_block = Self::typed_block(&editing.buffer);
                delete_block = true;
            }
            vim::Outcome::PasteBelow => put = self.vim_block.is_some().then_some(index + 1),
            vim::Outcome::PasteAbove => put = self.vim_block.is_some().then_some(index),
            vim::Outcome::Stay => {}
            vim::Outcome::Close => close = true,
            vim::Outcome::Discard => cancel = true,
            // `:q` only leaves a block that is as it was.
            vim::Outcome::Quit => close = Self::typed_block(&editing.buffer).as_ref() == cx.script.blocks.get(index),
            vim::Outcome::LeaveUp => {
                leave = above;
                self.vim_from_below = above.is_some();
            }
            vim::Outcome::LeaveDown => leave = below,
            vim::Outcome::OpenBelow => commit = true,
            vim::Outcome::OpenAbove => open_above = true,
            vim::Outcome::DeleteBlock => delete_block = true,
        }
        // In the line of a role block's names, Backspace and Delete take a whole role (the
        // only one: the whole line). The asterisks around the names cannot be picked apart.
        let typing = !(cx.vim && !elsewhere && self.vim.mode == vim::Mode::Normal);
        let range = egui::TextEdit::load_state(ui.ctx(), id).and_then(|state| state.cursor.char_range());
        if let Some(at) = range.filter(|r| typing && r.primary == r.secondary).map(|r| r.primary.index) {
            let mut text: Vec<char> = editing.buffer.chars().collect();
            let names_end = text.iter().position(|c| *c == '\n').unwrap_or(text.len());
            if vim::role_names(&text).is_some() && at <= names_end {
                let back = at > 0 && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Backspace));
                let forward = !back && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Delete));
                // Delete at the very end would pull the text up into the names: nothing happens.
                if back || (forward && at < names_end) {
                    let place = match vim::remove_role(&mut text, if back { at - 1 } else { at }) {
                        Some(place) => place,
                        None => {
                            text.drain(..(names_end + 1).min(text.len()));
                            0
                        }
                    };
                    editing.buffer = text.into_iter().collect();
                    let mut state = egui::TextEdit::load_state(ui.ctx(), id).unwrap_or_default();
                    state.cursor.set_char_range(Some(CCursorRange::one(CCursor::new(place))));
                    state.store(ui.ctx(), id);
                }
            }
        }
        // Backspace with nothing typed after the names takes the last name away again.
        if let Some((names, "")) = Self::role_header(&editing.buffer) {
            if cursor == Some(editing.buffer.chars().count()) && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Backspace)) {
                editing.buffer = match names.len() {
                    1 => String::new(),
                    n => format!("**{}**\n", names[..n - 1].join("/")),
                };
            }
        }
        // While nothing has been drawn yet the cursor is at the end of what is there.
        let typing_at = range.map_or(editing.buffer.chars().count(), |r| r.primary.index);
        if tab && typing {
            if let Some((name, _)) = Self::completion(cx.cast, &editing.buffer, typing_at) {
                let (text, place) = Self::complete(&editing.buffer, &name);
                editing.buffer = text;
                let mut state = egui::TextEdit::load_state(ui.ctx(), id).unwrap_or_default();
                state.cursor.set_char_range(Some(CCursorRange::one(CCursor::new(place))));
                state.store(ui.ctx(), id);
            }
        }

        // With Vim keys the mode is shown to the right of the field, which is that much narrower.
        let beside = ARROWS + if cx.vim { 70.0 } else { 0.0 };
        let field = Rect::from_min_size(rect.min + vec2(0.0, BLOCK_PAD), vec2(rect.width() - beside, 0.0));
        let mut child = ui.new_child(UiBuilder::new().max_rect(field));
        let before_typing = editing.buffer.clone();
        let range_before = egui::TextEdit::load_state(ui.ctx(), id).and_then(|state| state.cursor.char_range());
        let output = egui::TextEdit::multiline(&mut editing.buffer)
            .id(id)
            .font(FontId::proportional(17.0))
            .desired_width(rect.width() - beside)
            .desired_rows(1)
            .lock_focus(true)
            .show(&mut child);
        if !editing.focused {
            output.response.request_focus();
            editing.focused = true;
        }
        // Whatever else was typed or cut: if it left a role's names with their asterisks
        // damaged (one deleted, the text pulled up into the line), it did not happen. The
        // names may change and grow, and the whole line may go.
        if editing.buffer != before_typing && vim::role_names(&before_typing.chars().collect::<Vec<_>>()).is_some() {
            let now: Vec<char> = editing.buffer.chars().collect();
            let first = editing.buffer.lines().next().unwrap_or_default();
            let intact = vim::role_names(&now).is_some() || !(first.starts_with('*') || first.contains("**"));
            if !intact {
                editing.buffer = before_typing;
                let mut state = egui::TextEdit::load_state(ui.ctx(), id).unwrap_or_default();
                state.cursor.set_char_range(range_before);
                state.store(ui.ctx(), id);
                ui.ctx().request_repaint();
            }
        }
        // Beside the field: move the block one place up or down.
        for (up, y) in [(true, 0.0), (false, 20.0)] {
            let button = Rect::from_min_size(pos2(rect.right() - 22.0, rect.top() + BLOCK_PAD + y), vec2(22.0, 18.0));
            let response = ui.put(button, egui::Button::new(egui::RichText::new(if up { "▲" } else { "▼" }).size(10.0)).small());
            let hint = if up { t("Block nach oben verschieben", "Move the block up") } else { t("Block nach unten verschieben", "Move the block down") };
            if response.on_hover_text(hint).clicked() {
                moved = Some(up);
            }
        }
        if cx.vim {
            // The mode at the right edge; in normal mode a block cursor on its character.
            let normal = self.vim.mode == vim::Mode::Normal;
            // A command line being typed (`:w`) shows in the mode's place.
            let label = match (normal, self.vim.pending()) {
                (false, _) => "INSERT".to_string(),
                (true, pending) if pending.is_empty() => "NORMAL".to_string(),
                (true, pending) => pending,
            };
            ui.painter().text(pos2(rect.right() - ARROWS, rect.top() + BLOCK_PAD + 6.0), Align2::RIGHT_TOP, label, FontId::monospace(12.0), if normal { BLUE } else { GREEN });
            // Escape belongs to Vim here: without this the text field would give up the
            // keyboard on it. And a click anywhere else is how the editor is left.
            let filter = egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true };
            ui.memory_mut(|m| m.set_focus_lock_filter(id, filter));
            if output.response.clicked_elsewhere() && moved.is_none() {
                close = true;
            } else if editing.focused && !output.response.has_focus() && !elsewhere {
                output.response.request_focus();
            }
            if let Some(at) = vim_cursor {
                let here = output.galley.pos_from_cursor(&output.galley.from_ccursor(CCursor::new(at)));
                let next = output.galley.pos_from_cursor(&output.galley.from_ccursor(CCursor::new(at + 1)));
                let width = if (next.top() - here.top()).abs() < 1.0 && next.left() > here.left() { next.left() - here.left() } else { 9.0 };
                let block = Rect::from_min_size(output.galley_pos + here.left_top().to_vec2(), vec2(width, here.height().max(18.0)));
                child.painter().rect_filled(block, 1.0, BRIGHT.gamma_multiply(0.35));
            }
        }
        // The rest of a role name that Tab would complete, in grey behind the cursor.
        let now_at = output.cursor_range.map(|range| range.primary.ccursor.index).filter(|_| vim_cursor.is_none());
        if let Some((at, (_, rest))) = now_at.and_then(|at| Some((at, Self::completion(cx.cast, &editing.buffer, at)?))) {
            let end = output.galley.pos_from_cursor(&output.galley.from_ccursor(CCursor::new(at)));
            let pos = output.galley_pos + end.right_top().to_vec2();
            child.painter().text(pos, Align2::LEFT_TOP, format!("{rest}  Tab"), FontId::proportional(17.0), MUTED);
        }

        // At least as tall as the two move buttons beside the field.
        let height = child.min_rect().height().max(38.0) + 2.0 * BLOCK_PAD;
        if (height - self.heights[index]).abs() > 0.5 {
            self.heights[index] = height;
            self.reflow();
            ui.ctx().request_repaint();
        }

        if cancel {
            if editing.fresh {
                actions.push(Action::Delete(index));
            }
            self.dirty = true;
        } else if delete_block {
            // `dd` on a block's only line takes the block; go on in the one after it.
            actions.push(Action::Delete(index));
            if let Some(to) = below.map(|b| b - 1).or(above) {
                actions.push(Action::EditText(to));
            }
            self.dirty = true;
        } else if let (Some(up), Some(with)) = (moved, Self::typed_block(&editing.buffer)) {
            if cx.script.blocks.get(index) != Some(&with) {
                actions.push(Action::Replace { block: index, with });
            }
            // Entered again in its new place, the editor keeps the mode it is in.
            self.vim_keep_mode = cx.vim;
            actions.push(Action::MoveAndEdit { block: index, up });
            self.dirty = true;
        } else if let (Some(at), Some(with), Some(block)) = (put, Self::typed_block(&editing.buffer), self.vim_block.clone()) {
            if cx.script.blocks.get(index) != Some(&with) {
                actions.push(Action::Replace { block: index, with });
            }
            actions.push(Action::InsertAndEdit { at, block });
            self.dirty = true;
        } else if commit || close || open_above || leave.is_some() {
            // Whatever was typed becomes one block. With nothing left in the editor the
            // block goes: a new one that was left empty, or one whose text was all taken out.
            let mut removed = false;
            match Self::typed_block(&editing.buffer) {
                Some(with) => {
                    // A block that was only looked at is not written again.
                    if cx.script.blocks.get(index) != Some(&with) {
                        actions.push(Action::Replace { block: index, with });
                    }
                    // Enter (and `o`) carry on writing in a new block below, `O` above.
                    if commit {
                        actions.push(Action::NewText(index + 1));
                    } else if open_above {
                        actions.push(Action::NewText(index));
                    }
                }
                None => {
                    actions.push(Action::Delete(index));
                    removed = true;
                }
            }
            if let Some(to) = leave.filter(|_| !commit && !open_above && !close) {
                // With this block gone, the ones after it have moved up by one.
                actions.push(Action::EditText(if removed && to > index { to - 1 } else { to }));
            }
            self.dirty = true;
        } else {
            self.editing = Some(editing);
        }
    }

    fn draw_cue(&mut self, ui: &mut Ui, cx: &Context, block: usize, cue: &Cue, rect: Rect, actions: &mut Vec<Action>) {
        let cue_index = self.cue_of_block.get(block).copied().flatten().unwrap_or(0);
        let snapshot = cx.snapshot;
        let is_current = snapshot.current == Some(cue_index);
        let is_next = snapshot.next == Some(cue_index);
        let waits = snapshot.pending_outros.iter().any(|&(_, outro)| outro == cue_index);
        let status = snapshot.audio.iter().find(|(c, _)| *c == cue_index).map(|(_, s)| *s);
        let sounding = status.is_some_and(|s| matches!(s.state, mdstage_engine::clock::VoiceState::Playing | mdstage_engine::clock::VoiceState::Tail));
        let delay = snapshot.delays.iter().find(|d| d.target == cue_index).map(|d| d.fraction);

        let panel = rect.shrink2(vec2(0.0, 4.0));
        let response = ui.interact(panel, Id::new(("cue", block)), Sense::click());
        let painter = ui.painter().clone();
        let under_pointer = ui.rect_contains_pointer(panel);
        if under_pointer {
            self.hovered = Some(block);
        }
        painter.rect_filled(panel, 4.0, if response.hovered() { RAISED } else { PANEL });
        // The bar at the left edge says one thing, where the cue stands in the show, and
        // says it in the colour of the word beside the cue's number:
        // green = the operator's current cue, yellow = the next Go (or an outro waiting
        // for its loop), blue = its audio is playing, faint = done in this pass,
        // grey = still to come.
        let done = snapshot.done.contains(&cue_index);
        let (bar, thick) = match () {
            _ if is_current => (GREEN, true),
            _ if waits || is_next => (YELLOW, true),
            _ if sounding => (BLUE, true),
            _ if done => (BORDER, false),
            _ => (MUTED, false),
        };
        painter.rect_filled(Rect::from_min_size(panel.min, vec2(if thick { 6.0 } else { 3.0 }, panel.height())), 0.0, bar);
        let now = ui.input(|i| i.time);
        if let Some((_, since)) = self.flash.filter(|(flashed, since)| *flashed == block && now - since < FLASH) {
            // Just gone to from another cue: outlined, fading.
            let strength = (1.0 - (now - since) / FLASH) as f32;
            painter.rect_stroke(panel, 4.0, Stroke::new(2.0_f32, BRIGHT.gamma_multiply(strength)), egui::StrokeKind::Outside);
            ui.ctx().request_repaint();
        }
        if let Some(fraction) = delay {
            // A delay auto-cue counting down fills the panel from the left.
            let filled = Rect::from_min_size(panel.min, vec2(panel.width() * fraction as f32, panel.height()));
            painter.rect_filled(filled, 4.0, Color32::from_rgba_unmultiplied(0x98, 0xc3, 0x79, 28));
        }

        let left = panel.left() + 16.0;
        let mut y = panel.top() + 10.0;
        let font = FontId::proportional(15.0);
        let mut x = painter.text(pos2(left, y), Align2::LEFT_TOP, format!("Cue {}", cue_index + 1), FontId::proportional(16.0), if done && !is_current && !is_next && !sounding { MUTED } else { BRIGHT }).right() + 12.0;
        let mut badge = |text: &str, colour: Color32| {
            x = painter.text(pos2(x, y + 1.0), Align2::LEFT_TOP, text, FontId::proportional(13.0), colour).right() + 10.0;
        };
        if cue.is_variant() {
            badge(t("Variante", "Variant"), MUTED);
        }
        if is_current {
            badge(t("aktuell", "current"), GREEN);
        }
        if waits {
            badge(t("wartet auf Loop-Ende", "waiting for loop end"), YELLOW);
        } else if is_next {
            badge(t("nächster", "next"), YELLOW);
        }
        if sounding {
            badge(t("♪ läuft", "♪ playing"), BLUE);
        }
        if done && !is_current && !is_next && !waits {
            badge(t("erledigt", "done"), MUTED);
        }
        // The buttons show while the pointer is on the cue (or a connection is being set
        // up from it, or one of its menus is open); otherwise only the trigger note.
        let full = !cx.locked && (under_pointer || matches!(self.picking, Some((_, from)) if from == block) || (self.buttons_of == Some(block) && ui.memory(|m| m.any_popup_open())));
        if full {
            self.buttons_of = Some(block);
        }
        let top = panel.top() + 6.0;
        self.cue_buttons(ui, cx, block, cue_index, cue, full, Rect::from_min_max(pos2(x, top), pos2(panel.right() - 10.0, top + ROW + 4.0)), actions);
        self.learn_durations(cx, cue_index);
        y += ROW;
        let mut go_to = None;
        for row in Self::cue_rows(cx, block, cue_index, cue, &self.durations) {
            painter.text(pos2(left, y), Align2::LEFT_TOP, row.label, font.clone(), MUTED);
            // Long rows (many microphones, a long note) go on in further lines.
            let mut places = Vec::new();
            let lines = Self::flow(ui, Some(&painter), &row.spans, &font, left + 56.0, panel.right() - 12.0, y, ROW, Some(&mut places));
            // A reference to another cue is underlined; a click goes there.
            for (span, target) in row.links.into_iter().filter(|_| !cx.locked) {
                let Some(place) = places.get(span) else { continue };
                let link = ui.interact(place.expand(2.0), Id::new(("cue-link", block, row.label, span)), Sense::click());
                painter.hline(place.x_range(), place.bottom(), Stroke::new(1.0_f32, if link.hovered() { BRIGHT } else { MUTED }));
                if link.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                if link.on_hover_text(t("Zu diesem Cue gehen", "Go to this cue")).clicked() {
                    go_to = Some(target);
                }
            }
            y += lines as f32 * ROW;
        }
        if let Some(cue) = go_to {
            self.go_to_cue(cue, now);
        }
        if let Some(audio) = cue.audio() {
            let width = panel.right() - 12.0 - left;
            let part = &audio.parts[0];
            // Auto-cue markers are named in a line of their own above the waveform.
            let autos = Self::position_autos(&Cues::new(cx.script), cue.note()).len();
            let wave = Rect::from_min_size(pos2(left, y + 4.0 + if autos > 0 { AUTO_NAMES } else { 0.0 }), vec2(width, WAVE_HEIGHT));
            // The cursor only makes sense on the part whose waveform is shown.
            // A cue of several parts reports each part that sounds. On the waveform (which is
            // the first part's) the cursor runs while that part plays; once it has handed
            // over and only rings out, a ghost cursor goes on through its tail.
            use mdstage_engine::clock::VoiceState;
            let of_part = |part: usize, state: VoiceState| snapshot.audio.iter().find(|(c, s)| *c == cue_index && s.part == part && s.state == state).map(|(_, s)| s.seconds);
            let playing = of_part(0, VoiceState::Playing);
            let ghost = of_part(0, VoiceState::Tail);
            let position = playing.or(snapshot.paused.iter().find(|(c, _)| *c == cue_index).map(|(_, seconds)| *seconds));
            let duration = self.draw_waveform(ui, cx, block, cue_index, cue.note(), part, (position, ghost), playing.is_some(), wave, actions);
            let strips = autos as f32 * AUTO_STRIP;
            let row = Rect::from_min_size(pos2(left, wave.bottom() + 4.0 + strips), vec2(width, CONTROLS));
            // While a later part plays, the row says so instead of a position in this one.
            let later = snapshot.audio.iter().find(|(c, s)| *c == cue_index && s.part > 0 && s.state == VoiceState::Playing).map(|(_, s)| (s.part, s.seconds));
            self.draw_transport(ui, cx, (block, cue_index), part, audio.looped, sounding, (position, later), duration, row, actions);
        }
        match self.picking {
            // A connection is being set up: the click names its other end.
            Some((link, from)) => {
                if response.hovered() && from != block {
                    painter.rect_stroke(panel, 4.0, Stroke::new(2.0_f32, YELLOW), egui::StrokeKind::Inside);
                }
                if response.clicked() {
                    self.picking = None;
                    if from != block {
                        actions.push(Action::Picked { link, block: from, cue: cue_index });
                    }
                }
            }
            None if response.clicked() => actions.push(Action::Fire(cue_index)),
            None => {}
        }
        if cx.locked {
            // Under the show lock a cue can be clicked and nothing else.
            return;
        }
        response.context_menu(|ui| {
            let mut pick = |ui: &mut Ui, label: &str, action: Action| {
                if ui.button(label).clicked() {
                    actions.push(action);
                    ui.close_menu();
                }
            };
            pick(ui, t("Als nächsten Go scharf schalten", "Arm as the next Go"), Action::Arm(cue_index));
            if !cx.locked {
                pick(ui, t("Bearbeiten…", "Edit…"), Action::EditCue(block));
                pick(ui, t("Kopieren", "Copy"), Action::Copy(block));
                pick(ui, t("Variante anlegen", "Create variant"), Action::Variant(block));
                Self::block_menu(ui, cx, block, actions);
            }
        });
    }

    /// Ask for the lengths of the audio files the cues leading into this one play, so
    /// that its derived timecode can be worked out even while they are off screen.
    fn learn_durations(&mut self, cx: &Context, cue: usize) {
        let cues = Cues::new(cx.script);
        let (mut at, mut steps) = (cue, 0);
        while let Some(before) = Self::predecessor(&cues, at).filter(|_| steps < 8) {
            for file in cues.get(before).and_then(|c| c.audio()).into_iter().flat_map(|a| a.parts).flat_map(|p| p.audios) {
                if !self.durations.contains_key(&file.file) {
                    if let Some(WaveState::Ready { duration, .. }) = self.waveforms.as_mut().map(|w| w.get(&file.file)) {
                        self.durations.insert(file.file, duration);
                    }
                }
            }
            (at, steps) = (before, steps + 1);
        }
    }

    /// The buttons in a cue's top line, from the right: its trigger note, arm in the
    /// live view, edit, variant, and the connections to other cues.
    #[allow(clippy::too_many_arguments)]
    fn cue_buttons(&mut self, ui: &mut Ui, cx: &Context, block: usize, cue_index: usize, cue: &Cue, full: bool, rect: Rect, actions: &mut Vec<Action>) {
        let mut row = ui.new_child(UiBuilder::new().id_salt(("cue-buttons", block)).max_rect(rect).layout(egui::Layout::right_to_left(egui::Align::Center)));
        row.spacing_mut().item_spacing.x = 4.0;
        row.spacing_mut().button_padding = vec2(6.0, 1.0);
        if let Some(note) = cue.note() {
            row.label(RichText::new(note.to_string()).size(14.0).color(MUTED));
            row.add_space(4.0);
        }
        if !full {
            return;
        }
        let shift = row.input(|i| i.modifiers.shift);
        let small = |text: &str, colour: Color32| egui::Button::new(RichText::new(text).size(13.0).color(colour));
        let live = egui::Button::image_and_text(egui::Image::new(live_icon()).tint(TEXT).fit_to_exact_size(vec2(13.0, 13.0)), RichText::new("Live").size(13.0).color(TEXT));
        if row.add(live).on_hover_text(t("Live-Ansicht öffnen und diesen Cue als nächsten scharf schalten", "Open the live view with this cue armed as the next")).clicked() {
            actions.push(Action::ArmLive(cue_index));
        }
        if cx.locked || cue.invalid {
            return;
        }
        if row.add(egui::Button::image(Icon::Pencil.image(13.0, TEXT))).on_hover_text(t("Cue bearbeiten", "Edit cue")).clicked() {
            actions.push(Action::EditCue(block));
        }
        if row.add(small("⊕", TEXT)).on_hover_text(t("Als Variante duplizieren", "Duplicate as a variant")).clicked() {
            actions.push(Action::Variant(block));
        }

        // The connections: a click sets one up (then click the other cue), Shift+click
        // on one that exists removes it.
        let mut link_button = |row: &mut Ui, link: Link, text: &str, exists: bool, enabled: bool, hint: &str| {
            // In the colour of its kind once it exists, bright while its other end is being picked.
            let kind = if link == Link::AutoCue { PURPLE } else { GREEN };
            let colour = if self.picking == Some((link, block)) { BRIGHT } else if exists { kind } else { TEXT };
            let hint = if exists { format!("{hint}\n{}", t("Shift+Klick löscht.", "Shift+click removes it.")) } else { hint.to_string() };
            if row.add_enabled(enabled, small(text, colour)).on_hover_text(hint).clicked() {
                match exists && shift {
                    true => actions.push(Action::Unlink { link, block }),
                    false if self.picking == Some((link, block)) => self.picking = None,
                    false => self.picking = Some((link, block)),
                }
            }
        };
        let has_audio = cue.audio().is_some();
        link_button(&mut row, Link::AutoCue, "Auto-Cue", cue.auto_trigger().is_some(), true, t("Diesen Cue von selbst auslösen lassen: danach die Quelle anklicken.", "Let this cue fire by itself: then click its source."));
        link_button(&mut row, Link::Adjust, t("⇢ Bezug", "⇢ Adjust"), cue.adjust().is_some(), has_audio, t("Beim Auslösen das Audio eines anderen Cues ausfaden oder leiser stellen: danach den anderen Cue anklicken.", "On firing, fade out or turn down another cue's audio: then click that cue."));

        let slf = match Cues::new(cx.script).slf(cue_index) {
            Some(Slf::Start { .. }) => "Start",
            Some(Slf::Loop { .. }) => "Loop",
            Some(Slf::Finish { .. }) => "Finish",
            Some(Slf::Bridge { .. }) => "Bridge",
            None => "S/L/F",
        };
        let linked = cue.chain_end().is_some() || cue.loop_outro().is_some();
        let label = RichText::new(slf).size(13.0).color(if matches!(self.picking, Some((Link::Chain | Link::LoopOutro, b)) if b == block) { BRIGHT } else if slf != "S/L/F" { ORANGE } else { TEXT });
        row.add_enabled_ui(has_audio, |row| {
            row.menu_button(label, |ui| {
                if ui.button(t("Start: am Ende nahtlos weiter mit … (Cue anklicken)", "Start: at the end carry straight on with … (click a cue)")).clicked() {
                    self.picking = Some((Link::Chain, block));
                    ui.close_menu();
                }
                if ui.button(t("Loop: läuft, bis dieses Outro kommt … (Cue anklicken)", "Loop: runs until this outro comes … (click a cue)")).clicked() {
                    self.picking = Some((Link::LoopOutro, block));
                    ui.close_menu();
                }
                if ui.add_enabled(linked, egui::Button::new(t("Verbindung löschen", "Remove the connection"))).clicked() {
                    actions.push(Action::Unlink { link: Link::Chain, block });
                    ui.close_menu();
                }
            })
            .response
            .on_hover_text(t("Loop-Struktur einrichten (Start, Loop, Finish …)", "Set up a loop structure (start, loop, finish …)"));
        });

        let auto_mic = cue.auto_mic();
        let hint = if auto_mic { t("Auto-Mic ist an: Mikrofone kommen aus dem folgenden Text. Klick schaltet es aus.", "Auto mic is on: the microphones come from the text that follows. Click to switch it off.") } else { t("Auto-Mic: Mikrofone aus dem folgenden Rollentext bestimmen", "Auto mic: work out the microphones from the text that follows") };
        if row.add(small("Auto-Mic", if auto_mic { GREEN } else { TEXT })).on_hover_text(hint).clicked() {
            actions.push(Action::AutoMic { block, on: !auto_mic });
        }
    }

    /// The row under a waveform: play/pause, stop, zoom, loop and volume.
    #[allow(clippy::too_many_arguments)]
    fn draw_transport(
        &mut self,
        ui: &mut Ui,
        cx: &Context,
        (block, cue): (usize, usize),
        part: &Part,
        looped: bool,
        sounding: bool,
        (position, later): (Option<f64>, Option<(usize, f64)>),
        duration: Option<f64>,
        rect: Rect,
        actions: &mut Vec<Action>,
    ) {
        let mut row = ui.new_child(egui::UiBuilder::new().id_salt(("transport", block)).max_rect(rect).layout(egui::Layout::left_to_right(egui::Align::Center)));
        row.spacing_mut().item_spacing.x = 6.0;
        row.spacing_mut().button_padding = vec2(7.0, 2.0);
        row.spacing_mut().slider_width = 110.0;
        if cx.locked {
            // Under the show lock the row only shows; a click on it goes to the cue.
            row.disable();
        }
        let play_hint = if sounding { t("Pause", "Pause") } else { t("Nur das Audio dieses Cues abspielen", "Play this cue's audio by itself") };
        if row.add(egui::Button::image(if sounding { Icon::Pause } else { Icon::Play }.image(13.0, TEXT))).on_hover_text(play_hint).clicked() {
            actions.push(Action::PlayPause(cue));
        }
        if row.add(egui::Button::image(Icon::Stop.image(13.0, TEXT))).on_hover_text(t("Stopp und zurück zum Anfang", "Stop and return to the start")).clicked() {
            actions.push(Action::StopCue(cue));
        }

        row.add_space(6.0);
        let (zoom, view_start) = self.zoom.get(&block).copied().unwrap_or((1.0, 0.0));
        let mut zoomed = None;
        if row.add_enabled(zoom > 1.0, egui::Button::new("−")).on_hover_text(t("Herauszoomen", "Zoom out")).clicked() {
            zoomed = Some(zoom / 2.0);
        }
        if row.add_enabled(zoom < MAX_ZOOM, egui::Button::new("+")).on_hover_text(t("Hineinzoomen (seitlich scrollen verschiebt)", "Zoom in (scroll sideways to move)")).clicked() {
            zoomed = Some(zoom * 2.0);
        }
        if let (Some(new), Some(duration)) = (zoomed, duration) {
            // Keep the playback position in view, or else the middle of what was shown.
            let centre = position.unwrap_or(view_start + duration / zoom as f64 / 2.0);
            match new <= 1.0 {
                true => drop(self.zoom.remove(&block)),
                false => drop(self.zoom.insert(block, (new, centre - duration / new as f64 / 2.0))),
            }
        }

        row.add_space(6.0);
        if row.add_enabled(!cx.locked, egui::SelectableLabel::new(looped, "⟳")).on_hover_text("Loop").clicked() {
            actions.push(Action::Loop { block, on: !looped });
        }
        row.add_space(6.0);
        row.add(Icon::Speaker.image(15.0, MUTED));
        let mut volume = self.volumes.get(&block).copied().unwrap_or(part.volume);
        let slider = row.add_enabled(!cx.locked, egui::Slider::new(&mut volume, 0.0..=1.0).show_value(false));
        if slider.changed() {
            self.volumes.insert(block, volume);
            actions.push(Action::LiveVolume { cue, volume });
        }
        if slider.drag_stopped() || (slider.changed() && !slider.dragged()) {
            if let Some(volume) = self.volumes.remove(&block) {
                actions.push(Action::Volume { block, volume });
            }
        }
        row.label(egui::RichText::new(format!("{:.0} %", volume * 100.0)).size(13.0).color(MUTED));

        if let Some(duration) = duration {
            let clock = |seconds: f64| format!("{}:{:04.1}", (seconds / 60.0) as u32, seconds % 60.0);
            let text = match (position, later) {
                (_, Some((part, seconds))) => format!("{} {} · {}", t("Teil", "Part"), part + 1, clock(seconds)),
                (Some(position), None) => format!("{} / {}", clock(position), clock(duration)),
                (None, None) => clock(duration),
            };
            row.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| ui.label(egui::RichText::new(text).monospace().size(12.0).color(MUTED)));
        }
    }

    /// Draw a cue's waveform with its markers. A click moves the audio there; with Shift
    /// the markers can be dragged: start and end in the lower half, the fades in the upper.
    /// Returns the file's length once it is known.
    #[allow(clippy::too_many_arguments)]
    fn draw_waveform(
        &mut self,
        ui: &mut Ui,
        cx: &Context,
        block: usize,
        cue_index: usize,
        note: Option<Note>,
        part: &Part,
        (cursor, ghost): (Option<f64>, Option<f64>),
        playing: bool,
        rect: Rect,
        actions: &mut Vec<Action>,
    ) -> Option<f64> {
        let painter = ui.painter().with_clip_rect(rect);
        painter.rect_filled(rect, 3.0, BACKGROUND);
        let file = &part.audios[0].file;
        let state = self.waveforms.as_mut().map_or(WaveState::Failed, |w| w.get(file));
        let (peaks, duration) = match state {
            WaveState::Ready { peaks, duration } if duration > 0.0 => (peaks, duration),
            WaveState::Loading => {
                painter.text(rect.center(), Align2::CENTER_CENTER, t("lädt …", "loading …"), FontId::proportional(13.0), MUTED);
                return None;
            }
            _ => {
                painter.text(rect.center(), Align2::CENTER_CENTER, format!("{file}: {}", t("nicht lesbar", "unreadable")), FontId::proportional(13.0), RED);
                return None;
            }
        };
        if self.durations.insert(file.clone(), duration) != Some(duration) {
            // Derived timecodes further down may be known now.
            ui.ctx().request_repaint();
        }
        let end = part.end.unwrap_or(duration).min(duration);
        let saved = Marks { start: part.start.unwrap_or(0.0).min(end), end, fadein: part.fadein.unwrap_or(0.0), fadeout: part.fadeout.unwrap_or(0.0) };
        let mut marks = self.dragging.get(&block).copied().unwrap_or(saved);

        // The stretch of the file in view: all of it, unless zoomed in.
        // Under the show lock the waveform is only looked at: it takes no drag and no
        // scrolling, and a click on it goes to the cue like anywhere else on the card.
        let area = ui.interact(rect, Id::new(("wave", block)), if cx.locked { Sense::hover() } else { Sense::click_and_drag() });
        let (zoom, mut view_start) = self.zoom.get(&block).copied().unwrap_or((1.0, 0.0));
        let view_len = duration / zoom as f64;
        if zoom > 1.0 {
            // The view turns the page when the playback position walks out of it (or a
            // loop takes it back to the start) — but only if it was in view before. After
            // scrolling away by hand the view is left alone, so that a place further on
            // can be found and clicked while the audio plays.
            let in_view = |start: f64| cursor.is_some_and(|at| at >= start && at <= start + view_len);
            if playing && self.following.contains(&block) && !in_view(view_start) {
                view_start = cursor.unwrap_or(view_start) - 0.1 * view_len;
            }
            if area.hovered() && !cx.locked {
                view_start -= ui.input(|i| i.smooth_scroll_delta.x) as f64 / rect.width() as f64 * view_len;
            }
            view_start = view_start.clamp(0.0, duration - view_len);
            match in_view(view_start) {
                true => drop(self.following.insert(block)),
                false => drop(self.following.remove(&block)),
            }
            self.zoom.insert(block, (zoom, view_start));
        } else {
            view_start = 0.0;
        }
        let x_of = |t: f64| rect.left() + ((t - view_start) / view_len) as f32 * rect.width();
        let t_of = |x: f32| (view_start + ((x - rect.left()) / rect.width()).clamp(0.0, 1.0) as f64 * view_len).clamp(0.0, duration);

        let shift_held = ui.input(|i| i.modifiers.shift);
        let shift = shift_held && !cx.locked;
        // The playhead is moved by dragging: press on the waveform and move. A mere click
        // does nothing, so that the audio is not sent elsewhere by accident. The audio
        // follows when the button is let go.
        if area.dragged() && !shift_held {
            if let Some(pointer) = area.interact_pointer_pos() {
                self.scrubbing.insert(block, t_of(pointer.x));
            }
        }
        if area.drag_stopped() || (!area.dragged() && !area.is_pointer_button_down_on()) {
            if let Some(seconds) = self.scrubbing.remove(&block) {
                actions.push(Action::Seek { cue: cue_index, seconds });
            }
        }

        // The markers are only there to be taken hold of while Shift is held; otherwise
        // the whole waveform is free for moving the playhead. Letting go of Shift in the
        // middle of a drag ends it.
        if !shift {
            if let Some(marks) = self.dragging.remove(&block) {
                actions.push(Action::Markers { block, marks });
            }
        }
        // Markers first, so a drag in this frame already moves the shading.
        let quarter = rect.height() / 4.0;
        for which in (0..4).filter(|_| shift) {
            let (time, y) = match which {
                0 => (marks.start, rect.bottom() - quarter),
                1 => (marks.end, rect.bottom() - quarter),
                2 => (marks.start + marks.fadein, rect.top() + quarter),
                _ => (marks.end - marks.fadeout, rect.top() + quarter),
            };
            let handle = Rect::from_center_size(pos2(x_of(time), y), vec2(12.0, rect.height() / 2.0));
            let response = ui.interact(handle, Id::new(("marker", block, which)), Sense::drag());
            if shift && (response.hovered() || response.dragged()) {
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            }
            if shift && response.dragged() {
                if let Some(pointer) = response.interact_pointer_pos() {
                    let t = t_of(pointer.x);
                    match which {
                        0 => marks.start = t.min(marks.end),
                        1 => marks.end = t.max(marks.start),
                        2 => marks.fadein = (t - marks.start).max(0.0),
                        _ => marks.fadeout = (marks.end - t).max(0.0),
                    }
                    // The fades have to fit between start and end.
                    let length = marks.end - marks.start;
                    marks.fadein = marks.fadein.min(length);
                    marks.fadeout = marks.fadeout.min(length - marks.fadein);
                    self.dragging.insert(block, marks);
                }
            }
            if response.drag_stopped() {
                if let Some(marks) = self.dragging.remove(&block) {
                    actions.push(Action::Markers { block, marks });
                }
            }
        }

        let columns = rect.width().max(1.0) as usize;
        let mid = rect.center().y;
        let half = rect.height() / 2.0 - 2.0;
        let bucket = |t: f64| ((t / duration) * peaks.len() as f64) as usize;
        for column in 0..columns {
            let t = view_start + column as f64 / columns as f64 * view_len;
            let from = bucket(t).min(peaks.len() - 1);
            let to = bucket(t + view_len / columns as f64).clamp(from + 1, peaks.len());
            let (lo, hi) = peaks[from..to].iter().fold((0.0f32, 0.0f32), |(lo, hi), p| (lo.min(p.0), hi.max(p.1)));
            let colour = if t < marks.start || t > marks.end { WAVE_DIM } else { BLUE };
            let x = rect.left() + column as f32 + 0.5;
            painter.line_segment([pos2(x, mid - hi * half), pos2(x, mid - lo * half + 1.0)], Stroke::new(1.0_f32, colour));
        }
        painter.vline(x_of(marks.start), rect.y_range(), Stroke::new(2.0_f32, YELLOW));
        painter.vline(x_of(marks.end), rect.y_range(), Stroke::new(2.0_f32, YELLOW));

        // The fades: a slope from silence up to full level and back down, with a grip
        // at the top where each one meets full level.
        let fade = Stroke::new(1.5_f32, GREEN);
        let (fade_in_end, fade_out_start) = (marks.start + marks.fadein, marks.end - marks.fadeout);
        if marks.fadein > 0.0 {
            painter.line_segment([pos2(x_of(marks.start), rect.bottom()), pos2(x_of(fade_in_end), rect.top() + 1.0)], fade);
        }
        if marks.fadeout > 0.0 {
            painter.line_segment([pos2(x_of(fade_out_start), rect.top() + 1.0), pos2(x_of(marks.end), rect.bottom())], fade);
        }
        for at in [fade_in_end, fade_out_start] {
            painter.rect_filled(Rect::from_center_size(pos2(x_of(at), rect.top() + 4.0), vec2(8.0, 8.0)), 2.0, GREEN);
        }
        for at in [marks.start, marks.end] {
            painter.rect_filled(Rect::from_center_size(pos2(x_of(at), rect.bottom() - 4.0), vec2(8.0, 8.0)), 2.0, YELLOW);
        }

        if let Some(point) = part.fading_point.filter(|p| *p > marks.start && *p < marks.end) {
            painter.vline(x_of(point), rect.y_range(), Stroke::new(2.0_f32, ORANGE));
        }

        // Cues that fire by themselves at a place in this audio.
        if let Some(note) = note {
            let cues = Cues::new(cx.script);
            for target in 0..cues.len() {
                let Some(auto) = cues.get(target).and_then(|c| c.auto_trigger()).filter(|a| a.source == note) else { continue };
                let (AutoWhen::At(saved), Some(target_block)) = (auto.when, cues.block_index(target)) else { continue };
                let mut at = self.auto_dragging.get(&target_block).copied().unwrap_or(saved);
                let mut let_go = !shift;
                if shift {
                    let handle = Rect::from_center_size(pos2(x_of(at), rect.center().y), vec2(8.0, rect.height()));
                    let response = ui.interact(handle, Id::new(("auto-cue", block, target)), Sense::drag());
                    if response.hovered() || response.dragged() {
                        ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
                    }
                    if response.dragged() {
                        if let Some(pointer) = response.interact_pointer_pos() {
                            at = t_of(pointer.x);
                            self.auto_dragging.insert(target_block, at);
                        }
                    }
                    let_go = response.drag_stopped();
                }
                if let_go {
                    if let Some(at) = self.auto_dragging.remove(&target_block) {
                        actions.push(Action::AutoCueAt { block: target_block, at });
                    }
                }
                let colour = PURPLE;
                if rect.x_range().contains(x_of(at)) {
                    // The marker goes on below the waveform to the strip its line runs out
                    // in. The further left a marker stands, the higher its strip: a line
                    // running out to the left then never meets another marker's foot.
                    let mut places: Vec<(f64, usize)> = Self::position_autos(&cues, Some(note)).into_iter().map(|(cue, saved)| (if cue == target { at } else { cues.block_index(cue).and_then(|b| self.auto_dragging.get(&b).copied()).unwrap_or(saved) }, cue)).collect();
                    places.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                    let level = places.iter().position(|&(_, cue)| cue == target).unwrap_or(0);
                    let foot = pos2(x_of(at), rect.bottom() + 3.0 + level as f32 * AUTO_STRIP);
                    ui.painter().vline(foot.x, rect.bottom()..=foot.y, Stroke::new(1.5_f32, colour));
                    self.auto_anchors.insert(target_block, foot);
                }
                painter.vline(x_of(at), rect.y_range(), Stroke::new(1.5_f32, colour));
// Its name stands above the waveform, over the marker.
                if rect.x_range().contains(x_of(at)) {
                    let name = ui.painter().layout_no_wrap(format!("Auto {}", target + 1), FontId::proportional(11.0), colour);
                    let x = (x_of(at) - name.size().x / 2.0).clamp(rect.left(), (rect.right() - name.size().x).max(rect.left()));
                    ui.painter().galley(pos2(x, rect.top() - 1.0 - name.size().y), name, colour);
                }
            }
        }

        // While the playhead is being dragged it is shown where it is held.
        if let Some(seconds) = self.scrubbing.get(&block).copied().or(cursor) {
            painter.vline(x_of(seconds.clamp(0.0, duration)), rect.y_range(), Stroke::new(1.5_f32, BRIGHT));
        }
        // The ghost cursor: the audio has handed over at its loop point and rings out.
        if let Some(seconds) = ghost {
            let x = x_of(seconds.clamp(0.0, duration));
            painter.add(egui::Shape::dashed_line(&[pos2(x, rect.top()), pos2(x, rect.bottom())], Stroke::new(1.5_f32, BRIGHT.gamma_multiply(0.6)), 4.0, 3.0));
            ui.ctx().request_repaint();
        }
        Some(duration)
    }

    /// The headings the top of the view lies under: the first-level one and, if one has
    /// come since, the second-level one below it.
    pub fn current_headings(&self) -> (Option<&str>, Option<&str>) {
        let passed = || self.headings.iter().rev().filter(|(i, _, _)| self.offsets.get(*i).is_some_and(|&o| o <= self.scroll_y + 1.0));
        let top = passed().position(|(_, level, _)| *level == 1);
        let act = top.and_then(|n| passed().nth(n)).map(|(_, _, text)| text.as_str());
        // A scene only counts if it comes after the act (nearer in the reversed walk).
        let scene = passed().take(top.unwrap_or(usize::MAX)).find(|(_, level, _)| *level == 2).map(|(_, _, text)| text.as_str());
        (act, scene)
    }

    /// The scene list: first- and second-level headings, the one in view highlighted.
    /// Returns whether its close button was pressed.
    pub fn sidebar(&mut self, ui: &mut Ui) -> bool {
        let mut close = false;
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(t("SZENEN", "SCENES")).size(12.0).strong().color(MUTED));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                close = ui.add(egui::Button::new(egui::RichText::new("«").color(MUTED)).frame(false)).on_hover_text(t("Szenenmenü ausblenden", "Hide the scene list")).clicked();
            });
        });
        ui.separator();
        let active = self.headings.iter().rposition(|(i, _, _)| self.offsets.get(*i).is_some_and(|&o| o <= self.scroll_y + 1.0));
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            let mut jump = None;
            for (n, (index, level, text)) in self.headings.iter().enumerate() {
                let colour = if active == Some(n) { BLUE } else if *level > 1 { TEXT } else { BRIGHT };
                let indent = "    ".repeat((*level as usize).saturating_sub(1));
                let mut label = egui::RichText::new(format!("{indent}{text}")).color(colour);
                if *level == 1 {
                    label = label.strong();
                }
                if ui.add(egui::Label::new(label).truncate().sense(Sense::click())).clicked() {
                    jump = Some(*index);
                }
            }
            if let Some(index) = jump {
                self.scroll_to = Some(self.offsets[index]);
            }
        });
        close
    }
}

/// Text cut to `most` characters, with an ellipsis where something was left out.
fn clip(text: &str, most: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= most { text.to_string() } else { format!("{}…", text.chars().take(most - 1).collect::<String>().trim_end()) }
}

/// A MIDI message in words: "Ch 1 · CC 7 = 100".
fn midi_text(bytes: &[u8]) -> String {
    let Some(&status) = bytes.first() else { return String::new() };
    let data = |n: usize| bytes.get(n).copied().unwrap_or(0);
    let what = match status & 0xf0 {
        0x90 => format!("Note {} ({})", data(1), data(2)),
        0x80 => format!("Note {} {}", data(1), t("aus", "off")),
        0xb0 => format!("CC {} = {}", data(1), data(2)),
        0xc0 => format!("{} {}", t("Programm", "Program"), data(1)),
        _ => return bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "),
    };
    format!("Ch {} · {what}", (status & 0x0f) + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_messages_are_put_in_words() {
        assert_eq!(midi_text(&[0xb1, 7, 100]), "Ch 2 · CC 7 = 100");
        assert_eq!(midi_text(&[0x90, 60, 127]), "Ch 1 · Note 60 (127)");
        assert_eq!(midi_text(&[0xf0, 0x7f]), "F0 7F");
        assert_eq!(clip("  kurz ", 10), "kurz");
        assert_eq!(clip("ein langer Text", 8), "ein lan…");
    }

    /// The view draws a script with connected cues, and glides to where it is sent
    /// instead of jumping there.
    #[test]
    fn the_view_glides_to_a_cue() {
        let mut text = String::from("# Stück\n\n# Szene\n\n");
        for n in 0..40 {
            let more = match n {
                0 => "music: a.wav\nchain_end: {ch: 1, note: 1}\ncue_midi:\n    - {device: Pult, cc: 7, value: 100}",
                1 => "music: b.wav",
                30 => "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 2}",
                _ => "note: Licht",
            };
            text.push_str(&format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n{more}\n```\n\n**Anna**\nEin Satz.\n\n"));
        }
        let script = Script::parse(&text);
        let cast = Cast::from_script(&script, false);
        let snapshot = Snapshot { done: vec![0], current: Some(1), next: Some(2), ..Default::default() };
        let cx = Context { script: &script, cast: &cast, snapshot: &snapshot, locked: false, line_numbers: true, group_mics: false, can_paste: false, has_editor: false, vim: false };
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        crate::theme::apply(&ctx);
        let mut view = ScriptView::default();
        view.dirty = true;
        let mut seen = Vec::new();
        for frame in 0..200 {
            let input = egui::RawInput { screen_rect: Some(Rect::from_min_size(pos2(0.0, 0.0), vec2(1000.0, 600.0))), time: Some(frame as f64 / 60.0), predicted_dt: 1.0 / 60.0, ..Default::default() };
            let _ = ctx.run(input, |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| view.show(ui, &cx, &mut Vec::new()));
            });
            if frame == 2 {
                view.go_to_cue(30, 2.0 / 60.0);
            }
            seen.push(view.scroll_y);
        }
        let target = view.offsets[view.block_of_cue[30]] - 120.0;
        assert!(view.scroll_to.is_none(), "it arrived");
        assert!((view.scroll_y - target).abs() < 1.5, "at {} instead of {target}", view.scroll_y);
        let on_the_way = seen.iter().filter(|&&y| y > 1.0 && y < target - 1.5).count();
        assert!(on_the_way >= 8, "only {on_the_way} frames between start and arrival");
        assert!(seen.windows(2).all(|pair| pair[1] >= pair[0] - 0.01), "never backwards");
        assert_eq!(view.lanes, 2);
    }

    /// Ties get lanes so that no two lines lie on each other; a chain running down the
    /// page shares one.
    #[test]
    fn connections_between_cues_are_given_lanes() {
        let cue = |n: usize, more: &str| format!("```yaml\ntrigger_note: {{ch: 1, note: {n}}}\n{more}\n```\n\n");
        let text = [
            cue(0, "music: a.wav\nchain_end: {ch: 1, note: 1}"),
            cue(1, "music: b.wav\nloop_outro: {ch: 1, note: 2}"),
            cue(2, "music: c.wav"),
            cue(3, "auto_trigger: {trigger_note: {ch: 1, note: 0}, delay: 2}"),
        ]
        .concat();
        let mut view = ScriptView::default();
        view.relate(&Script::parse(&text));
        let lanes: Vec<(usize, usize, usize)> = view.relations.iter().map(|r| (r.from, r.to, r.lane)).collect();
        assert_eq!(view.relations.len(), 3);
        let lane_of = |from: usize, to: usize| lanes.iter().find(|l| (l.0, l.1) == (from, to)).map(|l| l.2);
        let blocks: Vec<usize> = Script::parse(&text).blocks.iter().enumerate().filter(|(_, b)| matches!(b, Block::Cue(_))).map(|(i, _)| i).collect();
        assert_eq!(lane_of(blocks[0], blocks[1]), Some(0));
        assert_eq!(lane_of(blocks[1], blocks[2]), Some(0), "the chain goes on in the same lane");
        assert_eq!(lane_of(blocks[0], blocks[3]), Some(1), "the long one goes around them");
        assert_eq!(view.lanes, 2);
        // No two line ends share a place on a cue's edge: every line has its own arrow.
        let mut places: Vec<(usize, usize)> = view.relations.iter().flat_map(|r| [(r.from, r.from_place.0), (r.to, r.to_place.0)]).collect();
        let all = places.len();
        places.sort_unstable();
        places.dedup();
        assert_eq!(places.len(), all);
    }

    #[test]
    fn role_names_complete_in_the_first_line_and_below_the_names() {
        let script = Script::parse("```yaml\nconfig:\n    roles:\n        Anna: {}\n        Ben: {}\n        New Yorker: {}\n```\n");
        let cast = Cast::from_script(&script, false);
        let offer = |text: &str, cursor: usize| ScriptView::completion(&cast, text, cursor).map(|(name, rest)| format!("{name}|{rest}"));
        // A new block.
        assert_eq!(offer("An", 2).as_deref(), Some("Anna|na"));
        assert_eq!(offer("new y", 5).as_deref(), Some("New Yorker|orker"));
        assert_eq!(offer("# An", 4), None);
        assert_eq!(offer("Xy", 2), None);
        assert_eq!(ScriptView::complete("An", "Anna"), ("**Anna**\n".to_string(), 9));
        // A block whose names were taken out, with its text still there.
        assert_eq!(offer("Be\nHallo.", 2).as_deref(), Some("Ben|n"));
        assert_eq!(offer("Be\nHallo.", 1), None, "only at the end of the line");
        assert_eq!(offer("Be\nHa", 5), None, "and not in the text further down");
        assert_eq!(ScriptView::complete("Be\nHallo.", "Ben"), ("**Ben**\n\nHallo.".to_string(), 8));
        // Below the names: a further role, but not one that is there already.
        assert_eq!(offer("**Ben**\nA\nHallo.", 9).as_deref(), Some("Anna|nna"));
        assert_eq!(offer("**Ben**\nB\nHallo.", 9), None);
        assert_eq!(offer("**Ben**\n\nHallo.", 8), None, "nothing typed, nothing offered");
        assert_eq!(offer("**Ben**\nHallo.\nA", 16), None, "only right below the names");
        assert_eq!(ScriptView::complete("**Ben**\nA\nHallo.", "Anna"), ("**Ben/Anna**\n\nHallo.".to_string(), 13));
        assert_eq!(ScriptView::complete("**Ben**\nA", "Anna"), ("**Ben/Anna**\n".to_string(), 13));
        // What comes of it is the role block one expects.
        assert_eq!(ScriptView::typed_block("**Ben/Anna**\n\nHallo."), Some(Block::Role { names: vec!["Ben".into(), "Anna".into()], text: "Hallo.".into() }));
    }

    #[test]
    fn scenes_are_numbered_and_the_title_is_not() {
        let numbers = |text: &str| ScriptView::scene_numbers(&Script::parse(text));
        // The title opens the file and is followed directly by the first scene.
        assert_eq!(numbers("# Stück\n\n# Einlass\n\n```yaml\nconfig:\n    roles: {}\n```\n\n*Licht.*\n\n# Prolog\n\n## Song\n\n# Ende\n"), [None, Some(1), None, None, Some(2), None, Some(3)]);
        // Without a title every first-level heading is a scene, also behind the config block.
        assert_eq!(numbers("```yaml\nconfig:\n    roles: {}\n```\n\n# Eins\n\n*Licht.*\n\n# Zwei\n"), [None, Some(1), None, Some(2)]);
        assert_eq!(numbers("# Titel\n\n```yaml\nconfig:\n    roles: {}\n```\n\n# Eins\n"), [None, None, Some(1)]);
        assert_eq!(numbers("*Nur Text.*\n"), [None]);

        let mut view = ScriptView::default();
        view.numbers = vec![None; 40];
        (0..20).for_each(|n| view.numbers[2 * n] = Some(n + 1));
        view.type_scene_digit(1, 0.0);
        view.type_scene_digit(7, 0.3);
        assert_eq!(view.typed_scene, Some((17, 0.3)));
    }

    #[test]
    fn long_rows_on_a_cue_go_on_in_further_lines() {
        let ctx = egui::Context::default();
        crate::theme::apply(&ctx);
        let _ = ctx.run(Default::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let font = FontId::proportional(15.0);
                let names: Vec<Span> = (1..=12).map(|n| (format!("Darstellerin {n}"), BRIGHT)).collect();
                let lines = |spans: &[Span], width: f32| ScriptView::flow_spans(ui, None, spans, &font, 0.0, width, 0.0, ROW);
                assert_eq!(lines(&names[..2], 2000.0), 1);
                assert_eq!(lines(&names, 5000.0), 1, "room for all of them");
                let narrow = lines(&names, 300.0);
                assert!((4..=12).contains(&narrow), "{narrow} lines for twelve names in 300 px");
                assert!(lines(&names, 150.0) > narrow, "narrower still, more lines");
                // One span longer than a line is broken inside, and what follows goes below it.
                let note = vec![("Ein sehr langer Hinweis, der ganz sicher nicht in eine einzige schmale Zeile passt.".to_string(), TEXT), ("Ende".to_string(), TEXT)];
                assert!(lines(&note, 200.0) >= 4);
                assert_eq!(lines(&note, 5000.0), 1);
                assert_eq!(lines(&[], 300.0), 1, "an empty row still is one line");
            });
        });
    }

    #[test]
    fn bare_text_typed_into_the_editor_is_a_stage_direction() {
        assert_eq!(ScriptView::typed_block("Licht aus."), Some(Block::Stage("Licht aus.".into())));
        assert_eq!(ScriptView::typed_block("*Licht aus.*"), Some(Block::Stage("Licht aus.".into())));
        assert_eq!(ScriptView::typed_block("# Akt 2"), Some(Block::Heading { level: 1, text: "Akt 2".into() }));
        assert_eq!(ScriptView::typed_block("**Anna**\nHallo."), Some(Block::Role { names: vec!["Anna".into()], text: "Hallo.".into() }));
        assert_eq!(ScriptView::typed_block(""), None);
        assert_eq!(ScriptView::typed_block("****\nHallo."), Some(Block::Stage("Hallo.".into())), "emptied role names leave no fragment");
        assert_eq!(ScriptView::typed_block("  \n\t\n "), None, "nothing but space is nothing");
        assert_eq!(ScriptView::typed_block("  Licht aus.  \n\n   \n"), Some(Block::Stage("Licht aus.".into())));
        assert_eq!(ScriptView::typed_block("**Anna**\n\n  Hallo.  \n \nNoch was.\n"), Some(Block::Role { names: vec!["Anna".into()], text: "Hallo.\nNoch was.".into() }));
        // What is typed comes back the same from the file.
        for typed in ["Licht aus.", "Zwei\nZeilen", "x"] {
            let block = ScriptView::typed_block(typed).unwrap();
            let written = Script { blocks: vec![block.clone()] }.to_markdown();
            assert_eq!(Script::parse(&written).blocks, [block], "{written:?}");
        }
        // Text with an asterisk in it cannot be one and stays as typed.
        assert_eq!(ScriptView::typed_block("Hallo *(leise)* du"), Some(Block::Text("Hallo *(leise)* du".into())));
    }
}
