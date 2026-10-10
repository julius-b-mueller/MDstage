//! Decoded audio held in memory, planar `f32`.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::{Error, Result};

pub struct Clip {
    sample_rate: u32,
    channels: Vec<Vec<f32>>,
}

impl Clip {
    /// Build a clip from one sample vector per channel. Shorter channels are zero-padded.
    pub fn from_planar(sample_rate: u32, mut channels: Vec<Vec<f32>>) -> Self {
        let frames = channels.iter().map(Vec::len).max().unwrap_or(0);
        for c in &mut channels {
            c.resize(frames, 0.0);
        }
        Clip { sample_rate, channels }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    pub fn channel(&self, index: usize) -> &[f32] {
        &self.channels[index]
    }

    pub fn duration(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }

    /// Frame index for a time in seconds, clamped to the clip.
    pub fn frame_at(&self, seconds: f64) -> usize {
        ((seconds.max(0.0) * self.sample_rate as f64).round() as usize).min(self.frames())
    }

    /// Min/max pairs over all channels for drawing a waveform with `buckets` columns.
    pub fn peaks(&self, buckets: usize) -> Vec<(f32, f32)> {
        let frames = self.frames();
        if buckets == 0 || frames == 0 {
            return Vec::new();
        }
        (0..buckets)
            .map(|b| {
                let from = b * frames / buckets;
                let to = ((b + 1) * frames / buckets).max(from + 1).min(frames);
                let mut lo = 0.0f32;
                let mut hi = 0.0f32;
                for c in &self.channels {
                    for &s in &c[from..to] {
                        lo = lo.min(s);
                        hi = hi.max(s);
                    }
                }
                (lo, hi)
            })
            .collect()
    }

    /// The sample rate of an audio file, read from its header without decoding it.
    pub fn probe_rate(path: &Path) -> Option<u32> {
        let stream = MediaSourceStream::new(Box::new(File::open(path).ok()?), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe().format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default()).ok()?;
        probed.format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?.codec_params.sample_rate
    }

    /// Decode a whole audio file (WAV, AIFF, FLAC, MP3, Ogg Vorbis, AAC/M4A).
    /// Encoder delay and padding of MP3/AAC are trimmed where the file declares them.
    pub fn decode_file(path: &Path) -> Result<Clip> {
        let name = path.display().to_string();
        let decode_err = |e: SymphoniaError| Error::Decode(name.clone(), e.to_string());

        let file = File::open(path).map_err(|e| Error::Io(name.clone(), e))?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &format_opts, &MetadataOptions::default())
            .map_err(decode_err)?;
        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| Error::Decode(name.clone(), "no audio track".into()))?;
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(decode_err)?;

        let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
        let mut channels: Vec<Vec<f32>> = Vec::new();
        let mut samples: Option<SampleBuffer<f32>> = None;

        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(SymphoniaError::ResetRequired) => break,
                Err(e) => return Err(decode_err(e)),
            };
            if packet.track_id() != track_id {
                continue;
            }
            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                // A corrupt packet is skipped rather than failing the whole file.
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(e) => return Err(decode_err(e)),
            };
            let spec = *decoded.spec();
            let count = spec.channels.count();
            if channels.is_empty() {
                sample_rate = spec.rate;
                channels = vec![Vec::new(); count];
            }
            let needed = decoded.capacity() * count;
            if samples.as_ref().is_none_or(|b| b.capacity() < needed) {
                samples = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
            }
            let buf = samples.as_mut().unwrap();
            buf.copy_planar_ref(decoded);
            let frames = buf.len() / count;
            for (c, out) in channels.iter_mut().enumerate().take(count) {
                out.extend_from_slice(&buf.samples()[c * frames..(c + 1) * frames]);
            }
        }

        if channels.is_empty() || sample_rate == 0 {
            return Err(Error::Decode(name, "no audio data".into()));
        }
        Ok(Clip::from_planar(sample_rate, channels))
    }

    /// Convert to another sample rate. Returns an unchanged copy if the rate already matches.
    pub fn resampled(&self, target_rate: u32) -> Result<Clip> {
        use rubato::{FftFixedIn, Resampler};

        if target_rate == self.sample_rate || self.frames() == 0 {
            return Ok(Clip { sample_rate: target_rate, channels: self.channels.clone() });
        }
        let err = |e: &dyn std::fmt::Display| Error::Resample(e.to_string());
        let chunk = 4096;
        let count = self.channel_count();
        let mut resampler =
            FftFixedIn::<f32>::new(self.sample_rate as usize, target_rate as usize, chunk, 2, count)
                .map_err(|e| err(&e))?;
        let delay = resampler.output_delay();
        let expected = (self.frames() as u64 * target_rate as u64).div_ceil(self.sample_rate as u64) as usize;

        let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(expected + delay + chunk); count];
        let mut pos = 0;
        // Feed zero-padded chunks until the resampler's delay has been flushed as well.
        while out[0].len() < expected + delay {
            let input: Vec<Vec<f32>> = self
                .channels
                .iter()
                .map(|c| {
                    let mut block = c[pos.min(c.len())..(pos + chunk).min(c.len())].to_vec();
                    block.resize(chunk, 0.0);
                    block
                })
                .collect();
            pos += chunk;
            let produced = resampler.process(&input, None).map_err(|e| err(&e))?;
            for (o, p) in out.iter_mut().zip(produced) {
                o.extend(p);
            }
        }
        for o in &mut out {
            o.drain(..delay);
            o.truncate(expected);
        }
        Ok(Clip::from_planar(target_rate, out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    #[test]
    fn pads_channels_and_reports_duration() {
        let clip = Clip::from_planar(48_000, vec![vec![0.0; 48_000], vec![0.0; 100]]);
        assert_eq!(clip.frames(), 48_000);
        assert_eq!(clip.channel(1).len(), 48_000);
        assert_eq!(clip.duration(), 1.0);
        assert_eq!(clip.frame_at(0.5), 24_000);
        assert_eq!(clip.frame_at(99.0), 48_000);
    }

    #[test]
    fn peaks_cover_the_whole_clip() {
        let clip = Clip::from_planar(48_000, vec![vec![0.0, 0.5, -0.25, 0.0, 1.0, -1.0, 0.0, 0.0]]);
        assert_eq!(clip.peaks(2), vec![(-0.25, 0.5), (-1.0, 1.0)]);
        assert_eq!(clip.peaks(100).len(), 100);
    }

    #[test]
    fn resampling_keeps_length_pitch_and_alignment() {
        let from = 44_100;
        let to = 48_000;
        let freq = 441.0;
        let data: Vec<f32> = (0..from).map(|n| (TAU * freq * n as f32 / from as f32).sin()).collect();
        let out = Clip::from_planar(from, vec![data]).resampled(to).unwrap();

        assert_eq!(out.sample_rate(), to);
        assert_eq!(out.frames(), 48_000);
        // Same sine at the new rate, in phase (i.e. the resampler delay was removed).
        for n in 2_000..46_000 {
            let expected = (TAU * freq * n as f32 / to as f32).sin();
            let got = out.channel(0)[n];
            assert!((got - expected).abs() < 0.01, "frame {n}: got {got}, expected {expected}");
        }
    }
}
