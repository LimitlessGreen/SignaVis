use serde_json::Value as JsonValue;
use super::path::jobs_dir;
use super::time::now_millis;

pub fn ensure_array_field<'a>(
    value: &'a mut JsonValue,
    field: &str,
) -> Result<&'a mut Vec<JsonValue>, String> {
    let obj = value
        .as_object_mut()
        .ok_or("project value must be an object")?;
    if !obj.contains_key(field) {
        obj.insert(field.to_string(), serde_json::json!([]));
    }
    obj.get_mut(field)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("project field '{field}' must be an array"))
}

pub fn write_job_json(
    app: &tauri::AppHandle,
    job: &JsonValue,
    origin: &str,
) -> Result<(), String> {
    let jobs_root = jobs_dir(app)?;
    std::fs::create_dir_all(&jobs_root).map_err(|e| format!("{origin}: {e}"))?;
    let job_id = job["id"].as_str().ok_or("job must contain id")?;
    let job_path = jobs_root.join(format!("{job_id}.json"));
    let content = serde_json::to_string_pretty(job).map_err(|e| format!("{origin}: {e}"))?;
    std::fs::write(job_path, content).map_err(|e| format!("{origin}: {e}"))
}

pub fn read_job_json(app: &tauri::AppHandle, id: &str) -> Result<JsonValue, String> {
    let jobs_root = jobs_dir(app)?;
    let job_path = jobs_root.join(format!("{id}.json"));
    let content =
        std::fs::read_to_string(job_path).map_err(|e| format!("read_local_job: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("read_local_job: malformed JSON: {e}"))
}

pub fn structured_job_error(code: &str, message: &str, details: JsonValue) -> JsonValue {
    serde_json::json!({
        "code": code,
        "message": message,
        "details": details,
    })
}

pub fn set_job_failed(
    job: &mut JsonValue,
    code: &str,
    message: &str,
    details: JsonValue,
) -> Result<(), String> {
    let now = now_millis()? as i64;
    job["status"] = serde_json::json!("failed");
    job["progress"] = serde_json::json!(1.0);
    job["updatedAt"] = serde_json::json!(now);
    if job["finishedAt"].is_null() {
        job["finishedAt"] = serde_json::json!(now);
    }
    job["error"] = structured_job_error(code, message, details);
    Ok(())
}
