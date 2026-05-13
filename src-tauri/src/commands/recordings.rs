// ═══════════════════════════════════════════════════════════════════════
// commands/recordings.rs — Tauri IPC Commands für Recording-Verwaltung
// inkl. Ordner-Import-Pipeline
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::corpus_store::{AudioMetadata, RecordingRecord};
use crate::helpers::time::now_millis;

use crate::commands::corpus::CorpusStoreState;

// Bekannte Audio-Erweiterungen
const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave", "mp3", "flac", "ogg", "opus", "aac", "m4a", "wv", "aif", "aiff",
];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| AUDIO_EXTENSIONS.contains(&s.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Berechnet SHA-256-Hash der ersten 64KB einer Datei (schnell + ausreichend für Duplikaterkennung).
fn file_hash_fast(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 65536];
    let n = file.read(&mut buf).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&buf[..n]);
    // Größe hinzufügen um Kollisionen zu reduzieren
    if let Ok(meta) = std::fs::metadata(path) {
        hasher.update(meta.len().to_le_bytes());
    }
    Some(hex::encode(hasher.finalize()))
}

/// Extrahiert einfache Audio-Metadaten ohne externe Abhängigkeit.
/// Für WAV: Header parsen. Für andere Formate: Schätzwerte aus Dateigröße.
fn extract_audio_metadata(path: &Path) -> AudioMetadata {
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime_type = match ext.as_str() {
        "wav" | "wave" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "aif" | "aiff" => "audio/aiff",
        _ => "audio/octet-stream",
    };

    // WAV-Header parsen für genaue Metadaten
    let wav_meta = if ext == "wav" || ext == "wave" {
        parse_wav_header(path)
    } else {
        None
    };

    if let Some((sample_rate, num_channels, duration)) = wav_meta {
        AudioMetadata {
            duration,
            sample_rate,
            num_channels,
            size_bytes,
            mime_type: mime_type.into(),
        }
    } else {
        // Schätzung: bei 48kHz Mono ca. 96kB/s
        let estimated_duration = if size_bytes > 0 {
            size_bytes as f64 / 96_000.0
        } else {
            0.0
        };
        AudioMetadata {
            duration: estimated_duration,
            sample_rate: 48000,
            num_channels: 1,
            size_bytes,
            mime_type: mime_type.into(),
        }
    }
}

/// Parst WAV-Datei-Header um Samplerate, Kanäle und Dauer zu extrahieren.
fn parse_wav_header(path: &Path) -> Option<(u32, u8, f64)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header).ok()?;

    // RIFF/WAVE prüfen
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return None;
    }
    // PCM fmt chunk (kann nicht bei allen WAVs an Position 12 sein, aber für Standard-WAV)
    if &header[12..16] != b"fmt " {
        return None;
    }

    let sample_rate = u32::from_le_bytes(header[24..28].try_into().ok()?);
    let num_channels = u16::from_le_bytes(header[22..24].try_into().ok()?) as u8;
    let bits_per_sample = u16::from_le_bytes(header[34..36].try_into().ok()?);
    let data_chunk_size = u32::from_le_bytes(header[40..44].try_into().ok()?);

    if sample_rate == 0 || num_channels == 0 || bits_per_sample == 0 {
        return None;
    }

    let bytes_per_sample = bits_per_sample as u32 / 8;
    let total_samples = data_chunk_size as f64 / (num_channels as f64 * bytes_per_sample as f64);
    let duration = total_samples / sample_rate as f64;

    Some((sample_rate, num_channels, duration))
}

/// Extrahiert Metadaten aus dem Dateipfad anhand eines Musters.
/// Muster: "{recorder_id}/{site}/{week}/"
/// Ergebnis: HashMap mit extrahierten Werten.
fn extract_path_fields(
    filepath: &Path,
    base_dir: &Path,
    pattern: &str,
) -> std::collections::HashMap<String, String> {
    let mut fields = std::collections::HashMap::new();

    // Relativen Pfad ermitteln
    let rel_path = match filepath.strip_prefix(base_dir) {
        Ok(p) => p,
        Err(_) => return fields,
    };

    // Verzeichniskomponenten als Strings
    let components: Vec<&str> = rel_path
        .components()
        .filter_map(|c| {
            if let std::path::Component::Normal(s) = c {
                s.to_str()
            } else {
                None
            }
        })
        .collect();

    // Muster-Tokens (ohne Dateiname)
    let pattern_parts: Vec<&str> = pattern
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    // Komponentenanzahl stimmt überein (letzte Komponente ist Dateiname, überspringen)
    let dir_components = if components.len() > 1 {
        &components[..components.len() - 1]
    } else {
        return fields;
    };

    for (i, part) in pattern_parts.iter().enumerate() {
        if i >= dir_components.len() {
            break;
        }
        // Prüfen ob Platzhalter {field_name}
        if let (Some(start), Some(end)) = (part.find('{'), part.rfind('}')) {
            let field_name = &part[start + 1..end];
            if !field_name.is_empty() {
                fields.insert(
                    field_name.to_string(),
                    dir_components[i].to_string(),
                );
            }
        }
    }

    fields
}

// ── recording_import_folder ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingImportFolderArgs {
    pub corpus_id: String,
    pub folder_path: String,
    pub path_pattern: Option<String>,
    pub skip_duplicates: Option<bool>,
    pub extensions: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u64,
    pub skipped: u64,
    pub errors: u64,
    pub error_messages: Vec<String>,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn recording_import_folder(
    store: State<'_, CorpusStoreState>,
    args: RecordingImportFolderArgs,
) -> Result<ImportResult, String> {
    let start = std::time::Instant::now();

    // Corpus-Existenz prüfen
    let _ = store
        .corpus_get(&args.corpus_id)
        .await?
        .ok_or_else(|| format!("recording_import_folder: corpus not found: {}", args.corpus_id))?;

    let folder = PathBuf::from(&args.folder_path);
    if !folder.exists() || !folder.is_dir() {
        return Err(format!(
            "recording_import_folder: path is not a directory: {}",
            folder.display()
        ));
    }

    let skip_dupes = args.skip_duplicates.unwrap_or(true);
    let allowed_exts: Option<Vec<String>> = args
        .extensions
        .map(|v| v.iter().map(|s| s.to_lowercase()).collect());
    let pattern = args.path_pattern.as_deref().unwrap_or("");
    let now = now_millis().unwrap_or(0) as i64;

    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors = 0u64;
    let mut error_messages = Vec::new();
    let mut batch: Vec<RecordingRecord> = Vec::new();

    // Ordner-Traversierung
    for entry in WalkDir::new(&folder)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        // Erweiterungsfilter
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let allowed = if let Some(ref exts) = allowed_exts {
            exts.contains(&ext)
        } else {
            is_audio_file(path)
        };

        if !allowed {
            continue;
        }

        // Dateipfad als absoluten Pfad sichern
        let abs_path = match path.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                error_messages.push(format!("{}: {}", path.display(), e));
                errors += 1;
                continue;
            }
        };

        // Duplikat-Check via Hash
        let file_hash = if skip_dupes {
            file_hash_fast(&abs_path)
        } else {
            None
        };

        if let Some(ref hash) = file_hash {
            match store.recording_hash_exists(hash).await {
                Ok(true) => {
                    skipped += 1;
                    continue;
                }
                Ok(false) => {}
                Err(e) => {
                    error_messages.push(format!("hash check {}: {}", abs_path.display(), e));
                    errors += 1;
                    continue;
                }
            }
        }

        // Metadaten extrahieren
        let metadata = extract_audio_metadata(&abs_path);

        // Pfad-basierte Metadaten extrahieren
        let path_fields = if !pattern.is_empty() {
            extract_path_fields(&abs_path, &folder, pattern)
        } else {
            std::collections::HashMap::new()
        };

        // Aufnahmezeitpunkt aus Datei-Modifikationszeit ermitteln (Fallback)
        // Aufnahmezeitpunkt aus Datei-Modifikationszeit (Fallback; später via BEXT/ID3)
        let recorded_at = std::fs::metadata(&abs_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

        let rec = RecordingRecord {
            id: Uuid::new_v4().to_string(),
            corpus_id: args.corpus_id.clone(),
            filepath: abs_path.to_string_lossy().into_owned(),
            tags: vec![],
            metadata,
            imported_at: now,
            file_hash,
            recorded_at,
            fields: path_fields,
        };

        batch.push(rec);

        // Batch-Insert alle 100 Einträge
        if batch.len() >= 100 {
            match store.recording_bulk_insert(&batch).await {
                Ok(n) => imported += n,
                Err(e) => {
                    error_messages.push(format!("batch insert: {e}"));
                    errors += batch.len() as u64;
                }
            }
            batch.clear();
        }
    }

    // Verbleibende Records einfügen
    if !batch.is_empty() {
        match store.recording_bulk_insert(&batch).await {
            Ok(n) => imported += n,
            Err(e) => {
                error_messages.push(format!("final batch insert: {e}"));
                errors += batch.len() as u64;
            }
        }
    }

    // Recording-Count im Corpus aktualisieren
    if imported > 0 {
        if let Ok(Some(mut corpus)) = store.corpus_get(&args.corpus_id).await {
            let total = store
                .recording_count_by_corpus(&args.corpus_id)
                .await
                .unwrap_or(corpus.recording_count + imported);
            corpus.recording_count = total;
            corpus.updated_at = now;
            let _ = store.corpus_update(&corpus).await;
        }
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors,
        error_messages,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

// ── recording_list ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingListArgs {
    pub corpus_id: String,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[tauri::command]
pub async fn recording_list(
    store: State<'_, CorpusStoreState>,
    args: RecordingListArgs,
) -> Result<Vec<JsonValue>, String> {
    let limit = args.limit.unwrap_or(100).min(1000);
    let offset = args.offset.unwrap_or(0);
    let recs = store
        .recording_list_by_corpus(&args.corpus_id, limit, offset)
        .await?;
    recs.iter()
        .map(|r| serde_json::to_value(r).map_err(|e| format!("recording_list: serialize: {e}")))
        .collect()
}

// ── recording_get ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn recording_get(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<JsonValue, String> {
    let rec = store
        .recording_get(&id)
        .await?
        .ok_or_else(|| format!("recording_get: not found: {id}"))?;
    serde_json::to_value(&rec).map_err(|e| format!("recording_get: serialize: {e}"))
}

// ── recording_set_tags ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSetTagsArgs {
    pub id: String,
    pub tags: Vec<String>,
}

#[tauri::command]
pub async fn recording_set_tags(
    store: State<'_, CorpusStoreState>,
    args: RecordingSetTagsArgs,
) -> Result<(), String> {
    store
        .recording_update_tags(&args.id, &args.tags)
        .await
}

// ── recording_delete ──────────────────────────────────────────────────

#[tauri::command]
pub async fn recording_delete(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<(), String> {
    store.recording_delete(&id).await
}

// ── recording_count ───────────────────────────────────────────────────

#[tauri::command]
pub async fn recording_count(
    store: State<'_, CorpusStoreState>,
    corpus_id: String,
) -> Result<u64, String> {
    store.recording_count_by_corpus(&corpus_id).await
}

// ── recording_distinct_values ─────────────────────────────────────────

/// Gibt alle distinkten Werte für ein gegebenes Pfad-Feld innerhalb eines
/// Corpus zurück. Wird für die Dropdown-Filter in der Toolbar verwendet.
///
/// Beispiel: field_name = "site" → ["Waldrand-Nord", "Seeufer", …]
#[tauri::command]
pub async fn recording_distinct_values(
    store: State<'_, CorpusStoreState>,
    corpus_id: String,
    field_name: String,
) -> Result<Vec<String>, String> {
    store.recording_distinct_field_values(&corpus_id, &field_name).await
}
