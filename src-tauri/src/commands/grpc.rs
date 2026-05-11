use serde_json::Value as JsonValue;

/// Returns the gRPC bind address from the environment or the default.
#[cfg(feature = "grpc")]
pub fn grpc_bind_addr() -> String {
    std::env::var("AW_GRPC_ADDR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "127.0.0.1:50051".to_string())
}

#[cfg(feature = "grpc")]
async fn grpc_analysis_client() -> Result<
    crate::grpc::analysis::analysis_service_client::AnalysisServiceClient<
        tonic::transport::Channel,
    >,
    String,
> {
    let endpoint = format!("http://{}", grpc_bind_addr());
    crate::grpc::analysis::analysis_service_client::AnalysisServiceClient::connect(endpoint)
        .await
        .map_err(|e| format!("grpc analysis connect failed: {e}"))
}

#[cfg(feature = "grpc")]
#[derive(Debug, serde::Deserialize)]
struct GrpcAnalyzeOptionsArgs {
    sample_rate: u32,
    overlap: f64,
    min_confidence: f64,
    geo_threshold: f64,
}

#[tauri::command]
pub async fn grpc_analysis_load_model(model_url: String) -> Result<JsonValue, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .load_model(crate::grpc::analysis::LoadModelRequest { model_url })
            .await
            .map_err(|e| format!("grpc load_model failed: {e}"))?
            .into_inner();

        return Ok(serde_json::json!({
            "labelCount": response.label_count,
            "hasAreaModel": response.has_area_model,
        }));
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = model_url;
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
pub async fn grpc_analysis_set_location(
    latitude: f64,
    longitude: f64,
    date_iso8601: Option<String>,
) -> Result<JsonValue, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .set_location(crate::grpc::analysis::SetLocationRequest {
                latitude,
                longitude,
                date_iso8601: date_iso8601.unwrap_or_default(),
            })
            .await
            .map_err(|e| format!("grpc set_location failed: {e}"))?
            .into_inner();

        return Ok(serde_json::json!({
            "ok": response.ok,
            "week": response.week,
        }));
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = (latitude, longitude, date_iso8601);
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
pub async fn grpc_analysis_get_species() -> Result<Vec<JsonValue>, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let response = client
            .get_species(crate::grpc::analysis::GetSpeciesRequest {})
            .await
            .map_err(|e| format!("grpc get_species failed: {e}"))?
            .into_inner();

        let items = response
            .species
            .into_iter()
            .map(|i| {
                serde_json::json!({
                    "scientific": i.scientific,
                    "common": i.common,
                    "geoscore": i.geoscore,
                })
            })
            .collect();

        return Ok(items);
    }

    #[cfg(not(feature = "grpc"))]
    {
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
pub async fn grpc_analysis_clear_location() -> Result<(), String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        client
            .clear_location(crate::grpc::analysis::ClearLocationRequest {})
            .await
            .map_err(|e| format!("grpc clear_location failed: {e}"))?;
        return Ok(());
    }

    #[cfg(not(feature = "grpc"))]
    {
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}

#[tauri::command]
pub async fn grpc_analysis_analyze(
    samples: Vec<f32>,
    options: Option<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    #[cfg(feature = "grpc")]
    {
        let mut client = grpc_analysis_client().await?;
        let opts = options
            .map(serde_json::from_value::<GrpcAnalyzeOptionsArgs>)
            .transpose()
            .map_err(|e| format!("invalid grpc analyze options: {e}"))?
            .unwrap_or(GrpcAnalyzeOptionsArgs {
                sample_rate: 48_000,
                overlap: 0.0,
                min_confidence: 0.25,
                geo_threshold: 0.0,
            });

        let response = client
            .analyze(crate::grpc::analysis::AnalyzeRequest {
                samples,
                options: Some(crate::grpc::analysis::AnalyzeOptions {
                    sample_rate: opts.sample_rate,
                    overlap: opts.overlap,
                    min_confidence: opts.min_confidence,
                    geo_threshold: opts.geo_threshold,
                }),
            })
            .await
            .map_err(|e| format!("grpc analyze failed: {e}"))?
            .into_inner();

        let detections = response
            .detections
            .into_iter()
            .map(|d| {
                serde_json::json!({
                    "start": d.start,
                    "end": d.end,
                    "scientific": d.scientific,
                    "common": d.common,
                    "confidence": d.confidence,
                    "geoscore": d.geoscore,
                })
            })
            .collect();

        return Ok(detections);
    }

    #[cfg(not(feature = "grpc"))]
    {
        let _ = (samples, options);
        Err("gRPC bridge is not available in this desktop build".to_string())
    }
}
