// The send flow:
// pre-request scripts → apply script changes → resolve vars + auth → Rust sends
// → test scripts → persist script-set variables → show results.

import { api, errorText } from "./lib/api";
import { composeUrl, prepare, toCurl } from "./lib/prepare";
import { runScripts } from "./lib/scripts";
import type { ScriptInput, ScriptOutput } from "./lib/scriptTypes";
import { effectiveDef, getState, lookup, scopes, setAppVar, setCollectionOverride, setState, toast } from "./store";
import type { RequestDef, RequestKey, RunResult } from "./types";

const controllers = new Map<RequestKey, AbortController>();
let seq = 0;

function applyVarOps(out: ScriptOutput, collectionPath: string) {
  for (const op of out.envOps) setAppVar(op.key, op.op === "set" ? op.value ?? "" : null);
  for (const op of out.collectionOps) setCollectionOverride(collectionPath, op.key, op.op === "set" ? op.value ?? "" : null);
}

function applyHeaderOps(def: RequestDef, out: ScriptOutput): RequestDef {
  if (!out.headerOps.length) return def;
  const headers = def.headers.map((h) => ({ ...h }));
  for (const op of out.headerOps) {
    const i = headers.findIndex((h) => h.enabled && h.key.toLowerCase() === op.key.toLowerCase());
    if (op.op === "remove") {
      if (i >= 0) headers.splice(i, 1);
    } else if (op.op === "upsert" && i >= 0) {
      headers[i].value = op.value;
    } else {
      headers.push({ key: op.key, value: op.value, enabled: true });
    }
  }
  return { ...def, headers };
}

export async function send(key: RequestKey) {
  const s = getState();
  const hit = lookup(s, key);
  if (!hit || s.running[key]) return;
  const { collection, node } = hit;
  const path = collection.path;
  let def = effectiveDef(s, key, node);

  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  setState((st) => ({ running: { ...st.running, [key]: true } }));

  const result: RunResult = { tests: [], logs: [], scriptErrors: [], seq: ++seq };
  const collect = (out: ScriptOutput) => {
    result.tests.push(...out.tests);
    result.logs.push(...out.logs);
    result.scriptErrors.push(...out.errors);
  };
  const scriptInput = (d: RequestDef): Omit<ScriptInput, "phase" | "scripts"> => {
    const sc = scopes(getState(), path);
    return {
      vars: { collection: sc.collection, environment: sc.environment },
      request: { method: d.method, url: composeUrl(d.url, d.params), headers: d.headers.filter((h) => h.enabled), body: d.body },
      info: { requestName: node.name, requestId: node.id },
    };
  };

  try {
    // 1. Pre-request scripts: collection → folders → request
    const pre = [...node.inheritedScripts.map((l) => ({ source: l.source, code: l.preRequest })), { source: node.name, code: def.preRequest }].filter((x) => x.code.trim());
    let localVars: Record<string, string> = {};
    if (pre.length) {
      const out = await runScripts({ phase: "prerequest", scripts: pre, ...scriptInput(def) }, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error("Request cancelled");
      collect(out);
      // A runaway pre-request script means its variable/header changes never
      // happened — don't send a half-prepared request.
      if (out.killed) throw new Error(out.errors[0]);
      applyVarOps(out, path);
      localVars = out.localVars;
      def = applyHeaderOps(def, out);
    }

    // 2. Resolve with the (possibly script-updated) variables and send
    const vars = { ...scopes(getState(), path).all, ...localVars };
    const prepared = prepare(def, node, vars);
    result.sent = prepared;
    result.scriptErrors.push(...prepared.warnings);
    try {
      result.meta = await api.send(key, prepared, getState().settings);
    } catch (e) {
      result.error = errorText(e);
    }

    // 3. Test scripts
    const tests = [...node.inheritedScripts.map((l) => ({ source: l.source, code: l.test })), { source: node.name, code: def.test }].filter((x) => x.code.trim());
    if (result.meta && tests.length && !ctrl.signal.aborted) {
      const m = result.meta;
      const body = await api.responseText(key);
      const out = await runScripts(
        {
          phase: "test",
          scripts: tests,
          ...scriptInput(def),
          response: { code: m.status, status: m.statusText, headers: m.headers, body, responseTime: Math.round(m.timeMs), size: m.size },
        },
        ctrl.signal,
      );
      collect(out);
      applyVarOps(out, path);
    }
  } catch (e) {
    result.error = errorText(e);
  } finally {
    controllers.delete(key);
    setState((st) => ({ running: { ...st.running, [key]: false }, results: { ...st.results, [key]: result } }));
  }
}

export function cancel(key: RequestKey) {
  controllers.get(key)?.abort();
  api.cancel(key);
}

export function preparedFor(key: RequestKey) {
  const s = getState();
  const hit = lookup(s, key);
  if (!hit) return null;
  return prepare(effectiveDef(s, key, hit.node), hit.node, scopes(s, hit.collection.path).all);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for webviews without async clipboard permission
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export async function copyCurl(key: RequestKey) {
  const p = preparedFor(key);
  if (!p) return;
  await copyText(toCurl(p));
  toast("Copied as cURL");
}
