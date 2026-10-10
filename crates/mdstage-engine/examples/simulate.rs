//! Run a show file through the engine without a soundcard: press Go for every cue, let
//! simulated time pass, then Back all the way. Nothing is played or sent; the show file
//! and its audio are only read.
//!
//!     cargo run --release -p mdstage-engine --example simulate -- SHOW.md [SECONDS_PER_GO]
//!
//! Reports what fired, what would be sent, and any audio that could not be loaded.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use mdstage_core::Script;
use mdstage_core::cues::Cues;
use mdstage_core::effects::Effect;
use mdstage_engine::mixer::Mixer;
use mdstage_engine::player::{ClipCache, Player, Routing};
use mdstage_engine::show::Show;

const SAMPLE_RATE: u32 = 48_000;
const BLOCK: usize = 480; // 10 ms
const CHANNELS: usize = 8;

/// The mixer rendered into a scratch buffer, standing in for the soundcard.
struct Sim {
    mixer: Mixer,
    buf: Vec<f32>,
    frames: u64,
    peak: f32,
}

impl Sim {
    /// Let simulated time pass: render audio and tick the show every block.
    fn pass_time(&mut self, show: &mut Show, seconds: f64, effects: &mut BTreeMap<&'static str, usize>) -> Result<(), mdstage_engine::Error> {
        for _ in 0..(seconds * SAMPLE_RATE as f64 / BLOCK as f64) as usize {
            self.mixer.render(&mut self.buf, CHANNELS);
            self.peak = self.buf.iter().fold(self.peak, |p, s| p.max(s.abs()));
            self.frames += BLOCK as u64;
            show.tick(self.frames as f64 / SAMPLE_RATE as f64)?;
            for effect in show.take_effects() {
                let kind = match effect {
                    Effect::Mic(_) => "mic changes",
                    Effect::TriggerNote(_) => "trigger notes",
                    Effect::TriggerOsc { .. } => "trigger OSC",
                    Effect::Midi { .. } => "MIDI messages",
                    Effect::Osc { .. } => "OSC messages",
                    Effect::Http { .. } => "HTTP requests",
                    Effect::Announce { .. } => "announcements",
                    Effect::Display { .. } => "display updates",
                };
                *effects.entry(kind).or_default() += 1;
            }
        }
        Ok(())
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().ok_or("usage: simulate SHOW.md [SECONDS_PER_GO]")?);
    let seconds_per_go: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2.0);

    let script = Script::parse(&std::fs::read_to_string(&path)?);
    let audio_dir = path.parent().unwrap_or(std::path::Path::new(".")).join("audio");
    let (mixer, handle) = Mixer::new();
    let player = Player::new(handle, ClipCache::new(audio_dir, SAMPLE_RATE), Routing::positional(&script.virtual_channels()));
    let mut show = Show::new(script, player, None, false);
    let total = Cues::new(show.script()).len();

    let mut sim = Sim { mixer, buf: vec![0.0f32; BLOCK * CHANNELS], frames: 0, peak: 0.0 };
    let mut effects: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut failures = Vec::new();
    let started = Instant::now();

    let mut presses = 0;
    while let Some(next) = show.next() {
        presses += 1;
        if let Err(e) = show.go() {
            failures.push(format!("cue #{}: {e}", next + 1));
            // The cue could not start its audio; step over it so the run continues.
            let after = Cues::new(show.script()).group(next).end;
            show.arm(Some(after).filter(|&c| c < total));
            if show.next() == Some(next) || presses > total * 4 {
                break;
            }
        }
        sim.pass_time(&mut show, seconds_per_go, &mut effects)?;
        // Like an operator, wait for a queued outro to come in before the next Go.
        let mut waited = 0.0;
        while !show.pending_outros().is_empty() && waited < 600.0 {
            sim.pass_time(&mut show, 1.0, &mut effects)?;
            waited += 1.0;
        }
        if presses > total * 4 {
            failures.push("gave up: Go did not advance".into());
            break;
        }
    }
    let fired: Vec<usize> = show.history().cues().map(|c| c + 1).collect();
    println!("{}", path.display());
    println!("  {total} cues; {presses} Go presses; {} cue firings in the history", fired.len());
    println!("  order: {fired:?}");
    println!("  would send: {effects:?}");
    println!("  loudest sample: {:.3}", sim.peak);
    if let Some(tc) = show.timecode_seconds() {
        println!("  timecode running at the end: {tc:.2} s");
    }

    let mut backs = 0;
    while !show.history().is_empty() && backs < total * 4 {
        show.back()?;
        backs += 1;
        sim.pass_time(&mut show, 0.6, &mut effects)?;
    }
    println!("  Back ×{backs} returned to the start: {}", show.history().is_empty());
    sim.pass_time(&mut show, 1.0, &mut effects)?;
    let silent = {
        sim.mixer.render(&mut sim.buf, CHANNELS);
        sim.buf.iter().all(|&s| s == 0.0)
    };
    println!("  silent afterwards: {silent}");
    println!("  simulated {:.0} s of show in {:.1?}", sim.frames as f64 / SAMPLE_RATE as f64, started.elapsed());
    if failures.is_empty() {
        println!("  all audio loaded");
    }
    for failure in failures {
        println!("  FAILED {failure}");
    }
    Ok(())
}
