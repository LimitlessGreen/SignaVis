// ═══════════════════════════════════════════════════════════════════════
// aw-dsp v2 — reference spectrogram core
//
// Conventions (verified by tests/v2.rs, not by parity with older code):
//   • periodic windows, win_len ≤ n_fft (zero-padded)
//   • centred frames: frame i is centred on sample i·hop (time i·hop/sr)
//   • levels in dBFS: a full-scale sine reads 0 dBFS in its bin/band,
//     independent of window, window length and FFT size
//   • band scales (mel, log) use continuous triangles in Hz, widened to at
//     least one FFT bin so no band is ever empty
//   • PCEN smoothing is a time constant in seconds (hop-independent)
//   • reassignment accumulates power, then converts to dB
//   • output: dBFS (default), magnitude (sine amplitude units: a sine of
//     amplitude A reads A) or phase (radians, −π … π)
// ═══════════════════════════════════════════════════════════════════════

#[cfg(feature = "parallel")]
use rayon::prelude::*;
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::sync::Arc;

use crate::SampleSource;

/// dBFS value used for silence (power 0).
pub const DB_FLOOR: f32 = -200.0;

/// PCEN input scale (librosa: magnitudes in 32-bit integer range).
const PCEN_SCALE: f64 = 2147483648.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum WindowKind {
    Hann,
    Hamming,
    Blackman,
    BlackmanHarris,
    Kaiser { beta: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum FreqScale {
    /// n_fft/2 + 1 bins, 0 … Nyquist.
    Linear,
    Mel { bands: usize, f_min: f64, f_max: f64 },
    /// Log-spaced bands (constant relative bandwidth). Not a true CQT:
    /// low bands are limited by the STFT resolution.
    Log { bands: usize, f_min: f64, f_max: f64 },
}

/// What each output cell holds. PCEN only applies to `Db`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Output {
    /// dBFS, or PCEN when `pcen` is set.
    #[default]
    Db,
    /// √power in sine amplitude units.
    Magnitude,
    /// Phase in radians at the window start; band scales take the
    /// filter-weighted circular mean of the bin phases.
    Phase,
}

/// Per-channel energy normalisation (Wang et al. 2017, librosa conventions).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pcen {
    /// Smoother time constant in seconds (librosa default 0.4).
    pub time_constant: f64,
    /// α (librosa 0.98).
    pub gain: f64,
    /// δ (librosa 2.0).
    pub bias: f64,
    /// r (librosa 0.5).
    pub power: f64,
    /// ε (librosa 1e-6).
    pub eps: f64,
}

impl Default for Pcen {
    fn default() -> Self { Self { time_constant: 0.4, gain: 0.98, bias: 2.0, power: 0.5, eps: 1e-6 } }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StftParams {
    pub sample_rate: u32,
    pub win_len: usize,
    pub hop: usize,
    pub n_fft: usize,
    pub window: WindowKind,
    pub scale: FreqScale,
    /// None → dBFS.
    pub pcen: Option<Pcen>,
    /// Time-frequency reassignment (not with phase output).
    pub reassign: bool,
    #[serde(default)]
    pub output: Output,
}

impl StftParams {
    /// Window length in ms → samples, with overlap fraction and zero-padding
    /// factor; the UI should think in these units.
    pub fn from_ms(sample_rate: u32, win_ms: f64, overlap: f64, zero_pad: usize, window: WindowKind, scale: FreqScale) -> Self {
        let win_len = ((win_ms * 1e-3 * sample_rate as f64).round() as usize).max(16);
        let hop = ((win_len as f64 * (1.0 - overlap.clamp(0.0, 0.99))).round() as usize).max(1);
        let n_fft = (win_len * zero_pad.max(1)).next_power_of_two();
        Self { sample_rate, win_len, hop, n_fft, window, scale, pcen: None, reassign: false, output: Output::Db }
    }

    /// Sets the sample rate taken from the audio and resolves a band `f_max`
    /// of 0 to Nyquist (frontends send 0 before the file is opened).
    pub fn resolve_sample_rate(&mut self, sr: u32) {
        self.sample_rate = sr;
        if let FreqScale::Mel { f_max, .. } | FreqScale::Log { f_max, .. } = &mut self.scale {
            if *f_max <= 0.0 { *f_max = sr as f64 / 2.0; }
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.sample_rate == 0 { return Err("sample_rate must be > 0".into()); }
        if self.win_len < 2 { return Err("win_len must be ≥ 2".into()); }
        if self.hop == 0 { return Err("hop must be ≥ 1".into()); }
        if self.win_len > self.n_fft { return Err(format!("win_len {} > n_fft {}", self.win_len, self.n_fft)); }
        if self.pcen.is_some() && self.reassign { return Err("PCEN and reassignment are exclusive".into()); }
        if self.pcen.is_some() && self.output != Output::Db { return Err("PCEN needs dB output".into()); }
        if self.reassign && self.output == Output::Phase { return Err("reassignment has no phase output".into()); }
        if let Some(p) = self.pcen {
            if !(p.time_constant > 0.0) { return Err("pcen.time_constant must be > 0".into()); }
        }
        let nyq = self.sample_rate as f64 / 2.0;
        if let FreqScale::Mel { bands, f_min, f_max } | FreqScale::Log { bands, f_min, f_max } = self.scale {
            if bands == 0 { return Err("bands must be > 0".into()); }
            if !(f_min >= 0.0 && f_min < f_max && f_max <= nyq) { return Err(format!("need 0 ≤ f_min < f_max ≤ {nyq}")); }
            if matches!(self.scale, FreqScale::Log { .. }) && f_min <= 0.0 { return Err("log scale needs f_min > 0".into()); }
        }
        Ok(())
    }

    pub fn n_bins(&self) -> usize { self.n_fft / 2 + 1 }

    pub fn out_bins(&self) -> usize {
        match self.scale { FreqScale::Linear => self.n_bins(), FreqScale::Mel { bands, .. } | FreqScale::Log { bands, .. } => bands }
    }

    /// Centred frames: one per hop, covering the whole signal.
    pub fn n_frames(&self, n_samples: u64) -> u64 { n_samples / self.hop as u64 + 1 }

    pub fn frame_time(&self, frame: u64) -> f64 { (frame * self.hop as u64) as f64 / self.sample_rate as f64 }

    /// Centre frequency (Hz) of each output row, low → high.
    pub fn bin_frequencies(&self) -> Vec<f64> {
        let sr = self.sample_rate as f64;
        match self.scale {
            FreqScale::Linear => (0..self.n_bins()).map(|k| k as f64 * sr / self.n_fft as f64).collect(),
            FreqScale::Mel { bands, f_min, f_max } => band_edges_mel(bands, f_min, f_max)[1..=bands].to_vec(),
            FreqScale::Log { bands, f_min, f_max } => band_edges_log(bands, f_min, f_max)[1..=bands].to_vec(),
        }
    }
}

// ─── Windows ────────────────────────────────────────────────────────

/// Periodic (DFT-even) window of length `n`.
pub fn window(kind: WindowKind, n: usize) -> Vec<f64> {
    let nf = n as f64;
    (0..n).map(|i| {
        let t = 2.0 * PI * i as f64 / nf;
        match kind {
            WindowKind::Hann => 0.5 - 0.5 * t.cos(),
            WindowKind::Hamming => 0.54 - 0.46 * t.cos(),
            WindowKind::Blackman => 0.42 - 0.5 * t.cos() + 0.08 * (2.0 * t).cos(),
            WindowKind::BlackmanHarris =>
                0.35875 - 0.48829 * t.cos() + 0.14128 * (2.0 * t).cos() - 0.01168 * (3.0 * t).cos(),
            WindowKind::Kaiser { beta } => {
                let x = 2.0 * i as f64 / nf - 1.0;
                bessel_i0(beta * (1.0 - x * x).max(0.0).sqrt()) / bessel_i0(beta)
            }
        }
    }).collect()
}

/// Modified Bessel function I₀ via its power series (converges for all x).
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, q) = (1.0, 1.0, x * x / 4.0);
    for k in 1..200 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 { break; }
    }
    sum
}

// ─── Band filterbanks ───────────────────────────────────────────────

pub fn hz_to_mel(hz: f64) -> f64 { 2595.0 * (1.0 + hz / 700.0).log10() }
pub fn mel_to_hz(mel: f64) -> f64 { 700.0 * (10f64.powf(mel / 2595.0) - 1.0) }

fn band_edges_mel(bands: usize, f_min: f64, f_max: f64) -> Vec<f64> {
    let (m0, m1) = (hz_to_mel(f_min), hz_to_mel(f_max));
    (0..bands + 2).map(|i| mel_to_hz(m0 + (m1 - m0) * i as f64 / (bands + 1) as f64)).collect()
}

fn band_edges_log(bands: usize, f_min: f64, f_max: f64) -> Vec<f64> {
    let (l0, l1) = (f_min.ln(), f_max.ln());
    (0..bands + 2).map(|i| (l0 + (l1 - l0) * i as f64 / (bands + 1) as f64).exp()).collect()
}

#[derive(Clone, Debug)]
pub struct Band { pub start: usize, pub weights: Vec<f32> }

/// Triangles with peak 1 at each centre. Half-widths are at least one bin
/// spacing, so narrow low-frequency bands interpolate between FFT bins
/// instead of collapsing to nothing.
fn triangle_bank(edges: &[f64], n_bins: usize, bin_hz: f64) -> Vec<Band> {
    (1..edges.len() - 1).map(|m| {
        let c = edges[m];
        let lw = (c - edges[m - 1]).max(bin_hz);
        let rw = (edges[m + 1] - c).max(bin_hz);
        let k0 = (((c - lw) / bin_hz).ceil().max(0.0)) as usize;
        let k1 = (((c + rw) / bin_hz).floor() as usize).min(n_bins - 1);
        let weights = (k0..=k1).map(|k| {
            let f = k as f64 * bin_hz;
            (if f <= c { 1.0 - (c - f) / lw } else { 1.0 - (f - c) / rw }).max(0.0) as f32
        }).collect();
        Band { start: k0, weights }
    }).collect()
}

pub fn filterbank(p: &StftParams) -> Vec<Band> {
    let bin_hz = p.sample_rate as f64 / p.n_fft as f64;
    match p.scale {
        FreqScale::Linear => Vec::new(),
        FreqScale::Mel { bands, f_min, f_max } => triangle_bank(&band_edges_mel(bands, f_min, f_max), p.n_bins(), bin_hz),
        FreqScale::Log { bands, f_min, f_max } => triangle_bank(&band_edges_log(bands, f_min, f_max), p.n_bins(), bin_hz),
    }
}

// ─── Engine ─────────────────────────────────────────────────────────

pub struct Stft {
    pub params: StftParams,
    win: Vec<f32>,
    /// t·w(t) and w'(t) for reassignment (t in samples from window centre).
    win_t: Vec<f32>,
    win_d: Vec<f32>,
    fb: Vec<Band>,
    fft: Arc<dyn RealToComplex<f32>>,
    /// Converts |X|² to amplitude² of a sine (2/Σw)².
    amp_scale: f64,
    /// Equivalent noise bandwidth in bins; divides band sums so a sine's
    /// spread main lobe counts once.
    enbw: f64,
}

struct Scratch {
    input: Vec<f32>,
    spec: Vec<Complex<f32>>,
    spec_t: Vec<Complex<f32>>,
    spec_d: Vec<Complex<f32>>,
    fft: Vec<Complex<f32>>,
    power: Vec<f32>,
}

/// PCEN smoother state carried across blocks.
pub struct PcenState(pub Vec<f64>);

impl Stft {
    pub fn new(params: StftParams) -> Result<Self, String> {
        params.validate()?;
        let w = window(params.window, params.win_len);
        let sum: f64 = w.iter().sum();
        let sum_sq: f64 = w.iter().map(|v| v * v).sum();
        let half = params.win_len as f64 / 2.0;
        let win_t = w.iter().enumerate().map(|(i, &v)| ((i as f64 - half) * v) as f32).collect();
        // Analytic-ish derivative via central differences on the periodic window.
        let n = w.len();
        let win_d = (0..n).map(|i| {
            let (a, b) = (if i + 1 < n { w[i + 1] } else { 0.0 }, if i > 0 { w[i - 1] } else { 0.0 });
            (0.5 * (a - b)) as f32
        }).collect();
        Ok(Self {
            fb: filterbank(&params),
            fft: RealFftPlanner::<f32>::new().plan_fft_forward(params.n_fft),
            amp_scale: (2.0 / sum).powi(2),
            // In FFT bins: zero-padding widens the main lobe by n_fft / win_len.
            enbw: params.n_fft as f64 * sum_sq / (sum * sum),
            win: w.iter().map(|&v| v as f32).collect(),
            win_t, win_d, params,
        })
    }

    pub fn new_pcen_state(&self) -> PcenState { PcenState(Vec::new()) }

    fn scratch(&self) -> Scratch {
        let reassign = self.params.reassign;
        let spec = self.fft.make_output_vec();
        Scratch {
            input: self.fft.make_input_vec(),
            spec_t: if reassign { spec.clone() } else { Vec::new() },
            spec_d: if reassign { spec.clone() } else { Vec::new() },
            spec,
            fft: self.fft.make_scratch_vec(),
            power: vec![0.0; self.params.n_bins()],
        }
    }

    /// Samples needed for frames [f0, f0+n): returns (start sample, len).
    /// `start` may be negative (zero padding before the signal).
    pub fn sample_range(&self, f0: u64, n: usize) -> (i64, usize) {
        let start = (f0 * self.params.hop as u64) as i64 - (self.params.win_len / 2) as i64;
        let len = if n == 0 { 0 } else { (n - 1) * self.params.hop + self.params.win_len };
        (start, len)
    }

    fn fft_into(&self, frame: &[f32], w: &[f32], s: &mut Scratch, which: u8) {
        s.input.fill(0.0);
        for ((o, &x), &wv) in s.input.iter_mut().zip(frame).zip(w) { *o = x * wv; }
        let out = match which { 0 => &mut s.spec, 1 => &mut s.spec_t, _ => &mut s.spec_d };
        self.fft.process_with_scratch(&mut s.input, out, &mut s.fft).expect("fft");
    }

    /// Linear power of one frame (sine amplitude² units) into `s.power`.
    fn frame_power(&self, frame: &[f32], s: &mut Scratch) {
        self.fft_into(frame, &self.win, s, 0);
        let k = self.amp_scale as f32;
        for (p, c) in s.power.iter_mut().zip(&s.spec) { *p = (c.re * c.re + c.im * c.im) * k; }
    }

    fn reduce(&self, power: &[f32], out: &mut [f32]) {
        if self.fb.is_empty() { out.copy_from_slice(power); return; }
        let inv = 1.0 / self.enbw;
        for (o, b) in out.iter_mut().zip(&self.fb) {
            let s: f64 = b.weights.iter().zip(&power[b.start..]).map(|(&w, &p)| w as f64 * p as f64).sum();
            *o = (s * inv) as f32;
        }
    }

    /// Output row (fractional) for a frequency in bins of the FFT.
    fn row_of_fft_bin(&self, k: f64) -> f64 {
        let hz = k * self.params.sample_rate as f64 / self.params.n_fft as f64;
        match self.params.scale {
            FreqScale::Linear => k,
            FreqScale::Mel { bands, f_min, f_max } => {
                let (m0, m1) = (hz_to_mel(f_min), hz_to_mel(f_max));
                (hz_to_mel(hz) - m0) / (m1 - m0) * (bands + 1) as f64 - 1.0
            }
            FreqScale::Log { bands, f_min, f_max } => {
                if hz <= 0.0 { return -1.0; }
                (hz.ln() - f_min.ln()) / (f_max.ln() - f_min.ln()) * (bands + 1) as f64 - 1.0
            }
        }
    }

    /// Phase of one frame per output row (see `Output::Phase`).
    fn frame_phase(&self, frame: &[f32], s: &mut Scratch, row: &mut [f32]) {
        self.fft_into(frame, &self.win, s, 0);
        if self.fb.is_empty() {
            for (o, c) in row.iter_mut().zip(&s.spec) { *o = c.im.atan2(c.re); }
            return;
        }
        for (o, b) in row.iter_mut().zip(&self.fb) {
            let (mut sin, mut cos) = (0f64, 0f64);
            for (&w, c) in b.weights.iter().zip(&s.spec[b.start..]) {
                let ph = (c.im as f64).atan2(c.re as f64);
                sin += w as f64 * ph.sin();
                cos += w as f64 * ph.cos();
            }
            *o = sin.atan2(cos) as f32;
        }
    }

    /// Linear power (phase for `Output::Phase`) for frames [f0, f0+n) →
    /// `out` (n × out_bins). `samples` covers `sample_range(f0, n)`.
    pub fn power_block(&self, samples: &[f32], n: usize, out: &mut [f32]) {
        let bins = self.params.out_bins();
        assert_eq!(out.len(), n * bins);
        if self.params.reassign { return self.reassigned_block(samples, n, out); }
        let phase = self.params.output == Output::Phase;
        const PER_TASK: usize = 32;
        let hop = self.params.hop;
        let wl = self.params.win_len;
        let task = |scratch: &mut Scratch, t: usize, chunk: &mut [f32]| {
            for (j, row) in chunk.chunks_mut(bins).enumerate() {
                let off = (t * PER_TASK + j) * hop;
                if phase { self.frame_phase(&samples[off..off + wl], scratch, row); continue; }
                self.frame_power(&samples[off..off + wl], scratch);
                self.reduce(&scratch.power, row);
            }
        };
        #[cfg(feature = "parallel")]
        out.par_chunks_mut(bins * PER_TASK).enumerate().for_each_init(|| self.scratch(), |s, (t, c)| task(s, t, c));
        #[cfg(not(feature = "parallel"))]
        { let mut s = self.scratch(); for (t, c) in out.chunks_mut(bins * PER_TASK).enumerate() { task(&mut s, t, c); } }
    }

    /// Reassigned power: each STFT cell's energy moves to its instantaneous
    /// frequency / group delay; energy is summed per output cell.
    /// Energy reassigned outside the block is dropped.
    fn reassigned_block(&self, samples: &[f32], n: usize, out: &mut [f32]) {
        let bins = self.params.out_bins();
        let (hop, wl, nfft) = (self.params.hop as f64, self.params.win_len, self.params.n_fft as f64);
        let k_amp = self.amp_scale;
        // Divide by ENBW for band scales so levels match the plain path.
        let k_band = if self.fb.is_empty() { 1.0 } else { 1.0 / self.enbw };
        // Main-lobe half-width of the widest supported window is 4 bins of win_len.
        let max_dk = 4.0 * nfft / wl as f64;
        out.fill(0.0);
        let mut s = self.scratch();
        for f in 0..n {
            let frame = &samples[f * self.params.hop..f * self.params.hop + wl];
            self.fft_into(frame, &self.win, &mut s, 0);
            self.fft_into(frame, &self.win_t, &mut s, 1);
            self.fft_into(frame, &self.win_d, &mut s, 2);
            for k in 0..s.spec.len() {
                let x = s.spec[k];
                let mag2 = (x.re * x.re + x.im * x.im) as f64;
                if mag2 < 1e-30 { continue; }
                let (xt, xd) = (s.spec_t[k], s.spec_d[k]);
                // t̂ = t + Re(X_th / X_h), ω̂ = ω − Im(X_dh / X_h)
                let dt = (xt.re * x.re + xt.im * x.im) as f64 / mag2;
                let dw = -((xd.im * x.re - xd.re * x.im) as f64) / mag2;
                let dk = dw * nfft / (2.0 * PI);
                // Unreliable estimates (|X| ≈ 0) can move energy arbitrarily far;
                // physical shifts stay within half a window / one main lobe.
                if dt.abs() > wl as f64 / 2.0 || dk.abs() > max_dk { continue; }
                let kk = k as f64 + dk;
                let ff = f as f64 + dt / hop;
                // Bilinear splat: continuous in the corrected coordinates, so
                // tiny numeric differences (SIMD vs scalar FFT) cannot flip
                // energy between cells.
                let (row, col) = (self.row_of_fft_bin(kk), ff);
                let (r0, c0) = (row.floor(), col.floor());
                let (fr, fc) = (row - r0, col - c0);
                let e = mag2 * k_amp * k_band;
                for (dr, wr) in [(0.0, 1.0 - fr), (1.0, fr)] {
                    for (dc, wc) in [(0.0, 1.0 - fc), (1.0, fc)] {
                        let (r, c) = (r0 + dr, c0 + dc);
                        if r < 0.0 || r >= bins as f64 || c < 0.0 || c >= n as f64 { continue; }
                        out[c as usize * bins + r as usize] += (e * wr * wc) as f32;
                    }
                }
            }
        }
    }

    /// PCEN smoother coefficient per frame (librosa's formula from T).
    fn pcen_b(&self, p: &Pcen) -> f64 {
        let t = p.time_constant * self.params.sample_rate as f64 / self.params.hop as f64;
        ((1.0 + 4.0 * t * t).sqrt() - 1.0) / (2.0 * t * t)
    }

    /// Frames to average for the initial PCEN state: one time constant.
    fn pcen_init_frames(&self) -> usize {
        self.params.pcen.map_or(0, |p| (p.time_constant * self.params.sample_rate as f64 / self.params.hop as f64).ceil() as usize).max(1)
    }

    /// Initial PCEN state = mean magnitude of the given power frames. Starting
    /// from the first frame alone (librosa) makes a quiet or fading-in start
    /// look like loud noise for several time constants.
    pub fn pcen_state_from(&self, power: &[f32]) -> PcenState {
        let bins = self.params.out_bins();
        let n = (power.len() / bins).max(1);
        let mut m = vec![0f64; bins];
        for frame in power.chunks(bins) {
            for (a, &e) in m.iter_mut().zip(frame) { *a += e.max(0.0).sqrt() as f64 * PCEN_SCALE; }
        }
        m.iter_mut().for_each(|a| *a /= n as f64);
        PcenState(m)
    }

    /// Power → dBFS, PCEN or magnitude, in place (phase stays). Frames must arrive in order.
    pub fn finalize(&self, data: &mut [f32], state: &mut PcenState) {
        let bins = self.params.out_bins();
        match self.params.output {
            Output::Phase => return,
            Output::Magnitude => return data.iter_mut().for_each(|v| *v = v.max(0.0).sqrt()),
            Output::Db => {}
        }
        match self.params.pcen {
            None => data.iter_mut().for_each(|v| *v = if *v > 0.0 { (10.0 * v.log10()).max(DB_FLOOR) } else { DB_FLOOR }),
            Some(p) => {
                // librosa conventions: magnitude scaled to 32-bit integer range.
                let b = self.pcen_b(&p);
                let offset = p.bias.powf(p.power);
                if state.0.len() != bins {
                    *state = self.pcen_state_from(&data[..bins.min(data.len())]);
                }
                for frame in data.chunks_mut(bins) {
                    for (e, m) in frame.iter_mut().zip(state.0.iter_mut()) {
                        let s = e.max(0.0).sqrt() as f64 * PCEN_SCALE;
                        *m = (1.0 - b) * *m + b * s;
                        let agc = (p.eps + *m).powf(-p.gain);
                        *e = ((s * agc + p.bias).powf(p.power) - offset) as f32;
                    }
                }
            }
        }
    }

    /// Extra frames on each side so reassigned energy near block edges is
    /// not lost (group delay is bounded by half a window).
    fn reassign_margin(&self) -> u64 {
        if self.params.reassign { (self.params.win_len / 2).div_ceil(self.params.hop) as u64 + 1 } else { 0 }
    }

    /// Frames before a block needed so an independently computed block
    /// matches the sequential PCEN result within `tol` (0 without PCEN).
    pub fn pcen_warmup(&self, tol: f64) -> usize {
        match self.params.pcen {
            Some(p) => (tol.ln() / (1.0 - self.pcen_b(&p)).ln()).ceil() as usize,
            None => 0,
        }
    }

    /// Frames [lo, hi) that must be computed to produce frames [f0, f0+n)
    /// independently (warm-up + reassignment margins).
    pub fn block_frame_range(&self, f0: u64, n: usize, total: u64, warmup: usize) -> (u64, u64) {
        let m = self.reassign_margin();
        let pre = m + if f0 == 0 { 0 } else { warmup as u64 };
        (f0.saturating_sub(pre), (f0 + n as u64 + m).min(total).max(f0 + n as u64))
    }

    /// Power for frames [lo, hi) from samples that start at sample `first`
    /// (any part of the needed range outside `samples` is zero).
    fn power_range(&self, samples: &[f32], first: i64, lo: u64, hi: u64) -> Vec<f32> {
        let (start, len) = self.sample_range(lo, (hi - lo) as usize);
        let mut buf = vec![0f32; len];
        let skip = (first - start).max(0) as usize;
        let from = (start - first).max(0) as usize;
        if skip < len && from < samples.len() {
            let k = (len - skip).min(samples.len() - from);
            buf[skip..skip + k].copy_from_slice(&samples[from..from + k]);
        }
        let mut out = vec![0f32; (hi - lo) as usize * self.params.out_bins()];
        self.power_block(&buf, (hi - lo) as usize, &mut out);
        out
    }

    /// Finalized values for frames [f0, f0+n), independent of other blocks
    /// (for parallel workers). `samples` start at sample `first` and should
    /// cover `sample_range` of `block_frame_range(f0, n, total, warmup)`.
    pub fn block_values(&self, samples: &[f32], first: i64, f0: u64, n: usize, total: u64, warmup: usize) -> Vec<f32> {
        let bins = self.params.out_bins();
        let (lo, hi) = self.block_frame_range(f0, n, total, warmup);
        let mut data = self.power_range(samples, first, lo, hi);
        let mut state = if lo == 0 && self.params.pcen.is_some() {
            let k = self.pcen_init_frames().min((hi - lo) as usize);
            self.pcen_state_from(&data[..k * bins])
        } else {
            self.new_pcen_state()
        };
        self.finalize(&mut data, &mut state);
        let a = (f0 - lo) as usize * bins;
        data[a..a + n * bins].to_vec()
    }

    /// Stream the whole source in blocks; `sink(first_frame, values)`.
    pub fn run<S: SampleSource, F: FnMut(u64, &[f32]) -> std::io::Result<()>>(
        &self, src: &mut S, block_frames: usize, mut sink: F,
    ) -> std::io::Result<u64> {
        let total = self.params.n_frames(src.len());
        let bins = self.params.out_bins();
        let mut samples = Vec::new();
        let mut state = self.new_pcen_state();
        if self.params.pcen.is_some() {
            let k = (self.pcen_init_frames() as u64).min(total);
            let (start, len) = self.sample_range(0, k as usize);
            read_padded(src, start, len, &mut samples)?;
            state = self.pcen_state_from(&self.power_range(&samples, start, 0, k));
        }
        let mut f0 = 0u64;
        while f0 < total {
            let n = block_frames.max(1).min((total - f0) as usize);
            let (lo, hi) = self.block_frame_range(f0, n, total, 0);
            let (start, len) = self.sample_range(lo, (hi - lo) as usize);
            read_padded(src, start, len, &mut samples)?;
            let mut out = self.power_range(&samples, start, lo, hi);
            let a = (f0 - lo) as usize * bins;
            out.truncate(a + n * bins);
            out.drain(..a);
            self.finalize(&mut out, &mut state);
            sink(f0, &out)?;
            f0 += n as u64;
        }
        Ok(total)
    }

    /// Convenience: whole signal in memory → (frames × out_bins) values.
    pub fn compute(&self, audio: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        self.run(&mut crate::MemSource(audio), 4096, |_, v| { out.extend_from_slice(v); Ok(()) }).unwrap();
        out
    }
}

/// Read `len` samples starting at `start` (may be negative / past the end),
/// zero-filling outside the signal.
pub fn read_padded<S: SampleSource>(src: &mut S, start: i64, len: usize, buf: &mut Vec<f32>) -> std::io::Result<()> {
    buf.clear();
    buf.resize(len, 0.0);
    let skip = (-start).max(0) as usize;
    if skip >= len { return Ok(()); }
    let from = start.max(0) as u64;
    let got = src.read(from, &mut buf[skip..])?;
    buf[skip + got..].fill(0.0);
    Ok(())
}

// ─── Statistics for display ─────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayStats {
    /// Median over all cells — a robust noise-floor estimate for sparse
    /// signals such as bird song.
    pub median: f32,
    pub p99_9: f32,
    pub max: f32,
    /// Median per output row (low → high): per-band noise floor.
    pub band_floor: Vec<f32>,
}

pub fn display_stats(values: &[f32], bins: usize) -> DisplayStats {
    if values.is_empty() || bins == 0 { return DisplayStats::default(); }
    let frames = values.len() / bins;
    let stride = (values.len() / 1_000_000).max(1);
    let mut all: Vec<f32> = values.iter().step_by(stride).copied().filter(|v| v.is_finite()).collect();
    all.sort_unstable_by(f32::total_cmp);
    let pct = |v: &[f32], p: f64| v.get(((v.len().max(1) - 1) as f64 * p) as usize).copied().unwrap_or(0.0);
    let fstride = (frames / 4000).max(1);
    let band_floor = (0..bins).map(|b| {
        let mut col: Vec<f32> = (0..frames).step_by(fstride).map(|f| values[f * bins + b]).collect();
        col.sort_unstable_by(f32::total_cmp);
        pct(&col, 0.5)
    }).collect();
    DisplayStats { median: pct(&all, 0.5), p99_9: pct(&all, 0.999), max: *all.last().unwrap_or(&0.0), band_floor }
}
