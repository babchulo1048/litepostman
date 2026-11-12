//! Sending requests with reqwest, cancel support, and response body storage.
//!
//! Bodies stay in Rust: the frontend gets metadata from `send_request`, then
//! asks for the pretty-printed text (`response_pretty`) or raw bytes
//! (`response_body`) separately. Large bodies never travel as giant JSON strings.

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method, redirect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const PRETTY_LIMIT: usize = 2 * 1024 * 1024;
const MAX_STORED_BODIES: usize = 30;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutBody {
    None,
    Text { content: String },
    Multipart { fields: Vec<FormField> },
}

#[derive(Deserialize)]
pub struct FormField {
    pub key: String,
    /// text value, or the file path when `file` is true
    pub value: String,
    #[serde(default)]
    pub file: bool,
}

/// Content-Type for an uploaded file, from its extension. Unknown → octet-stream.
fn mime_for(path: &std::path::Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        _ => "application/octet-stream",
    }
}

/// Build the multipart form; file fields are read from disk here.
fn build_form(fields: Vec<FormField>) -> Result<reqwest::multipart::Form, String> {
    let mut form = reqwest::multipart::Form::new();
    for f in fields {
        if !f.file {
            form = form.text(f.key, f.value);
            continue;
        }
        if f.value.trim().is_empty() {
            return Err(format!("Form-data field \"{}\": no file selected", f.key));
        }
        let path = std::path::Path::new(&f.value);
        let bytes = std::fs::read(path).map_err(|e| format!("Form-data field \"{}\": cannot read {}: {e}", f.key, f.value))?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str(mime_for(path))
            .map_err(|e| e.to_string())?;
        form = form.part(f.key, part);
    }
    Ok(form)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: OutBody,
    pub timeout_ms: u64,
    pub insecure: bool,
    pub follow_redirects: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub time_ms: f64,
    pub size: usize,
    pub final_url: String,
    pub http_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrettyBody {
    pub text: String,
    /// "json" | "xml" | "html" | "javascript" | "text"
    pub language: String,
    pub too_large: bool,
    pub binary: bool,
    pub size: usize,
}

struct StoredBody {
    id: String,
    bytes: Vec<u8>,
    content_type: String,
}

/// Shared state for all HTTP commands. Tauri keeps one instance and hands a
/// reference to each command. `Mutex` = lock so only one thread touches the
/// data at a time; `Arc` = shared ownership across threads.
pub struct HttpState {
    jar: Arc<reqwest::cookie::Jar>,
    clients: Mutex<HashMap<(bool, bool), Client>>,
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
    bodies: Mutex<Vec<StoredBody>>,
}

impl HttpState {
    pub fn new() -> Self {
        HttpState {
            jar: Arc::new(reqwest::cookie::Jar::default()),
            clients: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            bodies: Mutex::new(Vec::new()),
        }
    }

    /// One client per (insecure, follow_redirects) combo, all sharing one cookie jar.
    fn client(&self, insecure: bool, follow: bool) -> Result<Client, String> {
        let mut clients = self.clients.lock().unwrap();
        if let Some(c) = clients.get(&(insecure, follow)) {
            return Ok(c.clone()); // Client is a cheap handle; clone shares the pool
        }
        let c = Client::builder()
            .cookie_provider(self.jar.clone())
            .danger_accept_invalid_certs(insecure)
            .redirect(if follow { redirect::Policy::limited(10) } else { redirect::Policy::none() })
            .build()
            .map_err(|e| e.to_string())?;
        clients.insert((insecure, follow), c.clone());
        Ok(c)
    }

    fn store_body(&self, id: &str, bytes: Vec<u8>, content_type: String) {
        let mut bodies = self.bodies.lock().unwrap();
        bodies.retain(|b| b.id != id);
        bodies.push(StoredBody { id: id.to_string(), bytes, content_type });
        if bodies.len() > MAX_STORED_BODIES {
            bodies.remove(0);
        }
    }

    fn with_body<T>(&self, id: &str, f: impl FnOnce(&StoredBody) -> T) -> Result<T, String> {
        let bodies = self.bodies.lock().unwrap();
        bodies.iter().find(|b| b.id == id).map(f).ok_or_else(|| "Response no longer in memory".to_string())
    }
}

/// reqwest errors wrap the real cause several levels deep ("error sending
/// request" → "connection refused"). Walk the chain so the user sees the cause.
fn describe(e: &reqwest::Error, timeout_ms: u64) -> String {
    if e.is_timeout() {
        return format!("Request timed out after {:.1}s", timeout_ms as f64 / 1000.0);
    }
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let part = s.to_string();
        if !msg.contains(&part) {
            msg.push_str(": ");
            msg.push_str(&part);
        }
        src = s.source();
    }
    msg
}

async fn do_send(state: &HttpState, id: &str, req: OutgoingRequest) -> Result<ResponseMeta, String> {
    let client = state.client(req.insecure, req.follow_redirects)?;
    let method = Method::from_bytes(req.method.trim().as_bytes())
        .map_err(|_| format!("Invalid method \"{}\"", req.method))?;
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("Invalid URL \"{}\": {e}", req.url))?;

    let mut rb = client.request(method, url).timeout(Duration::from_millis(req.timeout_ms));
    for (k, v) in &req.headers {
        let name = HeaderName::from_bytes(k.trim().as_bytes()).map_err(|_| format!("Invalid header name \"{k}\""))?;
        let value = HeaderValue::from_str(v).map_err(|_| format!("Invalid value for header \"{k}\""))?;
        rb = rb.header(name, value);
    }
    rb = match req.body {
        OutBody::None => rb,
        OutBody::Text { content } => rb.body(content),
        OutBody::Multipart { fields } => rb.multipart(build_form(fields)?),
    };

    let start = Instant::now();
    let resp = rb.send().await.map_err(|e| describe(&e, req.timeout_ms))?;
    let status = resp.status();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let content_type = resp
        .headers()
        .get("content-type")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default();
    let final_url = resp.url().to_string();
    let http_version = format!("{:?}", resp.version());
    let bytes = resp.bytes().await.map_err(|e| describe(&e, req.timeout_ms))?;
    let time_ms = start.elapsed().as_secs_f64() * 1000.0;

    let size = bytes.len();
    state.store_body(id, bytes.to_vec(), content_type);
    Ok(ResponseMeta {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        time_ms,
        size,
        final_url,
        http_version,
    })
}

// `async fn` commands run on Tauri's tokio runtime, so a slow request never
// blocks the UI. `tauri::State` is how a command borrows the shared HttpState.
#[tauri::command]
pub async fn send_request(
    state: tauri::State<'_, HttpState>,
    id: String,
    request: OutgoingRequest,
) -> Result<ResponseMeta, String> {
    let (tx, rx) = oneshot::channel();
    state.inflight.lock().unwrap().insert(id.clone(), tx);
    // `select!` waits on both futures and takes whichever finishes first:
    // the request, or a cancel signal from `cancel_request`.
    let result = tokio::select! {
        r = do_send(&state, &id, request) => r,
        _ = rx => Err("Request cancelled".to_string()),
    };
    state.inflight.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn cancel_request(state: tauri::State<'_, HttpState>, id: String) {
    if let Some(tx) = state.inflight.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// Raw body bytes — sent as binary over IPC, not as a JSON string.
#[tauri::command]
pub fn response_body(state: tauri::State<'_, HttpState>, id: String) -> Result<tauri::ipc::Response, String> {
    state.with_body(&id, |b| tauri::ipc::Response::new(b.bytes.clone()))
}

fn detect_language(content_type: &str, text: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("json") {
        return "json";
    }
    if ct.contains("html") {
        return "html";
    }
    if ct.contains("xml") {
        return "xml";
    }
    if ct.contains("javascript") {
        return "javascript";
    }
    let t = text.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        "json"
    } else if t.starts_with("<?xml") {
        "xml"
    } else if t.starts_with('<') {
        "html"
    } else {
        "text"
    }
}

#[tauri::command]
pub fn response_pretty(state: tauri::State<'_, HttpState>, id: String) -> Result<PrettyBody, String> {
    state.with_body(&id, |b| {
        let size = b.bytes.len();
        let Ok(text) = std::str::from_utf8(&b.bytes) else {
            return PrettyBody { text: String::new(), language: "text".into(), too_large: false, binary: true, size };
        };
        let mut language = detect_language(&b.content_type, text).to_string();
        if size > PRETTY_LIMIT {
            return PrettyBody { text: String::new(), language, too_large: true, binary: false, size };
        }
        let text = if language == "json" {
            match serde_json::from_str::<serde_json::Value>(text) {
                Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| text.to_string()),
                Err(_) => {
                    language = "text".into();
                    text.to_string()
                }
            }
        } else {
            text.to_string()
        };
        PrettyBody { text, language, too_large: false, binary: false, size }
    })
}

#[tauri::command]
pub fn save_response(state: tauri::State<'_, HttpState>, id: String, path: String) -> Result<(), String> {
    let bytes = state.with_body(&id, |b| b.bytes.clone())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_file_errors_are_clear() {
        let field = |value: &str| vec![FormField { key: "doc".into(), value: value.into(), file: true }];
        let err = build_form(field("/nope/missing.pdf")).err().unwrap();
        assert!(err.starts_with("Form-data field \"doc\": cannot read /nope/missing.pdf"), "{err}");
        assert_eq!(build_form(field("")).err().unwrap(), "Form-data field \"doc\": no file selected");
        assert!(build_form(field("Cargo.toml")).is_ok());
        assert_eq!(mime_for(std::path::Path::new("a.PDF")), "application/pdf");
    }
}
