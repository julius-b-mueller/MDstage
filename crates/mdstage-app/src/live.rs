//! The live view: current and next cue, Go and Back, timecode, running audio,
//! microphones and display clients — for the operator's or the stage monitor.

use eframe::egui::{self, Color32, RichText, Ui};
use mdstage_core::cues::Cues;
use mdstage_core::mic::{Mic, MicChip};
use mdstage_core::{Block, Script};
use mdstage_engine::clock::VoiceState;
use mdstage_engine::mtc::Timecode;
use mdstage_engine::session::Request;

use crate::script_view::Context;
use crate::lang::t;
use crate::theme::*;

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

fn cue_card(ui: &mut Ui, cx: &Context, title: &str, cue: Option<usize>, accent: Color32, size: f32) {
    egui::Frame::new().fill(PANEL).corner_radius(6).inner_margin(14).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(RichText::new(title).size(12.0).color(MUTED));
        match cue {
            Some(cue) => {
                ui.label(RichText::new(format!("Cue {}", cue + 1)).size(size).color(accent).strong());
                let text = summary(cx.script, cue);
                if !text.is_empty() {
                    ui.label(RichText::new(text).size(size * 0.5).color(TEXT));
                }
            }
            None => {
                ui.label(RichText::new("—").size(size).color(MUTED));
            }
        }
    });
}

/// Draw the live view. Returns the requests the operator made.
pub fn show(ui: &mut Ui, cx: &Context) -> Vec<Request> {
    let mut requests = Vec::new();
    let snapshot = cx.snapshot;

    ui.horizontal(|ui| {
        let go = egui::Button::new(RichText::new("GO").size(30.0).color(Color32::BLACK).strong()).fill(GREEN).min_size(egui::vec2(170.0, 72.0));
        if ui.add_enabled(snapshot.next.is_some(), go).clicked() {
            requests.push(Request::Go);
        }
        let back = egui::Button::new(RichText::new("Back").size(20.0)).min_size(egui::vec2(110.0, 72.0));
        if ui.add(back).clicked() {
            requests.push(Request::Back);
        }
        ui.add_space(16.0);
        ui.vertical(|ui| {
            ui.label(RichText::new("TIMECODE").size(12.0).color(MUTED));
            let text = snapshot.timecode.map_or("--:--:--:--".to_string(), timecode);
            ui.label(RichText::new(text).size(34.0).monospace().color(if snapshot.timecode.is_some() { BRIGHT } else { MUTED }));
        });
    });
    ui.add_space(8.0);

    let pending = snapshot.pending_outros.first().map(|&(_, outro)| outro);
    cue_card(ui, cx, t("AKTUELL", "CURRENT"), snapshot.current, GREEN, 40.0);
    ui.add_space(6.0);
    let next_title = if pending.is_some() { t("NÄCHSTER — wartet auf Loop-Ende", "NEXT — waiting for loop end") } else { t("NÄCHSTER", "NEXT") };
    cue_card(ui, cx, next_title, pending.or(snapshot.next), YELLOW, 30.0);

    // Variants of the next cue: choose which one Go fires.
    if let Some(next) = snapshot.next {
        let group = Cues::new(cx.script).group(next);
        if group.len() > 1 {
            ui.add_space(6.0);
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(t("Variante:", "Variant:")).color(MUTED));
                for cue in group.clone() {
                    let text = summary(cx.script, cue);
                    let label = if text.is_empty() { format!("Cue {}", cue + 1) } else { format!("Cue {} · {text}", cue + 1) };
                    if ui.selectable_label(cue == next, label).clicked() {
                        requests.push(Request::SelectVariant((cue != group.start).then_some(cue)));
                    }
                }
            });
        }
    }

    ui.add_space(10.0);
    ui.label(RichText::new("AUDIO").size(12.0).color(MUTED));
    let sounding: Vec<_> = snapshot.audio.iter().filter(|(_, s)| matches!(s.state, VoiceState::Playing | VoiceState::Tail)).collect();
    if sounding.is_empty() {
        ui.label(RichText::new(t("nichts läuft", "nothing playing")).color(MUTED));
    }
    for (cue, status) in sounding {
        // A loop's bar cycles between its start and its loop point.
        let (from, to) = if status.state == VoiceState::Tail { (status.transition, status.end) } else { (status.start, status.transition) };
        let fraction = if to > from { ((status.seconds - from) / (to - from)).clamp(0.0, 1.0) } else { 0.0 };
        ui.horizontal(|ui| {
            ui.label(format!("Cue {}", cue + 1));
            let label = if status.state == VoiceState::Tail { t("klingt aus", "ringing out").to_string() } else { format!("{:.1} / {:.1} s", status.seconds - from, to - from) };
            ui.add(egui::ProgressBar::new(fraction as f32).text(label).desired_width(ui.available_width() - 70.0));
            if ui.small_button("Stop").clicked() {
                requests.push(Request::Fire(*cue));
            }
        });
    }
    for delay in &snapshot.delays {
        ui.horizontal(|ui| {
            ui.label(format!("Cue {} ⏱", delay.target + 1));
            ui.add(egui::ProgressBar::new(delay.fraction as f32).text("Auto-Cue").desired_width(ui.available_width() - 70.0));
        });
    }

    ui.add_space(10.0);
    ui.label(RichText::new(t("MIKROFONE", "MICROPHONES")).size(12.0).color(MUTED));
    ui.horizontal_wrapped(|ui| match &snapshot.mic {
        None => {
            ui.label(RichText::new(t("noch nicht gesetzt", "not set yet")).color(MUTED));
        }
        Some(Mic::MuteAll) => {
            ui.label(RichText::new(t("alle aus", "all off")).color(RED));
        }
        Some(mic) => {
            for chip in cx.cast.chips(mic, false) {
                if let MicChip::Role { name, color } = chip {
                    ui.label(RichText::new(name).color(named(color.as_deref()).unwrap_or(BRIGHT)).strong());
                }
            }
        }
    });

    if !snapshot.display_clients.is_empty() {
        ui.add_space(10.0);
        ui.label(RichText::new("DISPLAYS").size(12.0).color(MUTED));
        ui.horizontal_wrapped(|ui| {
            for client in &snapshot.display_clients {
                let name = if client.name.is_empty() { client.slug.clone() } else { format!("{} ({})", client.name, client.slug) };
                ui.label(RichText::new("●").color(if client.connected { GREEN } else { RED }));
                ui.label(name);
            }
        });
    }
    requests
}
