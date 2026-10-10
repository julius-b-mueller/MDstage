//! Check streaming against decoding whole files, on real audio: every page of every file
//! in a folder, read in an order that forces seeks and restarts, must equal the same
//! stretch of the file decoded in one go.
//!
//!     cargo run --release -p mdstage-engine --example stream_probe -- AUDIO_DIR [RATE]

use std::path::PathBuf;
use std::time::Instant;

use mdstage_engine::clip::Clip;
use mdstage_engine::mixer::PAGE;
use mdstage_engine::stream::Reader;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().ok_or("usage: stream_probe AUDIO_DIR [RATE]")?);
    let rate: Option<u32> = args.next().and_then(|r| r.parse().ok());
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)?.filter_map(|e| Some(e.ok()?.path())).filter(|p| p.is_file()).collect();
    files.sort();
    let mut bad = 0;
    for path in files {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let started = Instant::now();
        let whole = match Clip::decode_file(&path) {
            Ok(clip) => clip,
            Err(e) => {
                println!("{name}: skipped ({e})");
                continue;
            }
        };
        let rate = rate.unwrap_or(whole.sample_rate());
        let whole = whole.resampled(rate)?;
        let decode = started.elapsed();

        let started = Instant::now();
        let mut reader = Reader::open(&path, rate)?;
        let open = started.elapsed();
        let info = reader.info();
        let pages = info.pages() as u32;
        // Backwards (a seek or a restart every time), a few jumps, then straight through.
        let order: Vec<u32> = (0..pages).rev().step_by(7).chain([pages / 2, 0, pages.saturating_sub(1), 1]).chain(0..pages).filter(|p| *p < pages).collect();
        let mut slowest = std::time::Duration::ZERO;
        let mut differ = info.frames != whole.frames() || info.channels != whole.channel_count();
        for index in order {
            let started = Instant::now();
            let page = reader.page(index)?;
            slowest = slowest.max(started.elapsed());
            let from = index as usize * PAGE;
            let to = (from + PAGE).min(whole.frames());
            differ |= (0..whole.channel_count().min(page.channel_count())).any(|c| page.channel(c) != &whole.channel(c)[from.min(to)..to]);
        }
        bad += differ as usize;
        println!(
            "{}  {name}: {:.1} s, {} ch — whole {decode:.0?}, open {open:.0?}, slowest page {slowest:.0?}",
            if differ { "DIFFERS" } else { "same   " },
            info.duration(),
            info.channels
        );
    }
    println!("{}", if bad == 0 { "all files stream exactly as they decode".to_string() } else { format!("{bad} files differ") });
    Ok(())
}
