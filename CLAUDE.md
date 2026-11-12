# LitePostman — Lightweight API Client (personal tool)

## What Is This
My own lightweight Postman. Offline-first, no account, no cloud. Import Postman JSON collections and environments, manage variables, run requests with pre-request/test scripts, read responses. The collection file on disk is the source of truth — edit it in VS Code, the app reloads.

This is **not a product**. It's my daily tool and my first real Tauri/Rust project. Decisions favor "works for Eyoel" over "works for everyone." (If it ever goes public on GitHub, rename it — "Postman" is a trademark.)

## About Me (the developer)
- Eyoel — backend-focused full-stack dev (Node.js, NestJS, React, PostgreSQL, Prisma) at Atlas Computer Technology, Addis Ababa
- **Limited Rust** — explain Rust concepts (ownership, borrowing, async/tokio, serde, `Result`/`?`) briefly when they first appear; prefer simple, readable Rust over clever Rust
- Wants it built fast — Claude writes the code, I review and test
- Uses Postman daily at work; this replaces it for me
- Sibling project: LiteView (`/home/eyoel/my_projects/file_viewer/`) — same stack, currently shelved

## Environment (verified 2026-10-30)
- OS: Linux Mint 22.2 (Ubuntu 24.04 base)
- Rust: cargo 1.91.1 · Node: v22 · webkit2gtk-4.1: 2.52 (installed)

## How to Work With Me
- **Goal: working app in one day.** Go through the Build Phases back to back, no waiting between them
- Build and run after each phase; fix what breaks, then move on immediately
- Only stop to ask me when genuinely blocked
- Don't add features outside the MVP list without asking
- Short explanations, direct answers

## Why Build This
- **Postman** — ~500MB, 300MB+ RAM, needs internet just to load local collections, 90% of features unused, no file-watching (delete + re-import on every change)
- **Bruno** — right philosophy (file-based, offline) but UI feels amateur
- **Yaak** — closest to what I want, but needs a paid license for work use
- **Mine** — Postman's look and the Postman features I actually use, nothing else, file-watching built in

## Step Zero (one evening)
Open Yaak and Postman side by side and note layout decisions to copy. Then start building.

## Stack
- **Runtime:** Tauri 2.0 (Rust backend + WebKitGTK webview on Linux)
- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **HTTP:** reqwest (Rust-side, `cookie_store` feature) — never webview fetch (CORS, forbidden headers, no TLS control)
- **File watching:** notify crate — watch the parent directory, not the file (VS Code atomic saves = Remove + Create)
- **Code display/edit:** CodeMirror 6 — only `@codemirror/view` + `@codemirror/state` + `@codemirror/lang-json` / `lang-javascript` (+ xml/html as needed), never the `codemirror` meta-package
- **Scripts:** run in a **Web Worker** inside the webview with a `pm` shim (JS engine for free, isolated from the UI, killable on timeout). Rust embedding (rquickjs/boa) only if the worker approach fails.
- **Storage:** filesystem only — no DB, no cloud, no accounts
- **Target:** Linux (Ubuntu, webkit2gtk-4.1) for me; Windows build (NSIS `.exe`, WebView2) for a friend, built by GitHub Actions — same setup as LiteView

## MVP Features (in order)
1. **Import Postman Collection v2.1** — drag & drop or file picker; remembers imported paths across launches
2. **Collection tree sidebar** — folders, nested requests, expandable, colored method badges
3. **Variables** — resolve `{{var}}` in URL, headers, params, body. Sources, lowest to highest priority:
   - collection `variable` array
   - imported Postman **environment** JSON file (watched for changes)
   - **Variables panel** — add / edit / delete key-values in the UI, Postman-style table with enable checkbox
   - values set by scripts (`pm.environment.set`, etc.)
   App-owned values (panel + script-set) persist to `~/.config/litepostman/variables.json`. One active environment in v1, no switcher.
4. **Auth inheritance** — `auth` block (bearer, basic, apikey) at collection → folder → request, resolved to headers. `noauth` breaks inheritance. No OAuth flows.
5. **Request panel with local edits** — method, URL, headers, params, body (raw + urlencoded + form-data with file upload). Never written back to the collection file. Edits keyed by request path, survive reloads, edited requests show a dot, "Reset to file" discards.
6. **Send via Rust** — status, headers, body, timing, size; timeout (default 30s) + Cancel button
7. **Scripts (Postman-compatible subset)** — runs the `event` blocks already in imported collections, plus editable in the request panel (Pre-request / Tests tabs):
   - Order: collection → folder → request, pre-request before send, tests after response
   - `pm.environment.get/set/unset`, `pm.collectionVariables.get/set`, `pm.variables.get`
   - `pm.request` — read url/headers/body; `pm.request.headers.add/upsert` in pre-request
   - `pm.response.code`, `.status`, `.headers.get()`, `.json()`, `.text()`, `.responseTime`
   - `pm.test(name, fn)` + a small `pm.expect` (`to.equal`, `to.eql`, `to.have.status`, `to.have.property`, `to.be.ok`, `to.include`) — not full Chai
   - `console.log` → Console tab
   - Unsupported `pm.*` calls show a clear "not supported" error instead of silently passing
   - Script timeout 5s, worker terminated on timeout
   - Script edits made in the app are local edits (same rule as #5), not written to the file
8. **Copy as cURL** — resolved request (vars + auth applied)
9. **Response viewer** — highlighted body (JSON/XML/HTML), headers tab, raw tab, **Test Results** tab (pass/fail list), **Console** tab. Pretty-print in Rust (`serde_json`), cap ~2MB with "show raw / save to file"
10. **File watcher hot-reload** — collection + environment files; debounced 150ms, retry on mid-write parse failure, preserve tree state, selection, and local edits

## Explicitly NOT Building (v1)
- Environment switcher / multiple environments / globals
- `pm.sendRequest`, `pm.require`, `pm.cookies`, `pm.visualizer`, `postman.setNextRequest`
- Collection runner (run whole folder in sequence)
- Collection editor (add/rename/reorder requests) — edit the JSON file
- Writing to the collection or environment file
- OAuth, SSE/WebSockets, CLI, sync, macOS

## Performance Targets (honest)
- Installer (.deb): <10MB
- RAM idle: <100MB (WebKitGTK alone is 50–80MB)
- Launch: <1s
- 200-request collection sidebar: <500ms

## Architecture
```
┌────────────────────────────────────────────────┐
│                 React Frontend                 │
│  Sidebar tree │ Request panel (edits, scripts) │
│  Variables    │ Response (body/tests/console)  │
│        Web Worker: script sandbox (pm shim)    │
└───────────┬────────────────────────┬───────────┘
            │ Tauri IPC (raw bytes for bodies)   │
┌───────────┴────────────────────────┴───────────┐
│                  Rust Backend                  │
│  Collection model: parse, normalize, vars, auth│
│  reqwest: send, timing, cookies, redirects     │
│  notify: dir watch, debounce, reload           │
│  serde_json: pretty-print; variables.json I/O  │
└────────────────────────────────────────────────┘
```

Send flow: resolve vars → run pre-request scripts (worker) → apply script changes → resolve vars again → Rust sends → run test scripts (worker) → persist script-set variables → show results.

## Postman v2.1 — real-world parsing rules
Build the parser against 3–4 real exported collections, not the spec.
- `url` may be a string or object (`{ raw, host[], path[], query[] }`) — normalize both
- `header` may be missing; entries may have `disabled: true`
- `query` params may have `disabled`
- `body.mode`: `raw` (check `options.raw.language`), `urlencoded`, `formdata` (file fields: `type: "file"`, path in `src` — string, array or null; relative = next to the collection file)
- `auth` inherits downward; `noauth` breaks it
- `event[]`: `listen: "prerequest" | "test"`, `script.exec` is an **array of lines** — join with `\n`
- `item` is recursive: `item[]` = folder, `request` = request
- Environment file: `{ name, values: [{ key, value, enabled }] }`

## Gotchas
- **Atomic saves:** watch parent dir; expect Remove+Create or Rename
- **Mid-write parse failure:** retry 2–3 times before showing an error
- **IPC size:** use `tauri::ipc::Response` for raw bodies, not 10MB strings
- **Large JSON:** pretty-print in Rust, not JS
- **WebKitGTK ≠ Chrome:** test on the real box
- **Redirects:** follow up to 10, show final URL
- **Self-signed certs:** toggle `danger_accept_invalid_certs`
- **Script sandbox:** worker has no DOM and no Tauri access — keep it that way; scripts from imported collections are untrusted code
- **Infinite loops in scripts:** only `worker.terminate()` stops them — enforce the timeout from the main thread
- **Rust compile time:** first build 3–5 min, incremental 10–30s

## UI Rule
Don't design from scratch. Copy Postman/Yaak layout decisions — spacing, tree indentation, method badge colors, tab structure, status-code colors. Polish is 40–50% of total effort.

## Build Phases (one day, back to back)
1. **Scaffold** — Tauri 2 + React + Vite + TS + Tailwind, app window opens
2. **Collection model + sidebar** — import file, parse, tree renders
3. **Send** — request panel, reqwest send, response panel with CM6, timeout/cancel
4. **Variables + auth** — collection/environment/panel/persistence, auth inheritance
5. **File watcher** — hot-reload with state + local edits preserved, Copy as cURL
6. **Scripts** — worker + `pm` shim, tests, Test Results + Console tabs
7. **Finish** — drag & drop, shortcuts, test against a real exported collection, build `.deb`

**Minimum to call today a win:** phases 1–5 (import, send, variables, auth, auto-reload). Phase 6 (scripts) is the most likely to spill over — if it does, finish it the next day. UI polish toward full Postman quality comes after.

## Kill Conditions
- Postman format inconsistencies eat more than a week → switch to my own simple format + one-time Postman converter
- WebKitGTK can't render smoothly → stop (no Electron fallback)
- Web Worker script approach can't support the `pm` subset → try rquickjs in Rust, or drop scripts to phase 2

## Focus Rule
LitePostman and LiteView are both Tauri. Doing both at once means shipping neither. **LiteView is shelved while this is active.**
