use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInfo {
    pub grpc_enabled: bool,
    pub grpc_addr: Option<String>,
    pub analysis_http_endpoint: Option<String>,
}

/// Return lightweight runtime info so the desktop frontend can react to
/// optional gRPC/analysis passthrough configuration.
#[tauri::command]
pub async fn get_desktop_runtime_info() -> Result<DesktopRuntimeInfo, String> {
    #[cfg(feature = "grpc")]
    let grpc_addr = Some(crate::commands::grpc::grpc_bind_addr());
    #[cfg(not(feature = "grpc"))]
    let grpc_addr: Option<String> = None;

    let analysis_http_endpoint = std::env::var("AW_ANALYSIS_HTTP_ENDPOINT")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());

    Ok(DesktopRuntimeInfo {
        grpc_enabled: grpc_addr.is_some(),
        grpc_addr,
        analysis_http_endpoint,
    })
}
