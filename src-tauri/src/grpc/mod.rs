// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/grpc/mod.rs
//
// gRPC service skeletons for future server/gateway mode.
// Compiled only with `--features grpc`.
// ═══════════════════════════════════════════════════════════════════════

pub mod analysis {
    tonic::include_proto!("audio_workbench.analysis.v1");
}

pub mod projects {
    tonic::include_proto!("audio_workbench.projects.v1");
}

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;

use tonic::{Request, Response, Status};
use tonic::transport::Server;

use crate::project_store::ProjectStore;

#[derive(Clone, Default)]
pub struct AnalysisServiceState {
    state: Arc<Mutex<AnalysisRuntimeState>>,
}

#[derive(Default)]
struct AnalysisRuntimeState {
    loaded: bool,
    location: Option<AnalysisLocation>,
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
        _request: Request<analysis::LoadModelRequest>,
    ) -> Result<Response<analysis::LoadModelResponse>, Status> {
        let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        state.loaded = true;

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
        let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        if !state.loaded {
            return Ok(Response::new(analysis::SetLocationResponse { ok: false, week: 0 }));
        }

        state.location = Some(AnalysisLocation {
            latitude: req.latitude,
            longitude: req.longitude,
            date_iso8601: req.date_iso8601,
        });

        Ok(Response::new(analysis::SetLocationResponse {
            ok: true,
            week: 22,
        }))
    }

    async fn clear_location(
        &self,
        _request: Request<analysis::ClearLocationRequest>,
    ) -> Result<Response<analysis::ClearLocationResponse>, Status> {
        let mut state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        state.location = None;
        Ok(Response::new(analysis::ClearLocationResponse {}))
    }

    async fn get_species(
        &self,
        _request: Request<analysis::GetSpeciesRequest>,
    ) -> Result<Response<analysis::GetSpeciesResponse>, Status> {
        let state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;
        if !state.loaded {
            return Ok(Response::new(analysis::GetSpeciesResponse { species: vec![] }));
        }

        let geoscore = if let Some(loc) = &state.location {
            let _ = (&loc.latitude, &loc.longitude, &loc.date_iso8601);
            0.83
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
                    geoscore: if state.location.is_some() { 0.62 } else { 1.0 },
                },
            ],
        }))
    }

    async fn analyze(
        &self,
        request: Request<analysis::AnalyzeRequest>,
    ) -> Result<Response<analysis::AnalyzeResponse>, Status> {
        let req = request.into_inner();
        let state = self.state.lock().map_err(|_| Status::internal("analysis state poisoned"))?;

        if !state.loaded {
            return Err(Status::failed_precondition("analysis model not loaded"));
        }

        let min_confidence = req
            .options
            .as_ref()
            .map(|o| o.min_confidence)
            .unwrap_or(0.25);

        let geoscore = if state.location.is_some() { 0.83 } else { 1.0 };

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
                geoscore: if state.location.is_some() { 0.62 } else { 1.0 },
            },
        ];

        Ok(Response::new(analysis::AnalyzeResponse { detections }))
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

pub async fn spawn_server(addr: String, store: ProjectStore) -> Result<(), String> {
    let socket_addr: SocketAddr = addr.parse().map_err(|e| format!("invalid AW_GRPC_ADDR: {e}"))?;

    let analysis = AnalysisServiceState::default();
    let projects = ProjectServiceState::new(store);

    Server::builder()
        .add_service(analysis::analysis_service_server::AnalysisServiceServer::new(analysis))
        .add_service(projects::project_service_server::ProjectServiceServer::new(projects))
        .serve(socket_addr)
        .await
        .map_err(|e| format!("grpc serve failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grpc::analysis::analysis_service_server::AnalysisService;
    use crate::grpc::projects::project_service_server::ProjectService;
    use std::time::{SystemTime, UNIX_EPOCH};

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
}
