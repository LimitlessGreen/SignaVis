// ═══════════════════════════════════════════════════════════════════════
// commands/corpus.rs — Tauri IPC Commands für Corpus-Verwaltung
// ═══════════════════════════════════════════════════════════════════════

use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::corpus_store::{CorpusRecord, CorpusStore, FieldDefinition};
use crate::helpers::time::now_millis;

pub type CorpusStoreState = Arc<CorpusStore>;

fn new_corpus_id() -> Result<String, String> {
    Ok(Uuid::new_v4().to_string())
}

// ── corpus_create ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusCreateArgs {
    pub name: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn corpus_create(
    store: State<'_, CorpusStoreState>,
    args: CorpusCreateArgs,
) -> Result<JsonValue, String> {
    let id = new_corpus_id()?;
    let now = now_millis()? as i64;
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("corpus_create: name must not be empty".into());
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

    let corpus = CorpusRecord {
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

    store.corpus_create(&corpus).await?;
    serde_json::to_value(&corpus).map_err(|e| format!("corpus_create: serialize: {e}"))
}

// ── corpus_list ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn corpus_list(
    store: State<'_, CorpusStoreState>,
) -> Result<Vec<JsonValue>, String> {
    let corpora = store.corpus_list().await?;
    corpora
        .iter()
        .map(|c| serde_json::to_value(c).map_err(|e| format!("corpus_list: serialize: {e}")))
        .collect()
}

// ── corpus_get ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn corpus_get(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<JsonValue, String> {
    let corpus = store
        .corpus_get(&id)
        .await?
        .ok_or_else(|| format!("corpus_get: not found: {id}"))?;
    serde_json::to_value(&corpus).map_err(|e| format!("corpus_get: serialize: {e}"))
}

// ── corpus_delete ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn corpus_delete(
    store: State<'_, CorpusStoreState>,
    id: String,
) -> Result<(), String> {
    store.corpus_delete(&id).await
}

// ── corpus_update_meta ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusUpdateMetaArgs {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn corpus_update_meta(
    store: State<'_, CorpusStoreState>,
    args: CorpusUpdateMetaArgs,
) -> Result<JsonValue, String> {
    let mut corpus = store
        .corpus_get(&args.id)
        .await?
        .ok_or_else(|| format!("corpus_update_meta: not found: {}", args.id))?;

    if let Some(name) = args.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("corpus_update_meta: name must not be empty".into());
        }
        corpus.name = name;
    }
    if let Some(desc) = args.description {
        corpus.description = if desc.trim().is_empty() { None } else { Some(desc) };
    }
    corpus.updated_at = now_millis()? as i64;

    store.corpus_update(&corpus).await?;
    serde_json::to_value(&corpus).map_err(|e| format!("corpus_update_meta: {e}"))
}

// ── corpus_add_field_to_schema ────────────────────────────────────────
//
// Fügt ein Feld ins Corpus-Schema ein (Idempotent — existiert das Feld
// bereits mit gleichem Namen, wird es übersprungen).

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusAddFieldArgs {
    pub corpus_id: String,
    pub field_name: String,
    pub field_kind: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

#[tauri::command]
pub async fn corpus_add_field_to_schema(
    store: State<'_, CorpusStoreState>,
    args: CorpusAddFieldArgs,
) -> Result<JsonValue, String> {
    let mut corpus = store
        .corpus_get(&args.corpus_id)
        .await?
        .ok_or_else(|| format!("corpus_add_field_to_schema: not found: {}", args.corpus_id))?;

    let name = args.field_name.trim().to_string();
    if name.is_empty() {
        return Err("corpus_add_field_to_schema: field_name must not be empty".into());
    }

    // Idempotent: nur hinzufügen wenn Name noch nicht vorhanden
    if !corpus.field_schema.iter().any(|f| f.name == name) {
        corpus.field_schema.push(FieldDefinition {
            name: name.clone(),
            kind: args.field_kind.trim().to_string(),
            description: args.description.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            group: args.group.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            system: false,
        });
        corpus.updated_at = now_millis()? as i64;
        store.corpus_update(&corpus).await?;
    }

    serde_json::to_value(&corpus).map_err(|e| format!("corpus_add_field_to_schema: {e}"))
}
