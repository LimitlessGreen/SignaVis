use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_millis() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?;
    Ok(duration.as_millis() as u64)
}

pub fn new_id(prefix: &str) -> Result<String, String> {
    Ok(format!("{prefix}-{}", now_millis()?))
}
