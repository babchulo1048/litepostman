// Script sandbox. Runs Postman pre-request / test scripts with a `pm` shim.
// Runs in a Web Worker: no DOM, no Tauri IPC, killable by the main thread.
// Imported collections are untrusted code — this file must never gain access
// to anything beyond the data passed in the message.

import type { ScriptInput, ScriptOutput } from "../lib/scriptTypes";
import type { LogEntry, TestResult } from "../types";

const g = globalThis as unknown as Record<string, unknown>;

// Remove network/escape hatches before any user code runs.
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker"]) {
  try {
    delete g[name];
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(g, name, { value: undefined, configurable: false, writable: false });
  } catch {
    /* ignore */
  }
}

// ---------- helpers ----------

function fmt(v: unknown): string {
  if (typeof v === "string") return `'${v}'`;
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "[Function]";
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(v);
  }
}

function logText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq((a as never)[k], (b as never)[k]));
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

class AssertionError extends Error {
  name = "AssertionError";
}

class NotSupported extends Error {
  name = "NotSupported";
}

// ---------- pm.expect: a small Chai subset ----------

class Assertion {
  private neg = false;
  private isDeep = false;
  constructor(private obj: unknown) {}

  private check(ok: boolean, msg: string, negMsg: string) {
    if (this.neg ? ok : !ok) throw new AssertionError(this.neg ? negMsg : msg);
    return this;
  }
  private x() {
    return fmt(this.obj);
  }

  // language chains — no-ops that return the same assertion
  get to() { return this; }
  get be() { return this; }
  get been() { return this; }
  get is() { return this; }
  get that() { return this; }
  get which() { return this; }
  get and() { return this; }
  get has() { return this; }
  get have() { return this; }
  get with() { return this; }
  get at() { return this; }
  get of() { return this; }
  get same() { return this; }
  get does() { return this; }
  get not() { this.neg = !this.neg; return this; }
  get deep() { this.isDeep = true; return this; }

  equal(v: unknown) {
    const ok = this.isDeep ? deepEq(this.obj, v) : this.obj === v;
    return this.check(ok, `expected ${this.x()} to equal ${fmt(v)}`, `expected ${this.x()} to not equal ${fmt(v)}`);
  }
  equals(v: unknown) { return this.equal(v); }
  eq(v: unknown) { return this.equal(v); }
  eql(v: unknown) {
    return this.check(deepEq(this.obj, v), `expected ${this.x()} to deeply equal ${fmt(v)}`, `expected ${this.x()} to not deeply equal ${fmt(v)}`);
  }
  get ok() { return this.check(!!this.obj, `expected ${this.x()} to be truthy`, `expected ${this.x()} to be falsy`); }
  get true() { return this.check(this.obj === true, `expected ${this.x()} to be true`, `expected ${this.x()} to not be true`); }
  get false() { return this.check(this.obj === false, `expected ${this.x()} to be false`, `expected ${this.x()} to not be false`); }
  get null() { return this.check(this.obj === null, `expected ${this.x()} to be null`, `expected ${this.x()} to not be null`); }
  get undefined() { return this.check(this.obj === undefined, `expected ${this.x()} to be undefined`, `expected ${this.x()} to not be undefined`); }
  get exist() { return this.check(this.obj != null, `expected ${this.x()} to exist`, `expected ${this.x()} to not exist`); }
  get empty() {
    const o = this.obj;
    const empty = typeof o === "string" || Array.isArray(o) ? o.length === 0 : typeof o === "object" && o ? Object.keys(o).length === 0 : false;
    return this.check(empty, `expected ${this.x()} to be empty`, `expected ${this.x()} not to be empty`);
  }
  a(type: string) {
    const t = typeName(this.obj);
    return this.check(t === type.toLowerCase(), `expected ${this.x()} to be a ${type}`, `expected ${this.x()} not to be a ${type}`);
  }
  an(type: string) { return this.a(type); }
  include(v: unknown) {
    const o = this.obj;
    let ok = false;
    if (typeof o === "string") ok = o.includes(String(v));
    else if (Array.isArray(o)) ok = o.some((e) => (this.isDeep || typeof v === "object" ? deepEq(e, v) : e === v));
    else if (o && typeof o === "object" && v && typeof v === "object") ok = Object.entries(v).every(([k, val]) => deepEq((o as never)[k], val));
    return this.check(ok, `expected ${this.x()} to include ${fmt(v)}`, `expected ${this.x()} to not include ${fmt(v)}`);
  }
  includes(v: unknown) { return this.include(v); }
  contain(v: unknown) { return this.include(v); }
  contains(v: unknown) { return this.include(v); }
  property(name: string, ...value: unknown[]) {
    const o = this.obj as Record<string, unknown> | null;
    const has = o != null && typeof o === "object" && name in o;
    if (value.length === 0) {
      this.check(has, `expected ${this.x()} to have property '${name}'`, `expected ${this.x()} to not have property '${name}'`);
    } else {
      const ok = has && (this.isDeep ? deepEq(o![name], value[0]) : o![name] === value[0]);
      this.check(ok, `expected ${this.x()} to have property '${name}' of ${fmt(value[0])}, but got ${fmt(has ? o![name] : undefined)}`, `expected ${this.x()} to not have property '${name}' of ${fmt(value[0])}`);
    }
    // Chai switches the subject to the property value
    return has && !this.neg ? new Assertion(o![name]) : this;
  }
  status(code: number) {
    const o = this.obj as { code?: number } | null;
    return this.check(o?.code === code, `expected response to have status code ${code} but got ${o?.code}`, `expected response to not have status code ${code}`);
  }
  above(n: number) { return this.check((this.obj as number) > n, `expected ${this.x()} to be above ${n}`, `expected ${this.x()} to be at most ${n}`); }
  gt(n: number) { return this.above(n); }
  greaterThan(n: number) { return this.above(n); }
  below(n: number) { return this.check((this.obj as number) < n, `expected ${this.x()} to be below ${n}`, `expected ${this.x()} to be at least ${n}`); }
  lt(n: number) { return this.below(n); }
  lessThan(n: number) { return this.below(n); }
  least(n: number) { return this.check((this.obj as number) >= n, `expected ${this.x()} to be at least ${n}`, `expected ${this.x()} to be below ${n}`); }
  gte(n: number) { return this.least(n); }
  most(n: number) { return this.check((this.obj as number) <= n, `expected ${this.x()} to be at most ${n}`, `expected ${this.x()} to be above ${n}`); }
  lte(n: number) { return this.most(n); }
  lengthOf(n: number) {
    const len = (this.obj as { length?: number } | null)?.length;
    return this.check(len === n, `expected ${this.x()} to have length ${n} but got ${len}`, `expected ${this.x()} to not have length ${n}`);
  }
  oneOf(list: unknown[]) { return this.check(list.includes(this.obj), `expected ${this.x()} to be one of ${fmt(list)}`, `expected ${this.x()} to not be one of ${fmt(list)}`); }
  match(re: RegExp) { return this.check(re.test(String(this.obj)), `expected ${this.x()} to match ${re}`, `expected ${this.x()} not to match ${re}`); }
}

/** Throws a clear error for anything outside the supported subset. */
function strict<T extends object>(obj: T, prefix: string): T {
  return new Proxy(obj, {
    get(t, p, r) {
      if (typeof p === "symbol" || p in t) return Reflect.get(t, p, r);
      if (p === "then" || p === "toJSON") return undefined;
      throw new NotSupported(`${prefix}.${p} is not supported in LitePostman`);
    },
  });
}

// ---------- run ----------

self.onmessage = async (e: MessageEvent<ScriptInput>) => {
  const input = e.data;
  const out: ScriptOutput = { envOps: [], collectionOps: [], headerOps: [], localVars: {}, tests: [], logs: [], errors: [] };
  const env = { ...input.vars.environment };
  const coll = { ...input.vars.collection };
  const local = out.localVars;
  const isPre = input.phase === "prerequest";

  const lookupVar = (k: string): string | undefined => local[k] ?? env[k] ?? coll[k];
  const replaceIn = (s: string) =>
    String(s).replace(/\{\{([^{}]+)\}\}/g, (m, name: string) => lookupVar(name.trim()) ?? m);

  const scope = (data: Record<string, string>, ops: ScriptOutput["envOps"], name: string) =>
    strict(
      {
        get: (k: string) => data[k],
        set: (k: string, v: unknown) => {
          data[k] = toStr(v);
          ops.push({ op: "set", key: k, value: data[k] });
        },
        unset: (k: string) => {
          delete data[k];
          ops.push({ op: "unset", key: k });
        },
        has: (k: string) => k in data,
        toObject: () => ({ ...data }),
        replaceIn,
      },
      `pm.${name}`,
    );

  // pm.request: read-only view + header changes in pre-request scripts
  const reqHeaders: { key: string; value: string }[] = input.request.headers.map((h) => ({ key: h.key, value: h.value }));
  const findH = (n: string) => reqHeaders.find((h) => h.key.toLowerCase() === n.toLowerCase());
  const headerKv = (h: unknown, v?: unknown) =>
    typeof h === "string" ? (h.includes(":") && v === undefined ? { key: h.split(":")[0].trim(), value: h.slice(h.indexOf(":") + 1).trim() } : { key: h, value: toStr(v ?? "") }) : { key: String((h as { key: string }).key), value: toStr((h as { value: unknown }).value ?? "") };
  const preOnly = (name: string) => {
    if (!isPre) throw new Error(`pm.request.headers.${name}() only works in pre-request scripts`);
  };
  const urlText = input.request.url;
  const request = strict(
    {
      method: input.request.method,
      url: strict(
        {
          toString: () => urlText,
          getHost: () => urlText.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0],
          getPath: () => "/" + urlText.replace(/^[a-z]+:\/\//i, "").split("?")[0].split("/").slice(1).join("/"),
          getQueryString: () => urlText.split("?")[1] ?? "",
        },
        "pm.request.url",
      ),
      headers: strict(
        {
          get: (n: string) => findH(n)?.value,
          has: (n: string) => !!findH(n),
          all: () => reqHeaders.map((h) => ({ ...h })),
          toObject: () => Object.fromEntries(reqHeaders.map((h) => [h.key, h.value])),
          each: (fn: (h: { key: string; value: string }) => void) => reqHeaders.forEach((h) => fn({ ...h })),
          add: (h: unknown, v?: unknown) => {
            preOnly("add");
            const kv = headerKv(h, v);
            reqHeaders.push(kv);
            out.headerOps.push({ op: "add", ...kv });
          },
          upsert: (h: unknown, v?: unknown) => {
            preOnly("upsert");
            const kv = headerKv(h, v);
            const ex = findH(kv.key);
            if (ex) ex.value = kv.value;
            else reqHeaders.push(kv);
            out.headerOps.push({ op: "upsert", ...kv });
          },
          remove: (n: string) => {
            preOnly("remove");
            const i = reqHeaders.findIndex((h) => h.key.toLowerCase() === n.toLowerCase());
            if (i >= 0) reqHeaders.splice(i, 1);
            out.headerOps.push({ op: "remove", key: n, value: "" });
          },
        },
        "pm.request.headers",
      ),
      body: strict(
        {
          mode: input.request.body.mode,
          raw: input.request.body.raw,
          urlencoded: input.request.body.urlencoded,
          formdata: input.request.body.formdata,
          toString: () => (input.request.body.mode === "raw" ? input.request.body.raw : ""),
        },
        "pm.request.body",
      ),
    },
    "pm.request",
  );

  // pm.response (tests only)
  let response: object | undefined;
  const res = input.response;
  if (res) {
    const findRH = (n: string) => res.headers.find(([k]) => k.toLowerCase() === n.toLowerCase());
    let parsed: unknown;
    let parsedOk = false;
    const json = () => {
      if (!parsedOk) {
        try {
          parsed = JSON.parse(res.body);
          parsedOk = true;
        } catch (err) {
          throw new Error(`pm.response.json(): response body is not valid JSON (${(err as Error).message})`);
        }
      }
      return parsed;
    };
    const assertStatus = (code: number) => {
      if (res.code !== code) throw new AssertionError(`expected response to have status code ${code} but got ${res.code}`);
    };
    const r = {
      code: res.code,
      status: res.status,
      responseTime: res.responseTime,
      responseSize: res.size,
      headers: strict(
        {
          get: (n: string) => findRH(n)?.[1],
          has: (n: string) => !!findRH(n),
          all: () => res.headers.map(([key, value]) => ({ key, value })),
          toObject: () => Object.fromEntries(res.headers),
          each: (fn: (h: { key: string; value: string }) => void) => res.headers.forEach(([key, value]) => fn({ key, value })),
        },
        "pm.response.headers",
      ),
      json,
      text: () => res.body,
      to: strict(
        {
          have: strict(
            {
              status: assertStatus,
              header: (n: string, v?: string) => {
                const h = findRH(n);
                if (!h) throw new AssertionError(`expected response to have header '${n}'`);
                if (v !== undefined && h[1] !== v) throw new AssertionError(`expected header '${n}' to be '${v}' but got '${h[1]}'`);
              },
            },
            "pm.response.to.have",
          ),
          be: strict(
            {
              get ok() {
                if (res.code < 200 || res.code > 299) throw new AssertionError(`expected response to be ok (2xx) but got ${res.code}`);
                return true;
              },
              get success() {
                if (res.code < 200 || res.code > 299) throw new AssertionError(`expected response to be successful (2xx) but got ${res.code}`);
                return true;
              },
              get json() {
                json();
                return true;
              },
            },
            "pm.response.to.be",
          ),
        },
        "pm.response.to",
      ),
    };
    response = strict(r, "pm.response");
  }

  let source = "";
  const pending: Promise<void>[] = [];
  const pushResult = (name: string) => {
    const result: TestResult = { name, status: "pass" };
    out.tests.push(result);
    return result;
  };
  const test = Object.assign(
    (name: string, fn: () => unknown) => {
      const result = pushResult(String(name));
      try {
        const ret = fn();
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          pending.push(
            (ret as Promise<unknown>).then(
              () => undefined,
              (err) => {
                result.status = "fail";
                result.error = (err as Error)?.message ?? String(err);
              },
            ),
          );
        }
      } catch (err) {
        result.status = "fail";
        result.error = (err as Error)?.message ?? String(err);
      }
    },
    { skip: (name: string) => (pushResult(String(name)).status = "skip") },
  );

  const pm = strict(
    {
      environment: scope(env, out.envOps, "environment"),
      collectionVariables: scope(coll, out.collectionOps, "collectionVariables"),
      variables: strict(
        {
          get: lookupVar,
          set: (k: string, v: unknown) => (local[k] = toStr(v)),
          has: (k: string) => lookupVar(k) !== undefined,
          replaceIn,
          toObject: () => ({ ...coll, ...env, ...local }),
        },
        "pm.variables",
      ),
      request,
      get response() {
        if (!response) throw new Error("pm.response is only available in test scripts");
        return response;
      },
      info: { eventName: isPre ? "prerequest" : "test", requestName: input.info.requestName, requestId: input.info.requestId, iteration: 0, iterationCount: 1 },
      test,
      expect: (v: unknown) => new Assertion(v),
    },
    "pm",
  );

  const consoleShim: Record<string, (...a: unknown[]) => void> = {};
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    consoleShim[level] = (...args: unknown[]) =>
      out.logs.push({ level: level === "debug" ? "log" : level, source, text: args.map(logText).join(" ") } as LogEntry);
  }

  // Legacy `postman.*` helpers that are just variable access
  const postman = strict(
    {
      setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v),
      getEnvironmentVariable: (k: string) => pm.environment.get(k),
      clearEnvironmentVariable: (k: string) => pm.environment.unset(k),
    },
    "postman",
  );

  // Track timers so async scripts (setTimeout) finish before we report back
  let timers = 0;
  let wake: (() => void) | null = null;
  const realSetTimeout = setTimeout;
  const sandboxSetTimeout = (fn: () => void, ms?: number) => {
    timers++;
    return realSetTimeout(() => {
      timers--;
      try {
        fn();
      } catch (err) {
        out.errors.push(`${source}: ${(err as Error)?.message ?? err}`);
      }
      if (timers === 0) wake?.();
    }, ms);
  };
  const requireShim = (name: string) => {
    throw new NotSupported(`require('${name}') is not supported in LitePostman`);
  };

  for (const script of input.scripts) {
    source = script.source;
    const legacyTests: Record<string, unknown> = {};
    try {
      const fn = new Function("pm", "postman", "console", "tests", "require", "setTimeout", "self", "globalThis", script.code);
      fn(pm, postman, consoleShim, legacyTests, requireShim, sandboxSetTimeout, undefined, undefined);
    } catch (err) {
      const e = err as Error;
      out.errors.push(`${source} ${isPre ? "pre-request" : "test"} script: ${e?.name === "NotSupported" ? "" : (e?.name ?? "Error") + ": "}${e?.message ?? e}`);
    }
    for (const [name, passed] of Object.entries(legacyTests)) {
      out.tests.push({ name, status: passed ? "pass" : "fail" });
    }
    if (timers > 0) await new Promise<void>((r) => (wake = r));
    await Promise.all(pending.splice(0));
  }

  (self as unknown as Worker).postMessage(out);
};
