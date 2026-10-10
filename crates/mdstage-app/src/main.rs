//! UI spike: the script view on a long show file.
//!
//!     cargo run --release -p mdstage-app -- [--blocks N] [--bench] [SCRIPT.md]
//!
//! `--blocks N` repeats the script until it has at least N blocks; `--bench` scrolls
//! through the whole document once, prints frame statistics and exits.
//!
//! What it proves: only visible blocks are laid out and painted (heights are measured once
//! per window width), jumps land exactly, a block can be edited in place with role
//! autocomplete, and waveforms with draggable markers draw from peaks decoded off-thread.

mod waveform;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use eframe::egui::text::{CCursor, CCursorRange, LayoutJob, TextFormat};
use eframe::egui::{self, Align2, Color32, FontId, Id, Key, Modifiers, Rect, Sense, Stroke, Ui, UiBuilder, pos2, vec2};
use mdstage_core::{Block, Cue, Script};

use waveform::{WaveState, Waveforms};

const BACKGROUND: Color32 = Color32::from_rgb(0x28, 0x2c, 0x34);
const PANEL: Color32 = Color32::from_rgb(0x21, 0x25, 0x2b);
const TEXT: Color32 = Color32::from_rgb(0xab, 0xb2, 0xbf);
const BRIGHT: Color32 = Color32::from_rgb(0xe6, 0xe6, 0xe6);
const MUTED: Color32 = Color32::from_rgb(0x7f, 0x84, 0x8e);
const ACCENT: Color32 = Color32::from_rgb(0x61, 0xaf, 0xef);
const MARKER: Color32 = Color32::from_rgb(0xe5, 0xc0, 0x7b);
const WAVE: Color32 = Color32::from_rgb(0x61, 0xaf, 0xef);
const WAVE_DIM: Color32 = Color32::from_rgb(0x4b, 0x52, 0x63);

const MARGIN: f32 = 24.0;
const BLOCK_PAD: f32 = 6.0;
const ROW: f32 = 21.0;
const WAVE_HEIGHT: f32 = 64.0;

fn role_colour(name: &str) -> Color32 {
    let hex = match name {
        "red" => 0xe06c75,
        "green" => 0x98c379,
        "yellow" => 0xe5c07b,
        "blue" => 0x61afef,
        "purple" => 0xc678dd,
        "cyan" => 0x56b6c2,
        "darkred" => 0xb03c45,
        "darkgreen" => 0x68b349,
        "darkyellow" => 0xb5904b,
        "darkblue" => 0x317fbf,
        "darkpurple" => 0x9648ad,
        "darkcyan" => 0x268692,
        _ => return TEXT,
    };
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

struct Args {
    script: PathBuf,
    min_blocks: usize,
    bench: bool,
}

impl Args {
    fn from_env() -> Args {
        let mut args = Args { script: PathBuf::from("website/preview/script.md"), min_blocks: 0, bench: false };
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--bench" => args.bench = true,
                "--blocks" => args.min_blocks = it.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                other => args.script = PathBuf::from(other),
            }
        }
        args
    }
}

struct Item {
    block: Block,
    /// 1-based cue number, for cue blocks.
    cue_number: usize,
}

struct Editing {
    index: usize,
    buffer: String,
    focused: bool,
}

/// Rolling window of timings, in milliseconds.
#[derive(Default)]
struct Timings(Vec<f32>);

impl Timings {
    fn push(&mut self, ms: f32) {
        if self.0.len() >= 120 {
            self.0.remove(0);
        }
        self.0.push(ms);
    }

    fn mean(&self) -> f32 {
        self.0.iter().sum::<f32>() / self.0.len().max(1) as f32
    }

    fn max(&self) -> f32 {
        self.0.iter().copied().fold(0.0, f32::max)
    }
}

struct Bench {
    frame: usize,
    update_ms: Vec<f32>,
    cpu_ms: Vec<f32>,
    started: Option<Instant>,
}

impl Bench {
    const WARM_UP: usize = 30;
    const FRAMES: usize = 600;
}

struct App {
    items: Vec<Item>,
    roles: HashMap<String, Color32>,
    role_names: Vec<String>,
    /// Height of every block and its top edge (`offsets` has one extra entry: the total).
    heights: Vec<f32>,
    offsets: Vec<f32>,
    layout_width: f32,
    layout_dirty: bool,
    layout_ms: f32,
    headings: Vec<(usize, u8, String)>,
    editing: Option<Editing>,
    /// Start/end markers moved in this session, by block index.
    markers: HashMap<usize, (f64, f64)>,
    scroll_to: Option<f32>,
    scroll_y: f32,
    visible: usize,
    waveforms: Waveforms,
    update_ms: Timings,
    cpu_ms: Timings,
    bench: Option<Bench>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, args: Args) -> App {
        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = BACKGROUND;
        visuals.window_fill = PANEL;
        visuals.extreme_bg_color = PANEL;
        visuals.override_text_color = Some(TEXT);
        cc.egui_ctx.set_visuals(visuals);

        let text = std::fs::read_to_string(&args.script).unwrap_or_else(|e| {
            eprintln!("cannot read {}: {e}", args.script.display());
            String::new()
        });
        let script = Script::parse(&text);
        let roles: Vec<(String, String)> = script.roles();

        // Repeat the body until the script is long enough for the test.
        let body: Vec<Block> = script.blocks.iter().filter(|b| !matches!(b, Block::Config(_))).cloned().collect();
        let mut blocks = body.clone();
        let mut round = 1;
        while !body.is_empty() && blocks.len() < args.min_blocks {
            round += 1;
            blocks.extend(body.iter().cloned().map(|b| match b {
                Block::Heading { level, text } => Block::Heading { level, text: format!("{text} ({round})") },
                other => other,
            }));
        }
        let mut cue_number = 0;
        let items = blocks
            .into_iter()
            .map(|block| {
                if matches!(block, Block::Cue(_)) {
                    cue_number += 1;
                }
                Item { block, cue_number }
            })
            .collect();

        let audio_dir = args.script.parent().unwrap_or(std::path::Path::new(".")).join("audio");
        App {
            items,
            role_names: roles.iter().map(|(n, _)| n.clone()).collect(),
            roles: roles.into_iter().map(|(n, c)| (n, role_colour(&c))).collect(),
            heights: Vec::new(),
            offsets: vec![0.0],
            layout_width: 0.0,
            layout_dirty: true,
            layout_ms: 0.0,
            headings: Vec::new(),
            editing: None,
            markers: HashMap::new(),
            scroll_to: None,
            scroll_y: 0.0,
            visible: 0,
            waveforms: Waveforms::new(audio_dir, cc.egui_ctx.clone()),
            update_ms: Timings::default(),
            cpu_ms: Timings::default(),
            bench: args.bench.then(|| Bench { frame: 0, update_ms: Vec::new(), cpu_ms: Vec::new(), started: None }),
        }
    }

    fn colour_of(&self, role: &str) -> Color32 {
        self.roles.get(role).copied().unwrap_or(BRIGHT)
    }

    /// Text layout of a block at the given width; `None` for blocks that are not plain text.
    fn job(&self, block: &Block, width: f32) -> Option<LayoutJob> {
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
            Block::Stage(text) => {
                job.append(text, 0.0, TextFormat { italics: true, ..plain(16.0, MUTED) });
            }
            Block::Role { names, text } => {
                let colour = names.first().map_or(BRIGHT, |n| self.colour_of(n));
                for (i, name) in names.iter().enumerate() {
                    if i > 0 {
                        job.append("  ", 0.0, plain(13.0, MUTED));
                    }
                    job.append(&name.to_uppercase(), 0.0, plain(13.0, self.colour_of(name)));
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

    /// Label/value rows shown in a cue panel. Each value is a list of coloured spans.
    fn cue_rows(&self, cue: &Cue) -> Vec<(&'static str, Vec<(String, Color32)>)> {
        let mut rows = Vec::new();
        if cue.invalid {
            rows.push(("YAML", vec![("nicht lesbar".to_string(), role_colour("red"))]));
            return rows;
        }
        let mics = cue.mics();
        if !mics.is_empty() {
            rows.push(("Mic", mics.iter().map(|m| (m.to_string(), self.colour_of(m))).collect()));
        }
        for (label, key) in [("Licht", "light"), ("Notiz", "note"), ("TC", "start_tc"), ("OSC", "osc")] {
            if let Some(value) = cue.text(key) {
                rows.push((label, vec![(value.to_string(), TEXT)]));
            }
        }
        if let Some(music) = cue.music() {
            let mut label = music.file.clone();
            if music.looped {
                label.push_str("  ⟳");
            }
            rows.push(("♬", vec![(label, TEXT)]));
        }
        rows
    }

    fn cue_height(&self, cue: &Cue) -> f32 {
        let wave = if cue.music().is_some() { WAVE_HEIGHT + 10.0 } else { 0.0 };
        8.0 + 10.0 + ROW + self.cue_rows(cue).len() as f32 * ROW + wave + 10.0
    }

    /// Measure every block for the given width. Runs once per width change or edit.
    fn measure(&mut self, ui: &Ui, width: f32) {
        let started = Instant::now();
        let editing = self.editing.as_ref().map(|e| e.index);
        let mut heights = std::mem::take(&mut self.heights);
        heights.resize(self.items.len(), 0.0);
        for (i, item) in self.items.iter().enumerate() {
            if editing == Some(i) {
                continue; // the editor reports its own height while open
            }
            heights[i] = match &item.block {
                Block::Config(_) => 0.0,
                Block::Cue(cue) => self.cue_height(cue),
                block => {
                    let job = self.job(block, width).unwrap_or_default();
                    ui.fonts(|f| f.layout_job(job)).size().y + 2.0 * BLOCK_PAD
                }
            };
        }
        self.heights = heights;
        self.layout_width = width;
        self.reflow();
        self.headings = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| match &item.block {
                Block::Heading { level, text } if *level <= 2 => Some((i, *level, text.clone())),
                _ => None,
            })
            .collect();
        self.layout_dirty = false;
        self.layout_ms = started.elapsed().as_secs_f32() * 1000.0;
    }

    /// Recompute the block offsets from the heights.
    fn reflow(&mut self) {
        self.offsets.clear();
        let mut y = 0.0;
        for h in &self.heights {
            self.offsets.push(y);
            y += h;
        }
        self.offsets.push(y);
    }

    fn total_height(&self) -> f32 {
        self.offsets.last().copied().unwrap_or(0.0)
    }

    fn script_view(&mut self, ui: &mut Ui) {
        let width = (ui.available_width() - 2.0 * MARGIN).max(200.0);
        if self.layout_dirty || (width - self.layout_width).abs() > 0.5 {
            self.measure(ui, width);
        }
        let mut area = egui::ScrollArea::vertical().auto_shrink([false, false]);
        if let Some(y) = self.scroll_to.take() {
            area = area.vertical_scroll_offset(y);
        }
        let total = self.total_height();
        let output = area.show_viewport(ui, |ui, viewport| {
            ui.set_height(total);
            ui.set_width(ui.available_width());
            let origin = ui.min_rect().min + vec2(MARGIN, 0.0);
            // First block whose bottom edge is below the top of the viewport.
            let first = self.offsets.partition_point(|&o| o <= viewport.min.y).saturating_sub(1);
            let mut drawn = 0;
            for i in first..self.items.len() {
                if self.offsets[i] > viewport.max.y {
                    break;
                }
                let rect = Rect::from_min_size(origin + vec2(0.0, self.offsets[i]), vec2(width, self.heights[i]));
                self.draw_block(ui, i, rect);
                drawn += 1;
            }
            self.visible = drawn;
        });
        self.scroll_y = output.state.offset.y;
    }

    fn draw_block(&mut self, ui: &mut Ui, index: usize, rect: Rect) {
        if self.editing.as_ref().is_some_and(|e| e.index == index) {
            self.draw_editor(ui, index, rect);
            return;
        }
        if let Block::Cue(cue) = &self.items[index].block {
            let cue = cue.clone();
            self.draw_cue(ui, index, &cue, rect);
            return;
        }
        let Some(job) = self.job(&self.items[index].block, rect.width()) else { return };
        let response = ui.interact(rect, Id::new(("block", index)), Sense::click());
        if response.hovered() && ui.input(|i| i.modifiers.shift) {
            ui.painter().rect_filled(rect.expand2(vec2(8.0, 0.0)), 4.0, PANEL);
        }
        let galley = ui.fonts(|f| f.layout_job(job));
        ui.painter().galley(rect.min + vec2(0.0, BLOCK_PAD), galley, TEXT);
        if response.clicked() && ui.input(|i| i.modifiers.shift) {
            let buffer = match &self.items[index].block {
                Block::Heading { level, text } => format!("{} {text}", "#".repeat(*level as usize)),
                Block::Stage(text) => format!("*{text}*"),
                Block::Role { names, text } => format!("**{}**\n{text}", names.join("/")),
                Block::Text(text) => text.clone(),
                Block::Config(_) | Block::Cue(_) => return,
            };
            self.editing = Some(Editing { index, buffer, focused: false });
        }
    }

    /// Role name completing what has been typed so far: `(full name, missing rest)`.
    fn ghost(&self, buffer: &str) -> Option<(String, String)> {
        if buffer.is_empty() || buffer.contains('\n') || buffer.starts_with(['#', '*']) {
            return None;
        }
        let typed = buffer.to_lowercase();
        let name = self.role_names.iter().find(|n| n.to_lowercase().starts_with(&typed))?;
        let rest: String = name.chars().skip(buffer.chars().count()).collect();
        Some((name.clone(), rest))
    }

    fn draw_editor(&mut self, ui: &mut Ui, index: usize, rect: Rect) {
        let Some(mut editing) = self.editing.take() else { return };
        let id = Id::new("block-editor");
        let ghost = self.ghost(&editing.buffer);

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
        if let Some((_, rest)) = self.ghost(&editing.buffer) {
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
            self.layout_dirty = true;
        } else if commit {
            if let Some(block) = Script::parse(&editing.buffer).blocks.into_iter().next() {
                self.items[index].block = block;
            }
            self.layout_dirty = true;
        } else {
            self.editing = Some(editing);
        }
    }

    fn draw_cue(&mut self, ui: &mut Ui, index: usize, cue: &Cue, rect: Rect) {
        let panel = rect.shrink2(vec2(0.0, 4.0));
        let painter = ui.painter().clone();
        painter.rect_filled(panel, 4.0, PANEL);
        painter.rect_filled(Rect::from_min_size(panel.min, vec2(4.0, panel.height())), 0.0, ACCENT);

        let left = panel.left() + 16.0;
        let mut y = panel.top() + 10.0;
        let font = FontId::proportional(15.0);
        painter.text(pos2(left, y), Align2::LEFT_TOP, format!("Cue {}", self.items[index].cue_number), FontId::proportional(16.0), BRIGHT);
        if let Some((ch, note)) = cue.trigger_note() {
            painter.text(pos2(panel.right() - 12.0, y), Align2::RIGHT_TOP, format!("{ch}/{note}"), font.clone(), MUTED);
        }
        y += ROW;
        for (label, spans) in self.cue_rows(cue) {
            painter.text(pos2(left, y), Align2::LEFT_TOP, label, font.clone(), MUTED);
            let mut x = left + 52.0;
            for (text, colour) in spans {
                x = painter.text(pos2(x, y), Align2::LEFT_TOP, text, font.clone(), colour).right() + 10.0;
            }
            y += ROW;
        }
        if let Some(music) = cue.music() {
            let wave = Rect::from_min_size(pos2(left, y + 4.0), vec2(panel.right() - 12.0 - left, WAVE_HEIGHT));
            self.draw_waveform(ui, index, &music, wave);
        }
    }

    fn draw_waveform(&mut self, ui: &mut Ui, index: usize, music: &mdstage_core::Music, rect: Rect) {
        let painter = ui.painter().clone();
        painter.rect_filled(rect, 3.0, BACKGROUND);
        let (peaks, duration) = match self.waveforms.get(&music.file) {
            WaveState::Ready { peaks, duration } => (peaks, duration),
            WaveState::Loading => {
                painter.text(rect.center(), Align2::CENTER_CENTER, "lädt …", FontId::proportional(13.0), MUTED);
                return;
            }
            WaveState::Failed => {
                painter.text(rect.center(), Align2::CENTER_CENTER, "Audiodatei nicht lesbar", FontId::proportional(13.0), MUTED);
                return;
            }
        };
        let (mut start, mut end) = *self
            .markers
            .entry(index)
            .or_insert((music.start.unwrap_or(0.0), music.end.unwrap_or(duration).min(duration)));

        // Markers first, so a drag in this frame already moves the shading.
        let shift = ui.input(|i| i.modifiers.shift);
        let x_of = |t: f64| rect.left() + (t / duration) as f32 * rect.width();
        for which in 0..2 {
            let x = x_of(if which == 0 { start } else { end });
            let handle = Rect::from_center_size(pos2(x, rect.center().y), vec2(12.0, rect.height()));
            let response = ui.interact(handle, Id::new(("marker", index, which)), Sense::drag());
            if response.hovered() || response.dragged() {
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
                    self.markers.insert(index, (start, end));
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
            let colour = if t < start || t > end { WAVE_DIM } else { WAVE };
            let x = rect.left() + column as f32 + 0.5;
            painter.line_segment([pos2(x, mid - hi * half), pos2(x, mid - lo * half + 1.0)], Stroke::new(1.0_f32, colour));
        }
        painter.vline(x_of(start), rect.y_range(), Stroke::new(2.0_f32, MARKER));
        painter.vline(x_of(end), rect.y_range(), Stroke::new(2.0_f32, MARKER));
    }

    fn sidebar(&mut self, ui: &mut Ui) {
        ui.add_space(6.0);
        ui.label(egui::RichText::new("SZENEN").size(12.0).color(MUTED));
        let active = self
            .headings
            .iter()
            .rposition(|(i, _, _)| self.offsets.get(*i).is_some_and(|&o| o <= self.scroll_y + 1.0));
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            let mut jump = None;
            for (n, (index, level, text)) in self.headings.iter().enumerate() {
                let colour = if active == Some(n) { ACCENT } else { TEXT };
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

    fn status_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            let cues = self.items.last().map_or(0, |i| i.cue_number);
            ui.label(format!("{} Blöcke · {cues} Cues · {} sichtbar", self.items.len(), self.visible));
            ui.separator();
            ui.label(format!(
                "update {:.2} ms (max {:.2}) · Frame-CPU {:.2} ms (max {:.2}) · Layout {:.1} ms",
                self.update_ms.mean(),
                self.update_ms.max(),
                self.cpu_ms.mean(),
                self.cpu_ms.max(),
                self.layout_ms
            ));
            ui.separator();
            if ui.button("Anfang").clicked() {
                self.scroll_to = Some(0.0);
            }
            if ui.button("Mitte").clicked() {
                self.scroll_to = Some(self.offsets[self.items.len() / 2]);
            }
            if ui.button("Ende").clicked() {
                self.scroll_to = Some(self.total_height());
            }
            ui.label(egui::RichText::new("Shift+Klick: Block bearbeiten · Shift+Ziehen: Marker").color(MUTED));
        });
    }

    /// Drive the scripted scroll-through and report when it is done.
    fn step_bench(&mut self, ctx: &egui::Context, update_ms: f32, cpu_ms: Option<f32>) {
        let total = self.total_height();
        let Some(bench) = &mut self.bench else { return };
        bench.frame += 1;
        ctx.request_repaint();
        if bench.frame <= Bench::WARM_UP {
            return;
        }
        let step = bench.frame - Bench::WARM_UP;
        bench.started.get_or_insert_with(Instant::now);
        bench.update_ms.push(update_ms);
        bench.cpu_ms.extend(cpu_ms);
        if step < Bench::FRAMES {
            self.scroll_to = Some(total * step as f32 / Bench::FRAMES as f32);
            return;
        }
        let elapsed = bench.started.map_or(Duration::ZERO, |s| s.elapsed());
        let summary = |values: &mut Vec<f32>| {
            values.sort_by(f32::total_cmp);
            let mean = values.iter().sum::<f32>() / values.len().max(1) as f32;
            let p99 = values.get(values.len() * 99 / 100).copied().unwrap_or(0.0);
            format!("mean {mean:.2} ms, p99 {p99:.2} ms, max {:.2} ms", values.last().copied().unwrap_or(0.0))
        };
        println!("Script: {} blocks, {} cues, {:.0} px tall", self.items.len(), self.items.last().map_or(0, |i| i.cue_number), total);
        println!("Layout of all blocks: {:.1} ms (once per window width)", self.layout_ms);
        println!("Scrolled top to bottom in {} frames, {:.1} fps", Bench::FRAMES, Bench::FRAMES as f32 / elapsed.as_secs_f32());
        println!("  UI code per frame:        {}", summary(&mut bench.update_ms));
        println!("  CPU per frame incl. paint: {}", summary(&mut bench.cpu_ms));
        self.bench = None;
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        let started = Instant::now();
        self.waveforms.poll();
        let cpu_ms = frame.info().cpu_usage.map(|s| s * 1000.0);
        if let Some(ms) = cpu_ms {
            self.cpu_ms.push(ms);
        }

        egui::TopBottomPanel::top("status").show(ctx, |ui| self.status_bar(ui));
        egui::SidePanel::left("scenes").default_width(220.0).show(ctx, |ui| self.sidebar(ui));
        egui::CentralPanel::default().show(ctx, |ui| self.script_view(ui));

        let update_ms = started.elapsed().as_secs_f32() * 1000.0;
        self.update_ms.push(update_ms);
        self.step_bench(ctx, update_ms, cpu_ms);
    }
}

fn main() -> eframe::Result {
    let args = Args::from_env();
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([1200.0, 900.0]).with_title("MDstage – UI-Spike"),
        ..Default::default()
    };
    eframe::run_native("MDstage UI-Spike", options, Box::new(move |cc| Ok(Box::new(App::new(cc, args)))))
}
