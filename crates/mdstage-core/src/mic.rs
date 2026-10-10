//! Microphone assignments: roles, role groups and Auto-Mic.

use serde_yaml_ng::Value;

use crate::{Block, Cue, Script};

/// The built-in group of all roles. `All` is accepted as well when the app runs in English.
const ALL_DE: &str = "Alle";
const ALL_EN: &str = "All";

/// A cue's microphone assignment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mic {
    /// The cue does not touch the microphones.
    Unchanged,
    /// Mute every channel.
    MuteAll,
    /// Open exactly these roles or groups; everything else is muted.
    Open(Vec<String>),
}

impl Mic {
    fn from_names(names: Vec<String>) -> Mic {
        if names.is_empty() { Mic::Unchanged } else { Mic::Open(names) }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Role {
    pub name: String,
    pub color: Option<String>,
    /// Mixer channel of the role's microphone.
    pub channel: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub name: String,
    pub color: Option<String>,
    pub roles: Vec<String>,
}

/// One chip in a cue's mic display.
#[derive(Clone, Debug, PartialEq)]
pub enum MicChip {
    Role { name: String, color: Option<String> },
    Group { name: String, color: Option<String>, members: Vec<(String, Option<String>)> },
}

/// Roles and groups of a show, from the config block.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cast {
    pub roles: Vec<Role>,
    pub groups: Vec<Group>,
    /// Whether `All` names the built-in group too (English UI).
    pub english: bool,
}

impl Cast {
    pub fn from_script(script: &Script, english: bool) -> Cast {
        let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        let entries = |key: &str| match script.config().and_then(|c| c.get(key)) {
            Some(Value::Mapping(m)) => m.iter().filter_map(|(k, v)| Some((k.as_str()?.to_string(), v.clone()))).collect(),
            _ => Vec::new(),
        };
        let roles = entries("roles")
            .into_iter()
            .map(|(name, v)| Role { name, color: text(&v, "color"), channel: v.get("ch").and_then(Value::as_u64) })
            .collect();
        let groups = entries("groups")
            .into_iter()
            .map(|(name, v)| {
                let members = match v.get("roles") {
                    Some(Value::Sequence(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                    _ => Vec::new(),
                };
                Group { name, color: text(&v, "color"), roles: members }
            })
            .collect();
        Cast { roles, groups, english }
    }

    pub fn role(&self, name: &str) -> Option<&Role> {
        self.roles.iter().find(|r| r.name == name)
    }

    fn is_all(&self, name: &str) -> bool {
        name == ALL_DE || (self.english && name == ALL_EN)
    }

    pub fn is_group(&self, name: &str) -> bool {
        self.is_all(name) || self.groups.iter().any(|g| g.name == name)
    }

    /// Member roles of a group; every role for the built-in group, nothing for a non-group.
    pub fn group_roles(&self, name: &str) -> Vec<String> {
        if self.is_all(name) {
            return self.roles.iter().map(|r| r.name.clone()).collect();
        }
        self.groups.iter().find(|g| g.name == name).map(|g| g.roles.clone()).unwrap_or_default()
    }

    fn group_color(&self, name: &str) -> Option<String> {
        self.groups.iter().find(|g| g.name == name && !self.is_all(name))?.color.clone()
    }

    fn role_color(&self, name: &str) -> Option<String> {
        self.role(name)?.color.clone()
    }

    /// Replace group names by their member roles, without duplicates (for MIDI/OSC routing).
    pub fn expand(&self, mic: &Mic) -> Mic {
        let Mic::Open(names) = mic else { return mic.clone() };
        let mut out: Vec<String> = Vec::new();
        for name in names {
            let members = if self.is_group(name) { self.group_roles(name) } else { vec![name.clone()] };
            for member in members {
                if !out.contains(&member) {
                    out.push(member);
                }
            }
        }
        Mic::from_names(out)
    }

    /// Chips for the cue panel and live view. `grouped` keeps groups as labelled boxes;
    /// otherwise they are flattened to their member roles.
    pub fn chips(&self, mic: &Mic, grouped: bool) -> Vec<MicChip> {
        let Mic::Open(names) = mic else { return Vec::new() };
        let role = |name: &str| MicChip::Role { name: name.to_string(), color: self.role_color(name) };
        // Group members that are not (or no longer) defined as roles are left out.
        let members = |group: &str| self.group_roles(group).into_iter().filter(|r| self.role(r).is_some());
        let mut out = Vec::new();
        if grouped {
            for name in names {
                out.push(if self.is_group(name) {
                    MicChip::Group {
                        name: name.clone(),
                        color: self.group_color(name),
                        members: members(name).map(|r| (r.clone(), self.role_color(&r))).collect(),
                    }
                } else {
                    role(name)
                });
            }
            return out;
        }
        let mut seen: Vec<String> = Vec::new();
        for name in names {
            let flat = if self.is_group(name) { members(name).collect() } else { vec![name.clone()] };
            for r in flat {
                if !seen.contains(&r) {
                    out.push(role(&r));
                    seen.push(r);
                }
            }
        }
        out
    }
}

impl Cue {
    /// Whether the cue computes its microphones from the script (`auto_mic: true`).
    pub fn auto_mic(&self) -> bool {
        self.field("auto_mic").and_then(Value::as_bool) == Some(true)
    }

    /// The stored `mic` field.
    pub fn mic(&self) -> Mic {
        match self.mics().as_slice() {
            ["muteall"] => Mic::MuteAll,
            names => Mic::from_names(names.iter().map(|n| n.to_string()).collect()),
        }
    }
}

impl Script {
    /// Whether any cue uses Auto-Mic. If so, manual mic selection is disabled everywhere.
    pub fn has_auto_mic(&self) -> bool {
        self.blocks.iter().any(|b| matches!(b, Block::Cue(c) if c.auto_mic()))
    }

    /// The microphones an Auto-Mic cue opens: every role (or group) with dialogue between
    /// the cue at `block_index` and the next Auto-Mic cue. The last Auto-Mic cue of the
    /// script mutes everything.
    pub fn auto_mic(&self, block_index: usize, cast: &Cast) -> Mic {
        let after = &self.blocks[(block_index + 1).min(self.blocks.len())..];
        let Some(next) = after.iter().position(|b| matches!(b, Block::Cue(c) if c.auto_mic())) else {
            return Mic::MuteAll;
        };
        let mut open: Vec<String> = Vec::new();
        // Roles already opened through a group are not listed again.
        let mut covered: Vec<String> = Vec::new();
        for block in &after[..next] {
            let Block::Role { names, text } = block else { continue };
            if text.trim().is_empty() {
                continue;
            }
            for name in names.iter().filter(|n| !n.is_empty()) {
                if open.contains(name) {
                    continue;
                }
                if cast.is_group(name) {
                    covered.extend(cast.group_roles(name));
                    open.push(name.clone());
                } else if !covered.contains(name) && cast.role(name).is_some() {
                    open.push(name.clone());
                }
            }
        }
        Mic::from_names(open)
    }

    /// The microphones the cue at `block_index` sets when it fires: computed for Auto-Mic
    /// cues, the stored `mic` field otherwise.
    pub fn mic_for_cue(&self, block_index: usize, cast: &Cast) -> Mic {
        match self.blocks.get(block_index) {
            Some(Block::Cue(cue)) if cue.auto_mic() => self.auto_mic(block_index, cast),
            Some(Block::Cue(cue)) => cue.mic(),
            _ => Mic::Unchanged,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOW: &str = "\
```yaml
config:
    roles:
        Anna: {color: blue, ch: 3}
        Ben: {color: green, ch: 5}
        Clara: {color: red}
    groups:
        Duo:
            color: purple
            roles: [Anna, Ben, Gone]
```

```yaml
auto_mic: true
```

**Anna**
Hello.

**Ben**

**Stranger**
Who am I?

```yaml
mic: [Duo, Clara]
```

**Clara/Anna**
Both of us.

```yaml
auto_mic: true
```

**Duo**
Together.

**Anna**
Me again.

**Clara**
And me.

```yaml
auto_mic: true
```

**Ben**
Too late.

```yaml
mic: muteall
```
";

    fn open(names: &[&str]) -> Mic {
        Mic::Open(names.iter().map(|n| n.to_string()).collect())
    }

    fn cue_blocks(script: &Script) -> Vec<usize> {
        (0..script.blocks.len()).filter(|&i| matches!(script.blocks[i], Block::Cue(_))).collect()
    }

    #[test]
    fn reads_roles_and_groups() {
        let script = Script::parse(SHOW);
        let cast = Cast::from_script(&script, false);
        assert_eq!(cast.roles.len(), 3);
        assert_eq!(cast.role("Anna"), Some(&Role { name: "Anna".into(), color: Some("blue".into()), channel: Some(3) }));
        assert_eq!(cast.role("Clara").unwrap().channel, None);
        assert_eq!(cast.group_roles("Duo"), ["Anna", "Ben", "Gone"]);
        assert_eq!(cast.group_roles("Alle"), ["Anna", "Ben", "Clara"]);
        assert!(cast.is_group("Alle") && !cast.is_group("All") && !cast.is_group("Anna"));
        assert!(Cast::from_script(&script, true).is_group("All"));
    }

    #[test]
    fn auto_mic_opens_roles_with_dialogue_until_the_next_auto_mic_cue() {
        let script = Script::parse(SHOW);
        let cast = Cast::from_script(&script, false);
        let cues = cue_blocks(&script);
        assert!(script.has_auto_mic());

        // Ben has no dialogue, Stranger is not a role; the manual cue in between is skipped
        // over, so Clara (speaking after it) still counts.
        assert_eq!(script.mic_for_cue(cues[0], &cast), open(&["Anna", "Clara"]));
        // A group stays a group and covers its members; Clara is added individually.
        assert_eq!(script.mic_for_cue(cues[2], &cast), open(&["Duo", "Clara"]));
        // The last Auto-Mic cue mutes everything, whatever follows.
        assert_eq!(script.mic_for_cue(cues[3], &cast), Mic::MuteAll);
    }

    #[test]
    fn manual_cues_use_the_stored_field() {
        let script = Script::parse(SHOW);
        let cast = Cast::from_script(&script, false);
        let cues = cue_blocks(&script);
        assert_eq!(script.mic_for_cue(cues[1], &cast), open(&["Duo", "Clara"]));
        assert_eq!(script.mic_for_cue(cues[4], &cast), Mic::MuteAll);
        assert_eq!(script.mic_for_cue(0, &cast), Mic::Unchanged, "the config block is not a cue");
        assert!(!Script::parse("```yaml\nmic: Anna\n```\n").has_auto_mic());
    }

    #[test]
    fn expands_groups_for_routing() {
        let cast = Cast::from_script(&Script::parse(SHOW), false);
        assert_eq!(cast.expand(&open(&["Duo", "Clara", "Anna"])), open(&["Anna", "Ben", "Gone", "Clara"]));
        assert_eq!(cast.expand(&open(&["Alle"])), open(&["Anna", "Ben", "Clara"]));
        assert_eq!(cast.expand(&Mic::MuteAll), Mic::MuteAll);
        assert_eq!(cast.expand(&Mic::Unchanged), Mic::Unchanged);
    }

    #[test]
    fn builds_display_chips() {
        let cast = Cast::from_script(&Script::parse(SHOW), false);
        let mic = open(&["Duo", "Anna", "Clara"]);
        let role = |name: &str, color: &str| MicChip::Role { name: name.into(), color: Some(color.into()) };

        assert_eq!(
            cast.chips(&mic, true),
            [
                MicChip::Group {
                    name: "Duo".into(),
                    color: Some("purple".into()),
                    // "Gone" is no longer a role and is left out.
                    members: vec![("Anna".into(), Some("blue".into())), ("Ben".into(), Some("green".into()))],
                },
                role("Anna", "blue"),
                role("Clara", "red"),
            ]
        );
        assert_eq!(cast.chips(&mic, false), [role("Anna", "blue"), role("Ben", "green"), role("Clara", "red")]);
        assert!(cast.chips(&Mic::MuteAll, true).is_empty());
    }
}
