//! Changes to a script's YAML blocks: editing cues, assigning trigger notes and removing
//! keys that are not part of the show-file format.

use serde_yaml_ng::{Mapping, Value};

use crate::cues::Note;
use crate::mic::{Group, Role};
use crate::{Block, Config, Cue, Script, yaml};

impl Cue {
    /// Replace the cue's content. The block is rewritten in the standard layout.
    pub fn set_yaml(&mut self, value: Value) {
        self.source = yaml::dump(&value, true);
        self.yaml = value;
        self.invalid = false;
    }
}

impl Config {
    /// Replace the config block's content. The block is rewritten in the standard layout.
    pub fn set_yaml(&mut self, value: Value) {
        self.source = yaml::dump(&value, false);
        self.yaml = value;
    }
}

impl Script {
    /// Names of the show's virtual audio channels (`L` and `R` unless configured).
    pub fn virtual_channels(&self) -> Vec<String> {
        match self.config().and_then(|c| c.get("virtualChannels")) {
            Some(Value::Sequence(list)) => {
                list.iter().filter_map(|v| v.get("name")?.as_str()).map(str::to_string).collect()
            }
            _ => vec!["L".into(), "R".into()],
        }
    }

    /// A cue's trigger note changed: point everything that referred to the old note
    /// (`chain_end`, `loop_outro`, `auto_trigger`, `music.adjust`) at the new one.
    /// Returns how many references there were.
    pub fn renumber_note(&mut self, from: Note, to: Note) -> usize {
        fn is(value: &Value, note: Note) -> bool {
            value.get("ch").and_then(Value::as_u64) == Some(note.ch) && value.get("note").and_then(Value::as_u64) == Some(note.note)
        }
        let mut hits = 0;
        for block in &mut self.blocks {
            let Block::Cue(cue) = block else { continue };
            if cue.invalid {
                continue;
            }
            let mut yaml = cue.yaml.clone();
            let mut found = 0;
            let mut point = |reference: Option<&mut Value>| {
                if let Some(reference) = reference.filter(|r| is(r, from)) {
                    let mut map = serde_yaml_ng::Mapping::new();
                    map.insert("ch".into(), to.ch.into());
                    map.insert("note".into(), to.note.into());
                    *reference = Value::Mapping(map);
                    found += 1;
                }
            };
            point(yaml.get_mut("chain_end"));
            point(yaml.get_mut("loop_outro"));
            point(yaml.get_mut("auto_trigger").and_then(|a| a.get_mut("trigger_note")));
            point(yaml.get_mut("music").and_then(|m| m.get_mut("adjust")).and_then(|a| a.get_mut("trigger_note")));
            if found > 0 {
                cue.set_yaml(yaml);
                hits += found;
            }
        }
        hits
    }

    /// Declare the show's output devices in the config block: `(name, type, colour)`,
    /// the colour optional. Addresses are not part of the show file.
    pub fn set_output_devices(&mut self, devices: &[(String, String, Option<String>)]) {
        for block in &mut self.blocks {
            let Block::Config(config) = block else { continue };
            let mut yaml = config.yaml.clone();
            let Some(Value::Mapping(inner)) = yaml.get_mut("config") else { continue };
            let list: Vec<Value> = devices
                .iter()
                .map(|(name, kind, colour)| {
                    let mut device = serde_yaml_ng::Mapping::new();
                    device.insert("name".into(), name.as_str().into());
                    device.insert("type".into(), kind.as_str().into());
                    if let Some(colour) = colour {
                        device.insert("color".into(), colour.as_str().into());
                    }
                    Value::Mapping(device)
                })
                .collect();
            match list.is_empty() {
                true => drop(inner.shift_remove("outputDevices")),
                false => drop(inner.insert("outputDevices".into(), Value::Sequence(list))),
            }
            if yaml != config.yaml {
                config.set_yaml(yaml);
            }
        }
    }

    /// Set the names of the show's virtual audio channels. `renames` (`(old, new)`) are
    /// followed through the patches of every cue, so audio stays on its channel.
    pub fn set_virtual_channels(&mut self, names: &[String], renames: &[(String, String)]) {
        fn rename_in(entry: &mut Value, renames: &[(String, String)]) -> bool {
            let mut changed = false;
            let Some(Value::Sequence(audios)) = entry.get_mut("audios") else { return false };
            for patch in audios.iter_mut().filter_map(|a| a.get_mut("patch")).filter_map(Value::as_sequence_mut) {
                for target in patch.iter_mut() {
                    let names: Vec<&mut Value> = match target {
                        Value::Sequence(list) => list.iter_mut().collect(),
                        single => vec![single],
                    };
                    for name in names {
                        if let Some((_, to)) = renames.iter().find(|(from, _)| name.as_str() == Some(from)) {
                            *name = to.as_str().into();
                            changed = true;
                        }
                    }
                }
            }
            changed
        }
        for block in &mut self.blocks {
            match block {
                Block::Config(config) => {
                    let mut yaml = config.yaml.clone();
                    let Some(Value::Mapping(inner)) = yaml.get_mut("config") else { continue };
                    let list: Vec<Value> = names
                        .iter()
                        .map(|name| {
                            let mut channel = serde_yaml_ng::Mapping::new();
                            channel.insert("name".into(), name.as_str().into());
                            Value::Mapping(channel)
                        })
                        .collect();
                    inner.insert("virtualChannels".into(), Value::Sequence(list));
                    config.set_yaml(yaml);
                }
                Block::Cue(cue) if !cue.invalid && !renames.is_empty() => {
                    let mut yaml = cue.yaml.clone();
                    let mut changed = yaml.get_mut("music").is_some_and(|music| rename_in(music, renames));
                    if let Some(Value::Sequence(parts)) = yaml.get_mut("music_seq") {
                        for part in parts {
                            changed |= rename_in(part, renames);
                        }
                    }
                    if changed {
                        cue.set_yaml(yaml);
                    }
                }
                _ => {}
            }
        }
    }

    /// Give every cue without a `trigger_note` the lowest free one (channel 1 first,
    /// notes 1–127). Returns whether anything changed. Empty and unreadable cues are skipped.
    pub fn assign_trigger_notes(&mut self) -> bool {
        let mut used: Vec<Note> = self
            .blocks
            .iter()
            .filter_map(|b| match b {
                // Read loosely, as any `{ch, note}` pair blocks that note.
                Block::Cue(c) => c.note(),
                _ => None,
            })
            .collect();
        let mut free = (1..=16).flat_map(|ch| (1..=127).map(move |note| Note { ch, note }));
        let mut changed = false;
        for block in &mut self.blocks {
            let Block::Cue(cue) = block else { continue };
            if cue.invalid || cue.yaml.is_null() || cue.yaml.get("trigger_note").is_some_and(|v| !v.is_null()) {
                continue;
            }
            let Some(note) = free.by_ref().find(|n| !used.contains(n)) else { break };
            used.push(note);
            let mut reference = Mapping::new();
            reference.insert("ch".into(), note.ch.into());
            reference.insert("note".into(), note.note.into());
            let mut map = cue.yaml.as_mapping().cloned().unwrap_or_default();
            map.insert("trigger_note".into(), Value::Mapping(reference));
            cue.set_yaml(Value::Mapping(map));
            changed = true;
        }
        changed
    }
}

impl Script {
    /// Store the role editor's result: the new role and group lists, with `renames`
    /// (`old name → new name`) applied to role blocks, group members and cue `mic` lists.
    /// Settings of a role beyond colour and channel are kept.
    pub fn save_roles(&mut self, roles: &[Role], groups: &[Group], renames: &[(String, String)]) {
        let renamed = |name: &str| renames.iter().find(|(from, _)| from == name).map(|(_, to)| to.clone());
        fn old_name<'a>(renames: &'a [(String, String)], name: &'a str) -> &'a str {
            renames.iter().find(|(_, to)| to == name).map_or(name, |(from, _)| from.as_str())
        }

        for block in &mut self.blocks {
            match block {
                Block::Role { names, .. } => {
                    for name in names.iter_mut() {
                        if let Some(to) = renamed(name) {
                            *name = to;
                        }
                    }
                }
                Block::Cue(cue) if !cue.invalid => {
                    let mut yaml = cue.yaml.clone();
                    let changed = match yaml.get_mut("mic") {
                        Some(Value::String(name)) => renamed(name).map(|to| *name = to).is_some(),
                        Some(Value::Sequence(list)) => {
                            let mut any = false;
                            for entry in list.iter_mut() {
                                if let Some(to) = entry.as_str().and_then(&renamed) {
                                    *entry = Value::String(to);
                                    any = true;
                                }
                            }
                            any
                        }
                        _ => false,
                    };
                    if changed {
                        cue.set_yaml(yaml);
                    }
                }
                _ => {}
            }
        }

        let Some(Block::Config(config)) = self.blocks.iter_mut().find(|b| matches!(b, Block::Config(_))) else {
            return;
        };
        let mut yaml = config.yaml.clone();
        let Some(Value::Mapping(root)) = yaml.get_mut("config") else { return };
        let previous = root.get("roles").and_then(Value::as_mapping).cloned().unwrap_or_default();

        let mut role_map = Mapping::new();
        for role in roles {
            let mut entry = previous.get(old_name(renames, &role.name)).and_then(Value::as_mapping).cloned().unwrap_or_default();
            entry.insert("color".into(), role.color.clone().map_or(Value::Null, Value::String));
            entry.insert("ch".into(), role.channel.map_or(Value::Null, Value::from));
            role_map.insert(role.name.clone().into(), Value::Mapping(entry));
        }
        root.insert("roles".into(), Value::Mapping(role_map));

        if groups.is_empty() {
            root.shift_remove("groups");
        } else {
            let mut group_map = Mapping::new();
            for group in groups {
                let mut entry = Mapping::new();
                entry.insert("color".into(), group.color.clone().map_or(Value::Null, Value::String));
                let members = group.roles.iter().map(|r| Value::String(renamed(r).unwrap_or_else(|| r.clone())));
                entry.insert("roles".into(), Value::Sequence(members.collect()));
                group_map.insert(group.name.clone().into(), Value::Mapping(entry));
            }
            root.insert("groups".into(), Value::Mapping(group_map));
        }
        config.set_yaml(yaml);
    }
}

impl Script {
    /// A variant group must start with a cue that is not a variant. After blocks were
    /// removed or moved, a "variant" left without such a cue before it becomes a cue of its own.
    fn repair_variants(&mut self) {
        let mut previous_is_cue = false;
        for block in &mut self.blocks {
            match block {
                Block::Cue(cue) => {
                    if cue.is_variant() && !previous_is_cue {
                        let mut yaml = cue.yaml.clone();
                        if let Some(map) = yaml.as_mapping_mut() {
                            map.shift_remove("sibling");
                        }
                        cue.set_yaml(yaml);
                    }
                    previous_is_cue = true;
                }
                // Variants follow their cue directly; anything in between ends the group.
                Block::Config(_) => {}
                _ => previous_is_cue = false,
            }
        }
    }

    /// Remove a block. The config block cannot be removed.
    pub fn delete_block(&mut self, index: usize) {
        if matches!(self.blocks.get(index), Some(Block::Config(_)) | None) {
            return;
        }
        self.blocks.remove(index);
        self.repair_variants();
    }

    /// Insert a block before `index` (or at the end).
    pub fn insert_block(&mut self, index: usize, block: Block) {
        self.blocks.insert(index.min(self.blocks.len()), block);
        self.repair_variants();
    }

    /// Swap a block with its neighbour above (`up`) or below. Returns its new index.
    /// The config block stays where it is.
    pub fn move_block(&mut self, index: usize, up: bool) -> usize {
        let target = if up { index.checked_sub(1) } else { Some(index + 1).filter(|&t| t < self.blocks.len()) };
        let is_config = |i: usize| matches!(self.blocks.get(i), Some(Block::Config(_)));
        match target {
            Some(target) if index < self.blocks.len() && !is_config(index) && !is_config(target) => {
                self.blocks.swap(index, target);
                self.repair_variants();
                target
            }
            _ => index,
        }
    }

    /// A new cue built from YAML fields, with the lowest free trigger note.
    pub fn new_cue(&mut self, fields: Value) -> Block {
        let mut cue = Cue { yaml: Value::Null, invalid: false, source: String::new() };
        cue.set_yaml(fields);
        // Let the existing note assignment pick the note, on a copy that includes the cue.
        self.blocks.push(Block::Cue(cue));
        self.assign_trigger_notes();
        self.blocks.pop().expect("the cue just pushed")
    }

    /// A copy of the cue at `index` as a cue of its own: fresh trigger note, not a variant.
    /// With `variant`, the copy is a variant of the original instead.
    pub fn copy_cue(&mut self, index: usize, variant: bool) -> Option<Block> {
        let Some(Block::Cue(original)) = self.blocks.get(index) else { return None };
        let mut yaml = original.yaml.clone();
        let map = yaml.as_mapping_mut()?;
        map.shift_remove("trigger_note");
        map.shift_remove("sibling");
        if variant {
            // `sibling` leads the block, as the app has always written it.
            let mut with_flag = Mapping::new();
            with_flag.insert("sibling".into(), true.into());
            with_flag.extend(map.clone());
            *map = with_flag;
        }
        Some(self.new_cue(yaml))
    }
}

/// One step into a YAML value.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Key(String),
    Index(usize),
}

/// A key (or list entry) that "Clean up YAML" removes, with the value it had.
#[derive(Clone, Debug, PartialEq)]
pub struct Removal {
    /// 1-based number of the YAML block in the file (the config block is 1).
    pub block: usize,
    /// Dotted path such as `music.adjust.foo` or `cue_midi[0].bar`.
    pub key: String,
    pub value: Value,
    path: Vec<Step>,
}

const CONFIG_KEYS: &[&str] = &["roles", "groups", "app_version", "emLightNote", "virtualChannels", "outputDevices"];
const CUE_KEYS: &[&str] = &[
    "sibling", "trigger_note", "note", "auto_mic", "mic", "music", "music_seq", "osc", "osc_arg", "osc_arg_type",
    "qlcplus", "projection", "start_tc", "auto_trigger", "chain_end", "loop_outro", "cue_midi", "cue_osc",
    "cue_http", "cue_display",
];
const NOTE_REF_KEYS: &[&str] = &["ch", "note"];
const MUSIC_KEYS: &[&str] =
    &["file", "volume", "start", "end", "fadein", "fadeout", "fading_point", "loop", "audios", "adjust"];
const MUSIC_SEQ_KEYS: &[&str] = &["file", "volume", "start", "end", "fadein", "fadeout", "fading_point", "audios"];
const AUDIO_KEYS: &[&str] = &["file", "mono", "volume", "patch"];
const ADJUST_KEYS: &[&str] = &["trigger_note", "fadeout", "fadetime", "volume"];
const AUTO_TRIGGER_KEYS: &[&str] = &["trigger_note", "at", "delay"];
const CUE_MIDI_KEYS: &[&str] = &["device", "type", "ch", "note", "vel", "cc", "value", "program", "bytes", "comment"];
const CUE_OSC_KEYS: &[&str] = &["device", "path", "arg", "arg_type", "comment"];
const CUE_HTTP_KEYS: &[&str] = &["device", "method", "path", "body", "content_type", "comment"];
const CUE_DISPLAY_KEYS: &[&str] = &["device", "markdown", "announce"];

fn path_text(path: &[Step]) -> String {
    let mut text = String::new();
    for step in path {
        match step {
            Step::Key(k) if text.is_empty() => text.push_str(k),
            Step::Key(k) => {
                text.push('.');
                text.push_str(k);
            }
            Step::Index(i) => text.push_str(&format!("[{i}]")),
        }
    }
    text
}

fn key(name: &str) -> Step {
    Step::Key(name.to_string())
}

/// Collects keys outside the format, walking the known nested structures.
struct Finder {
    found: Vec<Vec<Step>>,
}

impl Finder {
    /// Report every key of the mapping at `path` that is not in `allowed`.
    fn check(&mut self, value: Option<&Value>, allowed: &[&str], path: &[Step]) {
        let Some(Value::Mapping(map)) = value else { return };
        for name in map.keys().filter_map(Value::as_str).filter(|n| !allowed.contains(n)) {
            let mut full = path.to_vec();
            full.push(key(name));
            self.found.push(full);
        }
    }

    /// Check every entry of the list at `path`, plus `nested` per entry.
    fn check_list(&mut self, value: Option<&Value>, allowed: &[&str], path: &[Step], with_audios: bool) {
        let Some(Value::Sequence(list)) = value else { return };
        for (i, item) in list.iter().enumerate() {
            let mut entry = path.to_vec();
            entry.push(Step::Index(i));
            self.check(Some(item), allowed, &entry);
            if with_audios {
                entry.push(key("audios"));
                self.check_list(item.get("audios"), AUDIO_KEYS, &entry, false);
            }
        }
    }

    fn cue(&mut self, cue: &Value) {
        self.check(Some(cue), CUE_KEYS, &[]);
        for name in ["trigger_note", "chain_end", "loop_outro"] {
            self.check(cue.get(name), NOTE_REF_KEYS, &[key(name)]);
        }
        if let Some(music) = cue.get("music").filter(|m| m.is_mapping()) {
            let music_path = [key("music")];
            self.check(Some(music), MUSIC_KEYS, &music_path);
            if let Some(adjust) = music.get("adjust").filter(|a| a.is_mapping()) {
                let adjust_path = [key("music"), key("adjust")];
                self.check(Some(adjust), ADJUST_KEYS, &adjust_path);
                self.check(adjust.get("trigger_note"), NOTE_REF_KEYS, &[key("music"), key("adjust"), key("trigger_note")]);
            }
            self.check_list(music.get("audios"), AUDIO_KEYS, &[key("music"), key("audios")], false);
        }
        self.check_list(cue.get("music_seq"), MUSIC_SEQ_KEYS, &[key("music_seq")], true);
        if let Some(auto) = cue.get("auto_trigger").filter(|a| a.is_mapping()) {
            self.check(Some(auto), AUTO_TRIGGER_KEYS, &[key("auto_trigger")]);
            self.check(auto.get("trigger_note"), NOTE_REF_KEYS, &[key("auto_trigger"), key("trigger_note")]);
        }
        for (name, allowed) in [
            ("cue_midi", CUE_MIDI_KEYS),
            ("cue_osc", CUE_OSC_KEYS),
            ("cue_http", CUE_HTTP_KEYS),
            ("cue_display", CUE_DISPLAY_KEYS),
        ] {
            self.check_list(cue.get(name), allowed, &[key(name)], false);
        }
    }
}

fn value_at<'v>(root: &'v Value, path: &[Step]) -> Option<&'v Value> {
    path.iter().try_fold(root, |v, step| match step {
        Step::Key(k) => v.get(k.as_str()),
        Step::Index(i) => v.get(*i),
    })
}

/// Remove the leaf at `path`; missing intermediate steps make it a no-op.
fn remove_at(root: &mut Value, path: &[Step]) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut current = root;
    for step in parents {
        let next = match step {
            Step::Key(k) => current.get_mut(k.as_str()),
            Step::Index(i) => current.get_mut(*i),
        };
        let Some(next) = next else { return };
        current = next;
    }
    match (current, last) {
        (Value::Mapping(map), Step::Key(k)) => {
            map.shift_remove(k.as_str());
        }
        (Value::Sequence(list), Step::Index(i)) if *i < list.len() => {
            list.remove(*i);
        }
        _ => {}
    }
}

/// What "Clean up YAML" would remove from one block.
fn block_removals(yaml: &Value, is_config: bool, channels: &[String]) -> Vec<Vec<Step>> {
    let mut finder = Finder { found: Vec::new() };
    if is_config {
        finder.check(yaml.get("config"), CONFIG_KEYS, &[key("config")]);
        return finder.found;
    }
    // 1. Keys that are not part of the format, at any depth.
    finder.cue(yaml);
    let mut paths = finder.found;

    // 2. Loop settings left behind on a cue that is not a loop.
    let music = yaml.get("music").filter(|m| m.is_mapping());
    let is_loop = music.and_then(|m| m.get("loop")).and_then(Value::as_bool) == Some(true)
        || yaml.get("loop_outro").is_some()
        || yaml.get("music_seq").is_some_and(Value::is_sequence);
    if let Some(music) = music.filter(|_| !is_loop) {
        if music.get("fading_point").is_some() {
            paths.push(vec![key("music"), key("fading_point")]);
        }
        if music.get("loop").and_then(Value::as_bool) == Some(false) {
            paths.push(vec![key("music"), key("loop")]);
        }
    }

    // 3. Audios patched to virtual channels that no longer exist.
    let unknown_channel = |audio: &Value| match audio.get("patch") {
        Some(Value::Sequence(patch)) => patch.iter().any(|entry| match entry {
            Value::Sequence(names) => names.iter().any(|n| n.as_str().is_some_and(|n| !channels.iter().any(|c| c == n))),
            other => other.as_str().is_some_and(|n| !channels.iter().any(|c| c == n)),
        }),
        _ => false,
    };
    let mut stale_audios = |container: Option<&Value>, prefix: Vec<Step>| {
        let Some(Value::Sequence(audios)) = container.and_then(|c| c.get("audios")) else { return };
        for (i, audio) in audios.iter().enumerate() {
            if unknown_channel(audio) {
                let mut path = prefix.clone();
                path.extend([key("audios"), Step::Index(i)]);
                paths.push(path);
            }
        }
    };
    stale_audios(music, vec![key("music")]);
    if let Some(Value::Sequence(slots)) = yaml.get("music_seq") {
        for (i, slot) in slots.iter().enumerate() {
            stale_audios(Some(slot), vec![key("music_seq"), Step::Index(i)]);
        }
    }
    paths
}

/// Call `visit` with every place in a cue that names an audio file: the short form
/// `music: file.wav`, `music.file`, and every entry of an `audios` list — in `music` as
/// well as in each `music_seq` entry.
fn audio_refs(cue: &mut Value, visit: &mut dyn FnMut(&mut Value)) {
    fn entry(entry: &mut Value, visit: &mut dyn FnMut(&mut Value)) {
        if !entry.is_mapping() {
            return;
        }
        if let Some(file) = entry.get_mut("file").filter(|f| f.is_string()) {
            visit(file);
        }
        if let Some(Value::Sequence(audios)) = entry.get_mut("audios") {
            for file in audios.iter_mut().filter_map(|a| a.get_mut("file")).filter(|f| f.is_string()) {
                visit(file);
            }
        }
    }
    match cue.get_mut("music") {
        Some(music) if music.is_string() => visit(music),
        Some(music) => entry(music, visit),
        None => {}
    }
    if let Some(Value::Sequence(parts)) = cue.get_mut("music_seq") {
        parts.iter_mut().for_each(|part| entry(part, visit));
    }
}

/// Point every reference to the audio file `from` in one cue at `to`. Returns how many
/// there were.
pub fn rename_audio_in(cue: &mut Value, from: &str, to: &str) -> usize {
    let mut hits = 0;
    audio_refs(cue, &mut |file| {
        if file.as_str().and_then(crate::audio::sanitize_path).as_deref() == Some(from) {
            *file = to.into();
            hits += 1;
        }
    });
    hits
}

/// The audio files one cue names, in the order they stand in it (repeats included).
pub fn audio_files_in(cue: &Value) -> Vec<String> {
    let mut files = Vec::new();
    audio_refs(&mut cue.clone(), &mut |file| files.push(file.as_str().and_then(crate::audio::sanitize_path).unwrap_or_default()));
    files
}

impl Script {
    /// Every audio file the cues name, and how many cue blocks cannot be read. Those may
    /// name files too, so with any of them the list is not to be relied on.
    pub fn audio_files_used(&self) -> (Vec<String>, usize) {
        let mut used: Vec<String> = Vec::new();
        let mut unreadable = 0;
        for block in &self.blocks {
            match block {
                Block::Cue(cue) if cue.invalid => unreadable += 1,
                Block::Cue(cue) => audio_refs(&mut cue.yaml.clone(), &mut |file| {
                    if let Some(name) = file.as_str().and_then(crate::audio::sanitize_path).filter(|n| !used.contains(n)) {
                        used.push(name);
                    }
                }),
                _ => {}
            }
        }
        (used, unreadable)
    }

    /// Point every reference to the audio file `from` at `to`. Only cues that name the
    /// file are rewritten. Returns how many references changed.
    pub fn rename_audio(&mut self, from: &str, to: &str) -> usize {
        let mut hits = 0;
        for block in &mut self.blocks {
            let Block::Cue(cue) = block else { continue };
            if cue.invalid {
                continue;
            }
            let mut yaml = cue.yaml.clone();
            let found = rename_audio_in(&mut yaml, from, to);
            if found > 0 {
                cue.set_yaml(yaml);
                hits += found;
            }
        }
        hits
    }

    /// Everything "Clean up YAML" would remove: keys outside the show-file format, loop
    /// settings on cues that do not loop, and audios patched to missing virtual channels.
    pub fn cleanup_preview(&self) -> Vec<Removal> {
        let channels = self.virtual_channels();
        let mut removals = Vec::new();
        let mut number = 0;
        for block in &self.blocks {
            let (yaml, is_config) = match block {
                Block::Config(c) => (&c.yaml, true),
                Block::Cue(c) if !c.invalid => (&c.yaml, false),
                Block::Cue(_) => {
                    number += 1;
                    continue;
                }
                _ => continue,
            };
            number += 1;
            for path in block_removals(yaml, is_config, &channels) {
                if let Some(value) = value_at(yaml, &path) {
                    removals.push(Removal { block: number, key: path_text(&path), value: value.clone(), path });
                }
            }
        }
        removals
    }

    /// Apply `cleanup_preview` and return what was removed. Only blocks that lose
    /// something are rewritten.
    pub fn cleanup(&mut self) -> Vec<Removal> {
        let removals = self.cleanup_preview();
        self.remove(&removals);
        removals
    }

    /// Remove one of the things `cleanup_preview` lists: the key `key` of YAML block
    /// number `block`. Returns whether it was there.
    pub fn cleanup_one(&mut self, block: usize, key: &str) -> bool {
        let removals: Vec<Removal> = self.cleanup_preview().into_iter().filter(|r| r.block == block && r.key == key).collect();
        self.remove(&removals);
        !removals.is_empty()
    }

    fn remove(&mut self, removals: &[Removal]) {
        let mut number = 0;
        for block in &mut self.blocks {
            if !matches!(block, Block::Config(_) | Block::Cue(_)) {
                continue;
            }
            number += 1;
            // Keys first; then whole list entries from the back, so the indices of the
            // entries still to be removed stay valid.
            let of_block = || removals.iter().filter(|r| r.block == number).map(|r| &r.path);
            let is_entry = |p: &&Vec<Step>| matches!(p.last(), Some(Step::Index(_)));
            let mut paths: Vec<&Vec<Step>> = of_block().filter(|p| !is_entry(p)).collect();
            paths.extend(of_block().filter(is_entry).collect::<Vec<_>>().into_iter().rev());
            if paths.is_empty() {
                continue;
            }
            match block {
                Block::Config(config) => {
                    let mut yaml = config.yaml.clone();
                    paths.iter().for_each(|p| remove_at(&mut yaml, p));
                    config.set_yaml(yaml);
                }
                Block::Cue(cue) => {
                    let mut yaml = cue.yaml.clone();
                    paths.iter().for_each(|p| remove_at(&mut yaml, p));
                    cue.set_yaml(yaml);
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "```yaml\nconfig:\n    roles: {}\n    settings:\n        host: {}\n    virtualChannels:\n        -\n            name: Saal L\n        -\n            name: Saal R\n```\n";

    fn cue_sources(script: &Script) -> Vec<&str> {
        script
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Cue(c) => Some(c.source.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn assigns_the_lowest_free_trigger_notes() {
        let text = format!(
            "{CONFIG}\n```yaml\nlight: A\n```\n\n```yaml\ntrigger_note: {{ch: 1, note: 1}}\n```\n\n```yaml\nmic: [Anna\n```\n\n```yaml\n```\n\n```yaml\nlight: B\ntrigger_note: {{ch: 1, note: 3}}\n```\n\n```yaml\nmusic: a.wav\n```\n"
        );
        let mut script = Script::parse(&text);
        assert!(script.assign_trigger_notes());
        assert_eq!(
            cue_sources(&script),
            [
                "light: A\ntrigger_note: {ch: 1, note: 2}",
                "trigger_note: {ch: 1, note: 1}",
                "mic: [Anna", // unreadable: left alone
                "",           // empty: left alone
                "light: B\ntrigger_note: {ch: 1, note: 3}",
                "music: a.wav\ntrigger_note: {ch: 1, note: 4}",
            ]
        );
        assert!(!script.assign_trigger_notes(), "nothing left to assign");
        assert_eq!(Script::parse(&script.to_markdown()), script, "the written file reads back the same");
    }

    #[test]
    fn editing_a_cue_rewrites_only_that_block() {
        let text = format!("{CONFIG}\n```yaml\nlight:   A   # hand-written\n```\n\n```yaml\nlight: B\n```\n");
        let mut script = Script::parse(&text);
        let Some(Block::Cue(cue)) = script.blocks.last_mut() else { panic!("expected a cue") };
        let mut yaml = cue.yaml.clone();
        yaml.as_mapping_mut().unwrap().insert("note".into(), "Go: now".into());
        cue.set_yaml(yaml);
        let written = script.to_markdown();
        assert!(written.contains("light:   A   # hand-written"), "untouched blocks keep their text");
        assert!(written.ends_with("```yaml\nlight: B\nnote: 'Go: now'\n```\n"));
    }

    #[test]
    fn finds_what_cleanup_would_remove() {
        let cue = "\
light: Day
foo: 1
trigger_note: {ch: 1, note: 1, velocity: 9}
music:
    file: a.wav
    loop: false
    fading_point: 3
    monitor: true
    adjust:
        trigger_note: {ch: 1, note: 2, x: 1}
        bar: 2
    audios:
        - {file: b.wav, patch: [Saal L, Gone], extra: 1}
        - {file: c.wav, patch: [[Saal L, Saal R]]}
        - {file: d.wav, patch: [[Saal L, Lost]]}
music_seq:
    - {file: e.wav, outro_len: 2, audios: [{file: f.wav, gain: 1}]}
auto_trigger: {trigger_note: {ch: 1, note: 2, y: 1}, at: 1, when: 2}
cue_midi:
    - {device: Licht, type: note, colour: red}
cue_display:
    - {device: Foyer, markdown: Hi, size: 3}";
        let script = Script::parse(&format!("{CONFIG}\n```yaml\n{cue}\n```\n"));
        let removals = script.cleanup_preview();
        let keys: Vec<(usize, &str)> = removals.iter().map(|r| (r.block, r.key.as_str())).collect();
        assert_eq!(
            keys,
            [
                (1, "config.settings"),
                (2, "light"),
                (2, "foo"),
                (2, "trigger_note.velocity"),
                (2, "music.monitor"),
                (2, "music.adjust.bar"),
                (2, "music.adjust.trigger_note.x"),
                (2, "music.audios[0].extra"),
                (2, "music_seq[0].outro_len"),
                (2, "music_seq[0].audios[0].gain"),
                (2, "auto_trigger.when"),
                (2, "auto_trigger.trigger_note.y"),
                (2, "cue_midi[0].colour"),
                (2, "cue_display[0].size"),
                (2, "music.audios[0]"),
                (2, "music.audios[2]"),
            ]
        );
        assert_eq!(removals[1].value, Value::String("Day".into()));
    }

    #[test]
    fn cleanup_removes_and_rewrites() {
        let text = format!(
            "{CONFIG}\n```yaml\nlight: Day\nmusic:\n    file: a.wav\n    loop: false\n    fading_point: 3\n    audios:\n        - {{file: b.wav, patch: [Gone]}}\n        - {{file: c.wav, patch: [Saal L]}}\n        - {{file: d.wav, patch: [Lost]}}\ntrigger_note: {{ch: 1, note: 1}}\n```\n\n```yaml\nmusic:\n    file: l.wav\n    loop: true\n    fading_point: 3\n```\n"
        );
        let mut script = Script::parse(&text);
        let removed = script.cleanup();
        assert_eq!(removed.len(), 6);
        assert_eq!(
            cue_sources(&script),
            [
                "music:\n    file: a.wav\n    audios:\n        -\n            file: c.wav\n            patch:\n                - Saal L\ntrigger_note: {ch: 1, note: 1}",
                // A real loop keeps its fading point, and the block keeps its original text.
                "music:\n    file: l.wav\n    loop: true\n    fading_point: 3",
            ]
        );
        assert!(!script.to_markdown().contains("settings"));
        assert!(script.cleanup().is_empty(), "a cleaned script has nothing left to remove");
    }

    #[test]
    fn saving_roles_renames_them_everywhere() {
        use crate::mic::{Cast, Mic};
        let text = "\
```yaml
config:
    roles:
        Anna:
            color: blue
            ch: 3
            device: 0
        Ben:
            color: green
            ch: null
    groups:
        Duo:
            color: purple
            roles:
                - Anna
                - Ben
    app_version: 1.16.0
```

```yaml
mic:
    - Anna
    - Duo
```

```yaml
mic: Anna
light: untouched   # stays as written
```

**Anna/Ben**
Hello Anna.

**Ben**
Hi.
";
        let mut script = Script::parse(text);
        let cast = Cast::from_script(&script, false);
        let mut roles = cast.roles.clone();
        roles[0].name = "Annabel".into();
        roles[0].color = Some("red".into());
        roles.push(Role { name: "Clara".into(), color: None, channel: Some(7), mixer: 0 });
        script.save_roles(&roles, &cast.groups, &[("Anna".into(), "Annabel".into())]);

        let written = script.to_markdown();
        let expected_config = "\
config:
    roles:
        Annabel:
            color: red
            ch: 3
            device: 0
        Ben:
            color: green
            ch: null
        Clara:
            color: null
            ch: 7
    groups:
        Duo:
            color: purple
            roles:
                - Annabel
                - Ben
    app_version: 1.16.0";
        assert!(written.starts_with(&format!("```yaml\n{expected_config}\n```\n")), "{written}");
        assert!(written.contains("**Annabel/Ben**\nHello Anna.\n"), "names change, dialogue does not");
        assert!(written.contains("mic: Annabel\nlight: untouched"), "a cue with a renamed mic is rewritten");

        let cast = Cast::from_script(&script, false);
        let first_cue = script.blocks.iter().position(|b| matches!(b, Block::Cue(_))).unwrap();
        assert_eq!(script.mic_for_cue(first_cue, &cast), Mic::Open(vec!["Annabel".into(), "Duo".into()]));

        // Removing all groups drops the key.
        script.save_roles(&cast.roles, &[], &[]);
        assert!(!script.to_markdown().contains("groups"));
    }

    #[test]
    fn inserts_moves_and_deletes_blocks() {
        let mut script = Script::parse(&format!("{CONFIG}\n# One\n\n*Two*\n\nThree\n"));
        script.delete_block(0);
        assert_eq!(script.blocks.len(), 4, "the config block stays");
        assert_eq!(script.move_block(1, true), 1, "nothing moves above the config block");
        assert_eq!(script.move_block(1, false), 2);
        assert_eq!(script.move_block(3, false), 3, "the last block cannot go further down");
        script.insert_block(99, Block::Text("Four".into()));
        script.delete_block(3);
        assert!(script.to_markdown().ends_with("*Two*\n\n# One\n\nFour\n"));
    }

    #[test]
    fn copies_cues_and_keeps_variant_groups_sound() {
        let text = format!("{CONFIG}\n```yaml\nlight: A\ntrigger_note: {{ch: 1, note: 1}}\n```\n");
        let mut script = Script::parse(&text);
        let copy = script.copy_cue(1, false).unwrap();
        let variant = script.copy_cue(1, true).unwrap();
        script.insert_block(2, variant);
        script.insert_block(3, copy);
        assert_eq!(
            cue_sources(&script),
            ["light: A\ntrigger_note: {ch: 1, note: 1}", "sibling: true\nlight: A\ntrigger_note: {ch: 1, note: 2}", "light: A\ntrigger_note: {ch: 1, note: 2}"],
            "each copy got the lowest note free at the time"
        );
        assert_eq!(script.validate().note_conflicts.len(), 1, "which the check then reports, as two were made from the same state");

        // Deleting the cue a variant belongs to makes the variant a cue of its own.
        script.delete_block(1);
        assert_eq!(cue_sources(&script)[0], "light: A\ntrigger_note: {ch: 1, note: 2}");
        // So does moving text in between.
        let mut script = Script::parse(&text);
        let variant = script.copy_cue(1, true).unwrap();
        script.insert_block(2, variant);
        script.insert_block(2, Block::Text("in between".into()));
        assert!(!cue_sources(&script)[1].contains("sibling"));

        let fresh = script.new_cue(serde_yaml_ng::from_str("note: Neu").unwrap());
        assert!(matches!(&fresh, Block::Cue(c) if c.source == "note: Neu\ntrigger_note: {ch: 1, note: 3}"));
        assert_eq!(script.blocks.len(), 4, "new_cue does not insert by itself");
    }

    #[test]
    fn default_virtual_channels_are_left_and_right() {
        assert_eq!(Script::parse("```yaml\nconfig:\n    roles: {}\n```\n").virtual_channels(), ["L", "R"]);
        assert_eq!(Script::parse(CONFIG).virtual_channels(), ["Saal L", "Saal R"]);
    }
    #[test]
    fn finds_and_renames_audio_references_everywhere() {
        let text = "```yaml\nmusic: a.wav\n```\n\nText\n\n```yaml\nmusic:\n    file: b.wav\n    volume: 0.5\nmusic_seq:\n    - file: ./a.wav\n    - audios:\n          - file: c.wav\n          - file: a.wav\n```\n\n```yaml\nmusic:\n    audios:\n        - file: d.wav\n```\n\n```yaml\nnote: [broken\n```\n";
        let mut script = Script::parse(text);
        assert_eq!(script.audio_files_used(), (vec!["a.wav".to_string(), "b.wav".into(), "c.wav".into(), "d.wav".into()], 1));

        let untouched = script.blocks[4].clone();
        assert_eq!(script.rename_audio("a.wav", "intro.wav"), 3);
        assert_eq!(script.audio_files_used().0, ["intro.wav", "b.wav", "c.wav", "d.wav"]);
        assert!(script.blocks[4] == untouched, "a cue that does not name the file keeps its text");
        assert!(script.to_markdown().contains("note: [broken"), "as does one that cannot be read");
        assert_eq!(script.rename_audio("missing.wav", "x.wav"), 0);
        let Block::Cue(second) = &script.blocks[2] else { panic!("a cue") };
        assert_eq!(audio_files_in(&second.yaml), ["b.wav", "intro.wav", "c.wav", "intro.wav"]);
    }

    #[test]
    fn virtual_channels_are_set_and_renames_reach_the_patches() {
        let mut script = Script::parse("```yaml\nconfig:\n    roles: {}\n```\n\n```yaml\nmusic:\n    audios:\n        - file: a.wav\n          patch: [L, [R, Sub]]\n```\n\n```yaml\nmusic: b.wav\n```\n");
        let untouched = script.blocks[2].clone();
        script.set_virtual_channels(&["Saal L".to_string(), "R".into(), "Sub".into()], &[("L".to_string(), "Saal L".to_string())]);
        assert_eq!(script.virtual_channels(), ["Saal L", "R", "Sub"]);
        let patch = script.blocks.iter().find_map(|b| match b {
            Block::Cue(cue) => cue.audio().and_then(|a| a.parts[0].audios[0].patch.clone()),
            _ => None,
        });
        assert_eq!(patch, Some(vec![vec!["Saal L".to_string()], vec!["R".to_string(), "Sub".to_string()]]));
        assert!(script.blocks[2] == untouched);
    }

    #[test]
    fn a_single_unknown_key_can_be_removed() {
        let mut script = Script::parse("```yaml\nconfig:\n    roles: {}\n```\n\n```yaml\nfoo: 1\nbar: 2\nnote: x\n```\n");
        assert!(script.cleanup_one(2, "foo"));
        assert!(!script.cleanup_one(2, "foo"));
        assert_eq!(script.cleanup_preview().iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["bar"]);
        assert!(script.to_markdown().contains("note: x"));
    }

    #[test]
    fn a_changed_trigger_note_takes_its_references_along() {
        let mut script = Script::parse("```yaml\ntrigger_note: {ch: 1, note: 1}\nmusic:\n    file: a.wav\n    adjust:\n        trigger_note: {ch: 1, note: 2}\n        fadeout: true\nchain_end: {ch: 1, note: 2}\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 2}\nloop_outro: {ch: 1, note: 3}\n```\n\n```yaml\ntrigger_note: {ch: 1, note: 3}\nauto_trigger:\n    trigger_note: {ch: 1, note: 2}\n    delay: 1\n```\n");
        let (from, to) = (Note { ch: 1, note: 2 }, Note { ch: 2, note: 40 });
        assert_eq!(script.renumber_note(from, to), 3);
        let cues = crate::cues::Cues::new(&script);
        assert_eq!(cues.get(0).unwrap().chain_end(), Some(to));
        assert_eq!(cues.get(0).unwrap().adjust().unwrap().target, to);
        assert_eq!(cues.get(2).unwrap().auto_trigger().unwrap().source, to);
        // The cue's own note is the caller's business, and other notes are left alone.
        assert_eq!(cues.get(1).unwrap().note(), Some(from));
        assert_eq!(cues.get(1).unwrap().loop_outro(), Some(Note { ch: 1, note: 3 }));
    }

    #[test]
    fn output_devices_are_declared_in_the_config() {
        let mut script = Script::parse("```yaml\nconfig:\n    roles: {}\n```\n");
        script.set_output_devices(&[("Licht".into(), "midi".into(), Some("yellow".into())), ("QLab".into(), "osc".into(), None)]);
        let declared = script.config().unwrap().get("outputDevices").unwrap().clone();
        assert_eq!(declared[0].get("color").and_then(Value::as_str), Some("yellow"));
        assert_eq!(declared[1].get("name").and_then(Value::as_str), Some("QLab"));
        assert!(declared[1].get("color").is_none());
        script.set_output_devices(&[]);
        assert!(script.config().unwrap().get("outputDevices").is_none());
    }
}
