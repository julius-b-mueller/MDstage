//! Start a real session for a show without an audio device and report how much decoded
//! audio it holds as the show advances. Reads the show and its audio; sends nothing.
//!
//!     cargo run --release -p mdstage-engine --example session_probe -- SHOW.md

use std::path::PathBuf;
use std::time::{Duration, Instant};

use mdstage_core::Script;
use mdstage_engine::session::{Request, Session, Snapshot};
use mdstage_engine::settings::Settings;

fn settle(session: &Session) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(60);
    std::thread::sleep(Duration::from_millis(60));
    loop {
        let snapshot = session.snapshot();
        // The display address appears once the session thread is up and running.
        if (snapshot.display_address.is_some() && snapshot.loading.is_none()) || Instant::now() > deadline {
            return snapshot;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(std::env::args().nth(1).ok_or("usage: session_probe SHOW.md")?);
    let script = Script::parse(&std::fs::read_to_string(&path)?);
    let settings = Settings {
        audio_device: Some("(none: probe)".into()),
        display_port: 0,
        outputs_blocked: true,
        ..Settings::default()
    };
    let started = Instant::now();
    let session = Session::start(script, path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf(), settings, false)?;
    let first = settle(&session);
    println!("ready after {:.1?}: {:.0} MB of decoded audio held", started.elapsed(), first.audio_memory_mb);
    let mut peak = first.audio_memory_mb;
    let mut presses = 0;
    while let Some(next) = session.snapshot().next {
        session.send(Request::Go);
        presses += 1;
        let snapshot = settle(&session);
        peak = peak.max(snapshot.audio_memory_mb);
        if presses % 8 == 0 || snapshot.next.is_none() {
            println!("after cue {:>2}: {:>4.0} MB held", next + 1, snapshot.audio_memory_mb);
        }
        session.send(Request::StopAll);
        if presses > 500 {
            break;
        }
    }
    let last = session.snapshot();
    println!("{presses} Go presses; peak {peak:.0} MB; problems: {:?}", last.problems.iter().filter(|p| !p.starts_with("Audio: ")).collect::<Vec<_>>());
    Ok(())
}
