// ═══════════════════════════════════════════════════════════════════════
// aw-dsp — native spectrogram core for the SignaVis desktop shell
//
// Port of src/domain/dsp.ts `computeSpectrogram` (STFT → mel/linear →
// PCEN or dB). Output must stay numerically equivalent to the JS
// reference; see tests/parity.rs.
//
// Designed for very long recordings: audio is pulled block-wise from a
// `SampleSource`, frames inside a block are computed in parallel (rayon),
// and only the PCEN recursion runs sequentially.
// ═══════════════════════════════════════════════════════════════════════

pub mod display;
pub mod mel;
pub mod pyramid;
pub mod source;
pub mod v2;

#[cfg(feature = "parallel")]
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub use pyramid::{Pyramid, PyramidMeta, build_pyramid};
pub use source::{SampleSource, WavSource, MemSource};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scale { Mel, Linear }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Window { Hann, Hamming, Blackman, BlackmanHarris }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecParams {
    pub sample_rate: u32,
    pub fft_size: usize,
    pub hop_size: usize,
    pub win_length: usize,
    pub n_mels: usize,
    pub scale: Scale,
    pub window: Window,
    /// None → dB (10·log10 power), Some → PCEN.
    pub pcen: Option<Pcen>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Pcen { pub gain: f64, pub bias: f64, pub root: f64, pub smoothing: f64 }

impl SpecParams {
    /// Same defaults as the JS player (PERCH_* constants).
    pub fn perch(sample_rate: u32) -> Self {
        let hop = (sample_rate / 100).max(1) as usize;
        Self {
            sample_rate, fft_size: 2048, hop_size: hop, win_length: 4 * hop, n_mels: 160,
            scale: Scale::Mel, window: Window::Hann,
            pcen: Some(Pcen { gain: 0.8, bias: 0.01, root: 4.0, smoothing: 0.025 }),
        }
    }

    pub fn out_bins(&self) -> usize {
        match self.scale { Scale::Linear => self.fft_size / 2, Scale::Mel => self.n_mels }
    }

    /// Frame count for `n_samples`, identical to the JS formula.
    pub fn n_frames(&self, n_samples: u64) -> u64 {
        let w = self.win_length as i64;
        let n = n_samples as i64;
        (((n - w).div_euclid(self.hop_size as i64)) + 1).max(1) as u64
    }
}

fn window_value(w: Window, i: usize, n: usize) -> f64 {
    use std::f64::consts::PI;
    let t = 2.0 * PI * i as f64 / (n.max(2) - 1) as f64;
    match w {
        Window::Hann => 0.5 * (1.0 - t.cos()),
        Window::Hamming => 0.54 - 0.46 * t.cos(),
        Window::Blackman => 0.42 - 0.5 * t.cos() + 0.08 * (2.0 * t).cos(),
        Window::BlackmanHarris =>
            0.35875 - 0.48829 * t.cos() + 0.14128 * (2.0 * t).cos() - 0.01168 * (3.0 * t).cos(),
    }
}

/// Precomputed state for one parameter set. Cheap to share across threads.
pub struct SpecEngine {
    pub params: SpecParams,
    window: Vec<f32>,
    fb: Vec<mel::SparseBand>,
    fft: Arc<dyn RealToComplex<f32>>,
}

struct Scratch {
    input: Vec<f32>,
    spec: Vec<realfft::num_complex::Complex<f32>>,
    fft: Vec<realfft::num_complex::Complex<f32>>,
    power: Vec<f32>,
}

/// PCEN smoothing state carried across blocks.
pub struct PcenState(pub Vec<f32>);

impl SpecEngine {
    pub fn new(params: SpecParams) -> Self {
        assert!(params.fft_size.is_power_of_two(), "fft_size must be a power of two");
        let copy = params.win_length.min(params.fft_size);
        let window = (0..copy).map(|i| window_value(params.window, i, params.win_length) as f32).collect();
        let fb = match params.scale {
            Scale::Mel => mel::sparse_mel_filterbank(
                params.sample_rate as f64, params.fft_size, params.n_mels, 0.0, params.sample_rate as f64 / 2.0),
            Scale::Linear => Vec::new(),
        };
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(params.fft_size);
        Self { params, window, fb, fft }
    }

    pub fn new_pcen_state(&self) -> PcenState { PcenState(vec![0.0; self.params.out_bins()]) }

    /// Number of input samples needed to compute `n` frames.
    pub fn samples_for_frames(&self, n: usize) -> usize {
        if n == 0 { 0 } else { (n - 1) * self.params.hop_size + self.params.win_length }
    }

    /// Band energies (power, before PCEN/dB) for `out.len() / out_bins` frames.
    /// `samples[0]` is the first sample of the first frame; missing tail
    /// samples are treated as zero (matches JS `audio[i] || 0`).
    pub fn band_energies(&self, samples: &[f32], out: &mut [f32]) {
        const FRAMES_PER_TASK: usize = 64;
        let task_len = self.params.out_bins() * FRAMES_PER_TASK;

        #[cfg(feature = "parallel")]
        out.par_chunks_mut(task_len).enumerate().for_each_init(
            || self.scratch(),
            |scratch, (task, chunk)| self.frames_into(samples, task * FRAMES_PER_TASK, chunk, scratch),
        );
        #[cfg(not(feature = "parallel"))]
        {
            let mut scratch = self.scratch();
            for (task, chunk) in out.chunks_mut(task_len).enumerate() {
                self.frames_into(samples, task * FRAMES_PER_TASK, chunk, &mut scratch);
            }
        }
    }

    fn scratch(&self) -> Scratch {
        Scratch {
            input: self.fft.make_input_vec(),
            spec: self.fft.make_output_vec(),
            fft: self.fft.make_scratch_vec(),
            power: vec![0f32; self.params.fft_size / 2],
        }
    }

    /// Compute consecutive frames starting at frame index `first` (relative to `samples`).
    fn frames_into(&self, samples: &[f32], first: usize, out: &mut [f32], s: &mut Scratch) {
        let hop = self.params.hop_size;
        for (j, frame_out) in out.chunks_mut(self.params.out_bins()).enumerate() {
            let off = (first + j) * hop;
            s.input.fill(0.0);
            for (i, w) in self.window.iter().enumerate() {
                s.input[i] = samples.get(off + i).copied().unwrap_or(0.0) * w;
            }
            self.fft.process_with_scratch(&mut s.input, &mut s.spec, &mut s.fft).expect("fft");
            for (p, c) in s.power.iter_mut().zip(s.spec.iter()) { *p = c.re * c.re + c.im * c.im; }
            match self.params.scale {
                Scale::Linear => frame_out.copy_from_slice(&s.power),
                Scale::Mel => for (o, band) in frame_out.iter_mut().zip(&self.fb) {
                    *o = band.weights.iter().zip(&s.power[band.start..])
                        .map(|(&w, &p)| w as f64 * p as f64).sum::<f64>() as f32;
                },
            }
        }
    }

    /// Convert band energies in place to display values (PCEN or dB).
    /// Sequential over frames because PCEN is a recursive filter.
    pub fn finalize(&self, data: &mut [f32], state: &mut PcenState) {
        let bins = self.params.out_bins();
        match (self.params.pcen, self.params.scale) {
            (Some(p), Scale::Mel) => {
                // f64 like the JS reference (JS numbers are doubles); at the
                // start of a file the smoothing state is tiny and f32 drifts.
                let (gain, bias, a) = (p.gain, p.bias, p.smoothing);
                let power = 1.0 / p.root;
                let offset = bias.powf(power);
                for frame in data.chunks_mut(bins) {
                    for (e, s) in frame.iter_mut().zip(state.0.iter_mut()) {
                        let ev = *e as f64;
                        // JS stores the state in a Float32Array → round each step.
                        *s = ((1.0 - a) * *s as f64 + a * ev) as f32;
                        let norm = ev / (1e-10 + *s as f64).powf(gain);
                        *e = ((norm + bias).powf(power) - offset) as f32;
                    }
                }
            }
            (_, Scale::Mel) => data.iter_mut().for_each(|v| *v = 10.0 * v.max(1e-10).log10()),
            (_, Scale::Linear) => data.iter_mut().for_each(|v| *v = 10.0 * v.max(1e-20).log10()),
        }
    }

    /// Finalized values for one block, computed independently of all other
    /// blocks so blocks can run in parallel (wasm worker pool).
    ///
    /// PCEN is a linear smoother that forgets its start state as
    /// (1 - smoothing)^frames, so `warmup` extra frames before the block,
    /// started from zero state, reproduce the sequential result: with
    /// smoothing 0.025 and 600 frames the residual is < 3e-7 (below f16
    /// precision). `samples[0]` is the first sample of the first warm-up
    /// frame; use warmup = 0 for the first block of a file (exact).
    pub fn block_values(&self, samples: &[f32], warmup: usize, n: usize) -> Vec<f32> {
        let bins = self.params.out_bins();
        let mut out = vec![0f32; (warmup + n) * bins];
        self.band_energies(samples, &mut out);
        let mut state = self.new_pcen_state();
        self.finalize(&mut out, &mut state);
        out.drain(..warmup * bins);
        out
    }

    /// Warm-up frames needed for `block_values` to be within `tol` of the
    /// sequential result (0 when no PCEN).
    pub fn pcen_warmup(&self, tol: f64) -> usize {
        match self.params.pcen {
            Some(p) if p.smoothing > 0.0 && p.smoothing < 1.0 =>
                (tol.ln() / (1.0 - p.smoothing).ln()).ceil() as usize,
            _ => 0,
        }
    }

    /// Stream the whole source block-wise. `sink(first_frame, values)` gets
    /// finalized values for `values.len() / out_bins` consecutive frames.
    /// An error from the sink (e.g. cancellation) aborts the run.
    pub fn run<S: SampleSource, F: FnMut(u64, &[f32]) -> std::io::Result<()>>(
        &self, src: &mut S, block_frames: usize, mut sink: F,
    ) -> std::io::Result<u64> {
        let total = self.params.n_frames(src.len());
        let bins = self.params.out_bins();
        let mut state = self.new_pcen_state();
        let mut samples = Vec::new();
        let mut out = Vec::new();
        let mut f0 = 0u64;
        while f0 < total {
            let n = block_frames.min((total - f0) as usize);
            samples.resize(self.samples_for_frames(n), 0.0);
            let got = src.read(f0 * self.params.hop_size as u64, &mut samples)?;
            samples[got..].fill(0.0);
            out.resize(n * bins, 0.0);
            self.band_energies(&samples, &mut out);
            self.finalize(&mut out, &mut state);
            sink(f0, &out)?;
            f0 += n as u64;
        }
        Ok(total)
    }
}
