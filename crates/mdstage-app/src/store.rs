//! Files: where the settings live, and opening and saving show files.

use crate::lang::t;
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
        notes.push(format!("{} {})", t("Skript formatiert (Sicherung:", "Script formatted (backup:"), backup.file_name().unwrap_or_default().to_string_lossy()));
    }
    let mut script = Script::parse(&text);
    if script.assign_trigger_notes() {
        notes.push(t("Trigger-Noten vergeben", "Trigger notes assigned").into());
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

/// The folder inside `audio/` that unused files are moved to. Fixed, so the same files
/// are recognised again the next time.
pub const UNUSED_AUDIO_DIR: &str = "_unused";

/// Whether a file name ends like an audio file MDstage can play.
pub fn is_audio_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["mp3", "wav", "aiff", "aif", "flac", "ogg", "aac", "m4a"].iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// The audio files directly in a show's `audio/` folder, sorted.
pub fn audio_files(audio_dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = std::fs::read_dir(audio_dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_type().ok()?.is_file().then(|| entry.file_name().into_string().ok())?
        })
        .filter(|name| is_audio_name(name))
        .collect();
    files.sort();
    files
}

/// The audio files in the folder that none of the `used` names refers to. Upper and
/// lower case are not told apart, as most file systems do not either.
pub fn unused_audio(audio_dir: &Path, used: &[String]) -> Vec<String> {
    let used: Vec<String> = used.iter().map(|name| name.to_lowercase()).collect();
    audio_files(audio_dir).into_iter().filter(|name| !used.contains(&name.to_lowercase())).collect()
}

/// Move files out of `audio/` into `audio/_unused/`. Nothing is deleted or overwritten:
/// a name taken there already gets a number. Returns what was moved and what could not be.
pub fn move_unused_audio(audio_dir: &Path, names: &[String]) -> (Vec<String>, Vec<String>) {
    let target = audio_dir.join(UNUSED_AUDIO_DIR);
    if std::fs::create_dir_all(&target).is_err() {
        return (Vec::new(), names.to_vec());
    }
    let (mut moved, mut failed) = (Vec::new(), Vec::new());
    for name in names {
        // Plain file names only: never a path, never anything outside audio/.
        let plain = !name.is_empty() && !name.contains(['/', '\\']) && is_audio_name(name);
        let source = audio_dir.join(name);
        if !plain || !source.is_file() {
            failed.push(name.clone());
            continue;
        }
        let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
        let mut destination = target.join(name);
        let mut number = 2;
        while destination.exists() {
            destination = target.join(format!("{stem} ({number}).{extension}"));
            number += 1;
        }
        match std::fs::rename(&source, &destination) {
            Ok(()) => moved.push(name.clone()),
            Err(_) => failed.push(name.clone()),
        }
    }
    (moved, failed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameError {
    /// Not a plain file name with an audio extension.
    Invalid,
    /// The folder already has a file of that name.
    Exists,
    /// The file to rename is not in the folder.
    Missing,
    Io,
}

impl RenameError {
    pub fn message(self) -> &'static str {
        match self {
            RenameError::Invalid => t(
                "Ungültiger Dateiname. Erlaubt ist ein Name ohne Pfadangabe mit einer Audio-Endung (z. B. .wav, .mp3).",
                "Invalid file name. Use a name without a path and with an audio extension (e.g. .wav, .mp3).",
            ),
            RenameError::Exists => t("Im audio-Ordner gibt es bereits eine Datei mit diesem Namen.", "A file with that name already exists in the audio folder."),
            RenameError::Missing => t("Die Datei wurde im audio-Ordner nicht gefunden.", "The file was not found in the audio folder."),
            RenameError::Io => t("Die Datei konnte nicht umbenannt werden.", "The file could not be renamed."),
        }
    }
}

/// Rename a file inside `audio/`. The references in the show file are the caller's job.
pub fn rename_audio_file(audio_dir: &Path, from: &str, to: &str) -> Result<(), RenameError> {
    let plain = |name: &str| !name.is_empty() && !name.contains(['/', '\\']);
    if !plain(from) || !plain(to) || from == to || to.starts_with('.') || to.contains([':', '*', '?', '"', '<', '>', '|']) || !is_audio_name(to) {
        return Err(RenameError::Invalid);
    }
    let (source, destination) = (audio_dir.join(from), audio_dir.join(to));
    if !source.is_file() {
        return Err(RenameError::Missing);
    }
    // Checked against the folder's listing, not by asking whether the target exists: on
    // a volume that tells case apart, intro.wav and Intro.wav can both be there, and a
    // rename would replace one without a word. Anything that differs from the new name
    // only by case counts as taken, except the file itself.
    let taken = std::fs::read_dir(audio_dir)
        .map_err(|_| RenameError::Io)?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .any(|entry| entry != from && entry.to_lowercase() == to.to_lowercase());
    if taken {
        return Err(RenameError::Exists);
    }
    if from.to_lowercase() == to.to_lowercase() {
        // Only the case changes. Where case is not told apart that looks like renaming a
        // file onto itself, so go by way of a third name.
        let between = audio_dir.join(format!(".mdstage-rename-{}", std::process::id()));
        std::fs::rename(&source, &between).map_err(|_| RenameError::Io)?;
        return std::fs::rename(&between, &destination).map_err(|_| {
            let _ = std::fs::rename(&between, &source);
            RenameError::Io
        });
    }
    std::fs::rename(&source, &destination).map_err(|_| RenameError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdstage-store-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for file in files {
            std::fs::write(dir.join(file), file).unwrap();
        }
        dir
    }

    #[test]
    fn unused_audio_is_found_and_parked() {
        let dir = folder("unused", &["a.wav", "B.MP3", "c.flac", "notes.txt"]);
        std::fs::create_dir_all(dir.join(UNUSED_AUDIO_DIR)).unwrap();
        std::fs::write(dir.join(UNUSED_AUDIO_DIR).join("c.flac"), "older").unwrap();

        let unused = unused_audio(&dir, &["A.wav".to_string(), "sub/x.wav".into()]);
        assert_eq!(unused, ["B.MP3", "c.flac"]);
        let (moved, failed) = move_unused_audio(&dir, &["B.MP3".to_string(), "c.flac".into(), "../evil.wav".into(), "gone.wav".into()]);
        assert_eq!(moved, ["B.MP3", "c.flac"]);
        assert_eq!(failed, ["../evil.wav", "gone.wav"]);
        assert_eq!(audio_files(&dir), ["a.wav"]);
        // Nothing was overwritten in the parking folder.
        assert_eq!(audio_files(&dir.join(UNUSED_AUDIO_DIR)), ["B.MP3", "c (2).flac", "c.flac"]);
        assert_eq!(std::fs::read_to_string(dir.join(UNUSED_AUDIO_DIR).join("c.flac")).unwrap(), "older");
        assert!(dir.join("notes.txt").exists());
    }

    #[test]
    fn audio_files_are_renamed_with_care() {
        let dir = folder("rename", &["intro.wav", "song.mp3"]);
        for bad in ["sub/x.wav", "intro.wav", ".hidden.wav", "x.txt", "a:b.wav", ""] {
            assert_eq!(rename_audio_file(&dir, "intro.wav", bad), Err(RenameError::Invalid), "{bad}");
        }
        assert_eq!(rename_audio_file(&dir, "nope.wav", "x.wav"), Err(RenameError::Missing));
        assert_eq!(rename_audio_file(&dir, "intro.wav", "SONG.mp3"), Err(RenameError::Exists));
        assert_eq!(std::fs::read_to_string(dir.join("song.mp3")).unwrap(), "song.mp3", "the other file is untouched");

        assert_eq!(rename_audio_file(&dir, "intro.wav", "Intro.wav"), Ok(()));
        assert_eq!(rename_audio_file(&dir, "Intro.wav", "opening.wav"), Ok(()));
        assert_eq!(audio_files(&dir), ["opening.wav", "song.mp3"]);
        assert_eq!(std::fs::read_to_string(dir.join("opening.wav")).unwrap(), "intro.wav");
    }
}
