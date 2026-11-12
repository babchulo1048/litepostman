//! Hot-reload: watch the *parent directories* of the collection/environment
//! files (editors save atomically: write temp file → rename, which a
//! file-level watch would lose). Events are filtered to our files, debounced
//! 150ms, then emitted to the frontend as `file-changed` with the path.

use notify::event::{AccessKind, AccessMode, ModifyKind};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(150);

pub struct WatchState {
    watcher: Mutex<RecommendedWatcher>,
    files: Arc<Mutex<HashSet<PathBuf>>>,
    dirs: Mutex<HashSet<PathBuf>>,
}

/// Only real content changes. Our own reads produce Access(Open/Read) events —
/// reacting to those would cause an endless reload loop.
fn is_write(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Modify(_) => true,
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        _ => false,
    }
}

/// Absolute, symlink-free path. `dunce` returns `C:\x\y.json` on Windows
/// instead of std's `\\?\C:\...`, which wouldn't match the paths the
/// file watcher reports.
pub fn canonical(p: &str) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
}

pub fn start(app: AppHandle) -> Result<WatchState, String> {
    let files: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;

    let files_for_thread = files.clone();
    // A plain OS thread that receives raw events and does the debouncing.
    // `move` gives the closure ownership of rx/app/files_for_thread.
    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut deadline: Option<Instant> = None;
        loop {
            let wait = match deadline {
                Some(d) => d.saturating_duration_since(Instant::now()),
                None => Duration::from_secs(3600),
            };
            match rx.recv_timeout(wait) {
                Ok(Ok(event)) => {
                    if !is_write(&event.kind) {
                        continue;
                    }
                    let watched = files_for_thread.lock().unwrap();
                    for p in event.paths {
                        if watched.contains(&p) {
                            pending.insert(p);
                            deadline = Some(Instant::now() + DEBOUNCE);
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    for p in pending.drain() {
                        let _ = app.emit("file-changed", p.to_string_lossy().to_string());
                    }
                    deadline = None;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(WatchState { watcher: Mutex::new(watcher), files, dirs: Mutex::new(HashSet::new()) })
}

/// Replace the set of watched files.
#[tauri::command]
pub fn watch_paths(state: tauri::State<'_, WatchState>, paths: Vec<String>) -> Result<(), String> {
    let files: HashSet<PathBuf> = paths.iter().map(|p| canonical(p)).collect();
    let new_dirs: HashSet<PathBuf> = files.iter().filter_map(|f| f.parent().map(Path::to_path_buf)).collect();

    let mut watcher = state.watcher.lock().unwrap();
    let mut dirs = state.dirs.lock().unwrap();
    for d in dirs.difference(&new_dirs) {
        let _ = watcher.unwatch(d);
    }
    for d in new_dirs.difference(&dirs) {
        watcher.watch(d, RecursiveMode::NonRecursive).map_err(|e| format!("Cannot watch {}: {e}", d.display()))?;
    }
    *dirs = new_dirs;
    *state.files.lock().unwrap() = files;
    Ok(())
}
