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
}

fn default_endpoint() -> String {
    "http://localhost:8787".to_string()
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self { mode: BackendMode::Local, endpoint: default_endpoint() }
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
}

// ── Internal state ────────────────────────────────────────────────────

struct Inner {
    config: ConnectionConfig,
    state: ConnectionState,
    error_message: Option<String>,
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
