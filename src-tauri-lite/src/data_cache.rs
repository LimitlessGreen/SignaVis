// ═══════════════════════════════════════════════════════════════════════
// data_cache.rs — `svdata:` protocol: large app data loaded on demand
//
// Species images (~93 MB) and the BirdNET model (~79 MB) are not shipped
// with Lite. The frontend asks for them under svdata (see onDemandUrl in
// src/infrastructure/tauri/runtime.ts); this handler serves them from
// <app data>/data-cache and, on a miss, downloads them once from the
// SignaVis web app on GitHub Pages and keeps them there.
// ═══════════════════════════════════════════════════════════════════════

use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use serde::Serialize;
use tauri::{Emitter, Manager, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "svdata";
const UPSTREAM: &str = "https://limitlessgreen.github.io/SignaVis";
/// Only these subtrees can be fetched (nothing else of the web app).
const ALLOWED_PREFIXES: &[&str] = &["demo/data/species_images/", "models/"];

/// Percent-decoded, checked site path ("models/birdnet-v2.4/model.json"), or None.
fn site_path(uri_path: &str) -> Option<String> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'))?;
    let ok = Path::new(&decoded).components().all(|c| matches!(c, Component::Normal(_)))
        && !decoded.contains('\\')
        && ALLOWED_PREFIXES.iter().any(|p| decoded.starts_with(p));
    ok.then_some(decoded)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "json" => "application/json",
        "bin" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // fetch() from the app origin (tfjs model loading) needs CORS.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("valid response")
}

async fn load(cache_dir: PathBuf, path: String) -> Result<Vec<u8>, (StatusCode, String)> {
    let local = cache_dir.join(&path);
    if let Ok(bytes) = tokio::fs::read(&local).await {
        return Ok(bytes);
    }
    let url = format!("{UPSTREAM}/{}", path.split('/').map(urlencode).collect::<Vec<_>>().join("/"));
    let res = reqwest::get(&url).await.map_err(|e| (StatusCode::BAD_GATEWAY, format!("{url}: {e}")))?;
    if !res.status().is_success() {
        let code = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return Err((code, format!("{url}: HTTP {}", res.status())));
    }
    let bytes = res.bytes().await.map_err(|e| (StatusCode::BAD_GATEWAY, format!("{url}: {e}")))?.to_vec();
    if let Some(dir) = local.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let tmp = local.with_extension(format!("{}.part", std::process::id()));
    if tokio::fs::write(&tmp, &bytes).await.is_ok() && tokio::fs::rename(&tmp, &local).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    Ok(bytes)
}

fn urlencode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// BirdNET model directories (layers model + area model) under models/.
const MODEL_DIRS: &[&str] = &["models/birdnet-v2.4/", "models/birdnet-v2.4/mdata/"];
pub const PREFETCH_EVENT: &str = "lite-prefetch";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchProgress {
    done: usize,
    total: usize,
    bytes: u64,
}

/// File names listed in a TF.js model.json (`weightsManifest[].paths`).
fn manifest_paths(model_json: &[u8]) -> Result<Vec<String>, String> {
    let v: serde_json::Value = serde_json::from_slice(model_json).map_err(|e| format!("model.json: {e}"))?;
    let paths = v["weightsManifest"]
        .as_array()
        .ok_or("model.json has no weightsManifest")?
        .iter()
        .flat_map(|w| w["paths"].as_array().cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().map(str::to_string))
        .filter(|p| !p.contains(['/', '\\']) && !p.starts_with('.'))
        .collect();
    Ok(paths)
}

/// Download the BirdNET model into the cache (for offline use), reporting
/// progress as PREFETCH_EVENT. Files already cached are not fetched again.
#[tauri::command]
pub async fn prefetch_model(app: tauri::AppHandle) -> Result<PrefetchProgress, String> {
    let cache_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("data-cache");
    let mut files = Vec::new();
    for dir in MODEL_DIRS {
        let model = load(cache_dir.clone(), format!("{dir}model.json")).await.map_err(|(_, m)| m)?;
        files.push(format!("{dir}model.json"));
        files.extend(manifest_paths(&model)?.into_iter().map(|p| format!("{dir}{p}")));
    }
    files.push(format!("{}labels.json", MODEL_DIRS[0]));
    let total = files.len();
    let mut progress = PrefetchProgress { done: 0, total, bytes: 0 };
    for path in files {
        let bytes = load(cache_dir.clone(), path).await.map_err(|(_, m)| m)?;
        progress.done += 1;
        progress.bytes += bytes.len() as u64;
        let _ = app.emit(PREFETCH_EVENT, progress.clone());
    }
    Ok(progress)
}

pub fn handle<R: tauri::Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let Some(path) = site_path(request.uri().path()) else {
        responder.respond(respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec()));
        return;
    };
    let cache_dir = match ctx.app_handle().path().app_data_dir() {
        Ok(d) => d.join("data-cache"),
        Err(e) => {
            responder.respond(respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", e.to_string().into_bytes()));
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let mime = mime_for(&path);
        match load(cache_dir, path).await {
            Ok(bytes) => responder.respond(respond(StatusCode::OK, mime, bytes)),
            Err((code, msg)) => {
                eprintln!("[svdata] {msg}");
                responder.respond(respond(code, "text/plain", msg.into_bytes()));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowed_subtrees() {
        assert_eq!(site_path("/models/birdnet-v2.4/model.json").as_deref(), Some("models/birdnet-v2.4/model.json"));
        assert_eq!(
            site_path("/demo/data/species_images/Turdus%20merula.webp").as_deref(),
            Some("demo/data/species_images/Turdus merula.webp")
        );
        for bad in ["/demo/labeling-app.html", "/models/../demo/x", "/models/a%5Cb", "/", "/demo/data/species_images/%zz"] {
            assert!(site_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn manifest_lists_shards_only_by_plain_name() {
        let json = br#"{"weightsManifest":[{"paths":["group1-shard1of2.bin","group1-shard2of2.bin"]},{"paths":["../evil.bin","a/b.bin"]}]}"#;
        assert_eq!(manifest_paths(json).unwrap(), vec!["group1-shard1of2.bin", "group1-shard2of2.bin"]);
        assert!(manifest_paths(b"{}").is_err());
    }

    #[test]
    fn upstream_segments_are_encoded() {
        assert_eq!(urlencode("Turdus merula.webp"), "Turdus%20merula.webp");
        assert_eq!(urlencode("Grün"), "Gr%C3%BCn");
    }
}
