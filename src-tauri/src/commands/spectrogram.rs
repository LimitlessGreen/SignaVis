// ═══════════════════════════════════════════════════════════════════════
// commands/spectrogram.rs — native spectrogram for long recordings
//
// spectrogram_open   compute (or reuse cached) multi-level pyramid for a file
// spectrogram_tile   raw f32 LE bytes for frames [f0, f1) of one level
// spectrogram_cancel abort a running build
//
// Stores live in <app_cache>/spectrograms/<key>, key = hash of file
// identity (path, size, mtime) + DSP params, so results survive restarts.
// Progress: event "spectrogram:progress" { id, fraction }.
// ═══════════════════════════════════════════════════════════════════════

use aw_dsp::pyramid::Layout;
use aw_dsp::v2::StftParams;
use aw_dsp::{build_pyramid, Pyramid, PyramidMeta, WavSource};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct SpectrogramState {
    stores: Mutex<HashMap<String, Arc<Pyramid>>>,
    builds: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Serialises builds of the same key.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramOpenArgs {
    pub path: String,
    /// `sampleRate` is ignored and taken from the file.
    pub params: StftParams,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramOpenResult {
    pub id: String,
    pub from_cache: bool,
    pub meta: PyramidMeta,
}

#[derive(Clone, Serialize)]
struct ProgressPayload<'a> { id: &'a str, fraction: f64 }

fn store_key(path: &str, params: &impl Serialize, version: u32) -> Result<String, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    let mtime = md.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    h.update(canonical.to_string_lossy().as_bytes());
    h.update(md.len().to_le_bytes());
    h.update(mtime.to_le_bytes());
    h.update(serde_json::to_vec(params).map_err(|e| e.to_string())?);
    h.update(version.to_le_bytes());
    Ok(hex::encode(&h.finalize()[..16]))
}

#[tauri::command]
pub async fn spectrogram_open(
    app: tauri::AppHandle,
    state: State<'_, SpectrogramState>,
    args: SpectrogramOpenArgs,
) -> Result<SpectrogramOpenResult, String> {
    let SpectrogramOpenArgs { path, mut params } = args;
    if !path.to_ascii_lowercase().ends_with(".wav") {
        return Err("native spectrogram supports WAV only".into());
    }
    let src = WavSource::open(&path).map_err(|e| format!("{path}: {e}"))?;
    params.resolve_sample_rate(src.sample_rate());
    let id = store_key(&path, &params, StftParams::VERSION)?;

    let lock = state.locks.lock().unwrap().entry(id.clone()).or_default().clone();
    let _guard = lock.lock().await;

    let cached = |state: &SpectrogramState, id: &str| state.stores.lock().unwrap().get(id)
        .map(|p| p.meta.clone());
    if let Some(meta) = cached(&state, &id) {
        return Ok(SpectrogramOpenResult { id, from_cache: true, meta });
    }
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("spectrograms").join(&id);
    if let Some(p) = Pyramid::open_as(&dir).map_err(|e| e.to_string())? {
        let meta = p.meta.clone();
        state.stores.lock().unwrap().insert(id.clone(), Arc::new(p));
        return Ok(SpectrogramOpenResult { id, from_cache: true, meta });
    }

    let cancel = Arc::new(AtomicBool::new(false));
    state.builds.lock().unwrap().insert(id.clone(), cancel.clone());
    let (app2, id2, dir2) = (app.clone(), id.clone(), dir.clone());
    let built = tauri::async_runtime::spawn_blocking(move || {
        let mut src = src;
        let mut last = -1.0;
        build_pyramid(&mut src, params, &dir2, |fraction| {
            if fraction - last >= 0.01 || fraction >= 1.0 {
                last = fraction;
                let _ = app2.emit("spectrogram:progress", ProgressPayload { id: &id2, fraction });
            }
            !cancel.load(Ordering::Relaxed)
        }).map(|_| ())
    }).await;
    state.builds.lock().unwrap().remove(&id);

    if let Err(e) = built.map_err(|e| e.to_string())? {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(if e.kind() == std::io::ErrorKind::Interrupted { "cancelled".into() } else { e.to_string() });
    }
    let p = Pyramid::open_as(&dir).map_err(|e| e.to_string())?.ok_or("store incomplete after build")?;
    let meta = p.meta.clone();
    state.stores.lock().unwrap().insert(id.clone(), Arc::new(p));
    Ok(SpectrogramOpenResult { id, from_cache: false, meta })
}

#[tauri::command]
pub fn spectrogram_cancel(state: State<'_, SpectrogramState>, id: String) {
    if let Some(c) = state.builds.lock().unwrap().get(&id) { c.store(true, Ordering::Relaxed); }
}

/// Returns `(f1 - f0) * bins` little-endian f32 values as a binary response.
#[tauri::command]
pub async fn spectrogram_tile(
    state: State<'_, SpectrogramState>,
    id: String,
    level: usize,
    f0: u64,
    f1: u64,
) -> Result<tauri::ipc::Response, String> {
    let store = state.stores.lock().unwrap().get(&id).cloned().ok_or("unknown spectrogram id")?;
    let values = tauri::async_runtime::spawn_blocking(move || store.read(level, f0, f1))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for v in values { bytes.extend_from_slice(&v.to_le_bytes()); }
    Ok(tauri::ipc::Response::new(bytes))
}

