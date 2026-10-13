//! MDstage: the interactive prompt book.
//!
//!     mdstage [SHOW.md]
//!
//! Without an argument the last show is opened again.

// No console window next to the app on Windows.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod cue_dialog;
mod cue_forms;
mod export;
mod lang;
mod live;
mod pointer;
mod roles_ui;
mod script_view;
mod settings_ui;
mod store;
mod theme;
mod vim;
mod waveform;

use std::path::{Path, PathBuf};
use std::time::Duration;

use eframe::egui::{self, Color32, Key, KeyboardShortcut, Modifiers, RichText};
use mdstage_core::cues::Cues;
use mdstage_core::mic::Cast;
use mdstage_core::validate::Report;
use mdstage_core::{Block, Script};
use mdstage_engine::mtc::Timecode;
use mdstage_engine::session::{Request, Session, Snapshot};
use mdstage_engine::settings::Settings;

use cue_dialog::CueDialog;
use roles_ui::RolesUi;
use script_view::{Action, Context, Link, ScriptView};
use settings_ui::SettingsUi;
use theme::*;

struct OpenShow {
    path: PathBuf,
    script: Script,
    cast: Cast,
    session: Session,
    /// Whether the file may send to devices (see `store::Loaded::trusted`).
    trusted: bool,
    report: Report,
    /// What opening changed in the file.
    notes: Vec<String>,
    /// Another version of MDstage saved the file last (`Some(None)`: it does not say
    /// which). Before this version saves it as its own, the operator is asked.
    saved_by_other: Option<Option<String>>,
}

/// This version of MDstage, as it is noted in show files.
const VERSION: &str = env!("CARGO_PKG_VERSION");

struct App {
    settings: Settings,
    show: Option<OpenShow>,
    snapshot: Snapshot,
    view: ScriptView,
    live_open: bool,
    /// Audio files no cue uses, waiting for the operator to confirm moving them away.
    unused_audio: Option<Vec<String>>,
    about_open: bool,
    live: live::LiveView,
    /// The file just opened was saved by another version: tell the operator once.
    version_notice: Option<Option<String>>,
    /// An edit is waiting to be saved into a file of another version: ask first.
    upgrade_prompt: bool,
    /// An audio file to rename (`from`, `to`) once that question is answered with yes.
    pending_rename: Option<(String, String)>,
    /// Audio files a cue has just swapped for others while further cues still use
    /// them: `(old, new, how many cues)`. The operator is asked whether those follow.
    swap_prompt: Option<Vec<(String, String, usize)>>,
    /// Where the pointer is while files are dragged over the window, if the system says.
    drag_at: Option<egui::Pos2>,
    /// Files dropped onto the window, the pointer position known then, and when.
    pending_drop: Option<(Vec<PathBuf>, Option<egui::Pos2>, std::time::Instant)>,
    /// Problem lines the operator chose not to see any more (this session).
    ignored: Vec<String>,
    /// What "Clean up YAML" would remove (`(YAML block, key)`), waiting to be confirmed.
    cleanup: Option<Vec<(usize, String)>>,
    /// A connection between two cues whose details are being asked for.
    link_dialog: Option<LinkDialog>,
    /// Auto-Mic is about to be switched on for this block while cues still name
    /// microphones by hand: the operator is asked what to do with those.
    auto_mic_prompt: Option<usize>,
    settings_ui: Option<SettingsUi>,
    cue_dialog: Option<CueDialog>,
    roles_ui: Option<RolesUi>,
    /// The export dialog's options (and whether to print trigger times), while it is open.
    export: Option<(mdstage_core::export::Options, bool)>,
    /// A copied cue's fields, for pasting.
    copied: Option<mdstage_core::yaml::Value>,
    /// Show lock: no editing, clicks only arm.
    locked: bool,
    /// Something that went wrong in the app itself (a file that could not be written …).
    message: Option<String>,
    followed: Option<usize>,
    /// The cue whose playhead was last moved on its waveform: the space bar plays and
    /// pauses its audio until a cue fires.
    space_cue: Option<usize>,
    /// How many cues had fired when the view last followed one that fired by itself.
    followed_fired: usize,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, path: Option<PathBuf>) -> App {
        theme::apply(&cc.egui_ctx);
        egui_extras::install_image_loaders(&cc.egui_ctx);
        let settings = Settings::load(&store::settings_path());
        // The first look at the MIDI ports is taken here, on the main thread: on macOS
        // the system only tells of devices plugged in later to a program whose first
        // MIDI client was made on a thread with a run loop.
        let _ = mdstage_engine::inputs::Inputs::port_names();
        lang::set_english(settings.language == "en");
        let settings_open_locked = settings.open_locked;
        let last = settings.recent_files.first().map(PathBuf::from).filter(|p| p.exists());
        let mut app = App {
            settings,
            show: None,
            snapshot: Snapshot::default(),
            view: ScriptView::default(),
            live_open: false,
            unused_audio: None,
            about_open: false,
            live: Default::default(),
            version_notice: None,
            upgrade_prompt: false,
            pending_rename: None,
            swap_prompt: None,
            drag_at: None,
            pending_drop: None,
            ignored: Vec::new(),
            cleanup: None,
            link_dialog: None,
            auto_mic_prompt: None,
            settings_ui: None,
            cue_dialog: None,
            roles_ui: None,
            export: None,
            copied: None,
            locked: settings_open_locked,
            message: None,
            followed: None,
            space_cue: None,
            followed_fired: 0,
        };
        if let Some(path) = path.or(last) {
            app.open(&path, &cc.egui_ctx);
        }
        app
    }

    fn english(&self) -> bool {
        self.settings.language == "en"
    }

    /// German or English, by the language setting.
    fn t<'a>(&self, german: &'a str, english: &'a str) -> &'a str {
        if self.english() { english } else { german }
    }

    /// A device was switched on or off, or the outputs blocked: keep it and tell the show.
    fn devices_changed(&mut self) {
        self.save_settings();
        if let Some(trusted) = self.show.as_ref().map(|s| s.trusted) {
            self.request(Request::Configure(Box::new(self.settings.clone()), trusted));
        }
    }

    fn save_settings(&mut self) {
        if let Err(e) = self.settings.save(&store::settings_path()) {
            self.message = Some(format!("{}: {e}", lang::t("Einstellungen nicht gespeichert", "Settings not saved")));
        }
    }

    fn open(&mut self, path: &Path, ctx: &egui::Context) {
        // Close the running show first: it holds the audio device and the display port.
        self.show = None;
        self.snapshot = Snapshot::default();
        self.followed = None;
        let loaded = match store::load(path, &mut self.settings) {
            Ok(loaded) => loaded,
            Err(e) => {
                self.message = Some(format!("{}: {e}", path.display()));
                return;
            }
        };
        let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let session = match Session::start(loaded.script.clone(), dir.clone(), self.settings.clone(), loaded.trusted) {
            Ok(session) => session,
            Err(e) => {
                self.message = Some(format!("{}: {e}", lang::t("Show nicht gestartet", "Show not started")));
                return;
            }
        };
        self.view.reset(dir.join("audio"), ctx);
        self.live.invalidate();
        let file_version = loaded.script.app_version();
        let saved_by_other = (file_version.as_deref() != Some(VERSION)).then_some(file_version);
        let saved_by_other_shown = saved_by_other.clone();
        self.upgrade_prompt = false;
        self.show = Some(OpenShow {
            path: path.to_path_buf(),
            cast: Cast::from_script(&loaded.script, self.english()),
            report: loaded.script.validate(),
            script: loaded.script,
            session,
            trusted: loaded.trusted,
            notes: loaded.notes,
            saved_by_other,
        });
        self.version_notice = saved_by_other_shown;
        // Where the operator had got to in this show the last time: go on from there.
        if let (Some(&cue), Some(show)) = (self.settings.next_cue.get(path.to_string_lossy().as_ref()), &self.show) {
            if cue > 0 && cue < Cues::new(&show.script).len() {
                show.session.send(Request::Arm(Some(cue)));
            }
        }
        store::remember(path, &mut self.settings);
        self.save_settings();
        ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!("MDstage — {}", path.file_name().unwrap_or_default().to_string_lossy())));
    }

    fn open_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new().add_filter("Markdown", &["md"]).pick_file() {
            self.open(&path, ctx);
        }
    }

    fn new_dialog(&mut self, ctx: &egui::Context) {
        let Some(path) = rfd::FileDialog::new().add_filter("Markdown", &["md"]).set_file_name("skript.md").save_file() else { return };
        match store::create(&path, &mut self.settings) {
            Ok(()) => self.open(&path, ctx),
            Err(e) => self.message = Some(format!("{}: {e}", path.display())),
        }
    }

    fn request(&self, request: Request) {
        if let Some(show) = &self.show {
            show.session.send(request);
        }
    }

    /// The script was edited: check it, write the file and tell the running show.
    fn after_edit(&mut self) {
        let english = self.english();
        let Some(show) = &mut self.show else { return };
        show.cast = Cast::from_script(&show.script, english);
        show.report = show.script.validate();
        if show.saved_by_other.is_some() {
            // Nothing is written into a file of another version before the operator
            // has agreed; until then the edit only exists in this window.
            self.upgrade_prompt = true;
            self.view.invalidate();
            return;
        }
        if let Err(e) = store::save(&show.path, &show.script, &mut self.settings, show.trusted) {
            self.message = Some(format!("{}: {e}", lang::t("Nicht gespeichert", "Not saved")));
        }
        show.session.send(Request::SetScript(Box::new(show.script.clone())));
        self.view.invalidate();
        self.live.invalidate();
        self.save_settings();
    }

    /// Change the cue in `block` and save.
    fn edit_cue(&mut self, block: usize, change: impl FnOnce(&mut mdstage_core::yaml::Mapping)) {
        let Some(Block::Cue(cue)) = self.show.as_mut().and_then(|s| s.script.blocks.get_mut(block)) else { return };
        let mut yaml = cue.yaml.clone();
        let Some(map) = yaml.as_mapping_mut() else { return };
        change(map);
        cue.set_yaml(yaml);
        self.after_edit();
    }

    /// While a connection was being set up for the cue in `block`, the cue `other` was
    /// clicked: make the connection, or ask for what is still open.
    fn link_picked(&mut self, link: Link, block: usize, other: usize) {
        let Some(show) = &self.show else { return };
        let cues = Cues::new(&show.script);
        let Some(note) = cues.get(other).and_then(|c| c.note()) else { return };
        // A variant never fires by itself (the operator has to choose which one is
        // taken): nothing carries straight on into one, and none is made an auto-cue.
        let other_in_group = cues.in_group(other);
        let block_in_group = (0..cues.len()).find(|&cue| cues.block_index(cue) == Some(block)).is_some_and(|cue| cues.in_group(cue));
        let refused = match link {
            Link::Chain if other_in_group => Some(lang::t(
                "Nicht verbunden: In eine Variante geht nichts nahtlos über, denn welche genommen wird, wählt der Operator. Als Outro eines Loops geht es.",
                "Not connected: nothing carries straight on into a variant, as the operator chooses which one is taken. As a loop's outro it works.",
            )),
            Link::AutoCue if block_in_group => Some(lang::t(
                "Nicht gesetzt: Eine Variante wird nie von selbst ausgelöst, denn welche genommen wird, wählt der Operator.",
                "Not set: a variant never fires by itself, as the operator chooses which one is taken.",
            )),
            _ => None,
        };
        if let Some(why) = refused {
            self.message = Some(why.to_string());
            return;
        }
        match link {
            Link::Chain => self.edit_cue(block, |map| drop(map.insert("chain_end".into(), note_value(note)))),
            Link::LoopOutro => self.edit_cue(block, |map| drop(map.insert("loop_outro".into(), note_value(note)))),
            Link::AutoCue => {
                // Where the source's audio stands, paused or playing, is where the cue fires.
                let paused = self.snapshot.paused.iter().find(|(c, _)| *c == other).map(|(_, seconds)| *seconds);
                let playing = self.snapshot.audio.iter().find(|(c, s)| *c == other && s.part == 0).map(|(_, s)| s.seconds);
                // A place that would put this source's auto-cues out of the order they stand
                // in is not taken.
                let cues = Cues::new(&show.script);
                let target = (0..cues.len()).find(|&cue| cues.block_index(cue) == Some(block));
                let range = target.map_or((None, None), |target| cues.auto_range(target, other, true));
                let out_of_order = paused.or(playing).is_some_and(|at| range.0.is_some_and(|from| at < from) || range.1.is_some_and(|to| at > to));
                if out_of_order {
                    let seconds = |value: Option<f64>| value.map_or("…".to_string(), mdstage_core::format::seconds);
                    self.message = Some(if lang::english() {
                        format!("Not set: this source's auto-cues fire in the order they stand in the script. The place has to lie between {} and {} s.", seconds(range.0), seconds(range.1))
                    } else {
                        format!("Nicht gesetzt: Die Auto-Cues dieser Quelle lösen in der Reihenfolge aus, in der sie im Skript stehen. Die Stelle muss zwischen {} und {} s liegen.", seconds(range.0), seconds(range.1))
                    });
                    return;
                }
                match paused.or(playing) {
                    Some(at) => self.edit_cue(block, |map| {
                        let mut auto = serde_yaml_mapping();
                        auto.insert("trigger_note".into(), note_value(note));
                        auto.insert("at".into(), ((at * 1000.0).round() / 1000.0).into());
                        map.insert("auto_trigger".into(), auto.into());
                    }),
                    None => self.link_dialog = Some(LinkDialog::Delay { block, source: note, seconds: 5.0, at_place: true, in_group: other_in_group, whole_group: true }),
                }
            }
            Link::Adjust => {
                let existing = show.script.blocks.get(block).and_then(|b| match b {
                    Block::Cue(cue) => cue.adjust().filter(|a| a.target == note),
                    _ => None,
                });
                self.link_dialog = Some(LinkDialog::Adjust {
                    block,
                    target: note,
                    fadeout: existing.as_ref().is_none_or(|a| a.fadeout),
                    volume: existing.as_ref().and_then(|a| a.volume).unwrap_or(0.3),
                    fadetime: existing.as_ref().and_then(|a| a.fadetime).unwrap_or(3.0),
                });
            }
        }
    }

    fn link_window(&mut self, ctx: &egui::Context) {
        let Some(mut dialog) = self.link_dialog.take() else { return };
        // For an auto-cue: the place in the source's audio that the time typed in would
        // be, if the source has audio that long.
        let place = match &dialog {
            LinkDialog::Delay { source, seconds, .. } => self.show.as_ref().and_then(|show| {
                let cues = Cues::new(&show.script);
                let audio = cues.get(cues.find(*source)?)?.audio()?;
                let part = audio.parts.first()?;
                let length = self.view.duration(&part.audios.first()?.file)?;
                let start = part.start.unwrap_or(0.0);
                let end = part.end.unwrap_or(length).min(length);
                (start + seconds < end).then_some(start + seconds)
            }),
            LinkDialog::Adjust { .. } => None,
        };
        // The auto-cues of one source fire in the order they stand in the script: the
        // seconds that keep it so, as a delay and as a place in the source's audio.
        let between = |range: (Option<f64>, Option<f64>), start: f64| ((range.0.unwrap_or(start) - start).max(0.0), range.1.map_or(36000.0, |to| to - start));
        let (delay_range, place_range) = match &dialog {
            LinkDialog::Delay { block, source, .. } => self.show.as_ref().and_then(|show| {
                let cues = Cues::new(&show.script);
                let target = (0..cues.len()).find(|&cue| cues.block_index(cue) == Some(*block))?;
                let from = cues.find(*source)?;
                let start = cues.get(from)?.audio().and_then(|audio| audio.parts.first()?.start).unwrap_or(0.0);
                Some((between(cues.auto_range(target, from, false), 0.0), between(cues.auto_range(target, from, true), start)))
            }),
            LinkDialog::Adjust { .. } => None,
        }
        .unwrap_or(((0.0, 36000.0), (0.0, 36000.0)));
        let mut open = true;
        let mut result = None;
        let title = match dialog {
            LinkDialog::Delay { .. } => lang::t("Verzögerung wählen", "Choose a delay"),
            LinkDialog::Adjust { .. } => lang::t("Bezug konfigurieren", "Set up the adjustment"),
        };
        egui::Window::new(title).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            match &mut dialog {
                LinkDialog::Delay { seconds, at_place, in_group, whole_group, .. } => {
                    ui.label(lang::t(
                        "Das Audio der Quelle steht an keiner Stelle. Nach welcher Zeit soll der Cue ausgelöst werden?",
                        "The source's audio is not standing anywhere. After what time is the cue to fire?",
                    ));
                    // What the time may be depends on which of the two kinds below it is.
                    let (from, to) = if *at_place && place.is_some() { place_range } else { delay_range };
                    if from <= to {
                        *seconds = seconds.clamp(from, to);
                        ui.add(egui::DragValue::new(seconds).speed(0.1).range(from..=to).suffix(" s"));
                        if from > 0.0 || to < 36000.0 {
                            let seconds = mdstage_core::format::seconds;
                            let text = match (from > 0.0, to < 36000.0, lang::english()) {
                                (true, true, false) => format!("Zwischen {} und {} s: Die Auto-Cues dieser Quelle lösen in der Reihenfolge aus, in der sie im Skript stehen.", seconds(from), seconds(to)),
                                (true, false, false) => format!("Mindestens {} s: Die Auto-Cues dieser Quelle lösen in der Reihenfolge aus, in der sie im Skript stehen.", seconds(from)),
                                (false, _, false) => format!("Höchstens {} s: Die Auto-Cues dieser Quelle lösen in der Reihenfolge aus, in der sie im Skript stehen.", seconds(to)),
                                (true, true, true) => format!("Between {} and {} s: this source's auto-cues fire in the order they stand in the script.", seconds(from), seconds(to)),
                                (true, false, true) => format!("At least {} s: this source's auto-cues fire in the order they stand in the script.", seconds(from)),
                                (false, _, true) => format!("At most {} s: this source's auto-cues fire in the order they stand in the script.", seconds(to)),
                            };
                            ui.label(RichText::new(text).color(MUTED));
                        }
                    } else {
                        ui.add(egui::DragValue::new(seconds).speed(0.1).range(0.0..=36000.0).suffix(" s"));
                    }
                    ui.add_space(4.0);
                    // The choice only exists while the time lies within the source's audio.
                    ui.add_enabled_ui(place.is_some(), |ui| {
                        ui.radio_value(at_place, true, lang::t("An dieser Stelle im Audio der Quelle (Marke in der Wellenform)", "At that place in the source's audio (marker on the waveform)"))
                            .on_hover_text(lang::t("Löst aus, sobald das Audio der Quelle die Stelle erreicht: bei einem Loop in jedem Durchgang, und auch nach einem Sprung in der Wellenform.", "Fires when the source's audio reaches the place: on every pass of a loop, and after a jump on the waveform too."));
                        ui.radio_value(at_place, false, lang::t("Einmal, mit Verzögerung nach dem Start der Quelle", "Once, with a delay after the source starts"))
                            .on_hover_text(lang::t("Zählt ab dem Auslösen der Quelle und löst genau einmal aus, was auch immer ihr Audio tut.", "Counts from the firing of the source and fires exactly once, whatever its audio does."));
                    });
                    if place.is_none() {
                        ui.label(RichText::new(lang::t("Die Quelle hat kein Audio, das so lang ist: Der Cue wird einmal mit Verzögerung ausgelöst.", "The source has no audio that long: the cue fires once, with a delay.")).color(MUTED));
                    }
                    // A delay on a source with variants: from whichever variant, or from this one.
                    if *in_group {
                        ui.add_space(4.0);
                        ui.label(lang::t("Die Quelle hat Varianten.", "The source has variants."));
                        let delayed = !(*at_place && place.is_some());
                        ui.add_enabled_ui(delayed, |ui| {
                            ui.radio_value(whole_group, true, lang::t("Verzögerung an der ganzen Gruppe: egal, welche Variante ausgelöst wird", "Delay on the whole group: whichever variant is fired"));
                            ui.radio_value(whole_group, false, lang::t("Verzögerung nur an dieser Variante", "Delay on this variant only"));
                        });
                        if !delayed {
                            ui.label(RichText::new(lang::t("Eine Stelle im Audio gehört immer zu der einen Variante, in deren Wellenform sie liegt.", "A place in the audio always belongs to the one variant whose waveform it lies in.")).color(MUTED));
                        }
                    }
                }
                LinkDialog::Adjust { fadeout, volume, fadetime, .. } => {
                    ui.radio_value(fadeout, true, lang::t("Ausfaden (stoppen)", "Fade out (stop)"));
                    ui.horizontal(|ui| {
                        ui.radio_value(fadeout, false, lang::t("Lautstärke auf", "Volume to"));
                        ui.add_enabled(!*fadeout, egui::Slider::new(volume, 0.0..=1.0).custom_formatter(|v, _| format!("{:.0} %", v * 100.0)));
                    });
                    ui.horizontal(|ui| {
                        ui.label(lang::t("Fadezeit", "Fade time"));
                        ui.add(egui::DragValue::new(fadetime).speed(0.1).range(0.0..=600.0).suffix(" s"));
                    });
                }
            }
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("OK").clicked() {
                    result = Some(true);
                }
                if ui.button(lang::t("Abbrechen", "Cancel")).clicked() {
                    result = Some(false);
                }
            });
        });
        match (result, dialog) {
            (Some(true), LinkDialog::Delay { block, source, seconds, at_place, in_group, whole_group }) => {
                // At the place in the source's audio (with its marker on the waveform, as
                // if it had been set from the playhead), or once after a delay.
                let place = place.filter(|_| at_place);
                self.edit_cue(block, |map| {
                    let mut auto = serde_yaml_mapping();
                    auto.insert("trigger_note".into(), note_value(source));
                    let (key, value) = match place {
                        Some(at) => ("at", at),
                        None => ("delay", seconds),
                    };
                    auto.insert(key.into(), ((value * 1000.0).round() / 1000.0).into());
                    if in_group && whole_group && place.is_none() {
                        auto.insert("group".into(), true.into());
                    }
                    map.insert("auto_trigger".into(), auto.into());
                });
            }
            (Some(true), LinkDialog::Adjust { block, target, fadeout, volume, fadetime }) => self.edit_adjust(block, |music| {
                let mut adjust = serde_yaml_mapping();
                adjust.insert("trigger_note".into(), note_value(target));
                match fadeout {
                    true => drop(adjust.insert("fadeout".into(), true.into())),
                    false => drop(adjust.insert("volume".into(), ((volume * 100.0).round() / 100.0).into())),
                }
                adjust.insert("fadetime".into(), ((fadetime * 1000.0).round() / 1000.0).into());
                music.insert("adjust".into(), adjust.into());
            }),
            (None, dialog) if open => self.link_dialog = Some(dialog),
            _ => {}
        }
    }

    /// Asked when the first cue is switched to Auto-Mic while others name microphones.
    fn auto_mic_window(&mut self, ctx: &egui::Context) {
        let Some(block) = self.auto_mic_prompt else { return };
        let mut open = true;
        let mut choice = None;
        let mut cancelled = false;
        egui::Window::new("Auto-Mic").open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(lang::t("Wenn Auto-Mic aktiv ist, werden manuell gesetzte Mikrofone ignoriert.", "While auto mic is in use, microphones chosen by hand are ignored."));
            ui.add_space(6.0);
            if ui.button(lang::t("Manuelle Mikros behalten (aber ignorieren)", "Keep the manual microphones (but ignore them)")).clicked() {
                choice = Some(false);
            }
            if ui.button(lang::t("Manuelle Mikrofone aus allen Cues entfernen", "Remove the manual microphones from all cues")).clicked() {
                choice = Some(true);
            }
            cancelled = ui.button(lang::t("Abbrechen", "Cancel")).clicked();
        });
        open &= !cancelled;
        if let Some(remove) = choice {
            self.auto_mic_prompt = None;
            if let (true, Some(show)) = (remove, &mut self.show) {
                for cue in show.script.blocks.iter_mut().filter_map(|b| match b {
                    Block::Cue(cue) if !cue.invalid && cue.yaml.get("mic").is_some() => Some(cue),
                    _ => None,
                }) {
                    let mut yaml = cue.yaml.clone();
                    if let Some(map) = yaml.as_mapping_mut() {
                        map.shift_remove("mic");
                    }
                    cue.set_yaml(yaml);
                }
            }
            self.edit_cue(block, |map| drop(map.insert("auto_mic".into(), true.into())));
        } else if !open {
            self.auto_mic_prompt = None;
        }
    }

    /// Change the `music` entry of the cue in `block` and save. The short form
    /// `music: file.wav` becomes the object form first, so it can hold more.
    /// Change what a cue does to another cue's audio. It is stored under `music`, which a
    /// cue without audio of its own gets for it and loses again when nothing is left there.
    fn edit_adjust(&mut self, block: usize, change: impl FnOnce(&mut mdstage_core::yaml::Mapping)) {
        self.edit_cue(block, |map| {
            if let Some(file) = map.get("music").and_then(|m| m.as_str()).map(str::to_string) {
                let mut music = serde_yaml_mapping();
                music.insert("file".into(), file.into());
                map.insert("music".into(), music.into());
            }
            if !map.contains_key("music") {
                map.insert("music".into(), serde_yaml_mapping().into());
            }
            if let Some(music) = map.get_mut("music").and_then(|m| m.as_mapping_mut()) {
                change(music);
            }
            if map.get("music").and_then(|m| m.as_mapping()).is_some_and(|music| music.is_empty()) {
                map.shift_remove("music");
            }
        });
    }

    fn edit_music(&mut self, block: usize, change: impl FnOnce(&mut mdstage_core::yaml::Mapping)) {
        let Some(Block::Cue(cue)) = self.show.as_mut().and_then(|s| s.script.blocks.get_mut(block)) else { return };
        let mut yaml = cue.yaml.clone();
        let Some(map) = yaml.as_mapping_mut() else { return };
        if let Some(file) = map.get("music").and_then(|m| m.as_str()).map(str::to_string) {
            let mut music = serde_yaml_mapping();
            music.insert("file".into(), file.into());
            map.insert("music".into(), music.into());
        }
        let Some(music) = map.get_mut("music").and_then(|m| m.as_mapping_mut()) else { return };
        change(music);
        cue.set_yaml(yaml);
        self.after_edit();
    }

    fn apply(&mut self, actions: Vec<Action>) {
        for action in actions {
            match &action {
                // With the live view open a click only chooses the next Go.
                Action::Fire(cue) if self.live_open => self.request(Request::Arm(Some(*cue))),
                // A cue started by a click is not the space bar's to pause.
                Action::Fire(cue) => {
                    self.space_cue = None;
                    self.request(Request::Fire(*cue));
                }
                Action::Arm(cue) => self.request(Request::Arm(Some(*cue))),
                Action::EditCue(block) | Action::NewCue(block) => {
                    let block = *block;
                    let Some(show) = &self.show else { continue };
                    let existing = match (&action, show.script.blocks.get(block)) {
                        (Action::EditCue(_), Some(Block::Cue(cue))) => Some(&cue.yaml),
                        _ => None,
                    };
                    // Auto-Mic on any *other* cue rules out choosing microphones by hand.
                    let others_auto = show.script.blocks.iter().enumerate().any(|(i, b)| matches!(b, Block::Cue(c) if c.auto_mic() && (i != block || existing.is_none())));
                    let audio_dir = show.path.parent().unwrap_or(Path::new(".")).join("audio");
                    // The other cues, for linking to them (S/L/F, auto-cue, adjust).
                    let mut links = Vec::new();
                    for (i, b) in show.script.blocks.iter().enumerate() {
                        let Block::Cue(cue) = b else { continue };
                        let Some(note) = cue.note().filter(|_| i != block || existing.is_none()) else { continue };
                        let what = cue.text("note").map(str::to_string).or_else(|| cue.audio().map(|a| a.parts[0].audios[0].file.clone())).unwrap_or_default();
                        links.push((note, format!("Cue {note}  {what}").trim_end().to_string()));
                    }
                    let mut devices = cue_forms::Devices::default();
                    for device in &self.settings.devices {
                        match device {
                            mdstage_engine::settings::DeviceSetting::Midi { name, .. } => devices.midi.push(name.clone()),
                            mdstage_engine::settings::DeviceSetting::Osc { name, .. } => devices.osc.push(name.clone()),
                            mdstage_engine::settings::DeviceSetting::Http { name, .. } => devices.http.push(name.clone()),
                            mdstage_engine::settings::DeviceSetting::Display { name, .. } => devices.display.push(name.clone()),
                        }
                    }
                    // The notes other cues have: this one must not take one of them. The
                    // variants of the cue being edited share its note and do not count.
                    let cues = Cues::new(&show.script);
                    let own_group: Vec<usize> = match existing {
                        Some(_) => (0..cues.len()).find(|&c| cues.block_index(c) == Some(block)).map(|c| cues.group(c).collect()).unwrap_or_default(),
                        None => Vec::new(),
                    };
                    let taken: Vec<mdstage_core::cues::Note> = (0..cues.len()).filter(|c| !own_group.contains(c)).filter_map(|c| cues.get(c)?.note()).collect();
                    self.cue_dialog = Some(CueDialog::new(block, existing.is_none(), existing, &audio_dir, others_auto, links).with_setup(show.script.virtual_channels(), devices).with_taken(taken));
                }
                Action::InsertCue(at) => {
                    if let Some(show) = &mut self.show {
                        let cue = show.script.new_cue(serde_yaml_mapping().into());
                        show.script.insert_block(*at, cue);
                    }
                    self.after_edit();
                }
                Action::NewText(at) => {
                    let at = *at;
                    if let Some(show) = &mut self.show {
                        show.script.insert_block(at, Block::Text(String::new()));
                        self.view.edit(&show.script, at, true);
                    }
                }
                Action::Move { block, up } => {
                    let mut refused = false;
                    if let Some(show) = &mut self.show {
                        // A move that would put auto-cues out of the order they fire in
                        // is not made.
                        let before = show.script.clone();
                        let conflicts = Cues::new(&before).auto_order_conflicts().len();
                        show.script.move_block(*block, *up);
                        if Cues::new(&show.script).auto_order_conflicts().len() > conflicts {
                            show.script = before;
                            refused = true;
                        }
                    }
                    match refused {
                        true => self.message = Some(lang::t("Nicht verschoben: Die Auto-Cues einer Quelle stehen in der Reihenfolge, in der sie auslösen. Erst die Zeit des Auto-Cues ändern, dann verschieben.", "Not moved: a source's auto-cues stand in the order they fire in. Change the auto-cue's time first, then move it.").to_string()),
                        false => self.after_edit(),
                    }
                }
                Action::Delete(block) => {
                    if let Some(show) = &mut self.show {
                        show.script.delete_block(*block);
                    }
                    self.after_edit();
                }
                Action::Copy(block) => {
                    if let Some(Block::Cue(cue)) = self.show.as_ref().and_then(|s| s.script.blocks.get(*block)) {
                        self.copied = Some(cue.yaml.clone());
                    }
                }
                Action::Paste(at) => {
                    let (Some(show), Some(mut fields)) = (&mut self.show, self.copied.clone()) else { continue };
                    // A pasted cue stands on its own: fresh trigger note, not a variant.
                    if let Some(map) = fields.as_mapping_mut() {
                        map.shift_remove("trigger_note");
                        map.shift_remove("sibling");
                    }
                    let cue = show.script.new_cue(fields);
                    show.script.insert_block(*at, cue);
                    self.after_edit();
                }
                Action::Variant(block) => {
                    let Some(show) = &mut self.show else { continue };
                    if let Some(variant) = show.script.copy_cue(*block, true) {
                        show.script.insert_block(*block + 1, variant);
                        self.after_edit();
                    }
                }
                Action::Replace { block, with } => {
                    if let Some(show) = &mut self.show {
                        show.script.blocks[*block] = with.clone();
                    }
                    self.after_edit();
                }
                Action::Markers { block, marks } => {
                    let marks = *marks;
                    let milliseconds = |seconds: f64| (seconds * 1000.0).round() / 1000.0;
                    self.edit_music(*block, |music| {
                        music.insert("start".into(), milliseconds(marks.start).into());
                        music.insert("end".into(), milliseconds(marks.end).into());
                        if marks.crossfade {
                            // One length for both ends; it stays even at 0, which is
                            // what says that the loop is of this kind.
                            music.insert("crossfade".into(), milliseconds(marks.fadein).into());
                            return;
                        }
                        for (key, seconds) in [("fadein", marks.fadein), ("fadeout", marks.fadeout)] {
                            match seconds >= 0.001 {
                                true => drop(music.insert(key.into(), milliseconds(seconds).into())),
                                false => drop(music.shift_remove(key)),
                            }
                        }
                    });
                }
                Action::SetMarkers { block, markers } => {
                    let mut markers = markers.clone();
                    markers.sort_by(|a, b| a.0.total_cmp(&b.0));
                    let list: Vec<mdstage_core::yaml::Value> = markers
                        .into_iter()
                        .map(|(at, name)| {
                            let mut entry = serde_yaml_mapping();
                            entry.insert("at".into(), ((at * 1000.0).round() / 1000.0).into());
                            if !name.is_empty() {
                                entry.insert("name".into(), name.into());
                            }
                            entry.into()
                        })
                        .collect();
                    self.edit_music(*block, |music| match list.is_empty() {
                        true => drop(music.shift_remove("markers")),
                        false => drop(music.insert("markers".into(), mdstage_core::yaml::Value::Sequence(list))),
                    });
                }
                // A variant group's volume: each variant's own volume counts times it.
                Action::LiveGroupVolume { block, volume } | Action::GroupVolume { block, volume } => {
                    let (block, volume) = (*block, (*volume * 100.0).round() / 100.0);
                    let mut sounding = Vec::new();
                    if let Some(show) = &self.show {
                        let cues = Cues::new(&show.script);
                        if let Some(root) = (0..cues.len()).find(|&cue| cues.block_index(cue) == Some(block)) {
                            for member in cues.group(root) {
                                let own = cues.get(member).and_then(|c| c.audio()).and_then(|a| a.parts.first().map(|p| p.volume));
                                if let Some(own) = own.filter(|_| self.snapshot.audio.iter().any(|(c, _)| *c == member)) {
                                    sounding.push((member, own * volume));
                                }
                            }
                        }
                    }
                    for (cue, volume) in sounding {
                        self.request(Request::Volume(cue, volume));
                    }
                    if matches!(action, Action::GroupVolume { .. }) {
                        self.edit_cue(block, |map| match volume >= 0.995 {
                            true => drop(map.shift_remove("group_volume")),
                            false => drop(map.insert("group_volume".into(), volume.into())),
                        });
                    }
                }
                Action::Volume { block, volume } => {
                    let volume = (*volume * 100.0).round() / 100.0;
                    self.edit_music(*block, |music| drop(music.insert("volume".into(), volume.into())));
                }
                Action::Loop { block, on, crossfade } => {
                    let (on, crossfade) = (*on, *crossfade);
                    self.edit_music(*block, |music| {
                        match on {
                            true => drop(music.insert("loop".into(), true.into())),
                            false => drop(music.shift_remove("loop")),
                        }
                        let before = music.shift_remove("crossfade");
                        if on && crossfade {
                            // The fades at the ends become the crossfade, and the loop
                            // wraps where it begins: a loop point of its own is no more.
                            // (Chosen again on a loop that already crossfades, it stays as it is.)
                            let fade = ["fadein", "fadeout"].iter().find_map(|key| music.get(*key).and_then(|v| v.as_f64())).filter(|fade| *fade > 0.0);
                            for key in ["fadein", "fadeout", "fading_point"] {
                                music.shift_remove(key);
                            }
                            music.insert("crossfade".into(), before.unwrap_or(fade.unwrap_or(mdstage_core::audio::DEFAULT_CROSSFADE).into()));
                        }
                    });
                }
                Action::AutoCueAt { block, at } => {
                    let at = (*at * 1000.0).round() / 1000.0;
                    let Some(Block::Cue(cue)) = self.show.as_mut().and_then(|s| s.script.blocks.get_mut(*block)) else { continue };
                    let mut yaml = cue.yaml.clone();
                    let Some(auto) = yaml.get_mut("auto_trigger").and_then(|a| a.as_mapping_mut()) else { continue };
                    auto.insert("at".into(), at.into());
                    cue.set_yaml(yaml);
                    self.after_edit();
                }
                Action::OpenInEditor(block) => self.open_in_editor(*block),
                Action::MoveAndEdit { block, up } => {
                    let Some(show) = &mut self.show else { continue };
                    let at = show.script.move_block(*block, *up);
                    if at != *block {
                        self.after_edit();
                    }
                    if let Some(show) = &self.show {
                        self.view.edit(&show.script, at, false);
                    }
                }
                Action::InsertAndEdit { at, block } => {
                    let Some(show) = &mut self.show else { continue };
                    show.script.insert_block(*at, block.clone());
                    self.after_edit();
                    if let Some(show) = &self.show {
                        self.view.edit(&show.script, *at, false);
                    }
                }
                Action::EditText(block) => {
                    if let Some(show) = &self.show {
                        self.view.edit(&show.script, *block, false);
                    }
                }
                Action::ArmLive(cue) => {
                    self.live_open = true;
                    self.request(Request::Arm(Some(*cue)));
                }
                Action::Picked { link, block, cue } => self.link_picked(*link, *block, *cue),
                Action::Unlink { link, block } => {
                    let link = *link;
                    self.edit_cue(*block, |map| match link {
                        Link::AutoCue => drop(map.shift_remove("auto_trigger")),
                        Link::Adjust => {
                            if let Some(music) = map.get_mut("music").and_then(|m| m.as_mapping_mut()) {
                                music.shift_remove("adjust");
                            }
                            // A cue that had `music` only for its adjust loses it again.
                            if map.get("music").and_then(|m| m.as_mapping()).is_some_and(|music| music.is_empty()) {
                                map.shift_remove("music");
                            }
                        }
                        Link::Chain | Link::LoopOutro => {
                            map.shift_remove("chain_end");
                            map.shift_remove("loop_outro");
                        }
                    });
                }
                Action::AutoMic { block, on } => {
                    let by_hand = |show: &OpenShow| show.script.blocks.iter().any(|b| matches!(b, Block::Cue(c) if c.yaml.get("mic").is_some()));
                    match (*on, &self.show) {
                        // The first Auto-Mic cue makes every hand-picked microphone void.
                        (true, Some(show)) if !show.script.has_auto_mic() && by_hand(show) => self.auto_mic_prompt = Some(*block),
                        (true, _) => self.edit_cue(*block, |map| drop(map.insert("auto_mic".into(), true.into()))),
                        (false, _) => self.edit_cue(*block, |map| drop(map.shift_remove("auto_mic"))),
                    }
                }
                Action::PlayPause(cue) => {
                    self.space_cue = Some(*cue);
                    self.request(Request::PlayPause(*cue));
                }
                // The stop button under a waveform is for trying audio out: at once.
                Action::StopCue(cue) => {
                    self.space_cue = None;
                    self.request(Request::StopCue(*cue, 0.02));
                }
                // The playhead was moved: from now on the space bar is this audio's.
                Action::Seek { cue, seconds } => {
                    self.space_cue = Some(*cue);
                    self.request(Request::Seek(*cue, *seconds));
                }
                Action::LiveVolume { cue, volume } => self.request(Request::Volume(*cue, *volume)),
            }
        }
    }

    fn shortcuts(&mut self, ctx: &egui::Context) {
        let pressed = |ctx: &egui::Context, key| ctx.input_mut(|i| i.consume_shortcut(&KeyboardShortcut::new(Modifiers::COMMAND, key)));
        if pressed(ctx, Key::O) {
            self.open_dialog(ctx);
        }
        if pressed(ctx, Key::N) {
            self.new_dialog(ctx);
        }
        if pressed(ctx, Key::L) {
            self.live_open = true;
        }
        if pressed(ctx, Key::B) && self.show.is_some() {
            self.toggle_sidebar();
        }
        if pressed(ctx, Key::F) && self.show.is_some() {
            self.view.open_search();
        }
        if pressed(ctx, Key::E) && self.show.is_some() {
            self.export.get_or_insert((EXPORT_DEFAULTS, false));
        }
        if pressed(ctx, Key::Comma) && self.settings_ui.is_none() {
            self.settings_ui = Some(SettingsUi::new(&self.settings).with_channels(self.show.as_ref().map(|s| s.script.virtual_channels()).unwrap_or_default()).with_show_dir(self.show.as_ref().and_then(|s| s.path.parent())).with_colours(self.device_colours()));
        }
        // Go and Back only when nothing is being typed.
        if self.show.is_some() && !self.view.is_editing() && !ctx.wants_keyboard_input() {
            // The space bar: Go while the show is locked. While it is being worked on, it
            // plays and pauses the audio whose playhead was last moved on its waveform —
            // and does nothing otherwise, so that no cue is fired or paused by accident.
            if ctx.input(|i| i.key_pressed(Key::Space)) {
                match (self.locked, self.space_cue) {
                    (true, _) => self.request(Request::Go),
                    (false, Some(cue)) => self.request(Request::PlayPause(cue)),
                    (false, None) => {}
                }
            }
            if ctx.input(|i| i.key_pressed(Key::Backspace)) {
                self.request(Request::Back);
            }
            // The arrow keys leaf through the cues from where the view is, whatever
            // the show is doing.
            for (key, forward) in [(Key::ArrowDown, true), (Key::ArrowUp, false)] {
                if ctx.input(|i| i.key_pressed(key) && i.modifiers.is_none()) {
                    self.view.step_cue(forward);
                }
            }
            // A number typed here is a scene to jump to.
            let (digits, now) = ctx.input(|i| {
                let typed: Vec<usize> = i.events.iter().filter_map(|e| match e {
                    egui::Event::Text(text) => Some(text.chars().filter_map(|c| c.to_digit(10)).map(|d| d as usize).collect::<Vec<_>>()),
                    _ => None,
                }).flatten().collect();
                (typed, i.time)
            });
            for digit in digits {
                self.view.type_scene_digit(digit, now);
            }
        }
    }

    fn menu(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        egui::menu::bar(ui, |ui| {
            ui.menu_button(self.t("Datei", "File"), |ui| {
                if ui.button(self.t("Neue Datei…", "New File…")).clicked() {
                    ui.close_menu();
                    self.new_dialog(&ctx);
                }
                if ui.button(self.t("Datei öffnen…", "Open File…")).clicked() {
                    ui.close_menu();
                    self.open_dialog(&ctx);
                }
                ui.menu_button(self.t("Zuletzt geöffnet", "Open Recent"), |ui| {
                    if self.settings.recent_files.is_empty() {
                        ui.label(self.t("— Keine —", "— None —"));
                    }
                    for file in self.settings.recent_files.clone() {
                        let name = Path::new(&file).file_name().unwrap_or_default().to_string_lossy().into_owned();
                        if ui.button(name).on_hover_text(&file).clicked() {
                            ui.close_menu();
                            self.open(Path::new(&file), &ctx);
                        }
                    }
                    if !self.settings.recent_files.is_empty() {
                        ui.separator();
                        if ui.button(self.t("Verlauf löschen", "Clear Recent Files")).clicked() {
                            ui.close_menu();
                            self.settings.recent_files.clear();
                            self.save_settings();
                        }
                    }
                });
                if ui.add_enabled(self.show.is_some(), egui::Button::new(self.t("Neu laden", "Reload"))).on_hover_text(self.t("Die Datei neu von der Platte lesen", "Read the file from disk again")).clicked() {
                    ui.close_menu();
                    self.reload(&ctx);
                }
                ui.separator();
                if ui.button(self.t("YAML aufräumen…", "Clean up YAML…")).clicked() {
                    ui.close_menu();
                    match self.show.as_ref().map(|s| s.script.cleanup_preview()) {
                        Some(found) if !found.is_empty() => self.cleanup = Some(found.into_iter().map(|r| (r.block, r.key)).collect()),
                        Some(_) => self.message = Some(self.t("Es wurden keine überflüssigen YAML-Eigenschaften gefunden.", "No superfluous YAML properties were found.").into()),
                        None => {}
                    }
                }
                if ui.button(self.t("Unbenutzte Audiodateien verschieben…", "Move unused audio files…")).clicked() {
                    ui.close_menu();
                    self.find_unused_audio();
                }
                ui.separator();
                if ui.button(self.t("Exportieren…", "Export…")).clicked() {
                    ui.close_menu();
                    if self.show.is_some() {
                        self.export.get_or_insert((EXPORT_DEFAULTS, false));
                    }
                }
                if ui.button(self.t("Rolleneditor…", "Role Editor…")).clicked() {
                    ui.close_menu();
                    self.roles_ui = self.show.as_ref().map(|s| RolesUi::new(&s.cast));
                }
                if ui.button(self.t("Einstellungen…", "Settings…")).clicked() {
                    ui.close_menu();
                    self.settings_ui = Some(SettingsUi::new(&self.settings).with_channels(self.show.as_ref().map(|s| s.script.virtual_channels()).unwrap_or_default()).with_show_dir(self.show.as_ref().and_then(|s| s.path.parent())).with_colours(self.device_colours()));
                }
                if ui.button(self.t("Beenden", "Quit")).clicked() {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
            });
            ui.menu_button(self.t("Ansicht", "View"), |ui| {
                if ui.button(self.t("Suchen…", "Find…")).clicked() {
                    ui.close_menu();
                    self.view.open_search();
                }
                if ui.button(self.t("Live-Ansicht", "Live View")).clicked() {
                    ui.close_menu();
                    self.live_open = true;
                }
                let scenes = if self.settings.sidebar_hidden { self.t("Szenenmenü einblenden", "Show Scene List") } else { self.t("Szenenmenü ausblenden", "Hide Scene List") };
                if ui.button(scenes).clicked() {
                    ui.close_menu();
                    self.toggle_sidebar();
                }
                if ui.button(self.t("Zum aktuellen Cue", "Show current cue")).clicked() {
                    ui.close_menu();
                    if let Some(cue) = self.snapshot.current.or(self.snapshot.next) {
                        self.view.scroll_to_cue(cue);
                    }
                }
            });
            // Single devices can be switched off without opening the settings: so that,
            // say, the lighting desk is left alone while its operator is programming.
            ui.menu_button(self.t("Geräte", "Devices"), |ui| {
                let mut changed = false;
                let mut any = false;
                for device in &mut self.settings.devices {
                    let label = format!("{} ({})", device.name(), device.kind());
                    if let Some(enabled) = device.enabled_mut() {
                        any = true;
                        changed |= ui.checkbox(enabled, label).on_hover_text(lang::t("Ohne Haken wird an dieses Gerät nichts gesendet.", "Without the tick nothing is sent to this device.")).changed();
                    }
                }
                if !any {
                    ui.label(RichText::new(lang::t("Keine MIDI-, OSC- oder HTTP-Geräte eingerichtet", "No MIDI, OSC or HTTP devices set up")).color(MUTED));
                }
                if !self.settings.mixers.is_empty() {
                    changed |= ui.checkbox(&mut self.settings.mics_enabled, lang::t("Mikrofonsteuerung (Mischpult)", "Microphone control (mixer)")).on_hover_text(lang::t("Ohne Haken werden keine Mikrofone am Mischpult geschaltet, auch nicht durch „Mics Off“.", "Without the tick no microphones are switched on the mixer, not by \"Mics Off\" either.")).changed();
                }
                ui.separator();
                changed |= ui.checkbox(&mut self.settings.outputs_blocked, lang::t("Alle Ausgänge blockieren", "Block all outputs")).changed();
                if changed {
                    self.devices_changed();
                }
            });
            ui.menu_button(self.t("Hilfe", "Help"), |ui| {
                if ui.button(self.t("Über MDstage…", "About MDstage…")).clicked() {
                    ui.close_menu();
                    self.about_open = true;
                }
            });
        });
    }

    fn toggle_sidebar(&mut self) {
        self.settings.sidebar_hidden = !self.settings.sidebar_hidden;
        self.save_settings();
    }

    /// The bar under the menu: scene list switch, Go and Back at the left; clock,
    /// timecode, view switches and the emergency buttons at the right.
    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            let has_show = self.show.is_some();
            let scenes = theme::tool_button(RichText::new("☰").size(20.0));
            if ui.add_enabled(has_show, scenes).on_hover_text(self.t("Szenenmenü ein- und ausblenden", "Show or hide the scene list")).clicked() {
                self.toggle_sidebar();
            }
            let go = egui::Button::new(RichText::new("GO").size(20.0).color(Color32::BLACK).strong())
                .fill(GREEN)
                .stroke(egui::Stroke::new(1.0_f32, Color32::BLACK))
                .min_size(egui::vec2(96.0, theme::TOOL));
            let blocked = self.snapshot.go_blocked || self.snapshot.needs_variant;
            let hint = if self.snapshot.go_blocked {
                lang::t("Ein Cue wird gerade von selbst ausgelöst – Go wartet, bis er da ist.", "A cue is about to fire by itself – Go waits until it has.")
            } else if self.snapshot.needs_variant {
                lang::t("Der nächste Cue hat Varianten: erst eine wählen (in der Live-Ansicht anklicken, oder hier die Variante direkt auslösen).", "The next cue has variants: choose one first (click it in the live view, or fire the variant here directly).")
            } else {
                lang::t("Leertaste (bei gesperrter Show)", "Space (while the show is locked)")
            };
            if ui.add_enabled(has_show && self.snapshot.next.is_some() && !blocked, go).on_hover_text(hint).on_disabled_hover_text(hint).clicked() {
                self.request(Request::Go);
            }
            let back = theme::tool_button(RichText::new("Back").size(15.0).strong()).min_size(egui::vec2(64.0, theme::TOOL));
            if ui.add_enabled(has_show, back).on_hover_text(self.t("Rücktaste", "Backspace")).clicked() {
                self.request(Request::Back);
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Right to left: the emergency buttons sit in the corner, as a group.
                if theme::emergency_button(ui, theme::music_icon(), false, has_show).on_hover_text(self.t("Notfall: alle Musik ausblenden", "Emergency: fade out all music")).clicked() {
                    self.request(Request::StopAll);
                }
                if theme::emergency_button(ui, theme::mic_icon(), false, has_show).on_hover_text(self.t("Notfall: alle Mikrofone aus", "Emergency: all microphones off")).clicked() {
                    self.request(Request::MicsOff);
                }
                if self.settings.emergency_light.is_some() {
                    let on = self.snapshot.emergency_light;
                    let hint = self.t("Notlicht an oder aus", "Emergency light on or off");
                    if theme::emergency_button(ui, theme::light_icon(), on, has_show).on_hover_text(hint).clicked() {
                        self.request(Request::EmergencyLight(!on));
                    }
                }
                ui.add_space(6.0);
                let next = theme::tool_icon(theme::Icon::Target, false);
                if ui.add_enabled(has_show, next).on_hover_text(self.t("Zum nächsten Cue springen", "Jump to the next cue")).clicked() {
                    if let Some(cue) = self.snapshot.next.or(self.snapshot.current) {
                        self.view.scroll_to_cue(cue);
                    }
                }
                let recent = theme::tool_icon(theme::Icon::Recent, false);
                if ui.add_enabled(has_show, recent).on_hover_text(self.t("Zum zuletzt ausgelösten Cue springen", "Jump to the cue that fired last")).clicked() {
                    if let Some(cue) = self.snapshot.latest.or(self.snapshot.current) {
                        self.view.scroll_to_cue(cue);
                    }
                }
                if ui.add_enabled(has_show, theme::tool_button(RichText::new("↺").size(20.0))).on_hover_text(self.t("Datei neu von der Platte lesen", "Read the file from disk again")).clicked() {
                    let ctx = ui.ctx().clone();
                    self.reload(&ctx);
                }
                let lock_hint = self.t("Bearbeitungssperre: kein Bearbeiten, Klicks schalten nur scharf", "Edit lock: no editing, clicks only arm");
                if ui.add(theme::tool_icon(theme::Icon::Lock, self.locked)).on_hover_text(lock_hint).clicked() {
                    self.locked = !self.locked;
                }
                if ui.add(theme::tool_toggle("LIVE", self.live_open)).on_hover_text(self.t("Live-Ansicht öffnen", "Open the live view")).clicked() {
                    self.live_open = !self.live_open;
                }
                ui.add_space(6.0);
                let running = self.snapshot.timecode.is_some();
                let tc = self.snapshot.timecode.map_or("--:--:--:--".to_string(), |s| Timecode::from_frames((s * 25.0).floor().max(0.0) as u64).to_string());
                theme::readout(ui, &tc, 20.0, if running { YELLOW } else { MUTED }).on_hover_text("Timecode");
                theme::readout(ui, &chrono::Local::now().format("%H:%M:%S").to_string(), 26.0, TEXT).on_hover_text(self.t("Uhrzeit", "Time of day"));
            });
        });
    }

    /// The line at the bottom of the window: the audio device and what is loading.
    fn status_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let output = match &self.snapshot.output {
                Some(o) => format!("{} · {} {} · {} Hz", o.name, o.channels, lang::t("Kanäle", "channels"), o.sample_rate),
                None if self.show.is_some() => self.t("kein Audiogerät", "no audio device").to_string(),
                None => String::new(),
            };
            ui.label(RichText::new(output).size(12.0).color(MUTED));
            if let Some(files) = self.snapshot.loading {
                ui.label(RichText::new(format!("{} ({files})", self.t("Audio lädt", "Loading audio"))).size(12.0).color(YELLOW));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.snapshot.audio_memory_mb >= 1.0 {
                    ui.label(RichText::new(format!("Audio {:.0} MB", self.snapshot.audio_memory_mb)).size(12.0).color(MUTED));
                }
            });
        });
    }

    /// Warnings above the script: an untrusted file, problems in cues, engine trouble.
    fn banners(&mut self, ui: &mut egui::Ui) {
        if let Some(message) = self.message.clone() {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(message).color(YELLOW));
                if ui.small_button("OK").clicked() {
                    self.message = None;
                }
            });
        }
        if self.settings.outputs_blocked {
            let mut unblock = false;
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(self.t("Geräte-Ausgänge blockiert – MIDI/OSC/HTTP werden nicht gesendet", "Device outputs blocked – MIDI/OSC/HTTP are not sent")).color(RED));
                unblock = ui.small_button(self.t("Entsperren", "Unblock")).clicked();
            });
            if unblock {
                self.settings.outputs_blocked = false;
                self.devices_changed();
            }
        }
        // Devices that are switched off, so that it is not forgotten.
        let mut off: Vec<String> = Vec::new();
        for device in &mut self.settings.devices {
            let name = device.name().to_string();
            if device.enabled_mut().is_some_and(|enabled| !*enabled) {
                off.push(name);
            }
        }
        if !self.settings.mics_enabled && !self.settings.mixers.is_empty() {
            off.push(lang::t("Mikrofonsteuerung", "microphone control").to_string());
        }
        if !off.is_empty() && !self.settings.outputs_blocked {
            let mut switch_on = false;
            ui.horizontal_wrapped(|ui| {
                let text = format!("{}: {}", lang::t("Ausgeschaltete Geräte – an sie wird nichts gesendet", "Devices switched off – nothing is sent to them"), off.join(", "));
                ui.label(RichText::new(text).color(YELLOW));
                switch_on = ui.small_button(lang::t("Alle einschalten", "Switch all on")).clicked();
            });
            if switch_on {
                for device in &mut self.settings.devices {
                    if let Some(enabled) = device.enabled_mut() {
                        *enabled = true;
                    }
                }
                self.settings.mics_enabled = true;
                self.devices_changed();
            }
        }
        let Some(show) = &self.show else { return };
        let mut allow = false;
        if !show.trusted {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(self.t(
                    "Diese Datei wurde zuletzt nicht auf diesem Rechner gespeichert. Sie sendet nichts an Geräte, bis du es erlaubst.",
                    "This file was last saved on another machine. It sends nothing to devices until you allow it.",
                )).color(YELLOW));
                allow = ui.button(self.t("Ausgaben erlauben", "Allow outputs")).clicked();
            });
        }
        // Each line: its text, its colour, and for an unknown key where it is, so it
        // can be deleted on the spot.
        let mut lines: Vec<(String, Color32, Option<(usize, String)>)> = show.notes.iter().map(|n| (n.clone(), MUTED, None)).collect();
        lines.extend(show.report.problems.iter().map(|p| {
            let unknown = p.message.strip_prefix("Unbekannter Schlüssel: ").map(|key| (p.block, key.to_string()));
            (format!("{} {}: {}", lang::t("YAML-Block", "YAML block"), p.block, p.message), RED, unknown)
        }));
        lines.extend(show.report.variants.iter().map(|issue| {
            use mdstage_core::validate::VariantIssue;
            let text = match (issue, lang::english()) {
                (VariantIssue::AutoCue(cue), false) => format!("{cue} ist eine Variante und zugleich ein Auto-Cue. Eine Variante wird nie von selbst ausgelöst (welche genommen wird, wählt der Operator); der Auto-Cue bleibt ohne Wirkung."),
                (VariantIssue::AutoCue(cue), true) => format!("{cue} is a variant and an auto-cue at once. A variant never fires by itself (the operator chooses which one is taken); the auto-cue has no effect."),
                (VariantIssue::ChainedInto { from, to }, false) => format!("{from} geht nahtlos in {to} über, das Varianten hat. In eine Variante geht nichts von selbst über; der Übergang bleibt ohne Wirkung."),
                (VariantIssue::ChainedInto { from, to }, true) => format!("{from} carries straight on into {to}, which has variants. Nothing carries on into a variant by itself; the transition has no effect."),
            };
            (text, RED, None)
        }));
        lines.extend(show.report.auto_order.iter().map(|(first, second)| {
            let text = if lang::english() {
                format!("{second} fires before {first}, but stands after it in the script. A source's auto-cues have to stand in the order they fire in: change a time or move a cue.")
            } else {
                format!("{second} löst vor {first} aus, steht im Skript aber danach. Die Auto-Cues einer Quelle müssen in der Reihenfolge stehen, in der sie auslösen: eine Zeit ändern oder einen Cue verschieben.")
            };
            (text, RED, None)
        }));
        lines.extend(show.report.note_conflicts.iter().map(|c| (if lang::english() { format!("Trigger note {} is used by two cues (YAML blocks {} and {}). Every cue needs a note of its own; only variants share one.", c.note, c.first, c.second) } else { format!("Trigger-Note {} haben zwei Cues (YAML-Blöcke {} und {}). Jeder Cue braucht eine eigene Note; nur Varianten teilen sich eine.", c.note, c.first, c.second) }, RED, None)));
        // Devices the cues send to that this machine has no address for.
        let mut missing: Vec<&str> = Vec::new();
        for cue in show.script.blocks.iter().filter_map(|b| match b {
            Block::Cue(cue) if !cue.invalid => Some(cue),
            _ => None,
        }) {
            for key in ["cue_midi", "cue_osc", "cue_http", "cue_display"] {
                for device in cue.yaml.get(key).and_then(|v| v.as_sequence()).into_iter().flatten().filter_map(|m| m.get("device")?.as_str()) {
                    if !missing.contains(&device) && !self.settings.devices.iter().any(|d| d.name() == device) {
                        missing.push(device);
                    }
                }
            }
        }
        lines.extend(missing.into_iter().map(|device| {
            let text = if lang::english() { format!("The device “{device}” is not set up on this machine: what cues send to it goes nowhere.") } else { format!("Das Gerät „{device}“ ist auf diesem Rechner nicht eingerichtet: Was Cues dorthin senden, kommt nirgends an.") };
            (text, YELLOW, None)
        }));
        lines.extend(self.snapshot.problems.iter().map(|p| (p.clone(), RED, None)));
        lines.retain(|(text, _, _)| !self.ignored.contains(text));
        let mut clear = false;
        let mut ignore = None;
        let mut delete = None;
        if !lines.is_empty() {
            egui::ScrollArea::vertical().id_salt("banner").max_height(96.0).show(ui, |ui| {
                for (line, colour, unknown) in &lines {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(line).color(*colour).size(13.0));
                        if *colour != MUTED && ui.small_button(lang::t("Ignorieren", "Ignore")).clicked() {
                            ignore = Some(line.clone());
                        }
                        if unknown.is_some() && !self.locked && ui.small_button(lang::t("Eigenschaft löschen", "Delete property")).clicked() {
                            delete = unknown.clone();
                        }
                    });
                }
            });
            clear = !self.snapshot.problems.is_empty() && ui.small_button(self.t("Meldungen der Engine ausblenden", "Dismiss engine messages")).clicked();
        }
        self.ignored.extend(ignore);
        if let Some((block, key)) = delete {
            if self.show.as_mut().is_some_and(|show| show.script.cleanup_one(block, &key)) {
                self.after_edit();
            }
        }
        if clear {
            self.request(Request::ClearProblems);
        }
        if allow {
            if let Some(show) = &mut self.show {
                store::trust(&show.path, &mut self.settings);
                show.trusted = true;
                show.session.send(Request::Configure(Box::new(self.settings.clone()), true));
            }
            self.save_settings();
        }
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        let Some(mut form) = self.settings_ui.take() else { return };
        let mut open = true;
        let mut result = None;
        let has_show = self.show.is_some();
        egui::Window::new(self.t("Einstellungen", "Settings")).open(&mut open).default_size([760.0, 620.0]).show(ctx, |ui| {
            result = form.show(ui, has_show, self.snapshot.heard);
        });
        if let Some(output) = form.test_output.take() {
            self.request(Request::TestTone(output));
        }
        match result {
            Some(true) => {
                // The channel names belong to the show file; a rename takes its routing along.
                let (names, renames) = form.channel_names();
                for (was, name) in &renames {
                    if let Some(output) = form.draft.routing.remove(was) {
                        form.draft.routing.insert(name.clone(), output);
                    }
                }
                // So do the devices' names, kinds and colours (their addresses do not).
                let colours_changed = form.colours != self.device_colours();
                let mut edited = false;
                if let Some(show) = &mut self.show {
                    if show.script.virtual_channels() != names {
                        show.script.set_virtual_channels(&names, &renames);
                        edited = true;
                    }
                    if colours_changed {
                        let devices: Vec<(String, String, Option<String>)> = form
                            .draft
                            .devices
                            .iter()
                            .map(|device| {
                                let kind = match device {
                                    mdstage_engine::settings::DeviceSetting::Midi { .. } => "midi",
                                    mdstage_engine::settings::DeviceSetting::Osc { .. } => "osc",
                                    mdstage_engine::settings::DeviceSetting::Http { .. } => "http",
                                    mdstage_engine::settings::DeviceSetting::Display { .. } => "display",
                                };
                                (device.name().to_string(), kind.to_string(), form.colours.get(device.name()).cloned())
                            })
                            .collect();
                        show.script.set_output_devices(&devices);
                        edited = true;
                    }
                }
                if edited {
                    self.after_edit();
                }
                let restart = form.draft.display_host != self.settings.display_host || form.draft.display_port != self.settings.display_port;
                self.settings = form.draft;
                self.save_settings();
                let reopen = self.show.as_ref().map(|s| (s.path.clone(), s.trusted));
                match reopen {
                    // The display server is opened with the show.
                    Some((path, _)) if restart => self.open(&path, ctx),
                    Some((_, trusted)) => {
                        self.request(Request::Configure(Box::new(self.settings.clone()), trusted));
                        let english = self.english();
                        if let Some(show) = &mut self.show {
                            show.cast = Cast::from_script(&show.script, english);
                        }
                    }
                    None => {}
                }
            }
            Some(false) => {}
            None if open => self.settings_ui = Some(form),
            None => {}
        }
    }

    fn export_window(&mut self, ctx: &egui::Context) {
        let (Some((mut options, mut times)), Some(show)) = (self.export, &self.show) else { return };
        let mut open = true;
        let mut format = None;
        egui::Window::new(self.t("Exportieren", "Export")).open(&mut open).resizable(false).show(ctx, |ui| {
            ui.checkbox(&mut options.cues, self.t("Cues einschließen", "Include cues"));
            ui.checkbox(&mut options.colours, self.t("Rollenfarben", "Role colours"));
            ui.checkbox(&mut options.grouped_mics, self.t("Mikrofone gruppiert", "Grouped mics"));
            ui.checkbox(&mut times, self.t("Auslösezeiten dieser Sitzung", "Trigger times of this session"));
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if ui.button("PDF…").clicked() {
                    format = Some("pdf");
                }
                if ui.button("DOCX…").clicked() {
                    format = Some("docx");
                }
            });
        });
        self.export = open.then_some((options, times));
        let Some(format) = format else { return };
        let fired: Vec<(usize, String)> = if times { self.snapshot.fired_at.iter().map(|&(cue, at)| (cue, store::clock_time(at))).collect() } else { Vec::new() };
        let book = show.script.book(&show.cast, options, &fired);
        let name = format!("{}.{format}", book.title.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"));
        let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() else { return };
        let date = store::today();
        let bytes = if format == "pdf" { export::pdf(&book, &date) } else { export::docx(&book, &date) };
        self.message = Some(match bytes.and_then(|b| std::fs::write(&path, b).map_err(|e| e.to_string())) {
            Ok(()) => format!("{}: {}", lang::t("Exportiert", "Exported"), path.display()),
            Err(e) => format!("{}: {e}", lang::t("Export fehlgeschlagen", "Export failed")),
        });
        self.export = None;
    }

    fn cue_window(&mut self, ctx: &egui::Context) {
        let (Some(mut dialog), Some(show)) = (self.cue_dialog.take(), &mut self.show) else { return };
        let title = if dialog.is_new { lang::t("Neuer Cue", "New cue") } else { lang::t("Cue bearbeiten", "Edit cue") };
        let mut open = true;
        let mut result = None;
        let mut swapped: Vec<(String, String)> = Vec::new();
        egui::Window::new(title).open(&mut open).default_size([640.0, 600.0]).show(ctx, |ui| result = dialog.show(ui, &show.cast));
        match result {
            Some(true) => {
                if dialog.is_new {
                    let cue = show.script.new_cue(dialog.value());
                    show.script.insert_block(dialog.block, cue);
                } else if let Some(Block::Cue(cue)) = show.script.blocks.get_mut(dialog.block) {
                    let before = cue.note();
                    let files_before = mdstage_core::edit::audio_files_in(&cue.yaml);
                    cue.set_yaml(dialog.value());
                    // Files that were swapped for others, place by place.
                    let files_after = mdstage_core::edit::audio_files_in(&cue.yaml);
                    if files_before.len() == files_after.len() {
                        for (was, now) in files_before.into_iter().zip(files_after) {
                            if was != now && !was.is_empty() && !now.is_empty() && !swapped.iter().any(|(w, _)| *w == was) {
                                swapped.push((was, now));
                            }
                        }
                    }
                    // A changed trigger note takes along every link other cues have to it.
                    if let (Some(before), Some(after)) = (before, cue.note()) {
                        if before != after {
                            show.script.renumber_note(before, after);
                            // Variants share their cue's note: the rest of the group follows.
                            let cues = Cues::new(&show.script);
                            let edited = (0..cues.len()).find(|&c| cues.block_index(c) == Some(dialog.block));
                            let group: Vec<usize> = edited.map(|c| cues.group(c).filter_map(|member| cues.block_index(member)).collect()).unwrap_or_default();
                            for member in group {
                                if let Some(Block::Cue(other)) = show.script.blocks.get_mut(member) {
                                    if other.note() == Some(before) {
                                        let mut yaml = other.yaml.clone();
                                        if let Some(map) = yaml.as_mapping_mut() {
                                            map.insert("trigger_note".into(), note_value(after));
                                        }
                                        other.set_yaml(yaml);
                                    }
                                }
                            }
                        }
                    }
                    // A cue must keep a trigger note even if it was deleted from the YAML.
                    show.script.assign_trigger_notes();
                }
                // Other cues still playing a file this one has just swapped: ask whether
                // they should follow.
                let cues = Cues::new(&show.script);
                let others: Vec<(String, String, usize)> = swapped
                    .into_iter()
                    .filter_map(|(was, now)| {
                        let users = (0..cues.len()).filter(|&c| cues.get(c).is_some_and(|cue| mdstage_core::edit::audio_files_in(&cue.yaml).contains(&was))).count();
                        (users > 0).then_some((was, now, users))
                    })
                    .collect();
                self.after_edit();
                if !others.is_empty() {
                    self.swap_prompt = Some(others);
                }
            }
            Some(false) if dialog.delete => {
                show.script.delete_block(dialog.block);
                self.after_edit();
            }
            Some(false) => {}
            None if open => {
                if let Some((from, to)) = dialog.rename_request.take() {
                    match self.rename_audio(&from, &to) {
                        Ok(true) => dialog.audio_renamed(&from, &to),
                        // Waiting for the answer to "save with this version?".
                        Ok(false) => {}
                        Err(e) => dialog.rename_error = Some(format!("{}: {e}", lang::t("Umbenennen fehlgeschlagen", "Rename failed"))),
                    }
                }
                self.cue_dialog = Some(dialog);
            }
            None => {}
        }
    }

    /// Rename a file in the show's `audio/` folder and follow it through every cue.
    /// Returns `Ok(false)` if it has to wait: the file was last saved by another version
    /// of MDstage, and the operator is asked first whether this one may save it.
    fn rename_audio(&mut self, from: &str, to: &str) -> Result<bool, String> {
        let Some(show) = &mut self.show else { return Ok(false) };
        if show.saved_by_other.is_some() {
            self.pending_rename = Some((from.to_string(), to.to_string()));
            self.upgrade_prompt = true;
            return Ok(false);
        }
        let audio_dir = show.path.parent().unwrap_or(Path::new(".")).join("audio");
        store::rename_audio_file(&audio_dir, from, to).map_err(|e| e.message().to_string())?;
        let before = show.script.clone();
        if show.script.rename_audio(from, to) == 0 {
            return Ok(true);
        }
        // A show file that cannot be written must not be left naming a file that is gone:
        // put both back.
        if let Err(e) = store::save(&show.path, &show.script, &mut self.settings, show.trusted) {
            show.script = before;
            let _ = store::rename_audio_file(&audio_dir, to, from);
            return Err(format!("{} ({e})", store::RenameError::Io.message()));
        }
        self.after_edit();
        Ok(true)
    }

    /// Menu: look for audio files no cue uses and offer to move them away.
    fn find_unused_audio(&mut self) {
        let Some(show) = &self.show else { return };
        let (used, unreadable) = show.script.audio_files_used();
        if unreadable > 0 {
            self.message = Some(
                self.t(
                    "Das Skript enthält fehlerhafte YAML-Blöcke. Solange die nicht gelesen werden können, lässt sich nicht sicher bestimmen, welche Audiodateien verwendet werden.",
                    "The script contains YAML blocks with errors. While those cannot be read, it is not possible to tell reliably which audio files are in use.",
                )
                .into(),
            );
            return;
        }
        let unused = store::unused_audio(&show.path.parent().unwrap_or(Path::new(".")).join("audio"), &used);
        if unused.is_empty() {
            self.message = Some(self.t("Alle Audiodateien im audio-Ordner werden im Skript verwendet.", "Every audio file in the audio folder is used by the script.").into());
        } else {
            self.unused_audio = Some(unused);
        }
    }

    /// The colour the open show gives each output device, by device name.
    fn device_colours(&self) -> std::collections::HashMap<String, String> {
        let declared = self.show.as_ref().and_then(|s| s.script.config()).and_then(|c| c.get("outputDevices")).and_then(|d| d.as_sequence()).cloned().unwrap_or_default();
        declared.iter().filter_map(|d| Some((d.get("name")?.as_str()?.to_string(), d.get("color")?.as_str()?.to_string()))).collect()
    }

    /// Open the show file at a block in the text editor set up in the settings.
    fn open_in_editor(&mut self, block: usize) {
        let Some(show) = &self.show else { return };
        let line = show.script.block_lines().get(block).copied().unwrap_or(1).to_string();
        let file = show.path.to_string_lossy();
        // Split into words first, so a path with spaces stays one argument.
        let words: Vec<String> = self.settings.editor_command.split_whitespace().map(|word| word.replace("{file}", &file).replace("{line}", &line)).collect();
        let Some((program, arguments)) = words.split_first() else { return };
        if let Err(e) = std::process::Command::new(program).args(arguments).spawn() {
            self.message = Some(format!("{} „{program}“: {e}", lang::t("Texteditor nicht gestartet", "Could not start the text editor")));
        }
    }

    fn reload(&mut self, ctx: &egui::Context) {
        if let Some(path) = self.show.as_ref().map(|s| s.path.clone()) {
            self.open(&path, ctx);
        }
    }

    /// Asked after a cue's audio file was swapped while other cues still play the old one.
    fn swap_window(&mut self, ctx: &egui::Context) {
        let Some(swaps) = self.swap_prompt.take() else { return };
        let mut open = true;
        let mut result = None;
        egui::Window::new(lang::t("Audiodatei auch in anderen Cues austauschen?", "Swap the audio file in other cues too?")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            for (was, now, users) in &swaps {
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new(was).color(BRIGHT));
                    ui.label("→");
                    ui.label(RichText::new(now).color(BRIGHT));
                });
                ui.label(RichText::new(if lang::english() { format!("{users} other cue(s) still use “{was}”.") } else { format!("{users} weitere(r) Cue(s) verwenden „{was}“ noch.") }).color(MUTED));
                ui.add_space(4.0);
            }
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button(lang::t("In allen Cues austauschen", "Swap in all cues")).clicked() {
                    result = Some(true);
                }
                if ui.button(lang::t("Nur in diesem Cue", "Only in this cue")).clicked() {
                    result = Some(false);
                }
            });
        });
        match result {
            Some(true) => {
                if let Some(show) = &mut self.show {
                    for (was, now, _) in &swaps {
                        show.script.rename_audio(was, now);
                    }
                }
                self.after_edit();
            }
            Some(false) => {}
            None if open => self.swap_prompt = Some(swaps),
            None => {}
        }
    }

    /// The notice on opening a file another version of MDstage saved, and the question
    /// before the first edit is written into it.
    fn version_windows(&mut self, ctx: &egui::Context) {
        if let Some(version) = self.version_notice.clone() {
            let mut open = true;
            let mut ok = false;
            egui::Window::new(lang::t("Andere Version", "Another version")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
                ui.label(match (&version, lang::english()) {
                    (Some(version), true) => format!("This file was saved with version {version}."),
                    (Some(version), false) => format!("Diese Datei wurde mit Version {version} gespeichert."),
                    (None, true) => "This file does not say which version saved it.".to_string(),
                    (None, false) => "Diese Datei gibt nicht an, mit welcher Version sie gespeichert wurde.".to_string(),
                });
                ui.label(format!("{}: {VERSION}", lang::t("Aktuelle Version", "Current version")));
                ui.add_space(6.0);
                ui.label(RichText::new(lang::t("Die Datei kann weiterhin verwendet werden. Wird sie bearbeitet, fragt MDstage nach und speichert sie dann mit der aktuellen Version; vorher wird eine Sicherung angelegt.", "The file can be used as it is. When it is edited, MDstage asks and then saves it with the current version; a backup is made first.")).color(MUTED));
                ui.add_space(6.0);
                ok = ui.button("OK").clicked();
            });
            if ok || !open {
                self.version_notice = None;
            }
        }

        if !self.upgrade_prompt {
            return;
        }
        let Some(version) = self.show.as_ref().and_then(|s| s.saved_by_other.clone()) else {
            self.upgrade_prompt = false;
            return;
        };
        let mut choice = None;
        egui::Window::new(lang::t("Skript wird aktualisiert", "The script is being updated")).collapsible(false).resizable(false).show(ctx, |ui| {
            let was = version.clone().unwrap_or_else(|| lang::t("unbekannt", "unknown").to_string());
            ui.label(if lang::english() { format!("This script was saved with version {was} and will now be saved with version {VERSION}.") } else { format!("Dieses Skript wurde mit Version {was} gespeichert und wird jetzt mit Version {VERSION} gespeichert.") });
            ui.label(RichText::new(lang::t("Bestehende Cues und Einstellungen können davon betroffen sein. Vorher wird eine Sicherungskopie neben der Datei angelegt.", "Existing cues and settings may be affected. A backup copy is put next to the file first.")).color(MUTED));
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if ui.button(lang::t("Trotzdem speichern", "Save anyway")).clicked() {
                    choice = Some(true);
                }
                if ui.button(lang::t("Änderung verwerfen", "Discard the change")).clicked() {
                    choice = Some(false);
                }
            });
        });
        match choice {
            Some(true) => {
                self.upgrade_prompt = false;
                let Some(show) = &mut self.show else { return };
                let name = version.unwrap_or_else(|| "unbekannt".to_string());
                match store::backup_version(&show.path, &name) {
                    Ok(backup) => {
                        show.saved_by_other = None;
                        show.script.set_app_version(VERSION);
                        self.after_edit();
                        self.message = Some(format!("{}: {backup}", lang::t("Mit der aktuellen Version gespeichert. Sicherung", "Saved with the current version. Backup")));
                        // A renaming that was waiting for this answer happens now.
                        if let Some((from, to)) = self.pending_rename.take() {
                            let done = self.rename_audio(&from, &to);
                            if let Some(dialog) = &mut self.cue_dialog {
                                match done {
                                    Ok(_) => dialog.audio_renamed(&from, &to),
                                    Err(e) => dialog.rename_error = Some(format!("{}: {e}", lang::t("Umbenennen fehlgeschlagen", "Rename failed"))),
                                }
                            }
                        }
                    }
                    // Without the copy nothing is written.
                    Err(e) => self.message = Some(format!("{}: {e}", lang::t("Sicherungskopie nicht geschrieben, nichts gespeichert", "Backup not written, nothing saved"))),
                }
            }
            Some(false) => {
                // Back to what is on disk.
                self.upgrade_prompt = false;
                self.pending_rename = None;
                self.reload(ctx);
            }
            None => {}
        }
    }

    fn about_window(&mut self, ctx: &egui::Context) {
        if !self.about_open {
            return;
        }
        let mut open = true;
        egui::Window::new(lang::t("Über MDstage", "About MDstage")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(RichText::new("MDstage").size(26.0).color(BRIGHT).strong());
            ui.label(lang::t("Das interaktive Inspizientenbuch", "The interactive prompt book"));
            ui.add_space(8.0);
            ui.label(format!("{}: {}", lang::t("Installierte Version", "Installed version"), env!("CARGO_PKG_VERSION")));
            ui.add_space(8.0);
            ui.label(RichText::new(lang::t("MDstage prüft nicht automatisch auf Updates – die Software verwendet kein Internet.", "MDstage does not check for updates by itself – the software does not use the internet.")).color(MUTED));
            ui.label(RichText::new(lang::t("Schau gelegentlich auf GitHub nach, ob eine neue Version verfügbar ist.", "Have a look on GitHub now and then for a new version.")).color(MUTED));
            ui.hyperlink_to(lang::t("GitHub Releases öffnen", "Open GitHub Releases"), "https://github.com/julius-b-mueller/MDstage/releases");
        });
        self.about_open = open;
    }

    /// Audio files were dropped onto the window: copy them into the show's `audio/`
    /// folder (a file of the same name that is there already is left alone). Dropped
    /// between two blocks of the script, each file becomes a cue there that plays it.
    fn audio_dropped(&mut self, files: Vec<PathBuf>, at: Option<egui::Pos2>) {
        let Some(show) = &mut self.show else { return };
        let audio_dir = show.path.parent().unwrap_or(Path::new(".")).join("audio");
        // Not onto a dialog, and not while editing is locked.
        let dialog_open = self.cue_dialog.is_some() || self.settings_ui.is_some() || self.roles_ui.is_some();
        let mut insert_at = at.filter(|_| !self.locked && !dialog_open).and_then(|point| self.view.insert_index_at(point, &show.script));
        let (mut copied, mut present, mut failed, mut cues) = (0, 0, 0, 0);
        for file in files {
            let Some(name) = file.file_name().and_then(|n| n.to_str()).filter(|n| store::is_audio_name(n)) else { continue };
            let target = audio_dir.join(name);
            // A link that points nowhere counts as there: copying would follow it.
            if store::occupied(&target) {
                present += 1;
            } else if std::fs::create_dir_all(&audio_dir).and_then(|()| std::fs::copy(&file, &target)).is_ok() {
                copied += 1;
            } else {
                failed += 1;
                continue;
            }
            if let Some(index) = insert_at {
                let mut fields = serde_yaml_mapping();
                fields.insert("music".into(), name.into());
                let cue = show.script.new_cue(fields.into());
                show.script.insert_block(index, cue);
                insert_at = Some(index + 1);
                cues += 1;
            }
        }
        if copied + present + failed == 0 {
            return;
        }
        let mut text = if lang::english() { format!("{copied} audio file(s) copied to audio/.") } else { format!("{copied} Audiodatei(en) nach audio/ kopiert.") };
        if present > 0 {
            text += &if lang::english() { format!(" {present} already there, left as they are.") } else { format!(" {present} gab es schon, unverändert gelassen.") };
        }
        if failed > 0 {
            text += &if lang::english() { format!(" {failed} could not be copied.") } else { format!(" {failed} konnten nicht kopiert werden.") };
        }
        if cues > 0 {
            text += &if lang::english() { format!(" {cues} cue(s) created.") } else { format!(" {cues} Cue(s) angelegt.") };
        }
        self.message = Some(text);
        if let Some(dialog) = &mut self.cue_dialog {
            dialog.refresh_audio(&audio_dir);
        }
        if cues > 0 {
            self.after_edit();
        }
    }

    /// "Clean up YAML": show what would go, and on confirmation keep a copy of the file
    /// as it was (`name~uncleaned.md`) before removing it.
    fn cleanup_window(&mut self, ctx: &egui::Context) {
        let Some(found) = self.cleanup.take() else { return };
        const SHOWN: usize = 30;
        let mut open = true;
        let mut result = None;
        egui::Window::new(lang::t("YAML aufräumen", "Clean up YAML")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(if lang::english() { format!("{} superfluous properties will be removed:", found.len()) } else { format!("{} überflüssige Eigenschaft(en) werden entfernt:", found.len()) });
            ui.add_space(6.0);
            egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                for (block, key) in found.iter().take(SHOWN) {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(format!("{} {block}", lang::t("YAML-Block", "YAML block"))).color(MUTED));
                        ui.label(RichText::new(key).color(BRIGHT).monospace());
                    });
                }
                if found.len() > SHOWN {
                    ui.label(RichText::new(format!("… {} {}", found.len() - SHOWN, lang::t("weitere", "more"))).color(MUTED));
                }
            });
            ui.add_space(6.0);
            ui.label(RichText::new(lang::t("Vorher wird eine Sicherungskopie als „…~uncleaned.md“ gespeichert.", "A backup is saved as “…~uncleaned.md” first.")).color(MUTED));
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button(lang::t("Aufräumen", "Clean up")).clicked() {
                    result = Some(true);
                }
                if ui.button(lang::t("Abbrechen", "Cancel")).clicked() {
                    result = Some(false);
                }
            });
        });
        match result {
            Some(true) => {
                let Some(show) = &mut self.show else { return };
                let backup = show.path.with_file_name(format!("{}~uncleaned.md", show.path.file_stem().unwrap_or_default().to_string_lossy()));
                // Without the copy nothing is removed.
                if let Err(e) = store::copy_plain(&show.path, &backup) {
                    self.message = Some(format!("{}: {e}", lang::t("Sicherungskopie nicht geschrieben, nichts aufgeräumt", "Backup not written, nothing cleaned up")));
                    return;
                }
                let removed = show.script.cleanup();
                self.after_edit();
                self.message = Some(format!("{} {} ({}: {})", removed.len(), lang::t("Eigenschaften entfernt", "properties removed"), lang::t("Sicherung", "backup"), backup.file_name().unwrap_or_default().to_string_lossy()));
            }
            Some(false) => {}
            None if open => self.cleanup = Some(found),
            None => {}
        }
    }

    fn unused_audio_window(&mut self, ctx: &egui::Context) {
        let (Some(files), Some(show)) = (self.unused_audio.take(), &self.show) else { return };
        const SHOWN: usize = 30;
        let mut open = true;
        let mut result = None;
        egui::Window::new(lang::t("Unbenutzte Audiodateien verschieben", "Move unused audio files")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            let folder = store::UNUSED_AUDIO_DIR;
            ui.label(if lang::english() { format!("{} file(s) will be moved to “audio/{folder}”:", files.len()) } else { format!("{} Datei(en) werden nach „audio/{folder}“ verschoben:", files.len()) });
            ui.add_space(6.0);
            egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                for file in files.iter().take(SHOWN) {
                    ui.label(RichText::new(file).color(BRIGHT));
                }
                if files.len() > SHOWN {
                    ui.label(RichText::new(format!("… {} {}", files.len() - SHOWN, lang::t("weitere", "more"))).color(MUTED));
                }
            });
            ui.add_space(6.0);
            ui.label(RichText::new(lang::t("Nichts wird gelöscht.", "Nothing is deleted.")).color(MUTED));
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button(lang::t("Verschieben", "Move")).clicked() {
                    result = Some(true);
                }
                if ui.button(lang::t("Abbrechen", "Cancel")).clicked() {
                    result = Some(false);
                }
            });
        });
        match result {
            Some(true) => {
                let folder = store::UNUSED_AUDIO_DIR;
                let (moved, failed) = store::move_unused_audio(&show.path.parent().unwrap_or(Path::new(".")).join("audio"), &files);
                let mut text = if lang::english() { format!("Moved {} file(s) to “audio/{folder}”.", moved.len()) } else { format!("{} Datei(en) nach „audio/{folder}“ verschoben.", moved.len()) };
                if !failed.is_empty() {
                    text += &if lang::english() { format!(" {} file(s) could not be moved.", failed.len()) } else { format!(" {} Datei(en) konnten nicht verschoben werden.", failed.len()) };
                }
                self.message = Some(text);
            }
            Some(false) => {}
            None if open => self.unused_audio = Some(files),
            None => {}
        }
    }

    fn roles_window(&mut self, ctx: &egui::Context) {
        let (Some(mut editor), Some(show)) = (self.roles_ui.take(), &mut self.show) else { return };
        let mut open = true;
        let mut result = None;
        let mixers = self.settings.mixers.len();
        egui::Window::new(if self.settings.language == "en" { "Role Editor" } else { "Rolleneditor" })
            .open(&mut open)
            .default_size([620.0, 560.0])
            .show(ctx, |ui| result = editor.show(ui, mixers));
        match result {
            Some(true) => {
                let (roles, groups, renames) = editor.result();
                show.script.save_roles(&roles, &groups, &renames);
                self.after_edit();
            }
            Some(false) => {}
            None if open => self.roles_ui = Some(editor),
            None => {}
        }
    }

    fn live_window(&mut self, ctx: &egui::Context) {
        if !self.live_open {
            return;
        }
        let Some(show) = &self.show else { return };
        let cx = Context { script: &show.script, cast: &show.cast, snapshot: &self.snapshot, locked: self.locked, line_numbers: self.settings.line_numbers, group_mics: self.settings.group_mics, has_editor: !self.settings.editor_command.trim().is_empty(), vim: self.settings.vim_keys, can_paste: self.copied.is_some() };
        let mut requests = Vec::new();
        let mut close = false;
        let builder = egui::ViewportBuilder::default().with_title(self.t("MDstage — Live-Ansicht", "MDstage — Live View")).with_inner_size([980.0, 860.0]);
        ctx.show_viewport_immediate(egui::ViewportId::from_hash_of("live"), builder, |ctx, _| {
            requests = self.live.show(ctx, &cx, self.settings.emergency_light.is_some());
            if !ctx.wants_keyboard_input() {
                if ctx.input(|i| i.key_pressed(Key::Space)) {
                    requests.push(Request::Go);
                }
                if ctx.input(|i| i.key_pressed(Key::Backspace)) {
                    requests.push(Request::Back);
                }
            }
            close = ctx.input(|i| i.viewport().close_requested());
        });
        for request in requests {
            show.session.send(request);
        }
        if close {
            self.live_open = false;
        }
    }
}

/// The details of a connection from the cue in `block` to another cue.
enum LinkDialog {
    /// Fire by itself this long after `source` fires.
    /// `at_place`: if the time lies within the source's audio, hang the auto-cue on that
    /// place in it (it then fires on every pass of a loop) instead of counting once.
    /// `in_group`: the source is one of several variants; `whole_group`: a delay then
    /// counts from whichever of them is fired, not only from the one that was clicked.
    Delay { block: usize, source: mdstage_core::cues::Note, seconds: f64, at_place: bool, in_group: bool, whole_group: bool },
    /// Change the audio of `target` when the cue fires.
    Adjust { block: usize, target: mdstage_core::cues::Note, fadeout: bool, volume: f64, fadetime: f64 },
}

/// Where the pointer is in the window, asked of the system rather than taken from the
/// window's own events (which stop while something is dragged in from another program).
/// `None` where the system does not tell (Linux) or the window's place is not known.
fn system_pointer(ctx: &egui::Context) -> Option<egui::Pos2> {
    let (x, y) = pointer::on_screen()?;
    let (inner, scale) = ctx.input(|i| (i.viewport().inner_rect, i.viewport().native_pixels_per_point.unwrap_or(1.0)));
    // macOS reports points like the window does; elsewhere the pointer comes in pixels.
    let scale = if cfg!(target_os = "macos") { 1.0 } else { scale };
    let zoom = ctx.zoom_factor();
    Some(((egui::pos2(x as f32, y as f32) / scale - inner?.min.to_vec2()).to_vec2() / zoom).to_pos2())
}

fn note_value(note: mdstage_core::cues::Note) -> mdstage_core::yaml::Value {
    let mut map = serde_yaml_mapping();
    map.insert("ch".into(), note.ch.into());
    map.insert("note".into(), note.note.into());
    map.into()
}

const EXPORT_DEFAULTS: mdstage_core::export::Options = mdstage_core::export::Options { cues: true, colours: true, grouped_mics: true };

/// `mdstage SHOW.md --export OUT.pdf|OUT.docx`: write the book and exit, without a window.
fn export_from_command_line(show: &Path, out: &Path) -> Result<(), String> {
    let script = Script::parse(&std::fs::read_to_string(show).map_err(|e| format!("{}: {e}", show.display()))?);
    let book = script.book(&Cast::from_script(&script, false), EXPORT_DEFAULTS, &[]);
    let date = store::today();
    let bytes = match out.extension().and_then(|e| e.to_str()) {
        Some("pdf") => export::pdf(&book, &date)?,
        Some("docx") => export::docx(&book, &date)?,
        _ => return Err("the output file must end in .pdf or .docx".into()),
    };
    std::fs::write(out, bytes).map_err(|e| format!("{}: {e}", out.display()))
}

/// An empty YAML mapping (the type lives in a dependency of `mdstage-core`).
fn serde_yaml_mapping() -> mdstage_core::yaml::Mapping {
    mdstage_core::yaml::Mapping::new()
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        lang::set_english(self.english());
        if let Some(show) = &self.show {
            self.snapshot = show.session.snapshot();
            // Keep clocks, cursors and progress bars moving.
            ctx.request_repaint_after(Duration::from_millis(33));
        }
        self.shortcuts(ctx);
        // Files dropped onto the window. Where they landed is only known once the pointer
        // reports in again (it does not while the system drags), so wait a moment for that.
        // While audio files are dragged over the window, a line in the script shows where
        // they would become cues. The window is not told where the pointer is during
        // such a drag, so the system is asked.
        let audio_hovers = ctx.input(|i| i.raw.hovered_files.iter().any(|f| f.path.as_ref().and_then(|p| p.file_name()?.to_str()).is_some_and(store::is_audio_name)));
        let may_insert = self.show.is_some() && !self.locked && self.cue_dialog.is_none() && self.settings_ui.is_none() && self.roles_ui.is_none();
        if audio_hovers {
            self.drag_at = system_pointer(ctx);
            ctx.request_repaint();
        }
        self.view.show_drop_line(self.drag_at.filter(|_| audio_hovers && may_insert));
        let dropped: Vec<PathBuf> = ctx.input(|i| i.raw.dropped_files.iter().filter_map(|f| f.path.clone()).collect());
        let pointer = ctx.input(|i| i.pointer.latest_pos());
        if !dropped.is_empty() {
            match self.drag_at.take() {
                // Dropped where the line was.
                Some(at) => self.audio_dropped(dropped, Some(at)),
                None => self.pending_drop = Some((dropped, pointer, std::time::Instant::now())),
            }
        } else if !audio_hovers {
            self.drag_at = None;
        }
        if let Some((files, before, since)) = self.pending_drop.take() {
            let landed = pointer.filter(|p| Some(*p) != before);
            if landed.is_some() || since.elapsed() > Duration::from_millis(1200) {
                self.audio_dropped(files, landed.or(pointer));
            } else {
                self.pending_drop = Some((files, before, since));
                ctx.request_repaint();
            }
        }

        let bar = |fill, x, y| egui::Frame::new().fill(fill).inner_margin(egui::Margin::symmetric(x, y));
        egui::TopBottomPanel::top("menu").frame(bar(PANEL, 8, 2)).show_separator_line(false).show(ctx, |ui| self.menu(ui));
        egui::TopBottomPanel::top("tools").frame(bar(theme::BAR, 10, 8).stroke(egui::Stroke::new(1.0_f32, Color32::BLACK))).show(ctx, |ui| self.toolbar(ui));
        // Where in the show the view is: the act and scene its top lies under.
        if let (Some(_), (act, scene)) = (&self.show, self.view.current_headings()) {
            if act.is_some() || scene.is_some() {
                egui::TopBottomPanel::top("scene").frame(bar(theme::BAR, 14, 6).stroke(egui::Stroke::new(1.0_f32, Color32::BLACK))).show_separator_line(false).show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        let heading = |text: &str, colour| egui::Label::new(RichText::new(text).size(20.0).strong().color(colour)).truncate();
                        match (act, scene) {
                            (Some(act), Some(scene)) => {
                                ui.label(RichText::new(act).size(14.0).color(MUTED));
                                ui.label(RichText::new("›").size(14.0).color(MUTED));
                                ui.add(heading(scene, BRIGHT));
                            }
                            (one, other) => drop(ui.add(heading(one.or(other).unwrap_or_default(), BRIGHT))),
                        }
                    });
                });
            }
        }
        egui::TopBottomPanel::top("notices").frame(bar(PANEL, 10, 3)).show_separator_line(false).show(ctx, |ui| {
            self.banners(ui);
            if let Some(hint) = self.view.picking_hint() {
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new(hint).color(YELLOW));
                    if ui.small_button(lang::t("Abbrechen", "Cancel")).clicked() || ui.input(|i| i.key_pressed(Key::Escape)) {
                        self.view.cancel_pick();
                    }
                });
            }
            if let Some(show) = &self.show {
                // The search sets out from where the show is: the cue fired last.
                let at = self.snapshot.latest.or(self.snapshot.current).and_then(|cue| Cues::new(&show.script).block_index(cue)).unwrap_or(0);
                self.view.search_bar(ui, &show.script, at);
            }
        });
        egui::TopBottomPanel::bottom("status").frame(bar(PANEL, 10, 3)).show(ctx, |ui| self.status_bar(ui));

        let mut actions = Vec::new();
        if self.show.is_some() && !self.settings.sidebar_hidden {
            let frame = egui::Frame::new().fill(theme::SIDEBAR).inner_margin(egui::Margin::symmetric(12, 8));
            let mut hide = false;
            egui::SidePanel::left("scenes").default_width(230.0).frame(frame).show(ctx, |ui| hide = self.view.sidebar(ui));
            if hide {
                self.toggle_sidebar();
            }
        }
        egui::CentralPanel::default().show(ctx, |ui| match &self.show {
            Some(show) => {
                let cx = Context { script: &show.script, cast: &show.cast, snapshot: &self.snapshot, locked: self.locked, line_numbers: self.settings.line_numbers, group_mics: self.settings.group_mics, has_editor: !self.settings.editor_command.trim().is_empty(), vim: self.settings.vim_keys, can_paste: self.copied.is_some() };
                self.view.show(ui, &cx, &mut actions);
            }
            None => {
                ui.vertical_centered(|ui| {
                    ui.add_space(120.0);
                    ui.label(RichText::new("MDstage").size(40.0).color(BRIGHT));
                    ui.label(RichText::new(self.t("Das interaktive Inspizientenbuch", "The interactive prompt book")).color(MUTED));
                    ui.add_space(24.0);
                    if ui.button(self.t("Datei öffnen…", "Open File…")).clicked() {
                        self.open_dialog(ctx);
                    }
                    if ui.button(self.t("Neue Datei…", "New File…")).clicked() {
                        self.new_dialog(ctx);
                    }
                });
            }
        });
        self.apply(actions);

        // Where the show has got to is remembered, for the next time it is opened.
        if let (Some(next), Some(show)) = (self.snapshot.next, &self.show) {
            let key = show.path.to_string_lossy().into_owned();
            if self.settings.next_cue.get(&key) != Some(&next) {
                self.settings.next_cue.insert(key, next);
                self.save_settings();
            }
        }

        // Follow the show: bring the operator's cue into view when it changes.
        if self.snapshot.current != self.followed {
            self.followed = self.snapshot.current;
            if let Some(cue) = self.snapshot.current {
                self.view.scroll_to_cue(cue);
            }
        }
        // A cue that fires by itself is shown as well: the view goes there and outlines
        // it for a moment. The operator's own cue stays the current one.
        let fired = self.snapshot.fired.len();
        if fired != self.followed_fired {
            // A cue fired (or was taken back): the space bar is no longer a waveform's.
            self.space_cue = None;
        }
        if fired > self.followed_fired {
            if let Some(cue) = self.snapshot.latest.filter(|latest| Some(*latest) != self.snapshot.current) {
                self.view.go_to_cue(cue, ctx.input(|i| i.time));
            }
        }
        self.followed_fired = fired;
        self.live_window(ctx);
        self.settings_window(ctx);
        self.cue_window(ctx);
        self.roles_window(ctx);
        self.export_window(ctx);
        self.unused_audio_window(ctx);
        self.link_window(ctx);
        self.auto_mic_window(ctx);
        self.cleanup_window(ctx);
        self.about_window(ctx);
        self.version_windows(ctx);
        self.swap_window(ctx);
    }
}

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [show, flag, out] = args.as_slice() {
        if flag == "--export" {
            if let Err(e) = export_from_command_line(Path::new(show), Path::new(out)) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return Ok(());
        }
    }
    let path = args.first().map(PathBuf::from);
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../assets/mdstage-512.png")).unwrap_or_default();
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([1200.0, 900.0]).with_title("MDstage").with_icon(icon),
        ..Default::default()
    };
    eframe::run_native("MDstage", options, Box::new(move |cc| Ok(Box::new(App::new(cc, path)))))
}
