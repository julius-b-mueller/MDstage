//! Colours and the look of the app.

use eframe::egui::{self, Color32, CornerRadius, RichText, Stroke};

pub const BACKGROUND: Color32 = Color32::from_rgb(0x28, 0x2c, 0x34);
pub const PANEL: Color32 = Color32::from_rgb(0x21, 0x25, 0x2b);
pub const RAISED: Color32 = Color32::from_rgb(0x2f, 0x34, 0x3e);
pub const TEXT: Color32 = Color32::from_rgb(0xab, 0xb2, 0xbf);
pub const BRIGHT: Color32 = Color32::from_rgb(0xe6, 0xe6, 0xe6);
pub const MUTED: Color32 = Color32::from_rgb(0x7f, 0x84, 0x8e);
pub const BLUE: Color32 = Color32::from_rgb(0x61, 0xaf, 0xef);
pub const GREEN: Color32 = Color32::from_rgb(0x98, 0xc3, 0x79);
pub const YELLOW: Color32 = Color32::from_rgb(0xe5, 0xc0, 0x7b);
pub const RED: Color32 = Color32::from_rgb(0xe0, 0x6c, 0x75);
pub const WAVE_DIM: Color32 = Color32::from_rgb(0x4b, 0x52, 0x63);
/// The bar across the top of the window.
pub const BAR: Color32 = Color32::from_rgb(0x38, 0x3c, 0x44);
/// The scene list.
pub const SIDEBAR: Color32 = Color32::from_rgb(0x1e, 0x21, 0x27);
pub const BORDER: Color32 = Color32::from_rgb(0x3e, 0x44, 0x51);
/// Readouts that look set into the bar (clock, timecode).
pub const INSET: Color32 = Color32::from_rgb(0x1b, 0x1e, 0x23);
pub const DARK_RED: Color32 = Color32::from_rgb(0xb0, 0x3c, 0x45);

/// Height of the buttons and readouts in the toolbar.
pub const TOOL: f32 = 44.0;

/// Colour of a role or group by its colour name in the show file; `#rrggbb` also works.
pub fn named(name: Option<&str>) -> Option<Color32> {
    let hex = match name? {
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
        other => u32::from_str_radix(other.strip_prefix('#').filter(|h| h.len() == 6)?, 16).ok()?,
    };
    Some(Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8))
}

pub fn apply(ctx: &egui::Context) {
    // MDstage is dark whatever the system is set to: it is used in dark rooms.
    ctx.set_theme(egui::Theme::Dark);
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BACKGROUND;
    visuals.window_fill = PANEL;
    visuals.window_stroke = Stroke::new(1.0_f32, Color32::BLACK);
    visuals.window_corner_radius = CornerRadius::same(8);
    visuals.menu_corner_radius = CornerRadius::same(6);
    visuals.extreme_bg_color = INSET;
    visuals.faint_bg_color = RAISED;
    visuals.override_text_color = Some(TEXT);
    visuals.hyperlink_color = BLUE;
    visuals.warn_fg_color = YELLOW;
    visuals.error_fg_color = RED;
    visuals.selection.bg_fill = BORDER;
    visuals.selection.stroke = Stroke::new(1.0_f32, BLUE);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    let corner = CornerRadius::same(5);
    for (widget, fill, stroke) in [
        (&mut visuals.widgets.inactive, RAISED, Color32::BLACK),
        (&mut visuals.widgets.hovered, BAR, Color32::BLACK),
        (&mut visuals.widgets.active, BACKGROUND, Color32::BLACK),
        (&mut visuals.widgets.open, BAR, BORDER),
    ] {
        widget.bg_fill = fill;
        widget.weak_bg_fill = fill;
        widget.bg_stroke = Stroke::new(1.0_f32, stroke);
        widget.corner_radius = corner;
        widget.expansion = 0.0;
    }
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, BRIGHT);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, BRIGHT);
    ctx.set_visuals_of(egui::Theme::Dark, visuals.clone());
    // Should anything ever ask for the light theme, it gets the same look.
    ctx.set_visuals_of(egui::Theme::Light, visuals);
    // The text face has no arrows and few symbols; the fixed-width one fills in.
    let mut fonts = egui::FontDefinitions::default();
    let fixed = fonts.families.get(&egui::FontFamily::Monospace).and_then(|names| names.first()).cloned();
    if let (Some(fixed), Some(text)) = (fixed, fonts.families.get_mut(&egui::FontFamily::Proportional)) {
        if !text.contains(&fixed) {
            text.push(fixed);
        }
    }
    ctx.set_fonts(fonts);
    ctx.all_styles_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 5.0);
        style.spacing.menu_margin = egui::Margin::same(6);
        style.spacing.window_margin = egui::Margin::same(12);
    });
}

/// A square-cornered toolbar button, as tall as the bar's readouts.
pub fn tool_button<'a>(text: impl Into<egui::WidgetText>) -> egui::Button<'a> {
    egui::Button::new(text).fill(BACKGROUND).stroke(Stroke::new(1.0_f32, Color32::BLACK)).corner_radius(CornerRadius::same(5)).min_size(egui::vec2(TOOL, TOOL))
}

/// The same button, lit: a switch that is on.
pub fn tool_toggle<'a>(text: &str, on: bool) -> egui::Button<'a> {
    match on {
        true => tool_button(RichText::new(text).size(15.0).strong().color(YELLOW)).fill(Color32::from_rgb(0x45, 0x40, 0x33)).stroke(Stroke::new(1.0_f32, YELLOW)),
        false => tool_button(RichText::new(text).size(15.0).strong()),
    }
}

/// One of the round red emergency buttons. `on` shows it held down (a latched one).
pub fn emergency_button<'a>(text: &str, on: bool) -> egui::Button<'a> {
    let label = RichText::new(text).size(14.0).strong().color(Color32::BLACK);
    egui::Button::new(label)
        .fill(if on { BRIGHT } else { RED })
        .stroke(Stroke::new(2.0_f32, if on { RED } else { DARK_RED }))
        .corner_radius(CornerRadius::same((TOOL / 2.0) as u8))
        .min_size(egui::vec2(TOOL + 20.0, TOOL))
}

/// A readout set into the bar: dark, with a fine edge, text in a fixed-width face.
pub fn readout(ui: &mut egui::Ui, text: &str, size: f32, colour: Color32) -> egui::Response {
    let frame = egui::Frame::new().fill(INSET).stroke(Stroke::new(1.0_f32, Color32::BLACK)).corner_radius(CornerRadius::same(5)).inner_margin(egui::Margin::symmetric(10, 0));
    frame
        .show(ui, |ui| {
            ui.set_height(TOOL - 2.0);
            ui.label(RichText::new(text).monospace().size(size).color(colour))
        })
        .response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_symbols_on_buttons_exist_in_the_fonts() {
        let ctx = egui::Context::default();
        apply(&ctx);
        let _ = ctx.run(Default::default(), |ctx| {
            let missing: Vec<&str> = ["☰", "🔒", "«", "›", "→", "↩", "←", "♬", "●", "▶", "♪", "⏱", "·", "—", "…", "×", "„", "“", "−"]
                .into_iter()
                .filter(|symbol| !ctx.fonts(|f| f.has_glyphs(&egui::FontId::proportional(14.0), symbol)))
                .collect();
            assert!(missing.is_empty(), "no glyphs for {missing:?}");
            assert!(ctx.style().visuals.dark_mode);
            assert_eq!(ctx.style().visuals.panel_fill, BACKGROUND);
        });
    }
}
