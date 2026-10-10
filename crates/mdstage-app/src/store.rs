//! Files: where the settings live, and opening and saving show files.

use std::path::{Path, PathBuf};

use mdstage_core::{Script, format};
use mdstage_engine::settings::Settings;
use sha2::{Digest, Sha256};

/// The folder for this machine's settings.
pub fn settings_dir() -> PathBuf {
    // For testing: keep the settings somewhere else.
    if let Some(dir) = std::env::var_os("MDSTAGE_SETTINGS_DIR") {
        return PathBuf::from(dir);
    }
    let home = || PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/MDstage")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("MDstage")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config")).join("MDstage")
    }
}

pub fn settings_path() -> PathBuf {
    settings_dir().join("settings.json")
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Keep a copy of a show file as it was before this version of MDstage first changed it
/// (`name~vor-mdstage2.md`). Made once; an existing copy is never overwritten.
fn backup_once(path: &Path) -> std::io::Result<()> {
    let backup = path.with_file_name(format!("{}~vor-mdstage2.md", path.file_stem().unwrap_or_default().to_string_lossy()));
    if !backup.exists() && path.exists() {
        std::fs::copy(path, backup)?;
    }
    Ok(())
}

/// A show file read from disk and brought up to standard.
pub struct Loaded {
    pub script: Script,
    /// Whether the file is as this machine last wrote it. A file changed elsewhere must
    /// be confirmed before it may send anything to devices.
    pub trusted: bool,
    /// What opening changed in the file, for the operator.
    pub notes: Vec<String>,
}

/// Read a show file. Formatting it to the standard and giving cues without one a
/// trigger note are done right away and written back (with a backup of the unformatted
/// file), as they always were.
pub fn load(path: &Path, settings: &mut Settings) -> std::io::Result<Loaded> {
    let original = std::fs::read_to_string(path)?;
    let key = path.to_string_lossy().into_owned();
    // Decided before anything is written, so tidying up cannot make a foreign file trusted.
    let trusted = settings.trusted.get(&key).is_some_and(|known| *known == hash(&original));

    let mut notes = Vec::new();
    let mut text = original.clone();
    if format::needs_formatting(&text) {
        let backup = path.with_file_name(format!("{}~unformatted.md", path.file_stem().unwrap_or_default().to_string_lossy()));
        std::fs::write(&backup, &original)?;
        text = format::format_script(&text);
        notes.push(format!("Skript formatiert (Sicherung: {})", backup.file_name().unwrap_or_default().to_string_lossy()));
    }
    let mut script = Script::parse(&text);
    if script.assign_trigger_notes() {
        notes.push("Trigger-Noten vergeben".into());
    }
    let written = script.to_markdown();
    if written != original {
        backup_once(path)?;
        std::fs::write(path, &written)?;
        if trusted {
            settings.trusted.insert(key, hash(&written));
        }
    }
    Ok(Loaded { script, trusted, notes })
}

/// Write the show file. `trusted` records it as written by this machine.
pub fn save(path: &Path, script: &Script, settings: &mut Settings, trusted: bool) -> std::io::Result<()> {
    let text = script.to_markdown();
    backup_once(path)?;
    std::fs::write(path, &text)?;
    if trusted {
        settings.trusted.insert(path.to_string_lossy().into_owned(), hash(&text));
    }
    Ok(())
}

/// Record the file as it is on disk as trusted (the operator allowed it).
pub fn trust(path: &Path, settings: &mut Settings) {
    if let Ok(text) = std::fs::read_to_string(path) {
        settings.trusted.insert(path.to_string_lossy().into_owned(), hash(&text));
    }
}

/// Create a new, empty show file titled after its file name.
pub fn create(path: &Path, settings: &mut Settings) -> std::io::Result<()> {
    let title = path.file_stem().unwrap_or_default().to_string_lossy();
    let text = format!("```yaml\nconfig:\n    app_version: {}\n    roles: {{}}\n```\n\n# {title}\n", env!("CARGO_PKG_VERSION"));
    std::fs::write(path, &text)?;
    settings.trusted.insert(path.to_string_lossy().into_owned(), hash(&text));
    Ok(())
}

/// Put a file at the top of the recent list (five entries).
pub fn remember(path: &Path, settings: &mut Settings) {
    let key = path.to_string_lossy().into_owned();
    settings.recent_files.retain(|f| *f != key);
    settings.recent_files.insert(0, key);
    settings.recent_files.truncate(5);
}

/// Today's date as `DD.MM.YYYY`, local time.
pub fn today() -> String {
    chrono::Local::now().format("%d.%m.%Y").to_string()
}

/// A point in time as local `HH:MM:SS`.
pub fn clock_time(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(time).format("%H:%M:%S").to_string()
}
