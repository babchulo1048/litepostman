# LitePostman

Personal offline Postman replacement. Tauri 2 (Rust) + React. See `CLAUDE.md` for the full plan.

## Run

```bash
npm install
npm run tauri dev          # dev app with hot reload
npm run tauri build -- --bundles deb   # → src-tauri/target/release/bundle/deb/*.deb
```

## Windows build

Built on GitHub's Windows machines by `.github/workflows/build.yml` (same as LiteView):
GitHub → **Actions** → **Build installers** → **Run workflow** (or push a tag like `v0.1.0`).
Download the `LitePostman-nsis` artifact → `LitePostman_0.1.0_x64-setup.exe`.

- WebView2 is preinstalled on Windows 10/11 — nothing else needed.
- The installer is unsigned: SmartScreen shows "Windows protected your PC" → **More info → Run anyway**.
- App data on Windows: `%APPDATA%\litepostman\` (Linux: `~/.config/litepostman/`).

## Try it with the samples

```bash
node samples/server.mjs    # local test API on http://localhost:4567
```

Then Import (or drag & drop) `samples/collection.json` and `samples/environment.json`.
Run **Auth → Login** first: its test script stores `token`, which the Users folder's inherited bearer auth uses.

## Shortcuts

| Key | Action |
|---|---|
| Ctrl+Enter | Send |
| Esc | Cancel running request |
| Ctrl+O | Import collection / environment |
| Ctrl+L | Focus URL bar |

## Where things live

- `src-tauri/src/collection.rs` — Postman v2.1 parser (URL normalize, auth inheritance, script chain)
- `src-tauri/src/http.rs` — reqwest send / cancel / body store / pretty-print
- `src-tauri/src/watcher.rs` — parent-dir watch, 150ms debounce, `file-changed` event
- `src/lib/prepare.ts` — vars + auth + body → outgoing request; Copy as cURL
- `src/run.ts` — send flow (pre-request → send → tests → persist vars)
- `src/worker/scriptWorker.ts` — script sandbox + `pm` shim
- `~/.config/litepostman/` (Windows: `%APPDATA%\litepostman\`) — `state.json` (imported paths, tree, settings), `variables.json`, `edits.json`

## Tests

```bash
cd src-tauri && cargo test     # parser tests (incl. samples/collection.json)
```

End-to-end self-test (runs every request in the loaded collections through the real app and writes a report):

```bash
node samples/server.mjs &
LITEPOSTMAN_SELFTEST=/tmp/report.json npm run tauri dev
```
