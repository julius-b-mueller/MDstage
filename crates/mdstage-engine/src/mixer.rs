//! Device-independent mixer with sample-accurate transitions between voices.
//!
//! A voice plays a region of a clip. At its *transition point* it either wraps (loop /
//! vamp), hands off to another voice on exactly that sample (start→loop, loop→outro) while
//! its own remainder rings out as a tail, or simply plays on to the end.
//!
//! `Mixer::render` runs in the audio callback: it never allocates, locks or frees. Voices
//! arrive fully built over a ring buffer and finished voices leave over another one, so
//! their memory is released on the control thread.

use std::sync::Arc;

use crate::clip::Clip;
use crate::clock::{VoiceShared, VoiceState};

pub type VoiceId = u32;

const MAX_VOICES: usize = 64;

/// One source channel of the clip feeding one physical output channel.
#[derive(Clone, Copy, Debug)]
pub struct Route {
    pub src: u16,
    pub out: u16,
    pub gain: f32,
}

/// What happens when a playing voice reaches its transition point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AtTransition {
    /// Jump back to the region start (loop / vamp). The tail is not played.
    Wrap,
    /// Start the given armed voice on this sample; this voice plays its tail to the end.
    Handoff(VoiceId),
    /// No transition: play through to the region end.
    Continue,
}

/// Everything the audio thread needs to play one voice. Built on the control thread.
pub struct VoiceSpec {
    pub id: VoiceId,
    pub clip: Arc<Clip>,
    /// Region start, in clip frames.
    pub start: usize,
    /// Transition point (`fading_point`, or the region end), in clip frames.
    pub transition: usize,
    /// Region end, in clip frames.
    pub end: usize,
    pub at_transition: AtTransition,
    pub gain: f32,
    pub routes: Vec<Route>,
    /// Armed voices stay silent until another voice hands off to them.
    pub armed: bool,
    pub shared: Arc<VoiceShared>,
}

pub enum Command {
    Add(VoiceSpec),
    SetTransition { id: VoiceId, at: AtTransition },
    /// Ramp the voice gain to `target` over `frames`; optionally end the voice once there.
    Fade { id: VoiceId, target: f32, frames: u32, then_stop: bool },
    /// Fade every voice out over `frames` and end it.
    StopAll { frames: u32 },
}

/// A voice as the audio thread sees it. Opaque to the control side, which only drops it.
pub struct Voice {
    spec: VoiceSpec,
    pos: usize,
    state: VoiceState,
    gain: f32,
    gain_step: f32,
    ramp_target: f32,
    ramp_left: u32,
    stop_after_ramp: bool,
    /// Frame within the current block at which this voice starts (set by a handoff).
    block_offset: usize,
    rendered: bool,
}

impl Voice {
    fn new(mut spec: VoiceSpec) -> Self {
        let frames = spec.clip.frames();
        spec.end = spec.end.min(frames);
        spec.start = spec.start.min(spec.end);
        spec.transition = spec.transition.clamp(spec.start, spec.end);
        // A zero-length loop would spin forever in the callback.
        if spec.transition == spec.start && spec.at_transition == AtTransition::Wrap {
            spec.at_transition = AtTransition::Continue;
        }
        let channels = spec.clip.channel_count();
        spec.routes.retain(|r| (r.src as usize) < channels);
        Voice {
            pos: spec.start,
            state: if spec.armed { VoiceState::Armed } else { VoiceState::Playing },
            gain: spec.gain,
            gain_step: 0.0,
            ramp_target: spec.gain,
            ramp_left: 0,
            stop_after_ramp: false,
            block_offset: 0,
            rendered: false,
            spec,
        }
    }

    fn fade(&mut self, target: f32, frames: u32, then_stop: bool) {
        self.stop_after_ramp = then_stop;
        if frames == 0 {
            self.gain = target;
            self.ramp_left = 0;
            if then_stop {
                self.state = VoiceState::Done;
            }
        } else {
            self.gain_step = (target - self.gain) / frames as f32;
            self.ramp_target = target;
            self.ramp_left = frames;
        }
    }

    /// Mix this voice into `out` for the rest of the block. Returns a handoff request
    /// `(target voice, frame offset within the block)` if the transition point was reached.
    fn render(&mut self, out: &mut [f32], out_channels: usize) -> Option<(VoiceId, usize)> {
        let nframes = out.len() / out_channels;
        let mut written = self.block_offset;
        let mut handoff = None;
        while written < nframes {
            let in_transition = self.state == VoiceState::Playing
                && self.spec.at_transition != AtTransition::Continue;
            let boundary = if in_transition { self.spec.transition } else { self.spec.end };
            if self.pos >= boundary {
                match (in_transition, self.spec.at_transition) {
                    (true, AtTransition::Wrap) => self.pos = self.spec.start,
                    (true, AtTransition::Handoff(id)) => {
                        handoff = Some((id, written));
                        self.state = VoiceState::Tail;
                    }
                    _ => {
                        self.state = VoiceState::Done;
                        break;
                    }
                }
                continue;
            }
            let n = (boundary - self.pos).min(nframes - written);
            self.mix(out, out_channels, written, n);
            self.pos += n;
            written += n;
            if self.state == VoiceState::Done {
                break;
            }
        }
        handoff
    }

    fn mix(&mut self, out: &mut [f32], out_channels: usize, offset: usize, n: usize) {
        let clip = &*self.spec.clip;
        if self.ramp_left == 0 {
            let gain = self.gain;
            if gain == 0.0 {
                return;
            }
            for r in &self.spec.routes {
                let out_ch = r.out as usize;
                if out_ch >= out_channels {
                    continue;
                }
                let g = gain * r.gain;
                let src = &clip.channel(r.src as usize)[self.pos..self.pos + n];
                for (f, s) in src.iter().enumerate() {
                    out[(offset + f) * out_channels + out_ch] += s * g;
                }
            }
            return;
        }
        for f in 0..n {
            if self.ramp_left > 0 {
                self.ramp_left -= 1;
                // Land exactly on the target instead of accumulating rounding error.
                self.gain = if self.ramp_left == 0 { self.ramp_target } else { self.gain + self.gain_step };
            }
            for r in &self.spec.routes {
                let out_ch = r.out as usize;
                if out_ch < out_channels {
                    out[(offset + f) * out_channels + out_ch] +=
                        clip.channel(r.src as usize)[self.pos + f] * self.gain * r.gain;
                }
            }
            if self.ramp_left == 0 && self.stop_after_ramp {
                self.state = VoiceState::Done;
                return;
            }
        }
    }
}

/// Lives in the audio callback.
pub struct Mixer {
    voices: Vec<Voice>,
    commands: rtrb::Consumer<Command>,
    retired: rtrb::Producer<Voice>,
    frames: u64,
}

/// Control-thread end of a mixer.
pub struct MixerHandle {
    commands: rtrb::Producer<Command>,
    retired: rtrb::Consumer<Voice>,
}

impl MixerHandle {
    /// Queue a command for the audio thread. Returns it back if the queue is full.
    pub fn send(&mut self, command: Command) -> std::result::Result<(), Command> {
        self.collect_garbage();
        self.commands.push(command).map_err(|rtrb::PushError::Full(c)| c)
    }

    /// Free voices the audio thread has finished with. Call regularly from the control side.
    pub fn collect_garbage(&mut self) {
        while self.retired.pop().is_ok() {}
    }
}

impl Mixer {
    pub fn new() -> (Mixer, MixerHandle) {
        let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(256);
        let (ret_tx, ret_rx) = rtrb::RingBuffer::new(MAX_VOICES * 2);
        (
            Mixer { voices: Vec::with_capacity(MAX_VOICES), commands: cmd_rx, retired: ret_tx, frames: 0 },
            MixerHandle { commands: cmd_tx, retired: ret_rx },
        )
    }

    /// Total frames rendered so far (the engine clock).
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Fill `out` (interleaved, `out_channels` wide) with the next block.
    pub fn render(&mut self, out: &mut [f32], out_channels: usize) {
        out.fill(0.0);
        if out_channels == 0 {
            return;
        }
        self.drain_commands();
        for v in &mut self.voices {
            v.rendered = false;
            v.block_offset = 0;
        }

        // A handoff can start a voice that sits earlier in the list than the one handing
        // off, so repeat until no voice was started mid-block.
        loop {
            let mut started = false;
            for i in 0..self.voices.len() {
                let v = &mut self.voices[i];
                if v.rendered || !matches!(v.state, VoiceState::Playing | VoiceState::Tail) {
                    continue;
                }
                let handoff = v.render(out, out_channels);
                v.rendered = true;
                if let Some((id, offset)) = handoff {
                    let target = self.voices.iter_mut().find(|t| t.spec.id == id && t.state == VoiceState::Armed);
                    if let Some(t) = target {
                        t.state = VoiceState::Playing;
                        t.block_offset = offset;
                        started = true;
                    }
                }
            }
            if !started {
                break;
            }
        }

        self.frames += (out.len() / out_channels) as u64;
        for v in &self.voices {
            v.spec.shared.publish(self.frames, v.pos as u64, v.state);
        }
        self.retire_done();
    }

    fn drain_commands(&mut self) {
        while let Ok(command) = self.commands.pop() {
            match command {
                Command::Add(spec) => {
                    if self.voices.len() < MAX_VOICES {
                        self.voices.push(Voice::new(spec));
                    } else {
                        // No room: hand it straight back so it is freed off the audio thread.
                        spec.shared.publish(self.frames, spec.start as u64, VoiceState::Done);
                        let mut v = Voice::new(spec);
                        v.state = VoiceState::Done;
                        if let Err(rtrb::PushError::Full(v)) = self.retired.push(v) {
                            std::mem::forget(v);
                        }
                    }
                }
                Command::SetTransition { id, at } => {
                    if let Some(v) = self.voices.iter_mut().find(|v| v.spec.id == id) {
                        let zero_loop = at == AtTransition::Wrap && v.spec.transition == v.spec.start;
                        if !zero_loop {
                            v.spec.at_transition = at;
                        }
                    }
                }
                Command::Fade { id, target, frames, then_stop } => {
                    if let Some(v) = self.voices.iter_mut().find(|v| v.spec.id == id) {
                        v.fade(target, frames, then_stop);
                    }
                }
                Command::StopAll { frames } => {
                    for v in &mut self.voices {
                        v.fade(0.0, frames, true);
                    }
                }
            }
        }
    }

    fn retire_done(&mut self) {
        let mut i = 0;
        while i < self.voices.len() {
            if self.voices[i].state != VoiceState::Done || self.retired.is_full() {
                i += 1;
                continue;
            }
            let v = self.voices.swap_remove(i);
            // Cannot fail: checked for space above and this is the only producer.
            let _ = self.retired.push(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    const SR: u32 = 48_000;

    fn spec(id: VoiceId, clip: Arc<Clip>, at: AtTransition, armed: bool) -> VoiceSpec {
        let frames = clip.frames();
        VoiceSpec {
            id,
            routes: (0..clip.channel_count() as u16).map(|c| Route { src: c, out: c, gain: 1.0 }).collect(),
            clip,
            start: 0,
            transition: frames,
            end: frames,
            at_transition: at,
            gain: 1.0,
            armed,
            shared: Arc::new(VoiceShared::default()),
        }
    }

    /// Render `total` frames in blocks of `block` frames, mono.
    fn render(mixer: &mut Mixer, total: usize, block: usize, channels: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut buf = vec![0.0; block * channels];
        while out.len() < total * channels {
            mixer.render(&mut buf, channels);
            out.extend_from_slice(&buf);
        }
        out.truncate(total * channels);
        out
    }

    #[test]
    fn loop_then_outro_is_sample_continuous() {
        // One continuous sine, cut into a loop (whole periods) and an outro that carries on
        // in phase. Looping and then handing off must reproduce the uncut sine exactly.
        let period = 100;
        let sine = |n: usize| (TAU * (n % period) as f32 / period as f32).sin();
        let loop_len = 10 * period;
        let outro_len = 700;
        let loop_clip = Arc::new(Clip::from_planar(SR, vec![(0..loop_len).map(sine).collect()]));
        let outro_clip = Arc::new(Clip::from_planar(SR, vec![(loop_len..loop_len + outro_len).map(sine).collect()]));

        let (mut mixer, mut handle) = Mixer::new();
        handle.send(Command::Add(spec(1, loop_clip, AtTransition::Wrap, false))).ok().unwrap();
        handle.send(Command::Add(spec(2, outro_clip, AtTransition::Continue, true))).ok().unwrap();

        // Block size deliberately not a divisor of the loop length.
        let block = 441;
        let mut out = render(&mut mixer, 6 * block, block, 1);
        handle.send(Command::SetTransition { id: 1, at: AtTransition::Handoff(2) }).ok().unwrap();
        out.extend(render(&mut mixer, 4000, block, 1));

        // 6 blocks = 2646 frames → the loop is in its 3rd pass; the handoff happens at 3000.
        let handoff_at = 3 * loop_len;
        for (n, &s) in out.iter().enumerate() {
            let expected = if n < handoff_at + outro_len { sine(n) } else { 0.0 };
            assert!((s - expected).abs() < 1e-6, "frame {n}: got {s}, expected {expected}");
        }
    }

    #[test]
    fn tail_rings_out_over_the_next_voice() {
        // Loop cycles 0..100, tail 100..150 is only heard once the handoff happens.
        let mut data = vec![1.0; 100];
        data.extend(vec![0.5; 50]);
        let loop_clip = Arc::new(Clip::from_planar(SR, vec![data]));
        let outro_clip = Arc::new(Clip::from_planar(SR, vec![vec![0.25; 200]]));

        let (mut mixer, mut handle) = Mixer::new();
        let mut looped = spec(1, loop_clip, AtTransition::Wrap, false);
        looped.transition = 100;
        handle.send(Command::Add(looped)).ok().unwrap();
        handle.send(Command::Add(spec(2, outro_clip, AtTransition::Continue, true))).ok().unwrap();

        let mut out = render(&mut mixer, 256, 64, 1);
        assert!(out.iter().all(|&s| s == 1.0), "tail must not be heard while looping");
        handle.send(Command::SetTransition { id: 1, at: AtTransition::Handoff(2) }).ok().unwrap();
        out.extend(render(&mut mixer, 384, 64, 1));

        // 256 frames rendered → next loop boundary at 300.
        assert!(out[..300].iter().all(|&s| s == 1.0));
        assert!(out[300..350].iter().all(|&s| s == 0.75), "tail and outro overlap");
        assert!(out[350..500].iter().all(|&s| s == 0.25));
        assert!(out[500..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn chain_start_into_loop() {
        let start = Arc::new(Clip::from_planar(SR, vec![vec![1.0; 130]]));
        let looped = Arc::new(Clip::from_planar(SR, vec![vec![2.0; 50]]));
        let (mut mixer, mut handle) = Mixer::new();
        // Added in "wrong" order: the armed voice sits before the one that starts it.
        handle.send(Command::Add(spec(2, looped, AtTransition::Wrap, true))).ok().unwrap();
        handle.send(Command::Add(spec(1, start, AtTransition::Handoff(2), false))).ok().unwrap();
        let out = render(&mut mixer, 400, 64, 1);
        assert!(out[..130].iter().all(|&s| s == 1.0));
        assert!(out[130..].iter().all(|&s| s == 2.0));
    }

    #[test]
    fn routes_to_physical_outputs() {
        let clip = Arc::new(Clip::from_planar(SR, vec![vec![0.5; 64], vec![-0.5; 64]]));
        let (mut mixer, mut handle) = Mixer::new();
        let mut s = spec(1, clip, AtTransition::Continue, false);
        // Left → outputs 7 and 3 (fan-out), right → output 8, one route beyond the device.
        s.routes = vec![
            Route { src: 0, out: 6, gain: 1.0 },
            Route { src: 0, out: 2, gain: 1.0 },
            Route { src: 1, out: 7, gain: 1.0 },
            Route { src: 1, out: 12, gain: 1.0 },
        ];
        handle.send(Command::Add(s)).ok().unwrap();
        let out = render(&mut mixer, 64, 64, 8);
        for frame in out.chunks(8) {
            assert_eq!(frame, [0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.5, -0.5]);
        }
    }

    #[test]
    fn fade_out_stops_and_retires_the_voice() {
        let clip = Arc::new(Clip::from_planar(SR, vec![vec![1.0; 10_000]]));
        let (mut mixer, mut handle) = Mixer::new();
        let s = spec(1, clip.clone(), AtTransition::Wrap, false);
        let shared = s.shared.clone();
        handle.send(Command::Add(s)).ok().unwrap();
        render(&mut mixer, 128, 64, 1);
        handle.send(Command::Fade { id: 1, target: 0.0, frames: 100, then_stop: true }).ok().unwrap();
        let out = render(&mut mixer, 256, 64, 1);

        assert!(out[..100].windows(2).all(|w| w[1] < w[0]), "gain ramps down monotonically");
        assert!(out[99].abs() < 1e-4);
        assert!(out[100..].iter().all(|&s| s == 0.0));
        assert_eq!(shared.state(), VoiceState::Done);

        // The audio thread gave the voice back; dropping it here releases the clip.
        assert_eq!(Arc::strong_count(&clip), 2);
        handle.collect_garbage();
        assert_eq!(Arc::strong_count(&clip), 1);
    }

    #[test]
    fn publishes_position_for_the_clock() {
        let clip = Arc::new(Clip::from_planar(SR, vec![vec![0.0; 1000]]));
        let (mut mixer, mut handle) = Mixer::new();
        let s = spec(1, clip, AtTransition::Wrap, false);
        let shared = s.shared.clone();
        handle.send(Command::Add(s)).ok().unwrap();
        render(&mut mixer, 1280, 64, 1);
        assert_eq!(mixer.frames(), 1280);
        assert_eq!(shared.clip_frame(), 280);
        assert_eq!(shared.state(), VoiceState::Playing);
    }
}
