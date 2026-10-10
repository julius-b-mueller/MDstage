//! The language of the interface: German or English, as chosen in the settings.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(english: bool) {
    ENGLISH.store(english, Ordering::Relaxed);
}

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// The German or the English wording, whichever the interface is set to.
pub fn t(german: &'static str, english: &'static str) -> &'static str {
    if self::english() { english } else { german }
}
