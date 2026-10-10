//! The live view, laid out like the one the operators know: clock, timecode and display
//! clients at the top; a bar with what the devices and microphones were last told; the
//! script itself, large, always scrolled so the next cue sits a little below the middle;
//! the audio that is playing; how far the show has come; and Back and Go across the bottom.

use std::collections::HashMap;

use eframe::egui::{self, Align2, Color32, CornerRadius, FontId, Id, Rect, RichText, Sense, Stroke, Ui, pos2, vec2};
use mdstage_core::cues::{Cues, DeviceKind, DeviceState, History};
use mdstage_core::mic::{Mic, MicChip};
use mdstage_core::yaml::Value;
use mdstage_core::{Block, Script};
use mdstage_engine::clock::VoiceState;
use mdstage_engine::mtc::Timecode;
use mdstage_engine::session::Request;

use crate::lang::t;
use crate::script_view::{Context, ScriptView};
use crate::theme::*;

/// Left and right margin of the script.
const MARGIN: f32 = 28.0;
/// Space between two blocks of the script.
const GAP: f32 = 14.0;
/// How much larger than in the main window text is set.
const SCALE: f32 = 1.3;
const HEADER: Color32 = Color32::from_rgb(0x21, 0x25, 0x2b);
const INFO: Color32 = Color32::from_rgb(0x1c, 0x20, 0x28);
const AUDIO: Color32 = Color32::from_rgb(0x2c, 0x31, 0x3a);
const TRACK: Color32 = Color32::from_rgb(0x38, 0x3c, 0x44);
const NEXT_FILL: Color32 = Color32::from_rgb(0x1e, 0x24, 0x30);
const PURPLE: Color32 = Color32::from_rgb(0xc6, 0x78, 0xdd);
/// The light around the next cue: how bright it is right at the card, over how many
/// pixels it has fallen to about a third, and where it stops being drawn.
const GLOW_STRENGTH: f32 = 0.30;
const GLOW_SOFTNESS: f32 = 8.0;
const GLOW_REACH: usize = 20;

fn timecode(seconds: f64) -> String {
    Timecode::from_frames((seconds * 25.0).floor().max(0.0) as u64).to_string()
}

/// One line that tells a cue apart: its note, audio, or the text around it.
fn summary(script: &Script, cue: usize) -> String {
    let cues = Cues::new(script);
    let Some(c) = cues.get(cue) else { return String::new() };
    let mut parts: Vec<String> = Vec::new();
    parts.extend(c.text("note").map(str::to_string));
    if let Some(audio) = c.audio() {
        parts.push(format!("♬ {}", audio.parts[0].audios[0].file));
    }
    if parts.is_empty() {
        // Nothing of its own to show: the line spoken right after it.
        let after = cues.block_index(cue).map_or(&[][..], |b| &script.blocks[b + 1..]);
        let line = after.iter().find_map(|b| match b {
            Block::Role { names, text } => Some(format!("{}: {}", names.join("/"), text.lines().next().unwrap_or_default())),
            Block::Stage(text) => Some(text.clone()),
            Block::Cue(_) => Some(String::new()),
            _ => None,
        });
        parts.extend(line.filter(|l| !l.is_empty()));
    }
    parts.join("  ·  ")
}

/// A rounded label: a name on a tint of its own colour.
fn chip(ui: &mut Ui, text: &str, colour: Color32, size: f32) {
    egui::Frame::new().fill(colour.gamma_multiply(0.16)).corner_radius(CornerRadius::same(4)).inner_margin(egui::Margin::symmetric(7, 1)).show(ui, |ui| {
        ui.label(RichText::new(text).size(size).color(colour).strong());
    });
}

fn mic_chips(ui: &mut Ui, cx: &Context, mic: &Mic, size: f32) {
    let colour = |color: &Option<String>| named(color.as_deref()).unwrap_or(BRIGHT);
    for entry in cx.cast.chips(mic, cx.group_mics) {
        match entry {
            MicChip::Role { name, color } => chip(ui, &name, colour(&color), size),
            MicChip::Group { name, color, members } => {
                egui::Frame::new().stroke(Stroke::new(1.0_f32, WAVE_DIM)).corner_radius(CornerRadius::same(5)).inner_margin(egui::Margin::symmetric(3, 1)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    ui.label(RichText::new(name).size(size).color(colour(&color)).strong());
                    for (member, color) in members {
                        chip(ui, &member, colour(&color), size - 1.0);
                    }
                });
            }
        }
    }
}

/// What a device was last told, in a few characters.
fn device_summary(state: &DeviceState, kind: DeviceKind) -> String {
    let text = |value: Option<&Value>| match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    match state {
        DeviceState::Display(markdown) => markdown.lines().find(|l| !l.trim().is_empty()).unwrap_or("—").trim_start_matches(['#', ' ']).to_string(),
        DeviceState::Messages(messages) => {
            let one = |m: &Value| {
                let comment = text(m.get("comment"));
                if !comment.is_empty() {
                    return comment;
                }
                if kind != DeviceKind::Midi {
                    return format!("{} {}", text(m.get("path")), text(m.get("arg"))).trim().to_string();
                }
                match m.get("type").and_then(Value::as_str).unwrap_or("note") {
                    "cc" => format!("CC{}={}", text(m.get("cc")), text(m.get("value"))),
                    "pc" => format!("PC{}", text(m.get("program"))),
                    "sysex" => "SysEx".to_string(),
                    _ => format!("N{}", text(m.get("note"))),
                }
            };
            messages.iter().map(one).collect::<Vec<_>>().join(", ")
        }
    }
}

/// A flat progress bar.
fn bar(ui: &mut Ui, width: f32, height: f32, fraction: f32, colour: Color32) {
    let (rect, _) = ui.allocate_exact_size(vec2(width.max(8.0), height), Sense::hover());
    ui.painter().rect_filled(rect, height / 2.0, TRACK);
    let filled = Rect::from_min_size(rect.min, vec2(rect.width() * fraction.clamp(0.0, 1.0), height));
    ui.painter().rect_filled(filled, height / 2.0, colour);
}

/// The live view's own state: the heights of the script's blocks at the width it was
/// last drawn at.
#[derive(Default)]
pub struct LiveView {
    heights: Vec<f32>,
    width: f32,
    dirty: bool,
}

impl LiveView {
    /// The script changed: measure it again.
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    /// Draw the live view into its window. Returns the requests the operator made.
    pub fn show(&mut self, ctx: &egui::Context, cx: &Context) -> Vec<Request> {
        let mut requests = Vec::new();
        let snapshot = cx.snapshot;
        let panel = |fill, x, y| egui::Frame::new().fill(fill).inner_margin(egui::Margin::symmetric(x, y));
        let pending = snapshot.pending_outros.first().copied();

        egui::TopBottomPanel::top("live-header").frame(panel(HEADER, 18, 8)).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 16.0;
                readout(ui, &chrono::Local::now().format("%H:%M:%S").to_string(), 34.0, TEXT);
                let running = snapshot.timecode.is_some();
                readout(ui, &snapshot.timecode.map_or("--:--:--:--".to_string(), timecode), 22.0, if running { YELLOW } else { MUTED });
                // Who is watching the displays.
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    for client in snapshot.display_clients.iter().rev() {
                        let colour = if client.connected { GREEN } else { RED };
                        egui::Frame::new().fill(Color32::from_rgb(0x2a, 0x2f, 0x38)).corner_radius(CornerRadius::same(8)).inner_margin(egui::Margin::symmetric(7, 2)).show(ui, |ui| {
                            ui.spacing_mut().item_spacing.x = 5.0;
                            let name = if client.name.is_empty() { client.slug.clone() } else { client.name.clone() };
                            ui.label(RichText::new(name).size(13.0).color(if client.connected { BRIGHT } else { MUTED }));
                            ui.label(RichText::new("●").size(11.0).color(colour));
                        });
                    }
                });
            });
        });

        // What the devices were last told by the cues fired so far, and the microphones.
        let cues = Cues::new(cx.script);
        let mut history = History::default();
        snapshot.fired.iter().for_each(|&cue| history.push(cue, false));
        let states = history.device_states(&cues);
        if !states.is_empty() || snapshot.mic.is_some() {
            let declared = cx.script.config().and_then(|c| c.get("outputDevices")).and_then(|d| d.as_sequence()).cloned().unwrap_or_default();
            let colour_of = |device: &str| declared.iter().find(|d| d.get("name").and_then(|n| n.as_str()) == Some(device)).and_then(|d| named(d.get("color").and_then(|c| c.as_str())));
            egui::TopBottomPanel::top("live-info").frame(panel(INFO, 18, 7)).show(ctx, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    for ((kind, device), state) in &states {
                        let colour = colour_of(device);
                        ui.label(RichText::new(device.to_uppercase()).size(11.0).color(colour.unwrap_or(WAVE_DIM)));
                        ui.label(RichText::new(device_summary(state, *kind)).size(16.0).strong().color(colour.unwrap_or(BRIGHT)));
                        ui.add(egui::Separator::default().vertical().spacing(12.0));
                    }
                    ui.label(RichText::new("MIC").size(11.0).color(WAVE_DIM));
                    match &snapshot.mic {
                        None => drop(ui.label(RichText::new("—").color(MUTED))),
                        Some(Mic::MuteAll) => drop(ui.label(RichText::new(t("alle aus", "all off")).size(16.0).italics().color(RED))),
                        Some(mic) => mic_chips(ui, cx, mic, 15.0),
                    }
                });
            });
        }

        // From the bottom up: the buttons, the show's progress, the audio that plays.
        egui::TopBottomPanel::bottom("live-controls").frame(panel(HEADER, 18, 12)).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 14.0;
                let height = 58.0;
                let back = egui::Button::new(RichText::new("◀ Back").size(21.0).strong().color(TEXT)).fill(TRACK).stroke(Stroke::NONE).corner_radius(CornerRadius::same(8)).min_size(vec2(180.0, height));
                if ui.add(back).on_hover_text(t("Rücktaste", "Backspace")).clicked() {
                    requests.push(Request::Back);
                }
                // While an outro waits for its loop's end there is nothing for Go to do.
                let ready = snapshot.next.is_some() && pending.is_none();
                let go = egui::Button::new(RichText::new("Go ▶").size(21.0).strong().color(if ready { Color32::from_rgb(0x1e, 0x21, 0x27) } else { MUTED }))
                    .fill(if ready { GREEN } else { TRACK })
                    .stroke(Stroke::NONE)
                    .corner_radius(CornerRadius::same(8))
                    .min_size(vec2(ui.available_width(), height));
                if ui.add_enabled(ready, go).on_hover_text(t("Leertaste", "Space")).clicked() {
                    requests.push(Request::Go);
                }
            });
        });
        self.progress(ctx, cx);
        self.audio(ctx, cx, &cues, &mut requests);

        egui::CentralPanel::default().frame(egui::Frame::new().fill(BACKGROUND)).show(ctx, |ui| self.script(ui, cx, &cues, &mut requests));
        requests
    }

    /// How far the show has come: the act and scene the operator is in, and one segment
    /// per scene, as wide as it has cues, filled as far as they have been passed.
    fn progress(&mut self, ctx: &egui::Context, cx: &Context) {
        // (heading level, title, first cue, number of cues)
        let mut segments: Vec<(u8, String, usize, usize)> = vec![(0, String::new(), 0, 0)];
        let mut cue = 0;
        for block in &cx.script.blocks {
            match block {
                Block::Heading { level, text } if *level <= 2 => segments.push((*level, text.clone(), cue, 0)),
                Block::Cue(_) => {
                    cue += 1;
                    segments.last_mut().expect("there is always one").3 += 1;
                }
                _ => {}
            }
        }
        if cue == 0 {
            return;
        }
        let at = cx.snapshot.current;
        let active = at.and_then(|at| segments.iter().rposition(|s| s.2 <= at && s.0 > 0));
        let (act, scene) = match active.map(|i| &segments[i]) {
            Some((2, title, ..)) => (segments[..active.unwrap_or(0)].iter().rev().find(|s| s.0 == 1).map(|s| s.1.as_str()), Some(title.as_str())),
            Some((_, title, ..)) => (Some(title.as_str()), None),
            None => (None, None),
        };
        egui::TopBottomPanel::bottom("live-progress").frame(egui::Frame::new().fill(Color32::from_rgb(0x27, 0x2b, 0x32)).inner_margin(egui::Margin::symmetric(14, 8))).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new(act.unwrap_or_default()).size(14.0).color(TEXT));
                ui.label(RichText::new(scene.unwrap_or_default()).size(14.0).color(MUTED));
            });
            let filled: Vec<&(u8, String, usize, usize)> = segments.iter().filter(|s| s.3 > 0).collect();
            let gap = 3.0;
            let width = ui.available_width() - gap * (filled.len().saturating_sub(1)) as f32;
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 5.0), Sense::hover());
            let mut x = rect.left();
            for (_, title, first, count) in filled {
                let segment = Rect::from_min_size(pos2(x, rect.top()), vec2((width * *count as f32 / cue as f32).max(3.0), 5.0));
                ui.painter().rect_filled(segment, 2.5, TRACK);
                let done = at.map_or(0, |at| (at + 1).saturating_sub(*first).min(*count));
                if done > 0 {
                    let part = Rect::from_min_size(segment.min, vec2(segment.width() * done as f32 / *count as f32, 5.0));
                    ui.painter().rect_filled(part, 2.5, Color32::from_white_alpha(128));
                }
                if !title.is_empty() && ui.rect_contains_pointer(segment.expand(4.0)) {
                    egui::show_tooltip_at_pointer(ui.ctx(), ui.layer_id(), Id::new("live-segment"), |ui| ui.label(title));
                }
                x += segment.width() + gap;
            }
        });
    }

    /// One row per audio that is playing: what it is, where it stands, a stop button.
    fn audio(&mut self, ctx: &egui::Context, cx: &Context, cues: &Cues, requests: &mut Vec<Request>) {
        let sounding: Vec<_> = cx.snapshot.audio.iter().filter(|(_, s)| matches!(s.state, VoiceState::Playing | VoiceState::Tail)).collect();
        if sounding.is_empty() {
            return;
        }
        egui::TopBottomPanel::bottom("live-audio").frame(egui::Frame::new().fill(AUDIO).inner_margin(egui::Margin::symmetric(18, 9))).show(ctx, |ui| {
            for (cue, status) in sounding {
                let looped = cues.get(*cue).is_some_and(|c| c.loop_outro().is_some() || c.audio().is_some_and(|a| a.looped || a.parts.len() > 1));
                // A loop's bar cycles between its start and its loop point.
                let tail = status.state == VoiceState::Tail;
                let (from, to) = if tail { (status.transition, status.end) } else { (status.start, status.transition) };
                let fraction = if to > from { ((status.seconds - from) / (to - from)).clamp(0.0, 1.0) } else { 0.0 };
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 10.0;
                    let label_width = (ui.available_width() * 0.3).clamp(120.0, 300.0);
                    ui.allocate_ui_with_layout(vec2(label_width, 22.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
                        ui.set_width(label_width);
                        if looped {
                            egui::Frame::new().stroke(Stroke::new(1.0_f32, PURPLE.gamma_multiply(0.4))).corner_radius(CornerRadius::same(3)).inner_margin(egui::Margin::symmetric(4, 0)).show(ui, |ui| {
                                ui.label(RichText::new("⟳ Loop").size(12.0).color(PURPLE));
                            });
                        }
                        ui.add(egui::Label::new(RichText::new(format!("Cue {}  {}", cue + 1, summary(cx.script, *cue))).size(16.0).color(TEXT)).truncate());
                    });
                    let time = if tail { t("klingt aus", "ringing out").to_string() } else { format!("{:.1} / {:.1} s", status.seconds - from, to - from) };
                    let colour = if looped { PURPLE } else { GREEN };
                    bar(ui, ui.available_width() - 150.0, 10.0, fraction as f32, if tail { colour.gamma_multiply(0.45) } else { colour });
                    ui.label(RichText::new(time).size(14.0).monospace().color(MUTED));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.add(egui::Button::new(RichText::new("×").size(18.0).color(MUTED)).frame(false)).on_hover_text(t("Stoppen", "Stop")).clicked() {
                            requests.push(Request::StopCue(*cue));
                        }
                    });
                });
            }
        });
    }

    /// The rows of a cue card and its height at a type size.
    fn card_height(rows: usize, size: f32) -> f32 {
        2.0 * 14.0 + (size + 9.0) + rows as f32 * (size + 7.0)
    }

    /// Measure every block for the width. Text is laid out; cue cards are counted in rows.
    /// The variants of a cue stand side by side in the place of the first.
    fn measure(&mut self, ui: &Ui, cx: &Context, cues: &Cues, width: f32) {
        let none = HashMap::new();
        let mut cue = 0;
        self.heights = cx
            .script
            .blocks
            .iter()
            .map(|block| match block {
                Block::Config(_) => 0.0,
                Block::Cue(_) => {
                    let this = cue;
                    cue += 1;
                    let group = cues.group(this);
                    if group.start != this {
                        return 0.0;
                    }
                    let rows = group.clone().filter_map(|c| Some(ScriptView::cue_rows(cx, cues.block_index(c)?, c, cues.get(c)?, &none).len())).max().unwrap_or(0);
                    Self::card_height(rows, 16.0) + GAP
                }
                block => ScriptView::text_job(cx.cast, block, width, SCALE).map_or(0.0, |job| ui.fonts(|f| f.layout_job(job)).size().y + GAP),
            })
            .collect();
        self.width = width;
        self.dirty = false;
    }

    /// The script, moved so that the next cue sits at about two thirds of the height.
    fn script(&mut self, ui: &mut Ui, cx: &Context, cues: &Cues, requests: &mut Vec<Request>) {
        let area = ui.available_rect_before_wrap();
        let width = (area.width() - 2.0 * MARGIN).max(200.0);
        if self.dirty || self.heights.len() != cx.script.blocks.len() || (width - self.width).abs() > 0.5 {
            self.measure(ui, cx, cues, width);
        }
        let snapshot = cx.snapshot;
        let pending = snapshot.pending_outros.first().map(|&(_, outro)| outro);
        let next = pending.or(snapshot.next);
        // The next cue's card is drawn larger; everything below it moves down by that much.
        let next_root = next.map(|c| cues.group(c).start);
        let anchor = next_root.or(snapshot.current.map(|c| cues.group(c).start)).and_then(|c| cues.block_index(c));
        let none = HashMap::new();
        let big = next_root.and_then(|root| {
            let rows = cues.group(root).filter_map(|c| Some(ScriptView::cue_rows(cx, cues.block_index(c)?, c, cues.get(c)?, &none).len())).max()?;
            Some(Self::card_height(rows, 21.0) + GAP)
        });
        let next_block = next_root.and_then(|c| cues.block_index(c));
        let height_of = |index: usize| match (big, next_block == Some(index)) {
            (Some(big), true) => big,
            _ => self.heights[index],
        };

        let before: f32 = anchor.map_or(0.0, |a| (0..a).map(height_of).sum());
        let anchor_height = anchor.map_or(0.0, height_of);
        // Where the top of the script has to be for the anchor to sit at 65 % of the height.
        let target = area.top() + area.height() * 0.65 - before - (anchor_height - GAP) / 2.0;
        let top = ui.ctx().animate_value_with_time(Id::new("live-scroll"), target, 0.45);

        let painter = ui.painter().with_clip_rect(area);
        let mut y = top;
        let mut cue = 0;
        for (index, block) in cx.script.blocks.iter().enumerate() {
            let height = height_of(index);
            let this_cue = matches!(block, Block::Cue(_)).then(|| {
                cue += 1;
                cue - 1
            });
            let rect = Rect::from_min_size(pos2(area.left() + MARGIN, y), vec2(width, (height - GAP).max(0.0)));
            y += height;
            if height == 0.0 || rect.bottom() < area.top() || rect.top() > area.bottom() {
                continue;
            }
            match (block, this_cue) {
                (Block::Cue(_), Some(root)) => self.cards(ui, cx, cues, root, rect, requests),
                (block, _) => {
                    if let Some(job) = ScriptView::text_job(cx.cast, block, width, SCALE) {
                        let galley = ui.fonts(|f| f.layout_job(job));
                        if let Block::Heading { .. } = block {
                            painter.rect_filled(rect.expand2(vec2(MARGIN, 5.0)), 0.0, BAR);
                        }
                        painter.galley(rect.min, galley, TEXT);
                    }
                }
            }
        }
    }

    /// The card of a cue, or the cards of its variants side by side.
    fn cards(&self, ui: &mut Ui, cx: &Context, cues: &Cues, root: usize, rect: Rect, requests: &mut Vec<Request>) {
        let snapshot = cx.snapshot;
        let group = cues.group(root);
        let pending = snapshot.pending_outros.first().map(|&(_, outro)| outro);
        let next = pending.or(snapshot.next);
        let group_is_next = next.is_some_and(|n| group.contains(&n));
        let variants = group.len();
        let chosen = snapshot.selected_variant.filter(|v| group.contains(v));
        let gap = 12.0;
        let each = (rect.width() - gap * (variants - 1) as f32) / variants as f32;
        for (place, cue) in group.clone().enumerate() {
            let card = Rect::from_min_size(pos2(rect.left() + place as f32 * (each + gap), rect.top()), vec2(each, rect.height()));
            // Variants of the next cue: all blink until one is chosen, then the others dim.
            let alpha = match (variants > 1 && group_is_next, chosen) {
                (true, None) => 0.72 + 0.28 * (ui.input(|i| i.time) * std::f64::consts::TAU).cos() as f32,
                (true, Some(chosen)) if chosen != cue => 0.35,
                _ => 1.0,
            };
            if variants > 1 && group_is_next {
                ui.ctx().request_repaint();
                let response = ui.interact(card, Id::new(("live-variant", cue)), Sense::click());
                if response.on_hover_text(t("Diese Variante für das nächste Go wählen", "Choose this variant for the next Go")).clicked() {
                    requests.push(Request::SelectVariant(Some(cue)));
                }
            }
            self.card(ui, cx, cues, cue, card, group_is_next, alpha);
        }
    }

    /// One cue card.
    #[allow(clippy::too_many_arguments)]
    fn card(&self, ui: &mut Ui, cx: &Context, cues: &Cues, cue: usize, rect: Rect, is_next: bool, alpha: f32) {
        let snapshot = cx.snapshot;
        let (Some(c), Some(block)) = (cues.get(cue), cues.block_index(cue)) else { return };
        let painter = ui.painter().with_clip_rect(ui.clip_rect());
        let tint = |colour: Color32| colour.gamma_multiply(alpha);
        let is_current = snapshot.current == Some(cue);
        let fired = snapshot.fired.contains(&cue);
        let size = if is_next { 21.0 } else { 16.0 };

        if is_next {
            // This is what Go fires: a soft white light around the card. Drawn as one
            // fine ring per pixel, each a little fainter than the one inside it along a
            // bell curve, so the light thins out evenly and ends without an edge.
            let radius = CornerRadius::same(8);
            painter.add(egui::Shadow { offset: [0, 0], blur: 10, spread: 0, color: Color32::from_black_alpha((160.0 * alpha) as u8) }.as_shape(rect, radius));
            for step in 0..GLOW_REACH {
                let distance = step as f32 + 0.5;
                let strength = GLOW_STRENGTH * (-(distance / GLOW_SOFTNESS).powi(2)).exp();
                let ring = Stroke::new(1.0_f32, Color32::from_white_alpha((255.0 * strength * alpha).round() as u8));
                painter.rect_stroke(rect.expand(distance), 8.0 + distance, ring, egui::StrokeKind::Middle);
            }
            painter.rect_filled(rect, radius, tint(NEXT_FILL));
            painter.rect_stroke(rect, radius, Stroke::new(1.5_f32, tint(Color32::from_white_alpha(217))), egui::StrokeKind::Inside);
        } else {
            painter.rect_filled(rect, 6.0, tint(PANEL));
            let stripe = if is_current { YELLOW } else if fired { WAVE_DIM } else { BLUE };
            painter.rect_filled(Rect::from_min_size(rect.min, vec2(5.0, rect.height())), 2.0, tint(stripe));
        }

        let left = rect.left() + 18.0;
        let mut y = rect.top() + 14.0;
        let title = painter.text(pos2(left, y), Align2::LEFT_TOP, format!("Cue {}", cue + 1), FontId::proportional(size + 2.0), tint(BRIGHT));
        let sounding = snapshot.audio.iter().any(|(a, s)| *a == cue && matches!(s.state, VoiceState::Playing | VoiceState::Tail));
        let mut x = title.right() + 12.0;
        if is_current {
            x = painter.text(pos2(x, y + 2.0), Align2::LEFT_TOP, t("● aktuell", "● current"), FontId::proportional(size - 3.0), tint(YELLOW)).right() + 10.0;
        }
        if sounding {
            painter.text(pos2(x, y + 2.0), Align2::LEFT_TOP, "♪", FontId::proportional(size - 2.0), tint(GREEN));
        }
        if let Some(note) = c.note() {
            painter.text(pos2(rect.right() - 16.0, y + 2.0), Align2::RIGHT_TOP, note.to_string(), FontId::proportional(size - 3.0), tint(MUTED));
        }
        y += size + 9.0;
        for (label, spans) in ScriptView::cue_rows(cx, block, cue, c, &HashMap::new()) {
            painter.text(pos2(left, y), Align2::LEFT_TOP, label, FontId::proportional(size - 2.0), tint(MUTED));
            let mut x = left + size * 3.6;
            for (text, colour) in spans {
                x = painter.text(pos2(x, y), Align2::LEFT_TOP, text, FontId::proportional(size), tint(colour)).right() + 8.0;
            }
            y += size + 7.0;
        }

        // What the cue is waiting for: its loop's end, or its auto-cue's delay.
        let waiting = snapshot.pending_outros.iter().find(|(_, outro)| *outro == cue).and_then(|(looped, _)| {
            let status = snapshot.audio.iter().find(|(a, _)| a == looped)?.1;
            Some((((status.seconds - status.start) / (status.transition - status.start).max(0.001)) as f32, YELLOW))
        });
        let delayed = snapshot.delays.iter().find(|d| d.target == cue).map(|d| (d.fraction as f32, GREEN));
        if let Some((fraction, colour)) = waiting.or(delayed) {
            let track = Rect::from_min_size(pos2(left, rect.bottom() - 9.0), vec2(rect.right() - 16.0 - left, 4.0));
            painter.rect_filled(track, 2.0, tint(AUDIO));
            painter.rect_filled(Rect::from_min_size(track.min, vec2(track.width() * fraction.clamp(0.0, 1.0), 4.0)), 2.0, tint(colour));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdstage_core::mic::Cast;
    use mdstage_engine::player::Status;
    use mdstage_engine::session::Snapshot;
    use mdstage_engine::show::DelayProgress;

    /// The live view draws every state a show goes through without falling over, and its
    /// buttons ask for what they say.
    #[test]
    fn draws_through_a_show() {
        let text = "```yaml\nconfig:\n    roles:\n        Anna: {color: blue, ch: 1}\n        Ben: {color: green, ch: 2}\n    groups:\n        Duo: {color: purple, roles: [Anna, Ben]}\n```\n\n# Akt 1\n\n```yaml\ntrigger_note: {ch: 1, note: 1}\nmic: Duo\nnote: Auftritt\nmusic:\n    file: loop.wav\n    loop: true\nloop_outro: {ch: 1, note: 2}\ncue_midi:\n    - {device: Licht, type: cc, ch: 1, cc: 7, value: 64}\ncue_display:\n    - {device: Foyer, markdown: \"# Eins\"}\n```\n\n**Anna**\nHallo *(leise)* du.\n\n## Szene 2\n\n*Licht aus.*\n\n```yaml\ntrigger_note: {ch: 1, note: 2}\nmusic: out.wav\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 3}\nsibling: true\nmic: muteall\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 4}\nauto_trigger:\n    trigger_note: {ch: 1, note: 2}\n    delay: 2\n```\n";
        let script = Script::parse(text);
        let cast = Cast::from_script(&script, false);
        let playing = Status { state: VoiceState::Playing, part: 0, seconds: 3.0, start: 0.0, transition: 8.0, end: 10.0 };
        let states = [
            Snapshot { next: Some(0), ..Default::default() },
            Snapshot { fired: vec![0], current: Some(0), next: Some(1), mic: Some(Mic::Open(vec!["Duo".into()])), audio: vec![(0, playing)], timecode: Some(3661.5), ..Default::default() },
            Snapshot { fired: vec![0], current: Some(0), next: Some(2), selected_variant: Some(2), pending_outros: vec![(0, 1)], audio: vec![(0, Status { state: VoiceState::Tail, ..playing })], ..Default::default() },
            Snapshot { fired: vec![0, 1], current: Some(1), next: Some(3), mic: Some(Mic::MuteAll), delays: vec![DelayProgress { target: 3, fraction: 0.4 }], ..Default::default() },
            Snapshot { fired: vec![0, 1, 3], current: Some(3), next: None, ..Default::default() },
        ];
        let mut live = LiveView::default();
        let ctx = egui::Context::default();
        crate::theme::apply(&ctx);
        for snapshot in &states {
            let cx = Context { script: &script, cast: &cast, snapshot, locked: false, line_numbers: false, group_mics: true, has_editor: false, can_paste: false };
            for _ in 0..2 {
                let mut asked = None;
                let _ = ctx.run(egui::RawInput { screen_rect: Some(Rect::from_min_size(pos2(0.0, 0.0), vec2(900.0, 700.0))), ..Default::default() }, |ctx| asked = Some(live.show(ctx, &cx)));
                assert_eq!(asked.map(|requests| requests.len()), Some(0), "nothing is asked for without a click");
            }
        }
        // Every block has been measured, and the second variant takes no room of its own.
        assert_eq!(live.heights.len(), script.blocks.len());
        let cue_heights: Vec<bool> = script.blocks.iter().zip(&live.heights).filter(|(b, _)| matches!(b, Block::Cue(_))).map(|(_, h)| *h > 0.0).collect();
        assert_eq!(cue_heights, [true, true, false, true]);
    }

    #[test]
    fn devices_are_summed_up_briefly() {
        let messages = |yaml: &str| DeviceState::Messages(mdstage_core::Script::parse(&format!("```yaml\ncue_x:\n{yaml}\n```\n")).blocks.iter().find_map(|b| match b {
            Block::Cue(cue) => cue.yaml.get("cue_x").and_then(Value::as_sequence).cloned(),
            _ => None,
        }).unwrap());
        assert_eq!(device_summary(&messages("    - {type: cc, cc: 7, value: 64}\n    - {type: note, note: 60}\n    - {type: pc, program: 5, comment: Szene 5}"), DeviceKind::Midi), "CC7=64, N60, Szene 5");
        assert_eq!(device_summary(&messages("    - {path: /go, arg: 0.8}\n    - {path: /stop}"), DeviceKind::Osc), "/go 0.8, /stop");
        assert_eq!(device_summary(&DeviceState::Display("\n# Szene 3\nText".into()), DeviceKind::Display), "Szene 3");
        assert_eq!(device_summary(&DeviceState::Display(String::new()), DeviceKind::Display), "—");
    }
}
