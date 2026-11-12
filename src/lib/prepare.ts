import type { Auth, Kv, OutBody, Prepared, RequestDef, RequestNode } from "../types";
import { resolve, type Vars } from "./vars";

/** URL bar text: base + enabled params. */
export function composeUrl(url: string, params: Kv[]): string {
  const q = params.filter((p) => p.enabled && p.key).map((p) => (p.value === "" ? p.key : `${p.key}=${p.value}`));
  if (!q.length) return url;
  return url + (url.includes("?") ? "&" : "?") + q.join("&");
}

/** URL bar edit → (base, params). Disabled params are kept, enabled ones come from the text. */
export function splitUrl(text: string, oldParams: Kv[]): { url: string; params: Kv[] } {
  const i = text.indexOf("?");
  if (i < 0) return { url: text, params: oldParams.filter((p) => !p.enabled) };
  const params: Kv[] = text
    .slice(i + 1)
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const j = p.indexOf("=");
      return j < 0 ? { key: p, value: "", enabled: true } : { key: p.slice(0, j), value: p.slice(j + 1), enabled: true };
    });
  return { url: text.slice(0, i), params: [...params, ...oldParams.filter((p) => !p.enabled)] };
}

export function effectiveAuth(def: RequestDef, node: RequestNode): { auth: Auth; source: string } {
  if (def.auth.type === "inherit") return { auth: node.inheritedAuth, source: node.inheritedAuthSource };
  return { auth: def.auth, source: "Request" };
}

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  text: "text/plain",
};

/** Turn a request definition into exactly what gets sent: vars resolved, auth applied. */
export function prepare(def: RequestDef, node: RequestNode, vars: Vars): Prepared {
  const r = (s: string) => resolve(s, vars);
  const warnings: string[] = [];

  // URL: path variables (:id), then {{vars}}, then query params
  let url = def.url;
  for (const pv of def.pathVars) {
    if (!pv.key) continue;
    const esc = pv.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    url = url.replace(new RegExp(`/:${esc}(?=/|$|\\?)`, "g"), "/" + pv.value);
  }
  url = r(composeUrl(url, def.params)).trim();
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;

  const headers: [string, string][] = def.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => [r(h.key).trim(), r(h.value)]);
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

  // Auth (explicit headers win over auth-generated ones, like Postman)
  const { auth } = effectiveAuth(def, node);
  const p = (k: string) => r(auth.params[k] ?? "");
  switch (auth.type) {
    case "noauth":
    case "inherit":
      break;
    case "bearer":
      if (!has("Authorization")) headers.push(["Authorization", `Bearer ${p("token")}`]);
      break;
    case "basic":
      if (!has("Authorization")) headers.push(["Authorization", `Basic ${base64(`${p("username")}:${p("password")}`)}`]);
      break;
    case "apikey": {
      const key = p("key");
      if (key) {
        if (auth.params.in === "query") {
          url += (url.includes("?") ? "&" : "?") + `${encodeURIComponent(key)}=${encodeURIComponent(p("value"))}`;
        } else if (!has(key)) {
          headers.push([key, p("value")]);
        }
      }
      break;
    }
    default:
      warnings.push(`Auth type "${auth.type}" is not supported — sent without auth`);
  }

  // Body
  let body: OutBody = { kind: "none" };
  const b = def.body;
  if (b.mode === "raw" && b.raw !== "") {
    body = { kind: "text", content: r(b.raw) };
    if (!has("Content-Type")) headers.push(["Content-Type", CONTENT_TYPES[b.language] ?? "text/plain"]);
  } else if (b.mode === "urlencoded") {
    const content = b.urlencoded
      .filter((f) => f.enabled && f.key)
      .map((f) => `${encodeURIComponent(r(f.key))}=${encodeURIComponent(r(f.value))}`)
      .join("&");
    body = { kind: "text", content };
    if (!has("Content-Type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  } else if (b.mode === "formdata") {
    body = { kind: "multipart", fields: b.formdata.filter((f) => f.enabled && f.key).map((f) => ({ key: r(f.key), value: r(f.value), file: !!f.file })) };
    // reqwest sets multipart Content-Type with the boundary; a manual one would break it
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === "content-type") headers.splice(i, 1);
  }

  if (!has("Accept")) headers.push(["Accept", "*/*"]);
  if (!has("User-Agent")) headers.push(["User-Agent", "LitePostman/0.1"]);

  return { method: def.method.trim().toUpperCase() || "GET", url, headers, body, warnings };
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export function toCurl(p: Prepared): string {
  const lines = [`curl --location --request ${p.method} ${shq(p.url)}`];
  for (const [k, v] of p.headers) {
    if (k === "User-Agent" && v === "LitePostman/0.1") continue;
    if (k === "Accept" && v === "*/*") continue;
    lines.push(`--header ${shq(`${k}: ${v}`)}`);
  }
  if (p.body.kind === "text") lines.push(`--data-raw ${shq(p.body.content)}`);
  if (p.body.kind === "multipart")
    for (const f of p.body.fields)
      // --form-string: a text value starting with @ or < must not be read as a file
      lines.push(f.file ? `--form ${shq(`${f.key}=@"${f.value}"`)}` : `--form-string ${shq(`${f.key}=${f.value}`)}`);
  return lines.join(" \\\n  ");
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // In objects, a key set to undefined/false counts as absent: { file: false } equals {} (Kv.file)
  const keys = (o: object) => {
    const rec = o as Record<string, unknown>;
    return Array.isArray(o) ? Object.keys(o) : Object.keys(o).filter((k) => rec[k] !== undefined && rec[k] !== false);
  };
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
