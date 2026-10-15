//! Timecode out: MIDI timecode (MTC) and Art-Net timecode, each device at its own frame
//! rate (24, 25, 29.97 drop-frame or 30 fps).
//!
//! The show counts timecode in seconds. `start_tc` in the show file is read at the show's
//! frame rate (kept on this computer, not in the file; 25 fps unless set). Each device
//! gets the position at its own rate, by default the show's.
//!
//! `MtcGenerator` is pure: given a timecode position it returns the messages that are due.
//! `TimecodeSender` runs the generators on their own thread against a position source
//! (normally the audio clock), so quarter frames are paced by the samples actually played
//! rather than a UI timer.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Frames a second of `Timecode::from_frames`/`to_frames` (25).
pub const FPS: u64 = 25;
#[cfg(test)]
const RATE_25: u8 = 0b01;

/// The frame rate a device gets timecode at.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FrameRate {
    #[serde(rename = "24")]
    Fps24,
    #[default]
    #[serde(rename = "25")]
    Fps25,
    /// 29.97 frames a second, drop-frame: the labels skip frames 0 and 1 every minute
    /// except every tenth, so that they keep up with the clock.
    #[serde(rename = "29.97df")]
    Fps2997Drop,
    #[serde(rename = "30")]
    Fps30,
}

impl FrameRate {
    pub const ALL: [FrameRate; 4] = [FrameRate::Fps24, FrameRate::Fps25, FrameRate::Fps2997Drop, FrameRate::Fps30];

    pub fn label(self) -> &'static str {
        match self {
            FrameRate::Fps24 => "24 fps",
            FrameRate::Fps25 => "25 fps",
            FrameRate::Fps2997Drop => "29.97 fps drop",
            FrameRate::Fps30 => "30 fps",
        }
    }

    /// Frames a second as the labels count them.
    pub fn nominal(self) -> u64 {
        match self {
            FrameRate::Fps24 => 24,
            FrameRate::Fps25 => 25,
            FrameRate::Fps2997Drop | FrameRate::Fps30 => 30,
        }
    }

    /// Frames a second of real time.
    pub fn real(self) -> f64 {
        match self {
            FrameRate::Fps2997Drop => 30000.0 / 1001.0,
            rate => rate.nominal() as f64,
        }
    }

    /// The rate code of MTC (bits 5–6 of the hours) and of Art-Net (its `Type` byte).
    fn code(self) -> u8 {
        match self {
            FrameRate::Fps24 => 0,
            FrameRate::Fps25 => 1,
            FrameRate::Fps2997Drop => 2,
            FrameRate::Fps30 => 3,
        }
    }

    /// The label of frame number `n` (counted from 00:00:00:00 in real frames).
    pub fn timecode(self, n: u64) -> Timecode {
        let nominal = self.nominal();
        let n = match self {
            // Two labels dropped every minute but every tenth: 17982 frames in ten minutes.
            FrameRate::Fps2997Drop => {
                let (tens, rest) = (n / 17982, n % 17982);
                n + 18 * tens + if rest < 2 { 0 } else { 2 * ((rest - 2) / 1798) }
            }
            _ => n,
        };
        let secs = n / nominal;
        Timecode { hours: ((secs / 3600) % 24) as u8, minutes: ((secs / 60) % 60) as u8, seconds: (secs % 60) as u8, frames: (n % nominal) as u8 }
    }

    /// The number of the frame at `seconds`.
    pub fn frame_at(self, seconds: f64) -> u64 {
        (seconds.max(0.0) * self.real()).floor() as u64
    }

    /// The moment (seconds) a timecode stands for at this rate; `None` if it has more
    /// frames than a second holds here.
    pub fn seconds(self, tc: Timecode) -> Option<f64> {
        let nominal = self.nominal();
        if tc.frames as u64 >= nominal {
            return None;
        }
        let whole = tc.hours as u64 * 3600 + tc.minutes as u64 * 60 + tc.seconds as u64;
        let mut n = whole * nominal + tc.frames as u64;
        if self == FrameRate::Fps2997Drop {
            let minutes = tc.hours as u64 * 60 + tc.minutes as u64;
            n -= 2 * (minutes - minutes / 10);
        }
        Some(n as f64 / self.real())
    }

    /// A position (seconds) as the timecode shown at this rate; drop-frame with `;`
    /// before the frames.
    pub fn show(self, seconds: f64) -> String {
        let text = self.timecode(self.frame_at(seconds + 1e-9)).to_string();
        match self {
            FrameRate::Fps2997Drop => format!("{};{}", &text[..8], &text[9..]),
            _ => text,
        }
    }
}

/// Art-Net timecode (ArtTimeCode) for one frame.
pub fn artnet_packet(tc: Timecode, rate: FrameRate) -> [u8; 19] {
    let mut packet = [0u8; 19];
    packet[..8].copy_from_slice(b"Art-Net\0");
    // OpCode 0x9700, low byte first; protocol version 14.
    packet[8] = 0x00;
    packet[9] = 0x97;
    packet[11] = 14;
    packet[14] = tc.frames;
    packet[15] = tc.seconds;
    packet[16] = tc.minutes;
    packet[17] = tc.hours;
    packet[18] = rate.code();
    packet
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timecode {
    pub hours: u8,
    pub minutes: u8,
    pub seconds: u8,
    pub frames: u8,
}

impl Timecode {
    pub fn from_frames(total: u64) -> Self {
        let secs = total / FPS;
        Timecode {
            hours: ((secs / 3600) % 24) as u8,
            minutes: ((secs / 60) % 60) as u8,
            seconds: (secs % 60) as u8,
            frames: (total % FPS) as u8,
        }
    }

    pub fn to_frames(self) -> u64 {
        (self.hours as u64 * 3600 + self.minutes as u64 * 60 + self.seconds as u64) * FPS + self.frames as u64
    }

    /// Parse `HH:MM:SS:FF` (or `HH:MM:SS;FF`, drop-frame), with up to 29 frames: whether
    /// the frames fit a second is the frame rate's business ([`FrameRate::seconds`]).
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.trim().split([':', ';']).map(|p| p.parse::<u8>().ok());
        let tc = Timecode {
            hours: parts.next()??,
            minutes: parts.next()??,
            seconds: parts.next()??,
            frames: parts.next()??,
        };
        let valid = parts.next().is_none()
            && tc.hours < 24
            && tc.minutes < 60
            && tc.seconds < 60
            && tc.frames < 30;
        valid.then_some(tc)
    }

    /// Full-frame SysEx: tells receivers to jump to this position.
    pub fn full_frame(self, rate: FrameRate) -> [u8; 10] {
        [0xF0, 0x7F, 0x7F, 0x01, 0x01, (rate.code() << 5) | self.hours, self.minutes, self.seconds, self.frames, 0xF7]
    }

    /// Quarter-frame message carrying piece `piece` (0–7) of this timecode.
    pub fn quarter_frame(self, piece: u8, rate: FrameRate) -> [u8; 2] {
        let nibble = match piece & 7 {
            0 => self.frames & 0x0F,
            1 => self.frames >> 4,
            2 => self.seconds & 0x0F,
            3 => self.seconds >> 4,
            4 => self.minutes & 0x0F,
            5 => self.minutes >> 4,
            6 => self.hours & 0x0F,
            _ => (self.hours >> 4) | (rate.code() << 1),
        };
        [0xF1, ((piece & 7) << 4) | nibble]
    }
}

impl std::fmt::Display for Timecode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:02}:{:02}:{:02}:{:02}", self.hours, self.minutes, self.seconds, self.frames)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MtcMessage {
    FullFrame([u8; 10]),
    QuarterFrame([u8; 2]),
}

impl MtcMessage {
    pub fn bytes(&self) -> &[u8] {
        match self {
            MtcMessage::FullFrame(b) => b,
            MtcMessage::QuarterFrame(b) => b,
        }
    }
}

/// Turns a moving timecode position into the MTC messages that are due.
///
/// Quarter frames are numbered continuously (4 per frame); number `q` carries piece
/// `q % 8`, and the timecode is latched at piece 0 so all eight pieces describe one frame.
/// A jump (scrub, loop restart, new cue) is answered with a full-frame message.
#[derive(Default)]
pub struct MtcGenerator {
    rate: FrameRate,
    /// Last quarter frame sent; `None` while stopped.
    last_qf: Option<u64>,
    latched: Option<Timecode>,
}

impl MtcGenerator {
    /// Largest forward gap that is still filled with quarter frames instead of a relocate.
    const MAX_CATCH_UP: u64 = 8;

    pub fn new(rate: FrameRate) -> Self {
        MtcGenerator { rate, ..Default::default() }
    }

    fn quarter_frames_per_second(&self) -> f64 {
        self.rate.real() * 4.0
    }

    pub fn stop(&mut self) {
        self.last_qf = None;
        self.latched = None;
    }

    /// Append the messages due at `seconds` (timecode position) to `out`.
    pub fn poll(&mut self, seconds: f64, out: &mut Vec<MtcMessage>) {
        let rate = self.rate;
        let qf = (seconds.max(0.0) * self.quarter_frames_per_second()).floor() as u64;
        let continuous = self.last_qf.is_some_and(|last| qf >= last && qf - last <= Self::MAX_CATCH_UP);
        if !continuous {
            out.push(MtcMessage::FullFrame(rate.timecode(qf / 4).full_frame(rate)));
            // Wait for the next piece 0 so receivers never see a partial timecode.
            self.last_qf = Some(qf);
            self.latched = None;
            return;
        }
        let last = self.last_qf.unwrap_or(qf);
        for q in last + 1..=qf {
            let piece = (q % 8) as u8;
            if piece == 0 {
                self.latched = Some(rate.timecode(q / 4));
            }
            if let Some(tc) = self.latched {
                out.push(MtcMessage::QuarterFrame(tc.quarter_frame(piece, rate)));
            }
        }
        self.last_qf = Some(qf);
    }

    /// Seconds (timecode position) at which the next quarter frame becomes due.
    pub fn next_due(&self) -> Option<f64> {
        self.last_qf.map(|q| (q + 1) as f64 / self.quarter_frames_per_second())
    }
}

/// A device that gets timecode, and at which rate.
#[derive(Clone, Debug, PartialEq)]
pub enum TimecodeTarget {
    /// MTC on this MIDI output port.
    Midi { port: String, rate: FrameRate },
    /// Art-Net timecode to this address (a device or a broadcast address).
    Artnet { host: String, port: u16, rate: FrameRate },
}

/// What is to be sent next to one target.
enum TargetState {
    Midi(MtcGenerator),
    /// The last frame sent.
    Artnet(Option<u64>),
}

impl TargetState {
    fn of(target: &TimecodeTarget) -> TargetState {
        match target {
            TimecodeTarget::Midi { rate, .. } => TargetState::Midi(MtcGenerator::new(*rate)),
            TimecodeTarget::Artnet { .. } => TargetState::Artnet(None),
        }
    }
}

/// Sends timecode on a background thread. `position` returns the current timecode
/// position in seconds, or `None` while timecode is stopped. `targets` says where it goes
/// (it may change while the thread runs). `send` delivers the bytes for one target: MIDI
/// bytes for an MTC target, a UDP packet for an Art-Net target.
pub struct TimecodeSender {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TimecodeSender {
    pub fn spawn(
        position: impl Fn() -> Option<f64> + Send + 'static,
        targets: Arc<std::sync::Mutex<Vec<TimecodeTarget>>>,
        mut send: impl FnMut(&TimecodeTarget, &[u8]) + Send + 'static,
    ) -> std::io::Result<Self> {
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let thread = thread::Builder::new().name("mdstage-timecode".into()).spawn(move || {
            // Best effort: without it the thread still works, just with more jitter.
            let _ = thread_priority::set_current_thread_priority(thread_priority::ThreadPriority::Max);
            let mut current: Vec<(TimecodeTarget, TargetState)> = Vec::new();
            let mut due = Vec::with_capacity(16);
            while flag.load(SeqCst) {
                let wanted = targets.lock().map(|t| t.clone()).unwrap_or_default();
                if wanted.len() != current.len() || wanted.iter().zip(&current).any(|(a, (b, _))| a != b) {
                    current = wanted.into_iter().map(|target| {
                        let state = TargetState::of(&target);
                        (target, state)
                    }).collect();
                }
                let Some(now) = position().filter(|_| !current.is_empty()) else {
                    for (target, state) in &mut current {
                        *state = TargetState::of(target);
                    }
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let mut wait = 0.02f64;
                for (target, state) in &mut current {
                    match state {
                        TargetState::Midi(generator) => {
                            generator.poll(now, &mut due);
                            for message in due.drain(..) {
                                send(target, message.bytes());
                            }
                            wait = wait.min(generator.next_due().map_or(0.0, |t| t - now));
                        }
                        TargetState::Artnet(last) => {
                            let TimecodeTarget::Artnet { rate, .. } = *target else { continue };
                            let frame = rate.frame_at(now);
                            if *last != Some(frame) {
                                *last = Some(frame);
                                send(target, &artnet_packet(rate.timecode(frame), rate));
                            }
                            wait = wait.min((frame + 1) as f64 / rate.real() - now);
                        }
                    }
                }
                // Sleep most of the way to what is due next, then spin the last bit: OS
                // sleeps overshoot by far more than MTC tolerates.
                let wait = wait.clamp(0.0, 0.02);
                let deadline = Instant::now() + Duration::from_secs_f64(wait);
                let spin = Duration::from_micros(500);
                if wait > spin.as_secs_f64() {
                    thread::sleep(Duration::from_secs_f64(wait) - spin);
                }
                while Instant::now() < deadline {
                    std::hint::spin_loop();
                }
            }
        })?;
        Ok(TimecodeSender { running, thread: Some(thread) })
    }
}

impl Drop for TimecodeSender {
    fn drop(&mut self) {
        self.running.store(false, SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timecode_roundtrip_and_parse() {
        let tc = Timecode::parse("01:02:03:04").unwrap();
        assert_eq!(tc, Timecode { hours: 1, minutes: 2, seconds: 3, frames: 4 });
        assert_eq!(tc.to_frames(), (3600 + 120 + 3) * 25 + 4);
        assert_eq!(Timecode::from_frames(tc.to_frames()), tc);
        assert_eq!(tc.to_string(), "01:02:03:04");
        assert_eq!(Timecode::parse("01:02:03;29"), Some(Timecode { hours: 1, minutes: 2, seconds: 3, frames: 29 }));
        for bad in ["", "01:02:03", "01:02:03:30", "24:00:00:00", "01:60:00:00", "a:b:c:d", "01:02:03:04:05"] {
            assert_eq!(Timecode::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn full_frame_bytes() {
        let tc = Timecode::parse("01:00:00:00").unwrap();
        assert_eq!(tc.full_frame(FrameRate::Fps25), [0xF0, 0x7F, 0x7F, 0x01, 0x01, 0x21, 0x00, 0x00, 0x00, 0xF7]);
    }

    #[test]
    fn quarter_frame_pieces() {
        let tc = Timecode { hours: 17, minutes: 42, seconds: 53, frames: 24 };
        let pieces: Vec<u8> = (0..8).map(|p| tc.quarter_frame(p, FrameRate::Fps25)[1]).collect();
        // frames 24 = 0x18, seconds 53 = 0x35, minutes 42 = 0x2A, hours 17 = 0x11, rate 25 fps.
        assert_eq!(pieces, [0x08, 0x11, 0x25, 0x33, 0x4A, 0x52, 0x61, 0x73]);
    }

    /// Reassemble timecodes from a quarter-frame stream the way a receiver does.
    fn decode(messages: &[MtcMessage]) -> Vec<Timecode> {
        let mut nibbles = [0u8; 8];
        let mut seen = 0;
        let mut out = Vec::new();
        for m in messages {
            let MtcMessage::QuarterFrame([_, data]) = m else {
                seen = 0;
                continue;
            };
            let piece = (data >> 4) as usize;
            assert_eq!(piece, seen, "pieces must arrive in order starting at 0");
            nibbles[piece] = data & 0x0F;
            seen += 1;
            if seen == 8 {
                seen = 0;
                assert_eq!(nibbles[7] >> 1, RATE_25);
                out.push(Timecode {
                    frames: nibbles[0] | nibbles[1] << 4,
                    seconds: nibbles[2] | nibbles[3] << 4,
                    minutes: nibbles[4] | nibbles[5] << 4,
                    hours: nibbles[6] | (nibbles[7] & 1) << 4,
                });
            }
        }
        out
    }

    #[test]
    fn steady_playback_sends_100_quarter_frames_per_second() {
        let start = Timecode::parse("01:00:00:00").unwrap().to_frames() as f64 / FPS as f64;
        let mut generator = MtcGenerator::new(FrameRate::Fps25);
        let mut out = Vec::new();
        // Poll at an awkward interval, as a real thread would.
        let mut t = 0.0;
        while t <= 2.0 {
            generator.poll(start + t, &mut out);
            t += 0.0037;
        }
        assert!(matches!(out[0], MtcMessage::FullFrame(_)));
        // 2 s = 200 quarter frames, minus the 8 skipped while waiting for the first piece 0.
        let quarter_frames = out.iter().filter(|m| matches!(m, MtcMessage::QuarterFrame(_))).count();
        assert!((190..=193).contains(&quarter_frames), "{quarter_frames}");

        let decoded = decode(&out);
        assert_eq!(decoded[0], Timecode::parse("01:00:00:02").unwrap());
        for pair in decoded.windows(2) {
            assert_eq!(pair[1].to_frames(), pair[0].to_frames() + 2, "one full timecode every 2 frames");
        }
    }

    #[test]
    fn every_rate_counts_its_own_frames() {
        let hour = 3600.0;
        for rate in FrameRate::ALL {
            assert_eq!(rate.timecode(rate.frame_at(hour)).to_string(), "01:00:00:00", "{rate:?}");
        }
        // Drop-frame: after 00:00:59;29 comes 00:01:00;02, but not at a tenth minute.
        let df = FrameRate::Fps2997Drop;
        assert_eq!(df.timecode(1799).to_string(), "00:00:59:29");
        assert_eq!(df.timecode(1800).to_string(), "00:01:00:02");
        assert_eq!(df.timecode(17982).to_string(), "00:10:00:00");
        assert_eq!(FrameRate::Fps30.timecode(29).to_string(), "00:00:00:29");
        assert_eq!(FrameRate::Fps24.timecode(24).to_string(), "00:00:01:00");

        // A timecode is the moment it stands for at the rate, and back.
        for rate in FrameRate::ALL {
            for text in ["00:00:00:00", "01:00:00:00", "00:01:00:02", "00:09:59:23", "10:23:45:12"] {
                let tc = Timecode::parse(text).unwrap();
                let seconds = rate.seconds(tc).unwrap();
                assert_eq!(rate.timecode(rate.frame_at(seconds + 1e-9)), tc, "{rate:?} {text}");
            }
        }
        assert_eq!(FrameRate::Fps25.seconds(Timecode::parse("00:00:01:12").unwrap()), Some(1.48));
        assert_eq!(FrameRate::Fps25.seconds(Timecode::parse("00:00:01:27").unwrap()), None, "no 27th frame at 25 fps");
        assert_eq!(FrameRate::Fps2997Drop.show(3600.0), "01:00:00;00");
        assert_eq!(FrameRate::Fps24.show(1.5), "00:00:01:12");

        // The rate goes into MTC (hours byte) and Art-Net (type byte).
        let tc = Timecode::parse("01:02:03:04").unwrap();
        assert_eq!(tc.full_frame(FrameRate::Fps30)[5], 0b0110_0001);
        assert_eq!(tc.quarter_frame(7, FrameRate::Fps24)[1], 0x70);
        let packet = artnet_packet(tc, FrameRate::Fps2997Drop);
        assert_eq!(&packet[..12], b"Art-Net\0\x00\x97\x00\x0e");
        assert_eq!(packet[14..], [4, 3, 2, 1, 2]);
    }

    #[test]
    fn a_30_fps_generator_sends_120_quarter_frames_per_second() {
        let mut generator = MtcGenerator::new(FrameRate::Fps30);
        let mut out = Vec::new();
        let mut t = 0.0;
        while t <= 1.0 {
            generator.poll(100.0 + t, &mut out);
            t += 0.001;
        }
        let quarter_frames = out.iter().filter(|m| matches!(m, MtcMessage::QuarterFrame(_))).count();
        // 1 s = 120 quarter frames, minus the 8 skipped while waiting for the first piece 0.
        assert!((110..=113).contains(&quarter_frames), "{quarter_frames}");
    }

    #[test]
    fn art_net_timecode_arrives_once_a_frame() {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = receiver.local_addr().unwrap().port();
        let targets = Arc::new(std::sync::Mutex::new(vec![TimecodeTarget::Artnet { host: "127.0.0.1".into(), port, rate: FrameRate::Fps30 }]));
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let started = Instant::now();
        let sender = TimecodeSender::spawn(
            move || Some(3600.0 + started.elapsed().as_secs_f64()),
            targets,
            move |target, bytes| {
                if let TimecodeTarget::Artnet { host, port, .. } = target {
                    socket.send_to(bytes, (host.as_str(), *port)).unwrap();
                }
            },
        )
        .unwrap();
        let mut packet = [0u8; 64];
        let mut frames = Vec::new();
        while frames.len() < 5 {
            let len = receiver.recv(&mut packet).unwrap();
            assert_eq!(len, 19);
            assert_eq!(&packet[..10], b"Art-Net\0\x00\x97");
            assert_eq!((packet[17], packet[16], packet[18]), (1, 0, 3), "01:00 at 30 fps");
            frames.push(packet[15] as u32 * 30 + packet[14] as u32);
        }
        drop(sender);
        for pair in frames.windows(2) {
            assert!(pair[1] > pair[0], "{frames:?}");
        }
    }

    #[test]
    fn jumps_send_a_full_frame() {
        let mut generator = MtcGenerator::new(FrameRate::Fps25);
        let mut out = Vec::new();
        generator.poll(10.0, &mut out);
        generator.poll(10.05, &mut out);
        out.clear();

        generator.poll(60.0, &mut out); // forward jump
        assert_eq!(out, [MtcMessage::FullFrame(Timecode::from_frames(60 * 25).full_frame(FrameRate::Fps25))]);
        out.clear();
        generator.poll(5.0, &mut out); // backward jump (loop restart)
        assert_eq!(out, [MtcMessage::FullFrame(Timecode::from_frames(5 * 25).full_frame(FrameRate::Fps25))]);

        generator.stop();
        out.clear();
        generator.poll(5.01, &mut out);
        assert!(matches!(out[..], [MtcMessage::FullFrame(_)]), "restart after stop relocates");
    }
}
