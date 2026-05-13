// ═══════════════════════════════════════════════════════════════════════
// commands/corpus.rs — Tauri IPC Commands für Dataset-Verwaltung
// ═══════════════════════════════════════════════════════════════════════

use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::corpus_store::{DatasetRecord, CorpusStore, FieldDefinition};
use crate::helpers::time::now_millis;

pub type CorpusStoreState = Arc<CorpusStore>;

fn new_dataset_id() -> Result<String, String> {
    Ok(Uuid::new_v4().to_string())
}

// ── dataset_create ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetCreateArgs {
    pub name: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn dataset_create(
    store: State<'_, CorpusStoreState>,
    args: DatasetCreateArgs,
) -> Result<JsonValue, String> {
    let id = new_dataset_id()?;
    let now = now_millis()? as i64;
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("dataset_create: name must not be empty".into());
    }

    // System-Pflichtfelder im Schema
    let field_schema = vec![
        FieldDefinition {
            name: "filepath".into(),
            kind: "string".into(),
            description: Some("Absoluter Pfad zur Audiodatei".into()),
            group: None,
            system: true,
        },
        FieldDefinition {
            name: "metadata".into(),
            kind: "dict".into(),
            description: Some("Audio-Metadaten (Dauer, Samplerate, …)".into()),
            group: None,
            system: true,
        },
        FieldDefinition {
            name: "recordedAt".into(),
            kind: "date".into(),
            description: Some("Aufnahmezeitpunkt".into()),
            group: None,
            system: true,
        },
        FieldDefinition {
            name: "location".into(),
            kind: "geo_location".into(),
            description: Some("Geografische Position".into()),
            group: None,
            system: true,
        },
    ];

    let dataset = DatasetRecord {
        id: id.clone(),
        name,
        media_type: "audio".into(),
        created_at: now,
        updated_at: now,
        recording_count: 0,
        field_schema,
        known_tags: vec![],
        description: args.description,
    };

    store.dataset_create(&dataset).await?;
    serde_json::to_value(&dataset).map_err(|e| format!("dataset_create: serialize: {e}"))
}

// ── dataset_list ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn dataset_list(
    store: State<'_, CorpusStoreState>,
) -> Result<Vec<JsonValue>, String> {
    let datasets = store.dataset_list().await?;
    datasets
        .iter()
        .map(|c| serde_json::to_value(c).map_err(|e| format!("dataset_list: serialize: {e}")))
        .collect()
}

// ── dataset_get ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn dataset_get(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<JsonValue, String> {
    let dataset = store
        .dataset_get(&id)
        .await?
        .ok_or_else(|| format!("dataset_get: not found: {id}"))?;
    serde_json::to_value(&dataset).map_err(|e| format!("dataset_get: serialize: {e}"))
}

// ── dataset_delete ────────────────────────────────────────────────────

#[tauri::command]
pub async fn dataset_delete(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<(), String> {
    store.dataset_delete(&id).await
}

// ── dataset_update_meta ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetUpdateMetaArgs {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn dataset_update_meta(
    store: State<'_, CorpusStoreState>,
    args: DatasetUpdateMetaArgs,
) -> Result<JsonValue, String> {
    let mut dataset = store
        .dataset_get(&args.id)
        .await?
        .ok_or_else(|| format!("dataset_update_meta: not found: {}", args.id))?;

    if let Some(name) = args.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("dataset_update_meta: name must not be empty".into());
        }
        dataset.name = name;
    }
    if let Some(desc) = args.description {
        dataset.description = if desc.trim().is_empty() { None } else { Some(desc) };
    }
    dataset.updated_at = now_millis()? as i64;

    store.dataset_update(&dataset).await?;
    serde_json::to_value(&dataset).map_err(|e| format!("dataset_update_meta: {e}"))
}

// ── dataset_add_field_to_schema ───────────────────────────────────────
//
// Fügt ein Feld ins Dataset-Schema ein (Idempotent — existiert das Feld
// bereits mit gleichem Namen, wird es übersprungen).

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetAddFieldArgs {
    pub dataset_id: String,
    pub field_name: String,
    pub field_kind: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

#[tauri::command]
pub async fn dataset_add_field_to_schema(
    store: State<'_, CorpusStoreState>,
    args: DatasetAddFieldArgs,
) -> Result<JsonValue, String> {
    let mut dataset = store
        .dataset_get(&args.dataset_id)
        .await?
        .ok_or_else(|| format!("dataset_add_field_to_schema: not found: {}", args.dataset_id))?;

    let name = args.field_name.trim().to_string();
    if name.is_empty() {
        return Err("dataset_add_field_to_schema: field_name must not be empty".into());
    }

    // Idempotent: nur hinzufügen wenn Name noch nicht vorhanden
    if !dataset.field_schema.iter().any(|f| f.name == name) {
        dataset.field_schema.push(FieldDefinition {
            name: name.clone(),
            kind: args.field_kind.trim().to_string(),
            description: args.description.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            group: args.group.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            system: false,
        });
        dataset.updated_at = now_millis()? as i64;
        store.dataset_update(&dataset).await?;
    }

    serde_json::to_value(&dataset).map_err(|e| format!("dataset_add_field_to_schema: {e}"))
}
