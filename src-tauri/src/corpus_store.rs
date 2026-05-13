// ═══════════════════════════════════════════════════════════════════════
// corpus_store.rs — SurrealDB-basierter Corpus/Recording-Store
//
// Betriebsmodi:
//   - Mit Feature "embedded-db": SurrealKV (persistent, reines Rust)
//   - Mit Feature "mem-db":      Mem-Backend (in-memory, Tests/PoC)
//   - Fallback:                  JSON-Dateien (kein surrealdb-Feature aktiv)
//
// Der Store wird als Tauri-Managed-State registriert und ist
// Clone + Send + Sync.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Datentypen ────────────────────────────────────────────────────────

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusRecord {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub recording_count: u64,
    pub field_schema: Vec<FieldDefinition>,
    pub known_tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRecord {
    pub id: String,
    pub corpus_id: String,
    pub filepath: String,
    pub tags: Vec<String>,
    pub metadata: AudioMetadata,
    pub imported_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<i64>, // Unix-Millisekunden; später via BEXT/ID3 präzisiert
    #[serde(default)]
    pub fields: std::collections::HashMap<String, String>,
}

// ── Store ─────────────────────────────────────────────────────────────

#[cfg(any(feature = "embedded-db", feature = "mem-db"))]
mod surreal_impl {
    use super::*;
    use surrealdb::Surreal;

    #[cfg(feature = "embedded-db")]
    use surrealdb::engine::local::SurrealKv;

    #[cfg(feature = "mem-db")]
    use surrealdb::engine::local::Mem;

    /// Hilfsstruct für COUNT()-Abfragen (serde_json::Value nicht mit SurrealDB kompatibel)
    #[derive(serde::Deserialize)]
    struct CountRow {
        c: i64,
    }

pub struct CorpusStore {
        db: Surreal<surrealdb::engine::local::Db>,
    }

    impl CorpusStore {
        #[cfg(feature = "embedded-db")]
        pub async fn open(data_dir: PathBuf) -> Result<Self, String> {
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("corpus_store: cannot create data dir: {e}"))?;
            let db_path = data_dir.join("corpus.db");
            let db = Surreal::new::<SurrealKv>(db_path.to_string_lossy().as_ref())
                .await
                .map_err(|e| format!("corpus_store: surrealdb open: {e}"))?;
            db.use_ns("signavis")
                .use_db("local")
                .await
                .map_err(|e| format!("corpus_store: use_ns/db: {e}"))?;
            let store = Self { db };
            store.init_schema().await?;
            Ok(store)
        }

        #[cfg(all(feature = "mem-db", not(feature = "embedded-db")))]
        pub async fn open(_data_dir: PathBuf) -> Result<Self, String> {
            let db = Surreal::new::<Mem>(())
                .await
                .map_err(|e| format!("corpus_store: surrealdb mem open: {e}"))?;
            db.use_ns("signavis")
                .use_db("local")
                .await
                .map_err(|e| format!("corpus_store: use_ns/db: {e}"))?;
            let store = Self { db };
            store.init_schema().await?;
            Ok(store)
        }

        async fn init_schema(&self) -> Result<(), String> {
            // Corpus-Tabelle (schemaless — vermeidet Konflikte mit id:Thing vs. string)
            self.db
                .query(
                    "DEFINE TABLE IF NOT EXISTS corpus SCHEMALESS;
                     DEFINE INDEX IF NOT EXISTS idx_corpus_name ON corpus FIELDS name;",
                )
                .await
                .map_err(|e| format!("corpus_store: init corpus schema: {e}"))?;

            // Recording-Tabelle (schemaless für dynamische Felder)
            self.db
                .query(
                    "DEFINE TABLE IF NOT EXISTS recording SCHEMALESS;
                     DEFINE INDEX IF NOT EXISTS idx_recording_corpus ON recording FIELDS corpus_id;
                     DEFINE INDEX IF NOT EXISTS idx_recording_filepath ON recording FIELDS filepath;
                     DEFINE INDEX IF NOT EXISTS idx_recording_hash ON recording FIELDS file_hash;",
                )
                .await
                .map_err(|e| format!("corpus_store: init recording schema: {e}"))?;

            Ok(())
        }

        // ── Corpus CRUD ───────────────────────────────────────────────

        pub async fn corpus_create(&self, corpus: &CorpusRecord) -> Result<(), String> {
            self.db
                .query("CREATE type::thing('corpus', $id) CONTENT $record")
                .bind(("id", corpus.id.clone()))
                .bind(("record", corpus.clone()))
                .await
                .map_err(|e| format!("corpus_create: {e}"))?;
            Ok(())
        }

        pub async fn corpus_get(&self, id: &str) -> Result<Option<CorpusRecord>, String> {
            let rid = id.to_owned();
            let mut resp = self
                .db
                .query("SELECT *, record::id(id) AS id FROM type::thing('corpus', $id)")
                .bind(("id", rid))
                .await
                .map_err(|e| format!("corpus_get: {e}"))?;
            let rows: Vec<CorpusRecord> =
                resp.take(0).map_err(|e| format!("corpus_get take: {e}"))?;
            Ok(rows.into_iter().next())
        }

        pub async fn corpus_list(&self) -> Result<Vec<CorpusRecord>, String> {
            let mut resp = self
                .db
                .query("SELECT *, record::id(id) AS id FROM corpus")
                .await
                .map_err(|e| format!("corpus_list: {e}"))?;
            let result: Vec<CorpusRecord> =
                resp.take(0).map_err(|e| format!("corpus_list take: {e}"))?;
            Ok(result)
        }

        pub async fn corpus_update(&self, corpus: &CorpusRecord) -> Result<(), String> {
            self.db
                .query("UPDATE type::thing('corpus', $id) CONTENT $record")
                .bind(("id", corpus.id.clone()))
                .bind(("record", corpus.clone()))
                .await
                .map_err(|e| format!("corpus_update: {e}"))?;
            Ok(())
        }

        pub async fn corpus_delete(&self, id: &str) -> Result<(), String> {
            // Alle Recordings des Corpus löschen
            let cid = id.to_owned();
            self.db
                .query("DELETE recording WHERE corpusId = $cid")
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("corpus_delete recordings: {e}"))?;
            self.db
                .query("DELETE type::thing('corpus', $id)")
                .bind(("id", id.to_owned()))
                .await
                .map_err(|e| format!("corpus_delete: {e}"))?;
            Ok(())
        }

        // ── Recording CRUD ────────────────────────────────────────────

        pub async fn recording_insert(&self, rec: &RecordingRecord) -> Result<(), String> {
            self.db
                .query("CREATE type::thing('recording', $id) CONTENT $record")
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
            let rid = id.to_owned();
            let mut resp = self
                .db
                .query("SELECT *, record::id(id) AS id FROM type::thing('recording', $id)")
                .bind(("id", rid))
                .await
                .map_err(|e| format!("recording_get: {e}"))?;
            let rows: Vec<RecordingRecord> =
                resp.take(0).map_err(|e| format!("recording_get take: {e}"))?;
            Ok(rows.into_iter().next())
        }

        pub async fn recording_list_by_corpus(
            &self,
            corpus_id: &str,
            limit: u64,
            offset: u64,
        ) -> Result<Vec<RecordingRecord>, String> {
            let cid = corpus_id.to_owned();
            let mut response = self
                .db
                .query(
                    "SELECT *, record::id(id) AS id FROM recording
                     WHERE corpusId = $cid
                     ORDER BY importedAt DESC, id ASC
                     LIMIT $lim START $off",
                )
                .bind(("cid", cid))
                .bind(("lim", limit))
                .bind(("off", offset))
                .await
                .map_err(|e| format!("recording_list_by_corpus: {e}"))?;
            let result: Vec<RecordingRecord> =
                response.take(0).map_err(|e| format!("recording_list_by_corpus take: {e}"))?;
            Ok(result)
        }

        pub async fn recording_count_by_corpus(&self, corpus_id: &str) -> Result<u64, String> {
            let cid = corpus_id.to_owned();
            let mut response = self
                .db
                .query("SELECT count() AS c FROM recording WHERE corpusId = $cid GROUP ALL")
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
            // SurrealDB: id ist ein Thing-Typ (recording:uuid), kein einfacher String.
            // type::thing('recording', $rid) wandelt den String in eine Record-ID um.
            let rid = id.to_owned();
            let owned_tags: Vec<String> = tags.to_vec();
            self.db
                .query("UPDATE type::thing('recording', $rid) SET tags = $tags")
                .bind(("rid", rid))
                .bind(("tags", owned_tags))
                .await
                .map_err(|e| format!("recording_update_tags: {e}"))?;
            Ok(())
        }

        pub async fn recording_hash_exists(&self, hash: &str) -> Result<bool, String> {
            let owned_hash = hash.to_owned();
            let mut response = self
                .db
                .query("SELECT count() AS c FROM recording WHERE fileHash = $hash GROUP ALL")
                .bind(("hash", owned_hash))
                .await
                .map_err(|e| format!("recording_hash_exists: {e}"))?;
            let rows: Vec<CountRow> =
                response.take(0).map_err(|e| format!("recording_hash_exists take: {e}"))?;
            Ok(rows.first().map(|r| r.c > 0).unwrap_or(false))
        }

        pub async fn recording_delete(&self, id: &str) -> Result<(), String> {
            self.db
                .query("DELETE type::thing('recording', $id)")
                .bind(("id", id.to_owned()))
                .await
                .map_err(|e| format!("recording_delete: {e}"))?;
            Ok(())
        }

        /// Gibt alle distinkten Werte eines Pfad-Felds in einem Corpus zurück.
        /// Pfad-Felder sind als camelCase-Key in der `fields`-Map gespeichert.
        pub async fn recording_distinct_field_values(
            &self,
            corpus_id: &str,
            field_name: &str,
        ) -> Result<Vec<String>, String> {
            let cid = corpus_id.to_owned();
            let field = field_name.to_owned();
            // SurrealQL: Felder in der fields-Map werden als fields.{name} adressiert
            let mut resp = self
                .db
                .query(format!(
                    "SELECT DISTINCT fields.{field} AS val FROM recording WHERE corpusId = $cid AND fields.{field} != NONE"
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

        /// Gibt alle Recordings eines Corpus ohne Pagination zurück (für Batch-Operationen).
        pub async fn recording_list_by_corpus_all(
            &self,
            corpus_id: &str,
        ) -> Result<Vec<RecordingRecord>, String> {
            let cid = corpus_id.to_owned();
            let mut response = self
                .db
                .query(
                    "SELECT *, record::id(id) AS id FROM recording
                     WHERE corpusId = $cid
                     ORDER BY importedAt ASC, id ASC",
                )
                .bind(("cid", cid))
                .await
                .map_err(|e| format!("recording_list_by_corpus_all: {e}"))?;
            let result: Vec<RecordingRecord> =
                response.take(0).map_err(|e| format!("recording_list_by_corpus_all take: {e}"))?;
            Ok(result)
        }

        /// Setzt ein beliebiges dynamisches Feld auf einem Recording (SurrealDB SCHEMALESS).
        ///
        /// `field_name` muss bereits durch `sanitize_field_name` validiert sein
        /// (nur `[a-zA-Z][a-zA-Z0-9_]*`) — wird direkt in die Query interpoliert.
        pub async fn recording_set_dynamic_field(
            &self,
            id: &str,
            field_name: &str,
            value: serde_json::Value,
        ) -> Result<(), String> {
            let query = format!(
                "UPDATE type::thing('recording', $id) SET {} = $value",
                field_name
            );
            self.db
                .query(query)
                .bind(("id", id.to_owned()))
                .bind(("value", value))
                .await
                .map_err(|e| format!("recording_set_dynamic_field: {e}"))?;
            Ok(())
        }
    }
}

/// Fallback: Wenn weder embedded-db noch mem-db aktiv sind.
#[cfg(not(any(feature = "embedded-db", feature = "mem-db")))]
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

        fn corpus_path(&self, id: &str) -> PathBuf {
            self.base_dir.join(format!("{id}.corpus.json"))
        }

        fn recordings_dir(&self, corpus_id: &str) -> PathBuf {
            self.base_dir.join(format!("{corpus_id}_recordings"))
        }

        pub async fn corpus_create(&self, corpus: &CorpusRecord) -> Result<(), String> {
            let json = serde_json::to_string_pretty(corpus)
                .map_err(|e| format!("corpus_create(json): {e}"))?;
            std::fs::write(self.corpus_path(&corpus.id), json)
                .map_err(|e| format!("corpus_create(json): {e}"))
        }

        pub async fn corpus_get(&self, id: &str) -> Result<Option<CorpusRecord>, String> {
            let path = self.corpus_path(id);
            if !path.exists() {
                return Ok(None);
            }
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("corpus_get(json): {e}"))?;
            let corpus: CorpusRecord = serde_json::from_str(&raw)
                .map_err(|e| format!("corpus_get(json): malformed: {e}"))?;
            Ok(Some(corpus))
        }

        pub async fn corpus_list(&self) -> Result<Vec<CorpusRecord>, String> {
            if !self.base_dir.exists() {
                return Ok(vec![]);
            }
            let mut result = vec![];
            for entry in std::fs::read_dir(&self.base_dir)
                .map_err(|e| format!("corpus_list(json): {e}"))?
            {
                let path = match entry {
                    Ok(e) => e.path(),
                    Err(_) => continue,
                };
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !name.ends_with(".corpus.json") {
                    continue;
                }
                let raw = match std::fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if let Ok(corpus) = serde_json::from_str::<CorpusRecord>(&raw) {
                    result.push(corpus);
                }
            }
            Ok(result)
        }

        pub async fn corpus_update(&self, corpus: &CorpusRecord) -> Result<(), String> {
            self.corpus_create(corpus).await
        }

        pub async fn corpus_delete(&self, id: &str) -> Result<(), String> {
            let path = self.corpus_path(id);
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("corpus_delete(json): {e}"))?;
            }
            let rec_dir = self.recordings_dir(id);
            if rec_dir.exists() {
                std::fs::remove_dir_all(&rec_dir)
                    .map_err(|e| format!("corpus_delete(json) recordings: {e}"))?;
            }
            Ok(())
        }

        pub async fn recording_insert(&self, rec: &RecordingRecord) -> Result<(), String> {
            let dir = self.recordings_dir(&rec.corpus_id);
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

        pub async fn recording_list_by_corpus(
            &self,
            corpus_id: &str,
            limit: u64,
            offset: u64,
        ) -> Result<Vec<RecordingRecord>, String> {
            let dir = self.recordings_dir(corpus_id);
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut recs: Vec<RecordingRecord> = std::fs::read_dir(&dir)
                .map_err(|e| format!("recording_list(json): {e}"))?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|s| serde_json::from_str::<RecordingRecord>(&s).ok())
                .collect();
            recs.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
            Ok(recs
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect())
        }

        pub async fn recording_count_by_corpus(&self, corpus_id: &str) -> Result<u64, String> {
            let dir = self.recordings_dir(corpus_id);
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

        /// Gibt alle Recordings eines Corpus ohne Pagination zurück (für Batch-Operationen).
        pub async fn recording_list_by_corpus_all(
            &self,
            corpus_id: &str,
        ) -> Result<Vec<RecordingRecord>, String> {
            let dir = self.recordings_dir(corpus_id);
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

        /// Setzt ein beliebiges dynamisches Feld auf einem Recording.
        /// Im JSON-Fallback wird das Recording als `serde_json::Value` geladen,
        /// das Feld gesetzt und zurückgeschrieben.
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
    }
}

// Re-export der aktiven Implementierung
#[cfg(any(feature = "embedded-db", feature = "mem-db"))]
pub use surreal_impl::CorpusStore;

#[cfg(not(any(feature = "embedded-db", feature = "mem-db")))]
pub use json_fallback::CorpusStore;

// ═══════════════════════════════════════════════════════════════════════
// Tests — laufen mit Feature "mem-db" (in-memory, kein Dateisystem nötig)
//
//   cargo test --features mem-db -p signavis
// ═══════════════════════════════════════════════════════════════════════
#[cfg(all(test, any(feature = "embedded-db", feature = "mem-db")))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Öffnet einen frischen In-Memory-Store für jeden Test.
    async fn open_store() -> CorpusStore {
        CorpusStore::open(PathBuf::from("/tmp/signavis_test"))
            .await
            .expect("Store öffnen fehlgeschlagen")
    }

    fn make_corpus(name: &str) -> CorpusRecord {
        CorpusRecord {
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

    fn make_recording(corpus_id: &str, filepath: &str) -> RecordingRecord {
        RecordingRecord {
            id: uuid::Uuid::new_v4().to_string(),
            corpus_id: corpus_id.to_string(),
            filepath: filepath.to_string(),
            tags: vec![],
            metadata: AudioMetadata::default(),
            imported_at: 0,
            file_hash: Some("abc123".into()),
            recorded_at: None,
            fields: std::collections::HashMap::new(),
        }
    }

    // ── Corpus CRUD ───────────────────────────────────────────────────

    #[tokio::test]
    async fn test_corpus_create_and_get() {
        let store = open_store().await;
        let corpus = make_corpus("Test Corpus");
        store.corpus_create(&corpus).await.unwrap();

        let got = store.corpus_get(&corpus.id).await.unwrap();
        assert!(got.is_some(), "corpus_get sollte Some zurückgeben");
        assert_eq!(got.unwrap().name, "Test Corpus");
    }

    #[tokio::test]
    async fn test_corpus_list() {
        let store = open_store().await;
        let c1 = make_corpus("Alpha");
        let c2 = make_corpus("Beta");
        store.corpus_create(&c1).await.unwrap();
        store.corpus_create(&c2).await.unwrap();

        let list = store.corpus_list().await.unwrap();
        assert_eq!(list.len(), 2);
    }

    #[tokio::test]
    async fn test_corpus_delete() {
        let store = open_store().await;
        let corpus = make_corpus("Löschen");
        store.corpus_create(&corpus).await.unwrap();
        store.corpus_delete(&corpus.id).await.unwrap();

        let got = store.corpus_get(&corpus.id).await.unwrap();
        assert!(got.is_none(), "corpus sollte nach Delete None sein");
    }

    // ── Recording CRUD ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_recording_insert_and_get() {
        let store = open_store().await;
        let corpus = make_corpus("Recordings");
        store.corpus_create(&corpus).await.unwrap();

        let rec = make_recording(&corpus.id, "/audio/test.wav");
        store.recording_insert(&rec).await.unwrap();

        let got = store.recording_get(&rec.id).await.unwrap();
        assert!(got.is_some());
        assert_eq!(got.unwrap().filepath, "/audio/test.wav");
    }

    #[tokio::test]
    async fn test_recording_list_by_corpus() {
        let store = open_store().await;
        let corpus = make_corpus("Liste");
        store.corpus_create(&corpus).await.unwrap();

        for i in 0..5 {
            let rec = make_recording(&corpus.id, &format!("/audio/{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let list = store.recording_list_by_corpus(&corpus.id, 10, 0).await.unwrap();
        assert_eq!(list.len(), 5);
    }

    #[tokio::test]
    async fn test_recording_count() {
        let store = open_store().await;
        let corpus = make_corpus("Zählen");
        store.corpus_create(&corpus).await.unwrap();

        for i in 0..3 {
            let rec = make_recording(&corpus.id, &format!("/audio/{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let count = store.recording_count_by_corpus(&corpus.id).await.unwrap();
        assert_eq!(count, 3);
    }

    /// Kerntest: Tags schreiben und zurücklesen — prüft type::thing() Fix.
    #[tokio::test]
    async fn test_recording_update_tags_roundtrip() {
        let store = open_store().await;
        let corpus = make_corpus("Tags");
        store.corpus_create(&corpus).await.unwrap();

        let rec = make_recording(&corpus.id, "/audio/tag_test.wav");
        store.recording_insert(&rec).await.unwrap();

        let new_tags = vec!["reviewed".to_string(), "Turdus merula".to_string()];
        store.recording_update_tags(&rec.id, &new_tags).await.unwrap();

        let got = store.recording_get(&rec.id).await.unwrap().unwrap();
        assert_eq!(got.tags, new_tags, "Tags-Roundtrip fehlgeschlagen — type::thing() Fix prüfen");
    }

    #[tokio::test]
    async fn test_recording_hash_dedup() {
        let store = open_store().await;
        let corpus = make_corpus("Dedup");
        store.corpus_create(&corpus).await.unwrap();

        let rec = make_recording(&corpus.id, "/audio/dedup.wav");
        store.recording_insert(&rec).await.unwrap();

        let exists = store.recording_hash_exists("abc123").await.unwrap();
        assert!(exists, "Hash-Dedup sollte true zurückgeben");

        let not_exists = store.recording_hash_exists("unknown_hash").await.unwrap();
        assert!(!not_exists);
    }

    #[tokio::test]
    async fn test_corpus_delete_cascades_recordings() {
        let store = open_store().await;
        let corpus = make_corpus("Kaskade");
        store.corpus_create(&corpus).await.unwrap();

        let rec = make_recording(&corpus.id, "/audio/cascade.wav");
        store.recording_insert(&rec).await.unwrap();

        store.corpus_delete(&corpus.id).await.unwrap();

        // Recording sollte nach Cascade-Delete weg sein
        let got = store.recording_get(&rec.id).await.unwrap();
        assert!(got.is_none(), "Recording sollte nach Corpus-Delete gelöscht sein");
    }

    #[tokio::test]
    async fn test_recording_pagination() {
        let store = open_store().await;
        let corpus = make_corpus("Paginierung");
        store.corpus_create(&corpus).await.unwrap();

        for i in 0..10u32 {
            let rec = make_recording(&corpus.id, &format!("/audio/page_{i}.wav"));
            store.recording_insert(&rec).await.unwrap();
        }

        let page1 = store.recording_list_by_corpus(&corpus.id, 5, 0).await.unwrap();
        let page2 = store.recording_list_by_corpus(&corpus.id, 5, 5).await.unwrap();

        assert_eq!(page1.len(), 5, "Seite 1 sollte 5 Einträge haben");
        assert_eq!(page2.len(), 5, "Seite 2 sollte 5 Einträge haben");

        // Keine Duplikate zwischen Seiten
        let ids1: std::collections::HashSet<_> = page1.iter().map(|r| &r.id).collect();
        let ids2: std::collections::HashSet<_> = page2.iter().map(|r| &r.id).collect();
        assert!(ids1.is_disjoint(&ids2), "Seiten sollten keine Duplikate enthalten");
    }
}
