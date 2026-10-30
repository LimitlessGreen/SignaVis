// On-disk multi-resolution spectrogram store.
//
// Layout of a store directory:
//   L0.f16, L1.f16, …   row-major [frame][bin], IEEE half floats (LE)
//   meta.json           written last — its presence marks a complete store
//
// Level k+1 max-pools FACTOR consecutive frames of level k, so short
// calls stay visible in overview levels. Values are stored as f16
// (display precision is 8 bit anyway) and served as f32, so the frontend
// keeps its existing float-based contrast pipeline.

use crate::{SampleSource, SpecEngine, SpecParams};
use serde::de::DeserializeOwned;
use half::f16;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const FACTOR: u64 = 4;
/// Stop adding levels once a level has at most this many frames.
const MIN_LEVEL_FRAMES: u64 = 2048;
/// Upper bound on values kept for percentile estimation.
const STATS_SAMPLES: u64 = 2_000_000;
const BLOCK_FRAMES: usize = 6000;
pub const FORMAT_VERSION: u32 = 2;
/// Store format for `v2::StftParams` (dBFS / PCEN, centred frames).
pub const FORMAT_VERSION_V2: u32 = 3;

/// What the pyramid needs to know about a parameter set.
pub trait Layout: Clone + Serialize + DeserializeOwned {
    const VERSION: u32;
    fn out_bins(&self) -> usize;
    fn n_frames(&self, n_samples: u64) -> u64;
}

impl Layout for SpecParams {
    const VERSION: u32 = FORMAT_VERSION;
    fn out_bins(&self) -> usize { SpecParams::out_bins(self) }
    fn n_frames(&self, n: u64) -> u64 { SpecParams::n_frames(self, n) }
}

impl Layout for crate::v2::StftParams {
    const VERSION: u32 = FORMAT_VERSION_V2;
    fn out_bins(&self) -> usize { crate::v2::StftParams::out_bins(self) }
    fn n_frames(&self, n: u64) -> u64 { crate::v2::StftParams::n_frames(self, n) }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelMeta {
    pub factor: u64,
    pub n_frames: u64,
    /// Contrast range of this level. Max-pooled levels are brighter than
    /// level 0, so each level needs its own black/white point.
    pub stats: Stats,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub min: f32, pub max: f32, pub p2: f32, pub p98: f32,
    /// Robust noise-floor estimate (sparse signals such as bird song).
    #[serde(default)] pub median: f32,
    #[serde(default)] pub p99_9: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", bound = "P: Layout")]
pub struct PyramidMeta<P = SpecParams> {
    pub version: u32,
    pub params: P,
    pub n_samples: u64,
    pub bins: usize,
    pub levels: Vec<LevelMeta>,
    /// Same as `levels[0].stats`.
    pub stats: Stats,
}

fn level_path(dir: &Path, k: usize) -> PathBuf { dir.join(format!("L{k}.f16")) }

fn level_count(n_frames: u64) -> usize {
    let mut n = n_frames;
    let mut levels = 1;
    while n > MIN_LEVEL_FRAMES {
        n = n.div_ceil(FACTOR);
        levels += 1;
    }
    levels
}

/// Receives encoded f16 frame bytes per level, in order.
pub trait LevelSink {
    fn write(&mut self, level: usize, bytes: &[u8]) -> io::Result<()>;
}

struct FileSink(Vec<BufWriter<File>>);

impl LevelSink for FileSink {
    fn write(&mut self, level: usize, bytes: &[u8]) -> io::Result<()> { self.0[level].write_all(bytes) }
}

/// Collects bytes in memory; the caller drains them (used by the wasm build).
#[derive(Default)]
pub struct VecSink(pub Vec<Vec<u8>>);

impl LevelSink for VecSink {
    fn write(&mut self, level: usize, bytes: &[u8]) -> io::Result<()> {
        if self.0.len() <= level { self.0.resize_with(level + 1, Vec::new); }
        self.0[level].extend_from_slice(bytes);
        Ok(())
    }
}

/// Streaming min/max plus a strided sample for percentiles.
struct StatsAcc { stride: u64, idx: u64, min: f32, max: f32, vals: Vec<f32> }

impl StatsAcc {
    fn new(n_values: u64) -> Self {
        Self { stride: (n_values / STATS_SAMPLES).max(1), idx: 0, min: f32::INFINITY, max: f32::NEG_INFINITY, vals: Vec::new() }
    }
    fn add(&mut self, frame: &[f32]) {
        for &v in frame {
            self.min = self.min.min(v);
            self.max = self.max.max(v);
            if self.idx % self.stride == 0 { self.vals.push(v); }
            self.idx += 1;
        }
    }
    fn finish(&mut self) -> Stats {
        let vals = &mut self.vals;
        vals.sort_unstable_by(f32::total_cmp);
        let pct = |p: f64| vals.get(((vals.len() as f64 - 1.0) * p) as usize).copied().unwrap_or(0.0);
        Stats { min: self.min, max: self.max, p2: pct(0.02), p98: pct(0.98), median: pct(0.5), p99_9: pct(0.999) }
    }
}

struct LevelAcc { acc: Vec<f32>, count: u64, written: u64, stats: StatsAcc }

/// Incremental pyramid construction from finalized frames (in order).
/// Storage-agnostic: encoded bytes go to a `LevelSink`.
pub struct PyramidBuilder<P: Layout = SpecParams> {
    params: P,
    n_samples: u64,
    bins: usize,
    levels: Vec<LevelAcc>,
    buf: Vec<u8>,
}

impl<P: Layout> PyramidBuilder<P> {
    pub fn new(params: P, n_samples: u64) -> Self {
        let bins = params.out_bins();
        let n_frames = params.n_frames(n_samples);
        let levels = (0..level_count(n_frames)).map(|k| LevelAcc {
            acc: vec![0.0; bins], count: 0, written: 0,
            stats: StatsAcc::new(n_frames.div_ceil(FACTOR.pow(k as u32)) * bins as u64),
        }).collect();
        Self { params, n_samples, bins, levels, buf: Vec::new() }
    }

    pub fn n_levels(&self) -> usize { self.levels.len() }
    pub fn n_frames(&self) -> u64 { self.params.n_frames(self.n_samples) }

    /// Push finalized values for whole frames.
    pub fn push_block(&mut self, block: &[f32], sink: &mut impl LevelSink) -> io::Result<()> {
        for frame in block.chunks(self.bins) { self.push(0, frame, sink)?; }
        Ok(())
    }

    fn push(&mut self, k: usize, frame: &[f32], sink: &mut impl LevelSink) -> io::Result<()> {
        self.buf.clear();
        for &v in frame { self.buf.extend_from_slice(&f16::from_f32(v).to_le_bytes()); }
        sink.write(k, &self.buf)?;
        self.levels[k].written += 1;
        self.levels[k].stats.add(frame);
        if k + 1 < self.levels.len() {
            let next = &mut self.levels[k + 1];
            if next.count == 0 { next.acc.copy_from_slice(frame); }
            else { for (a, &v) in next.acc.iter_mut().zip(frame) { *a = a.max(v); } }
            next.count += 1;
            if next.count == FACTOR { self.emit_acc(k + 1, sink)?; }
        }
        Ok(())
    }

    fn emit_acc(&mut self, k: usize, sink: &mut impl LevelSink) -> io::Result<()> {
        self.levels[k].count = 0;
        let acc = std::mem::take(&mut self.levels[k].acc);
        let r = self.push(k, &acc, sink);
        self.levels[k].acc = acc;
        r
    }

    /// Flush partial groups (bottom-up so they cascade) and compute stats.
    pub fn finish(mut self, sink: &mut impl LevelSink) -> io::Result<PyramidMeta<P>> {
        for k in 1..self.levels.len() {
            if self.levels[k].count > 0 { self.emit_acc(k, sink)?; }
        }
        let levels: Vec<LevelMeta> = self.levels.iter_mut().enumerate()
            .map(|(k, l)| LevelMeta { factor: FACTOR.pow(k as u32), n_frames: l.written, stats: l.stats.finish() })
            .collect();
        Ok(PyramidMeta {
            version: P::VERSION,
            n_samples: self.n_samples,
            bins: self.bins,
            stats: levels[0].stats.clone(),
            levels,
            params: self.params,
        })
    }
}

/// Compute the spectrogram of `src` into `dir`. `progress(fraction)`
/// returning false cancels the build (io::ErrorKind::Interrupted).
pub fn build_pyramid<S: SampleSource>(
    src: &mut S, params: SpecParams, dir: &Path, progress: impl FnMut(f64) -> bool,
) -> io::Result<PyramidMeta> {
    let engine = SpecEngine::new(params.clone());
    build_with(src, params, dir, progress, |src, sink| engine.run(src, BLOCK_FRAMES, sink).map(|_| ()))
}

/// Same as `build_pyramid` for the v2 engine (dBFS / PCEN, centred frames).
pub fn build_pyramid_v2<S: SampleSource>(
    src: &mut S, params: crate::v2::StftParams, dir: &Path, progress: impl FnMut(f64) -> bool,
) -> io::Result<PyramidMeta<crate::v2::StftParams>> {
    let engine = crate::v2::Stft::new(params.clone()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    build_with(src, params, dir, progress, |src, sink| engine.run(src, BLOCK_FRAMES, sink).map(|_| ()))
}

type BlockSink<'a> = &'a mut dyn FnMut(u64, &[f32]) -> io::Result<()>;

fn build_with<S: SampleSource, P: Layout>(
    src: &mut S, params: P, dir: &Path, mut progress: impl FnMut(f64) -> bool,
    run: impl FnOnce(&mut S, BlockSink) -> io::Result<()>,
) -> io::Result<PyramidMeta<P>> {
    fs::create_dir_all(dir)?;
    let _ = fs::remove_file(dir.join("meta.json"));
    let bins = params.out_bins();
    let mut builder = PyramidBuilder::new(params, src.len());
    let n_frames = builder.n_frames();
    let mut sink = FileSink((0..builder.n_levels())
        .map(|k| File::create(level_path(dir, k)).map(|f| BufWriter::with_capacity(1 << 20, f)))
        .collect::<io::Result<_>>()?);

    run(src, &mut |f0, block| {
        builder.push_block(block, &mut sink)?;
        let done = (f0 + (block.len() / bins) as u64) as f64 / n_frames as f64;
        if progress(done) { Ok(()) } else { Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled")) }
    })?;
    let meta = builder.finish(&mut sink)?;
    for w in &mut sink.0 { w.flush()?; }

    // Write meta last via rename so a crash never leaves a "complete" store.
    let tmp = dir.join("meta.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&meta)?)?;
    fs::rename(&tmp, dir.join("meta.json"))?;
    Ok(meta)
}

pub struct Pyramid<P: Layout = SpecParams> { pub dir: PathBuf, pub meta: PyramidMeta<P> }

impl Pyramid {
    /// Open a complete v1 store; Ok(None) if missing, incomplete or outdated.
    pub fn open(dir: &Path) -> io::Result<Option<Self>> { Self::open_as(dir) }
}

impl<P: Layout> Pyramid<P> {
    /// Open a complete store of layout `P`; Ok(None) if missing, incomplete,
    /// outdated or of another layout.
    pub fn open_as(dir: &Path) -> io::Result<Option<Self>> {
        let bytes = match fs::read(dir.join("meta.json")) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let meta: PyramidMeta<P> = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        if meta.version != P::VERSION { return Ok(None); }
        Ok(Some(Self { dir: dir.to_path_buf(), meta }))
    }

    /// Frames [f0, f1) of `level` as f32, clamped to the level's length.
    pub fn read(&self, level: usize, f0: u64, f1: u64) -> io::Result<Vec<f32>> {
        let lm = self.meta.levels.get(level)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no such level"))?;
        let f1 = f1.min(lm.n_frames);
        let f0 = f0.min(f1);
        let bins = self.meta.bins as u64;
        let mut file = File::open(level_path(&self.dir, level))?;
        file.seek(SeekFrom::Start(f0 * bins * 2))?;
        let mut raw = vec![0u8; ((f1 - f0) * bins * 2) as usize];
        file.read_exact(&mut raw)?;
        Ok(decode_f16(&raw))
    }
}

/// Decode little-endian f16 bytes as stored in level files.
pub fn decode_f16(raw: &[u8]) -> Vec<f32> {
    raw.chunks_exact(2).map(|b| f16::from_le_bytes([b[0], b[1]]).to_f32()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemSource, Scale};

    fn signal(n: usize) -> Vec<f32> {
        (0..n).map(|i| if (i / 32000) % 2 == 0 { 0.5 * (i as f32 * 0.3).sin() } else { 0.001 }).collect()
    }

    #[test]
    fn levels_match_direct_compute_and_max_pool() {
        let audio = signal(32000 * 90);
        let mut p = SpecParams::perch(32000);
        p.scale = Scale::Mel;
        let dir = tempfile::tempdir().unwrap();
        let meta = build_pyramid(&mut MemSource(&audio), p.clone(), dir.path(), |_| true).unwrap();
        let pyr = Pyramid::open(dir.path()).unwrap().unwrap();

        let n0 = p.n_frames(audio.len() as u64);
        assert_eq!(meta.levels[0].n_frames, n0);
        assert!(meta.levels.len() >= 3, "{:?}", meta.levels);
        for (k, l) in meta.levels.iter().enumerate().skip(1) {
            assert_eq!(l.n_frames, meta.levels[k - 1].n_frames.div_ceil(FACTOR));
        }

        // Level 0 equals a direct computation (within f16 precision).
        let mut direct = Vec::new();
        SpecEngine::new(p).run(&mut MemSource(&audio), 999, |_, v| { direct.extend_from_slice(v); Ok(()) }).unwrap();
        let l0 = pyr.read(0, 0, n0).unwrap();
        for (a, b) in l0.iter().zip(&direct) { assert!((a - b).abs() <= 1e-3 * b.abs().max(1.0)); }

        // Level 1 frame j == max over level 0 frames 4j..4j+4 (f16 of max == max of f16).
        let bins = meta.bins;
        let l1 = pyr.read(1, 10, 11).unwrap();
        let src = pyr.read(0, 40, 44).unwrap();
        for b in 0..bins {
            let m = (0..4).map(|j| src[j * bins + b]).fold(f32::MIN, f32::max);
            assert_eq!(l1[b], m);
        }

        // Out-of-range reads clamp.
        assert_eq!(pyr.read(0, n0 - 2, n0 + 100).unwrap().len(), 2 * bins);
        // Max pooling can only raise values → per-level white point never drops.
        for w in meta.levels.windows(2) { assert!(w[1].stats.p98 >= w[0].stats.p98, "{:?}", meta.levels); }
        assert!(meta.stats.min <= meta.stats.p2 && meta.stats.p2 <= meta.stats.p98 && meta.stats.p98 <= meta.stats.max);
    }

    #[test]
    fn cancel_leaves_no_meta() {
        let audio = signal(32000 * 200);
        let dir = tempfile::tempdir().unwrap();
        let r = build_pyramid(&mut MemSource(&audio), SpecParams::perch(32000), dir.path(), |f| f < 0.3);
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(Pyramid::open(dir.path()).unwrap().is_none());
    }
}
