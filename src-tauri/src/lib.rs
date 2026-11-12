mod collection;
mod http;
mod watcher;

use collection::{Collection, Environment};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

/// Read + parse a file, retrying a few times: when an editor is mid-save the
/// file can be briefly empty or half-written.
async fn read_with_retry<T>(path: &str, parse: impl Fn(&str, &str) -> Result<T, String>) -> Result<T, String> {
    let canonical = watcher::canonical(path).to_string_lossy().to_string();
    let mut last_err = String::new();
    for attempt in 0..4 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        match std::fs::read_to_string(&canonical) {
            Ok(text) => match parse(&canonical, &text) {
                Ok(v) => return Ok(v),
                Err(e) => last_err = e,
            },
            Err(e) => last_err = format!("Cannot read {canonical}: {e}"),
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn load_collection(path: String) -> Result<Collection, String> {
    read_with_retry(&path, collection::parse_collection).await
}

#[tauri::command]
async fn load_environment(path: String) -> Result<Environment, String> {
    read_with_retry(&path, collection::parse_environment).await
}

#[tauri::command]
fn detect_file_kind(path: String) -> Result<String, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    collection::detect_kind(&text).map(String::from)
}

// ---------- app config files in ~/.config/litepostman ----------

fn config_file(name: &str) -> Result<PathBuf, String> {
    // Whitelist: the frontend can only touch these files.
    if !["state", "variables", "edits"].contains(&name) {
        return Err(format!("Unknown config file {name}"));
    }
    let dir = dirs::config_dir().ok_or("No config dir")?.join("litepostman");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

/// `Option<String>`: `None` when the file doesn't exist yet (first launch).
#[tauri::command]
fn read_config(name: String) -> Result<Option<String>, String> {
    let path = config_file(&name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_config(name: String, contents: String) -> Result<(), String> {
    let path = config_file(&name)?;
    // Write to a temp file then rename, so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- dev self-test (inactive unless LITEPOSTMAN_SELFTEST is set) ----------

/// (report path, request name to show at the end)
#[tauri::command]
fn selftest_config() -> Option<(String, String)> {
    let report = std::env::var("LITEPOSTMAN_SELFTEST").ok()?;
    Some((report, std::env::var("LITEPOSTMAN_SHOW").unwrap_or_default()))
}

#[tauri::command]
fn write_selftest_report(contents: String) -> Result<(), String> {
    let path = std::env::var("LITEPOSTMAN_SELFTEST").map_err(|_| "self-test not enabled")?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(http::HttpState::new())
        .setup(|app| {
            let watch = watcher::start(app.handle().clone())?;
            app.manage(watch);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_collection,
            load_environment,
            detect_file_kind,
            read_config,
            write_config,
            selftest_config,
            write_selftest_report,
            http::send_request,
            http::cancel_request,
            http::response_body,
            http::response_pretty,
            http::save_response,
            watcher::watch_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
