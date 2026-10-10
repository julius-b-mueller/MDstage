//! Soundcard output: runs a `Mixer` inside the device's audio callback.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig, SupportedStreamConfigRange};

use crate::clock::{ClockDriver, EngineClock};
use crate::mixer::Mixer;
use crate::{Error, Result};

/// Frames rendered per chunk when the device wants a sample format other than `f32`.
const SCRATCH_FRAMES: usize = 1024;

pub struct OutputInfo {
    pub name: String,
    /// Largest channel count the device offers.
    pub max_channels: usize,
    pub default_sample_rate: u32,
}

/// A running output stream. Dropping it stops playback.
pub struct Output {
    _stream: cpal::Stream,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub clock: Arc<EngineClock>,
    /// Set when the stream reported an error (the device was unplugged, for instance).
    pub failed: Arc<std::sync::atomic::AtomicBool>,
}

fn device_err(e: impl std::fmt::Display) -> Error {
    Error::Device(e.to_string())
}

/// All output devices of the default audio host.
pub fn list_outputs() -> Result<Vec<OutputInfo>> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    for device in host.output_devices().map_err(device_err)? {
        let Ok(configs) = device.supported_output_configs() else { continue };
        let Ok(default) = device.default_output_config() else { continue };
        out.push(OutputInfo {
            name: device.name().unwrap_or_default(),
            max_channels: configs.map(|c| c.channels() as usize).max().unwrap_or(0),
            default_sample_rate: default.sample_rate().0,
        });
    }
    Ok(out)
}

/// Open an output device and start rendering `mixer` to it.
///
/// `device_name` selects a device by name (`None` = system default). The stream uses as
/// many channels as the device offers, up to `max_channels`, at the device's default
/// sample rate; clips must be resampled to `Output::sample_rate` by the caller.
pub fn open(mut mixer: Mixer, device_name: Option<&str>, max_channels: usize) -> Result<Output> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .output_devices()
            .map_err(device_err)?
            .find(|d| d.name().is_ok_and(|n| n == name))
            .ok_or_else(|| Error::Device(format!("output device not found: {name}")))?,
        None => host.default_output_device().ok_or_else(|| Error::Device("no default output device".into()))?,
    };
    let name = device.name().unwrap_or_default();
    let default = device.default_output_config().map_err(device_err)?;
    let rate = default.sample_rate();

    // Among the configs that support the default rate, take the most channels we may use,
    // preferring f32 so no conversion is needed.
    let supports_rate = |c: &SupportedStreamConfigRange| c.min_sample_rate() <= rate && rate <= c.max_sample_rate();
    let best = device
        .supported_output_configs()
        .map_err(device_err)?
        .filter(supports_rate)
        .filter(|c| matches!(c.sample_format(), SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32))
        .filter(|c| c.channels() as usize <= max_channels.max(1))
        .max_by_key(|c| (c.channels(), c.sample_format() == SampleFormat::F32));
    let (channels, format) = match best {
        Some(c) => (c.channels(), c.sample_format()),
        None => (default.channels(), default.sample_format()),
    };

    let config = StreamConfig { channels, sample_rate: SampleRate(rate.0), buffer_size: cpal::BufferSize::Default };
    let clock = Arc::new(EngineClock::new(rate.0));
    let ch = channels as usize;
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = failed.clone();
    let on_error = move |e| {
        eprintln!("audio stream error: {e}");
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    };

    let stream = match format {
        SampleFormat::F32 => {
            let mut driver = ClockDriver::new(clock.clone());
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    mixer.render(data, ch);
                    driver.publish(mixer.frames());
                },
                on_error,
                None,
            )
        }
        SampleFormat::I16 => {
            let mut driver = ClockDriver::new(clock.clone());
            let mut scratch = vec![0.0f32; SCRATCH_FRAMES * ch];
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _| {
                    for chunk in data.chunks_mut(scratch.len()) {
                        let block = &mut scratch[..chunk.len()];
                        mixer.render(block, ch);
                        for (o, s) in chunk.iter_mut().zip(block.iter()) {
                            *o = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    }
                    driver.publish(mixer.frames());
                },
                on_error,
                None,
            )
        }
        SampleFormat::I32 => {
            let mut driver = ClockDriver::new(clock.clone());
            let mut scratch = vec![0.0f32; SCRATCH_FRAMES * ch];
            device.build_output_stream(
                &config,
                move |data: &mut [i32], _| {
                    for chunk in data.chunks_mut(scratch.len()) {
                        let block = &mut scratch[..chunk.len()];
                        mixer.render(block, ch);
                        for (o, s) in chunk.iter_mut().zip(block.iter()) {
                            *o = (s.clamp(-1.0, 1.0) as f64 * i32::MAX as f64) as i32;
                        }
                    }
                    driver.publish(mixer.frames());
                },
                on_error,
                None,
            )
        }
        other => return Err(Error::Device(format!("unsupported sample format {other:?}"))),
    }
    .map_err(device_err)?;
    stream.play().map_err(device_err)?;

    Ok(Output { _stream: stream, device_name: name, sample_rate: rate.0, channels: ch, clock, failed })
}
