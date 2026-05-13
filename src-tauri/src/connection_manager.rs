// ═══════════════════════════════════════════════════════════════════════
// src-tauri/src/connection_manager.rs — Backend connection manager
//
// Owns the analysis backend configuration (mode + endpoint), runs a
// background health-ping task, and emits "connection://status" Tauri
// events whenever the state changes.
//
// Lives entirely in Rust so:
//   - HTTP calls bypass the webview CSP
//   - Ping continues even when the UI is busy rendering
//   - Single source of truth shared between IPC and any future Rust services
// ═══════════════════════════════════════════════════════════════════════

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

// ── Public types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendMode {
    Local,
    Server,
    Cloud,
}

impl Default for BackendMode {
    fn default() -> Self { Self::Local }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Local,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub mode: BackendMode,
    #[serde(default = "default_endpoint")]
    pub endpoint: String,
    /// Optional explicit SurrealDB WebSocket endpoint (e.g. "ws://host:8000").
    /// When None in server mode the endpoint field is used after http→ws conversion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_endpoint: Option<String>,
    /// SurrealDB namespace (defaults to "signavis").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// SurrealDB database (defaults to "main").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Last-used username (saved for convenience; password is never stored).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

fn default_endpoint() -> String {
    "http://localhost:8787".to_string()
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            mode: BackendMode::Local,
            endpoint: default_endpoint(),
            db_endpoint: None,
            namespace: None,
            database: None,
            username: None,
        }
    }
}

/// Emitted as Tauri event payload on every state transition.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub mode: BackendMode,
    pub endpoint: String,
    pub error_message: Option<String>,
    /// Present when successfully logged in to a SurrealDB server.
    pub logged_in_as: Option<String>,
}

// ── Internal state ────────────────────────────────────────────────────

struct Inner {
    config: ConnectionConfig,
    state: ConnectionState,
    error_message: Option<String>,
    session_token: Option<String>,
    logged_in_as: Option<String>,
}

// ── Manager ───────────────────────────────────────────────────────────

/// Tauri managed state — register once in `lib.rs` via `app.manage(ConnectionManager::new(...))`.
pub struct ConnectionManager {
    inner: Arc<Mutex<Inner>>,
}

const EVENT: &str = "connection://status";
const PING_INTERVAL: Duration = Duration::from_secs(10);
const PING_TIMEOUT: Duration = Duration::from_secs(4);
const HEALTH_PATH: &str = "/analysis/species";
const CONFIG_FILE: &str = "connection_config.json";

impl ConnectionManager {
    pub fn new(config: ConnectionConfig) -> Self {
        let state = match config.mode {
            BackendMode::Local => ConnectionState::Local,
            _ => ConnectionState::Connecting,
        };
        Self {
            inner: Arc::new(Mutex::new(Inner {
                config,
                state,
                error_message: None,
                session_token: None,
                logged_in_as: None,
            })),
        }
    }

    // ── Public API called from IPC commands ───────────────────────

    pub fn status(&self) -> ConnectionStatus {
        let g = self.inner.lock().unwrap();
        ConnectionStatus {
            state:         g.state.clone(),
            mode:          g.config.mode.clone(),
            endpoint:      g.config.endpoint.clone(),
            error_message: g.error_message.clone(),
            logged_in_as:  g.logged_in_as.clone(),
        }
    }

    pub fn config(&self) -> ConnectionConfig {
        self.inner.lock().unwrap().config.clone()
    }

    /// Apply a new config, persist it, and trigger a reconnect attempt.
    pub fn set_config(&self, config: ConnectionConfig, app: &AppHandle) {
        let is_local = config.mode == BackendMode::Local;
        {
            let mut g = self.inner.lock().unwrap();
            g.config = config;
            g.state  = if is_local { ConnectionState::Local } else { ConnectionState::Connecting };
            g.error_message = None;
            // Clear session when switching modes
            if is_local {
                g.session_token = None;
                g.logged_in_as  = None;
            }
        }
        persist_config(app, &self.config());
        emit_status(app, &self.status());

        if !is_local {
            Self::spawn_ping(Arc::clone(&self.inner), app.clone());
        }
    }

    /// Call once during app setup to start the background ping loop.
    pub fn start(&self, app: &AppHandle) {
        emit_status(app, &self.status());
        let is_local = { self.inner.lock().unwrap().config.mode == BackendMode::Local };
        if !is_local {
            Self::spawn_ping(Arc::clone(&self.inner), app.clone());
        }
    }

    /// Authenticate against the configured SurrealDB server.
    /// Returns the username on success; stores the JWT token internally.
    pub async fn login(
        &self,
        username: String,
        password: String,
        app: AppHandle,
    ) -> Result<String, String> {
        let (http_endpoint, namespace, database) = {
            let g = self.inner.lock().unwrap();
            let ws_ep = g.config.db_endpoint.clone()
                .unwrap_or_else(|| Self::http_to_ws(&g.config.endpoint));
            let http_ep = Self::ws_to_http(&ws_ep);
            let ns = g.config.namespace.clone().unwrap_or_else(|| "signavis".to_string());
            let db = g.config.database.clone().unwrap_or_else(|| "main".to_string());
            (http_ep, ns, db)
        };

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client
            .post(format!("{}/signin", http_endpoint.trim_end_matches('/')))
            .json(&serde_json::json!({
                "ns": namespace,
                "db": database,
                "user": username,
                "pass": password
            }))
            .send()
            .await
            .map_err(|e| format!("Login request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Login failed (HTTP {status}): {body}"));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Login response parse error: {e}"))?;
        let token = body["token"]
            .as_str()
            .ok_or_else(|| "Login response missing 'token' field".to_string())?
            .to_string();

        {
            let mut g = self.inner.lock().unwrap();
            g.session_token = Some(token);
            g.logged_in_as  = Some(username.clone());
            g.config.username = Some(username.clone());
        }
        persist_config(&app, &self.config());
        emit_status(&app, &self.status());
        Ok(username)
    }

    /// Clear the current server session.
    pub fn logout(&self, app: &AppHandle) {
        {
            let mut g = self.inner.lock().unwrap();
            g.session_token = None;
            g.logged_in_as  = None;
        }
        emit_status(app, &self.status());
    }

    /// Returns the currently logged-in username, if any.
    pub fn whoami(&self) -> Option<String> {
        self.inner.lock().unwrap().logged_in_as.clone()
    }

    /// Returns the current JWT session token, if logged in.
    pub fn session_token(&self) -> Option<String> {
        self.inner.lock().unwrap().session_token.clone()
    }

    /// Returns the SurrealDB WS endpoint derived from the config.
    pub fn db_ws_endpoint(&self) -> String {
        let g = self.inner.lock().unwrap();
        g.config.db_endpoint.clone()
            .unwrap_or_else(|| Self::http_to_ws(&g.config.endpoint))
    }

    /// Returns the configured namespace (defaults to "signavis").
    pub fn namespace(&self) -> String {
        self.inner.lock().unwrap().config.namespace.clone()
            .unwrap_or_else(|| "signavis".to_string())
    }

    /// Returns the configured database (defaults to "main").
    pub fn database(&self) -> String {
        self.inner.lock().unwrap().config.database.clone()
            .unwrap_or_else(|| "main".to_string())
    }

    // ── Background ping ───────────────────────────────────────────

    fn spawn_ping(inner: Arc<Mutex<Inner>>, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(PING_TIMEOUT)
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    set_error(&inner, &app, format!("HTTP client error: {e}"));
                    return;
                }
            };

            let mut interval = tokio::time::interval(PING_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                // Re-read config each tick so a mode change stops the loop.
                let (mode, endpoint) = {
                    let g = inner.lock().unwrap();
                    (g.config.mode.clone(), g.config.endpoint.clone())
                };
                if mode == BackendMode::Local {
                    break;
                }

                let url = format!("{}{}", endpoint.trim_end_matches('/'), HEALTH_PATH);
                match client.get(&url).send().await {
                    Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 405 => {
                        set_state(&inner, &app, ConnectionState::Connected, None);
                    }
                    Ok(resp) => {
                        set_error(&inner, &app, format!("HTTP {}", resp.status()));
                    }
                    Err(e) if e.is_timeout() => {
                        set_error(&inner, &app, "Timeout".to_string());
                    }
                    Err(e) => {
                        set_error(&inner, &app, format!("{e}"));
                    }
                }
            }
        });
    }

    // ── URL helpers ───────────────────────────────────────────────

    fn ws_to_http(url: &str) -> String {
        url.replacen("wss://", "https://", 1)
           .replacen("ws://", "http://", 1)
    }

    fn http_to_ws(url: &str) -> String {
        url.replacen("https://", "wss://", 1)
           .replacen("http://", "ws://", 1)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

fn set_state(inner: &Arc<Mutex<Inner>>, app: &AppHandle, state: ConnectionState, error: Option<String>) {
    {
        let mut g = inner.lock().unwrap();
        if g.state == state && g.error_message == error {
            return; // no change — avoid redundant events
        }
        g.state         = state;
        g.error_message = error;
    }
    let status = {
        let g = inner.lock().unwrap();
        ConnectionStatus {
            state:         g.state.clone(),
            mode:          g.config.mode.clone(),
            endpoint:      g.config.endpoint.clone(),
            error_message: g.error_message.clone(),
            logged_in_as:  g.logged_in_as.clone(),
        }
    };
    emit_status(app, &status);
}

fn set_error(inner: &Arc<Mutex<Inner>>, app: &AppHandle, msg: String) {
    set_state(inner, app, ConnectionState::Error, Some(msg));
}

fn emit_status(app: &AppHandle, status: &ConnectionStatus) {
    let _ = app.emit(EVENT, status);
}

// ── Config persistence ────────────────────────────────────────────────

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CONFIG_FILE))
}

pub fn load_config(app: &AppHandle) -> ConnectionConfig {
    let Some(path) = config_path(app) else { return ConnectionConfig::default() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return ConnectionConfig::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn persist_config(app: &AppHandle, config: &ConnectionConfig) {
    let Some(path) = config_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(path, json);
    }
}
