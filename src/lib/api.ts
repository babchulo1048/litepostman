import { invoke } from "@tauri-apps/api/core";
import type { Collection, Environment, Prepared, PrettyBody, ResponseMeta, Settings } from "../types";

export const api = {
  loadCollection: (path: string) => invoke<Collection>("load_collection", { path }),
  loadEnvironment: (path: string) => invoke<Environment>("load_environment", { path }),
  detectKind: (path: string) => invoke<"collection" | "environment">("detect_file_kind", { path }),
  readConfig: (name: "state" | "variables" | "edits") => invoke<string | null>("read_config", { name }),
  writeConfig: (name: "state" | "variables" | "edits", contents: string) =>
    invoke<void>("write_config", { name, contents }),
  watchPaths: (paths: string[]) => invoke<void>("watch_paths", { paths }),

  send: (id: string, p: Prepared, s: Settings) =>
    invoke<ResponseMeta>("send_request", {
      id,
      request: {
        method: p.method,
        url: p.url,
        headers: p.headers,
        body: p.body,
        timeoutMs: s.timeoutMs,
        insecure: s.insecure,
        followRedirects: s.followRedirects,
      },
    }),
  cancel: (id: string) => invoke<void>("cancel_request", { id }),
  responseBytes: async (id: string) => new Uint8Array(await invoke<ArrayBuffer>("response_body", { id })),
  responseText: async (id: string) => new TextDecoder().decode(await api.responseBytes(id)),
  responsePretty: (id: string) => invoke<PrettyBody>("response_pretty", { id }),
  saveResponse: (id: string, path: string) => invoke<void>("save_response", { id, path }),
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** File name from a Linux (/) or Windows (\) path. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Where read_config/write_config keep files (dirs::config_dir() in Rust). */
export const CONFIG_DIR = navigator.userAgent.includes("Windows") ? "%APPDATA%\\litepostman" : "~/.config/litepostman";
