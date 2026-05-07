use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};

#[derive(Clone)]
pub struct ProjectStore {
    base_dir: PathBuf,
}

impl ProjectStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn ensure_dir(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.base_dir).map_err(|e| format!("project_store: {e}"))
    }

    fn sanitize_id(id: &str) -> Result<String, String> {
        let safe_id: String = id
            .chars()
            .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
            .collect();
        if safe_id != id {
            return Err(format!("invalid project id: {id:?}"));
        }
        Ok(safe_id)
    }

    fn project_path(&self, id: &str) -> Result<PathBuf, String> {
        let safe_id = Self::sanitize_id(id)?;
        self.ensure_dir()?;
        Ok(self.base_dir.join(format!("{safe_id}.awproject.json")))
    }

    pub fn write_project_json(&self, project: &JsonValue) -> Result<(), String> {
        let id = project["id"]
            .as_str()
            .ok_or("write_project: missing 'id' field")?;
        let path = self.project_path(id)?;
        let content = serde_json::to_string_pretty(project).map_err(|e| format!("write_project: {e}"))?;
        std::fs::write(&path, content).map_err(|e| format!("write_project: {e}"))
    }

    pub fn read_project_json(&self, id: &str) -> Result<JsonValue, String> {
        let path = self.project_path(id)?;
        let content = std::fs::read_to_string(&path).map_err(|e| format!("read_project: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("read_project: malformed JSON: {e}"))
    }

    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let path = self.project_path(id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("delete_project: {e}"))?;
        }
        Ok(())
    }

    pub fn list_project_ids(&self) -> Result<Vec<String>, String> {
        if !self.base_dir.exists() {
            return Ok(vec![]);
        }
        let entries = std::fs::read_dir(&self.base_dir).map_err(|e| format!("list_project_ids: {e}"))?;
        let ids = entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                let name = path.file_name()?.to_str()?;
                name.strip_suffix(".awproject.json").map(|s| s.to_string())
            })
            .collect();
        Ok(ids)
    }

    pub fn list_project_summaries(&self) -> Result<Vec<JsonValue>, String> {
        if !self.base_dir.exists() {
            return Ok(vec![]);
        }

        let entries = std::fs::read_dir(&self.base_dir).map_err(|e| format!("list_projects: {e}"))?;
        let mut summaries: Vec<JsonValue> = vec![];

        for entry in entries {
            let path = match entry {
                Ok(e) => e.path(),
                Err(_) => continue,
            };
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".awproject.json") else {
                continue;
            };

            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let project: JsonValue = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let label_count = project["labels"].as_array().map(|a| a.len()).unwrap_or(0) as u64;
            let annotation_count = project["annotations"].as_array().map(|a| a.len()).unwrap_or(0) as u64;
            summaries.push(json!({
                "id": id,
                "name": project["name"].as_str().unwrap_or("Unnamed Project"),
                "createdAt": project["createdAt"].as_i64().unwrap_or(0),
                "updatedAt": project["updatedAt"].as_i64().unwrap_or(0),
                "audioSource": project["audioSource"].clone(),
                "labelCount": label_count,
                "annotationCount": annotation_count,
            }));
        }

        summaries.sort_by(|a, b| {
            let au = a["updatedAt"].as_i64().unwrap_or(0);
            let bu = b["updatedAt"].as_i64().unwrap_or(0);
            bu.cmp(&au)
        });

        Ok(summaries)
    }
}
