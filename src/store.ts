import { useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, baseName, errorText } from "./lib/api";
import { deepEqual } from "./lib/prepare";
import { kvToVars, type Vars } from "./lib/vars";
import type { Collection, Environment, Kv, RequestDef, RequestKey, RequestNode, RunResult, Settings, TreeNode } from "./types";

export type CollectionSlot = { path: string; data?: Collection; error?: string };

export type State = {
  ready: boolean;
  collections: CollectionSlot[];
  environment: { path: string; data?: Environment; error?: string } | null;
  /** Variables panel + pm.environment.set — highest priority */
  appVars: Kv[];
  /** pm.collectionVariables.set, per collection path */
  collectionOverrides: Record<string, Record<string, string>>;
  edits: Record<RequestKey, RequestDef>;
  expanded: Record<string, boolean>;
  selected: RequestKey | null;
  view: "request" | "variables";
  settings: Settings;
  running: Record<RequestKey, boolean>;
  results: Record<RequestKey, RunResult>;
  toast: { text: string; error?: boolean; id: number } | null;
  sidebarWidth: number;
};

let state: State = {
  ready: false,
  collections: [],
  environment: null,
  appVars: [],
  collectionOverrides: {},
  edits: {},
  expanded: {},
  selected: null,
  view: "request",
  settings: { timeoutMs: 30000, insecure: false, followRedirects: true },
  running: {},
  results: {},
  toast: null,
  sidebarWidth: 280,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
  schedulePersist();
}

/** React hook: re-renders only when the selected slice changes (by reference). */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
  );
}

// ---------- persistence ----------

let persisted: Partial<State> = {};
let persistTimer: number | undefined;

function schedulePersist() {
  if (!state.ready) return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, 300);
}

function persist() {
  const s = state;
  if (s.collections !== persisted.collections || s.environment !== persisted.environment || s.expanded !== persisted.expanded || s.selected !== persisted.selected || s.settings !== persisted.settings || s.sidebarWidth !== persisted.sidebarWidth) {
    api.writeConfig(
      "state",
      JSON.stringify(
        {
          collections: s.collections.map((c) => c.path),
          environment: s.environment?.path ?? null,
          expanded: s.expanded,
          selected: s.selected,
          settings: s.settings,
          sidebarWidth: s.sidebarWidth,
        },
        null,
        2,
      ),
    );
  }
  if (s.appVars !== persisted.appVars || s.collectionOverrides !== persisted.collectionOverrides) {
    api.writeConfig("variables", JSON.stringify({ variables: s.appVars, collectionVariables: s.collectionOverrides }, null, 2));
  }
  if (s.edits !== persisted.edits) {
    api.writeConfig("edits", JSON.stringify(s.edits, null, 2));
  }
  persisted = s;
}

async function readJson<T>(name: "state" | "variables" | "edits"): Promise<Partial<T>> {
  try {
    const text = await api.readConfig(name);
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

let started = false;
export async function init() {
  if (started) return; // React StrictMode runs effects twice in dev
  started = true;
  type Saved = { collections: string[]; environment: string | null; expanded: Record<string, boolean>; selected: string | null; settings: Settings; sidebarWidth: number };
  const saved = await readJson<Saved>("state");
  const vars = await readJson<{ variables: Kv[]; collectionVariables: Record<string, Record<string, string>> }>("variables");
  const edits = await readJson<Record<string, RequestDef>>("edits");

  const collections = await Promise.all((saved.collections ?? []).map(loadSlot));
  let environment: State["environment"] = null;
  if (saved.environment) environment = await loadEnvSlot(saved.environment);

  state = {
    ...state,
    collections,
    environment,
    appVars: vars.variables ?? [],
    collectionOverrides: vars.collectionVariables ?? {},
    edits: edits as Record<string, RequestDef>,
    expanded: saved.expanded ?? {},
    selected: saved.selected ?? null,
    settings: { ...state.settings, ...saved.settings },
    sidebarWidth: saved.sidebarWidth ?? 280,
  };
  persisted = state;
  setState({ ready: true });
  syncWatches();
}

// ---------- loading / watching ----------

async function loadSlot(path: string): Promise<CollectionSlot> {
  try {
    const data = await api.loadCollection(path);
    return { path: data.path, data };
  } catch (e) {
    return { path, error: errorText(e) };
  }
}

async function loadEnvSlot(path: string): Promise<NonNullable<State["environment"]>> {
  try {
    const data = await api.loadEnvironment(path);
    return { path: data.path, data };
  } catch (e) {
    return { path, error: errorText(e) };
  }
}

function syncWatches() {
  const paths = state.collections.map((c) => c.path);
  if (state.environment) paths.push(state.environment.path);
  api.watchPaths(paths).catch((e) => toast(`File watching failed: ${errorText(e)}`, true));
}

export async function importPaths(paths: string[]) {
  for (const path of paths) {
    try {
      const kind = await api.detectKind(path);
      if (kind === "environment") {
        const env = await loadEnvSlot(path);
        if (env.error) throw new Error(env.error);
        setState({ environment: env });
        toast(`Environment "${env.data!.name}" loaded`);
      } else {
        const slot = await loadSlot(path);
        if (slot.error) throw new Error(slot.error);
        setState((s) => {
          const exists = s.collections.some((c) => c.path === slot.path);
          return {
            collections: exists ? s.collections.map((c) => (c.path === slot.path ? slot : c)) : [...s.collections, slot],
            expanded: { ...s.expanded, [slot.path]: true },
          };
        });
        toast(`Imported "${slot.data!.name}" (${slot.data!.requestCount} requests)`);
      }
    } catch (e) {
      toast(`${baseName(path)}: ${errorText(e)}`, true);
    }
  }
  syncWatches();
}

export async function pickAndImport() {
  const picked = await open({ multiple: true, filters: [{ name: "Postman JSON", extensions: ["json"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

export async function pickEnvironment() {
  const picked = await open({ multiple: false, filters: [{ name: "Postman environment", extensions: ["json"] }] });
  if (!picked) return;
  const env = await loadEnvSlot(picked as string);
  if (env.error) return toast(env.error, true);
  setState({ environment: env });
  syncWatches();
}

export function clearEnvironment() {
  setState({ environment: null });
  syncWatches();
}

export function removeCollection(path: string) {
  setState((s) => ({ collections: s.collections.filter((c) => c.path !== path) }));
  syncWatches();
}

export async function reloadFile(path: string) {
  const s = getState();
  if (s.environment?.path === path) {
    const env = await loadEnvSlot(path);
    // Keep the last good values on a failed reload
    setState((st) => ({ environment: env.error ? { ...st.environment!, error: env.error } : env }));
  }
  if (s.collections.some((c) => c.path === path)) {
    const slot = await loadSlot(path);
    setState((st) => ({
      collections: st.collections.map((c) => (c.path !== path ? c : slot.error ? { ...c, error: slot.error } : slot)),
    }));
  }
}

// ---------- lookup ----------

export const keyOf = (collectionPath: string, id: string): RequestKey => `${collectionPath}::${id}`;

type Hit = { collection: Collection; node: RequestNode; trail: string[] };
// Cached per parsed collection so lookups return the same object (React needs stable snapshots)
const indexCache = new WeakMap<Collection, Map<string, Hit>>();

function indexOf(c: Collection) {
  let idx = indexCache.get(c);
  if (!idx) {
    idx = new Map();
    const walk = (nodes: TreeNode[], trail: string[]) => {
      for (const n of nodes) {
        if (n.type === "folder") walk(n.children, [...trail, n.name]);
        else idx!.set(n.id, { collection: c, node: n, trail });
      }
    };
    walk(c.items, []);
    indexCache.set(c, idx);
  }
  return idx;
}

export function lookup(s: State, key: RequestKey | null) {
  if (!key) return null;
  const sep = key.indexOf("::");
  const path = key.slice(0, sep);
  const id = key.slice(sep + 2);
  const coll = s.collections.find((c) => c.path === path)?.data;
  if (!coll) return null;
  return indexOf(coll).get(id) ?? null;
}

// ---------- variables ----------

/** All variable layers for one collection, lowest → highest priority. */
export function scopes(s: State, collectionPath: string) {
  const coll = s.collections.find((c) => c.path === collectionPath)?.data;
  const collection: Vars = { ...kvToVars(coll?.variables ?? []), ...(s.collectionOverrides[collectionPath] ?? {}) };
  const environment: Vars = kvToVars(s.environment?.data?.values ?? [], s.appVars);
  return { collection, environment, all: { ...collection, ...environment } };
}

export function setAppVar(key: string, value: string | null) {
  setState((s) => {
    const rest = s.appVars.filter((v) => v.key !== key);
    if (value === null) return { appVars: rest };
    const i = s.appVars.findIndex((v) => v.key === key);
    const row = { key, value, enabled: true };
    if (i < 0) return { appVars: [...s.appVars, row] };
    const next = [...s.appVars];
    next[i] = row;
    return { appVars: next };
  });
}

export function setCollectionOverride(path: string, key: string, value: string | null) {
  setState((s) => {
    const cur = { ...(s.collectionOverrides[path] ?? {}) };
    if (value === null) delete cur[key];
    else cur[key] = value;
    return { collectionOverrides: { ...s.collectionOverrides, [path]: cur } };
  });
}

// ---------- local edits ----------

export function effectiveDef(s: State, key: RequestKey, node: RequestNode): RequestDef {
  return s.edits[key] ?? node.request;
}

export function editRequest(key: RequestKey, node: RequestNode, update: (d: RequestDef) => RequestDef) {
  setState((s) => {
    const next = update(effectiveDef(s, key, node));
    const edits = { ...s.edits };
    // Editing back to the file's version clears the "edited" dot
    if (deepEqual(next, node.request)) delete edits[key];
    else edits[key] = next;
    return { edits };
  });
}

export function resetEdits(key: RequestKey) {
  setState((s) => {
    const edits = { ...s.edits };
    delete edits[key];
    return { edits };
  });
}

// ---------- ui ----------

export function select(key: RequestKey) {
  setState({ selected: key, view: "request" });
}

export function toggleExpanded(id: string) {
  setState((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } }));
}

let toastTimer: number | undefined;
export function toast(text: string, error = false) {
  clearTimeout(toastTimer);
  setState({ toast: { text, error, id: Date.now() } });
  toastTimer = window.setTimeout(() => setState({ toast: null }), error ? 6000 : 2500);
}
