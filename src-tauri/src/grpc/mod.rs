// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/grpc/mod.rs
//
// gRPC service skeletons for future server/gateway mode.
// Compiled only with `--features grpc`.
// ═══════════════════════════════════════════════════════════════════════

pub mod analysis {
    tonic::include_proto!("signavis.analysis.v1");
}

pub mod projects {
    tonic::include_proto!("signavis.projects.v1");
}

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;

use reqwest::Method;
use tonic::{Request, Response, Status};
use tonic::transport::Server;
use tracing::{debug, info, warn};

use crate::project_store::ProjectStore;

#[derive(Clone, Default)]
pub struct AnalysisServiceState {
    state: Arc<Mutex<AnalysisRuntimeState>>,
    http: reqwest::Client,
}

#[derive(Default)]
struct AnalysisRuntimeState {
    loaded: bool,
    location: Option<AnalysisLocation>,
    backend_endpoint: Option<String>,
}

#[derive(Clone)]
struct AnalysisLocation {
    latitude: f64,
    longitude: f64,
    date_iso8601: String,
}

#[tonic::async_trait]
impl analysis::analysis_service_server::AnalysisService for AnalysisServiceState {
    async fn load_model(
        &self,
        request: Request<analysis::LoadModelRequest>,
    ) -> Result<Response<analysis::LoadModelResponse>, Status> {
        let req = request.into_inner();
        debug!(model_url = %req.model_url, "AnalysisService::load_model");
        let endpoint = self.backend_endpoint();

        if let Some(endpoint) = endpoint {
            debug!(endpoint = %endpoint, "forwarding load_model to HTTP backend");
            let body = serde_json::json!({ "modelUrl": req.model_url });
            let payload = self
                .http_json(Method::POST, &endpoint, "/analysis/load", Some(body))
                .await?;

            let label_count = payload["labelCount"].as_u64().unwrap_or(0) as u32;
            let has_area_model = payload["hasAreaModel"].as_bool().unwrap_or(false);

            self.set_loaded(true)?;
            info!(label_count, has_area_model, "load_model via passthrough ok");
            return Ok(Response::new(analysis::LoadModelResponse {
                label_count,
                has_area_model,
            }));
        }

        let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        state.loaded = true;

        info!(label_count = 6522, "load_model (stub) ok");
        Ok(Response::new(analysis::LoadModelResponse {
            label_count: 6522,
            has_area_model: true,
        }))
    }

    async fn set_location(
        &self,
        request: Request<analysis::SetLocationRequest>,
    ) -> Result<Response<analysis::SetLocationResponse>, Status> {
        let req = request.into_inner();
        debug!(lat = req.latitude, lon = req.longitude, "AnalysisService::set_location");
        let endpoint = {
            let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
            if !state.loaded {
                return Ok(Response::new(analysis::SetLocationResponse { ok: false, week: 0 }));
            }

            state.location = Some(AnalysisLocation {
                latitude: req.latitude,
                longitude: req.longitude,
                date_iso8601: req.date_iso8601.clone(),
            });
            state.backend_endpoint.clone()
        };

        if let Some(endpoint) = endpoint {
            let body = serde_json::json!({
                "latitude": req.latitude,
                "longitude": req.longitude,
                "date": if req.date_iso8601.is_empty() { serde_json::Value::Null } else { serde_json::json!(req.date_iso8601) },
            });
            let payload = self
                .http_json(Method::POST, &endpoint, "/analysis/location", Some(body))
                .await?;

            return Ok(Response::new(analysis::SetLocationResponse {
                ok: payload["ok"].as_bool().unwrap_or(false),
                week: payload["week"].as_u64().unwrap_or(0) as u32,
            }));
        }

        Ok(Response::new(analysis::SetLocationResponse { ok: true, week: 22 }))
    }

    async fn clear_location(
        &self,
        _request: Request<analysis::ClearLocationRequest>,
    ) -> Result<Response<analysis::ClearLocationResponse>, Status> {
        let endpoint = {
            let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
            state.location = None;
            state.backend_endpoint.clone()
        };

        if let Some(endpoint) = endpoint {
            let _ = self
                .http_json(Method::DELETE, &endpoint, "/analysis/location", None)
                .await?;
            return Ok(Response::new(analysis::ClearLocationResponse {}));
        }

        Ok(Response::new(analysis::ClearLocationResponse {}))
    }

    async fn get_species(
        &self,
        _request: Request<analysis::GetSpeciesRequest>,
    ) -> Result<Response<analysis::GetSpeciesResponse>, Status> {
        let (loaded, location, endpoint) = {
            let state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
            (state.loaded, state.location.clone(), state.backend_endpoint.clone())
        };

        if !loaded {
            return Ok(Response::new(analysis::GetSpeciesResponse { species: vec![] }));
        }

        if let Some(endpoint) = endpoint {
            let payload = self
                .http_json(Method::GET, &endpoint, "/analysis/species", None)
                .await?;

            let items = payload
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|i| analysis::SpeciesItem {
                    scientific: i["scientific"].as_str().unwrap_or_default().to_string(),
                    common: i["common"].as_str().unwrap_or_default().to_string(),
                    geoscore: i["geoscore"].as_f64().unwrap_or(0.0),
                })
                .collect();
            return Ok(Response::new(analysis::GetSpeciesResponse { species: items }));
        }

        let geoscore = if let Some(loc) = &location {
            // Lightweight deterministic scoring that actually consumes location fields.
            let lat_factor = (loc.latitude.abs() / 90.0).clamp(0.0, 1.0);
            let lon_factor = (loc.longitude.abs() / 180.0).clamp(0.0, 1.0);
            let date_factor = if loc.date_iso8601.is_empty() { 0.0 } else { 0.02 };
            (0.78 + (lat_factor * 0.03) + (lon_factor * 0.02) + date_factor).min(0.95)
        } else {
            1.0
        };

        Ok(Response::new(analysis::GetSpeciesResponse {
            species: vec![
                analysis::SpeciesItem {
                    scientific: "Corvus corax".to_string(),
                    common: "Raven".to_string(),
                    geoscore,
                },
                analysis::SpeciesItem {
                    scientific: "Parus major".to_string(),
                    common: "Great Tit".to_string(),
                    geoscore: if location.is_some() { 0.62 } else { 1.0 },
                },
            ],
        }))
    }

    async fn analyze(
        &self,
        request: Request<analysis::AnalyzeRequest>,
    ) -> Result<Response<analysis::AnalyzeResponse>, Status> {
        let req = request.into_inner();
        debug!(samples = req.samples.len(), "AnalysisService::analyze");
        let (loaded, has_location, endpoint) = {
            let state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
            (state.loaded, state.location.is_some(), state.backend_endpoint.clone())
        };

        if !loaded {
            warn!("analyze called before model loaded");
            return Err(Status::failed_precondition("analysis model not loaded"));
        }

        let min_confidence = req
            .options
            .as_ref()
            .map(|o| o.min_confidence)
            .unwrap_or(0.25);

        if let Some(endpoint) = endpoint {
            debug!(endpoint = %endpoint, "forwarding analyze to HTTP backend");
            let body = serde_json::json!({
                "samples": req.samples,
                "options": {
                    "sampleRate": req.options.as_ref().map(|o| o.sample_rate),
                    "overlap": req.options.as_ref().map(|o| o.overlap),
                    "minConfidence": req.options.as_ref().map(|o| o.min_confidence),
                    "geoThreshold": req.options.as_ref().map(|o| o.geo_threshold),
                },
            });

            let payload = self
                .http_json(Method::POST, &endpoint, "/analysis/analyze", Some(body))
                .await?;

            let detections = payload
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|d| analysis::Detection {

                    start: d["start"].as_f64().unwrap_or(0.0),
                    end: d["end"].as_f64().unwrap_or(0.0),
                    scientific: d["scientific"].as_str().unwrap_or_default().to_string(),
                    common: d["common"].as_str().unwrap_or_default().to_string(),
                    confidence: d["confidence"].as_f64().unwrap_or(0.0),
                    geoscore: d["geoscore"].as_f64().unwrap_or(0.0),
                })
                .collect();
            return Ok(Response::new(analysis::AnalyzeResponse { detections }));
        }

        let geoscore = if has_location { 0.83 } else { 1.0 };

        let detections = vec![
            analysis::Detection {
                start: 0.0,
                end: 3.0,
                scientific: "Corvus corax".to_string(),
                common: "Raven".to_string(),
                confidence: min_confidence.max(0.91),
                geoscore,
            },
            analysis::Detection {
                start: 3.0,
                end: 6.0,
                scientific: "Parus major".to_string(),
                common: "Great Tit".to_string(),
                confidence: min_confidence.max(0.76),
                geoscore: if has_location { 0.62 } else { 1.0 },
            },
        ];

        Ok(Response::new(analysis::AnalyzeResponse { detections }))
    }
}

impl AnalysisServiceState {
    fn timeout_from_env() -> std::time::Duration {
        let ms = std::env::var("AW_ANALYSIS_HTTP_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(15_000);
        std::time::Duration::from_millis(ms)
    }

    fn new_http_client(timeout: std::time::Duration) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    fn backend_endpoint(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.backend_endpoint.clone())
    }

    fn set_loaded(&self, loaded: bool) -> Result<(), Status> {
        let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        state.loaded = loaded;
        Ok(())
    }

    async fn http_json(
        &self,
        method: Method,
        endpoint: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Status> {
        let url = format!("{}{}", endpoint.trim_end_matches('/'), path);
        let request = self.http.request(method, &url);
        let request = if let Some(b) = body { request.json(&b) } else { request };

        let response = request
            .send()
            .await
            .map_err(|e| {
                warn!(url = %url, error = %e, "HTTP passthrough request failed");
                Status::internal(format!("analysis backend request failed: {e}"))
            })?;

        if !response.status().is_success() {
            warn!(url = %url, status = %response.status(), "HTTP passthrough returned non-2xx");
            return Err(Status::internal(format!(
                "analysis backend returned HTTP {}",
                response.status()
            )));
        }

        if response.status().as_u16() == 204 {
            return Ok(serde_json::json!({}));
        }

        response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| {
                warn!(url = %url, error = %e, "HTTP passthrough JSON decode failed");
                Status::internal(format!("analysis backend JSON decode failed: {e}"))
            })
    }

    pub fn from_env() -> Self {
        let endpoint = std::env::var("AW_ANALYSIS_HTTP_ENDPOINT")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        let timeout = Self::timeout_from_env();

        if let Some(ref ep) = endpoint {
            info!(endpoint = %ep, timeout_ms = timeout.as_millis(), "AnalysisService passthrough enabled");
        } else {
            info!("AnalysisService passthrough disabled; using stub responses");
        }

        Self {
            state: Arc::new(Mutex::new(AnalysisRuntimeState {
                loaded: false,
                location: None,
                backend_endpoint: endpoint,
            })),
            http: Self::new_http_client(timeout),
        }
    }
}

#[derive(Default)]
pub struct ProjectServiceImpl;

#[derive(Clone)]
pub struct ProjectServiceState {
    store: Arc<ProjectStore>,
}

impl ProjectServiceState {
    pub fn new(store: ProjectStore) -> Self {
        Self {
            store: Arc::new(store),
        }
    }
}

fn audio_source_to_json(src: Option<projects::audio_source_ref::Source>) -> serde_json::Value {
    match src {
        Some(projects::audio_source_ref::Source::File(f)) => serde_json::json!({
            "type": "file",
            "name": f.name,
            "size": if f.size == 0 { serde_json::Value::Null } else { serde_json::json!(f.size) },
        }),
        Some(projects::audio_source_ref::Source::Url(u)) => serde_json::json!({
            "type": "url",
            "url": u.url,
            "name": if u.name.is_empty() { serde_json::Value::Null } else { serde_json::json!(u.name) },
        }),
        Some(projects::audio_source_ref::Source::XenoCanto(x)) => serde_json::json!({
            "type": "xeno-canto",
            "xcId": x.xc_id,
            "name": if x.name.is_empty() { serde_json::Value::Null } else { serde_json::json!(x.name) },
        }),
        None => serde_json::json!({ "type": "file", "name": "unknown" }),
    }
}

fn json_to_audio_source(v: &serde_json::Value) -> projects::AudioSourceRef {
    let ty = v["type"].as_str().unwrap_or("file");
    let source = match ty {
        "url" => projects::audio_source_ref::Source::Url(projects::UrlSource {
            url: v["url"].as_str().unwrap_or_default().to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
        }),
        "xeno-canto" => projects::audio_source_ref::Source::XenoCanto(projects::XenoCantoSource {
            xc_id: v["xcId"].as_str().unwrap_or_default().to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
        }),
        _ => projects::audio_source_ref::Source::File(projects::FileSource {
            name: v["name"].as_str().unwrap_or_default().to_string(),
            size: v["size"].as_u64().unwrap_or(0),
        }),
    };

    projects::AudioSourceRef { source: Some(source) }
}

fn proto_project_to_json(project: &projects::Project) -> serde_json::Value {
    serde_json::json!({
        "id": project.id,
        "name": project.name,
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
        "audioSource": audio_source_to_json(project.audio_source.as_ref().and_then(|a| a.source.clone())),
        "annotations": project.annotations.iter().map(|a| serde_json::json!({
            "id": a.id,
            "start": a.start,
            "end": a.end,
            "species": a.species,
            "label": a.label,
            "confidence": a.confidence,
            "color": a.color,
            "scientificName": a.scientific_name,
            "commonName": a.common_name,
            "origin": a.origin,
            "author": a.author,
            "tags": a.tags,
        })).collect::<Vec<_>>(),
        "labels": project.labels.iter().map(|l| serde_json::json!({
            "id": l.id,
            "start": l.start,
            "end": l.end,
            "freqMin": l.freq_min,
            "freqMax": l.freq_max,
            "label": l.label,
            "species": l.species,
            "color": l.color,
            "scientificName": l.scientific_name,
            "commonName": l.common_name,
            "origin": l.origin,
            "author": l.author,
            "tags": l.tags,
            "readonly": l.readonly,
            "confidence": l.confidence,
            "recordingId": l.recording_id,
        })).collect::<Vec<_>>(),
        "settings": if project.settings_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str::<serde_json::Value>(&project.settings_json).unwrap_or_else(|_| serde_json::json!({}))
        }
    })
}

fn json_to_proto_project(v: &serde_json::Value) -> projects::Project {
    let annotations = v["annotations"].as_array().cloned().unwrap_or_default().into_iter().map(|a| {
        let tags = a["tags"].as_object().cloned().unwrap_or_default()
            .into_iter().map(|(k, v)| (k, v.as_str().unwrap_or_default().to_string())).collect();
        projects::AnnotationRegion {
            id: a["id"].as_str().unwrap_or_default().to_string(),
            start: a["start"].as_f64().unwrap_or(0.0),
            end: a["end"].as_f64().unwrap_or(0.0),
            species: a["species"].as_str().unwrap_or_default().to_string(),
            label: a["label"].as_str().unwrap_or_default().to_string(),
            confidence: a["confidence"].as_f64().unwrap_or(0.0),
            color: a["color"].as_str().unwrap_or_default().to_string(),
            scientific_name: a["scientificName"].as_str().unwrap_or_default().to_string(),
            common_name: a["commonName"].as_str().unwrap_or_default().to_string(),
            origin: a["origin"].as_str().unwrap_or_default().to_string(),
            author: a["author"].as_str().unwrap_or_default().to_string(),
            tags,
        }
    }).collect();

    let labels = v["labels"].as_array().cloned().unwrap_or_default().into_iter().map(|l| {
        let tags = l["tags"].as_object().cloned().unwrap_or_default()
            .into_iter().map(|(k, v)| (k, v.as_str().unwrap_or_default().to_string())).collect();
        projects::SpectrogramLabel {
            id: l["id"].as_str().unwrap_or_default().to_string(),
            start: l["start"].as_f64().unwrap_or(0.0),
            end: l["end"].as_f64().unwrap_or(0.0),
            freq_min: l["freqMin"].as_f64().unwrap_or(0.0),
            freq_max: l["freqMax"].as_f64().unwrap_or(0.0),
            label: l["label"].as_str().unwrap_or_default().to_string(),
            species: l["species"].as_str().unwrap_or_default().to_string(),
            color: l["color"].as_str().unwrap_or_default().to_string(),
            scientific_name: l["scientificName"].as_str().unwrap_or_default().to_string(),
            common_name: l["commonName"].as_str().unwrap_or_default().to_string(),
            origin: l["origin"].as_str().unwrap_or_default().to_string(),
            author: l["author"].as_str().unwrap_or_default().to_string(),
            tags,
            readonly: l["readonly"].as_bool().unwrap_or(false),
            confidence: l["confidence"].as_f64().unwrap_or(0.0),
            recording_id: l["recordingId"].as_str().unwrap_or_default().to_string(),
        }
    }).collect();

    projects::Project {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str().unwrap_or_default().to_string(),
        created_at: v["createdAt"].as_i64().unwrap_or(0),
        updated_at: v["updatedAt"].as_i64().unwrap_or(0),
        audio_source: Some(json_to_audio_source(&v["audioSource"])),
        annotations,
        labels,
        settings_json: serde_json::to_string(&v["settings"]).unwrap_or_else(|_| "{}".to_string()),
    }
}

#[tonic::async_trait]
impl projects::project_service_server::ProjectService for ProjectServiceState {
    async fn save_project(
        &self,
        request: Request<projects::SaveProjectRequest>,
    ) -> Result<Response<projects::SaveProjectResponse>, Status> {
        let req = request.into_inner();
        let Some(project) = req.project else {
            return Err(Status::invalid_argument("project is required"));
        };
        let json = proto_project_to_json(&project);
        self.store
            .write_project_json(&json)
            .map_err(Status::internal)?;
        Ok(Response::new(projects::SaveProjectResponse {}))
    }

    async fn get_project(
        &self,
        request: Request<projects::GetProjectRequest>,
    ) -> Result<Response<projects::GetProjectResponse>, Status> {
        let id = request.into_inner().id;
        let json = self.store.read_project_json(&id).map_err(Status::not_found)?;
        Ok(Response::new(projects::GetProjectResponse {
            project: Some(json_to_proto_project(&json)),
        }))
    }

    async fn list_projects(
        &self,
        _request: Request<projects::ListProjectsRequest>,
    ) -> Result<Response<projects::ListProjectsResponse>, Status> {
        let summaries = self.store.list_project_summaries().map_err(Status::internal)?;
        let projects = summaries
            .into_iter()
            .map(|s| projects::ProjectSummary {
                id: s["id"].as_str().unwrap_or_default().to_string(),
                name: s["name"].as_str().unwrap_or_default().to_string(),
                created_at: s["createdAt"].as_i64().unwrap_or(0),
                updated_at: s["updatedAt"].as_i64().unwrap_or(0),
                audio_source: Some(json_to_audio_source(&s["audioSource"])),
                label_count: s["labelCount"].as_u64().unwrap_or(0) as u32,
                annotation_count: s["annotationCount"].as_u64().unwrap_or(0) as u32,
            })
            .collect();
        Ok(Response::new(projects::ListProjectsResponse { projects }))
    }

    async fn delete_project(
        &self,
        request: Request<projects::DeleteProjectRequest>,
    ) -> Result<Response<projects::DeleteProjectResponse>, Status> {
        let id = request.into_inner().id;
        self.store.delete_project(&id).map_err(Status::internal)?;
        Ok(Response::new(projects::DeleteProjectResponse {}))
    }
}

pub async fn spawn_server_with_analysis(
    addr: String,
    store: ProjectStore,
    analysis: AnalysisServiceState,
) -> Result<(), String> {
    let socket_addr: SocketAddr = addr.parse().map_err(|e| format!("invalid AW_GRPC_ADDR: {e}"))?;

    info!(addr = %socket_addr, "gRPC server starting");

    let projects = ProjectServiceState::new(store);

    Server::builder()
        .add_service(analysis::analysis_service_server::AnalysisServiceServer::new(analysis))
        .add_service(projects::project_service_server::ProjectServiceServer::new(projects))
        .serve(socket_addr)
        .await
        .map_err(|e| {
            warn!(error = %e, "gRPC server exited with error");
            format!("grpc serve failed: {e}")
        })
}

pub async fn spawn_server(addr: String, store: ProjectStore) -> Result<(), String> {
    let analysis = AnalysisServiceState::from_env();
    spawn_server_with_analysis(addr, store, analysis).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grpc::analysis::analysis_service_client::AnalysisServiceClient;
    use crate::grpc::analysis::analysis_service_server::AnalysisService;
    use crate::grpc::projects::project_service_client::ProjectServiceClient;
    use crate::grpc::projects::project_service_server::ProjectService;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::time::{sleep, Duration};

    async fn spawn_mock_analysis_backend(
        route: &'static str,
        status_line: &'static str,
        body: &'static str,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock analysis backend");
        let addr = listener
            .local_addr()
            .expect("read mock analysis backend local addr");

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = vec![0_u8; 4096];
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("read request bytes from mock backend");
                let request = String::from_utf8_lossy(&buffer[..read]);
                let request_line = request.lines().next().unwrap_or_default();

                let (response_status, response_body) = if request_line.contains(route) {
                    (status_line, body)
                } else {
                    ("404 Not Found", "{}")
                };

                let response = format!(
                    "HTTP/1.1 {response_status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                    response_body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });

        format!("http://{addr}")
    }

    async fn spawn_mock_analysis_backend_sequence(
        responses: Vec<(&'static str, &'static str, &'static str)>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock analysis backend sequence");
        let addr = listener
            .local_addr()
            .expect("read mock analysis backend sequence local addr");

        tokio::spawn(async move {
            for (route, status_line, body) in responses {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };

                let mut buffer = vec![0_u8; 4096];
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("read request bytes from mock backend sequence");
                let request = String::from_utf8_lossy(&buffer[..read]);
                let request_line = request.lines().next().unwrap_or_default();

                let (response_status, response_body) = if request_line.contains(route) {
                    (status_line, body)
                } else {
                    ("404 Not Found", "{}")
                };

                let response = format!(
                    "HTTP/1.1 {response_status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                    response_body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });

        format!("http://{addr}")
    }

    fn new_http_passthrough_service(endpoint: String) -> AnalysisServiceState {
        AnalysisServiceState {
            state: Arc::new(Mutex::new(AnalysisRuntimeState {
                loaded: false,
                location: None,
                backend_endpoint: Some(endpoint),
            })),
            http: AnalysisServiceState::new_http_client(Duration::from_millis(500)),
        }
    }

    fn new_http_passthrough_service_with_timeout(
        endpoint: String,
        timeout: Duration,
    ) -> AnalysisServiceState {
        AnalysisServiceState {
            state: Arc::new(Mutex::new(AnalysisRuntimeState {
                loaded: false,
                location: None,
                backend_endpoint: Some(endpoint),
            })),
            http: AnalysisServiceState::new_http_client(timeout),
        }
    }

    #[tokio::test]
    async fn analysis_service_requires_load_before_analyze() {
        let svc = AnalysisServiceState::default();
        let result = svc
            .analyze(Request::new(analysis::AnalyzeRequest {
                samples: vec![0.1, 0.2],
                options: Some(analysis::AnalyzeOptions {
                    sample_rate: 48_000,
                    overlap: 1.0,
                    min_confidence: 0.42,
                    geo_threshold: 0.0,
                }),
            }))
            .await;

        assert!(result.is_err(), "analyze must fail before load_model");
    }

    #[tokio::test]
    async fn analysis_service_load_then_analyze_returns_detections() {
        let svc = AnalysisServiceState::default();

        let load = svc
            .load_model(Request::new(analysis::LoadModelRequest {
                model_url: "../models/birdnet-v2.4/".to_string(),
            }))
            .await
            .expect("load_model should succeed")
            .into_inner();

        assert_eq!(load.label_count, 6522);
        assert!(load.has_area_model);

        let detections = svc
            .analyze(Request::new(analysis::AnalyzeRequest {
                samples: vec![0.1, 0.2, -0.1],
                options: Some(analysis::AnalyzeOptions {
                    sample_rate: 48_000,
                    overlap: 1.0,
                    min_confidence: 0.42,
                    geo_threshold: 0.0,
                }),
            }))
            .await
            .expect("analyze should succeed")
            .into_inner();

        assert!(detections.detections.len() >= 2);
        assert_eq!(detections.detections[0].scientific, "Corvus corax");
        assert!(detections.detections[0].confidence >= 0.42);
    }

    #[tokio::test]
    async fn analysis_service_http_passthrough_load_model_happy_path() {
        let endpoint = spawn_mock_analysis_backend(
            "/analysis/load",
            "200 OK",
            r#"{"labelCount":999,"hasAreaModel":false}"#,
        )
        .await;
        let svc = new_http_passthrough_service(endpoint);

        let load = svc
            .load_model(Request::new(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            }))
            .await
            .expect("load_model via HTTP passthrough should succeed")
            .into_inner();

        assert_eq!(load.label_count, 999);
        assert!(!load.has_area_model);
    }

    #[tokio::test]
    async fn analysis_service_http_passthrough_returns_internal_on_http_error() {
        let endpoint = spawn_mock_analysis_backend(
            "/analysis/load",
            "500 Internal Server Error",
            r#"{"error":"backend exploded"}"#,
        )
        .await;
        let svc = new_http_passthrough_service(endpoint);

        let err = svc
            .load_model(Request::new(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            }))
            .await
            .expect_err("load_model via HTTP passthrough should fail on HTTP 500");

        assert_eq!(err.code(), tonic::Code::Internal);
        assert!(
            err.message().contains("HTTP 500"),
            "unexpected error message: {}",
            err.message()
        );
    }

    #[tokio::test]
    async fn analysis_service_http_passthrough_times_out_when_backend_hangs() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind hanging backend");
        let addr = listener.local_addr().expect("read hanging backend addr");

        tokio::spawn(async move {
            if let Ok((_stream, _)) = listener.accept().await {
                sleep(Duration::from_millis(250)).await;
            }
        });

        let endpoint = format!("http://{addr}");
        let svc = new_http_passthrough_service_with_timeout(endpoint, Duration::from_millis(40));

        let err = svc
            .load_model(Request::new(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            }))
            .await
            .expect_err("load_model should fail on backend timeout");

        assert_eq!(err.code(), tonic::Code::Internal);
        assert!(
            err.message().contains("request failed"),
            "unexpected timeout message: {}",
            err.message()
        );
    }

    #[tokio::test]
    async fn analysis_service_http_passthrough_full_flow_maps_payloads() {
        let endpoint = spawn_mock_analysis_backend_sequence(vec![
            ("/analysis/load", "200 OK", r#"{"labelCount":777,"hasAreaModel":true}"#),
            ("/analysis/location", "200 OK", r#"{"ok":true,"week":17}"#),
            (
                "/analysis/species",
                "200 OK",
                r#"[{"scientific":"Corvus corax","common":"Raven","geoscore":0.9}]"#,
            ),
            (
                "/analysis/analyze",
                "200 OK",
                r#"[{"start":0.0,"end":1.0,"scientific":"Corvus corax","common":"Raven","confidence":0.95,"geoscore":0.9}]"#,
            ),
            ("/analysis/location", "204 No Content", ""),
        ])
        .await;

        let svc = new_http_passthrough_service(endpoint);

        let load = svc
            .load_model(Request::new(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            }))
            .await
            .expect("load_model should succeed")
            .into_inner();
        assert_eq!(load.label_count, 777);
        assert!(load.has_area_model);

        let set_location = svc
            .set_location(Request::new(analysis::SetLocationRequest {
                latitude: 50.0,
                longitude: 8.0,
                date_iso8601: "2026-05-07".to_string(),
            }))
            .await
            .expect("set_location should succeed")
            .into_inner();
        assert!(set_location.ok);
        assert_eq!(set_location.week, 17);

        let species = svc
            .get_species(Request::new(analysis::GetSpeciesRequest {}))
            .await
            .expect("get_species should succeed")
            .into_inner();
        assert_eq!(species.species.len(), 1);
        assert_eq!(species.species[0].scientific, "Corvus corax");
        assert_eq!(species.species[0].common, "Raven");

        let detections = svc
            .analyze(Request::new(analysis::AnalyzeRequest {
                samples: vec![0.1, -0.2, 0.3],
                options: Some(analysis::AnalyzeOptions {
                    sample_rate: 48_000,
                    overlap: 1.0,
                    min_confidence: 0.25,
                    geo_threshold: 0.0,
                }),
            }))
            .await
            .expect("analyze should succeed")
            .into_inner();
        assert_eq!(detections.detections.len(), 1);
        assert_eq!(detections.detections[0].scientific, "Corvus corax");
        assert!(detections.detections[0].confidence >= 0.95);

        svc.clear_location(Request::new(analysis::ClearLocationRequest {}))
            .await
            .expect("clear_location should succeed");
    }

    #[tokio::test]
    async fn analysis_service_http_passthrough_returns_internal_on_invalid_json() {
        let endpoint = spawn_mock_analysis_backend_sequence(vec![
            ("/analysis/load", "200 OK", r#"{"labelCount":777,"hasAreaModel":true}"#),
            ("/analysis/species", "200 OK", "not-json"),
        ])
        .await;
        let svc = new_http_passthrough_service(endpoint);

        svc.load_model(Request::new(analysis::LoadModelRequest {
            model_url: "https://example.invalid/model".to_string(),
        }))
        .await
        .expect("load_model should succeed before invalid-json species call");

        let err = svc
            .get_species(Request::new(analysis::GetSpeciesRequest {}))
            .await
            .expect_err("get_species should fail on invalid backend json");

        assert_eq!(err.code(), tonic::Code::Internal);
        assert!(
            err.message().contains("JSON decode failed"),
            "unexpected invalid-json message: {}",
            err.message()
        );
    }

    #[tokio::test]
    async fn project_service_roundtrip_save_list_get_delete() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-grpc-test-{nanos}"));
        let store = ProjectStore::new(dir.clone());
        let svc = ProjectServiceState::new(store);

        let project = projects::Project {
            id: "p-1".to_string(),
            name: "Roundtrip".to_string(),
            created_at: 1,
            updated_at: 2,
            audio_source: Some(projects::AudioSourceRef {
                source: Some(projects::audio_source_ref::Source::File(projects::FileSource {
                    name: "test.wav".to_string(),
                    size: 123,
                })),
            }),
            annotations: vec![],
            labels: vec![],
            settings_json: "{}".to_string(),
        };

        svc.save_project(Request::new(projects::SaveProjectRequest {
            project: Some(project),
        }))
        .await
        .expect("save_project should succeed");

        let list = svc
            .list_projects(Request::new(projects::ListProjectsRequest {}))
            .await
            .expect("list_projects should succeed")
            .into_inner();
        assert_eq!(list.projects.len(), 1);
        assert_eq!(list.projects[0].id, "p-1");

        let got = svc
            .get_project(Request::new(projects::GetProjectRequest { id: "p-1".to_string() }))
            .await
            .expect("get_project should succeed")
            .into_inner();
        assert_eq!(got.project.as_ref().map(|p| p.name.as_str()), Some("Roundtrip"));

        svc.delete_project(Request::new(projects::DeleteProjectRequest {
            id: "p-1".to_string(),
        }))
        .await
        .expect("delete_project should succeed");

        let list_after = svc
            .list_projects(Request::new(projects::ListProjectsRequest {}))
            .await
            .expect("list_projects after delete should succeed")
            .into_inner();
        assert!(list_after.projects.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn grpc_network_e2e_smoke() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-grpc-e2e-{nanos}"));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("read local addr");
        drop(listener);

        let server_store = ProjectStore::new(dir.clone());
        tokio::spawn(async move {
            let _ = spawn_server(addr.to_string(), server_store).await;
        });

        sleep(Duration::from_millis(120)).await;

        let endpoint = format!("http://{addr}");
        let mut analysis = AnalysisServiceClient::connect(endpoint.clone())
            .await
            .expect("connect analysis client");
        let mut projects = ProjectServiceClient::connect(endpoint)
            .await
            .expect("connect project client");

        let load = analysis
            .load_model(analysis::LoadModelRequest {
                model_url: "../models/birdnet-v2.4/".to_string(),
            })
            .await
            .expect("load_model over network")
            .into_inner();
        assert_eq!(load.label_count, 6522);

        let detected = analysis
            .analyze(analysis::AnalyzeRequest {
                samples: vec![0.1, 0.2],
                options: Some(analysis::AnalyzeOptions {
                    sample_rate: 48_000,
                    overlap: 1.0,
                    min_confidence: 0.3,
                    geo_threshold: 0.0,
                }),
            })
            .await
            .expect("analyze over network")
            .into_inner();
        assert!(!detected.detections.is_empty());

        projects
            .save_project(projects::SaveProjectRequest {
                project: Some(projects::Project {
                    id: "net-1".to_string(),
                    name: "Network".to_string(),
                    created_at: 1,
                    updated_at: 2,
                    audio_source: Some(projects::AudioSourceRef {
                        source: Some(projects::audio_source_ref::Source::File(projects::FileSource {
                            name: "n.wav".to_string(),
                            size: 1,
                        })),
                    }),
                    annotations: vec![],
                    labels: vec![],
                    settings_json: "{}".to_string(),
                }),
            })
            .await
            .expect("save project over network");

        let listed = projects
            .list_projects(projects::ListProjectsRequest {})
            .await
            .expect("list projects over network")
            .into_inner();
        assert_eq!(listed.projects.len(), 1);
        assert_eq!(listed.projects[0].id, "net-1");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn grpc_network_e2e_analysis_http_passthrough() {
        let endpoint = spawn_mock_analysis_backend_sequence(vec![
            ("/analysis/load", "200 OK", r#"{"labelCount":4242,"hasAreaModel":false}"#),
            (
                "/analysis/analyze",
                "200 OK",
                r#"[{"start":1.0,"end":2.5,"scientific":"Turdus merula","common":"Common Blackbird","confidence":0.88,"geoscore":0.74}]"#,
            ),
        ])
        .await;

        let analysis_state = new_http_passthrough_service(endpoint);

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-grpc-e2e-http-{nanos}"));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("read local addr");
        drop(listener);

        let server_store = ProjectStore::new(dir.clone());
        tokio::spawn(async move {
            let _ = spawn_server_with_analysis(addr.to_string(), server_store, analysis_state).await;
        });

        sleep(Duration::from_millis(120)).await;

        let endpoint = format!("http://{addr}");
        let mut analysis = AnalysisServiceClient::connect(endpoint)
            .await
            .expect("connect analysis client");

        let load = analysis
            .load_model(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            })
            .await
            .expect("load_model over network passthrough")
            .into_inner();
        assert_eq!(load.label_count, 4242);
        assert!(!load.has_area_model);

        let detected = analysis
            .analyze(analysis::AnalyzeRequest {
                samples: vec![0.05, -0.1, 0.2],
                options: Some(analysis::AnalyzeOptions {
                    sample_rate: 48_000,
                    overlap: 1.0,
                    min_confidence: 0.25,
                    geo_threshold: 0.0,
                }),
            })
            .await
            .expect("analyze over network passthrough")
            .into_inner();

        assert_eq!(detected.detections.len(), 1);
        assert_eq!(detected.detections[0].scientific, "Turdus merula");
        assert_eq!(detected.detections[0].common, "Common Blackbird");
        assert!(detected.detections[0].confidence >= 0.88);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn grpc_network_e2e_analysis_http_passthrough_full_flow() {
        let endpoint = spawn_mock_analysis_backend_sequence(vec![
            ("/analysis/load", "200 OK", r#"{"labelCount":3333,"hasAreaModel":true}"#),
            ("/analysis/location", "200 OK", r#"{"ok":true,"week":9}"#),
            (
                "/analysis/species",
                "200 OK",
                r#"[{"scientific":"Parus major","common":"Great Tit","geoscore":0.67}]"#,
            ),
            ("/analysis/location", "204 No Content", ""),
        ])
        .await;

        let analysis_state = new_http_passthrough_service(endpoint);

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-grpc-e2e-http-flow-{nanos}"));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("read local addr");
        drop(listener);

        let server_store = ProjectStore::new(dir.clone());
        tokio::spawn(async move {
            let _ = spawn_server_with_analysis(addr.to_string(), server_store, analysis_state).await;
        });

        sleep(Duration::from_millis(120)).await;

        let endpoint = format!("http://{addr}");
        let mut analysis = AnalysisServiceClient::connect(endpoint)
            .await
            .expect("connect analysis client");

        let load = analysis
            .load_model(analysis::LoadModelRequest {
                model_url: "https://example.invalid/model".to_string(),
            })
            .await
            .expect("load_model over network passthrough")
            .into_inner();
        assert_eq!(load.label_count, 3333);
        assert!(load.has_area_model);

        let loc = analysis
            .set_location(analysis::SetLocationRequest {
                latitude: 52.5,
                longitude: 13.4,
                date_iso8601: "2026-05-07".to_string(),
            })
            .await
            .expect("set_location over network passthrough")
            .into_inner();
        assert!(loc.ok);
        assert_eq!(loc.week, 9);

        let species = analysis
            .get_species(analysis::GetSpeciesRequest {})
            .await
            .expect("get_species over network passthrough")
            .into_inner();
        assert_eq!(species.species.len(), 1);
        assert_eq!(species.species[0].scientific, "Parus major");
        assert_eq!(species.species[0].common, "Great Tit");

        analysis
            .clear_location(analysis::ClearLocationRequest {})
            .await
            .expect("clear_location over network passthrough");

        let _ = std::fs::remove_dir_all(dir);
    }
}
