//! Colours and the look of the app.

use eframe::egui::{self, Color32};

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
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BACKGROUND;
    visuals.window_fill = PANEL;
    visuals.extreme_bg_color = PANEL;
    visuals.override_text_color = Some(TEXT);
    visuals.selection.bg_fill = Color32::from_rgb(0x3e, 0x44, 0x51);
    ctx.set_visuals(visuals);
    ctx.style_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 5.0);
    });
}
