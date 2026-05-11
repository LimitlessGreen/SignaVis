use serde::Deserialize;
use serde_json::Value as JsonValue;
use crate::helpers::path::{project_store, jobs_dir};
use crate::helpers::time::now_millis;
use crate::helpers::job::{write_job_json, read_job_json, set_job_failed};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRunLocalArgs {
    pub project_id: String,
    pub asset_id: Option<String>,
    pub backend: Option<String>,
}

/// Scaffold command for local analysis. It creates a persisted job record
/// so the frontend can build a complete vertical slice before real execution exists.
#[tauri::command]
pub async fn analysis_run_local(
    app: tauri::AppHandle,
    args: AnalysisRunLocalArgs,
) -> Result<JsonValue, String> {
    // Validate project existence early for deterministic UI errors.
    let project = project_store(&app)?.read_project_json(&args.project_id)?;

    let job_id = crate::helpers::time::new_id("job")?;
    let created_at = now_millis()? as i64;
    let backend = args
        .backend
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string());
    let mut job = serde_json::json!({
        "id": job_id,
        "projectId": args.project_id,
        "assetId": args.asset_id,
        "backend": backend,
        "status": "queued",
        "progress": 0.0,
        "createdAt": created_at,
        "startedAt": null,
        "finishedAt": null,
        "error": null,
        "result": {
            "message": "analysis_run_local scaffold command executed",
            "detections": []
        }
    });

    write_job_json(&app, &job, "analysis_run_local")?;

    job["status"] = serde_json::json!("running");
    job["startedAt"] = serde_json::json!(created_at);
    job["progress"] = serde_json::json!(0.5);
    write_job_json(&app, &job, "analysis_run_local")?;

    // Fail with structured error payloads for deterministic UI handling.
    if backend != "local" && backend != "server" && backend != "cloud" {
        set_job_failed(
            &mut job,
            "invalid_backend",
            "Unsupported analysis backend",
            serde_json::json!({ "backend": backend }),
        )?;
        write_job_json(&app, &job, "analysis_run_local")?;
        return Ok(job);
    }

    if let Some(asset_id) = args.asset_id.as_ref() {
        let found = project
            .get("assets")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter().any(|a| {
                    a.get("id").and_then(|v| v.as_str()) == Some(asset_id.as_str())
                })
            })
            .unwrap_or(false);

        if !found {
            set_job_failed(
                &mut job,
                "asset_not_found",
                "Referenced assetId does not exist in project",
                serde_json::json!({
                    "projectId": args.project_id,
                    "assetId": asset_id,
                }),
            )?;
            write_job_json(&app, &job, "analysis_run_local")?;
            return Ok(job);
        }
    }

    job["status"] = serde_json::json!("done");
    job["finishedAt"] = serde_json::json!(now_millis()? as i64);
    job["progress"] = serde_json::json!(1.0);
    job["updatedAt"] = serde_json::json!(now_millis()? as i64);
    write_job_json(&app, &job, "analysis_run_local")?;

    Ok(job)
}

/// Return one persisted local job by id.
#[tauri::command]
pub async fn read_local_job(app: tauri::AppHandle, id: String) -> Result<JsonValue, String> {
    read_job_json(&app, &id)
}

/// Return local jobs sorted by createdAt descending. Optional project filter.
#[tauri::command]
pub async fn list_local_jobs(
    app: tauri::AppHandle,
    project_id: Option<String>,
) -> Result<Vec<JsonValue>, String> {
    let jobs_root = jobs_dir(&app)?;
    if !jobs_root.exists() {
        return Ok(vec![]);
    }

    let entries =
        std::fs::read_dir(&jobs_root).map_err(|e| format!("list_local_jobs: {e}"))?;
    let mut jobs: Vec<JsonValue> = Vec::new();

    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let job: JsonValue = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(ref pid) = project_id {
            if job["projectId"].as_str() != Some(pid.as_str()) {
                continue;
            }
        }

        jobs.push(job);
    }

    jobs.sort_by(|a, b| {
        let au = a["createdAt"].as_i64().unwrap_or(0);
        let bu = b["createdAt"].as_i64().unwrap_or(0);
        bu.cmp(&au)
    });

    Ok(jobs)
}

/// Mark a local job as cancelled.
#[tauri::command]
pub async fn cancel_local_job(
    app: tauri::AppHandle,
    id: String,
) -> Result<JsonValue, String> {
    let mut job = read_job_json(&app, &id)?;
    job["status"] = serde_json::json!("cancelled");
    job["updatedAt"] = serde_json::json!(now_millis()? as i64);
    if job["finishedAt"].is_null() {
        job["finishedAt"] = serde_json::json!(now_millis()? as i64);
    }
    write_job_json(&app, &job, "cancel_local_job")?;
    Ok(job)
}
