//! Waveform peaks, decoded on a background thread and cached per file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use eframe::egui;
use mdstage_engine::clip::Clip;

/// Peak pairs kept per file; enough for a waveform a few thousand pixels wide.
const BUCKETS: usize = 4000;

#[derive(Clone)]
pub enum WaveState {
    Loading,
    Ready { peaks: Arc<Vec<(f32, f32)>>, duration: f64 },
    Failed,
}

pub struct Waveforms {
    cache: HashMap<String, WaveState>,
    requests: Sender<String>,
    results: Receiver<(String, WaveState)>,
}

impl Waveforms {
    pub fn new(audio_dir: PathBuf, ctx: egui::Context) -> Waveforms {
        let (requests, todo) = channel::<String>();
        let (done, results) = channel();
        std::thread::Builder::new()
            .name("mdstage-peaks".into())
            .spawn(move || {
                for file in todo {
                    let state = match Clip::decode_file(&audio_dir.join(&file)) {
                        Ok(clip) => WaveState::Ready { peaks: Arc::new(clip.peaks(BUCKETS)), duration: clip.duration() },
                        Err(e) => {
                            eprintln!("{e}");
                            WaveState::Failed
                        }
                    };
                    if done.send((file, state)).is_err() {
                        break;
                    }
                    ctx.request_repaint();
                }
            })
            .expect("spawn peaks thread");
        Waveforms { cache: HashMap::new(), requests, results }
    }

    /// Take over finished decodes. Call once per frame.
    pub fn poll(&mut self) {
        while let Ok((file, state)) = self.results.try_recv() {
            self.cache.insert(file, state);
        }
    }

    /// Peaks for a file; the first call queues the decode and reports `Loading`.
    pub fn get(&mut self, file: &str) -> WaveState {
        if let Some(state) = self.cache.get(file) {
            return state.clone();
        }
        self.cache.insert(file.to_string(), WaveState::Loading);
        let _ = self.requests.send(file.to_string());
        WaveState::Loading
    }
}
