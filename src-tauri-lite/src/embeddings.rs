// ═══════════════════════════════════════════════════════════════════════
// embeddings.rs — Perch-2-Embeddings pro Projektordner (Plattform-Phase 1)
//
// Modell: perch_v2_no_dft_embed.onnx (49 MB), beim ersten Gebrauch nach
// <app data>/models/perch-v2/ geladen und per SHA-256 geprueft. Ueberschreibbar
// mit SIGNAVIS_PERCH_MODEL=<pfad> (Entwicklung).
//
// Speicher im Projekt: .signavis/embeddings/perch2/
//   index.json   – Hop, Modell-Hash, pro Datei Groesse/mtime/Zeilenbereich
//   vectors.f16  – Zeilen zu 1536 f16 (little endian), nur angehaengt;
//                  geaenderte/geloeschte Dateien hinterlassen Luecken, die
//                  beim Ueberschreiten von 30 % kompaktiert werden.
// Der Job laeuft inkrementell (nur neue/geaenderte Dateien), ist abbrechbar
// und meldet Fortschritt als EMBED_EVENT.
// ═══════════════════════════════════════════════════════════════════════

use half::f16;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use aw_embed::{DIM, SAMPLE_RATE, WINDOW};

const MODEL_FILE: &str = "perch_v2_no_dft_embed.onnx";
const MODEL_SHA256: &str = "1da731f3db5e98708cee6dd116403897f9e2204a74b5d56760fd8ec8503350ac";
const MODEL_SIZE: u64 = 49_447_593;
/// Release-Asset mit dem headless Perch-2-Modell (Apache 2.0, siehe ADR 001).
const MODEL_URL: &str =
    "https://github.com/LimitlessGreen/Audio-Workbench/releases/download/models-perch-v2/perch_v2_no_dft_embed.onnx";
const MODEL_ENV: &str = "SIGNAVIS_PERCH_MODEL";
pub const MODEL_EVENT: &str = "lite-embed-model";
pub const EMBED_EVENT: &str = "lite-embed-progress";
const STORE_DIR: &str = ".signavis/embeddings/perch2";
const DEFAULT_HOP_S: f64 = 5.0;
const BATCH: usize = 32;

// ── Zustand ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct EmbedState {
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    /// Zuletzt geladene Matrix (normiert, f32) fuer die Suche.
    cache: Mutex<Option<Loaded>>,
}

pub(crate) struct Loaded {
    pub root: String,
    pub stamp: u64,
    pub rows: Vec<RowRef>,
    pub vecs: Vec<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRef {
    pub path: String,
    pub start: f64,
}

// ── Index ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    size: u64,
    last_modified: f64,
    /// Erste Zeile in vectors.f16 und Anzahl Fenster.
    row: u64,
    count: u64,
    duration: f64,
    /// Pegel pro Fenster (RMS in dBFS, 0,1 dB genau), fuer „leise Fenster
    /// ausblenden“ auf der Karte. Leer in aelteren Stores (wird nachgereicht).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    level: Vec<f32>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Index {
    version: u32,
    model_sha256: String,
    hop_s: f64,
    /// Zeilen in vectors.f16 (inkl. Luecken).
    total_rows: u64,
    /// Erhoeht sich bei jeder Aenderung (Cache-Invalidierung).
    stamp: u64,
    files: BTreeMap<String, FileEntry>,
    /// Dateien, die nicht dekodiert werden konnten (mit Grund).
    #[serde(default)]
    failed: BTreeMap<String, String>,
}

impl Index {
    fn new(hop_s: f64) -> Self {
        Self {
            version: 1,
            model_sha256: MODEL_SHA256.into(),
            hop_s,
            total_rows: 0,
            stamp: 0,
            files: BTreeMap::new(),
            failed: BTreeMap::new(),
        }
    }
    fn live_rows(&self) -> u64 {
        self.files.values().map(|f| f.count).sum()
    }
}

pub(crate) fn store_dir(root: &str) -> PathBuf {
    Path::new(root).join(STORE_DIR)
}

fn read_index(root: &str) -> Option<Index> {
    let bytes = std::fs::read(store_dir(root).join("index.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Aenderungszaehler des Stores (None: keine Embeddings).
pub(crate) fn store_stamp(root: &str) -> Option<u64> {
    read_index(root).map(|i| i.stamp)
}

fn write_index(root: &str, idx: &Index) -> Result<(), String> {
    let dir = store_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".index.{}.tmp", std::process::id()));
    let json = serde_json::to_vec(idx).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join("index.json")).map_err(|e| format!("replace index.json: {e}"))
}

/// RMS-Pegel jedes Fensters in dBFS (Stille: −120), auf 0,1 dB gerundet.
pub(crate) fn window_levels(windows: &[f32]) -> Vec<f32> {
    windows
        .chunks_exact(WINDOW)
        .map(|w| {
            let ms = w.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / WINDOW as f64;
            let db = if ms > 1e-12 { 10.0 * ms.log10() } else { -120.0 };
            ((db * 10.0).round() / 10.0) as f32
        })
        .collect()
}

/// Pegel pro Fenster: Datei/Start → dBFS (fehlt bei Stores ohne Pegel).
pub(crate) fn levels_by_row(root: &str) -> Option<BTreeMap<String, Vec<f32>>> {
    let idx = read_index(root)?;
    Some(idx.files.into_iter().filter(|(_, e)| e.level.len() as u64 == e.count).map(|(k, e)| (k, e.level)).collect())
}

fn vectors_path(root: &str) -> PathBuf {
    store_dir(root).join("vectors.f16")
}

fn to_f16_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| f16::from_f32(*x).to_le_bytes()).collect()
}

/// Zeilen [row, row+count) aus vectors.f16 lesen.
fn read_rows(file: &mut std::fs::File, row: u64, count: u64) -> Result<Vec<f32>, String> {
    use std::io::Seek;
    let row_bytes = (DIM * 2) as u64;
    file.seek(std::io::SeekFrom::Start(row * row_bytes)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (count * row_bytes) as usize];
    file.read_exact(&mut buf).map_err(|e| format!("vectors.f16: {e}"))?;
    Ok(buf.chunks_exact(2).map(|b| f16::from_le_bytes([b[0], b[1]]).to_f32()).collect())
}

/// Luecken entfernen: vectors.f16 neu schreiben, Zeilen fortlaufend.
fn compact(root: &str, idx: &mut Index) -> Result<(), String> {
    let path = vectors_path(root);
    let tmp = path.with_extension("f16.compact");
    let mut src = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut dst = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
    let mut next = 0u64;
    for f in idx.files.values_mut() {
        let rows = read_rows(&mut src, f.row, f.count)?;
        dst.write_all(&to_f16_bytes(&rows)).map_err(|e| e.to_string())?;
        f.row = next;
        next += f.count;
    }
    dst.flush().map_err(|e| e.to_string())?;
    drop(dst);
    drop(src);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    idx.total_rows = next;
    idx.stamp += 1;
    write_index(root, idx)
}

// ── Modell ────────────────────────────────────────────────────────────

fn model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os(MODEL_ENV).filter(|v| !v.is_empty()) {
        return Ok(p.into());
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join("perch-v2").join(MODEL_FILE))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    present: bool,
    path: String,
    size: u64,
}

#[tauri::command]
pub fn embed_model_status(app: tauri::AppHandle) -> Result<ModelStatus, String> {
    let p = model_path(&app)?;
    let present = std::env::var_os(MODEL_ENV).is_some_and(|v| !v.is_empty()) && p.is_file()
        || std::fs::metadata(&p).is_ok_and(|m| m.len() == MODEL_SIZE);
    Ok(ModelStatus { present, path: p.to_string_lossy().into_owned(), size: MODEL_SIZE })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    bytes: u64,
    total: u64,
}

/// Modell herunterladen (Fortschritt als MODEL_EVENT), Hash pruefen.
#[tauri::command]
pub async fn embed_model_download(app: tauri::AppHandle) -> Result<ModelStatus, String> {
    let status = embed_model_status(app.clone())?;
    if status.present {
        return Ok(status);
    }
    let target = PathBuf::from(&status.path);
    let dir = target.parent().ok_or("bad model path")?;
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let mut res = reqwest::get(MODEL_URL).await.map_err(|e| format!("{MODEL_URL}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{MODEL_URL}: HTTP {}", res.status()));
    }
    let tmp = target.with_extension("onnx.part");
    let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        bytes += chunk.len() as u64;
        if bytes - last_emit > (1 << 20) {
            last_emit = bytes;
            let _ = app.emit(MODEL_EVENT, DownloadProgress { bytes, total: MODEL_SIZE });
        }
    }
    drop(out);
    let got = format!("{:x}", hasher.finalize());
    if got != MODEL_SHA256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Modell-Pruefsumme falsch ({got})"));
    }
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    let _ = app.emit(MODEL_EVENT, DownloadProgress { bytes, total: MODEL_SIZE });
    embed_model_status(app)
}

/// CUDA (nur mit Feature `cuda`) bzw. DirectML (Windows) versuchen, sonst CPU.
fn open_embedder(model: &Path) -> Result<(aw_embed::Embedder, &'static str), String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    #[cfg(feature = "cuda")]
    match aw_embed::Embedder::new(model, threads, "cuda") {
        Ok(e) => return Ok((e, "cuda")),
        Err(e) => eprintln!("[embed] CUDA nicht verfuegbar, nutze CPU: {e}"),
    }
    #[cfg(windows)]
    match aw_embed::Embedder::new(model, threads, "directml") {
        Ok(e) => return Ok((e, "directml")),
        Err(e) => eprintln!("[embed] DirectML nicht verfuegbar, nutze CPU: {e}"),
    }
    aw_embed::Embedder::new(model, threads, "cpu").map(|e| (e, "cpu")).map_err(|e| e.to_string())
}

// ── Dekodieren ────────────────────────────────────────────────────────

/// Beliebiges Audioformat (Symphonia) -> Mono f32 + Abtastrate.
fn decode_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SErr, formats::FormatOptions,
                          io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|x| x.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Format: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("keine Audiospur")?;
    let track_id = track.id;
    let sr = track.codec_params.sample_rate.ok_or("Abtastrate unbekannt")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec: {e}"))?;
    let mut mono = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SErr::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SErr::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let sb = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if sb.capacity() < decoded.capacity() * ch {
            *sb = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        sb.copy_interleaved_ref(decoded);
        mono.extend(sb.samples().chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
    }
    Ok((mono, sr))
}

// ── Job ───────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    root: String,
    /// "starting" | "running" | "done" | "cancelled" | "error"
    phase: String,
    done: usize,
    total: usize,
    current: Option<String>,
    windows: u64,
    audio_seconds: f64,
    device: String,
    error: Option<String>,
    failed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    exists: bool,
    hop_s: f64,
    files: usize,
    windows: u64,
    failed: BTreeMap<String, String>,
    running: bool,
}

#[tauri::command]
pub fn embed_info(state: tauri::State<'_, EmbedState>, root: String) -> StoreInfo {
    let running = state.running.load(Ordering::SeqCst);
    match read_index(&root) {
        Some(idx) => StoreInfo {
            exists: true,
            hop_s: idx.hop_s,
            files: idx.files.len(),
            windows: idx.live_rows(),
            failed: idx.failed,
            running,
        },
        None => StoreInfo { exists: false, hop_s: DEFAULT_HOP_S, files: 0, windows: 0, failed: BTreeMap::new(), running },
    }
}

#[tauri::command]
pub fn embed_cancel(state: tauri::State<'_, EmbedState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Embedding-Job starten (kehrt sofort zurueck; Fortschritt per EMBED_EVENT).
/// `hop_s`: Fensterabstand in Sekunden (0 < hop <= 5); bei Aenderung wird neu gerechnet.
#[tauri::command]
pub fn embed_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbedState>,
    root: String,
    hop_s: Option<f64>,
) -> Result<(), String> {
    let hop_s = hop_s.unwrap_or(DEFAULT_HOP_S);
    if !(0.5..=5.0).contains(&hop_s) {
        return Err(format!("Hop muss zwischen 0,5 und 5 s liegen: {hop_s}"));
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("Embedding-Job laeuft bereits".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let model = model_path(&app)?;
    let (cancel, running) = (state.cancel.clone(), state.running.clone());
    std::thread::spawn(move || {
        let mut p = JobProgress { root: root.clone(), phase: "starting".into(), ..Default::default() };
        let _ = app.emit(EMBED_EVENT, p.clone());
        let emit = |p: &JobProgress| {
            let _ = app.emit(EMBED_EVENT, p.clone());
        };
        if let Err(e) = run_job(&emit, &root, hop_s, &model, &cancel, &mut p) {
            p.phase = "error".into();
            p.error = Some(e);
        }
        running.store(false, Ordering::SeqCst);
        let _ = app.emit(EMBED_EVENT, p);
    });
    Ok(())
}

fn run_job(
    emit: &dyn Fn(&JobProgress),
    root: &str,
    hop_s: f64,
    model: &Path,
    cancel: &AtomicBool,
    p: &mut JobProgress,
) -> Result<(), String> {
    if !model.is_file() {
        return Err("Perch-Modell fehlt (erst herunterladen)".into());
    }
    let audio = crate::project_fs::project_list_audio(root.to_string())?;
    let mut idx = match read_index(root) {
        Some(i) if i.model_sha256 == MODEL_SHA256 && (i.hop_s - hop_s).abs() < 1e-9 && vectors_path(root).is_file() => i,
        _ => {
            let _ = std::fs::remove_file(vectors_path(root));
            Index::new(hop_s)
        }
    };
    // Geloeschte Dateien austragen
    let present: std::collections::HashSet<&str> = audio.iter().map(|f| f.path.as_str()).collect();
    idx.files.retain(|k, _| present.contains(k.as_str()));
    idx.failed.retain(|k, _| present.contains(k.as_str()));
    let todo: Vec<_> = audio
        .iter()
        .filter(|f| match idx.files.get(&f.path) {
            // geaendert, oder aus einem aelteren Store ohne Pegel (dann nur Pegel nachrechnen)
            Some(e) => e.size != f.size || e.last_modified != f.last_modified || e.level.len() as u64 != e.count,
            None => match idx.failed.get(&f.path) {
                // fehlgeschlagene nur nach Aenderung erneut versuchen
                Some(_) => false,
                None => true,
            },
        })
        .cloned()
        .collect();
    p.total = todo.len();
    p.phase = "running".into();
    p.failed = idx.failed.len();
    emit(p);
    if todo.is_empty() {
        write_index(root, &idx)?;
        p.phase = "done".into();
        return Ok(());
    }

    let (mut embedder, device) = open_embedder(model)?;
    p.device = device.into();
    std::fs::create_dir_all(store_dir(root)).map_err(|e| e.to_string())?;
    let mut vec_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(vectors_path(root))
        .map_err(|e| e.to_string())?;
    let hop = (hop_s * SAMPLE_RATE as f64).round() as usize;

    for f in &todo {
        if cancel.load(Ordering::SeqCst) {
            p.phase = "cancelled".into();
            write_index(root, &idx)?;
            return Ok(());
        }
        p.current = Some(f.path.clone());
        emit(p);
        let full = Path::new(root).join(&f.path);
        // Unveraenderte Datei, nur der Pegel fehlt: dekodieren, nicht neu einbetten.
        let levels_only = idx.files.get(&f.path).is_some_and(|e| e.size == f.size && e.last_modified == f.last_modified);
        if levels_only {
            if let Ok((x, sr)) = decode_mono(&full) {
                if let Ok(x) = aw_embed::resample_to_32k(&x, sr) {
                    let lv = window_levels(&aw_embed::frame(&x, hop, false));
                    if let Some(e) = idx.files.get_mut(&f.path) {
                        if lv.len() as u64 == e.count {
                            e.level = lv;
                        }
                    }
                }
            }
            write_index(root, &idx)?;
            p.done += 1;
            emit(p);
            continue;
        }
        let result = decode_mono(&full).and_then(|(x, sr)| {
            let x = aw_embed::resample_to_32k(&x, sr).map_err(|e| e.to_string())?;
            let duration = x.len() as f64 / SAMPLE_RATE as f64;
            let windows = aw_embed::frame(&x, hop, false);
            drop(x);
            let n = windows.len() / WINDOW;
            let level = window_levels(&windows);
            let mut vecs = Vec::with_capacity(n * DIM);
            // in Stuecken, damit Abbrechen auch bei langen Aufnahmen greift
            for chunk in windows.chunks(BATCH * 8 * WINDOW) {
                if cancel.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                vecs.extend(embedder.embed(chunk, BATCH).map_err(|e| e.to_string())?);
            }
            Ok((vecs, n as u64, duration, level))
        });
        match result {
            Ok((vecs, n, duration, level)) => {
                vec_file.write_all(&to_f16_bytes(&vecs)).map_err(|e| e.to_string())?;
                vec_file.flush().map_err(|e| e.to_string())?;
                idx.files.insert(
                    f.path.clone(),
                    FileEntry { size: f.size, last_modified: f.last_modified, row: idx.total_rows, count: n, duration, level },
                );
                idx.failed.remove(&f.path);
                idx.total_rows += n;
                idx.stamp += 1;
                p.windows += n;
                p.audio_seconds += duration;
            }
            Err(e) if e == "cancelled" => {
                p.phase = "cancelled".into();
                write_index(root, &idx)?;
                return Ok(());
            }
            Err(e) => {
                idx.files.remove(&f.path);
                idx.failed.insert(f.path.clone(), e);
                p.failed = idx.failed.len();
            }
        }
        write_index(root, &idx)?;
        p.done += 1;
        emit(p);
    }
    drop(vec_file);
    p.current = None;
    if idx.total_rows > 0 && (idx.total_rows - idx.live_rows()) * 10 > idx.total_rows * 3 {
        compact(root, &mut idx)?;
    }
    p.phase = "done".into();
    Ok(())
}

// ── Suche ─────────────────────────────────────────────────────────────

fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

/// Matrix normiert laden (gecacht, solange sich der Index nicht aendert).
pub(crate) fn with_loaded<T>(state: &EmbedState, root: &str, f: impl FnOnce(&Loaded) -> T) -> Result<T, String> {
    let idx = read_index(root).ok_or("Noch keine Embeddings in diesem Projekt")?;
    let mut guard = state.cache.lock().unwrap();
    let fresh = guard.as_ref().is_some_and(|l| l.root == root && l.stamp == idx.stamp);
    if !fresh {
        let mut file = std::fs::File::open(vectors_path(root)).map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        let mut vecs = Vec::with_capacity(idx.live_rows() as usize * DIM);
        for (path, e) in &idx.files {
            let mut v = read_rows(&mut file, e.row, e.count)?;
            v.chunks_exact_mut(DIM).for_each(normalize);
            vecs.extend(v);
            rows.extend((0..e.count).map(|i| RowRef { path: path.clone(), start: i as f64 * idx.hop_s }));
        }
        *guard = Some(Loaded { root: root.to_string(), stamp: idx.stamp, rows, vecs });
    }
    Ok(f(guard.as_ref().unwrap()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    path: String,
    start: f64,
    end: f64,
    score: f32,
}

/// Fenster eines Treffers -> Zeile, gesucht ueber Pfad und Startzeit.
pub(crate) fn find_row(l: &Loaded, path: &str, start: f64) -> Option<usize> {
    l.rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.path == path && r.start <= start + 1e-6)
        .max_by(|a, b| a.1.start.total_cmp(&b.1.start))
        .map(|(i, _)| i)
}

/// Top-k aehnlichste Fenster zu einem Fenster (`path` + Zeit `start` in s).
/// Treffer aus demselben Fenster werden ausgelassen.
#[tauri::command]
pub fn embed_similar(
    state: tauri::State<'_, EmbedState>,
    root: String,
    path: String,
    start: f64,
    k: Option<usize>,
) -> Result<Vec<Hit>, String> {
    let k = k.unwrap_or(50).clamp(1, 2000);
    with_loaded(&state, &root, |l| {
        let qi = find_row(l, &path, start).ok_or_else(|| format!("Kein Embedding fuer {path} @ {start:.1} s"))?;
        let q = &l.vecs[qi * DIM..(qi + 1) * DIM];
        let scores = l.vecs.chunks_exact(DIM).map(|v| v.iter().zip(q).map(|(a, b)| a * b).sum::<f32>());
        Ok(top_k(scores, k, Some(qi))
            .into_iter()
            .map(|(i, score)| {
                let r = &l.rows[i];
                Hit { path: r.path.clone(), start: r.start, end: r.start + WINDOW as f64 / SAMPLE_RATE as f64, score }
            })
            .collect())
    })?
}

pub(crate) fn top_k(scores: impl Iterator<Item = f32>, k: usize, skip: Option<usize>) -> Vec<(usize, f32)> {
    let mut all: Vec<(usize, f32)> = scores.enumerate().filter(|(i, _)| Some(*i) != skip).collect();
    let k = k.min(all.len());
    if k == 0 {
        return vec![];
    }
    all.select_nth_unstable_by(k - 1, |a, b| b.1.total_cmp(&a.1));
    all.truncate(k);
    all.sort_by(|a, b| b.1.total_cmp(&a.1));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realtest mit Modell: SIGNAVIS_PERCH_MODEL und EMBED_TEST_DIR (Ordner mit Audio) setzen,
    /// optional EMBED_TEST_HOP (Sekunden, Standard 5).
    #[test]
    #[ignore]
    fn job_end_to_end() {
        let model = PathBuf::from(std::env::var("SIGNAVIS_PERCH_MODEL").unwrap());
        let root = std::env::var("EMBED_TEST_DIR").unwrap();
        let hop: f64 = std::env::var("EMBED_TEST_HOP").ok().and_then(|v| v.parse().ok()).unwrap_or(5.0);
        let _ = std::fs::remove_dir_all(store_dir(&root));
        let cancel = AtomicBool::new(false);
        let mut p = JobProgress::default();
        let t = std::time::Instant::now();
        run_job(&|p| eprintln!("{} {}/{} {:?}", p.phase, p.done, p.total, p.current), &root, hop, &model, &cancel, &mut p)
            .unwrap();
        let secs = t.elapsed().as_secs_f64();
        eprintln!("{} Fenster, {:.0} s Audio in {secs:.1} s ({:.0}x, {})", p.windows, p.audio_seconds, p.audio_seconds / secs, p.device);
        assert!(p.windows > 0);
        // zweiter Lauf: nichts zu tun
        let mut p2 = JobProgress::default();
        run_job(&|_| {}, &root, hop, &model, &cancel, &mut p2).unwrap();
        assert_eq!(p2.total, 0);
        let state = EmbedState::default();
        let first = read_index(&root).unwrap().files.keys().next().unwrap().clone();
        let hits = with_loaded(&state, &root, |l| {
            let q = &l.vecs[..DIM];
            top_k(l.vecs.chunks_exact(DIM).map(|v| v.iter().zip(q).map(|(a, b)| a * b).sum::<f32>()), 5, None)
        })
        .unwrap();
        eprintln!("{first}: {hits:?}");
        assert!((hits[0].1 - 1.0).abs() < 1e-2);
    }

    #[test]
    fn top_k_sorts_and_skips() {
        let s = vec![0.1, 0.9, 0.5, 0.95, 0.2];
        assert_eq!(top_k(s.iter().copied(), 2, Some(3)), vec![(1, 0.9), (2, 0.5)]);
        assert_eq!(top_k(s.iter().copied(), 10, None).len(), 5);
    }

    #[test]
    fn window_levels_in_dbfs() {
        // Sinus mit Amplitude 1 → −3,0 dBFS; halbe Amplitude → −9,0; Stille → −120
        let sine = |a: f32| (0..WINDOW).map(move |i| a * (i as f32 * 0.05).sin());
        let w: Vec<f32> = sine(1.0).chain(sine(0.5)).chain(std::iter::repeat(0.0).take(WINDOW)).collect();
        assert_eq!(window_levels(&w), vec![-3.0, -9.0, -120.0]);
    }

    #[test]
    fn append_compact_round_trip() {
        let dir = std::env::temp_dir().join(format!("signavis-embed-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.to_string_lossy().into_owned();
        std::fs::create_dir_all(store_dir(&root)).unwrap();
        let mut idx = Index::new(5.0);
        let rows = |v: f32, n: usize| vec![v; n * DIM];
        let mut f = std::fs::File::create(vectors_path(&root)).unwrap();
        for (name, v, n) in [("a.wav", 1.0, 2), ("b.wav", 2.0, 1), ("c.wav", 3.0, 3)] {
            f.write_all(&to_f16_bytes(&rows(v, n))).unwrap();
            idx.files.insert(
                name.into(),
                FileEntry { size: 0, last_modified: 0.0, row: idx.total_rows, count: n as u64, duration: 0.0, level: vec![v; n] },
            );
            idx.total_rows += n as u64;
        }
        drop(f);
        idx.files.remove("b.wav");
        compact(&root, &mut idx).unwrap();
        assert_eq!(idx.total_rows, 5);
        let mut f = std::fs::File::open(vectors_path(&root)).unwrap();
        let c = &idx.files["c.wav"];
        assert_eq!(c.row, 2);
        assert!(read_rows(&mut f, c.row, c.count).unwrap().iter().all(|x| *x == 3.0));
        assert_eq!(c.level, vec![3.0; 3], "Pegel bleiben beim Verdichten an ihrer Datei");
        assert_eq!(levels_by_row(&root).unwrap().len(), 2);
        assert_eq!(std::fs::metadata(vectors_path(&root)).unwrap().len(), 5 * DIM as u64 * 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
