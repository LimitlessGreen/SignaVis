// ═══════════════════════════════════════════════════════════════════════
// geo_grid.rs — range map grids from the geomodel trunk, natively
//
// The web app runs the trunk (models/geo-trunk-*, scripts/geo_trunk.py) on
// WebGPU; the Lite webview bundles only the WASM build of onnxruntime and
// has no WebGPU on Linux. Here the trunk runs on ONNX Runtime (CUDA with the
// feature, DirectML on Windows, else CPU on all cores); the output layer of
// the one species is applied in Rust. Files come through the svdata cache.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use aw_embed::geo::{grid_points, GeoTrunk, Head};
use serde::Deserialize;
use tauri::Manager;

#[derive(Deserialize)]
struct HeadJson {
    n: usize,
    d: usize,
    hidden: String,
    #[serde(default = "default_input")]
    input: String,
    rows: Vec<Vec<usize>>,
}
fn default_input() -> String { "input".into() }

struct Loaded {
    key: String,
    trunk: GeoTrunk,
    head: Head,
    rows: Vec<Vec<usize>>,
    label_ix: HashMap<String, usize>,
}

#[derive(Default)]
pub struct GeoState(Arc<Mutex<Option<Loaded>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRequest {
    /// Site path of the trunk folder ("models/geo-trunk-v3.0/").
    trunk: String,
    /// Site path of the geomodel label file.
    labels: String,
    species: String,
    lats: Vec<f32>,
    west: f32,
    east: f32,
    cols: usize,
    week: f32,
}

fn checked(path: &str) -> Result<String, String> {
    let ok = path.starts_with("models/") && !path.contains("..") && !path.contains('\\');
    ok.then(|| path.to_string()).ok_or_else(|| format!("not a model path: {path}"))
}

/// Geo label file: <id>\t<scientific>\t<common>, in output order.
pub(crate) fn parse_labels(text: &str) -> HashMap<String, usize> {
    text.lines()
        .enumerate()
        .filter_map(|(i, l)| l.split('\t').nth(1).filter(|s| !s.is_empty()).map(|s| (s.trim().to_string(), i)))
        .collect()
}

fn open_trunk(path: &std::path::Path, input: &str, output: &str) -> Result<GeoTrunk, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    #[cfg(feature = "cuda")]
    match GeoTrunk::new(path, threads, "cuda", input, output) {
        Ok(t) => return Ok(t),
        Err(e) => eprintln!("[geo] CUDA not available, using CPU: {e}"),
    }
    #[cfg(windows)]
    match GeoTrunk::new(path, threads, "directml", input, output) {
        Ok(t) => return Ok(t),
        Err(e) => eprintln!("[geo] DirectML not available, using CPU: {e}"),
    }
    GeoTrunk::new(path, threads, "cpu", input, output).map_err(|e| e.to_string())
}

async fn load(cache: std::path::PathBuf, trunk: &str, labels: &str) -> Result<Loaded, String> {
    let get = |p: String| crate::data_cache::load(cache.clone(), p);
    let head_json: HeadJson = serde_json::from_slice(&get(format!("{trunk}head.json")).await.map_err(|(_, m)| m)?)
        .map_err(|e| format!("head.json: {e}"))?;
    let head_bin = get(format!("{trunk}head.bin")).await.map_err(|(_, m)| m)?;
    let head = Head::from_bin(&head_bin, head_json.n, head_json.d).map_err(|e| e.to_string())?;
    get(format!("{trunk}trunk.onnx")).await.map_err(|(_, m)| m)?;  // cached on disk
    let text = get(labels.to_string()).await.map_err(|(_, m)| m)?;
    let label_ix = parse_labels(&String::from_utf8_lossy(&text));
    let model = cache.join(format!("{trunk}trunk.onnx"));
    let t = open_trunk(&model, &head_json.input, &head_json.hidden)?;
    Ok(Loaded { key: format!("{trunk}|{labels}"), trunk: t, head, rows: head_json.rows, label_ix })
}

/// Scores of one species on a grid (f32 little endian per cell, row-major); empty when the
/// geomodel has no output for it. The first call loads the trunk (provider: geo_grid_ep).
#[tauri::command]
pub async fn geo_grid(app: tauri::AppHandle, state: tauri::State<'_, GeoState>, req: GridRequest) -> Result<tauri::ipc::Response, String> {
    let cache = app.path().app_data_dir().map_err(|e| e.to_string())?.join("data-cache");
    Ok(tauri::ipc::Response::new(run(cache, state.0.clone(), req).await?))
}

/// geo_grid without Tauri: `cache` is the svdata cache folder.
async fn run(cache: std::path::PathBuf, cell: Arc<Mutex<Option<Loaded>>>, req: GridRequest) -> Result<Vec<u8>, String> {
    let trunk = checked(&req.trunk)?;
    let labels = checked(&req.labels)?;
    let key = format!("{trunk}|{labels}");
    let need_load = cell.lock().map_err(|e| e.to_string())?.as_ref().map_or(true, |l| l.key != key);
    if need_load {
        let loaded = load(cache, &trunk, &labels).await?;
        *cell.lock().map_err(|e| e.to_string())? = Some(loaded);
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut guard = cell.lock().map_err(|e| e.to_string())?;
        let l = guard.as_mut().ok_or("geomodel trunk not loaded")?;
        // An overlapping request for another model may have replaced it since the load above.
        if l.key != key {
            return Err(format!("geomodel trunk changed while loading ({key}); try again"));
        }
        let Some(&ix) = l.label_ix.get(req.species.as_str()) else { return Ok(Vec::new()) };
        let mut rows: Vec<usize> = l.rows.iter().filter_map(|r| r.get(ix).copied()).collect();
        rows.sort_unstable();
        rows.dedup();
        let x = grid_points(&req.lats, req.west, req.east, req.cols, req.week);
        let hidden = l.trunk.hidden(&x, 4096).map_err(|e| e.to_string())?;
        Ok(l.head.scores(&hidden, &rows).iter().flat_map(|v| v.to_le_bytes()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Execution provider of the loaded trunk ("cuda", "directml", "cpu"), or "" before the first grid.
#[tauri::command]
pub fn geo_grid_ep(state: tauri::State<'_, GeoState>) -> String {
    state.0.lock().ok().and_then(|g| g.as_ref().map(|l| l.trunk.ep.to_string())).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_by_scientific_name_in_file_order() {
        let ix = parse_labels("BN1\tCuculus canorus\tCommon Cuckoo\nBN2\tTurdus merula\tBlackbird\r\n\n");
        assert_eq!(ix["Cuculus canorus"], 0);
        assert_eq!(ix["Turdus merula"], 1);
        assert_eq!(ix.len(), 2);
    }

    /// The request as the frontend sends it (NativeGeoGridRunner.grid), against a cache folder
    /// with the real trunk: GEO_TRUNK_DIR=models/geo-trunk-v3.0 GEO_LABELS=<geo labels file>
    /// cargo test -p signavis-lite geo_grid -- --ignored
    #[test]
    #[ignore]
    fn frontend_request_end_to_end() {
        let trunk = std::path::PathBuf::from(std::env::var("GEO_TRUNK_DIR").expect("GEO_TRUNK_DIR"));
        let labels = std::path::PathBuf::from(std::env::var("GEO_LABELS").expect("GEO_LABELS"));
        let cache = std::env::temp_dir().join(format!("geo-grid-test-{}", std::process::id()));
        let t = cache.join("models/geo-trunk-v3.0");
        std::fs::create_dir_all(&t).unwrap();
        for f in ["trunk.onnx", "head.bin", "head.json"] { std::fs::copy(trunk.join(f), t.join(f)).unwrap(); }
        std::fs::create_dir_all(cache.join("models/birdnet-v3.0")).unwrap();
        std::fs::copy(&labels, cache.join("models/birdnet-v3.0/G.txt")).unwrap();
        let json = r#"{"trunk":"models/geo-trunk-v3.0/","labels":"models/birdnet-v3.0/G.txt",
            "species":"Cuculus canorus","week":20,"lats":[51.34,-1.0],"west":12.0,"east":12.74,"cols":1}"#;
        let cell = Arc::new(Mutex::new(None));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bytes = rt.block_on(run(cache.clone(), cell.clone(), serde_json::from_str(json).unwrap())).unwrap();
        let v: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        assert_eq!(v.len(), 2);
        assert!((v[0] - 0.9437).abs() < 0.01, "{v:?}");   // Leipzig, mid May (full model 0.9437)
        let none = rt.block_on(run(cache.clone(), cell, serde_json::from_str(&json.replace("Cuculus canorus", "Nobody"))
            .unwrap())).unwrap();
        assert!(none.is_empty());
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn only_model_paths() {
        assert!(checked("models/geo-trunk-v3.0/").is_ok());
        assert!(checked("models/../secret").is_err());
        assert!(checked("demo/x").is_err());
    }
}
