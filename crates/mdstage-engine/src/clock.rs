//! Lock-free clocks shared between the audio callback and the other threads.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering::SeqCst};
use std::time::Instant;

/// Two `u64` values that are always read as a consistent pair (seqlock, single writer).
/// The writer never blocks, so it is safe to call from the audio callback.
#[derive(Default)]
pub struct SeqPair {
    seq: AtomicU32,
    a: AtomicU64,
    b: AtomicU64,
}

impl SeqPair {
    pub fn write(&self, a: u64, b: u64) {
        let s = self.seq.load(SeqCst);
        self.seq.store(s.wrapping_add(1), SeqCst);
        self.a.store(a, SeqCst);
        self.b.store(b, SeqCst);
        self.seq.store(s.wrapping_add(2), SeqCst);
    }

    pub fn read(&self) -> (u64, u64) {
        loop {
            let s = self.seq.load(SeqCst);
            if s & 1 == 0 {
                let pair = (self.a.load(SeqCst), self.b.load(SeqCst));
                if self.seq.load(SeqCst) == s {
                    return pair;
                }
            }
            std::hint::spin_loop();
        }
    }
}

/// Maps wall-clock time to the engine's sample counter. The audio callback publishes
/// "frame F was reached at time T" once per block; readers extrapolate between blocks,
/// which gives a clock far finer than the block size (needed for MTC quarter frames).
pub struct EngineClock {
    epoch: Instant,
    sample_rate: u32,
    /// (engine frames rendered, seconds since `epoch` as `f64` bits)
    anchor: SeqPair,
}

impl EngineClock {
    pub fn new(sample_rate: u32) -> Self {
        Self { epoch: Instant::now(), sample_rate, anchor: SeqPair::default() }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Frames rendered at the last published block boundary.
    pub fn frames(&self) -> u64 {
        self.anchor.read().0
    }

    /// Engine frame position right now, extrapolated from the last block boundary.
    /// Extrapolation is capped at a quarter second so a stalled stream doesn't run away.
    pub fn frames_now(&self) -> f64 {
        let (frames, at) = self.anchor.read();
        let elapsed = self.epoch.elapsed().as_secs_f64() - f64::from_bits(at);
        frames as f64 + elapsed.clamp(-0.25, 0.25) * self.sample_rate as f64
    }
}

/// The audio callback's end of an `EngineClock`.
///
/// Callbacks do not arrive evenly: the OS wakes the audio thread early, late or in bursts.
/// Anchoring the clock to the raw callback time would make it jump by that jitter on every
/// block, so the time is run through a delay-locked loop first — the published anchors lie
/// on a smooth line that follows the soundcard's real rate.
pub struct ClockDriver {
    clock: Arc<EngineClock>,
    last_frames: u64,
    /// Filtered time (seconds since the clock's epoch) at `last_frames`.
    last_time: f64,
    seconds_per_frame: f64,
    locked: bool,
}

impl ClockDriver {
    /// Loop bandwidth: low enough to flatten callback jitter, high enough to lock within a few seconds.
    const BANDWIDTH_HZ: f64 = 0.1;
    /// A prediction error this large means a dropout or device stall: start over.
    const RESYNC_SECONDS: f64 = 0.05;

    pub fn new(clock: Arc<EngineClock>) -> Self {
        let seconds_per_frame = 1.0 / clock.sample_rate as f64;
        ClockDriver { clock, last_frames: 0, last_time: 0.0, seconds_per_frame, locked: false }
    }

    /// Forget the timing learnt so far: the next `publish` starts afresh (after someone
    /// else has been driving the clock).
    pub fn reset(&mut self) {
        self.locked = false;
    }

    /// Call from the audio callback after rendering, with the total frames rendered so far.
    pub fn publish(&mut self, frames_rendered: u64) {
        let now = self.clock.epoch.elapsed().as_secs_f64();
        self.publish_at(frames_rendered, now);
    }

    fn publish_at(&mut self, frames_rendered: u64, now: f64) {
        let advanced = frames_rendered.saturating_sub(self.last_frames) as f64;
        let nominal = 1.0 / self.clock.sample_rate as f64;
        let predicted = self.last_time + advanced * self.seconds_per_frame;
        let error = now - predicted;
        if !self.locked || advanced == 0.0 || error.abs() > Self::RESYNC_SECONDS {
            self.last_time = now;
            self.seconds_per_frame = nominal;
            self.locked = true;
        } else {
            let omega = std::f64::consts::TAU * Self::BANDWIDTH_HZ * advanced * nominal;
            self.last_time = predicted + std::f64::consts::SQRT_2 * omega * error;
            self.seconds_per_frame += omega * omega * error / advanced;
        }
        self.last_frames = frames_rendered;
        self.clock.anchor.write(frames_rendered, self.last_time.to_bits());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum VoiceState {
    /// Loaded, waiting to be started by a handoff from another voice.
    Armed = 0,
    Playing = 1,
    /// Past its transition point, ringing out to the end of its region.
    Tail = 2,
    Done = 3,
}

/// Playback position of one voice, published by the audio callback.
#[derive(Default)]
pub struct VoiceShared {
    /// (engine frame, clip frame): "at engine frame E the voice was at clip frame C".
    /// While the voice plays straight through, clip position = C + (engine now − E).
    position: SeqPair,
    state: AtomicU8,
}

impl VoiceShared {
    pub fn publish(&self, engine_frame: u64, clip_frame: u64, state: VoiceState) {
        self.position.write(engine_frame, clip_frame);
        self.state.store(state as u8, SeqCst);
    }

    pub fn state(&self) -> VoiceState {
        match self.state.load(SeqCst) {
            0 => VoiceState::Armed,
            1 => VoiceState::Playing,
            2 => VoiceState::Tail,
            _ => VoiceState::Done,
        }
    }

    /// Clip frame at the last block boundary.
    pub fn clip_frame(&self) -> u64 {
        self.position.read().1
    }

    /// Clip frame right now, extrapolated with the engine clock. Only advances while the
    /// voice is audible; an armed or finished voice reports its last position.
    pub fn clip_frame_now(&self, clock: &EngineClock) -> f64 {
        let (engine_frame, clip_frame) = self.position.read();
        match self.state() {
            VoiceState::Playing | VoiceState::Tail => {
                clip_frame as f64 + (clock.frames_now() - engine_frame as f64).max(0.0)
            }
            _ => clip_frame as f64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_pair_reads_back_what_was_written() {
        let pair = SeqPair::default();
        pair.write(7, 9);
        assert_eq!(pair.read(), (7, 9));
    }

    #[test]
    fn driver_smooths_callback_jitter() {
        let sample_rate = 48_000;
        let block = 512u64;
        // The device runs 0.02 % fast and every callback arrives up to ±2 ms off.
        let period = block as f64 / sample_rate as f64 / 1.0002;
        let clock = Arc::new(EngineClock::new(sample_rate));
        let mut driver = ClockDriver::new(clock.clone());

        let mut seed = 12345u64;
        let mut worst_raw = 0.0f64;
        let mut worst_filtered = 0.0f64;
        for k in 1..=4000u64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let jitter = ((seed >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 0.004;
            let ideal = 1.0 + k as f64 * period;
            driver.publish_at(k * block, ideal + jitter);
            // Give the loop 20 s to lock, then compare against the ideal line.
            if k > 2000 {
                let published = f64::from_bits(clock.anchor.read().1);
                worst_raw = worst_raw.max(jitter.abs());
                worst_filtered = worst_filtered.max((published - ideal).abs());
            }
        }
        assert!(worst_raw > 0.0019, "test jitter too small: {worst_raw}");
        assert!(worst_filtered < 0.0004, "filtered clock still off by {worst_filtered} s");
        assert_eq!(clock.frames(), 4000 * block);
    }

    #[test]
    fn driver_resyncs_after_a_dropout() {
        let clock = Arc::new(EngineClock::new(48_000));
        let mut driver = ClockDriver::new(clock.clone());
        driver.publish_at(480, 1.0);
        driver.publish_at(960, 1.01);
        driver.publish_at(1440, 3.0); // stream stalled for two seconds
        assert_eq!(f64::from_bits(clock.anchor.read().1), 3.0);
    }
}
