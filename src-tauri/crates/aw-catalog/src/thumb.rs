//! Spectrogram thumbnails for the library grid.
//!
//! A thumbnail shows the whole recording: short files are decoded completely and every column takes
//! the loudest frame of its time span; long files are sampled at `w` evenly spaced points (seek + a
//! few FFT frames each), so a 10 h night costs about as much as a 1 min clip. Values are dB with the
//! per-frequency 20th percentile removed (steady noise and hum fade), scaled to 0..255. Row 0 is the top
//! (highest frequency). Results are cached in the `thumb` table.

use crate::{Catalog, Result, now_ms};
use rusqlite::{OptionalExtension, params};
use std::fs::File;
use std::path::Path;

const NFFT: usize = 512;
/// FFT frames read per column when sampling a long file.
const FRAMES_PER_COL: usize = 4;
/// Files up to this many sample frames are decoded completely (≈ 2 min at 48 kHz).
const FULL_DECODE_MAX: u64 = 6_000_000;

#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbSpec { pub w: u32, pub h: u32, pub max_hz: f64 }

impl ThumbSpec {
    fn clamp(self) -> Self {
        Self { w: self.w.clamp(16, 512), h: self.h.clamp(8, 256), max_hz: if self.max_hz > 0.0 { self.max_hz } else { 12_000.0 } }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumb {
    pub recording_id: i64,
    pub w: u32,
    pub h: u32,
    /// Top frequency actually shown (lower than asked when the file's Nyquist frequency is lower).
    pub max_hz: f64,
    pub data: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbResult {
    pub recording_id: i64,
    pub thumb: Option<Thumb>,
    pub error: Option<String>,
}

/// Cached thumbnail of the given size, if any.
pub fn cached(cat: &Catalog, recording_id: i64, spec: ThumbSpec) -> Result<Option<Thumb>> {
    let spec = spec.clamp();
    Ok(cat.conn.query_row(
        "SELECT w, h, max_hz, data FROM thumb WHERE recording_id = ?1 AND w = ?2 AND h = ?3",
        params![recording_id, spec.w, spec.h],
        |r| Ok(Thumb { recording_id, w: r.get(0)?, h: r.get(1)?, max_hz: r.get(2)?, data: r.get(3)? })).optional()?)
}

pub fn store(cat: &Catalog, t: &Thumb) -> Result<()> {
    cat.conn.execute(
        "INSERT OR REPLACE INTO thumb(recording_id, w, h, max_hz, data, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![t.recording_id, t.w, t.h, t.max_hz, t.data, now_ms()])?;
    Ok(())
}

pub fn clear(cat: &Catalog) -> Result<usize> { Ok(cat.conn.execute("DELETE FROM thumb", [])?) }

/// Thumbnails for several recordings: cached ones from the catalog, the rest rendered from the
/// files on this machine (`machine`, see `root_location`). The catalog lock is only held for the
/// database steps, never while decoding.
pub fn thumbs(cat: &std::sync::Mutex<Catalog>, ids: &[i64], spec: ThumbSpec, machine: &str) -> Vec<ThumbResult> {
    let spec = spec.clamp();
    let fail = |id, e: String| ThumbResult { recording_id: id, thumb: None, error: Some(e) };
    ids.iter().map(|&id| {
        let looked = cat.lock().map_err(|e| e.to_string()).and_then(|c| {
            let hit = cached(&c, id, spec).map_err(|e| e.to_string())?;
            let path = if hit.is_none() { crate::recording_path(&c, id, machine).map_err(|e| e.to_string())? } else { None };
            Ok((hit, path))
        });
        let (hit, path) = match looked { Ok(x) => x, Err(e) => return fail(id, e) };
        if let Some(t) = hit { return ThumbResult { recording_id: id, thumb: Some(t), error: None }; }
        let Some(path) = path else { return fail(id, "file not located on this computer".into()) };
        match render(&path, spec) {
            Ok((data, max_hz)) => {
                let t = Thumb { recording_id: id, w: spec.w, h: spec.h, max_hz, data };
                if let Ok(c) = cat.lock() { let _ = store(&c, &t); }
                ThumbResult { recording_id: id, thumb: Some(t), error: None }
            }
            Err(e) => fail(id, e.to_string()),
        }
    }).collect()
}

/// Render a thumbnail from an audio file. Returns the bytes (w*h) and the top frequency shown.
pub fn render(path: &Path, spec: ThumbSpec) -> std::io::Result<(Vec<u8>, f64)> {
    let spec = spec.clamp();
    let mut src = Source::open(path)?;
    let sr = src.sample_rate as f64;
    let w = spec.w as usize;
    let mut cols: Vec<Vec<f32>> = vec![Vec::new(); w];
    let window: Vec<f32> = (0..NFFT).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / NFFT as f32).cos()).collect();
    let mut fft = Fft::new(NFFT);

    let full = src.frames.is_none_or(|n| n <= FULL_DECODE_MAX);
    if full {
        // Whole file; each column keeps the loudest value per bin over its frames.
        let mut frames: Vec<Vec<f32>> = Vec::new();
        let mut buf = Vec::with_capacity(NFFT);
        while let Some(chunk) = src.next_samples()? {
            for s in chunk {
                buf.push(s);
                if buf.len() == NFFT { frames.push(fft.power(&buf, &window)); buf.clear(); }
            }
        }
        if frames.is_empty() && !buf.is_empty() { buf.resize(NFFT, 0.0); frames.push(fft.power(&buf, &window)); }
        let n = frames.len();
        if n == 0 { return Err(std::io::Error::other("no audio")); }
        for (c, col) in cols.iter_mut().enumerate() {
            let (a, b) = (c * n / w, ((c + 1) * n / w).max(c * n / w + 1).min(n));
            if a >= n { continue; }
            *col = max_of(&frames[a..b]);
        }
        // Files shorter than the grid: stretch instead of leaving empty columns.
        if n < w { for c in 0..w { cols[c] = frames[c * n / w].clone(); } }
    } else {
        let total = src.frames.unwrap_or(0);
        let need = NFFT * FRAMES_PER_COL;
        for (c, col) in cols.iter_mut().enumerate() {
            let at = (total as f64 * (c as f64 + 0.5) / w as f64) as u64;
            let at = at.saturating_sub(need as u64 / 2);
            src.seek(at)?;
            let mut buf: Vec<f32> = Vec::with_capacity(need);
            while buf.len() < need {
                match src.next_samples()? { Some(s) => buf.extend(s), None => break }
            }
            let frames: Vec<Vec<f32>> = buf.chunks_exact(NFFT).map(|f| fft.power(f, &window)).collect();
            if !frames.is_empty() { *col = max_of(&frames); }
        }
    }

    let max_hz = spec.max_hz.min(sr / 2.0);
    let bins = NFFT / 2 + 1;
    let top_bin = ((max_hz / (sr / 2.0)) * (bins - 1) as f64).round().max(1.0) as usize;
    let h = spec.h as usize;
    // dB image (row 0 = top), NaN where a column is empty.
    let mut img = vec![f32::NAN; w * h];
    for (c, col) in cols.iter().enumerate() {
        if col.is_empty() { continue; }
        for r in 0..h {
            let lo = (h - 1 - r) * top_bin / h;
            let hi = ((h - r) * top_bin / h).max(lo + 1).min(bins);
            let p = col[lo..hi].iter().cloned().fold(0.0f32, f32::max);
            img[r * w + c] = 10.0 * (p + 1e-12).log10();
        }
    }
    Ok((scale(&img, w, h), max_hz))
}

/// Remove each row's 20th percentile (steady background) and map 0 dB .. top (≥ 20 dB) to 0..255.
fn scale(img: &[f32], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0f32; w * h];
    for r in 0..h {
        let row = &img[r * w..(r + 1) * w];
        let mut v: Vec<f32> = row.iter().cloned().filter(|x| x.is_finite()).collect();
        if v.is_empty() { continue; }
        v.sort_by(|a, b| a.total_cmp(b));
        let med = v[v.len() / 5];
        for c in 0..w { out[r * w + c] = if row[c].is_finite() { (row[c] - med).max(0.0) } else { 0.0 }; }
    }
    let mut all: Vec<f32> = out.clone();
    all.sort_by(|a, b| a.total_cmp(b));
    let top = all[((all.len() as f64 * 0.997) as usize).min(all.len() - 1)].max(20.0);
    out.iter().map(|&x| ((x / top).clamp(0.0, 1.0) * 255.0).round() as u8).collect()
}

fn max_of(frames: &[Vec<f32>]) -> Vec<f32> {
    let mut m = frames[0].clone();
    for f in &frames[1..] { for (a, b) in m.iter_mut().zip(f) { *a = a.max(*b); } }
    m
}

// ── Decoding (symphonia), mono f32 ───────────────────────────────────────

struct Source {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_rate: u32,
    frames: Option<u64>,
}

impl Source {
    fn open(path: &Path) -> std::io::Result<Self> {
        use symphonia::core::{codecs::DecoderOptions, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
        let e = |x: symphonia::core::errors::Error| std::io::Error::other(x.to_string());
        let mss = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions { enable_gapless: false, ..Default::default() }, &MetadataOptions::default()).map_err(e)?;
        let format = probed.format;
        let track = format.default_track().ok_or_else(|| std::io::Error::other("no audio track"))?;
        let p = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs().make(&p, &DecoderOptions::default()).map_err(e)?;
        Ok(Self { track_id: track.id, sample_rate: p.sample_rate.unwrap_or(48_000), frames: p.n_frames, format, decoder })
    }

    fn seek(&mut self, frame: u64) -> std::io::Result<()> {
        use symphonia::core::formats::{SeekMode, SeekTo};
        self.format.seek(SeekMode::Coarse, SeekTo::TimeStamp { ts: frame, track_id: self.track_id })
            .map_err(|x| std::io::Error::other(x.to_string()))?;
        self.decoder.reset();
        Ok(())
    }

    /// Next decoded packet mixed to mono; `None` at the end of the stream.
    fn next_samples(&mut self) -> std::io::Result<Option<Vec<f32>>> {
        use symphonia::core::{audio::SampleBuffer, errors::Error};
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(Error::IoError(x)) if x.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(Error::ResetRequired) => return Ok(None),
                Err(x) => return Err(std::io::Error::other(x.to_string())),
            };
            if packet.track_id() != self.track_id { continue; }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(Error::DecodeError(_)) => continue,
                Err(x) => return Err(std::io::Error::other(x.to_string())),
            };
            let spec = *decoded.spec();
            let ch = spec.channels.count().max(1);
            let mut sb = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            sb.copy_interleaved_ref(decoded);
            let s = sb.samples();
            return Ok(Some(s.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect()));
        }
    }
}

// ── Small radix-2 FFT (power spectrum of a real frame) ───────────────────

struct Fft { n: usize, cos: Vec<f32>, sin: Vec<f32>, re: Vec<f32>, im: Vec<f32> }

impl Fft {
    fn new(n: usize) -> Self {
        assert!(n.is_power_of_two());
        let (cos, sin) = (0..n / 2).map(|k| {
            let a = -2.0 * std::f32::consts::PI * k as f32 / n as f32;
            (a.cos(), a.sin())
        }).unzip();
        Self { n, cos, sin, re: vec![0.0; n], im: vec![0.0; n] }
    }

    fn power(&mut self, frame: &[f32], window: &[f32]) -> Vec<f32> {
        let n = self.n;
        let bits = n.trailing_zeros();
        for i in 0..n {
            let j = i.reverse_bits() >> (usize::BITS - bits);
            self.re[j] = frame.get(i).copied().unwrap_or(0.0) * window[i];
            self.im[j] = 0.0;
        }
        let mut len = 2;
        while len <= n {
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..len / 2 {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + len / 2);
                    let tr = self.re[b] * c - self.im[b] * s;
                    let ti = self.re[b] * s + self.im[b] * c;
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
            }
            len *= 2;
        }
        (0..=n / 2).map(|k| self.re[k] * self.re[k] + self.im[k] * self.im[k]).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16-bit mono WAV: `tone(t)` gives the frequency (Hz) at second t, or None for silence.
    fn wav(path: &Path, sr: u32, secs: f64, tone: impl Fn(f64) -> Option<f64>) {
        let n = (sr as f64 * secs) as u32;
        let mut b = Vec::new();
        b.extend(b"RIFF"); b.extend((36 + n * 2).to_le_bytes()); b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes()); b.extend(1u16.to_le_bytes()); b.extend(1u16.to_le_bytes());
        b.extend(sr.to_le_bytes()); b.extend((sr * 2).to_le_bytes()); b.extend(2u16.to_le_bytes()); b.extend(16u16.to_le_bytes());
        b.extend(b"data"); b.extend((n * 2).to_le_bytes());
        let mut phase = 0.0f64;
        let mut seed = 1u32;
        for i in 0..n {
            let t = i as f64 / sr as f64;
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = ((seed >> 16) as f64 / 65536.0 - 0.5) * 200.0;
            let v = match tone(t) {
                Some(f) => { phase += 2.0 * std::f64::consts::PI * f / sr as f64; phase.sin() * 12_000.0 }
                None => 0.0,
            };
            b.extend(((v + noise) as i16).to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    /// Row with the highest value in column c.
    fn peak_row(d: &[u8], w: usize, h: usize, c: usize) -> (usize, u8) {
        (0..h).map(|r| (r, d[r * w + c])).max_by_key(|x| x.1).unwrap()
    }

    #[test]
    fn short_file_shows_tone_at_its_frequency_and_time() {
        let dir = std::env::temp_dir().join(format!("aw-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("short.wav");
        // 10 s, 4 kHz tone in the second half only.
        wav(&p, 24_000, 10.0, |t| (t >= 5.0).then_some(4000.0));
        let spec = ThumbSpec { w: 40, h: 24, max_hz: 12_000.0 };
        let (d, max_hz) = render(&p, spec).unwrap();
        assert_eq!(max_hz, 12_000.0);
        assert_eq!(d.len(), 40 * 24);
        // 4 kHz of 12 kHz → a third up from the bottom: row ≈ 24 - 8 - 1 = 15.
        let (r, v) = peak_row(&d, 40, 24, 30);
        assert!((14..=16).contains(&r), "row {r}");
        assert!(v > 200);
        // First half: nothing loud.
        assert!(peak_row(&d, 40, 24, 5).1 < 60, "{:?}", peak_row(&d, 40, 24, 5));
    }

    #[test]
    fn long_file_is_sampled_and_capped_at_nyquist() {
        let dir = std::env::temp_dir().join(format!("aw-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("long.wav");
        // 8 kHz sample rate, 13 min (> FULL_DECODE_MAX frames), tone 2 kHz rising to 3 kHz halfway.
        wav(&p, 8_000, 780.0, |t| Some(if t < 390.0 { 2000.0 } else { 3000.0 }));
        let spec = ThumbSpec { w: 20, h: 16, max_hz: 12_000.0 };
        let (d, max_hz) = render(&p, spec).unwrap();
        assert_eq!(max_hz, 4000.0);
        // 2 kHz of 4 kHz → middle (row 7/8); 3 kHz → row ≈ 3.
        assert!((7..=8).contains(&peak_row(&d, 20, 16, 2).0), "{:?}", peak_row(&d, 20, 16, 2));
        assert!((3..=4).contains(&peak_row(&d, 20, 16, 17).0), "{:?}", peak_row(&d, 20, 16, 17));
    }

    #[test]
    fn cache_roundtrip() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        let t = Thumb { recording_id: 7, w: 16, h: 8, max_hz: 1000.0, data: vec![3; 128] };
        store(&cat, &t).unwrap();
        let spec = ThumbSpec { w: 16, h: 8, max_hz: 1000.0 };
        assert_eq!(cached(&cat, 7, spec).unwrap().unwrap().data, vec![3; 128]);
        assert!(cached(&cat, 7, ThumbSpec { w: 32, ..spec }).unwrap().is_none());
        assert_eq!(clear(&cat).unwrap(), 1);
    }
}
