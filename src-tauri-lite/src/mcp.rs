// MCP server: lets AI assistants (Claude Desktop, Claude Code, Cursor, …) drive SignaVis Lite.
//
// Off by default; the webview switches it on (⚙ → Allow AI assistants). Streamable HTTP on
// 127.0.0.1 with a bearer token; port and token go to `mcp.json` in the app config dir so the
// stdio shim (`signavis-lite --mcp`) and clients can find them. Only the protocol lives here:
// tools/list returns the list the webview registered (app/lite/assistant-tools.ts), tools/call is
// sent to the webview as the event `mcp://call` and answered with `mcp_respond`.
// Plan: SignaVis-lab plans/mcp-server-plan.md.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub const CALL_EVENT: &str = "mcp://call";
const IDENTIFIER: &str = "io.github.limitlessgreen.signavis.lite";
/// Newest first; an older client version we know is echoed back.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
/// Tool calls may wait for the person (confirm dialogs), so this is generous.
const CALL_TIMEOUT: Duration = Duration::from_secs(180);

const INSTRUCTIONS: &str = "SignaVis Lite is a desktop app for listening to, viewing and labelling \
sound recordings (birds, bats, frogs). Start with get_app_state to see what is open. Times are \
seconds from the start of the open recording, frequencies Hz. Changes you make are single undo steps \
in the app; deleting asks the person first. list_actions/run_action reach every command of the \
app's Ctrl K search (spaces, panels, menus).";

#[derive(Serialize, Deserialize, Clone)]
pub struct McpConfig {
    pub port: u16,
    pub token: String,
    pub url: String,
}

#[derive(Default)]
pub struct McpState {
    inner: Arc<Shared>,
    running: Mutex<Option<Running>>,
}

#[derive(Default)]
struct Shared {
    tools: Mutex<Value>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_id: AtomicU64,
}

struct Running {
    server: Arc<tiny_http::Server>,
    config: McpConfig,
}

/// Where mcp.json lives: the same dir as Tauri's app_config_dir (or the test data dir override).
pub fn config_path() -> Option<PathBuf> {
    if let Some(d) = crate::data_dir_override() {
        return Some(d.join("mcp.json"));
    }
    let base: Option<PathBuf> = if cfg!(windows) {
        std::env::var_os("APPDATA").map(Into::into)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(Into::into)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|b| b.join(IDENTIFIER).join("mcp.json"))
}

fn read_config() -> Option<McpConfig> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_config(c: &McpConfig) -> Result<(), String> {
    let path = config_path().ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(c).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn new_token() -> Result<String, String> {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    running: bool,
    url: Option<String>,
    config_path: Option<String>,
    /// For the settings dialog: what to paste into a client's config.
    client_config: Option<Value>,
}

fn status_of(running: &Option<Running>) -> McpStatus {
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
    McpStatus {
        running: running.is_some(),
        url: running.as_ref().map(|r| r.config.url.clone()),
        config_path: config_path().map(|p| p.to_string_lossy().into_owned()),
        client_config: exe.map(|e| json!({ "mcpServers": { "signavis": { "command": e, "args": ["--mcp"] } } })),
    }
}

#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>) -> McpStatus {
    status_of(&state.running.lock().unwrap())
}

/// The webview's tool list (MCP `tools/list` shape); set before or after starting.
#[tauri::command]
pub fn mcp_set_tools(state: State<'_, McpState>, tools: Value) {
    *state.inner.tools.lock().unwrap() = tools;
}

/// The webview's answer to an `mcp://call` event.
#[tauri::command]
pub fn mcp_respond(state: State<'_, McpState>, id: u64, result: Value) {
    if let Some(tx) = state.inner.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub fn mcp_set_enabled(app: AppHandle, state: State<'_, McpState>, enabled: bool) -> Result<McpStatus, String> {
    let mut running = state.running.lock().unwrap();
    if !enabled {
        if let Some(r) = running.take() {
            r.server.unblock();
        }
        // The token stays valid only while the server runs.
        if let Some(p) = config_path() {
            let _ = std::fs::remove_file(p);
        }
        return Ok(status_of(&running));
    }
    if running.is_none() {
        // Keep the port of last time when it is free (clients configured by URL keep working).
        let old = read_config();
        let server = old
            .as_ref()
            .and_then(|c| tiny_http::Server::http(("127.0.0.1", c.port)).ok())
            .map(Ok)
            .unwrap_or_else(|| tiny_http::Server::http("127.0.0.1:0"))
            .map_err(|e| format!("cannot start the MCP server: {e}"))?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
        let token = match old {
            Some(c) if c.port == port => c.token,
            _ => new_token()?,
        };
        let config = McpConfig { port, token, url: format!("http://127.0.0.1:{port}/mcp") };
        write_config(&config)?;
        let server = Arc::new(server);
        spawn_loop(app, server.clone(), state.inner.clone(), config.token.clone());
        *running = Some(Running { server, config });
    }
    Ok(status_of(&running))
}

// ── HTTP + JSON-RPC ─────────────────────────────────────────────────────

fn spawn_loop(app: AppHandle, server: Arc<tiny_http::Server>, shared: Arc<Shared>, token: String) {
    std::thread::Builder::new()
        .name("mcp-http".into())
        .spawn(move || {
            for req in server.incoming_requests() {
                let (app, shared, token) = (app.clone(), shared.clone(), token.clone());
                // One thread per request: a tool call waits for the webview.
                std::thread::spawn(move || handle(req, &app, &shared, &token));
            }
        })
        .expect("spawn mcp thread");
}

fn header<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn reply(req: tiny_http::Request, status: u16, body: Option<Value>) {
    let mut res = tiny_http::Response::from_data(body.map(|b| b.to_string().into_bytes()).unwrap_or_default())
        .with_status_code(status);
    res.add_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = req.respond(res);
}

/// Browsers send Origin; only local pages may talk to us (DNS-rebinding guard from the MCP spec).
pub fn origin_ok(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => {
            let host = o.split("://").nth(1).unwrap_or("").split([':', '/']).next().unwrap_or("");
            matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        }
    }
}

pub fn token_ok(auth: Option<&str>, token: &str) -> bool {
    let Some(given) = auth.and_then(|a| a.strip_prefix("Bearer ")) else { return false };
    // Constant time over equal lengths.
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn handle(mut req: tiny_http::Request, app: &AppHandle, shared: &Shared, token: &str) {
    if !origin_ok(header(&req, "Origin")) {
        return reply(req, 403, None);
    }
    if req.url().split('?').next() != Some("/mcp") {
        return reply(req, 404, None);
    }
    if !token_ok(header(&req, "Authorization"), token) {
        return reply(req, 401, Some(json!({ "error": "missing or wrong bearer token (see mcp.json)" })));
    }
    if *req.method() != tiny_http::Method::Post {
        // No server-initiated stream (GET) and no sessions to delete.
        return reply(req, 405, None);
    }
    let mut body = String::new();
    if req.as_reader().take(8 << 20).read_to_string(&mut body).is_err() {
        return reply(req, 400, None);
    }
    let Ok(msg) = serde_json::from_str::<Value>(&body) else {
        return reply(req, 400, Some(rpc_error(Value::Null, -32700, "parse error")));
    };
    match dispatch(&msg, |name, args| call_webview(app, shared, name, args), &shared.tools.lock().unwrap().clone()) {
        Some(res) => reply(req, 200, Some(res)),
        None => reply(req, 202, None),
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message → the response (None for notifications and responses).
pub fn dispatch(msg: &Value, call: impl Fn(&str, Value) -> Value, tools: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str);
    let (Some(id), Some(method)) = (id, method) else { return None };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "signavis-lite", "title": "SignaVis Lite", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": if tools.is_array() { tools.clone() } else { json!([]) } }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "params.name is required"));
            };
            let known = tools.as_array().is_some_and(|t| t.iter().any(|x| x.get("name").and_then(Value::as_str) == Some(name)));
            if !known {
                return Some(rpc_error(id, -32602, &format!("unknown tool: {name}")));
            }
            call(name, params.get("arguments").cloned().unwrap_or(json!({})))
        }
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn call_webview(app: &AppHandle, shared: &Shared, name: &str, args: Value) -> Value {
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel();
    shared.pending.lock().unwrap().insert(id, tx);
    if app.emit_to("main", CALL_EVENT, json!({ "id": id, "name": name, "arguments": args })).is_err() {
        shared.pending.lock().unwrap().remove(&id);
        return tool_error("SignaVis Lite has no window to run this in.");
    }
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(v) => v,
        Err(_) => {
            shared.pending.lock().unwrap().remove(&id);
            tool_error("SignaVis Lite did not answer in time (is a dialog open?).")
        }
    }
}

// ── stdio shim: `signavis-lite --mcp` ───────────────────────────────────

/// Forward newline-delimited JSON-RPC from stdin to the running app; answers go to stdout.
pub fn stdio_bridge() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id").cloned());
        let answer = match read_config() {
            None => Err("SignaVis Lite is not running, or AI assistants are off (⚙ → Allow AI assistants).".to_string()),
            Some(c) => post(&c, &line),
        };
        let response = match answer {
            Ok(Some(body)) => body,
            Ok(None) => continue,
            Err(e) => match id {
                Some(id) => rpc_error(id, -32000, &e).to_string(),
                None => continue,
            },
        };
        if writeln!(out, "{response}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

/// Minimal HTTP/1.1 POST to 127.0.0.1 (no client library needed for one local hop).
fn post(c: &McpConfig, body: &str) -> Result<Option<String>, String> {
    let fail = |e: std::io::Error| format!("cannot reach SignaVis Lite on port {}: {e}", c.port);
    let mut s = TcpStream::connect(("127.0.0.1", c.port)).map_err(fail)?;
    write!(
        s,
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        c.port, c.token, body.len(), body
    )
    .map_err(fail)?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(fail)?;
    let (status, body) = parse_response(&raw).ok_or("bad answer from SignaVis Lite")?;
    match status {
        202 => Ok(None),
        200 => Ok(Some(String::from_utf8_lossy(&body).trim().to_string())),
        401 => Err("SignaVis Lite refused the token; switch AI assistants off and on again.".into()),
        _ => Err(format!("SignaVis Lite answered HTTP {status}")),
    }
}

/// Status and body of an HTTP/1.1 response; large bodies come chunked (tiny_http does that).
pub fn parse_response(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut rest = &raw[split + 4..];
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if !chunked {
        return Some((status, rest.to_vec()));
    }
    let mut body = Vec::new();
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&rest[..eol]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[eol + 2..];
        if size == 0 {
            return Some((status, body));
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_echoes_a_known_version_else_newest() {
        let r = dispatch(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), |_, _| json!(null), &json!([])).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], false);
        let r = dispatch(&json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}), |_, _| json!(null), &json!([])).unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn notifications_get_no_answer_and_unknown_methods_an_error() {
        assert!(dispatch(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), |_, _| json!(null), &json!([])).is_none());
        let r = dispatch(&json!({"jsonrpc":"2.0","id":"a","method":"resources/list"}), |_, _| json!(null), &json!([])).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], "a");
    }

    #[test]
    fn tools_are_listed_and_only_known_ones_called() {
        let tools = json!([{ "name": "get_app_state", "description": "", "inputSchema": {"type":"object"} }]);
        let r = dispatch(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), |_, _| json!(null), &tools).unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "get_app_state");
        let r = dispatch(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_app_state","arguments":{"x":1}}}),
            |n, a| json!({ "content": [{ "type": "text", "text": format!("{n} {a}") }] }), &tools).unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "get_app_state {\"x\":1}");
        let r = dispatch(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rm_rf"}}), |_, _| json!(null), &tools).unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn responses_plain_and_chunked() {
        let (st, b) = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((st, b.as_slice()), (200, &b"{}"[..]));
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n";
        let (_, b) = parse_response(raw).unwrap();
        assert_eq!(b, b"{\"a\":1}");
        assert_eq!(parse_response(b"HTTP/1.1 202 Accepted\r\n\r\n").unwrap().0, 202);
        assert!(parse_response(b"garbage").is_none());
    }

    #[test]
    fn origin_and_token_checks() {
        assert!(origin_ok(None));
        assert!(origin_ok(Some("http://localhost:5173")));
        assert!(origin_ok(Some("http://127.0.0.1")));
        assert!(!origin_ok(Some("https://evil.example")));
        assert!(!origin_ok(Some("http://localhost.evil.example")));
        assert!(token_ok(Some("Bearer abc"), "abc"));
        assert!(!token_ok(Some("Bearer abd"), "abc"));
        assert!(!token_ok(Some("abc"), "abc"));
        assert!(!token_ok(None, "abc"));
    }
}
