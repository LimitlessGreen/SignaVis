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

use tonic::{Request, Response, Status};
use tonic::transport::Server;

use crate::project_store::ProjectStore;

#[derive(Default)]
pub struct AnalysisServiceImpl;

#[tonic::async_trait]
impl analysis::analysis_service_server::AnalysisService for AnalysisServiceImpl {
    async fn load_model(
        &self,
        _request: Request<analysis::LoadModelRequest>,
    ) -> Result<Response<analysis::LoadModelResponse>, Status> {
        Err(Status::unimplemented("LoadModel not implemented yet"))
    }

    async fn set_location(
        &self,
        _request: Request<analysis::SetLocationRequest>,
    ) -> Result<Response<analysis::SetLocationResponse>, Status> {
        Err(Status::unimplemented("SetLocation not implemented yet"))
    }

    async fn clear_location(
        &self,
        _request: Request<analysis::ClearLocationRequest>,
    ) -> Result<Response<analysis::ClearLocationResponse>, Status> {
        Err(Status::unimplemented("ClearLocation not implemented yet"))
    }

    async fn get_species(
        &self,
        _request: Request<analysis::GetSpeciesRequest>,
    ) -> Result<Response<analysis::GetSpeciesResponse>, Status> {
        Err(Status::unimplemented("GetSpecies not implemented yet"))
    }

    async fn analyze(
        &self,
        _request: Request<analysis::AnalyzeRequest>,
    ) -> Result<Response<analysis::AnalyzeResponse>, Status> {
        Err(Status::unimplemented("Analyze not implemented yet"))
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

    let analysis = AnalysisServiceImpl::default();
    let projects = ProjectServiceState::new(store);

    Server::builder()
        .add_service(analysis::analysis_service_server::AnalysisServiceServer::new(analysis))
        .add_service(projects::project_service_server::ProjectServiceServer::new(projects))
        .serve(socket_addr)
        .await
        .map_err(|e| format!("grpc serve failed: {e}"))
}
