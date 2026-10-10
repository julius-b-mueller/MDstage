//! The script: headings, stage directions, dialogue and cue panels in one long,
//! virtualized view. Only the blocks on screen are laid out and painted; heights are
//! measured once per window width.

use std::collections::HashMap;
use std::path::PathBuf;

use eframe::egui::text::{CCursor, CCursorRange, LayoutJob, TextFormat};
use eframe::egui::{self, Align2, Color32, FontId, Id, Key, Modifiers, Rect, Sense, Stroke, Ui, UiBuilder, pos2, vec2};
use mdstage_core::cues::{AutoWhen, Cues, Slf};
use mdstage_core::effects::Effect;
use mdstage_core::mic::{Cast, Mic, MicChip};
use mdstage_core::{Block, Cue, Script};
use mdstage_engine::session::Snapshot;

use crate::theme::*;
use crate::waveform::{WaveState, Waveforms};

const MARGIN: f32 = 24.0;
const BLOCK_PAD: f32 = 6.0;
const ROW: f32 = 21.0;
const WAVE_HEIGHT: f32 = 64.0;

/// What the operator did in the view; the app carries it out.
pub enum Action {
    /// A click on a cue.
    Fire(usize),
    /// A block was edited.
    Replace { block: usize, with: Block },
    /// The start/end markers of a cue's audio were dragged (seconds).
    Markers { block: usize, start: f64, end: f64 },
}

/// What the view shows; borrowed from the app each frame.
pub struct Context<'a> {
    pub script: &'a Script,
    pub cast: &'a Cast,
    pub snapshot: &'a Snapshot,
    /// Editing is off (show lock).
    pub locked: bool,
}

struct Editing {
    index: usize,
    buffer: String,
    focused: bool,
}

/// One coloured piece of a row in a cue panel.
type Span = (String, Color32);

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
    /// Markers being dragged: block → (start, end).
    dragging: HashMap<usize, (f64, f64)>,
    scroll_to: Option<f32>,
    scroll_y: f32,
    waveforms: Option<Waveforms>,
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

    /// Bring a cue to the top third of the view.
    pub fn scroll_to_cue(&mut self, cue: usize) {
        if let Some(&block) = self.block_of_cue.get(cue) {
            self.scroll_to = self.offsets.get(block).map(|y| (y - 120.0).max(0.0));
        }
    }

    fn role_colour(cast: &Cast, name: &str) -> Color32 {
        let role = cast.role(name).and_then(|r| r.color.as_deref());
        let group = cast.groups.iter().find(|g| g.name == name).and_then(|g| g.color.as_deref());
        named(role.or(group)).unwrap_or(BRIGHT)
    }

    /// Text layout of a block; `None` for blocks that are not plain text.
    fn job(cast: &Cast, block: &Block, width: f32) -> Option<LayoutJob> {
        let mut job = LayoutJob::default();
        job.wrap.max_width = width;
        let plain = |size: f32, color| TextFormat { font_id: FontId::proportional(size), color, ..Default::default() };
        match block {
            Block::Heading { level, text } => {
                let size = match level {
                    1 => 27.0,
                    2 => 21.0,
                    _ => 17.0,
                };
                job.append(text, 0.0, plain(size, BRIGHT));
            }
            Block::Stage(text) => job.append(text, 0.0, TextFormat { italics: true, ..plain(16.0, MUTED) }),
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
                        job.append(&rest[..open], 0.0, plain(17.0, colour));
                        job.append(&rest[open + 1..open + close + 1], 0.0, TextFormat { italics: true, ..plain(17.0, MUTED) });
                        rest = &rest[open + close + 2..];
                    }
                    job.append(rest, 0.0, plain(17.0, colour));
                }
            }
            Block::Text(text) => job.append(text, 0.0, plain(17.0, TEXT)),
            Block::Config(_) | Block::Cue(_) => return None,
        }
        Some(job)
    }

    /// The rows of a cue panel: a label and coloured spans.
    fn cue_rows(cx: &Context, block: usize, cue_index: usize, cue: &Cue) -> Vec<(&'static str, Vec<Span>)> {
        let mut rows = Vec::new();
        if cue.invalid {
            rows.push(("YAML", vec![("nicht lesbar".to_string(), RED)]));
            return rows;
        }
        let mic = cx.script.mic_for_cue(block, cx.cast);
        match &mic {
            Mic::MuteAll => rows.push(("Mic", vec![("alle aus".to_string(), MUTED)])),
            Mic::Open(_) => {
                let mut spans = Vec::new();
                for chip in cx.cast.chips(&mic, true) {
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
                rows.push(("Mic", spans));
            }
            Mic::Unchanged if cue.auto_mic() => rows.push(("Mic", vec![("(auto, niemand spricht)".to_string(), MUTED)])),
            Mic::Unchanged => {}
        }
        for (label, key) in [("Notiz", "note"), ("TC", "start_tc"), ("OSC", "osc"), ("Proj.", "projection"), ("QLC+", "qlcplus")] {
            if let Some(value) = cue.text(key) {
                rows.push((label, vec![(value.to_string(), TEXT)]));
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
                spans.push(("⟳".to_string(), BLUE));
            }
            rows.push(("♬", spans));
        }
        let cues = Cues::new(cx.script);
        let cue_label = |target: Option<usize>| target.map_or("?".to_string(), |c| format!("Cue {}", c + 1));
        match cues.slf(cue_index) {
            Some(Slf::Start { next }) => rows.push(("S/L/F", vec![(format!("Start → {}", cue_label(cues.find(next))), BLUE)])),
            Some(Slf::Loop { outro }) => rows.push(("S/L/F", vec![(format!("Loop ↩ {}", cue_label(cues.find(outro))), BLUE)])),
            Some(Slf::Finish { from }) => rows.push(("S/L/F", vec![(format!("Finish ← {}", cue_label(from.first().copied())), BLUE)])),
            Some(Slf::Bridge { from, next }) => {
                rows.push(("S/L/F", vec![(format!("Bridge ← {} → {}", cue_label(from.first().copied()), cue_label(cues.find(next))), BLUE)]))
            }
            None => {}
        }
        if let Some(auto) = cue.auto_trigger() {
            let source = cue_label(cues.find(auto.source));
            let text = match auto.when {
                AutoWhen::At(at) => format!("automatisch bei {at} s in {source}"),
                AutoWhen::Delay(delay) => format!("automatisch {delay} s nach {source}"),
            };
            rows.push(("⏱", vec![(text, GREEN)]));
        }
        if let Some(adjust) = cue.adjust() {
            let target = cue_label(cues.find(adjust.target));
            let text = match (adjust.fadeout, adjust.volume) {
                (true, _) => format!("{target} ausfaden"),
                (false, Some(v)) => format!("{target} auf {} %", (v * 100.0).round()),
                _ => target,
            };
            rows.push(("⇢", vec![(text, TEXT)]));
        }
        // What the cue sends, per device.
        let mut sends: Vec<(String, usize)> = Vec::new();
        let mut count = |label: String| match sends.iter_mut().find(|(l, _)| *l == label) {
            Some(entry) => entry.1 += 1,
            None => sends.push((label, 1)),
        };
        for effect in cue.fire_effects() {
            match effect {
                Effect::Midi { device, .. } => count(format!("MIDI {device}")),
                Effect::Osc { device, .. } => count(format!("OSC {device}")),
                Effect::Http { device, .. } => count(format!("HTTP {device}")),
                Effect::Announce { device, .. } => count(format!("Durchsage {device}")),
                _ => {}
            }
        }
        if let Some(list) = cue.yaml.get("cue_display").and_then(|v| v.as_sequence()) {
            for device in list.iter().filter_map(|m| m.get("device")?.as_str()) {
                count(format!("Display {device}"));
            }
        }
        if !sends.is_empty() {
            let spans = sends.into_iter().map(|(label, n)| (if n > 1 { format!("{label} ×{n}") } else { label }, YELLOW)).collect();
            rows.push(("Sendet", spans));
        }
        rows
    }

    fn cue_height(rows: usize, has_audio: bool) -> f32 {
        let wave = if has_audio { WAVE_HEIGHT + 10.0 } else { 0.0 };
        8.0 + 10.0 + ROW + rows as f32 * ROW + wave + 10.0
    }

    /// Measure every block for the given width. Runs once per width change or edit.
    fn measure(&mut self, ui: &Ui, cx: &Context, width: f32) {
        let editing = self.editing.as_ref().map(|e| e.index);
        let blocks = &cx.script.blocks;
        self.heights.resize(blocks.len(), 0.0);
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
                    let rows = Self::cue_rows(cx, i, self.cue_of_block[i].unwrap_or(0), cue);
                    Self::cue_height(rows.len(), cue.audio().is_some())
                }
                block => {
                    let job = Self::job(cx.cast, block, width).unwrap_or_default();
                    ui.fonts(|f| f.layout_job(job)).size().y + 2.0 * BLOCK_PAD
                }
            };
        }
        self.layout_width = width;
        self.reflow();
        self.headings = blocks
            .iter()
            .enumerate()
            .filter_map(|(i, block)| match block {
                Block::Heading { level, text } if *level <= 2 => Some((i, *level, text.clone())),
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
        let width = (ui.available_width() - 2.0 * MARGIN).max(200.0);
        if self.dirty || self.heights.len() != cx.script.blocks.len() || (width - self.layout_width).abs() > 0.5 {
            self.measure(ui, cx, width);
        }
        let mut area = egui::ScrollArea::vertical().auto_shrink([false, false]);
        if let Some(y) = self.scroll_to.take() {
            area = area.vertical_scroll_offset(y);
        }
        let total = self.offsets.last().copied().unwrap_or(0.0);
        let output = area.show_viewport(ui, |ui, viewport| {
            ui.set_height(total + 200.0);
            ui.set_width(ui.available_width());
            let origin = ui.min_rect().min + vec2(MARGIN, 0.0);
            let first = self.offsets.partition_point(|&o| o <= viewport.min.y).saturating_sub(1);
            for i in first..cx.script.blocks.len() {
                if self.offsets[i] > viewport.max.y {
                    break;
                }
                let rect = Rect::from_min_size(origin + vec2(0.0, self.offsets[i]), vec2(width, self.heights[i]));
                self.draw_block(ui, cx, i, rect, actions);
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
        let Some(job) = Self::job(cx.cast, block, rect.width()) else { return };
        let response = ui.interact(rect, Id::new(("block", index)), Sense::click());
        let shift = ui.input(|i| i.modifiers.shift);
        if response.hovered() && shift && !cx.locked {
            ui.painter().rect_filled(rect.expand2(vec2(8.0, 0.0)), 4.0, PANEL);
        }
        let galley = ui.fonts(|f| f.layout_job(job));
        ui.painter().galley(rect.min + vec2(0.0, BLOCK_PAD), galley, TEXT);
        if response.clicked() && shift && !cx.locked {
            let buffer = Script { blocks: vec![block.clone()] }.to_markdown();
            self.editing = Some(Editing { index, buffer: buffer.trim_end().to_string(), focused: false });
        }
    }

    /// Role name completing what has been typed so far: `(full name, missing rest)`.
    fn ghost(cast: &Cast, buffer: &str) -> Option<(String, String)> {
        if buffer.is_empty() || buffer.contains('\n') || buffer.starts_with(['#', '*']) {
            return None;
        }
        let typed = buffer.to_lowercase();
        let name = cast.roles.iter().map(|r| &r.name).chain(cast.groups.iter().map(|g| &g.name)).find(|n| n.to_lowercase().starts_with(&typed))?;
        let rest: String = name.chars().skip(buffer.chars().count()).collect();
        Some((name.clone(), rest))
    }

    fn draw_editor(&mut self, ui: &mut Ui, cx: &Context, index: usize, rect: Rect, actions: &mut Vec<Action>) {
        let Some(mut editing) = self.editing.take() else { return };
        let id = Id::new("block-editor");
        let ghost = Self::ghost(cx.cast, &editing.buffer);

        // Keys the editor handles itself must be taken before the text field sees them.
        let tab = ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Tab));
        let commit = ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter));
        let cancel = ui.input(|i| i.key_pressed(Key::Escape));
        if tab {
            if let Some((name, _)) = &ghost {
                editing.buffer = format!("**{name}**\n");
                let end = CCursor::new(editing.buffer.chars().count());
                if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), id) {
                    state.cursor.set_char_range(Some(CCursorRange::one(end)));
                    state.store(ui.ctx(), id);
                }
            }
        }

        let field = Rect::from_min_size(rect.min + vec2(0.0, BLOCK_PAD), vec2(rect.width(), 0.0));
        let mut child = ui.new_child(UiBuilder::new().max_rect(field));
        let output = egui::TextEdit::multiline(&mut editing.buffer)
            .id(id)
            .font(FontId::proportional(17.0))
            .desired_width(rect.width())
            .desired_rows(1)
            .lock_focus(true)
            .show(&mut child);
        if !editing.focused {
            output.response.request_focus();
            editing.focused = true;
        }
        if let Some((_, rest)) = Self::ghost(cx.cast, &editing.buffer) {
            let end = output.galley.pos_from_cursor(&output.galley.end());
            let pos = output.galley_pos + end.right_top().to_vec2();
            child.painter().text(pos, Align2::LEFT_TOP, format!("{rest}  ⇥"), FontId::proportional(17.0), MUTED);
        }

        let height = child.min_rect().height() + 2.0 * BLOCK_PAD;
        if (height - self.heights[index]).abs() > 0.5 {
            self.heights[index] = height;
            self.reflow();
            ui.ctx().request_repaint();
        }

        if cancel {
            self.dirty = true;
        } else if commit {
            // Whatever was typed becomes one block; an emptied editor leaves it as it was.
            if let Some(with) = Script::parse(&editing.buffer.replace("\n\n", "\n")).blocks.into_iter().next() {
                actions.push(Action::Replace { block: index, with });
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
        painter.rect_filled(panel, 4.0, if response.hovered() { RAISED } else { PANEL });
        let bar = match () {
            _ if is_current => GREEN,
            _ if waits => YELLOW,
            _ if is_next => YELLOW,
            _ if snapshot.fired.contains(&cue_index) => WAVE_DIM,
            _ => BLUE,
        };
        painter.rect_filled(Rect::from_min_size(panel.min, vec2(if is_current || is_next { 6.0 } else { 4.0 }, panel.height())), 0.0, bar);
        if let Some(fraction) = delay {
            // A delay auto-cue counting down fills the panel from the left.
            let filled = Rect::from_min_size(panel.min, vec2(panel.width() * fraction as f32, panel.height()));
            painter.rect_filled(filled, 4.0, Color32::from_rgba_unmultiplied(0x98, 0xc3, 0x79, 28));
        }

        let left = panel.left() + 16.0;
        let mut y = panel.top() + 10.0;
        let font = FontId::proportional(15.0);
        let mut x = painter.text(pos2(left, y), Align2::LEFT_TOP, format!("Cue {}", cue_index + 1), FontId::proportional(16.0), BRIGHT).right() + 12.0;
        let mut badge = |text: &str, colour: Color32| {
            x = painter.text(pos2(x, y + 1.0), Align2::LEFT_TOP, text, FontId::proportional(13.0), colour).right() + 10.0;
        };
        if cue.is_variant() {
            badge("Variante", MUTED);
        }
        if is_current {
            badge("● aktuell", GREEN);
        }
        if waits {
            badge("wartet auf Loop-Ende", YELLOW);
        } else if is_next {
            badge("▶ nächster", YELLOW);
        }
        if sounding {
            badge("♪ läuft", BLUE);
        }
        if let Some(note) = cue.note() {
            painter.text(pos2(panel.right() - 12.0, y), Align2::RIGHT_TOP, note.to_string(), font.clone(), MUTED);
        }
        y += ROW;
        for (label, spans) in Self::cue_rows(cx, block, cue_index, cue) {
            painter.text(pos2(left, y), Align2::LEFT_TOP, label, font.clone(), MUTED);
            let mut x = left + 56.0;
            for (text, colour) in spans {
                x = painter.text(pos2(x, y), Align2::LEFT_TOP, text, font.clone(), colour).right() + 8.0;
            }
            y += ROW;
        }
        if let Some(audio) = cue.audio() {
            let wave = Rect::from_min_size(pos2(left, y + 4.0), vec2(panel.right() - 12.0 - left, WAVE_HEIGHT));
            let part = &audio.parts[0];
            // The cursor only makes sense on the part whose waveform is shown.
            let cursor = status.filter(|s| s.part == 0 && sounding).map(|s| s.seconds);
            self.draw_waveform(ui, cx, block, &part.audios[0].file, (part.start, part.end, part.fading_point), cursor, wave, actions);
        }
        if response.clicked() {
            actions.push(Action::Fire(cue_index));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_waveform(
        &mut self,
        ui: &mut Ui,
        cx: &Context,
        block: usize,
        file: &str,
        (start, end, fading_point): (Option<f64>, Option<f64>, Option<f64>),
        cursor: Option<f64>,
        rect: Rect,
        actions: &mut Vec<Action>,
    ) {
        let painter = ui.painter().clone();
        painter.rect_filled(rect, 3.0, BACKGROUND);
        let state = self.waveforms.as_mut().map_or(WaveState::Failed, |w| w.get(file));
        let (peaks, duration) = match state {
            WaveState::Ready { peaks, duration } if duration > 0.0 => (peaks, duration),
            WaveState::Loading => {
                painter.text(rect.center(), Align2::CENTER_CENTER, "lädt …", FontId::proportional(13.0), MUTED);
                return;
            }
            _ => {
                painter.text(rect.center(), Align2::CENTER_CENTER, format!("{file}: nicht lesbar"), FontId::proportional(13.0), RED);
                return;
            }
        };
        let saved = (start.unwrap_or(0.0), end.unwrap_or(duration).min(duration));
        let (mut start, mut end) = self.dragging.get(&block).copied().unwrap_or(saved);

        // Markers first, so a drag in this frame already moves the shading.
        let shift = ui.input(|i| i.modifiers.shift) && !cx.locked;
        let x_of = |t: f64| rect.left() + (t / duration) as f32 * rect.width();
        for which in 0..2 {
            let x = x_of(if which == 0 { start } else { end });
            let handle = Rect::from_center_size(pos2(x, rect.center().y), vec2(12.0, rect.height()));
            let response = ui.interact(handle, Id::new(("marker", block, which)), Sense::drag());
            if shift && (response.hovered() || response.dragged()) {
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            }
            if shift && response.dragged() {
                if let Some(pointer) = response.interact_pointer_pos() {
                    let t = ((pointer.x - rect.left()) / rect.width()).clamp(0.0, 1.0) as f64 * duration;
                    if which == 0 {
                        start = t.min(end);
                    } else {
                        end = t.max(start);
                    }
                    self.dragging.insert(block, (start, end));
                }
            }
            if response.drag_stopped() {
                if let Some((start, end)) = self.dragging.remove(&block) {
                    actions.push(Action::Markers { block, start, end });
                }
            }
        }

        let columns = rect.width().max(1.0) as usize;
        let mid = rect.center().y;
        let half = rect.height() / 2.0 - 2.0;
        for column in 0..columns {
            let from = column * peaks.len() / columns;
            let to = ((column + 1) * peaks.len() / columns).clamp(from + 1, peaks.len());
            let (lo, hi) = peaks[from..to].iter().fold((0.0f32, 0.0f32), |(lo, hi), p| (lo.min(p.0), hi.max(p.1)));
            let t = column as f64 / columns as f64 * duration;
            let colour = if t < start || t > end { WAVE_DIM } else { BLUE };
            let x = rect.left() + column as f32 + 0.5;
            painter.line_segment([pos2(x, mid - hi * half), pos2(x, mid - lo * half + 1.0)], Stroke::new(1.0_f32, colour));
        }
        painter.vline(x_of(start), rect.y_range(), Stroke::new(2.0_f32, YELLOW));
        painter.vline(x_of(end), rect.y_range(), Stroke::new(2.0_f32, YELLOW));
        if let Some(point) = fading_point.filter(|p| *p > start && *p < end) {
            painter.vline(x_of(point), rect.y_range(), Stroke::new(2.0_f32, Color32::from_rgb(0xd1, 0x9a, 0x66)));
        }
        if let Some(seconds) = cursor {
            painter.vline(x_of(seconds.clamp(0.0, duration)), rect.y_range(), Stroke::new(1.5_f32, BRIGHT));
        }
    }

    /// The scene list: first- and second-level headings, the one in view highlighted.
    pub fn sidebar(&mut self, ui: &mut Ui) {
        ui.add_space(6.0);
        ui.label(egui::RichText::new("SZENEN").size(12.0).color(MUTED));
        let active = self.headings.iter().rposition(|(i, _, _)| self.offsets.get(*i).is_some_and(|&o| o <= self.scroll_y + 1.0));
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            let mut jump = None;
            for (n, (index, level, text)) in self.headings.iter().enumerate() {
                let colour = if active == Some(n) { BLUE } else { TEXT };
                let indent = if *level > 1 { "    " } else { "" };
                let label = egui::RichText::new(format!("{indent}{text}")).color(colour);
                if ui.add(egui::Label::new(label).truncate().sense(Sense::click())).clicked() {
                    jump = Some(*index);
                }
            }
            if let Some(index) = jump {
                self.scroll_to = Some(self.offsets[index]);
            }
        });
    }
}
