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

use tonic::{Request, Response, Status};

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

#[tonic::async_trait]
impl projects::project_service_server::ProjectService for ProjectServiceImpl {
    async fn save_project(
        &self,
        _request: Request<projects::SaveProjectRequest>,
    ) -> Result<Response<projects::SaveProjectResponse>, Status> {
        Err(Status::unimplemented("SaveProject not implemented yet"))
    }

    async fn get_project(
        &self,
        _request: Request<projects::GetProjectRequest>,
    ) -> Result<Response<projects::GetProjectResponse>, Status> {
        Err(Status::unimplemented("GetProject not implemented yet"))
    }

    async fn list_projects(
        &self,
        _request: Request<projects::ListProjectsRequest>,
    ) -> Result<Response<projects::ListProjectsResponse>, Status> {
        Err(Status::unimplemented("ListProjects not implemented yet"))
    }

    async fn delete_project(
        &self,
        _request: Request<projects::DeleteProjectRequest>,
    ) -> Result<Response<projects::DeleteProjectResponse>, Status> {
        Err(Status::unimplemented("DeleteProject not implemented yet"))
    }
}
