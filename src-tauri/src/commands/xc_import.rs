// ═══════════════════════════════════════════════════════════════════════
// commands/xc_import.rs — Tauri IPC command: download a Xeno-canto
// recording from CDN and import it into a dataset as a RecordingRecord.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;
use tauri::State;
use uuid::Uuid;

use crate::corpus_store::{AudioMetadata, GeoLocation, RecordingRecord};
use crate::helpers::time::now_millis;
use crate::commands::corpus::CorpusStoreState;

// ── argument types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XcGeoLocation {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XcDownloadArgs {
    /// Target dataset ID.
    pub dataset_id: String,
    /// XC numeric ID (as string).
    pub xc_id: String,
    /// Direct audio URL from the XC API response.
    pub audio_url: String,
    /// Suggested filename (e.g. "XC12345.mp3").
    pub filename: String,
    /// Recording timestamp in Unix milliseconds (optional, computed on frontend).
    pub recorded_at_ms: Option<i64>,
    /// Geographic coordinates (optional).
    pub location: Option<XcGeoLocation>,
    /// Flat string metadata to store in recording.fields.
    pub fields: HashMap<String, String>,
}

// ── result type ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XcDownloadResult {
    pub recording_id: String,
    pub filepath: String,
}

// ── command ────────────────────────────────────────────────────────────

/// Downloads an audio file from Xeno-canto and imports it as a Recording.
///
/// The file is saved to `<app_data>/xc-downloads/<dataset_id>/<filename>`.
/// Duplicate detection is done by checking for existing `xc_id` in fields.
#[tauri::command]
pub async fn xc_download_recording(
    store: State<'_, CorpusStoreState>,
    app: tauri::AppHandle,
    args: XcDownloadArgs,
) -> Result<XcDownloadResult, String> {
    // ── resolve download directory ────────────────────────────────
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("xc_download: app_data_dir: {e}"))?;

    let dest_dir = data_dir
        .join("xc-downloads")
        .join(&args.dataset_id);

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("xc_download: create dir: {e}"))?;

    let dest_path: PathBuf = dest_dir.join(&args.filename);

    // ── skip if already imported (xc_id match) ────────────────────
    if let Some(existing_xc_id) = args.fields.get("xc_id") {
        if let Ok(recordings) = store.recording_list_by_dataset(&args.dataset_id, 10_000, 0, None).await {
            if recordings.iter().any(|r| r.fields.get("xc_id").map(|s| s.as_str()) == Some(existing_xc_id.as_str())) {
                return Err(format!("XC{existing_xc_id} already imported into this dataset."));
            }
        }
    }

    // ── download audio ───────────────────────────────────────────
    if args.audio_url.is_empty() {
        return Err("xc_download: audio_url is empty".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("xc_download: build http client: {e}"))?;

    let response = client
        .get(&args.audio_url)
        .send()
        .await
        .map_err(|e| format!("xc_download: HTTP GET {}: {e}", &args.audio_url))?;

    if !response.status().is_success() {
        return Err(format!("xc_download: HTTP {} for {}", response.status(), &args.audio_url));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("xc_download: read body: {e}"))?;

    std::fs::write(&dest_path, &bytes)
        .map_err(|e| format!("xc_download: write file: {e}"))?;

    // ── build RecordingRecord ─────────────────────────────────────
    let recording_id = Uuid::new_v4().to_string();
    let filepath = dest_path
        .to_str()
        .ok_or("xc_download: non-UTF8 path")?
        .to_string();

    let size_bytes = bytes.len() as u64;
    // MP3 bit-rate estimate: 128 kbps → 16000 bytes/s
    let duration_estimate = if size_bytes > 0 {
        size_bytes as f64 / 16_000.0
    } else {
        0.0
    };
    // Try to use xc_duration_s from fields if available
    let duration = args
        .fields
        .get("xc_duration_s")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(duration_estimate);

    let metadata = AudioMetadata {
        duration,
        sample_rate: 44100,
        num_channels: 1,
        size_bytes,
        mime_type: "audio/mpeg".into(),
    };

    let imported_at = now_millis().map_err(|e| e.to_string())? as i64;

    // Parse ISO-8601 recordedAt → Unix ms
    let recorded_at: Option<i64> = args.recorded_at_ms;

    let location: Option<GeoLocation> = args.location.map(|g| GeoLocation {
        latitude: g.latitude,
        longitude: g.longitude,
        altitude: g.altitude,
    });

    let rec = RecordingRecord {
        id: recording_id.clone(),
        dataset_id: args.dataset_id.clone(),
        filepath: filepath.clone(),
        tags: vec![],
        metadata,
        imported_at,
        file_hash: None,
        recorded_at,
        location,
        fields: args.fields,
    };

    store
        .recording_insert(&rec)
        .await
        .map_err(|e| format!("xc_download: store insert: {e}"))?;

    Ok(XcDownloadResult {
        recording_id,
        filepath,
    })
}
