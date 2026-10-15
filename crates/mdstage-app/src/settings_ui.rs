//! The settings window: this machine's audio device, routing, output devices, mixers,
//! remote control and display server.

use eframe::egui::{self, Color32, RichText, Ui};
use mdstage_core::cues::Note;
use mdstage_engine::inputs::Inputs;
use mdstage_engine::outputs::SystemMidi;
use mdstage_engine::mtc::FrameRate;
use mdstage_engine::settings::{ArgSetting, CueTriggerSetting, DeviceSetting, EmergencyLightSetting, MixerSetting, NoteSetting, Settings};

use crate::lang::t;
use crate::theme::*;

/// Which note field "MIDI learn" is waiting to fill.
#[derive(Clone, Copy, PartialEq)]
enum Learning {
    Go,
    Back,
    Up,
    Down,
}

/// The frame rate of a device's timecode: its own, or the show's (`None`).
fn rate_choice(ui: &mut Ui, id: impl std::hash::Hash, rate: &mut Option<FrameRate>) {
    let like_show = t("wie die Show", "as the show");
    egui::ComboBox::from_id_salt(id).selected_text(rate.map_or(like_show, FrameRate::label)).width(120.0).show_ui(ui, |ui| {
        ui.selectable_value(rate, None, like_show);
        for choice in FrameRate::ALL {
            ui.selectable_value(rate, Some(choice), choice.label());
        }
    });
}

pub struct SettingsUi {
    /// The settings being edited; applied on "Save".
    pub draft: Settings,
    audio_devices: Vec<String>,
    midi_outputs: Vec<String>,
    midi_inputs: Vec<String>,
    /// When the MIDI ports were last looked up: devices plugged in while the settings
    /// are open turn up in the lists.
    midi_scanned: std::time::Instant,
    learning: Option<(Learning, Option<Note>)>,
    /// The show's virtual channels as edited: the name each had when the window opened
    /// (`None` for a new one) and its name now.
    pub channels: Vec<(Option<String>, String)>,
    /// Set when a channel's test button was pressed: the physical output (0-based).
    pub test_output: Option<usize>,
    /// The colour each output device is marked with on the cues, by device name. Kept
    /// in the show file, with the device's name and kind.
    pub colours: std::collections::HashMap<String, String>,
    /// The window listing the Vim keys is open.
    vim_help: bool,
    /// Stylesheets in the open show's `css/` folder.
    css_files: Vec<String>,
    /// This machine's address in the local network, if it has one.
    lan_address: Option<String>,
    /// The open show's file, as its settings are kept under (its frame rate).
    show_file: Option<String>,
}

/// A text field that takes the remaining room up to `width`.
fn field(ui: &mut Ui, value: &mut String, hint: &str, width: f32) {
    ui.add(egui::TextEdit::singleline(value).hint_text(hint).desired_width(width));
}

/// Choose the colour a device is marked with on the cues. `was` is the device's name
/// before this frame's edit, `name` its name now: the colour moves along with a rename.
fn colour_choice(ui: &mut Ui, id: impl std::hash::Hash, colours: &mut std::collections::HashMap<String, String>, was: &str, name: &str) {
    if was != name {
        if let Some(colour) = colours.remove(was) {
            colours.insert(name.to_string(), colour);
        }
    }
    let current = colours.get(name).cloned().unwrap_or_default();
    let mut picked = current.clone();
    let swatch = |colour: &str| RichText::new("●").color(named(Some(colour)).unwrap_or(MUTED));
    egui::ComboBox::from_id_salt(id).selected_text(swatch(&picked)).width(36.0).show_ui(ui, |ui| {
        ui.selectable_value(&mut picked, String::new(), t("keine Farbe", "no colour"));
        for colour in ["red", "green", "yellow", "blue", "purple", "cyan", "darkred", "darkgreen", "darkyellow", "darkblue", "darkpurple", "darkcyan"] {
            ui.selectable_value(&mut picked, colour.to_string(), swatch(colour));
        }
    });
    if picked != current {
        match picked.is_empty() {
            true => drop(colours.remove(name)),
            false => drop(colours.insert(name.to_string(), picked)),
        }
    }
}

/// Choose one of `options`, or type a name that is not present right now.
fn port_picker(ui: &mut Ui, id: impl std::hash::Hash, value: &mut String, options: &[String]) {
    egui::ComboBox::from_id_salt(id).selected_text(if value.is_empty() { "—" } else { value.as_str() }).width(220.0).show_ui(ui, |ui| {
        for option in options {
            ui.selectable_value(value, option.clone(), option);
        }
        if !value.is_empty() && !options.contains(value) {
            ui.label(RichText::new(format!("{value} ({})", t("nicht angeschlossen", "not connected"))).color(RED));
        }
    });
}

/// Type and value of an optional OSC argument.
fn arg_fields(ui: &mut Ui, id: impl std::hash::Hash, arg: &mut ArgSetting) {
    let shown = if arg.kind.is_empty() { "none" } else { arg.kind.as_str() }.to_string();
    egui::ComboBox::from_id_salt(id).selected_text(shown).width(64.0).show_ui(ui, |ui| {
        for kind in ["none", "int", "float", "string"] {
            ui.selectable_value(&mut arg.kind, kind.to_string(), kind);
        }
    });
    if arg.kind != "none" && !arg.kind.is_empty() {
        ui.add(egui::TextEdit::singleline(&mut arg.value).desired_width(50.0));
    }
}

fn note_fields(ui: &mut Ui, note: &mut Option<NoteSetting>) {
    let mut on = note.is_some();
    if ui.checkbox(&mut on, "").changed() {
        *note = on.then_some(NoteSetting { ch: 1, note: 36 });
    }
    if let Some(n) = note {
        ui.label(t("Kanal", "Channel"));
        ui.add(egui::DragValue::new(&mut n.ch).range(1..=16));
        ui.label("Note");
        ui.add(egui::DragValue::new(&mut n.note).range(0..=127));
    }
}

impl SettingsUi {
    pub fn new(settings: &Settings) -> SettingsUi {
        SettingsUi {
            draft: settings.clone(),
            audio_devices: mdstage_engine::device::list_outputs().map(|l| l.into_iter().map(|d| d.name).collect()).unwrap_or_default(),
            midi_outputs: SystemMidi::port_names(),
            midi_inputs: Inputs::port_names(),
            midi_scanned: std::time::Instant::now(),
            learning: None,
            channels: Vec::new(),
            test_output: None,
            colours: Default::default(),
            vim_help: false,
            css_files: Vec::new(),
            // Asking which local address a route to the outside would use sends nothing.
            lan_address: std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| s.connect("192.0.2.1:9").and_then(|()| s.local_addr())).ok().map(|a| a.ip().to_string()),
            show_file: None,
        }
    }

    /// The device colours declared in the open show.
    pub fn with_colours(mut self, colours: std::collections::HashMap<String, String>) -> SettingsUi {
        self.colours = colours;
        self
    }

    /// List the stylesheets of the open show (`css/*.css` next to the show file).
    pub fn with_show_file(mut self, file: Option<String>) -> SettingsUi {
        self.show_file = file;
        self
    }

    pub fn with_show_dir(mut self, show_dir: Option<&std::path::Path>) -> SettingsUi {
        let entries = show_dir.and_then(|dir| std::fs::read_dir(dir.join("css")).ok());
        self.css_files = entries.into_iter().flatten().filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.to_lowercase().ends_with(".css")).collect();
        self.css_files.sort();
        self
    }

    /// Edit the virtual channels of the open show along with the settings.
    pub fn with_channels(mut self, names: Vec<String>) -> SettingsUi {
        self.channels = names.into_iter().map(|name| (Some(name.clone()), name)).collect();
        self
    }

    /// What is wrong with the channel names, if anything.
    pub fn channel_problem(&self) -> Option<&'static str> {
        let names: Vec<&str> = self.channels.iter().map(|(_, name)| name.trim()).collect();
        if names.iter().any(|name| name.is_empty()) {
            return Some(t("Jeder Kanal braucht einen Namen.", "Every channel needs a name."));
        }
        let twice = names.iter().enumerate().any(|(i, name)| names[..i].contains(name));
        twice.then(|| t("Namen müssen eindeutig sein.", "Names must be unique."))
    }

    /// The channel names as edited, and the renames `(old, new)` among them.
    pub fn channel_names(&self) -> (Vec<String>, Vec<(String, String)>) {
        let names = self.channels.iter().map(|(_, name)| name.trim().to_string()).collect();
        let renames = self.channels.iter().filter_map(|(was, name)| Some((was.clone()?, name.trim().to_string()))).filter(|(was, name)| was != name).collect();
        (names, renames)
    }

    /// Draw the form. `channels` are the open show's virtual channels, `heard` the last
    /// MIDI note that came in. Returns `Some(true)` on Save, `Some(false)` on Cancel.
    pub fn show(&mut self, ui: &mut Ui, has_show: bool, heard: Option<Note>) -> Option<bool> {
        let mut result = None;
        if self.midi_scanned.elapsed() >= std::time::Duration::from_secs(1) {
            self.midi_scanned = std::time::Instant::now();
            self.midi_outputs = SystemMidi::port_names();
            self.midi_inputs = Inputs::port_names();
        }
        ui.ctx().request_repaint_after(std::time::Duration::from_secs(1));
        let problem = self.channel_problem();
        let channels = &mut self.channels;
        let mut test_output = None;
        let (css_files, lan_address) = (&self.css_files, &self.lan_address);
        let colours = &mut self.colours;
        let mut vim_help = self.vim_help;
        egui::ScrollArea::vertical().auto_shrink([false, false]).max_height(ui.available_height() - 44.0).show(ui, |ui| {
            let draft = &mut self.draft;
            ui.heading(t("Allgemein", "General"));
            ui.horizontal(|ui| {
                ui.label(t("Sprache", "Language"));
                ui.selectable_value(&mut draft.language, "de".to_string(), "Deutsch");
                ui.selectable_value(&mut draft.language, "en".to_string(), "English");
            });
            ui.checkbox(&mut draft.outputs_blocked, t("Ausgaben an Geräte blockieren (MIDI, OSC, HTTP, Displays)", "Block output to devices (MIDI, OSC, HTTP, displays)"));
            ui.checkbox(&mut draft.open_locked, t("Gesperrt öffnen", "Open locked"));
            ui.checkbox(&mut draft.group_mics, t("Mikrofone in Gruppen bündeln", "Bundle microphones into groups"));
            ui.horizontal(|ui| {
                ui.label(t("Auto-Mic: Mikrofone verzögert ausschalten", "Auto mic: switch microphones off after"));
                ui.add(egui::DragValue::new(&mut draft.mic_off_delay).range(0.0..=30.0).speed(0.1).fixed_decimals(1).suffix(" s"))
                    .on_hover_text(t("Ein Auto-Mic-Cue schaltet neue Mikrofone sofort ein und nicht mehr gebrauchte erst nach dieser Zeit aus. Wer abgeht, kann so zu Ende sprechen. 0 schaltet sofort aus.", "An auto-mic cue switches new microphones on at once and those no longer needed off only after this time, so that whoever leaves can finish speaking. 0 switches off at once."));
            });
            ui.checkbox(&mut draft.line_numbers, t("Markdown-Zeilennummern anzeigen", "Show Markdown line numbers"));
            ui.horizontal(|ui| {
                ui.checkbox(&mut draft.vim_keys, t("Vim-Tasten im Texteditor", "Vim keys in the text editor")).on_hover_text(t("Normal- und Einfügemodus beim Bearbeiten von Text", "Normal and insert mode when editing text"));
                if ui.small_button("Info").on_hover_text(t("Alle unterstützten Tasten anzeigen", "Show all supported keys")).clicked() {
                    vim_help = !vim_help;
                }
            });
            ui.horizontal(|ui| {
                ui.label(t("Texteditor (Rechtsklick auf einen Block)", "Text editor (right-click on a block)"));
                let presets = [("", t("— deaktiviert —", "— disabled —")), ("code -g {file}:{line}", "VS Code"), ("zed {file}:{line}", "Zed")];
                let shown = presets.iter().find(|(command, _)| *command == draft.editor_command).map_or(t("eigener Befehl", "custom command"), |(_, label)| label);
                egui::ComboBox::from_id_salt("editor").selected_text(shown).show_ui(ui, |ui| {
                    for (command, label) in presets {
                        ui.selectable_value(&mut draft.editor_command, command.to_string(), label);
                    }
                });
                field(ui, &mut draft.editor_command, t("z. B. myeditor {file}:{line}", "e.g. myeditor {file}:{line}"), 220.0);
            });
            ui.label(RichText::new(t("{file} = Dateipfad · {line} = Zeilennummer", "{file} = file path · {line} = line number")).color(MUTED));

            ui.add_space(12.0);
            ui.heading("Audio");
            ui.horizontal(|ui| {
                ui.label(t("Ausgabegerät", "Output device"));
                let current = draft.audio_device.clone().unwrap_or_else(|| t("Systemstandard", "System default").into());
                egui::ComboBox::from_id_salt("audio-device").selected_text(current).width(260.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.audio_device, None, t("Systemstandard", "System default"));
                    for name in &self.audio_devices {
                        ui.selectable_value(&mut draft.audio_device, Some(name.clone()), name);
                    }
                });
            });
            ui.label(RichText::new(t("Ein anderes Gerät wird sofort übernommen, wenn es die Abtastrate der geöffneten Show kann.", "Another device is switched to at once if it can run at the sample rate of the open show.")).color(MUTED));
            if has_show {
                ui.add_space(6.0);
                ui.label(t("Virtuelle Kanäle → Ausgang des Geräts", "Virtual channels → output of the device"));
                ui.label(RichText::new(t("Die Namen stehen in der Show-Datei, die Ausgänge gelten nur auf diesem Rechner. Umbenennen passt die Patches aller Cues an.", "The names are kept in the show file, the outputs apply to this machine only. Renaming follows through the patches of all cues.")).color(MUTED));
                let mut remove = None;
                egui::Grid::new("routing").show(ui, |ui| {
                    for (i, (was, name)) in channels.iter_mut().enumerate() {
                        ui.add(egui::TextEdit::singleline(name).desired_width(140.0));
                        // Routing is kept by name: under the old one until the rename is saved.
                        let key = was.clone().unwrap_or_else(|| name.clone());
                        // Shown 1-based, stored 0-based.
                        let mut output = draft.routing.get(&key).copied().unwrap_or(i) + 1;
                        if ui.add(egui::DragValue::new(&mut output).range(1..=64).prefix(t("Ausgang ", "Output "))).changed() {
                            draft.routing.insert(key, output - 1);
                        }
                        if ui.add(egui::Button::image(Icon::Play.image(11.0, TEXT)).small()).on_hover_text(t("Testton auf diesem Ausgang", "Test tone on this output")).clicked() {
                            test_output = Some(output - 1);
                        }
                        if ui.small_button("×").on_hover_text(t("Kanal entfernen", "Remove channel")).clicked() {
                            remove = Some(i);
                        }
                        ui.end_row();
                    }
                });
                if let Some(i) = remove {
                    channels.remove(i);
                }
                if ui.button(t("+ Kanal", "+ Channel")).clicked() {
                    channels.push((None, String::new()));
                }
                if let Some(problem) = problem {
                    ui.label(RichText::new(problem).color(RED));
                }
            }

            ui.add_space(12.0);
            ui.heading(t("Ausgabegeräte", "Output devices"));
            ui.label(RichText::new(t("Der Name muss dem Gerätenamen in der Show-Datei entsprechen. Adressen bleiben auf diesem Rechner.", "The name must match the device name in the show file. Addresses stay on this machine.")).color(MUTED));
            let mut remove = None;
            for (i, device) in draft.devices.iter_mut().enumerate() {
                ui.horizontal(|ui| match device {
                    DeviceSetting::Midi { name, port, enabled, trigger_notes, timecode, frame_rate } => {
                        ui.checkbox(enabled, "").on_hover_text(t("Eingeschaltet: Ohne Haken wird an dieses Gerät nichts gesendet. Auch im Menü „Geräte“ umschaltbar.", "Switched on: without the tick nothing is sent to this device. Can also be switched in the Devices menu."));
                        ui.label(RichText::new("MIDI").color(BLUE));
                        let was = name.clone();
                        field(ui, name, "Name", 120.0);
                        if has_show {
                            colour_choice(ui, ("device-colour", i), colours, &was, name);
                        }
                        port_picker(ui, ("midi-port", i), port, &self.midi_outputs);
                        ui.checkbox(trigger_notes, t("Trigger-Noten", "Trigger notes"));
                        ui.checkbox(timecode, "Timecode (MTC)");
                        if *timecode {
                            rate_choice(ui, ("midi-rate", i), frame_rate);
                        }
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Artnet { name, host, port, enabled, frame_rate } => {
                        ui.checkbox(enabled, "").on_hover_text(t("Eingeschaltet: Ohne Haken wird an dieses Gerät nichts gesendet. Auch im Menü „Geräte“ umschaltbar.", "Switched on: without the tick nothing is sent to this device. Can also be switched in the Devices menu."));
                        ui.label(RichText::new("Art-Net").color(Color32::from_rgb(0xc6, 0x78, 0xdd)));
                        field(ui, name, "Name", 120.0);
                        field(ui, host, "2.255.255.255", 130.0);
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.label(RichText::new("Timecode").color(MUTED));
                        rate_choice(ui, ("artnet-rate", i), frame_rate);
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Osc { name, host, port, enabled, trigger_notes } => {
                        ui.checkbox(enabled, "").on_hover_text(t("Eingeschaltet: Ohne Haken wird an dieses Gerät nichts gesendet. Auch im Menü „Geräte“ umschaltbar.", "Switched on: without the tick nothing is sent to this device. Can also be switched in the Devices menu."));
                        ui.label(RichText::new("OSC").color(GREEN));
                        let was = name.clone();
                        field(ui, name, "Name", 120.0);
                        if has_show {
                            colour_choice(ui, ("device-colour", i), colours, &was, name);
                        }
                        field(ui, host, "Host", 130.0);
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.checkbox(trigger_notes, t("Trigger-Noten", "Trigger notes"));
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Http { name, url, enabled } => {
                        ui.checkbox(enabled, "").on_hover_text(t("Eingeschaltet: Ohne Haken wird an dieses Gerät nichts gesendet. Auch im Menü „Geräte“ umschaltbar.", "Switched on: without the tick nothing is sent to this device. Can also be switched in the Devices menu."));
                        ui.label(RichText::new("HTTP").color(YELLOW));
                        let was = name.clone();
                        field(ui, name, "Name", 120.0);
                        if has_show {
                            colour_choice(ui, ("device-colour", i), colours, &was, name);
                        }
                        field(ui, url, "http://192.168.1.50:8080", 260.0);
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    }
                    DeviceSetting::Display { name, style, scroll_seconds, language, repeat } => {
                        ui.label(RichText::new("Display").color(RED));
                        let was = name.clone();
                        field(ui, name, "Name", 120.0);
                        if has_show {
                            colour_choice(ui, ("device-colour", i), colours, &was, name);
                        }
                        egui::ComboBox::from_id_salt(("display-style", i)).selected_text(if style.is_empty() { "dark" } else { style.as_str() }).width(130.0).show_ui(ui, |ui| {
                            for choice in ["dark", "light", "subtitle"].into_iter().chain(css_files.iter().map(String::as_str)) {
                                ui.selectable_value(style, choice.to_string(), choice);
                            }
                        });
                        ui.label(t("Blättern (s)", "Scroll (s)"));
                        ui.add(egui::DragValue::new(scroll_seconds).range(0..=600));
                        field(ui, language, t("Sprache (de, en …)", "Language (de, en …)"), 60.0);
                        ui.checkbox(repeat, t("Durchsage wiederholen", "Repeat announcement"));
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    }
                });
            }
            if let Some(i) = remove {
                draft.devices.remove(i);
            }
            ui.horizontal(|ui| {
                if ui.button("+ MIDI").clicked() {
                    draft.devices.push(DeviceSetting::Midi { name: String::new(), port: String::new(), enabled: true, trigger_notes: false, timecode: false, frame_rate: None });
                }
                if ui.button("+ OSC").clicked() {
                    draft.devices.push(DeviceSetting::Osc { name: String::new(), host: "127.0.0.1".into(), port: 8000, enabled: true, trigger_notes: false });
                }
                if ui.button("+ HTTP").clicked() {
                    draft.devices.push(DeviceSetting::Http { name: String::new(), url: String::new(), enabled: true });
                }
                if ui.button("+ Display").clicked() {
                    draft.devices.push(DeviceSetting::Display { name: String::new(), style: "dark".into(), scroll_seconds: 0, language: String::new(), repeat: false });
                }
                if ui.button("+ Art-Net").on_hover_text(t("Art-Net-Timecode an ein Gerät oder eine Broadcast-Adresse", "Art-Net timecode to a device or a broadcast address")).clicked() {
                    draft.devices.push(DeviceSetting::Artnet { name: "Art-Net".into(), host: "2.255.255.255".into(), port: mdstage_engine::settings::artnet_port(), enabled: true, frame_rate: None });
                }
            });
            ui.label(RichText::new(t("Timecode geht an MIDI-Geräte mit Haken bei „Timecode“ (als MTC) und an Art-Net-Geräte – mit der Framerate der Show oder einer eigenen.", "Timecode goes to MIDI devices with “Timecode” ticked (as MTC) and to Art-Net devices – at the show's frame rate or one of their own.")).color(MUTED));
            // The show's frame rate: kept on this computer, by show file.
            if let Some(file) = &self.show_file {
                ui.horizontal(|ui| {
                    ui.label(t("Framerate dieser Show", "This show's frame rate"));
                    let mut rate = draft.frame_rates.get(file).copied().unwrap_or_default();
                    egui::ComboBox::from_id_salt("show-rate").selected_text(rate.label()).width(130.0).show_ui(ui, |ui| {
                        for choice in FrameRate::ALL {
                            ui.selectable_value(&mut rate, choice, choice.label());
                        }
                    });
                    match rate == FrameRate::default() {
                        true => drop(draft.frame_rates.remove(file)),
                        false => drop(draft.frame_rates.insert(file.clone(), rate)),
                    }
                });
                ui.label(RichText::new(t("Gilt für die Start-Timecodes im Skript (start_tc), die Anzeige und alle Geräte auf „wie die Show“. Sie wird auf diesem Rechner gespeichert, nicht in der Show-Datei.", "Applies to the start timecodes in the script (start_tc), the display and every device set to “as the show”. It is kept on this computer, not in the show file.")).color(MUTED));
            }

            ui.add_space(12.0);
            ui.heading("Display-Server");
            ui.horizontal(|ui| {
                ui.label(t("Schnittstelle", "Interface"));
                field(ui, &mut draft.display_host, "127.0.0.1", 130.0);
                ui.label("Port");
                ui.add(egui::DragValue::new(&mut draft.display_port).range(1..=65535));
            });
            ui.label(RichText::new(t("127.0.0.1 = nur dieser Rechner; 0.0.0.0 = im ganzen Netzwerk erreichbar. Gilt ab dem nächsten Öffnen der Show.", "127.0.0.1 = this machine only; 0.0.0.0 = reachable from the whole network. Takes effect the next time the show is opened.")).color(MUTED));
            // Where each display is to be opened in a browser.
            let host = match draft.display_host.as_str() {
                "0.0.0.0" | "" => lan_address.clone().unwrap_or_else(|| "127.0.0.1".into()),
                host => host.to_string(),
            };
            for device in &draft.devices {
                if let DeviceSetting::Display { name, .. } = device {
                    let url = format!("http://{host}:{}/{}", draft.display_port, mdstage_engine::display::slugify(name));
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(name).color(MUTED));
                        ui.add(egui::Label::new(RichText::new(&url).monospace().color(BRIGHT)).selectable(true));
                    });
                }
            }

            ui.add_space(12.0);
            ui.heading(t("Mischpult-Fernsteuerung (Mikrofone)", "Mixer remote control (microphones)"));
            let mut remove = None;
            for (i, mixer) in draft.mixers.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(format!("{} {}", t("Pult", "Mixer"), i + 1));
                    // Changing the method keeps the port, where both have one.
                    let kind = match mixer {
                        MixerSetting::X32 { .. } => 0,
                        MixerSetting::MidiNote { .. } => 1,
                        MixerSetting::MidiCc { .. } => 2,
                        MixerSetting::MidiProgram { .. } => 3,
                        MixerSetting::MidiSysex { .. } => 4,
                        MixerSetting::Osc { .. } => 5,
                    };
                    let names = ["X32 MIDI", t("MIDI-Note", "MIDI note"), t("MIDI-CC", "MIDI CC"), t("MIDI-Programm", "MIDI program"), t("MIDI-SysEx", "MIDI SysEx"), "OSC"];
                    let mut chosen = kind;
                    egui::ComboBox::from_id_salt(("mixer-method", i)).selected_text(names[kind]).show_ui(ui, |ui| {
                        for (n, name) in names.iter().enumerate() {
                            ui.selectable_value(&mut chosen, n, *name);
                        }
                    });
                    if chosen != kind {
                        let port = match mixer {
                            MixerSetting::X32 { port } | MixerSetting::MidiNote { port, .. } | MixerSetting::MidiCc { port, .. } => port.clone(),
                            MixerSetting::MidiProgram { port, .. } | MixerSetting::MidiSysex { port, .. } => port.clone(),
                            MixerSetting::Osc { .. } => String::new(),
                        };
                        let ch = || "{ch}".to_string();
                        *mixer = match chosen {
                            0 => MixerSetting::X32 { port },
                            1 => MixerSetting::MidiNote { port, channel: "1".into(), note: ch(), on_velocity: 127, off_velocity: 0 },
                            2 => MixerSetting::MidiCc { port, channel: "1".into(), controller: ch(), on_value: 127, off_value: 0 },
                            3 => MixerSetting::MidiProgram { port, channel: "1".into(), on_program: 0, off_program: 1 },
                            4 => MixerSetting::MidiSysex { port, unmute: String::new(), mute: String::new() },
                            _ => MixerSetting::Osc {
                                host: "192.168.1.1".into(),
                                port: 10023,
                                on_path: "/ch/{ch}/mix/on".into(),
                                on_arg: ArgSetting { kind: "int".into(), value: "1".into() },
                                off_path: "/ch/{ch}/mix/on".into(),
                                off_arg: ArgSetting { kind: "int".into(), value: "0".into() },
                            },
                        };
                    }
                    if ui.small_button("×").clicked() {
                        remove = Some(i);
                    }
                });
                let byte = |ui: &mut Ui, label: &str, value: &mut u8| {
                    ui.label(label);
                    ui.add(egui::DragValue::new(value).range(0..=127));
                };
                ui.horizontal_wrapped(|ui| {
                    ui.add_space(16.0);
                    match mixer {
                        MixerSetting::X32 { port } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(RichText::new(t("CC auf Kanal 2, Controller = Mic-Kanal − 1", "CC on channel 2, controller = mic channel − 1")).color(MUTED));
                        }
                        MixerSetting::MidiNote { port, channel, note, on_velocity, off_velocity } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "1", 44.0);
                            ui.label("Note");
                            field(ui, note, "{ch}", 54.0);
                            byte(ui, t("an", "on"), on_velocity);
                            byte(ui, t("aus", "off"), off_velocity);
                        }
                        MixerSetting::MidiCc { port, channel, controller, on_value, off_value } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "1", 44.0);
                            ui.label("Controller");
                            field(ui, controller, "{ch}", 54.0);
                            byte(ui, t("an", "on"), on_value);
                            byte(ui, t("aus", "off"), off_value);
                        }
                        MixerSetting::MidiProgram { port, channel, on_program, off_program } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("Kanal", "Channel"));
                            field(ui, channel, "{ch}", 54.0);
                            byte(ui, t("Programm an", "Program on"), on_program);
                            byte(ui, t("aus", "off"), off_program);
                        }
                        MixerSetting::MidiSysex { port, unmute, mute } => {
                            port_picker(ui, ("mixer-port", i), port, &self.midi_outputs);
                            ui.label(t("an", "on"));
                            field(ui, unmute, "F0 … {ch} {val} F7", 190.0);
                            ui.label(t("aus", "off"));
                            field(ui, mute, "F0 … {ch} {val} F7", 190.0);
                        }
                        MixerSetting::Osc { host, port, on_path, on_arg, off_path, off_arg } => {
                            field(ui, host, "Host", 120.0);
                            ui.add(egui::DragValue::new(port).range(1..=65535));
                            for (label, path, arg, id) in [(t("an", "on"), on_path, on_arg, "on"), (t("aus", "off"), off_path, off_arg, "off")] {
                                ui.label(label);
                                field(ui, path, "/ch/{ch}/mix/on", 150.0);
                                arg_fields(ui, ("mixer-arg", i, id), arg);
                            }
                        }
                    }
                });
                if !matches!(mixer, MixerSetting::X32 { .. }) {
                    ui.label(RichText::new(t("    {ch} = Mic-Kanal der Rolle (MIDI: ab 0, OSC: ab 1, zweistellig)", "    {ch} = the role's mic channel (MIDI: from 0, OSC: from 1, two digits)")).color(MUTED));
                }
            }
            if let Some(i) = remove {
                draft.mixers.remove(i);
            }
            if ui.button(t("+ Pult", "+ Mixer")).clicked() {
                draft.mixers.push(MixerSetting::X32 { port: String::new() });
            }

            ui.add_space(12.0);
            ui.heading(t("Notlicht", "Emergency light"));
            let mut enabled = draft.emergency_light.is_some();
            if ui.checkbox(&mut enabled, t("Notlicht-Taste in der Werkzeugleiste", "Emergency light button in the toolbar")).changed() {
                draft.emergency_light = enabled.then(EmergencyLightSetting::default);
            }
            let targets: Vec<(String, bool)> = draft
                .devices
                .iter()
                .filter_map(|d| match d {
                    DeviceSetting::Midi { name, .. } => Some((name.clone(), false)),
                    DeviceSetting::Osc { name, .. } => Some((name.clone(), true)),
                    _ => None,
                })
                .collect();
            if let Some(light) = &mut draft.emergency_light {
                ui.horizontal(|ui| {
                    ui.label(t("Gerät", "Device"));
                    egui::ComboBox::from_id_salt("light-device").selected_text(if light.device.is_empty() { "—" } else { light.device.as_str() }).width(200.0).show_ui(ui, |ui| {
                        for (name, _) in &targets {
                            ui.selectable_value(&mut light.device, name.clone(), name);
                        }
                    });
                });
                let is_osc = targets.iter().any(|(name, osc)| *name == light.device && *osc);
                let hint = if is_osc { t("/pfad", "/path") } else { "90 3C 7F" };
                ui.horizontal(|ui| {
                    ui.label(t("an", "on"));
                    field(ui, &mut light.on, hint, 200.0);
                    if is_osc {
                        arg_fields(ui, "light-on-arg", &mut light.on_arg);
                    }
                });
                ui.horizontal(|ui| {
                    ui.label(t("aus", "off"));
                    field(ui, &mut light.off, hint, 200.0);
                    if is_osc {
                        arg_fields(ui, "light-off-arg", &mut light.off_arg);
                    }
                });
                if !is_osc {
                    ui.label(RichText::new(t("MIDI als Hex-Bytes, z. B. Note an Kanal 1: 90 3C 7F, Note aus: 80 3C 00", "MIDI as hex bytes, e.g. note on, channel 1: 90 3C 7F, note off: 80 3C 00")).color(MUTED));
                }
            }

            ui.add_space(12.0);
            ui.heading(t("Fernsteuerung", "Remote control"));
            if let Some((target, baseline)) = self.learning {
                // The first note that differs from what was last heard is the one to learn.
                if let Some(note) = heard.filter(|n| Some(*n) != baseline) {
                    let learned = Some(NoteSetting { ch: note.ch, note: note.note });
                    match target {
                        Learning::Go => draft.go_note = learned,
                        Learning::Back => draft.back_note = learned,
                        Learning::Up => draft.up_note = learned,
                        Learning::Down => draft.down_note = learned,
                    }
                    self.learning = None;
                }
            }
            for (label, target) in [(t("Go-Note", "Go note"), Learning::Go), (t("Back-Note", "Back note"), Learning::Back), (t("▲-Note (Cue davor vormerken)", "▲ note (arm the cue before)"), Learning::Up), (t("▼-Note (Cue danach vormerken)", "▼ note (arm the cue after)"), Learning::Down)] {
                ui.horizontal(|ui| {
                    ui.label(label);
                    note_fields(ui, match target {
                        Learning::Go => &mut draft.go_note,
                        Learning::Back => &mut draft.back_note,
                        Learning::Up => &mut draft.up_note,
                        Learning::Down => &mut draft.down_note,
                    });
                    let waiting = self.learning.is_some_and(|(t, _)| t == target);
                    if ui.selectable_label(waiting, if waiting { t("Note spielen …", "Play a note …") } else { t("Lernen", "Learn") }).clicked() {
                        self.learning = if waiting { None } else { Some((target, heard)) };
                    }
                });
            }
            ui.label(RichText::new(t("„Lernen“ braucht eine geöffnete Show.", "“Learn” needs an open show.")).color(MUTED));
            ui.horizontal(|ui| {
                ui.label(t("MIDI-Eingang für Go/Back/▲/▼", "MIDI input for Go/Back/▲/▼"));
                let current = draft.control_port.clone().unwrap_or_else(|| t("alle", "all").into());
                egui::ComboBox::from_id_salt("control-port").selected_text(current).width(220.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut draft.control_port, None, t("alle", "all"));
                    for name in &self.midi_inputs {
                        ui.selectable_value(&mut draft.control_port, Some(name.clone()), name);
                    }
                });
            });
            // Go, Back, ▲ and ▼ by OSC, for hardware that sends OSC.
            let control = &mut draft.osc_control;
            ui.horizontal(|ui| {
                ui.checkbox(&mut control.enabled, t("Go/Back/▲/▼ per OSC", "Go/Back/▲/▼ by OSC"));
                if control.enabled {
                    ui.label(t("UDP-Port", "UDP port"));
                    ui.add(egui::DragValue::new(&mut control.port).range(1..=65535));
                    ui.checkbox(&mut control.network, t("aus dem Netzwerk annehmen", "accept from the network"));
                }
            });
            if control.enabled {
                ui.horizontal(|ui| {
                    for (label, path) in [("Go", &mut control.go), ("Back", &mut control.back), ("▲", &mut control.up), ("▼", &mut control.down)] {
                        ui.label(label);
                        field(ui, path, "/…", 130.0);
                    }
                });
                ui.label(RichText::new(t("Eine Nachricht an die Adresse löst aus; mit 0 als erstem Argument (Taste losgelassen) nichts. Back wirkt sofort. Derselbe Port wie für Trigger-Noten per OSC geht auch. Ein leeres Feld wird nicht angenommen.", "A message to the address acts; with 0 as its first argument (button let go of) nothing does. Back acts at once. The same port as for trigger notes by OSC works too. An empty field is not listened for.")).color(MUTED));
            }
            ui.horizontal(|ui| {
                ui.label(t("Cues per Trigger-Note auslösen", "Fire cues by trigger note"));
                let kind = match draft.cue_trigger {
                    CueTriggerSetting::Off => 0,
                    CueTriggerSetting::Midi { .. } => 1,
                    CueTriggerSetting::Osc { .. } => 2,
                };
                if ui.selectable_label(kind == 0, t("aus", "off")).clicked() {
                    draft.cue_trigger = CueTriggerSetting::Off;
                }
                if ui.selectable_label(kind == 1, "MIDI").clicked() && kind != 1 {
                    draft.cue_trigger = CueTriggerSetting::Midi { port: String::new() };
                }
                if ui.selectable_label(kind == 2, "OSC").clicked() && kind != 2 {
                    draft.cue_trigger = CueTriggerSetting::Osc { port: 8001, network: false };
                }
            });
            match &mut draft.cue_trigger {
                CueTriggerSetting::Off => {}
                CueTriggerSetting::Midi { port } => {
                    ui.horizontal(|ui| {
                        ui.label(t("Eingang", "Input"));
                        port_picker(ui, "cue-trigger-port", port, &self.midi_inputs);
                    });
                }
                CueTriggerSetting::Osc { port, network } => {
                    ui.horizontal(|ui| {
                        ui.label(t("UDP-Port", "UDP port"));
                        ui.add(egui::DragValue::new(port).range(1..=65535));
                        ui.checkbox(network, t("aus dem Netzwerk annehmen", "accept from the network"));
                        ui.label(RichText::new(t("Pfad: /cue/<Kanal>/<Note>", "Path: /cue/<channel>/<note>")).color(MUTED));
                    });
                }
            }
        });

        self.test_output = test_output;
        // The list of Vim keys, in a window of its own.
        egui::Window::new(t("Vim-Tasten", "Vim keys")).open(&mut vim_help).default_size([560.0, 620.0]).show(ui.ctx(), |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                for (section, keys) in crate::vim::reference() {
                    ui.add_space(6.0);
                    ui.label(RichText::new(section).strong().color(BRIGHT));
                    egui::Grid::new(section).num_columns(2).spacing([18.0, 4.0]).show(ui, |ui| {
                        for (key, does) in keys {
                            ui.label(RichText::new(key).monospace().color(YELLOW));
                            ui.label(does);
                            ui.end_row();
                        }
                    });
                }
            });
        });
        self.vim_help = vim_help;
        ui.separator();
        ui.horizontal(|ui| {
            if ui.add_enabled(problem.is_none(), egui::Button::new(t("Speichern", "Save"))).clicked() {
                result = Some(true);
            }
            if ui.button(t("Abbrechen", "Cancel")).clicked() {
                result = Some(false);
            }
        });
        result
    }
}
