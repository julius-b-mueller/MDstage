//! Realtime engine for MDstage: audio playback with sample-accurate transitions,
//! MIDI timecode derived from the audio clock, and the output device glue.
//!
//! The mixer is device-independent (`Mixer::render` fills any buffer), so all transition
//! logic is testable offline. `device` wires it to a soundcard.

pub mod clip;
pub mod clock;
pub mod device;
pub mod mixer;
pub mod mtc;
pub mod player;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("cannot decode {0}: {1}")]
    Decode(String, String),
    #[error("resampling failed: {0}")]
    Resample(String),
    #[error("audio device: {0}")]
    Device(String),
    #[error("midi: {0}")]
    Midi(String),
    #[error("the audio engine is not taking commands (queue full)")]
    Busy,
}

pub type Result<T> = std::result::Result<T, Error>;
