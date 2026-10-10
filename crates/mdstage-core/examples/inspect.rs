//! Check show files against the parser without modifying them.
//!
//!     cargo run -p mdstage-core --example inspect -- SHOW.md [MORE.md …]
//!
//! Prints block counts, unreadable YAML, and whether reading and writing the file back
//! reproduces it exactly (with the first differing line if not).

use std::collections::BTreeMap;

use mdstage_core::cues::{Cues, History, Slf};
use mdstage_core::mic::{Cast, Mic};
use mdstage_core::{Block, Script, format, yaml};

fn main() {
    for path in std::env::args().skip(1) {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                println!("{path}: {e}");
                continue;
            }
        };
        let script = Script::parse(&text);
        let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
        let mut invalid = Vec::new();
        for (i, block) in script.blocks.iter().enumerate() {
            let kind = match block {
                Block::Config(_) => "config",
                Block::Heading { .. } => "heading",
                Block::Stage(_) => "stage",
                Block::Role { .. } => "role",
                Block::Cue(cue) => {
                    if cue.invalid {
                        invalid.push(i);
                    }
                    "cue"
                }
                Block::Text(_) => "text",
            };
            *kinds.entry(kind).or_default() += 1;
        }
        println!("{path}");
        println!("  blocks: {kinds:?}");
        println!("  cues with unreadable YAML: {}", invalid.len());

        let cast = Cast::from_script(&script, false);
        println!("  roles: {}, groups: {}", cast.roles.len(), cast.groups.len());
        for (i, block) in script.blocks.iter().enumerate() {
            if matches!(block, Block::Cue(c) if c.auto_mic()) {
                let mic = match script.auto_mic(i, &cast) {
                    Mic::Open(names) => names.join(", "),
                    Mic::MuteAll => "(mute all)".into(),
                    Mic::Unchanged => "(nobody speaks)".into(),
                };
                println!("  auto-mic cue at block {i}: {mic}");
            }
        }

        let cues = Cues::new(&script);
        let label = |i: usize| match cues.get(i).and_then(|c| c.note()) {
            Some(note) => format!("#{} ({note})", i + 1),
            None => format!("#{}", i + 1),
        };
        let mut dangling = Vec::new();
        for i in 0..cues.len() {
            let cue = cues.get(i).unwrap();
            let links = [
                ("chain_end", cue.chain_end()),
                ("loop_outro", cue.loop_outro()),
                ("auto_trigger", cue.auto_trigger().map(|a| a.source)),
                ("adjust", cue.adjust().map(|a| a.target)),
            ];
            for (field, note) in links {
                if let Some(note) = note.filter(|n| cues.find(*n).is_none()) {
                    dangling.push(format!("{} {field} → {note}", label(i)));
                }
            }
            match cues.slf(i) {
                Some(Slf::Start { next }) => println!("  {} Start → {next}", label(i)),
                Some(Slf::Loop { outro }) => println!("  {} Loop ↩ {outro}", label(i)),
                Some(Slf::Finish { from }) => println!("  {} Finish ← {:?}", label(i), from.iter().map(|&f| label(f)).collect::<Vec<_>>()),
                Some(Slf::Bridge { from, next }) => {
                    println!("  {} Bridge ← {:?} → {next}", label(i), from.iter().map(|&f| label(f)).collect::<Vec<_>>())
                }
                None => {}
            }
            if let Some(auto) = cue.auto_trigger() {
                println!("  {} fires automatically: {:?} of {}", label(i), auto.when, auto.source);
            }
            if cues.group(i).start == i && cues.group(i).len() > 1 {
                println!("  {} has {} variant(s)", label(i), cues.group(i).len() - 1);
            }
        }
        println!("  links to cues that do not exist: {}", if dangling.is_empty() { "none".into() } else { dangling.join("; ") });

        // Press Go until the show ends; then Back all the way.
        let mut history = History::default();
        let mut order = Vec::new();
        while let Some(cue) = history.go(&cues, None, None) {
            history.push(cue, false);
            order.push(cue + 1);
        }
        let devices: Vec<String> = history.device_states(&cues).keys().map(|(kind, name)| format!("{kind:?}:{name}")).collect();
        println!("  Go from top to bottom fires {} of {} cues", order.len(), cues.len());
        println!("  final mic state: {:?}", history.mic(&cues, &cast));
        println!("  devices addressed: {devices:?}");
        let mut backs = 0;
        while history.back(&cues).is_some() {
            backs += 1;
        }
        println!("  Back {backs} times returns to the start: {}", history.is_empty());

        // Plain-text blocks the parser could not classify are worth a look.
        let unclassified: Vec<&str> = script
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Text(t) => t.lines().next(),
                _ => None,
            })
            .collect();
        println!("  plain text blocks: {}", unclassified.len());
        for line in unclassified.iter().take(8) {
            println!("    {}", line.chars().take(70).collect::<String>());
        }

        // Would rewriting each YAML block change how it looks in the file?
        let mut restyled = Vec::new();
        for block in &script.blocks {
            let (source, written) = match block {
                Block::Config(c) => (&c.source, yaml::dump(&c.yaml, false)),
                Block::Cue(c) if !c.invalid => (&c.source, yaml::dump(&c.yaml, true)),
                _ => continue,
            };
            if &written != source {
                let line = source.lines().zip(written.lines()).find(|(a, b)| a != b);
                restyled.push(line.map(|(a, b)| format!("{a:?} → {b:?}")).unwrap_or_else(|| "length differs".into()));
            }
        }
        println!("  YAML blocks our writer would lay out differently: {}", restyled.len());
        for diff in restyled.iter().take(6) {
            println!("    {diff}");
        }

        println!("  needs formatting: {}", format::needs_formatting(&text));
        let removals = script.cleanup_preview();
        println!("  cleanup would remove {} key(s)", removals.len());
        for r in removals.iter().take(8) {
            println!("    block {}: {}", r.block, r.key);
        }
        let mut with_notes = script.clone();
        println!("  cues still needing a trigger note: {}", with_notes.assign_trigger_notes());

        let written = script.to_markdown();
        if written == text {
            println!("  round trip: identical");
        } else {
            let line = text.lines().zip(written.lines()).position(|(a, b)| a != b);
            println!("  round trip: DIFFERS ({} → {} bytes)", text.len(), written.len());
            match line {
                Some(n) => {
                    println!("    first difference at line {}:", n + 1);
                    println!("      file:    {:?}", text.lines().nth(n).unwrap_or_default());
                    println!("      written: {:?}", written.lines().nth(n).unwrap_or_default());
                }
                None => println!("    same lines, different length or line endings"),
            }
        }
    }
}
