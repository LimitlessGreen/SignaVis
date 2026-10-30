// ═══════════════════════════════════════════════════════════════════════
// aw-dsp-wasm — browser bindings for aw-dsp
//
// Split for a worker pool without SharedArrayBuffer:
//   compute workers:  WasmStft.blockValues(…)  (parallel, PCEN included
//                     via warm-up frames)
//   coordinator:      WasmPyramidBuilderV2 → bytes per level → OPFS
// WAV parsing happens here too so JS only slices the File.
// ═══════════════════════════════════════════════════════════════════════

use aw_dsp::pyramid::{PyramidBuilder, VecSink};
use wasm_bindgen::prelude::*;

// ── Engine (dBFS / PCEN, centred frames) ────────────────────────────
//
// Workflow per block (coordinator):
//   [lo, hi] = stft.blockFrameRange(f0, n, total)
//   [start, len] = stft.sampleRange(lo, hi - lo)    // start may be < 0
//   read the in-file part of [start, start + len) → samples, first = max(0, start)
//   compute worker: stft.blockValues(samples, first, f0, n, total)

use aw_dsp::v2::{Stft, StftParams};

fn parse_v2(json: &str) -> Result<StftParams, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("params: {e}")))
}

#[wasm_bindgen]
pub struct WasmStft { stft: Stft, warmup: usize }

#[wasm_bindgen]
impl WasmStft {
    #[wasm_bindgen(constructor)]
    pub fn new(params_json: &str) -> Result<WasmStft, JsError> {
        let stft = Stft::new(parse_v2(params_json)?).map_err(|e| JsError::new(&e))?;
        let warmup = stft.pcen_warmup(1e-6);
        Ok(Self { stft, warmup })
    }

    #[wasm_bindgen(js_name = outBins)]
    pub fn out_bins(&self) -> usize { self.stft.params.out_bins() }

    #[wasm_bindgen(js_name = nFrames)]
    pub fn n_frames(&self, n_samples: f64) -> f64 { self.stft.params.n_frames(n_samples as u64) as f64 }

    /// Centre frequency (Hz) per output row, low → high.
    #[wasm_bindgen(js_name = binFrequencies)]
    pub fn bin_frequencies(&self) -> Vec<f64> { self.stft.params.bin_frequencies() }

    /// [lo, hi) frames to compute for output frames [f0, f0 + n).
    #[wasm_bindgen(js_name = blockFrameRange)]
    pub fn block_frame_range(&self, f0: f64, n: usize, total: f64) -> Vec<f64> {
        let (lo, hi) = self.stft.block_frame_range(f0 as u64, n, total as u64, self.warmup);
        vec![lo as f64, hi as f64]
    }

    /// [start, len] samples for frames [lo, lo + n); start may be negative.
    #[wasm_bindgen(js_name = sampleRange)]
    pub fn sample_range(&self, lo: f64, n: usize) -> Vec<f64> {
        let (s, l) = self.stft.sample_range(lo as u64, n);
        vec![s as f64, l as f64]
    }

    /// Finalized values for frames [f0, f0 + n), independent of other blocks.
    #[wasm_bindgen(js_name = blockValues)]
    pub fn block_values(&self, samples: &[f32], first: f64, f0: f64, n: usize, total: f64) -> Vec<f32> {
        self.stft.block_values(samples, first as i64, f0 as u64, n, total as u64, self.warmup)
    }
}

#[wasm_bindgen]
pub struct WasmPyramidBuilderV2 { builder: Option<PyramidBuilder<StftParams>>, sink: VecSink }

#[wasm_bindgen]
impl WasmPyramidBuilderV2 {
    #[wasm_bindgen(constructor)]
    pub fn new(params_json: &str, n_samples: f64) -> Result<WasmPyramidBuilderV2, JsError> {
        let p = parse_v2(params_json)?;
        p.validate().map_err(|e| JsError::new(&e))?;
        Ok(Self { builder: Some(PyramidBuilder::new(p, n_samples as u64)), sink: VecSink::default() })
    }

    #[wasm_bindgen(js_name = nLevels)]
    pub fn n_levels(&self) -> usize { self.builder.as_ref().map_or(0, |b| b.n_levels()) }

    #[wasm_bindgen(js_name = pushBlock)]
    pub fn push_block(&mut self, block: &[f32]) -> Result<(), JsError> {
        let b = self.builder.as_mut().ok_or_else(|| JsError::new("builder finished"))?;
        b.push_block(block, &mut self.sink).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = takeLevel)]
    pub fn take_level(&mut self, level: usize) -> Vec<u8> {
        self.sink.0.get_mut(level).map(std::mem::take).unwrap_or_default()
    }

    pub fn finish(&mut self) -> Result<String, JsError> {
        let b = self.builder.take().ok_or_else(|| JsError::new("builder finished"))?;
        let meta = b.finish(&mut self.sink).map_err(|e| JsError::new(&e.to_string()))?;
        serde_json::to_string(&meta).map_err(|e| JsError::new(&e.to_string()))
    }
}

/// CLAHE in place on a [0, 1] image (see aw_dsp::display::clahe).
#[wasm_bindgen]
pub fn clahe(gray: &mut [f32], width: usize, height: usize, tiles_x: usize, tiles_y: usize, clip_limit: f32) {
    aw_dsp::display::clahe(gray, width, height, tiles_x, tiles_y, clip_limit);
}

/// Per-band noise floor (median per row) of row-major [frame][bin] values.
#[wasm_bindgen(js_name = bandFloor)]
pub fn band_floor(values: &[f32], bins: usize) -> Vec<f32> {
    aw_dsp::v2::display_stats(values, bins).band_floor
}

#[wasm_bindgen(js_name = decodeF16)]
pub fn decode_f16(bytes: &[u8]) -> Vec<f32> { aw_dsp::pyramid::decode_f16(bytes) }

// ── WAV ─────────────────────────────────────────────────────────────

/// Parse a WAV header from the first bytes of a file (64 KiB is plenty).
/// Returns JSON { sampleRate, channels, bitsPerSample, float, dataOffset, nSamples }.
#[wasm_bindgen(js_name = wavInfo)]
pub fn wav_info(head: &[u8]) -> Result<String, JsError> {
    let mut cur = std::io::Cursor::new(head);
    let r = hound::WavReader::new(&mut cur).map_err(|e| JsError::new(&format!("wav: {e}")))?;
    let spec = r.spec();
    let n_samples = r.duration();
    drop(r);
    Ok(format!(
        r#"{{"sampleRate":{},"channels":{},"bitsPerSample":{},"float":{},"dataOffset":{},"nSamples":{}}}"#,
        spec.sample_rate, spec.channels, spec.bits_per_sample,
        spec.sample_format == hound::SampleFormat::Float, cur.position(), n_samples,
    ))
}

/// Convert interleaved PCM bytes to mono f32, channel 0 only
/// (matches AudioBuffer.getChannelData(0) in the JS path).
#[wasm_bindgen(js_name = wavChannel0)]
pub fn wav_channel0(bytes: &[u8], channels: usize, bits: usize, float: bool) -> Vec<f32> {
    let bps = bits / 8;
    let stride = bps * channels;
    bytes.chunks_exact(stride).map(|f| match (float, bits) {
        (true, 32) => f32::from_le_bytes([f[0], f[1], f[2], f[3]]),
        (false, 8) => (f[0] as f32 - 128.0) / 128.0,
        (false, 16) => i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0,
        (false, 24) => (i32::from_le_bytes([0, f[0], f[1], f[2]]) >> 8) as f32 / 8388608.0,
        (false, 32) => i32::from_le_bytes([f[0], f[1], f[2], f[3]]) as f32 / 2147483648.0,
        _ => 0.0,
    }).collect()
}
