//! Perch-2-Embeddings per ONNX Runtime.
//!
//! Modell: 5 s Rohaudio @ 32 kHz (160 000 Samples) -> 1536-dim Embedding.
//! Die Spektrogramm-Vorverarbeitung steckt im Modell.

use std::path::Path;

pub const SAMPLE_RATE: u32 = 32_000;
pub const WINDOW: usize = 160_000;
pub const DIM: usize = 1536;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// WAV lesen, auf Mono mischen, als f32 zurueckgeben.
pub fn read_wav_mono(path: impl AsRef<Path>) -> Result<(Vec<f32>, u32), Error> {
    let mut r = hound::WavReader::open(path)?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let inter: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>()?
        }
    };
    let mono = inter.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect();
    Ok((mono, spec.sample_rate))
}

/// Polyphasen-Resampling auf 32 kHz, Nachbau von `scipy.signal.resample_poly`
/// (Kaiser-FIR, beta = 5, half_len = 10 * max(up, down)). Gleiche Ausgabe wie
/// die Perch-Referenz-Pipeline (Hoplite/Python) bis auf Rundung.
pub fn resample_to_32k(x: &[f32], sr: u32) -> Result<Vec<f32>, Error> {
    Ok(resample_poly(x, SAMPLE_RATE, sr))
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Modifizierte Besselfunktion I0 (Reihenentwicklung).
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, q) = (1.0, 1.0, x * x / 4.0);
    for k in 1..200 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

/// `scipy.signal.firwin(n, cutoff, window=("kaiser", beta))`, DC-normiert.
fn firwin_kaiser(n: usize, cutoff: f64, beta: f64) -> Vec<f64> {
    let alpha = (n - 1) as f64 / 2.0;
    let i0b = bessel_i0(beta);
    let mut h: Vec<f64> = (0..n)
        .map(|i| {
            let m = i as f64 - alpha;
            let a = std::f64::consts::PI * cutoff * m;
            let sinc = if m == 0.0 { 1.0 } else { a.sin() / a };
            let r = 2.0 * i as f64 / (n - 1) as f64 - 1.0;
            cutoff * sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b
        })
        .collect();
    let s: f64 = h.iter().sum();
    h.iter_mut().for_each(|v| *v /= s);
    h
}

pub fn resample_poly(x: &[f32], target: u32, sr: u32) -> Vec<f32> {
    if sr == target {
        return x.to_vec();
    }
    let g = gcd(target, sr);
    let (up, down) = ((target / g) as usize, (sr / g) as usize);
    let max_rate = up.max(down);
    let half_len = 10 * max_rate;
    let h: Vec<f64> = firwin_kaiser(2 * half_len + 1, 1.0 / max_rate as f64, 5.0)
        .into_iter()
        .map(|v| v * up as f64)
        .collect();
    let n_out = (x.len() * up).div_ceil(down);
    let n_pre_pad = down - half_len % down;
    let n_pre_remove = (half_len + n_pre_pad) / down;
    let hl = h.len() as isize;
    let (up_i, nx) = (up as isize, x.len() as isize);
    let out = |n: usize| -> f32 {
        // Position im hochgetasteten Signal, h vorne um n_pre_pad Nullen verschoben
        let j0 = ((n + n_pre_remove) * down) as isize - n_pre_pad as isize;
        let mut k = j0.rem_euclid(up_i);
        let mut acc = 0f64;
        while k < hl {
            let xi = (j0 - k) / up_i;
            if xi < 0 {
                break;
            }
            if xi < nx {
                acc += h[k as usize] * x[xi as usize] as f64;
            }
            k += up_i;
        }
        acc as f32
    };
    (0..n_out).map(out).collect()
}

/// Audio in 5-s-Fenster schneiden (Hop in Samples), letztes Fenster mit Nullen auffuellen.
/// Optional pro Fenster Mittelwert entfernen und auf Peak normieren.
pub fn frame(x: &[f32], hop: usize, normalize: bool) -> Vec<f32> {
    let n = if x.len() <= WINDOW { 1 } else { (x.len() - WINDOW).div_ceil(hop) + 1 };
    let mut out = vec![0f32; n * WINDOW];
    for i in 0..n {
        let s = i * hop;
        let e = (s + WINDOW).min(x.len());
        let w = &mut out[i * WINDOW..(i + 1) * WINDOW];
        w[..e - s].copy_from_slice(&x[s..e]);
        if normalize {
            let m = w[..e - s].iter().sum::<f32>() / (e - s).max(1) as f32;
            w[..e - s].iter_mut().for_each(|v| *v -= m);
            let p = w.iter().fold(0f32, |a, v| a.max(v.abs()));
            if p > 0.0 {
                w.iter_mut().for_each(|v| *v /= p);
            }
        }
    }
    out
}

pub struct Embedder {
    session: ort::session::Session,
}

impl Embedder {
    pub fn new(model: impl AsRef<Path>, threads: usize) -> Result<Self, Error> {
        let session = ort::session::Session::builder()?
            .with_intra_threads(threads)?
            .commit_from_file(model)?;
        Ok(Self { session })
    }

    /// `windows`: n * WINDOW Samples. Liefert n * DIM Werte.
    pub fn embed(&mut self, windows: &[f32], batch: usize) -> Result<Vec<f32>, Error> {
        let n = windows.len() / WINDOW;
        let mut out = Vec::with_capacity(n * DIM);
        for b in windows.chunks(batch * WINDOW) {
            let bn = b.len() / WINDOW;
            let t = ort::value::Tensor::from_array(([bn, WINDOW], b.to_vec().into_boxed_slice()))?;
            let res = self.session.run(ort::inputs!["inputs" => t])?;
            let (_, e) = res["embedding"].try_extract_tensor::<f32>()?;
            out.extend_from_slice(e);
        }
        Ok(out)
    }
}
