use std::path::PathBuf;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use crate::helpers::path::{project_store, assets_dir};
use crate::helpers::time::{now_millis, new_id};
use crate::helpers::job::ensure_array_field;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportLocalArgs {
    pub project_id: String,
    pub source_path: String,
}

/// Import a local file as project asset by copying it into app data storage.
#[tauri::command]
pub async fn asset_import_local(
    app: tauri::AppHandle,
    args: AssetImportLocalArgs,
) -> Result<JsonValue, String> {
    let source = PathBuf::from(args.source_path.trim());
    if !source.exists() {
        return Err(format!(
            "source file does not exist: {}",
            source.display()
        ));
    }
    if !source.is_file() {
        return Err(format!(
            "source path is not a file: {}",
            source.display()
        ));
    }

    let mut project = project_store(&app)?.read_project_json(&args.project_id)?;

    let assets_root = assets_dir(&app)?;
    std::fs::create_dir_all(&assets_root)
        .map_err(|e| format!("asset_import_local: {e}"))?;
    let project_assets_dir = assets_root.join(&args.project_id);
    std::fs::create_dir_all(&project_assets_dir)
        .map_err(|e| format!("asset_import_local: {e}"))?;

    let asset_id = new_id("asset")?;
    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("source file name is invalid utf-8")?;
    let dest_file_name = format!("{asset_id}_{file_name}");
    let dest_path = project_assets_dir.join(dest_file_name);
    std::fs::copy(&source, &dest_path)
        .map_err(|e| format!("asset_import_local: {e}"))?;

    let size_bytes = std::fs::metadata(&dest_path)
        .map_err(|e| format!("asset_import_local: {e}"))?
        .len();

    let imported_at = now_millis()? as i64;
    let asset = serde_json::json!({
        "id": asset_id,
        "kind": "audio",
        "sourcePath": source.to_string_lossy(),
        "storagePath": dest_path.to_string_lossy(),
        "sizeBytes": size_bytes,
        "importedAt": imported_at,
    });

    ensure_array_field(&mut project, "assets")?.push(asset.clone());
    project["updatedAt"] = serde_json::json!(imported_at);
    project_store(&app)?.write_project_json(&project)?;

    Ok(asset)
}
