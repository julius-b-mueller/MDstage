//! Audio spike: start → loop → finish on a real output device, with MTC from the audio clock.
//!
//!     cargo run --release -p mdstage-engine --example spike_audio -- [--audible] [AUDIO_DIR]
//!
//! Silent by default (gain 0) so it can run unattended; `--audible` plays at -12 dB.
//! On macOS/Linux the MTC goes to a virtual MIDI port that the spike reads back itself to
//! measure quarter-frame timing.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mdstage_engine::clip::Clip;
use mdstage_engine::clock::VoiceState;
use mdstage_engine::device;
use mdstage_engine::mixer::{AtTransition, Command, Mixer, Route, VoiceSpec};
use mdstage_engine::mtc::{MtcSender, Timecode};

/// Arrival time (µs) and bytes of each MIDI message read back from the virtual port.
type Received = Arc<Mutex<Vec<(u64, Vec<u8>)>>>;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut audible = false;
    let mut dir = PathBuf::from("website/preview/audio");
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--audible" => audible = true,
            other => dir = PathBuf::from(other),
        }
    }

    println!("Output devices:");
    for d in device::list_outputs()? {
        println!("  {} — up to {} channels, {} Hz", d.name, d.max_channels, d.default_sample_rate);
    }

    let (mixer, mut handle) = Mixer::new();
    let output = device::open(mixer, None, 8)?;
    println!("Opened \"{}\": {} channels at {} Hz", output.device_name, output.channels, output.sample_rate);

    let load = |file: &str| -> Result<Arc<Clip>, Box<dyn std::error::Error>> {
        let t = Instant::now();
        let clip = Clip::decode_file(&dir.join(file))?;
        let decoded = t.elapsed();
        let (rate, channels) = (clip.sample_rate(), clip.channel_count());
        let clip = clip.resampled(output.sample_rate)?;
        println!(
            "  {file}: {:.2} s, {channels} ch, {rate} Hz — decode {decoded:.0?}, total {:.0?}",
            clip.duration(),
            t.elapsed()
        );
        Ok(Arc::new(clip))
    };
    println!("Loading:");
    let start = load("Abendabschlusslied start.wav")?;
    let looped = load("Abendabschlusslied loop.wav")?;
    let finish = load("Abendabschlusslied finish.wav")?;

    // Stereo onto outputs 1/2, and also onto the last pair if the device has more.
    let gain = if audible { 0.25 } else { 0.0 };
    let routes = |clip: &Clip| -> Vec<Route> {
        let mut r = Vec::new();
        for src in 0..clip.channel_count().min(2) as u16 {
            r.push(Route { src, out: src, gain: 1.0 });
            if output.channels > 2 {
                r.push(Route { src, out: (output.channels - 2) as u16 + src, gain: 1.0 });
            }
        }
        r
    };
    let voice = |id, clip: &Arc<Clip>, from: usize, at, armed| {
        let spec = VoiceSpec {
            start: from,
            at_transition: at,
            gain,
            routes: routes(clip),
            armed,
            ..VoiceSpec::whole(id, clip.clone())
        };
        let shared = spec.shared.clone();
        (spec, shared)
    };
    // Only the last 3 s of the start clip, to keep the run short.
    let (start_spec, start_shared) =
        voice(1, &start, start.frames() - start.frame_at(3.0), AtTransition::Handoff(2), false);
    let (loop_spec, loop_shared) = voice(2, &looped, 0, AtTransition::Wrap, true);
    let (finish_spec, finish_shared) = voice(3, &finish, 0, AtTransition::Continue, true);

    let received: Received = Arc::default();
    let midi = open_midi_loopback(received.clone());
    let clock = output.clock.clone();
    let tc_start = Timecode::parse("01:00:00:00").unwrap().to_frames() as f64 / 25.0;
    let rate = output.sample_rate as f64;
    let first_frame = clock.frames() as f64;
    let _mtc = match midi {
        Some((mut out, _input)) => {
            let sender = MtcSender::spawn(
                move || Some(tc_start + (clock.frames_now() - first_frame) / rate),
                move |bytes| {
                    let _ = out.send(bytes);
                },
            )?;
            Some((sender, _input))
        }
        None => None,
    };

    for spec in [loop_spec, finish_spec, start_spec] {
        handle.send(Command::Add(spec)).map_err(|_| "command queue full")?;
    }

    println!("Playing{}:", if audible { "" } else { " (silent, pass --audible to hear it)" });
    let names = ["start", "loop", "finish"];
    let shared = [start_shared, loop_shared, finish_shared];
    let mut states = [VoiceState::Armed; 3];
    let mut loop_passes = 0;
    let mut last_loop_pos = 0;
    let mut outro_queued = false;
    let began = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(5));
        handle.collect_garbage();
        for i in 0..3 {
            let s = shared[i].state();
            if s != states[i] {
                println!("  {:7.3} s  {} → {s:?}", began.elapsed().as_secs_f64(), names[i]);
                states[i] = s;
            }
        }
        let pos = shared[1].clip_frame();
        if pos < last_loop_pos {
            loop_passes += 1;
            println!("  {:7.3} s  loop wrapped (pass {loop_passes})", began.elapsed().as_secs_f64());
        }
        last_loop_pos = pos;
        // Let the loop wrap once, then queue the outro for the next loop boundary.
        if loop_passes == 1 && !outro_queued {
            handle
                .send(Command::SetTransition { id: 2, at: AtTransition::Handoff(3) })
                .map_err(|_| "command queue full")?;
            outro_queued = true;
            println!("  {:7.3} s  outro queued", began.elapsed().as_secs_f64());
        }
        // Three seconds into the finish, fade everything out.
        if states[2] == VoiceState::Playing && shared[2].clip_frame() > finish.frame_at(3.0) as u64 {
            handle.send(Command::StopAll { frames: output.sample_rate / 2 }).map_err(|_| "command queue full")?;
            println!("  {:7.3} s  stop all (500 ms fade)", began.elapsed().as_secs_f64());
            break;
        }
        if began.elapsed() > Duration::from_secs(120) {
            return Err("timed out".into());
        }
    }
    std::thread::sleep(Duration::from_millis(700));
    println!("  {:7.3} s  finish is {:?}", began.elapsed().as_secs_f64(), shared[2].state());

    drop(_mtc);
    report_mtc(&received.lock().unwrap());
    Ok(())
}

#[cfg(unix)]
fn open_midi_loopback(received: Received) -> Option<(midir::MidiOutputConnection, midir::MidiInputConnection<()>)> {
    use midir::os::unix::VirtualOutput;
    let port_name = "MDstage MTC spike";
    let out = midir::MidiOutput::new("mdstage-spike").ok()?.create_virtual(port_name).ok()?;
    let mut input = midir::MidiInput::new("mdstage-spike-in").ok()?;
    input.ignore(midir::Ignore::None);
    let port = input.ports().into_iter().find(|p| input.port_name(p).is_ok_and(|n| n.contains(port_name)))?;
    let conn = input
        .connect(&port, "mtc-readback", move |stamp, bytes, _| received.lock().unwrap().push((stamp, bytes.to_vec())), ())
        .ok()?;
    println!("MTC → virtual MIDI port \"{port_name}\" (read back for measurement)");
    Some((out, conn))
}

#[cfg(not(unix))]
fn open_midi_loopback(_: Received) -> Option<(midir::MidiOutputConnection, midir::MidiInputConnection<()>)> {
    println!("MTC measurement skipped: no virtual MIDI ports on this platform");
    None
}

fn report_mtc(received: &[(u64, Vec<u8>)]) {
    let qf: Vec<(u64, u8)> = received.iter().filter(|(_, b)| b.len() == 2 && b[0] == 0xF1).map(|(t, b)| (*t, b[1])).collect();
    let full = received.iter().filter(|(_, b)| b.first() == Some(&0xF0)).count();
    println!("MTC: {} quarter frames, {full} full-frame message(s)", qf.len());
    if qf.len() < 16 {
        return;
    }
    let out_of_order = qf.windows(2).filter(|w| (w[1].1 >> 4) != ((w[0].1 >> 4) + 1) % 8).count();
    let gaps: Vec<f64> = qf.windows(2).map(|w| (w[1].0 - w[0].0) as f64 / 1000.0).collect();
    let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
    let sd = (gaps.iter().map(|g| (g - mean).powi(2)).sum::<f64>() / gaps.len() as f64).sqrt();
    let worst = gaps.iter().map(|g| (g - 10.0).abs()).fold(0.0, f64::max);
    let late = gaps.iter().filter(|g| (*g - 10.0).abs() > 1.0).count();
    println!("  interval: mean {mean:.3} ms (ideal 10.000), std dev {sd:.3} ms, worst deviation {worst:.3} ms");
    println!("  intervals off by more than 1 ms: {late} of {}; pieces out of order: {out_of_order}", gaps.len());
}
