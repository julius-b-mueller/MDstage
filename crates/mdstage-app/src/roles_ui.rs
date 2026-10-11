//! The role editor: roles with colour, microphone channel and mixer, and role groups.

use eframe::egui::{self, RichText, Ui};
use mdstage_core::mic::{Cast, Group, Role};

use crate::lang::t;
use crate::theme::*;

/// The colour a new role or group gets: the one used least so far, the first of those in
/// the order of the list. So new roles go through the colours one after the other.
fn next_colour<'a>(used: impl Iterator<Item = &'a str>) -> String {
    let used: Vec<&str> = used.collect();
    let count = |colour: &str| used.iter().filter(|u| **u == colour).count();
    COLOURS.iter().min_by_key(|colour| count(colour)).unwrap_or(&COLOURS[0]).to_string()
}

const COLOURS: [&str; 12] =
    ["red", "green", "yellow", "blue", "purple", "cyan", "darkred", "darkgreen", "darkyellow", "darkblue", "darkpurple", "darkcyan"];

pub struct RolesUi {
    /// Each role with the name it had when the editor opened (`None` for new roles).
    roles: Vec<(Option<String>, Role)>,
    groups: Vec<Group>,
}

fn colour_picker(ui: &mut Ui, id: impl std::hash::Hash, colour: &mut Option<String>) {
    let shown = colour.clone().unwrap_or_else(|| "—".into());
    egui::ComboBox::from_id_salt(id).selected_text(RichText::new(shown).color(named(colour.as_deref()).unwrap_or(TEXT))).width(110.0).show_ui(ui, |ui| {
        ui.selectable_value(colour, None, "—");
        for name in COLOURS {
            ui.selectable_value(colour, Some(name.to_string()), RichText::new(name).color(named(Some(name)).unwrap_or(TEXT)));
        }
    });
}

impl RolesUi {
    pub fn new(cast: &Cast) -> RolesUi {
        RolesUi { roles: cast.roles.iter().map(|r| (Some(r.name.clone()), r.clone())).collect(), groups: cast.groups.clone() }
    }

    /// What to store: roles, groups, and `(old, new)` for every renamed role.
    pub fn result(&self) -> (Vec<Role>, Vec<Group>, Vec<(String, String)>) {
        let renames = self.roles.iter().filter_map(|(was, role)| was.clone().filter(|w| *w != role.name).map(|w| (w, role.name.clone()))).collect();
        (self.roles.iter().map(|(_, r)| r.clone()).collect(), self.groups.clone(), renames)
    }

    /// Why the current state cannot be saved, if it cannot.
    fn problem(&self) -> Option<String> {
        let mut seen: Vec<&str> = Vec::new();
        for name in self.roles.iter().map(|(_, r)| r.name.as_str()).chain(self.groups.iter().map(|g| g.name.as_str())) {
            if name.trim().is_empty() {
                return Some(t("Jede Rolle und Gruppe braucht einen Namen.", "Every role and group needs a name.").into());
            }
            if name.contains('/') || name.contains('*') {
                return Some(if crate::lang::english() { format!("“{name}”: names must not contain / or *.") } else { format!("„{name}“: Namen dürfen weder / noch * enthalten.") });
            }
            if seen.contains(&name) || name == "Alle" || (crate::lang::english() && name == "All") || name == "muteall" {
                return Some(if crate::lang::english() { format!("The name “{name}” is used twice or reserved.") } else { format!("Der Name „{name}“ ist doppelt oder reserviert.") });
            }
            seen.push(name);
        }
        None
    }

    /// Draw the editor. Returns `Some(true)` on Save, `Some(false)` on Cancel.
    pub fn show(&mut self, ui: &mut Ui, mixers: usize) -> Option<bool> {
        let mut result = None;
        egui::ScrollArea::vertical().auto_shrink([false, false]).max_height(ui.available_height() - 64.0).show(ui, |ui| {
            ui.heading(t("Rollen", "Roles"));
            let mut remove = None;
            let RolesUi { roles, groups } = self;
            egui::Grid::new("roles").num_columns(5).show(ui, |ui| {
                ui.label(RichText::new("Name").color(MUTED));
                ui.label(RichText::new(t("Farbe", "Colour")).color(MUTED));
                ui.label(RichText::new(t("Mic-Kanal", "Mic channel")).color(MUTED));
                ui.label(RichText::new(t("Pult", "Mixer")).color(MUTED));
                ui.end_row();
                for (i, (_, role)) in roles.iter_mut().enumerate() {
                    let before = role.name.clone();
                    if ui.add(egui::TextEdit::singleline(&mut role.name).desired_width(180.0)).changed() && !before.is_empty() {
                        // Group members follow the name while it is being typed.
                        for member in groups.iter_mut().flat_map(|g| g.roles.iter_mut()).filter(|m| **m == before) {
                            *member = role.name.clone();
                        }
                    }
                    colour_picker(ui, ("role-colour", i), &mut role.color);
                    let mut channel = role.channel.unwrap_or(0);
                    if ui.add(egui::DragValue::new(&mut channel).range(0..=128).custom_formatter(|n, _| if n == 0.0 { "—".into() } else { format!("{n}") })).changed() {
                        role.channel = (channel > 0).then_some(channel);
                    }
                    // Shown 1-based; only worth choosing with more than one mixer.
                    let mut mixer = role.mixer + 1;
                    if ui.add_enabled(mixers > 1 || role.mixer > 0, egui::DragValue::new(&mut mixer).range(1..=mixers.max(role.mixer + 1))).changed() {
                        role.mixer = mixer - 1;
                    }
                    if ui.small_button("×").clicked() {
                        remove = Some(i);
                    }
                    ui.end_row();
                }
            });
            if let Some(i) = remove {
                let (_, role) = self.roles.remove(i);
                for group in &mut self.groups {
                    group.roles.retain(|r| *r != role.name);
                }
            }
            if ui.button(t("+ Rolle", "+ Role")).clicked() {
                let colour = next_colour(self.roles.iter().filter_map(|(_, role)| role.color.as_deref()));
                self.roles.push((None, Role { name: String::new(), color: Some(colour), channel: None, mixer: 0 }));
            }

            ui.add_space(14.0);
            ui.heading(t("Gruppen", "Groups"));
            ui.label(RichText::new(t("Eine Gruppe kann wie eine Rolle sprechen und als Mikrofon gewählt werden. „Alle“ gibt es immer.", "A group can speak like a role and be chosen as a microphone. “All” always exists.")).color(MUTED));
            let mut remove = None;
            let names: Vec<String> = self.roles.iter().map(|(_, r)| r.name.clone()).filter(|n| !n.is_empty()).collect();
            for (i, group) in self.groups.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut group.name).desired_width(180.0));
                    colour_picker(ui, ("group-colour", i), &mut group.color);
                    if ui.small_button("×").clicked() {
                        remove = Some(i);
                    }
                });
                ui.horizontal_wrapped(|ui| {
                    ui.add_space(16.0);
                    for name in &names {
                        let mut member = group.roles.contains(name);
                        if ui.checkbox(&mut member, name).changed() {
                            if member {
                                group.roles.push(name.clone());
                            } else {
                                group.roles.retain(|r| r != name);
                            }
                        }
                    }
                });
            }
            if let Some(i) = remove {
                self.groups.remove(i);
            }
            if ui.button(t("+ Gruppe", "+ Group")).clicked() {
                let colour = next_colour(self.groups.iter().filter_map(|group| group.color.as_deref()));
                self.groups.push(Group { name: String::new(), color: Some(colour), roles: Vec::new() });
            }
        });

        ui.separator();
        let problem = self.problem();
        if let Some(problem) = &problem {
            ui.label(RichText::new(problem).color(RED));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_roles_go_through_the_colours() {
        assert_eq!(next_colour([].into_iter()), "red");
        assert_eq!(next_colour(["red", "green"].into_iter()), "yellow");
        assert_eq!(next_colour(["blue", "blue"].into_iter()), "red");
        // Once every colour is taken, the round begins again.
        let mut all: Vec<&str> = COLOURS.to_vec();
        assert_eq!(next_colour(all.iter().copied()), "red");
        all.push("red");
        assert_eq!(next_colour(all.iter().copied()), "green");
    }
}
