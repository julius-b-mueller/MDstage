//! MDstage: the interactive prompt book.
//!
//!     mdstage [SHOW.md]
//!
//! Without an argument the last show is opened again.

mod cue_dialog;
mod export;
mod live;
mod roles_ui;
mod script_view;
mod settings_ui;
mod store;
mod theme;
mod waveform;

use std::path::{Path, PathBuf};
use std::time::Duration;

use eframe::egui::{self, Color32, Key, KeyboardShortcut, Modifiers, RichText};
use mdstage_core::mic::Cast;
use mdstage_core::validate::Report;
use mdstage_core::{Block, Script};
use mdstage_engine::mtc::Timecode;
use mdstage_engine::session::{Request, Session, Snapshot};
use mdstage_engine::settings::Settings;

use cue_dialog::CueDialog;
use roles_ui::RolesUi;
use script_view::{Action, Context, ScriptView};
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
}

struct App {
    settings: Settings,
    show: Option<OpenShow>,
    snapshot: Snapshot,
    view: ScriptView,
    live_open: bool,
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
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, path: Option<PathBuf>) -> App {
        theme::apply(&cc.egui_ctx);
        let settings = Settings::load(&store::settings_path());
        let last = settings.recent_files.first().map(PathBuf::from).filter(|p| p.exists());
        let mut app = App {
            settings,
            show: None,
            snapshot: Snapshot::default(),
            view: ScriptView::default(),
            live_open: false,
            settings_ui: None,
            cue_dialog: None,
            roles_ui: None,
            export: None,
            copied: None,
            locked: false,
            message: None,
            followed: None,
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

    fn save_settings(&mut self) {
        if let Err(e) = self.settings.save(&store::settings_path()) {
            self.message = Some(format!("Einstellungen nicht gespeichert: {e}"));
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
                self.message = Some(format!("Show nicht gestartet: {e}"));
                return;
            }
        };
        self.view.reset(dir.join("audio"), ctx);
        self.show = Some(OpenShow {
            path: path.to_path_buf(),
            cast: Cast::from_script(&loaded.script, self.english()),
            report: loaded.script.validate(),
            script: loaded.script,
            session,
            trusted: loaded.trusted,
            notes: loaded.notes,
        });
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
        if let Err(e) = store::save(&show.path, &show.script, &mut self.settings, show.trusted) {
            self.message = Some(format!("Nicht gespeichert: {e}"));
        }
        show.session.send(Request::SetScript(Box::new(show.script.clone())));
        self.view.invalidate();
        self.save_settings();
    }

    fn apply(&mut self, actions: Vec<Action>) {
        for action in actions {
            match &action {
                // With the live view open a click only chooses the next Go.
                Action::Fire(cue) if self.live_open || self.locked => self.request(Request::Arm(Some(*cue))),
                Action::Fire(cue) => self.request(Request::Fire(*cue)),
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
                    let mut number = 0;
                    let mut links = Vec::new();
                    for (i, b) in show.script.blocks.iter().enumerate() {
                        let Block::Cue(cue) = b else { continue };
                        number += 1;
                        let Some(note) = cue.note().filter(|_| i != block || existing.is_none()) else { continue };
                        let what = cue.text("note").map(str::to_string).or_else(|| cue.audio().map(|a| a.parts[0].audios[0].file.clone())).unwrap_or_default();
                        links.push((note, format!("Cue {number}  ({note})  {what}").trim_end().to_string()));
                    }
                    self.cue_dialog = Some(CueDialog::new(block, existing.is_none(), existing, &audio_dir, others_auto, links));
                }
                Action::NewText(at) => {
                    let at = *at;
                    if let Some(show) = &mut self.show {
                        show.script.insert_block(at, Block::Text(String::new()));
                        self.view.edit(&show.script, at, true);
                    }
                }
                Action::Move { block, up } => {
                    if let Some(show) = &mut self.show {
                        show.script.move_block(*block, *up);
                    }
                    self.after_edit();
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
                Action::Markers { block, start, end } => {
                    let (start, end) = (*start, *end);
                    let Some(Block::Cue(cue)) = self.show.as_mut().and_then(|s| s.script.blocks.get_mut(*block)) else { continue };
                    let mut yaml = cue.yaml.clone();
                    let Some(map) = yaml.as_mapping_mut() else { continue };
                    // The short form `music: file.wav` becomes the object form to hold the times.
                    if let Some(file) = map.get("music").and_then(|m| m.as_str()).map(str::to_string) {
                        let mut music = serde_yaml_mapping();
                        music.insert("file".into(), file.into());
                        map.insert("music".into(), music.into());
                    }
                    let Some(music) = map.get_mut("music").and_then(|m| m.as_mapping_mut()) else { continue };
                    let milliseconds = |seconds: f64| (seconds * 1000.0).round() / 1000.0;
                    music.insert("start".into(), milliseconds(start).into());
                    music.insert("end".into(), milliseconds(end).into());
                    cue.set_yaml(yaml);
                    self.after_edit();
                }
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
        if pressed(ctx, Key::F) && self.show.is_some() {
            self.view.open_search();
        }
        if pressed(ctx, Key::E) && self.show.is_some() {
            self.export.get_or_insert((EXPORT_DEFAULTS, false));
        }
        if pressed(ctx, Key::Comma) && self.settings_ui.is_none() {
            self.settings_ui = Some(SettingsUi::new(&self.settings));
        }
        // Go and Back only when nothing is being typed.
        if self.show.is_some() && !self.view.is_editing() && !ctx.wants_keyboard_input() {
            if ctx.input(|i| i.key_pressed(Key::Space)) {
                self.request(Request::Go);
            }
            if ctx.input(|i| i.key_pressed(Key::Backspace)) {
                self.request(Request::Back);
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
                });
                ui.separator();
                if ui.button(self.t("YAML aufräumen…", "Clean up YAML…")).clicked() {
                    ui.close_menu();
                    let removed = self.show.as_mut().map(|s| s.script.cleanup());
                    match removed {
                        Some(removed) if !removed.is_empty() => {
                            self.after_edit();
                            self.message = Some(format!("{} Schlüssel entfernt: {}", removed.len(), removed.iter().map(|r| r.key.as_str()).collect::<Vec<_>>().join(", ")));
                        }
                        Some(_) => self.message = Some(self.t("Nichts aufzuräumen.", "Nothing to clean up.").into()),
                        None => {}
                    }
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
                    self.settings_ui = Some(SettingsUi::new(&self.settings));
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
                if ui.button(self.t("Zum aktuellen Cue", "Show current cue")).clicked() {
                    ui.close_menu();
                    if let Some(cue) = self.snapshot.current.or(self.snapshot.next) {
                        self.view.scroll_to_cue(cue);
                    }
                }
            });
        });
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let has_show = self.show.is_some();
            let go = egui::Button::new(RichText::new("GO").size(18.0).color(Color32::BLACK).strong()).fill(GREEN).min_size(egui::vec2(72.0, 34.0));
            if ui.add_enabled(has_show && self.snapshot.next.is_some(), go).on_hover_text(self.t("Leertaste", "Space")).clicked() {
                self.request(Request::Go);
            }
            if ui.add_enabled(has_show, egui::Button::new("Back").min_size(egui::vec2(56.0, 34.0))).on_hover_text(self.t("Rücktaste", "Backspace")).clicked() {
                self.request(Request::Back);
            }
            ui.separator();
            let tc = self.snapshot.timecode.map_or("--:--:--:--".to_string(), |s| Timecode::from_frames((s * 25.0).floor().max(0.0) as u64).to_string());
            ui.label(RichText::new(tc).monospace().size(18.0).color(if self.snapshot.timecode.is_some() { BRIGHT } else { MUTED }));
            ui.separator();
            if ui.add_enabled(has_show, egui::Button::new(RichText::new(self.t("Musik Stop", "Music Stop")).color(RED))).clicked() {
                self.request(Request::StopAll);
            }
            if ui.add_enabled(has_show, egui::Button::new(RichText::new(self.t("Mics aus", "Mics Off")).color(RED))).clicked() {
                self.request(Request::MicsOff);
            }
            if self.settings.emergency_light.is_some() {
                let on = self.snapshot.emergency_light;
                let label = RichText::new(self.t("Notlicht", "Emergency Light")).color(if on { Color32::BLACK } else { RED });
                let button = egui::Button::new(label).fill(if on { RED } else { Color32::TRANSPARENT });
                if ui.add_enabled(has_show, button).clicked() {
                    self.request(Request::EmergencyLight(!on));
                }
            }
            ui.separator();
            let (lock, lock_hint) = (self.t("🔒 Gesperrt", "🔒 Locked"), self.t("Kein Bearbeiten; Klicks schalten nur scharf", "No editing; clicks only arm"));
            let live = self.t("Live-Ansicht", "Live View");
            ui.toggle_value(&mut self.locked, lock).on_hover_text(lock_hint);
            ui.toggle_value(&mut self.live_open, live);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if let Some(files) = self.snapshot.loading {
                    ui.label(RichText::new(format!("{} ({files})", self.t("Audio lädt", "Loading audio"))).color(YELLOW));
                }
                let output = match &self.snapshot.output {
                    Some(o) => format!("{} · {} Kanäle · {} Hz", o.name, o.channels, o.sample_rate),
                    None if has_show => self.t("kein Audiogerät", "no audio device").to_string(),
                    None => String::new(),
                };
                ui.label(RichText::new(output).color(MUTED));
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
        let mut lines: Vec<(String, Color32)> = show.notes.iter().map(|n| (n.clone(), MUTED)).collect();
        lines.extend(show.report.problems.iter().map(|p| (format!("YAML-Block {}: {}", p.block, p.message), RED)));
        lines.extend(show.report.note_conflicts.iter().map(|c| (format!("Trigger-Note {} doppelt: YAML-Blöcke {} und {}", c.note, c.first, c.second), RED)));
        lines.extend(self.snapshot.problems.iter().map(|p| (p.clone(), RED)));
        let mut clear = false;
        if !lines.is_empty() {
            egui::ScrollArea::vertical().id_salt("banner").max_height(88.0).show(ui, |ui| {
                for (line, colour) in &lines {
                    ui.label(RichText::new(line).color(*colour).size(13.0));
                }
            });
            clear = !self.snapshot.problems.is_empty() && ui.small_button(self.t("Meldungen der Engine ausblenden", "Dismiss engine messages")).clicked();
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
        let channels = self.show.as_ref().map(|s| s.script.virtual_channels()).unwrap_or_default();
        let mut open = true;
        let mut result = None;
        egui::Window::new(self.t("Einstellungen", "Settings")).open(&mut open).default_size([760.0, 620.0]).show(ctx, |ui| {
            result = form.show(ui, &channels, self.snapshot.heard);
        });
        match result {
            Some(true) => {
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
            Ok(()) => format!("Exportiert: {}", path.display()),
            Err(e) => format!("Export fehlgeschlagen: {e}"),
        });
        self.export = None;
    }

    fn cue_window(&mut self, ctx: &egui::Context) {
        let (Some(mut dialog), Some(show)) = (self.cue_dialog.take(), &mut self.show) else { return };
        let title = if dialog.is_new { "Neuer Cue" } else { "Cue bearbeiten" };
        let mut open = true;
        let mut result = None;
        egui::Window::new(title).open(&mut open).default_size([640.0, 600.0]).show(ctx, |ui| result = dialog.show(ui, &show.cast));
        match result {
            Some(true) => {
                if dialog.is_new {
                    let cue = show.script.new_cue(dialog.value());
                    show.script.insert_block(dialog.block, cue);
                } else if let Some(Block::Cue(cue)) = show.script.blocks.get_mut(dialog.block) {
                    cue.set_yaml(dialog.value());
                    // A cue must keep a trigger note even if it was deleted from the YAML.
                    show.script.assign_trigger_notes();
                }
                self.after_edit();
            }
            Some(false) => {}
            None if open => self.cue_dialog = Some(dialog),
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
        let cx = Context { script: &show.script, cast: &show.cast, snapshot: &self.snapshot, locked: self.locked, can_paste: self.copied.is_some() };
        let mut requests = Vec::new();
        let mut close = false;
        let builder = egui::ViewportBuilder::default().with_title(self.t("MDstage — Live-Ansicht", "MDstage — Live View")).with_inner_size([620.0, 720.0]);
        ctx.show_viewport_immediate(egui::ViewportId::from_hash_of("live"), builder, |ctx, _| {
            egui::CentralPanel::default().show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| requests = live::show(ui, &cx));
            });
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
        if let Some(show) = &self.show {
            self.snapshot = show.session.snapshot();
            // Keep clocks, cursors and progress bars moving.
            ctx.request_repaint_after(Duration::from_millis(33));
        }
        self.shortcuts(ctx);

        egui::TopBottomPanel::top("top").show(ctx, |ui| {
            self.menu(ui);
            self.toolbar(ui);
            self.banners(ui);
            if let Some(show) = &self.show {
                self.view.search_bar(ui, &show.script);
            }
            ui.add_space(2.0);
        });

        let mut actions = Vec::new();
        if self.show.is_some() {
            egui::SidePanel::left("scenes").default_width(220.0).show(ctx, |ui| self.view.sidebar(ui));
        }
        egui::CentralPanel::default().show(ctx, |ui| match &self.show {
            Some(show) => {
                let cx = Context { script: &show.script, cast: &show.cast, snapshot: &self.snapshot, locked: self.locked, can_paste: self.copied.is_some() };
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

        // Follow the show: bring the operator's cue into view when it changes.
        if self.snapshot.current != self.followed {
            self.followed = self.snapshot.current;
            if let Some(cue) = self.snapshot.current {
                self.view.scroll_to_cue(cue);
            }
        }
        self.live_window(ctx);
        self.settings_window(ctx);
        self.cue_window(ctx);
        self.roles_window(ctx);
        self.export_window(ctx);
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
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([1200.0, 900.0]).with_title("MDstage"),
        ..Default::default()
    };
    eframe::run_native("MDstage", options, Box::new(move |cc| Ok(Box::new(App::new(cc, path)))))
}
