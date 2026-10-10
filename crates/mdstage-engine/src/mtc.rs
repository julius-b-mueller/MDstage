//! MIDI timecode (MTC), 25 fps.
//!
//! `MtcGenerator` is pure: given a timecode position it returns the messages that are due.
//! `MtcSender` runs it on its own thread against a position source (normally the audio
//! clock), so quarter frames are paced by the samples actually played rather than a UI timer.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const FPS: u64 = 25;
/// MTC rate code for 25 fps (bits 5–6 of the hours byte).
const RATE_25: u8 = 0b01;
const QF_PER_SECOND: f64 = (FPS * 4) as f64;

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

    /// Parse `HH:MM:SS:FF`.
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.trim().split(':').map(|p| p.parse::<u8>().ok());
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
            && (tc.frames as u64) < FPS;
        valid.then_some(tc)
    }

    /// Full-frame SysEx: tells receivers to jump to this position.
    pub fn full_frame(self) -> [u8; 10] {
        [0xF0, 0x7F, 0x7F, 0x01, 0x01, (RATE_25 << 5) | self.hours, self.minutes, self.seconds, self.frames, 0xF7]
    }

    /// Quarter-frame message carrying piece `piece` (0–7) of this timecode.
    pub fn quarter_frame(self, piece: u8) -> [u8; 2] {
        let nibble = match piece & 7 {
            0 => self.frames & 0x0F,
            1 => self.frames >> 4,
            2 => self.seconds & 0x0F,
            3 => self.seconds >> 4,
            4 => self.minutes & 0x0F,
            5 => self.minutes >> 4,
            6 => self.hours & 0x0F,
            _ => (self.hours >> 4) | (RATE_25 << 1),
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
    /// Last quarter frame sent; `None` while stopped.
    last_qf: Option<u64>,
    latched: Option<Timecode>,
}

impl MtcGenerator {
    /// Largest forward gap that is still filled with quarter frames instead of a relocate.
    const MAX_CATCH_UP: u64 = 8;

    pub fn stop(&mut self) {
        self.last_qf = None;
        self.latched = None;
    }

    /// Append the messages due at `seconds` (timecode position) to `out`.
    pub fn poll(&mut self, seconds: f64, out: &mut Vec<MtcMessage>) {
        let qf = (seconds.max(0.0) * QF_PER_SECOND).floor() as u64;
        let continuous = self.last_qf.is_some_and(|last| qf >= last && qf - last <= Self::MAX_CATCH_UP);
        if !continuous {
            out.push(MtcMessage::FullFrame(Timecode::from_frames(qf / 4).full_frame()));
            // Wait for the next piece 0 so receivers never see a partial timecode.
            self.last_qf = Some(qf);
            self.latched = None;
            return;
        }
        let last = self.last_qf.unwrap_or(qf);
        for q in last + 1..=qf {
            let piece = (q % 8) as u8;
            if piece == 0 {
                self.latched = Some(Timecode::from_frames(q / 4));
            }
            if let Some(tc) = self.latched {
                out.push(MtcMessage::QuarterFrame(tc.quarter_frame(piece)));
            }
        }
        self.last_qf = Some(qf);
    }

    /// Seconds (timecode position) at which the next quarter frame becomes due.
    pub fn next_due(&self) -> Option<f64> {
        self.last_qf.map(|q| (q + 1) as f64 / QF_PER_SECOND)
    }
}

/// Sends MTC on a background thread. `position` returns the current timecode position in
/// seconds, or `None` while timecode is stopped. `send` delivers raw MIDI bytes.
pub struct MtcSender {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MtcSender {
    pub fn spawn(
        position: impl Fn() -> Option<f64> + Send + 'static,
        mut send: impl FnMut(&[u8]) + Send + 'static,
    ) -> std::io::Result<Self> {
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let thread = thread::Builder::new().name("mdstage-mtc".into()).spawn(move || {
            // Best effort: without it the thread still works, just with more jitter.
            let _ = thread_priority::set_current_thread_priority(thread_priority::ThreadPriority::Max);
            let mut generator = MtcGenerator::default();
            let mut due = Vec::with_capacity(16);
            while flag.load(SeqCst) {
                let Some(now) = position() else {
                    generator.stop();
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                generator.poll(now, &mut due);
                for message in due.drain(..) {
                    send(message.bytes());
                }
                // Sleep most of the way to the next quarter frame, then spin the last bit:
                // OS sleeps overshoot by far more than MTC tolerates.
                let wait = generator.next_due().map_or(0.0, |t| t - now).clamp(0.0, 0.02);
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
        Ok(MtcSender { running, thread: Some(thread) })
    }
}

impl Drop for MtcSender {
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
        for bad in ["", "01:02:03", "01:02:03:25", "24:00:00:00", "01:60:00:00", "a:b:c:d", "01:02:03:04:05"] {
            assert_eq!(Timecode::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn full_frame_bytes() {
        let tc = Timecode::parse("01:00:00:00").unwrap();
        assert_eq!(tc.full_frame(), [0xF0, 0x7F, 0x7F, 0x01, 0x01, 0x21, 0x00, 0x00, 0x00, 0xF7]);
    }

    #[test]
    fn quarter_frame_pieces() {
        let tc = Timecode { hours: 17, minutes: 42, seconds: 53, frames: 24 };
        let pieces: Vec<u8> = (0..8).map(|p| tc.quarter_frame(p)[1]).collect();
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
        let mut generator = MtcGenerator::default();
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
    fn jumps_send_a_full_frame() {
        let mut generator = MtcGenerator::default();
        let mut out = Vec::new();
        generator.poll(10.0, &mut out);
        generator.poll(10.05, &mut out);
        out.clear();

        generator.poll(60.0, &mut out); // forward jump
        assert_eq!(out, [MtcMessage::FullFrame(Timecode::from_frames(60 * 25).full_frame())]);
        out.clear();
        generator.poll(5.0, &mut out); // backward jump (loop restart)
        assert_eq!(out, [MtcMessage::FullFrame(Timecode::from_frames(5 * 25).full_frame())]);

        generator.stop();
        out.clear();
        generator.poll(5.01, &mut out);
        assert!(matches!(out[..], [MtcMessage::FullFrame(_)]), "restart after stop relocates");
    }
}
