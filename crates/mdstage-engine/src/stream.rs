//! Audio files read a stretch at a time, so a show's audio never has to sit in memory as
//! a whole: a `Reader` delivers any stretch of a file at the output rate, and a `Loader`
//! runs readers on a thread of its own, away from the show logic and the audio callback.
//!
//! Whatever a reader returns is, sample for sample, what decoding the whole file with
//! `Clip::decode_file` and `Clip::resampled` would have put at that place.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};

use rubato::{FftFixedIn, Resampler};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{self, CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::clip::Clip;
use crate::mixer::PAGE;
use crate::{Error, Result};

/// Input frames per resampler block. Must match `Clip::resampled`.
const CHUNK: usize = 4096;

/// What is known about a file once it has been opened, at the output rate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: usize,
}

impl Info {
    pub fn duration(&self) -> f64 {
        self.frames as f64 / self.sample_rate as f64
    }

    pub fn pages(&self) -> usize {
        self.frames.div_ceil(PAGE)
    }
}

/// Codecs whose packets can be decoded on their own, so a seek lands exactly.
const EXACT_SEEK: &[codecs::CodecType] = &[
    codecs::CODEC_TYPE_FLAC,
    codecs::CODEC_TYPE_PCM_U8,
    codecs::CODEC_TYPE_PCM_S8,
    codecs::CODEC_TYPE_PCM_S16LE,
    codecs::CODEC_TYPE_PCM_S16BE,
    codecs::CODEC_TYPE_PCM_S24LE,
    codecs::CODEC_TYPE_PCM_S24BE,
    codecs::CODEC_TYPE_PCM_S32LE,
    codecs::CODEC_TYPE_PCM_S32BE,
    codecs::CODEC_TYPE_PCM_F32LE,
    codecs::CODEC_TYPE_PCM_F32BE,
    codecs::CODEC_TYPE_PCM_F64LE,
    codecs::CODEC_TYPE_PCM_F64BE,
];

/// A file being decoded, at its own sample rate.
struct Decoding {
    name: String,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn codecs::Decoder>,
    track_id: u32,
    samples: Option<SampleBuffer<f32>>,
    sample_rate: u32,
    channels: usize,
    /// Length as the file declares it, for files that can be searched exactly.
    frames: Option<usize>,
    exact_seek: bool,
}

impl Decoding {
    fn open(path: &Path) -> Result<Decoding> {
        // The first packet tells the real rate and channel count; then start over.
        let mut probe = Decoding::begin(path, 0, 0)?;
        let mut first: Vec<Vec<f32>> = Vec::new();
        if probe.next(&mut first)?.is_none() || probe.sample_rate == 0 || first.is_empty() {
            return Err(Error::Decode(probe.name, "no audio data".into()));
        }
        Decoding::begin(path, probe.sample_rate, first.len())
    }

    fn begin(path: &Path, sample_rate: u32, channels: usize) -> Result<Decoding> {
        let name = path.display().to_string();
        let decode_err = |e: SymphoniaError| Error::Decode(name.clone(), e.to_string());
        let file = File::open(path).map_err(|e| Error::Io(name.clone(), e))?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let format = symphonia::default::get_probe().format(&hint, stream, &format_opts, &MetadataOptions::default()).map_err(decode_err)?.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| Error::Decode(name.clone(), "no audio track".into()))?;
        let decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(decode_err)?;
        let exact_seek = EXACT_SEEK.contains(&track.codec_params.codec);
        Ok(Decoding {
            track_id: track.id,
            frames: track.codec_params.n_frames.filter(|_| exact_seek).map(|n| n as usize),
            exact_seek,
            format,
            decoder,
            samples: None,
            sample_rate,
            channels,
            name,
        })
    }

    /// Decode the next packet and append its samples to `out`, one vector per channel.
    /// Returns the frame number the packet starts at, or `None` at the end of the file.
    fn next(&mut self, out: &mut Vec<Vec<f32>>) -> Result<Option<usize>> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(SymphoniaError::ResetRequired) => return Ok(None),
                Err(e) => return Err(Error::Decode(self.name.clone(), e.to_string())),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                // A corrupt packet is skipped rather than failing the whole file.
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(e) => return Err(Error::Decode(self.name.clone(), e.to_string())),
            };
            let spec = *decoded.spec();
            let count = spec.channels.count();
            if self.channels == 0 {
                self.sample_rate = spec.rate;
                self.channels = count;
            }
            if out.is_empty() {
                out.resize(self.channels, Vec::new());
            }
            let needed = decoded.capacity() * count;
            if self.samples.as_ref().is_none_or(|b| b.capacity() < needed) {
                self.samples = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
            }
            let buf = self.samples.as_mut().unwrap();
            buf.copy_planar_ref(decoded);
            let frames = buf.len() / count.max(1);
            for (c, channel) in out.iter_mut().enumerate() {
                match c < count {
                    true => channel.extend_from_slice(&buf.samples()[c * frames..(c + 1) * frames]),
                    false => channel.resize(channel.len() + frames, 0.0),
                }
            }
            return Ok(Some(packet.ts() as usize));
        }
    }

    fn seek(&mut self, frame: usize) -> Result<()> {
        self.format
            .seek(SeekMode::Accurate, SeekTo::TimeStamp { ts: frame as u64, track_id: self.track_id })
            .map_err(|e| Error::Decode(self.name.clone(), e.to_string()))?;
        self.decoder.reset();
        Ok(())
    }
}

/// Sample rate conversion of a stream, block by block.
struct Resampling {
    inner: FftFixedIn<f32>,
    /// Decoded frames waiting for a full block.
    input: Vec<Vec<f32>>,
    /// Frames of resampler delay still to be dropped from the start.
    skip: usize,
    produced: usize,
    expected: usize,
}

impl Resampling {
    fn new(from: u32, to: u32, channels: usize, expected: usize) -> Result<Resampling> {
        let inner = FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, channels).map_err(|e| Error::Resample(e.to_string()))?;
        Ok(Resampling { skip: inner.output_delay(), inner, input: vec![Vec::new(); channels], produced: 0, expected })
    }
}

/// Reads any stretch of one audio file, converted to the output rate.
pub struct Reader {
    path: PathBuf,
    decoding: Decoding,
    resampling: Option<Resampling>,
    /// Frames ready to be handed out; the first one is frame `pos` of the file.
    queue: Vec<Vec<f32>>,
    pos: usize,
    /// After a seek: `pos` is only known once the next packet has arrived.
    landing: bool,
    ended: bool,
    info: Info,
}

impl Reader {
    pub fn open(path: &Path, sample_rate: u32) -> Result<Reader> {
        let mut decoding = Decoding::open(path)?;
        // Where the audio really ends. Headers are not always right about it (and MP3, AAC
        // and Ogg do not say reliably at all), so look: at the last stretch if the file
        // can be searched exactly, otherwise at all of it.
        let mut scratch = Vec::new();
        let mut end = None;
        if let Some(declared) = decoding.frames.filter(|n| *n > 0) {
            if decoding.seek(declared - 1).is_ok() {
                while let Some(at) = decoding.next(&mut scratch)? {
                    end = Some(at + scratch.first().map_or(0, Vec::len));
                    scratch.iter_mut().for_each(Vec::clear);
                }
            }
            decoding = Decoding::open(path)?;
        }
        let source_frames = match end {
            Some(end) => end,
            None => {
                let mut frames = 0;
                while decoding.next(&mut scratch)?.is_some() {
                    frames += scratch.first().map_or(0, Vec::len);
                    scratch.iter_mut().for_each(Vec::clear);
                }
                decoding = Decoding::open(path)?;
                frames
            }
        };
        let frames = match decoding.sample_rate == sample_rate {
            true => source_frames,
            false => (source_frames as u64 * sample_rate as u64).div_ceil(decoding.sample_rate as u64) as usize,
        };
        let info = Info { sample_rate, channels: decoding.channels, frames };
        let mut reader = Reader { path: path.to_path_buf(), queue: vec![Vec::new(); info.channels], decoding, resampling: None, pos: 0, landing: false, ended: false, info };
        reader.resampling = reader.resampler()?;
        Ok(reader)
    }

    pub fn info(&self) -> Info {
        self.info
    }

    fn resampler(&self) -> Result<Option<Resampling>> {
        match self.decoding.sample_rate == self.info.sample_rate {
            true => Ok(None),
            false => Resampling::new(self.decoding.sample_rate, self.info.sample_rate, self.info.channels, self.info.frames).map(Some),
        }
    }

    /// Decode from the very beginning again.
    fn restart(&mut self) -> Result<()> {
        self.decoding = Decoding::open(&self.path)?;
        self.resampling = self.resampler()?;
        self.queue.iter_mut().for_each(Vec::clear);
        (self.pos, self.landing, self.ended) = (0, false, false);
        Ok(())
    }

    fn can_seek(&self) -> bool {
        self.decoding.exact_seek && self.resampling.is_none()
    }

    /// Get ready to deliver `frame`, which is not simply next in line.
    fn jump(&mut self, frame: usize) -> Result<()> {
        if self.can_seek() && self.decoding.seek(frame).is_ok() {
            self.queue.iter_mut().for_each(Vec::clear);
            (self.pos, self.landing, self.ended) = (frame, true, false);
            return Ok(());
        }
        self.restart()
    }

    /// Decode a bit more into the queue. `false` once the file has nothing left.
    fn fill(&mut self) -> Result<bool> {
        if self.ended {
            return Ok(false);
        }
        let Some(resampling) = &mut self.resampling else {
            return Ok(match self.decoding.next(&mut self.queue)? {
                Some(at) => {
                    if self.landing {
                        (self.pos, self.landing) = (at, false);
                    }
                    true
                }
                None => {
                    self.ended = true;
                    false
                }
            });
        };
        if self.decoding.next(&mut resampling.input)?.is_none() {
            if resampling.produced >= resampling.expected {
                self.ended = true;
                return Ok(false);
            }
            // The file is through: push what is left, and the resampler's delay, out with silence.
            let padded = (resampling.input[0].len() / CHUNK + 1) * CHUNK;
            resampling.input.iter_mut().for_each(|c| c.resize(padded, 0.0));
        }
        while resampling.input[0].len() >= CHUNK {
            let block: Vec<&[f32]> = resampling.input.iter().map(|c| &c[..CHUNK]).collect();
            let out = resampling.inner.process(&block, None).map_err(|e| Error::Resample(e.to_string()))?;
            resampling.input.iter_mut().for_each(|c| drop(c.drain(..CHUNK)));
            let got = out.first().map_or(0, Vec::len);
            let skip = resampling.skip.min(got);
            let take = (got - skip).min(resampling.expected - resampling.produced);
            for (queue, out) in self.queue.iter_mut().zip(&out) {
                queue.extend_from_slice(&out[skip..skip + take]);
            }
            resampling.skip -= skip;
            resampling.produced += take;
        }
        Ok(true)
    }

    /// `len` frames from `frame` on. Beyond the end of the file there is silence.
    pub fn read(&mut self, frame: usize, len: usize) -> Result<Clip> {
        let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(len); self.info.channels];
        if frame < self.info.frames && self.info.channels > 0 {
            // Decoding forward is quicker than a seek for anything close by.
            if frame < self.pos || (self.can_seek() && frame > self.pos + self.queue[0].len() + PAGE) {
                self.jump(frame)?;
            }
            loop {
                if !self.landing {
                    let skip = frame.saturating_sub(self.pos).min(self.queue[0].len());
                    self.queue.iter_mut().for_each(|c| drop(c.drain(..skip)));
                    self.pos += skip;
                    if self.pos >= frame {
                        let take = self.queue[0].len().min(len - out[0].len());
                        for (out, queue) in out.iter_mut().zip(&mut self.queue) {
                            out.extend(queue.drain(..take));
                        }
                        self.pos += take;
                    }
                }
                if out[0].len() == len || !self.fill()? {
                    break;
                }
                // A seek that came down after the frame asked for: take the long way.
                if out[0].is_empty() && !self.landing && self.pos > frame {
                    self.restart()?;
                }
            }
        }
        out.iter_mut().for_each(|c| c.resize(len, 0.0));
        Ok(Clip::from_planar(self.info.sample_rate, out))
    }

    /// The page with the given number (`PAGE` frames; the last one may be shorter).
    pub fn page(&mut self, index: u32) -> Result<Clip> {
        let from = index as usize * PAGE;
        self.read(from, PAGE.min(self.info.frames.saturating_sub(from)))
    }
}

/// Min/max pairs for drawing a file's waveform with `buckets` columns, and its length in
/// seconds. Reads the file through once without ever holding it as a whole.
pub fn peaks(path: &Path, buckets: usize) -> Result<(Vec<(f32, f32)>, f64)> {
    let rate = Clip::probe_rate(path).ok_or_else(|| Error::Decode(path.display().to_string(), "no sample rate".into()))?;
    let mut reader = Reader::open(path, rate)?;
    let info = reader.info();
    let mut peaks = vec![(0.0f32, 0.0f32); if info.frames == 0 { 0 } else { buckets }];
    for index in 0..info.pages() as u32 {
        let page = reader.page(index)?;
        for channel in 0..page.channel_count() {
            for (n, &sample) in page.channel(channel).iter().enumerate() {
                let (lo, hi) = &mut peaks[(index as usize * PAGE + n) * buckets / info.frames];
                *lo = lo.min(sample);
                *hi = hi.max(sample);
            }
        }
    }
    Ok((peaks, info.duration()))
}

/// Work for the loader thread. Urgent jobs are done before all others.
pub enum Job {
    Open { file: String, urgent: bool },
    Page { file: String, index: u32, urgent: bool },
    /// The file is not needed any more.
    Close { file: String },
}

pub enum Loaded {
    Opened { file: String, info: Result<Info> },
    Page { file: String, index: u32, clip: Result<Clip> },
}

/// A thread that opens audio files and reads pages from them on request.
pub struct Loader {
    jobs: Sender<Job>,
    pub done: Receiver<Loaded>,
}

impl Loader {
    /// `dir` is the folder the files are in; pages come out at `sample_rate`.
    pub fn spawn(dir: PathBuf, sample_rate: u32) -> std::io::Result<Loader> {
        let (jobs, incoming) = channel::<Job>();
        let (finished, done) = channel();
        std::thread::Builder::new().name("mdstage-audio-loader".into()).spawn(move || {
            let mut queue: VecDeque<Job> = VecDeque::new();
            let mut readers: HashMap<String, Reader> = HashMap::new();
            loop {
                if queue.is_empty() {
                    match incoming.recv() {
                        Ok(job) => queue.push_back(job),
                        Err(_) => return,
                    }
                }
                queue.extend(incoming.try_iter());
                let urgent = queue.iter().position(|job| matches!(job, Job::Open { urgent: true, .. } | Job::Page { urgent: true, .. }));
                let Some(job) = queue.remove(urgent.unwrap_or(0)) else { continue };
                let result = match job {
                    Job::Close { file } => {
                        readers.remove(&file);
                        continue;
                    }
                    Job::Open { file, .. } => {
                        let opened = Reader::open(&dir.join(&file), sample_rate);
                        let info = opened.map(|reader| {
                            let info = reader.info();
                            readers.insert(file.clone(), reader);
                            info
                        });
                        Loaded::Opened { file, info }
                    }
                    Job::Page { file, index, .. } => {
                        let clip = match readers.get_mut(&file) {
                            Some(reader) => reader.page(index),
                            None => Reader::open(&dir.join(&file), sample_rate).and_then(|mut reader| {
                                let clip = reader.page(index);
                                readers.insert(file.clone(), reader);
                                clip
                            }),
                        };
                        Loaded::Page { file, index, clip }
                    }
                };
                if finished.send(result).is_err() {
                    return;
                }
            }
        })?;
        Ok(Loader { jobs, done })
    }

    pub fn send(&self, job: Job) {
        let _ = self.jobs.send(job);
    }
}

/// Write a 16-bit WAV file with a recognisable value in every sample (for tests).
#[cfg(test)]
pub(crate) fn write_wav(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
    let data: Vec<u8> = (0..frames * channels as usize).flat_map(|n| (((n * 37) % 60_000) as i32 - 30_000).to_le_bytes()[..2].to_vec()).collect();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * channels as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(&(channels * 2).to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&data);
    std::fs::write(path, bytes).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::write_wav as wav;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdstage-stream-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every page, asked for in an order that forces seeks and restarts, must equal the
    /// same stretch of the file decoded as a whole.
    fn pages_match(path: &Path, rate: u32) {
        let whole = Clip::decode_file(path).unwrap().resampled(rate).unwrap();
        let mut reader = Reader::open(path, rate).unwrap();
        assert_eq!(reader.info(), Info { sample_rate: rate, channels: whole.channel_count(), frames: whole.frames() });
        let pages = reader.info().pages() as u32;
        let order: Vec<u32> = (0..pages).rev().chain([0, pages - 1, 1, 1, 2, 0]).chain(0..pages).filter(|p| *p < pages).collect();
        for index in order {
            let page = reader.page(index).unwrap();
            let from = index as usize * PAGE;
            let to = (from + PAGE).min(whole.frames());
            assert_eq!(page.frames(), to - from, "page {index}");
            for c in 0..whole.channel_count() {
                assert!(page.channel(c) == &whole.channel(c)[from..to], "page {index}, channel {c} differs");
            }
        }
    }

    #[test]
    fn pages_equal_the_file_decoded_as_a_whole() {
        let dir = temp("exact");
        let path = dir.join("a.wav");
        wav(&path, 48_000, 2, 3 * PAGE + 1234);
        pages_match(&path, 48_000);
    }

    #[test]
    fn resampled_pages_equal_the_resampled_file() {
        let dir = temp("resampled");
        let path = dir.join("a.wav");
        wav(&path, 44_100, 1, 2 * PAGE + 999);
        pages_match(&path, 48_000);
    }

    #[test]
    fn peaks_match_those_of_the_decoded_file() {
        let dir = temp("peaks");
        let path = dir.join("a.wav");
        // 328 columns of 400 frames each, over more than two pages.
        wav(&path, 48_000, 2, 131_200);
        let whole = Clip::decode_file(&path).unwrap();
        let (found, duration) = peaks(&path, 328).unwrap();
        assert!(found == whole.peaks(328), "peaks differ");
        assert_eq!(duration, whole.duration());
    }

    #[test]
    fn reads_past_the_end_are_silent() {
        let dir = temp("end");
        let path = dir.join("a.wav");
        wav(&path, 48_000, 1, 100);
        let mut reader = Reader::open(&path, 48_000).unwrap();
        let clip = reader.read(90, 20).unwrap();
        assert!(clip.channel(0)[..10].iter().all(|s| *s != 0.0));
        assert!(clip.channel(0)[10..].iter().all(|s| *s == 0.0));
        assert_eq!(reader.read(500, 4).unwrap().channel(0), &[0.0; 4]);
    }

    #[test]
    fn the_loader_serves_pages_and_reports_missing_files() {
        let dir = temp("loader");
        wav(&dir.join("a.wav"), 48_000, 2, PAGE + 10);
        let loader = Loader::spawn(dir, 48_000).unwrap();
        loader.send(Job::Open { file: "a.wav".into(), urgent: false });
        loader.send(Job::Open { file: "missing.wav".into(), urgent: false });
        loader.send(Job::Page { file: "a.wav".into(), index: 1, urgent: true });
        let mut seen = Vec::new();
        for _ in 0..3 {
            seen.push(match loader.done.recv_timeout(std::time::Duration::from_secs(5)).unwrap() {
                Loaded::Opened { file, info } => format!("{file}: {:?}", info.map(|i| i.frames).map_err(|e| matches!(e, Error::Io(..)))),
                Loaded::Page { file, index, clip } => format!("{file} page {index}: {}", clip.unwrap().frames()),
            });
        }
        seen.sort();
        assert_eq!(seen, ["a.wav page 1: 10", "a.wav: Ok(65546)", "missing.wav: Err(true)"]);
    }
}
