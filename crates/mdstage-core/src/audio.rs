//! A cue's audio as written in the show file: one or more parts (the `music` block and
//! any `music_seq` entries), each made of one or more files patched to virtual channels.

use serde_yaml_ng::Value;

use crate::Cue;
use crate::cues::DEFAULT_VOLUME;

/// One audio file of a part.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioFile {
    /// Path below the show's `audio/` folder.
    pub file: String,
    /// Mix all channels of the file down to one.
    pub mono: bool,
    pub volume: f64,
    /// Virtual-channel names per source channel (several names = fan-out). `None` uses
    /// the default: channel *i* to the *i*-th virtual channel, mono to the first two.
    pub patch: Option<Vec<Vec<String>>>,
}

/// One stretch of audio with its own transport; times in seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub audios: Vec<AudioFile>,
    pub volume: f64,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub fadein: Option<f64>,
    pub fadeout: Option<f64>,
    /// Where a loop wraps or hands off; the rest up to `end` rings out as a tail.
    pub fading_point: Option<f64>,
    /// `music.crossfade`: the loop runs on without a gap. Its last seconds fade out
    /// while the next pass already fades in from the start, over this many seconds.
    pub crossfade: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CueAudio {
    /// The `music` block first, then the `music_seq` entries. Several parts form a
    /// multi-part loop that plays them in turn.
    pub parts: Vec<Part>,
    /// `music.loop: true`.
    pub looped: bool,
}

impl CueAudio {
    /// The crossfade of a loop that runs on without a gap, in seconds; `None` for any
    /// other audio. Only a loop of a single part crossfades.
    pub fn crossfade(&self) -> Option<f64> {
        self.parts.first().filter(|_| self.looped && self.parts.len() == 1).and_then(|part| part.crossfade)
    }
}

/// The crossfade a loop gets when it is made one that runs on without a gap, in seconds.
pub const DEFAULT_CROSSFADE: f64 = 2.0;

/// The longest crossfade a loop from `start` to `end` has room for: the fade out of one
/// pass has to be over before the next one begins.
pub fn longest_crossfade(start: f64, end: f64) -> f64 {
    ((end - start) / 2.0).max(0.0)
}

/// Keep a file name from the show file inside the audio folder: drop `..`, `.` and
/// empty path segments, and a Windows drive (`C:`) in front – joined to the audio folder,
/// a path with a drive would replace it. Sub-folders stay possible.
pub fn sanitize_path(name: &str) -> Option<String> {
    let drive = |s: &str| s.len() >= 2 && s.as_bytes()[0].is_ascii_alphabetic() && s.as_bytes()[1] == b':';
    let mut name = name.trim_start_matches(['/', '\\']);
    while drive(name) {
        name = name[2..].trim_start_matches(['/', '\\']);
    }
    let clean: Vec<&str> = name.split(['/', '\\']).filter(|s| !matches!(*s, "" | "." | "..")).collect();
    let path = clean.join("/").replace('\0', "");
    (!path.is_empty()).then_some(path)
}

fn whole_file(name: &str) -> Vec<AudioFile> {
    sanitize_path(name).map(|file| AudioFile { file, mono: false, volume: 1.0, patch: None }).into_iter().collect()
}

fn audios(value: &Value) -> Vec<AudioFile> {
    if let Some(Value::Sequence(list)) = value.get("audios").filter(|a| a.as_sequence().is_some_and(|l| !l.is_empty())) {
        return list
            .iter()
            .filter_map(|a| {
                let patch = a.get("patch").and_then(Value::as_sequence).map(|entries| {
                    entries
                        .iter()
                        .map(|entry| match entry {
                            Value::Sequence(names) => names.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                            single => single.as_str().map(str::to_string).into_iter().collect(),
                        })
                        .collect()
                });
                Some(AudioFile {
                    file: sanitize_path(a.get("file")?.as_str()?)?,
                    mono: a.get("mono").and_then(Value::as_bool) == Some(true),
                    volume: a.get("volume").and_then(Value::as_f64).unwrap_or(1.0),
                    patch,
                })
            })
            .collect();
    }
    value.get("file").and_then(Value::as_str).map(whole_file).unwrap_or_default()
}

fn part(value: &Value) -> Option<Part> {
    let audios = match value {
        Value::String(name) => whole_file(name),
        other => audios(other),
    };
    if audios.is_empty() {
        return None;
    }
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    Some(Part {
        audios,
        volume: number("volume").unwrap_or(DEFAULT_VOLUME),
        start: number("start"),
        end: number("end"),
        fadein: number("fadein"),
        fadeout: number("fadeout"),
        // 0 means "not set", as in files written by earlier versions.
        fading_point: number("fading_point").filter(|&p| p > 0.0),
        crossfade: number("crossfade").filter(|x| x.is_finite()).map(|x| x.max(0.0)),
    })
}

/// A named place in a cue's audio, set by hand on its waveform (`music.markers`).
#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    /// Seconds into the file.
    pub at: f64,
    pub name: String,
}

impl Cue {
    /// The markers on the cue's audio, in the order of their places.
    pub fn markers(&self) -> Vec<Marker> {
        let list = self.field("music").and_then(|music| music.get("markers")).and_then(Value::as_sequence);
        let mut markers: Vec<Marker> = list
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let at = entry.get("at").and_then(Value::as_f64).filter(|at| at.is_finite() && *at >= 0.0)?;
                Some(Marker { at, name: entry.get("name").and_then(Value::as_str).unwrap_or_default().to_string() })
            })
            .collect();
        markers.sort_by(|a, b| a.at.total_cmp(&b.at));
        markers
    }

    /// The cue's audio, or `None` if it has none that can be played.
    pub fn audio(&self) -> Option<CueAudio> {
        let music = self.field("music")?;
        let mut parts = vec![part(music)?];
        if let Some(Value::Sequence(slots)) = self.field("music_seq") {
            parts.extend(slots.iter().filter_map(part));
        }
        Some(CueAudio { parts, looped: music.get("loop").and_then(Value::as_bool) == Some(true) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Block, Script};

    fn audio(cue: &str) -> Option<CueAudio> {
        let script = Script::parse(&format!("```yaml\n{cue}\n```\n"));
        let Block::Cue(cue) = &script.blocks[0] else { panic!("expected a cue") };
        cue.audio()
    }

    #[test]
    fn reads_the_short_and_the_object_form() {
        let short = audio("music: drumroll.mp3").unwrap();
        assert_eq!(short.parts.len(), 1);
        assert!(!short.looped);
        assert_eq!(short.parts[0].audios, [AudioFile { file: "drumroll.mp3".into(), mono: false, volume: 1.0, patch: None }]);
        assert_eq!(short.parts[0].volume, DEFAULT_VOLUME);

        let full = audio("music:\n    file: sub/loop.wav\n    volume: 0.75\n    start: 2.5\n    end: 120\n    fadein: 1\n    fadeout: 2\n    fading_point: 96\n    loop: true").unwrap();
        assert!(full.looped);
        let part = &full.parts[0];
        assert_eq!(part.audios[0].file, "sub/loop.wav");
        assert_eq!((part.volume, part.start, part.end), (0.75, Some(2.5), Some(120.0)));
        assert_eq!((part.fadein, part.fadeout, part.fading_point), (Some(1.0), Some(2.0), Some(96.0)));
        assert_eq!(audio("music:\n    file: a.wav\n    fading_point: 0").unwrap().parts[0].fading_point, None);
        assert_eq!(full.crossfade(), None);
        assert_eq!(audio("music: {file: a.wav, loop: true, crossfade: 2.5}").unwrap().crossfade(), Some(2.5));
        // Only a loop crossfades, and only one of a single part.
        assert_eq!(audio("music: {file: a.wav, crossfade: 2.5}").unwrap().crossfade(), None);
        assert_eq!(audio("music: {file: a.wav, loop: true, crossfade: 2}\nmusic_seq:\n    - file: b.wav").unwrap().crossfade(), None);
        assert_eq!(longest_crossfade(2.0, 10.0), 4.0);
    }

    #[test]
    fn reads_several_audios_with_patches() {
        let cue = "music:\n    audios:\n        - file: band.wav\n          patch: [Saal L, Saal R, [Sub L, Sub R]]\n        - file: click.wav\n          mono: true\n          volume: 0.7\n          patch: [Click]\n        - {volume: 1}";
        let parts = audio(cue).unwrap().parts;
        assert_eq!(parts[0].audios.len(), 2, "an entry without a file is ignored");
        let names = |list: &[&[&str]]| Some(list.iter().map(|e| e.iter().map(|n| n.to_string()).collect()).collect::<Vec<Vec<String>>>());
        assert_eq!(parts[0].audios[0].patch, names(&[&["Saal L"], &["Saal R"], &["Sub L", "Sub R"]]));
        assert_eq!(parts[0].audios[1], AudioFile { file: "click.wav".into(), mono: true, volume: 0.7, patch: names(&[&["Click"]]) });
    }

    #[test]
    fn reads_multi_part_loops() {
        let cue = "music:\n    file: a.wav\n    fading_point: 32\nmusic_seq:\n    - file: b.wav\n      fading_point: 28\n      volume: 0.5\n    - audios:\n        - {file: c.wav, patch: [L]}\n    - {volume: 1}";
        let parts = audio(cue).unwrap().parts;
        assert_eq!(parts.len(), 3, "a slot without audio is ignored");
        assert_eq!((parts[1].audios[0].file.as_str(), parts[1].fading_point, parts[1].volume), ("b.wav", Some(28.0), 0.5));
        assert_eq!(parts[2].audios[0].file, "c.wav");
    }

    #[test]
    fn keeps_file_names_inside_the_audio_folder() {
        assert_eq!(sanitize_path("../../etc/passwd"), Some("etc/passwd".into()));
        assert_eq!(sanitize_path("sub\\..\\a.wav"), Some("sub/a.wav".into()));
        assert_eq!(sanitize_path("/abs/./a.wav"), Some("abs/a.wav".into()));
        assert_eq!(sanitize_path("../.."), None);
        assert_eq!(sanitize_path("C:\\Windows\\a.wav"), Some("Windows/a.wav".into()));
        assert_eq!(sanitize_path("\\c:d:a.wav"), Some("a.wav".into()));
        assert_eq!(sanitize_path("C:"), None);
        assert_eq!(sanitize_path("sub/c:a.wav"), Some("sub/c:a.wav".into()), "only in front is it a drive");
        assert_eq!(audio("music: ../.."), None);
        assert_eq!(audio("light: Day"), None);
    }

    #[test]
    fn reads_named_markers_in_the_order_of_their_places() {
        let script = crate::Script::parse("```yaml\nmusic:\n    file: a.wav\n    markers:\n        - {at: 30.5, name: Refrain}\n        - {at: 4}\n        - {name: nirgends}\n```\n");
        let crate::Block::Cue(cue) = &script.blocks[0] else { panic!("a cue") };
        assert_eq!(cue.markers(), [Marker { at: 4.0, name: String::new() }, Marker { at: 30.5, name: "Refrain".into() }]);
        // The key is known: nothing about it is reported or cleaned away.
        assert!(script.validate().problems.is_empty(), "{:?}", script.validate().problems);
        let none = crate::Script::parse("```yaml\nmusic: a.wav\n```\n");
        let crate::Block::Cue(cue) = &none.blocks[0] else { panic!("a cue") };
        assert!(cue.markers().is_empty());
    }
}
