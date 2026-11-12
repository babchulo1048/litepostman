// Mirrors the Rust types in src-tauri/src/collection.rs and http.rs

/** `file`: form-data only — `value` is the path of a file to upload. */
export type Kv = { key: string; value: string; enabled: boolean; file?: boolean };

export type Auth = { type: string; params: Record<string, string> };

export type BodyMode = "none" | "raw" | "urlencoded" | "formdata";

export type Body = {
  mode: BodyMode;
  raw: string;
  language: string;
  urlencoded: Kv[];
  formdata: Kv[];
};

export type RequestDef = {
  method: string;
  url: string;
  params: Kv[];
  pathVars: Kv[];
  headers: Kv[];
  body: Body;
  auth: Auth;
  preRequest: string;
  test: string;
};

export type ScriptLayer = { source: string; preRequest: string; test: string };

export type FolderNode = { type: "folder"; id: string; name: string; children: TreeNode[] };

export type RequestNode = {
  type: "request";
  id: string;
  name: string;
  request: RequestDef;
  inheritedAuth: Auth;
  inheritedAuthSource: string;
  inheritedScripts: ScriptLayer[];
};

export type TreeNode = FolderNode | RequestNode;

export type Collection = {
  path: string;
  name: string;
  variables: Kv[];
  items: TreeNode[];
  requestCount: number;
};

export type Environment = { path: string; name: string; values: Kv[] };

export type OutBody =
  | { kind: "none" }
  | { kind: "text"; content: string }
  | { kind: "multipart"; fields: { key: string; value: string; file: boolean }[] };

export type Prepared = {
  method: string;
  url: string;
  headers: [string, string][];
  body: OutBody;
  warnings: string[];
};

export type ResponseMeta = {
  status: number;
  statusText: string;
  headers: [string, string][];
  timeMs: number;
  size: number;
  finalUrl: string;
  httpVersion: string;
};

export type PrettyBody = {
  text: string;
  language: string;
  tooLarge: boolean;
  binary: boolean;
  size: number;
};

export type Settings = { timeoutMs: number; insecure: boolean; followRedirects: boolean };

export type TestResult = { name: string; status: "pass" | "fail" | "skip"; error?: string };

export type LogEntry = { level: "log" | "info" | "warn" | "error"; source: string; text: string };

export type RunResult = {
  meta?: ResponseMeta;
  error?: string;
  tests: TestResult[];
  logs: LogEntry[];
  scriptErrors: string[];
  sent?: Prepared;
  /** bumps on every send so the body view knows to refetch */
  seq: number;
};

/** "collectionPath::requestId" */
export type RequestKey = string;
