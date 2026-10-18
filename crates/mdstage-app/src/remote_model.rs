//! The script as the remote live view shows it (see `mdstage_engine::remote`): the text
//! set as the live view sets it, and each cue's card with the rows the live view gives
//! it. Worked out here, where the live view's layout lives, and handed to the show,
//! which serves it.

use std::collections::HashMap;

use eframe::egui::Color32;
use eframe::egui::text::LayoutJob;
use mdstage_core::cues::Cues;
use mdstage_core::mic::Cast;
use mdstage_core::{Block, Script};
use mdstage_engine::session::Snapshot;
use serde_json::{Value, json};

use crate::lang::t;
use crate::script_view::{Context, ScriptView};
use crate::theme::named;

/// How much larger than in the main window text is set (as in the live view).
const SCALE: f32 = 1.3;

fn hex(colour: Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", colour.r(), colour.g(), colour.b())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\n', "<br>")
}

/// A laid-out text block as HTML: one span per stretch of one size, colour and slant.
fn html(job: &LayoutJob) -> String {
    let mut out = String::new();
    for section in &job.sections {
        let text = &job.text[section.byte_range.clone()];
        let format = &section.format;
        let slant = if format.italics { "font-style:italic;" } else { "" };
        out.push_str(&format!("<span style=\"font-size:{:.1}px;color:{};{slant}\">{}</span>", format.font_id.size, hex(format.color), escape(text)));
    }
    out
}

/// The model of the remote live view for this script, as JSON.
pub fn model(script: &Script, cast: &Cast) -> String {
    let snapshot = Snapshot::default();
    let cx = Context { script, cast, snapshot: &snapshot, locked: true, line_numbers: false, group_mics: false, can_paste: false, has_editor: false, vim: false };
    let cues = Cues::new(script);
    let numbers = ScriptView::scene_numbers(script);

    // The script in order: text, and the cards of each cue (its variants beside it).
    let mut blocks = Vec::new();
    let mut cue = 0;
    for (index, block) in script.blocks.iter().enumerate() {
        match block {
            Block::Config(_) => {}
            Block::Cue(_) => {
                if cues.group_root(cue) == cue {
                    blocks.push(json!({ "cues": cues.group(cue).collect::<Vec<usize>>() }));
                }
                cue += 1;
            }
            block => {
                if let Some(job) = ScriptView::text_job(cast, block, f32::INFINITY, SCALE, numbers.get(index).copied().flatten()) {
                    blocks.push(json!({ "html": html(&job), "heading": matches!(block, Block::Heading { .. }) }));
                }
            }
        }
    }

    let cards: Vec<Value> = (0..cues.len())
        .map(|index| {
            let (Some(c), Some(block)) = (cues.get(index), cues.block_index(index)) else { return Value::Null };
            let rows: Vec<Value> = ScriptView::cue_rows(&cx, block, index, c, &HashMap::new())
                .into_iter()
                .map(|row| json!({ "label": row.label, "spans": row.spans.iter().map(|(text, colour)| json!([text, hex(*colour)])).collect::<Vec<_>>() }))
                .collect();
            json!({
                "name": cues.name(index),
                "label": ScriptView::name_with_file(&cues, index),
                "summary": crate::live::summary(script, index),
                "auto": c.auto_trigger().is_some(),
                "rows": rows,
            })
        })
        .collect();

    // The show's progress: one segment per act or scene, as wide as it has cues.
    let mut segments: Vec<(u8, String, usize, usize)> = vec![(0, String::new(), 0, 0)];
    let mut count = 0;
    for block in &script.blocks {
        match block {
            Block::Heading { level, text } if *level <= 2 => segments.push((*level, text.clone(), count, 0)),
            Block::Cue(_) => {
                count += 1;
                segments.last_mut().expect("there is always one").3 += 1;
            }
            _ => {}
        }
    }

    // Colours of the microphones' names and of the devices.
    let mut colours: HashMap<String, String> = HashMap::new();
    for name in cast.roles.iter().map(|role| &role.name).chain(cast.groups.iter().map(|group| &group.name)) {
        colours.insert(name.clone(), hex(ScriptView::role_colour(cast, name)));
    }
    let declared = script.config().and_then(|c| c.get("outputDevices")).and_then(|d| d.as_sequence()).cloned().unwrap_or_default();
    let devices: HashMap<String, String> = declared
        .iter()
        .filter_map(|d| Some((d.get("name")?.as_str()?.to_string(), hex(named(d.get("color").and_then(|c| c.as_str()))?))))
        .collect();

    json!({
        "blocks": blocks,
        "cues": cards,
        "segments": segments,
        "colours": colours,
        "devices": devices,
        "text": {
            "current": t("aktuell", "current"),
            "pin": t("PIN für die Remote-Liveansicht", "PIN for the remote live view"),
            "wrongPin": t("Falsche PIN.", "Wrong PIN."),
            "wait": t("Zu viele falsche Versuche – bitte eine Minute warten.", "Too many wrong tries – please wait a minute."),
            "offline": t("Keine Verbindung zu MDstage – es wird neu verbunden …", "No connection to MDstage – reconnecting …"),
            "noControls": t("Die Steuerung von hier ist in MDstage ausgeschaltet.", "Control from here is switched off in MDstage."),
            "question": t("MDstage wartet am Rechner auf die Wahl einer Variante für das Tracking.", "MDstage waits at the computer for a variant to be chosen for tracking."),
            "chooseVariant": t("Erst eine Variante wählen: auf ihre Karte tippen.", "Choose a variant first: tap its card."),
            "blocked": t("Ein Cue wird gerade von selbst ausgelöst – Go wartet.", "A cue is about to fire by itself – Go waits."),
            "mics": t("Mikros", "Mics"),
            "micsOff": t("Mikros aus", "Mics off"),
            "empty": t("leer", "empty"),
            "as": t("wie", "as"),
            "ringing": t("klingt aus", "ringing out"),
            "send": t("OK", "OK"),
        },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_holds_the_script_and_the_cards() {
        let script = Script::parse("```yaml\nconfig:\n    roles:\n        Anna: {color: blue}\n```\n\n# Akt <1>\n\n**Anna**\nHallo & so.\n\n```yaml\ntrigger_note: {ch: 1, note: 1}\nmic: Anna\nmusic: a.wav\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 2}\nsibling: true\n```\n");
        let cast = Cast::from_script(&script, false);
        let model: Value = serde_json::from_str(&model(&script, &cast)).unwrap();
        let blocks = model["blocks"].as_array().unwrap();
        assert!(blocks[0]["heading"].as_bool().unwrap() && blocks[0]["html"].as_str().unwrap().contains("Akt &lt;1&gt;"), "text is escaped");
        assert!(blocks[1]["html"].as_str().unwrap().contains("Hallo &amp; so."));
        assert_eq!(blocks[2]["cues"], json!([0, 1]), "a cue and its variant stand together");
        assert_eq!(model["cues"][0]["label"], "Cue 1.1 (a)");
        assert!(model["cues"][0]["rows"].as_array().unwrap().iter().any(|row| row["spans"].to_string().contains("a.wav")));
        assert!(model["colours"]["Anna"].as_str().unwrap().starts_with('#'));
    }
}
