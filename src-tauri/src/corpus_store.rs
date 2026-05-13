// ═══════════════════════════════════════════════════════════════════════
// corpus_store.rs — SurrealDB-based Dataset/Recording store
//
// Operating modes:
//   - With feature "embedded-db": SurrealKV (persistent, pure Rust)
//   - With feature "mem-db":      Mem backend (in-memory, tests/PoC)
//   - Fallback:                   JSON files (no surrealdb feature active)
//
// The store is registered as Tauri managed state and is
// Clone + Send + Sync.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// corpus_store.rs — SurrealDB-based Dataset/Recording store
//
// Operating modes:
//   - With feature "embedded-db": SurrealKV (persistent, pure Rust)
//   - With feature "mem-db":      Mem backend (in-memory, tests/PoC)
//   - With feature "server-db":   Remote SurrealDB via WebSocket
//   - Fallback:                   JSON files (no surrealdb feature active)
//
// The store is registered as Tauri managed state and is
// Clone + Send + Sync.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Data types ────────────────────────────────────────────────────────

/// A saved view: a named, persisted filter/sort pipeline on a dataset.
/// `stages` are opaque JSON so the Rust layer stays decoupled from the
/// TypeScript ViewStage definitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub name: String,
    /// Ordered list of ViewStage objects (schema defined in TypeScript).
    pub stages: Vec<serde_json::Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub duration: f64,
    pub sample_rate: u32,
    pub num_channels: u8,
    pub size_bytes: u64,
    pub mime_type: String,
}

impl Default for AudioMetadata {
    fn default() -> Self {
        Self {
            duration: 0.0,
            sample_rate: 0,
            num_channels: 1,
            size_bytes: 0,
            mime_type: "audio/wav".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDefinition {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub system: bool,
}

/// Controls who can see a dataset in server mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatasetVisibility {
    Private,
    Shared,
    Public,
}

impl Default for DatasetVisibility {
    fn default() -> Self { Self::Private }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRecord {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub recording_count: u64,
    pub field_schema: Vec<FieldDefinition>,
    pub known_tags: Vec<String>,
    #[serde(default)]
    pub saved_views: Vec<SavedView>,
    /// Analysis runs keyed by job_id.
    #[serde(default)]
    pub analysis_runs: std::collections::HashMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Visibility for shared server deployments.
    #[serde(default)]
    pub visibility: DatasetVisibility,
}

/// Geographic position of a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoLocation {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRecord {
    pub id: String,
    pub dataset_id: String,
    pub filepath: String,
    pub tags: Vec<String>,
    pub metadata: AudioMetadata,
    pub imported_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<i64>, // Unix milliseconds; refined later via BEXT/ID3
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<GeoLocation>,
    #[serde(default)]
    pub fields: std::collections::HashMap<String, String>,
}

// ── Store ──────────────────────────────────────────────────────────────

#[cfg(any(feature = "embedded-db", feature = "mem-db", feature = "server-db"))]
mod surreal_impl {
    use super::*;
    use std::sync::{Arc, Mutex};
    use surrealdb::Surreal;
    use surrealdb::engine::any::Any;

    /// Helper struct for COUNT() queries (serde_json::Value is not compatible with SurrealDB)
    #[derive(serde::Deserialize)]
    struct CountRow {
        c: i64,
    }

    pub struct CorpusStore {
        /// Local embedded DB handle (available when embedded-db or mem-db is active).
        #[cfg(any(feature = "embedded-db", feature = "mem-db"))]
        embedded_db: Surreal<Any>,
        /// Server DB handle — set when connected to a remote SurrealDB.
        /// When Some, all queries are routed here instead of the embedded db.
        server_db: Arc<Mutex<Option<Surreal<Any>>>>,
    }

    impl CorpusStore {
        /// Returns the currently active DB handle: server if connected, else local.
        fn active_db(&self) -> Result<Surreal<Any>, String> {
            {
                let guard = self.server_db.lock().unwrap();
                if let Some(ref db) = *guard {
                    return Ok(db.clone());
                }
            }
            #[cfg(any(feature = "embedded-db", feature = "mem-db"))]
            return Ok(self.embedded_db.clone());
            #[cfg(not(any(feature = "embedded-db", feature = "mem-db")))]
            Err("No database connection established. Connect to a SurrealDB server first.".to_string())
        }

        #[cfg(feature = "embedded-db")]
        pub async fn open(data_dir: PathBuf) -> Result<Self, String> {
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("corpus_store: cannot create data dir: {e}"))?;
            let db_path = data_dir.join("corpus.db");
            let db = surrealdb::engine::any::connect(
                format!("surrealkv://{}", db_path.to_string_lossy()),
            )
            .await
            .map_err(|e| format!("corpus_store: surrealdb open: {e}"))?;
            db.use_ns("signavis")
                .use_db("local")
                .await
                .map_err(|e| format!("corpus_store: use_ns/db: {e}"))?;
            let store = Self { embedded_db: db, server_db: Arc::new(Mutex::new(None)) };
            store.init_schema().await?;
            Ok(store)
        }

        #[cfg(all(feature = "mem-db", not(feature = "embedded-db")))]
        pub async fn open(_data_dir: PathBuf) -> Result<Self, String> {
            let db = surrealdb::engine::any::connect("mem://")
                .await
                .map_err(|e| format!("corpus_store: surrealdb mem open: {e}"))?;
            db.use_ns("signavis")
                .use_db("local")
                .await
                .map_err(|e| format!("corpus_store: use_ns/db: {e}"))?;
            let store = Self { embedded_db: db, server_db: Arc::new(Mutex::new(None)) };
            store.init_schema().await?;
            Ok(store)
        }

        #[cfg(all(
            feature = "server-db",
            not(feature = "embedded-db"),
            not(feature = "mem-db")
        ))]
        pub async fn open(_data_dir: PathBuf) -> Result<Self, String> {
            // Server-only mode: starts disconnected; call reconnect_server() after login.
            Ok(Self { server_db: Arc::new(Mutex::new(None)) })
        }

        async fn init_schema(&self) -> Result<(), String> {
            let db = self.active_db()?;
            // Dataset table (schemaless — avoids conflicts with id:Thing vs. string)
            db.query(
                    "DEFINE TABLE IF NOT EXISTS dataset SCHEMALESS;
                     DEFINE INDEX IF NOT EXISTS idx_dataset_name ON dataset FIELDS name;",
                )
                .await
                .map_err(|e| format!("corpus_store: init dataset schema: {e}"))?;

            // Recording table (schemaless for dynamic fields)
            db.query(
                    "DEFINE TABLE IF NOT EXISTS recording SCHEMALESS;
                     DEFINE INDEX IF NOT EXISTS idx_recording_dataset ON recording FIELDS dataset_id;
                     DEFINE INDEX IF NOT EXISTS idx_recording_filepath ON recording FIELDS filepath;
                     DEFINE INDEX IF NOT EXISTS idx_recording_hash ON recording FIELDS file_hash;",
                )
                .await
                .map_err(|e| format!("corpus_store: init recording schema: {e}"))?;

            Ok(())
        }

        /// Connect to a remote SurrealDB server using a JWT token obtained from login.
        /// After this all queries are routed to the remote server.
        #[cfg(feature = "server-db")]
        pub async fn reconnect_server(
            &self,
            ws_endpoint: &str,
            namespace: &str,
            database: &str,
            token: &str,
        ) -> Result<(), String> {
            let db = surrealdb::engine::any::connect(ws_endpoint)
                .await
                .map_err(|e| format!("corpus_store: connect to server: {e}"))?;
            db.authenticate(surrealdb::opt::auth::Jwt::from(token))
                .await
                .map_err(|e| format!("corpus_store: authenticate: {e}"))?;
            db.use_ns(namespace)
                .use_db(database)
                .await
                .map_err(|e| format!("corpus_store: use_ns/db: {e}"))?;
            // Ensure schema exists on the server too
            db.query(
                    "DEFINE TABLE IF NOT EXISTS dataset SCHEMALESS;
                     DEFINE TABLE IF NOT EXISTS recording SCHEMALESS;",
                )
                .await
                .map_err(|e| format!("corpus_store: server schema init: {e}"))?;
            *self.server_db.lock().unwrap() = Some(db);
            Ok(())
        }

        /// Disconnect from the remote server and fall back to the local embedded DB.
        pub fn disconnect_server(&self) {
            *self.server_db.lock().unwrap() = None;
        }

        // ── Dataset CRUD ─────────────────────────────────────────────

        pub async fn dataset_create(&self, dataset: &DatasetRecord) -> Result<(), String> {
            let db = self.active_db()?;
            db.query("CREATE type::thing('dataset', $id) CONTENT $record")
                .bind(("id", dataset.id.clone()))
                .bind(("record", dataset.clone()))
                .await
                .map_err(|e| format!("dataset_create: {e}"))?;
            Ok(())
        }

        pub async fn dataset_get(&self, id: &str) -> Result<Option<DatasetRecord>, String> {
            let db = self.active_db()?;
            let rid = id.to_owned();
            let mut resp = db
                .query("SELECT *, record::id(id) AS id FROM type::thing('dataset', $id)")
                .bind(("id", rid))
                .await
                .map_err(|e| format!("dataset_get: {e}"))?;
            let rows: Vec<DatasetRecord> =
                resp.take(0).map_err(|e| format!("dataset_get take: {e}"))?;
            Ok(rows.into_iter().next())
        }

        pub async fn dataset_list(&self) -> Result<Vec<DatasetRecord>, String> {
            let db = self.active_db()?;
            let mut resp = db
                .query("SELECT *, record::id(id) AS id FROM dataset")
                .await
                .map_err(|e| format!("dataset_list: {e}"))?;
            let result: Vec<DatasetRecord> =
                resp.take(0).map_err(|e| format!("dataset_list take: {e}"))?;
            Ok(result)
        }

        pub async fn dataset_update(&self, dataset: &DatasetRecord) -> Result<(), String> {
            let db = self.active_db()?;
            db.query("UPDATE type::thing('dataset', $id) CONTENT $record")
                .bind(("id", dataset.id.clone()))
                .bind(("record", dataset.clone()))
                .await
                .map_err(|e| format!("dataset_update: {e}"))?;
            Ok(())
        }

        pub async fn dataset_delete(&self, id: &str) -> Result<(), String> {
            let db = self.active_db()?;
            // Delete all recordings belonging to the dataset
            let cid = id.to_owned();
            db.query("DELETE recording WHERE datasetId = $cid")
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("dataset_delete recordings: {e}"))?;
            db.query("DELETE type::thing('dataset', $id)")
                .bind(("id", id.to_owned()))
                .await
                .map_err(|e| format!("dataset_delete: {e}"))?;
            Ok(())
        }

        /// Updates only the `visibility` field of a dataset.
        pub async fn dataset_set_visibility(
            &self,
            dataset_id: &str,
            visibility: DatasetVisibility,
        ) -> Result<(), String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("dataset_set_visibility: dataset '{dataset_id}' not found"))?;
            dataset.visibility = visibility;
            dataset.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            self.dataset_update(&dataset).await
        }

        // ── Recording CRUD ────────────────────────────────────────────

        pub async fn recording_insert(&self, rec: &RecordingRecord) -> Result<(), String> {
            let db = self.active_db()?;
            db.query("CREATE type::thing('recording', $id) CONTENT $record")
                .bind(("id", rec.id.clone()))
                .bind(("record", rec.clone()))
                .await
                .map_err(|e| format!("recording_insert: {e}"))?;
            Ok(())
        }

        pub async fn recording_bulk_insert(
            &self,
            records: &[RecordingRecord],
        ) -> Result<u64, String> {
            let mut count = 0u64;
            for rec in records {
                self.recording_insert(rec).await?;
                count += 1;
            }
            Ok(count)
        }

        pub async fn recording_get(
            &self,
            id: &str,
        ) -> Result<Option<RecordingRecord>, String> {
            let db = self.active_db()?;
            let rid = id.to_owned();
            let mut resp = db
                .query("SELECT *, record::id(id) AS id FROM type::thing('recording', $id)")
                .bind(("id", rid))
                .await
                .map_err(|e| format!("recording_get: {e}"))?;
            let rows: Vec<RecordingRecord> =
                resp.take(0).map_err(|e| format!("recording_get take: {e}"))?;
            Ok(rows.into_iter().next())
        }

        pub async fn recording_list_by_dataset(
            &self,
            dataset_id: &str,
            limit: u64,
            offset: u64,
            tag_filter: Option<&str>,
        ) -> Result<Vec<RecordingRecord>, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let builder = if let Some(tag) = tag_filter {
                let q = "SELECT *, record::id(id) AS id FROM recording
                         WHERE datasetId = $cid AND $tag IN tags
                         ORDER BY importedAt DESC, id ASC
                         LIMIT $lim START $off";
                db.query(q)
                    .bind(("cid", cid))
                    .bind(("tag", tag.to_owned()))
                    .bind(("lim", limit))
                    .bind(("off", offset))
            } else {
                let q = "SELECT *, record::id(id) AS id FROM recording
                         WHERE datasetId = $cid
                         ORDER BY importedAt DESC, id ASC
                         LIMIT $lim START $off";
                db.query(q)
                    .bind(("cid", cid))
                    .bind(("lim", limit))
                    .bind(("off", offset))
            };
            let mut response = builder
                .await
                .map_err(|e| format!("recording_list_by_dataset: {e}"))?;
            let result: Vec<RecordingRecord> =
                response.take(0).map_err(|e| format!("recording_list_by_dataset take: {e}"))?;
            Ok(result)
        }

        // ── Saved Views ───────────────────────────────────────────────

        /// Upserts a saved view on a dataset (insert or replace by name).
        pub async fn dataset_save_view(
            &self,
            dataset_id: &str,
            view: SavedView,
        ) -> Result<DatasetRecord, String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("dataset_save_view: dataset '{dataset_id}' not found"))?;
            dataset.saved_views.retain(|v| v.name != view.name);
            dataset.saved_views.push(view);
            dataset.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            self.dataset_update(&dataset).await?;
            Ok(dataset)
        }

        /// Removes a saved view by name. No-op if the name doesn't exist.
        pub async fn dataset_delete_view(
            &self,
            dataset_id: &str,
            view_name: &str,
        ) -> Result<DatasetRecord, String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("dataset_delete_view: dataset '{dataset_id}' not found"))?;
            dataset.saved_views.retain(|v| v.name != view_name);
            dataset.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            self.dataset_update(&dataset).await?;
            Ok(dataset)
        }

        // ── Analysis Runs ─────────────────────────────────────────────

        /// Inserts or replaces an analysis run record (keyed by run.key).
        pub async fn upsert_analysis_run(
            &self,
            dataset_id: &str,
            run: &AnalysisRunRecord,
        ) -> Result<(), String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("upsert_analysis_run: dataset '{dataset_id}' not found"))?;
            let value = serde_json::to_value(run)
                .map_err(|e| format!("upsert_analysis_run: serialize: {e}"))?;
            dataset.analysis_runs.insert(run.key.clone(), value);
            self.dataset_update(&dataset).await
        }

        pub async fn recording_count_by_dataset(&self, dataset_id: &str) -> Result<u64, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let mut response = db
                .query("SELECT count() AS c FROM recording WHERE datasetId = $cid GROUP ALL")
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("recording_count: {e}"))?;
            let rows: Vec<CountRow> =
                response.take(0).map_err(|e| format!("recording_count take: {e}"))?;
            let count = rows.first().map(|r| r.c as u64).unwrap_or(0);
            Ok(count)
        }

        pub async fn recording_update_tags(
            &self,
            id: &str,
            tags: &[String],
        ) -> Result<(), String> {
            let db = self.active_db()?;
            let rid = id.to_owned();
            let owned_tags: Vec<String> = tags.to_vec();
            db.query("UPDATE type::thing('recording', $rid) SET tags = $tags")
                .bind(("rid", rid))
                .bind(("tags", owned_tags))
                .await
                .map_err(|e| format!("recording_update_tags: {e}"))?;
            Ok(())
        }

        pub async fn recording_hash_exists(&self, hash: &str) -> Result<bool, String> {
            let db = self.active_db()?;
            let owned_hash = hash.to_owned();
            let mut response = db
                .query("SELECT count() AS c FROM recording WHERE fileHash = $hash GROUP ALL")
                .bind(("hash", owned_hash))
                .await
                .map_err(|e| format!("recording_hash_exists: {e}"))?;
            let rows: Vec<CountRow> =
                response.take(0).map_err(|e| format!("recording_hash_exists take: {e}"))?;
            Ok(rows.first().map(|r| r.c > 0).unwrap_or(false))
        }

        pub async fn recording_delete(&self, id: &str) -> Result<(), String> {
            let db = self.active_db()?;
            db.query("DELETE type::thing('recording', $id)")
                .bind(("id", id.to_owned()))
                .await
                .map_err(|e| format!("recording_delete: {e}"))?;
            Ok(())
        }

        /// Returns all distinct values of a path field within a dataset.
        /// Path fields are stored as camelCase keys in the `fields` map.
        pub async fn recording_distinct_field_values(
            &self,
            dataset_id: &str,
            field_name: &str,
        ) -> Result<Vec<String>, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let field = field_name.to_owned();
            // SurrealQL: fields in the fields map are addressed as fields.{name}
            let mut resp = db
                .query(format!(
                    "SELECT DISTINCT fields.{field} AS val FROM recording WHERE datasetId = $cid AND fields.{field} != NONE"
                ))
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("recording_distinct_field_values: {e}"))?;

            #[derive(serde::Deserialize)]
            struct Row { val: Option<String> }
            let rows: Vec<Row> = resp
                .take(0)
                .map_err(|e| format!("recording_distinct_field_values take: {e}"))?;

            let mut values: Vec<String> = rows
                .into_iter()
                .filter_map(|r| r.val)
                .collect();
            values.sort_unstable();
            Ok(values)
        }

        /// Returns all recordings of a dataset without pagination (for batch operations).
        pub async fn recording_list_by_dataset_all(
            &self,
            dataset_id: &str,
        ) -> Result<Vec<RecordingRecord>, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let mut response = db
                .query(
                    "SELECT *, record::id(id) AS id FROM recording
                     WHERE datasetId = $cid
                     ORDER BY importedAt ASC, id ASC",
                )
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("recording_list_by_dataset_all: {e}"))?;
            let result: Vec<RecordingRecord> =
                response.take(0).map_err(|e| format!("recording_list_by_dataset_all take: {e}"))?;
            Ok(result)
        }

        /// Sets an arbitrary dynamic field on a recording (SurrealDB SCHEMALESS).
        ///
        /// `field_name` must already be validated by `sanitize_field_name`
        /// (only `[a-zA-Z][a-zA-Z0-9_]*`) — it is interpolated directly into the query.
        pub async fn recording_set_dynamic_field(
            &self,
            id: &str,
            field_name: &str,
            value: serde_json::Value,
        ) -> Result<(), String> {
            let db = self.active_db()?;
            let query = format!(
                "UPDATE type::thing('recording', $id) SET {} = $value",
                field_name
            );
            db.query(query)
                .bind(("id", id.to_owned()))
                .bind(("value", value))
                .await
                .map_err(|e| format!("recording_set_dynamic_field: {e}"))?;
            Ok(())
        }

        /// Returns a single recording as a raw JSON value, merging all dynamic
        /// top-level SurrealDB properties into the `fields` sub-object so the
        /// TypeScript `Recording.fields` interface is fully populated.
        pub async fn recording_get_json(
            &self,
            id: &str,
        ) -> Result<Option<serde_json::Value>, String> {
            let db = self.active_db()?;
            let rid = id.to_owned();
            let mut resp = db
                .query("SELECT *, record::id(id) AS id FROM type::thing('recording', $id)")
                .bind(("id", rid))
                .await
                .map_err(|e| format!("recording_get_json: {e}"))?;
            let rows: Vec<serde_json::Value> =
                resp.take(0).map_err(|e| format!("recording_get_json take: {e}"))?;
            Ok(rows.into_iter().next().map(recording_doc_merge_fields))
        }

        /// Returns all recordings in a dataset as raw JSON, with dynamic fields
        /// merged into the `fields` sub-object.
        pub async fn recording_list_json(
            &self,
            dataset_id: &str,
            limit: u64,
            offset: u64,
            tag_filter: Option<&str>,
        ) -> Result<Vec<serde_json::Value>, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let builder = if let Some(tag) = tag_filter {
                let q = "SELECT *, record::id(id) AS id FROM recording
                         WHERE datasetId = $cid AND $tag IN tags
                         ORDER BY importedAt DESC, id ASC
                         LIMIT $lim START $off";
                db.query(q)
                    .bind(("cid", cid))
                    .bind(("tag", tag.to_owned()))
                    .bind(("lim", limit))
                    .bind(("off", offset))
            } else {
                let q = "SELECT *, record::id(id) AS id FROM recording
                         WHERE datasetId = $cid
                         ORDER BY importedAt DESC, id ASC
                         LIMIT $lim START $off";
                db.query(q)
                    .bind(("cid", cid))
                    .bind(("lim", limit))
                    .bind(("off", offset))
            };
            let mut response = builder
                .await
                .map_err(|e| format!("recording_list_json: {e}"))?;
            let rows: Vec<serde_json::Value> =
                response.take(0).map_err(|e| format!("recording_list_json take: {e}"))?;
            Ok(rows.into_iter().map(recording_doc_merge_fields).collect())
        }

        /// Returns all recordings in a dataset as raw JSON (no pagination),
        /// with dynamic fields merged. Used for embedding/similarity operations.
        pub async fn recording_list_all_json(
            &self,
            dataset_id: &str,
        ) -> Result<Vec<serde_json::Value>, String> {
            let db = self.active_db()?;
            let cid = dataset_id.to_owned();
            let mut response = db
                .query(
                    "SELECT *, record::id(id) AS id FROM recording
                     WHERE datasetId = $cid
                     ORDER BY importedAt ASC, id ASC",
                )
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("recording_list_all_json: {e}"))?;
            let rows: Vec<serde_json::Value> =
                response.take(0).map_err(|e| format!("recording_list_all_json take: {e}"))?;
            Ok(rows.into_iter().map(recording_doc_merge_fields).collect())
        }
    }
}

/// Merges all dynamic top-level SurrealDB properties into the `fields` sub-object
/// so the TypeScript `Recording.fields: Record<string, unknown>` is fully populated.
///
/// Base fields that stay at the top level: id, datasetId, filepath, tags,
/// metadata, importedAt, fileHash, recordedAt.
/// Everything else (birdnetV24, embedding, umap2d, …) is moved into `fields`.
pub(crate) fn recording_doc_merge_fields(mut doc: serde_json::Value) -> serde_json::Value {
    const BASE: &[&str] = &[
        "id", "datasetId", "dataset_id", "filepath",
        "tags", "metadata", "importedAt", "imported_at",
        "fileHash", "file_hash", "recordedAt", "recorded_at",
    ];

    let Some(obj) = doc.as_object_mut() else { return doc };

    // Extract existing `fields` map (string path-fields from import)
    let mut fields_map = match obj.remove("fields") {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };

    // Move dynamic top-level properties (non-base) into fields_map
    let dynamic_keys: Vec<String> = obj
        .keys()
        .filter(|k| !BASE.contains(&k.as_str()))
        .cloned()
        .collect();
    for key in dynamic_keys {
        if let Some(val) = obj.remove(&key) {
            fields_map.insert(key, val);
        }
    }

    obj.insert("fields".to_string(), serde_json::Value::Object(fields_map));
    doc
}

/// Fallback: when neither embedded-db, mem-db, nor server-db is active.
#[cfg(not(any(feature = "embedded-db", feature = "mem-db", feature = "server-db")))]
mod json_fallback {
    use super::*;

    pub struct CorpusStore {
        base_dir: PathBuf,
    }

    impl CorpusStore {
        pub async fn open(data_dir: PathBuf) -> Result<Self, String> {
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("corpus_store(json): create dir: {e}"))?;
            Ok(Self { base_dir: data_dir })
        }

        fn dataset_path(&self, id: &str) -> PathBuf {
            self.base_dir.join(format!("{id}.dataset.json"))
        }

        fn recordings_dir(&self, dataset_id: &str) -> PathBuf {
            self.base_dir.join(format!("{dataset_id}_recordings"))
        }

        pub async fn dataset_create(&self, dataset: &DatasetRecord) -> Result<(), String> {
            let json = serde_json::to_string_pretty(dataset)
                .map_err(|e| format!("dataset_create(json): {e}"))?;
            std::fs::write(self.dataset_path(&dataset.id), json)
                .map_err(|e| format!("dataset_create(json): {e}"))
        }

        pub async fn dataset_get(&self, id: &str) -> Result<Option<DatasetRecord>, String> {
            let path = self.dataset_path(id);
            if !path.exists() {
                return Ok(None);
            }
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("dataset_get(json): {e}"))?;
            let dataset: DatasetRecord = serde_json::from_str(&raw)
                .map_err(|e| format!("dataset_get(json): malformed: {e}"))?;
            Ok(Some(dataset))
        }

        pub async fn dataset_list(&self) -> Result<Vec<DatasetRecord>, String> {
            if !self.base_dir.exists() {
                return Ok(vec![]);
            }
            let mut result = vec![];
            for entry in std::fs::read_dir(&self.base_dir)
                .map_err(|e| format!("dataset_list(json): {e}"))?
            {
                let path = match entry {
                    Ok(e) => e.path(),
                    Err(_) => continue,
                };
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !name.ends_with(".dataset.json") {
                    continue;
                }
                let raw = match std::fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if let Ok(dataset) = serde_json::from_str::<DatasetRecord>(&raw) {
                    result.push(dataset);
                }
            }
            Ok(result)
        }

        pub async fn dataset_update(&self, dataset: &DatasetRecord) -> Result<(), String> {
            self.dataset_create(dataset).await
        }

        pub async fn dataset_delete(&self, id: &str) -> Result<(), String> {
            let path = self.dataset_path(id);
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("dataset_delete(json): {e}"))?;
            }
            let rec_dir = self.recordings_dir(id);
            if rec_dir.exists() {
                std::fs::remove_dir_all(&rec_dir)
                    .map_err(|e| format!("dataset_delete(json) recordings: {e}"))?;
            }
            Ok(())
        }

        pub async fn recording_insert(&self, rec: &RecordingRecord) -> Result<(), String> {
            let dir = self.recordings_dir(&rec.dataset_id);
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("recording_insert(json): dir: {e}"))?;
            let json = serde_json::to_string_pretty(rec)
                .map_err(|e| format!("recording_insert(json): {e}"))?;
            std::fs::write(dir.join(format!("{}.json", rec.id)), json)
                .map_err(|e| format!("recording_insert(json): write: {e}"))
        }

        pub async fn recording_bulk_insert(
            &self,
            records: &[RecordingRecord],
        ) -> Result<u64, String> {
            let mut count = 0u64;
            for rec in records {
                self.recording_insert(rec).await?;
                count += 1;
            }
            Ok(count)
        }

        pub async fn recording_get(
            &self,
            id: &str,
        ) -> Result<Option<RecordingRecord>, String> {
            // Scan all corpora for the recording
            for entry in std::fs::read_dir(&self.base_dir).map_err(|e| format!("{e}"))?.flatten() {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    let rec_path = dir_path.join(format!("{id}.json"));
                    if rec_path.exists() {
                        let raw = std::fs::read_to_string(&rec_path).map_err(|e| format!("{e}"))?;
                        return Ok(serde_json::from_str(&raw).ok());
                    }
                }
            }
            Ok(None)
        }

        pub async fn recording_list_by_dataset(
            &self,
            dataset_id: &str,
            limit: u64,
            offset: u64,
            tag_filter: Option<&str>,
        ) -> Result<Vec<RecordingRecord>, String> {
            let dir = self.recordings_dir(dataset_id);
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut recs: Vec<RecordingRecord> = std::fs::read_dir(&dir)
                .map_err(|e| format!("recording_list(json): {e}"))?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|s| serde_json::from_str::<RecordingRecord>(&s).ok())
                .filter(|r| {
                    tag_filter.map_or(true, |tag| r.tags.iter().any(|t| t == tag))
                })
                .collect();
            recs.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
            Ok(recs
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect())
        }

        // ── Saved Views ───────────────────────────────────────────────

        pub async fn dataset_save_view(
            &self,
            dataset_id: &str,
            view: SavedView,
        ) -> Result<DatasetRecord, String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("dataset_save_view: dataset '{dataset_id}' not found"))?;
            dataset.saved_views.retain(|v| v.name != view.name);
            dataset.saved_views.push(view);
            dataset.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            self.dataset_update(&dataset).await?;
            Ok(dataset)
        }

        pub async fn dataset_delete_view(
            &self,
            dataset_id: &str,
            view_name: &str,
        ) -> Result<DatasetRecord, String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("dataset_delete_view: dataset '{dataset_id}' not found"))?;
            dataset.saved_views.retain(|v| v.name != view_name);
            dataset.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            self.dataset_update(&dataset).await?;
            Ok(dataset)
        }

        // ── Analysis Runs ─────────────────────────────────────────────

        /// Inserts or replaces an analysis run record (keyed by run.key).
        pub async fn upsert_analysis_run(
            &self,
            dataset_id: &str,
            run: &AnalysisRunRecord,
        ) -> Result<(), String> {
            let mut dataset = self
                .dataset_get(dataset_id)
                .await?
                .ok_or_else(|| format!("upsert_analysis_run: dataset '{dataset_id}' not found"))?;
            let value = serde_json::to_value(run)
                .map_err(|e| format!("upsert_analysis_run: serialize: {e}"))?;
            dataset.analysis_runs.insert(run.key.clone(), value);
            self.dataset_update(&dataset).await
        }

        pub async fn recording_count_by_dataset(&self, dataset_id: &str) -> Result<u64, String> {
            let dir = self.recordings_dir(dataset_id);
            if !dir.exists() {
                return Ok(0);
            }
            let count = std::fs::read_dir(&dir)
                .map_err(|e| format!("{e}"))?
                .filter(|e| {
                    e.as_ref().ok().and_then(|e| {
                        e.path().extension().and_then(|s| s.to_str()).map(|s| s == "json")
                    }).unwrap_or(false)
                })
                .count();
            Ok(count as u64)
        }

        pub async fn recording_update_tags(
            &self,
            id: &str,
            tags: &[String],
        ) -> Result<(), String> {
            if let Some(mut rec) = self.recording_get(id).await? {
                rec.tags = tags.to_vec();
                self.recording_insert(&rec).await?;
            }
            Ok(())
        }

        pub async fn recording_hash_exists(&self, hash: &str) -> Result<bool, String> {
            for entry in std::fs::read_dir(&self.base_dir).map_err(|e| format!("{e}"))?.flatten() {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    for rec_entry in std::fs::read_dir(&dir_path).map_err(|e| format!("{e}"))?.flatten() {
                        if let Ok(raw) = std::fs::read_to_string(rec_entry.path()) {
                            if let Ok(rec) = serde_json::from_str::<RecordingRecord>(&raw) {
                                if rec.file_hash.as_deref() == Some(hash) {
                                    return Ok(true);
                                }
                            }
                        }
                    }
                }
            }
            Ok(false)
        }

        pub async fn recording_delete(&self, id: &str) -> Result<(), String> {
            for entry in std::fs::read_dir(&self.base_dir).map_err(|e| format!("{e}"))?.flatten() {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    let rec_path = dir_path.join(format!("{id}.json"));
                    if rec_path.exists() {
                        std::fs::remove_file(&rec_path)
                            .map_err(|e| format!("recording_delete(json): {e}"))?;
                        return Ok(());
                    }
                }
            }
            Ok(())
        }

        /// Returns all recordings of a dataset without pagination (for batch operations).
        pub async fn recording_list_by_dataset_all(
            &self,
            dataset_id: &str,
        ) -> Result<Vec<RecordingRecord>, String> {
            let dir = self.recordings_dir(dataset_id);
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut recs: Vec<RecordingRecord> = std::fs::read_dir(&dir)
                .map_err(|e| format!("recording_list_all(json): {e}"))?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|s| serde_json::from_str::<RecordingRecord>(&s).ok())
                .collect();
            recs.sort_by(|a, b| a.imported_at.cmp(&b.imported_at));
            Ok(recs)
        }

        /// Sets an arbitrary dynamic field on a recording.
        /// In the JSON fallback the recording is loaded as a `serde_json::Value`,
        /// the field is set, and the document is written back.
        pub async fn recording_set_dynamic_field(
            &self,
            id: &str,
            field_name: &str,
            value: serde_json::Value,
        ) -> Result<(), String> {
            // Scan all corpora for the recording file
            for entry in std::fs::read_dir(&self.base_dir).map_err(|e| format!("{e}"))?.flatten() {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    let rec_path = dir_path.join(format!("{id}.json"));
                    if rec_path.exists() {
                        let raw = std::fs::read_to_string(&rec_path)
                            .map_err(|e| format!("recording_set_dynamic_field(json) read: {e}"))?;
                        let mut doc: serde_json::Value = serde_json::from_str(&raw)
                            .map_err(|e| format!("recording_set_dynamic_field(json) parse: {e}"))?;
                        if let Some(obj) = doc.as_object_mut() {
                            obj.insert(field_name.to_owned(), value);
                        }
                        let out = serde_json::to_string_pretty(&doc)
                            .map_err(|e| format!("recording_set_dynamic_field(json) serialize: {e}"))?;
                        std::fs::write(&rec_path, out)
                            .map_err(|e| format!("recording_set_dynamic_field(json) write: {e}"))?;
                        return Ok(());
                    }
                }
            }
            Err(format!("recording_set_dynamic_field(json): recording '{id}' not found"))
        }

        /// Returns a single recording as full JSON with dynamic fields merged.
        pub async fn recording_get_json(
            &self,
            id: &str,
        ) -> Result<Option<serde_json::Value>, String> {
            for entry in std::fs::read_dir(&self.base_dir).map_err(|e| format!("{e}"))?.flatten() {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    let rec_path = dir_path.join(format!("{id}.json"));
                    if rec_path.exists() {
                        let raw = std::fs::read_to_string(&rec_path)
                            .map_err(|e| format!("recording_get_json(fallback): {e}"))?;
                        let doc: serde_json::Value = serde_json::from_str(&raw)
                            .map_err(|e| format!("recording_get_json(fallback) parse: {e}"))?;
                        return Ok(Some(recording_doc_merge_fields(doc)));
                    }
                }
            }
            Ok(None)
        }

        /// Returns a page of recordings as full JSON with dynamic fields merged.
        pub async fn recording_list_json(
            &self,
            dataset_id: &str,
            limit: u64,
            offset: u64,
            tag_filter: Option<&str>,
        ) -> Result<Vec<serde_json::Value>, String> {
            let recs = self
                .recording_list_by_dataset(dataset_id, limit, offset, tag_filter)
                .await?;
            recs.into_iter()
                .map(|r| {
                    serde_json::to_value(&r)
                        .map(recording_doc_merge_fields)
                        .map_err(|e| format!("recording_list_json serialize: {e}"))
                })
                .collect()
        }

        pub async fn dataset_set_visibility(
            &self,
            _dataset_id: &str,
            _visibility: DatasetVisibility,
        ) -> Result<(), String> {
            Err("dataset_set_visibility: not supported in JSON fallback mode".to_string())
        }

        /// Returns all recordings as full JSON with dynamic fields merged.
        pub async fn recording_list_all_json(
            &self,
            dataset_id: &str,
        ) -> Result<Vec<serde_json::Value>, String> {
            let dir = self.recordings_dir(dataset_id);
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut results: Vec<serde_json::Value> = std::fs::read_dir(&dir)
                .map_err(|e| format!("recording_list_all_json: {e}"))?
                .flatten()
                .filter(|e| {
                    e.path().extension().and_then(|s| s.to_str()) == Some("json")
                })
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(recording_doc_merge_fields)
                .collect();
            results.sort_by(|a, b| {
                let ta = a["importedAt"].as_i64().unwrap_or(0);
                let tb = b["importedAt"].as_i64().unwrap_or(0);
                ta.cmp(&tb)
            });
            Ok(results)
        }
    }
}

// Re-export of the active implementation
#[cfg(any(feature = "embedded-db", feature = "mem-db", feature = "server-db"))]
pub use surreal_impl::CorpusStore;

#[cfg(not(any(feature = "embedded-db", feature = "mem-db", feature = "server-db")))]
pub use json_fallback::CorpusStore;

// ── AnalysisRun ───────────────────────────────────────────────────────
// Stored as a sub-document inside DatasetRecord.analysis_runs (a JSON
// object keyed by run_key / job_id).

/// Mirrors domain/corpus/types.ts#AnalysisRunInfo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRunRecord {
    pub key: String,
    pub run_type: String,
    pub config: serde_json::Value,
    pub status: String, // "queued" | "running" | "completed" | "failed" | "cancelled"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

// Type alias for consistency — CorpusStore is the internal store name, DatasetRecord is the domain type.

// ═══════════════════════════════════════════════════════════════════════
// Tests — run with feature "mem-db" (in-memory, no filesystem required)
//
//   cargo test --features mem-db -p signavis
// ═══════════════════════════════════════════════════════════════════════
#[cfg(all(test, any(feature = "embedded-db", feature = "mem-db")))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Opens a fresh in-memory store for each test.
    async fn open_store() -> CorpusStore {
        CorpusStore::open(PathBuf::from("/tmp/signavis_test"))
            .await
            .expect("Opening store failed")
    }

    fn make_dataset(name: &str) -> DatasetRecord {
        DatasetRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            media_type: "audio".into(),
            created_at: 0,
            updated_at: 0,
            recording_count: 0,
            field_schema: vec![],
            known_tags: vec![],
            description: None,
        }
    }

    fn make_recording(dataset_id: &str, filepath: &str) -> RecordingRecord {
        RecordingRecord {
            id: uuid::Uuid::new_v4().to_string(),
            dataset_id: dataset_id.to_string(),
            filepath: filepath.to_string(),
            tags: vec![],
            metadata: AudioMetadata::default(),
            imported_at: 0,
            file_hash: Some("abc123".into()),
            recorded_at: None,
            fields: std::collections::HashMap::new(),
        }
    }

    // ── Dataset CRUD ──────────────────────────────────────────────────

    #[tokio::test]
    async fn test_dataset_create_and_get() {
        let store = open_store().await;
        let dataset = make_dataset("Test Dataset");
        store.dataset_create(&dataset).await.unwrap();

        let got = store.dataset_get(&dataset.id).await.unwrap();
        assert!(got.is_some(), "dataset_get should return Some");
        assert_eq!(got.unwrap().name, "Test Dataset");
    }

    #[tokio::test]
    async fn test_dataset_list() {
        let store = open_store().await;
        let c1 = make_dataset("Alpha");
        let c2 = make_dataset("Beta");
        store.dataset_create(&c1).await.unwrap();
        store.dataset_create(&c2).await.unwrap();

        let list = store.dataset_list().await.unwrap();
        assert_eq!(list.len(), 2);
    }

    #[tokio::test]
    async fn test_dataset_delete() {
        let store = open_store().await;
        let dataset = make_dataset("Delete");
        store.dataset_create(&dataset).await.unwrap();
        store.dataset_delete(&dataset.id).await.unwrap();

        let got = store.dataset_get(&dataset.id).await.unwrap();
        assert!(got.is_none(), "dataset should be None after delete");
    }

    // ── Recording CRUD ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_recording_insert_and_get() {
        let store = open_store().await;
        let dataset = make_dataset("Recordings");
        store.dataset_create(&dataset).await.unwrap();

        let rec = make_recording(&dataset.id, "/audio/test.wav");
        store.recording_insert(&rec).await.unwrap();

        let got = store.recording_get(&rec.id).await.unwrap();
        assert!(got.is_some());
        assert_eq!(got.unwrap().filepath, "/audio/test.wav");
    }

    #[tokio::test]
    async fn test_recording_list_by_dataset() {
        let store = open_store().await;
        let dataset = make_dataset("List");
        store.dataset_create(&dataset).await.unwrap();

        for i in 0..5 {
            let rec = make_recording(&dataset.id, &format!("/audio/{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let list = store.recording_list_by_dataset(&dataset.id, 10, 0).await.unwrap();
        assert_eq!(list.len(), 5);
    }

    #[tokio::test]
    async fn test_recording_count() {
        let store = open_store().await;
        let dataset = make_dataset("Count");
        store.dataset_create(&dataset).await.unwrap();

        for i in 0..3 {
            let rec = make_recording(&dataset.id, &format!("/audio/{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let count = store.recording_count_by_dataset(&dataset.id).await.unwrap();
        assert_eq!(count, 3);
    }

    /// Core test: write and read back tags — verifies type::thing() fix.
    #[tokio::test]
    async fn test_recording_update_tags_roundtrip() {
        let store = open_store().await;
        let dataset = make_dataset("Tags");
        store.dataset_create(&dataset).await.unwrap();

        let rec = make_recording(&dataset.id, "/audio/tag_test.wav");
        store.recording_insert(&rec).await.unwrap();

        let new_tags = vec!["reviewed".to_string(), "Turdus merula".to_string()];
        store.recording_update_tags(&rec.id, &new_tags).await.unwrap();

        let got = store.recording_get(&rec.id).await.unwrap().unwrap();
        assert_eq!(got.tags, new_tags, "Tags round-trip failed — check type::thing() fix");
    }

    #[tokio::test]
    async fn test_recording_hash_dedup() {
        let store = open_store().await;
        let dataset = make_dataset("Dedup");
        store.dataset_create(&dataset).await.unwrap();

        let rec = make_recording(&dataset.id, "/audio/dedup.wav");
        store.recording_insert(&rec).await.unwrap();

        let exists = store.recording_hash_exists("abc123").await.unwrap();
        assert!(exists, "Hash dedup should return true");

        let not_exists = store.recording_hash_exists("unknown_hash").await.unwrap();
        assert!(!not_exists);
    }

    #[tokio::test]
    async fn test_dataset_delete_cascades_recordings() {
        let store = open_store().await;
        let dataset = make_dataset("Cascade");
        store.dataset_create(&dataset).await.unwrap();

        let rec = make_recording(&dataset.id, "/audio/cascade.wav");
        store.recording_insert(&rec).await.unwrap();

        store.dataset_delete(&dataset.id).await.unwrap();

        // Recording should be gone after cascade delete
        let got = store.recording_get(&rec.id).await.unwrap();
        assert!(got.is_none(), "Recording should be deleted after dataset delete");
    }

    #[tokio::test]
    async fn test_recording_pagination() {
        let store = open_store().await;
        let dataset = make_dataset("Pagination");
        store.dataset_create(&dataset).await.unwrap();

        for i in 0..10u32 {
            let rec = make_recording(&dataset.id, &format!("/audio/page_{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let page1 = store.recording_list_by_dataset(&dataset.id, 5, 0).await.unwrap();
        let page2 = store.recording_list_by_dataset(&dataset.id, 5, 5).await.unwrap();

        assert_eq!(page1.len(), 5, "Page 1 should have 5 entries");
        assert_eq!(page2.len(), 5, "Page 2 should have 5 entries");

        // No duplicates between pages
        let ids1: std::collections::HashSet<_> = page1.iter().map(|r| &r.id).collect();
        let ids2: std::collections::HashSet<_> = page2.iter().map(|r| &r.id).collect();
        assert!(ids1.is_disjoint(&ids2), "Pages should not contain duplicates");
    }
}
