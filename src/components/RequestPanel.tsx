import { useEffect, useMemo, useRef, useState } from "react";
import { editRequest, effectiveDef, getState, lookup, resetEdits, scopes, useStore } from "../store";
import { cancel, copyCurl, send } from "../run";
import { composeUrl, effectiveAuth, prepare, splitUrl } from "../lib/prepare";
import { resolve, unresolvedIn } from "../lib/vars";
import type { Body, BodyMode, RequestDef, RequestKey, RequestNode } from "../types";
import KvTable from "./KvTable";
import CodeEditor from "./CodeEditor";
import { methodColor } from "./Sidebar";

/** "Bearer abcdef…" — enough to recognise the token without showing it all */
function mask(v: string) {
  const [scheme, ...rest] = v.split(" ");
  const secret = rest.join(" ");
  return secret.length > 8 ? `${scheme} ${secret.slice(0, 6)}…` : v;
}

const CARET = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5' fill='none' stroke='%23a6a6a6' stroke-width='1.4'/%3E%3C/svg%3E")`;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type Tab = "params" | "auth" | "headers" | "body" | "pre" | "tests";

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`relative h-9 px-3 text-[12.5px] ${active ? "text-fg" : "text-muted hover:text-fg"}`}
      onClick={onClick}
    >
      {children}
      {active && <span className="absolute right-3 bottom-0 left-3 h-[2px] rounded bg-accent" />}
    </button>
  );
}

function Count({ n, color = "text-ok" }: { n: number; color?: string }) {
  return n ? <sup className={`ml-0.5 ${color}`}>{n}</sup> : null;
}

/** URL bar keeps its own text while typing, so "?a=" isn't rewritten under the cursor. */
function UrlInput({ def, onChange, inputRef }: { def: RequestDef; onChange: (url: string, params: RequestDef["params"]) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const composed = composeUrl(def.url, def.params);
  const [text, setText] = useState(composed);
  useEffect(() => {
    const parsed = splitUrl(text, def.params);
    if (composeUrl(parsed.url, parsed.params) !== composed) setText(composed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed]);
  return (
    <input
      ref={inputRef}
      data-url-input
      className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[12.5px] text-fg placeholder:text-dim"
      value={text}
      spellCheck={false}
      placeholder="Enter URL or paste text"
      onChange={(e) => {
        setText(e.target.value);
        const p = splitUrl(e.target.value, def.params);
        onChange(p.url, p.params);
      }}
    />
  );
}

function AuthView({ def, node, vars }: { def: RequestDef; node: RequestNode; vars: Record<string, string> }) {
  const { auth, source } = effectiveAuth(def, node);
  const inherited = def.auth.type === "inherit";
  const label: Record<string, string> = { noauth: "No Auth", bearer: "Bearer Token", basic: "Basic Auth", apikey: "API Key" };
  const rows = Object.entries(auth.params);
  return (
    <div className="max-w-2xl space-y-4 p-4">
      <div className="flex items-baseline gap-3">
        <span className="w-20 text-muted">Type</span>
        <span className="font-medium">{inherited ? "Inherit auth from parent" : (label[def.auth.type] ?? def.auth.type)}</span>
      </div>
      {inherited && (
        <div className="rounded border border-line bg-panel px-3 py-2 text-muted">
          Using <b className="text-fg">{label[auth.type] ?? auth.type}</b> from <b className="text-fg">{source}</b>
          {auth.type === "noauth" && " — no auth header is sent"}
        </div>
      )}
      {!label[auth.type] && auth.type !== "inherit" && (
        <div className="rounded border border-[#ffc65c55] bg-[#ffc65c14] px-3 py-2 text-warn">Auth type "{auth.type}" is not supported in v1 — the request is sent without auth.</div>
      )}
      {auth.type !== "noauth" && label[auth.type] && rows.length > 0 && (
        <table className="w-full border-collapse">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b border-line">
                <td className="w-28 py-1.5 text-muted">{k}</td>
                <td className="selectable py-1.5 font-mono text-[12px] break-all">
                  {k === "password" ? "•".repeat(Math.min(v.length, 12)) : v}
                  {v.includes("{{") && k !== "password" && <div className="text-[11px] text-dim">→ {resolve(v, vars)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11.5px] text-dim">Auth comes from the collection file (collection → folder → request). Edit it there.</p>
    </div>
  );
}

const BODY_MODES: [BodyMode, string][] = [
  ["none", "none"],
  ["formdata", "form-data"],
  ["urlencoded", "x-www-form-urlencoded"],
  ["raw", "raw"],
];
const LANGS: [string, string][] = [
  ["text", "Text"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["html", "HTML"],
  ["xml", "XML"],
];

function BodyView({ body, onChange }: { body: Body; onChange: (b: Body) => void }) {
  const beautify = () => {
    try {
      onChange({ ...body, raw: JSON.stringify(JSON.parse(body.raw), null, 2) });
    } catch {
      /* not valid JSON (e.g. has {{vars}} outside strings) — leave as is */
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 px-4 text-[12.5px]">
        {BODY_MODES.map(([m, label]) => (
          <label key={m} className="flex cursor-pointer items-center gap-1.5 text-muted">
            <input type="radio" className="accent-accent" checked={body.mode === m} onChange={() => onChange({ ...body, mode: m })} />
            <span className={body.mode === m ? "text-fg" : ""}>{label}</span>
          </label>
        ))}
        {body.mode === "raw" && (
          <>
            <select
              className="cursor-pointer appearance-none rounded bg-transparent px-1.5 py-0.5 text-info hover:bg-hover"
              value={body.language}
              onChange={(e) => onChange({ ...body, language: e.target.value })}
            >
              {LANGS.map(([v, l]) => (
                <option key={v} value={v} className="bg-raised text-fg">
                  {l}
                </option>
              ))}
            </select>
            {body.language === "json" && (
              <button className="ml-auto text-muted hover:text-fg" onClick={beautify}>
                Beautify
              </button>
            )}
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {body.mode === "none" && <div className="p-6 text-center text-dim">This request does not have a body</div>}
        {body.mode === "raw" && <CodeEditor value={body.raw} language={body.language} onChange={(raw) => onChange({ ...body, raw })} />}
        {body.mode === "urlencoded" && (
          <div className="px-4 pb-4">
            <KvTable rows={body.urlencoded} onChange={(urlencoded) => onChange({ ...body, urlencoded })} />
          </div>
        )}
        {body.mode === "formdata" && (
          <div className="px-4 pb-4">
            <KvTable rows={body.formdata} allowFiles onChange={(formdata) => onChange({ ...body, formdata })} />
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptView({ code, onChange, node, phase }: { code: string; onChange: (c: string) => void; node: RequestNode; phase: "preRequest" | "test" }) {
  const inherited = node.inheritedScripts.filter((l) => l[phase].trim());
  return (
    <div className="flex h-full min-h-0 flex-col">
      {inherited.length > 0 && (
        <div className="shrink-0 border-b border-line px-4 py-1.5 text-[11.5px] text-dim">
          Also runs first (from file): {inherited.map((l) => `${l.source} (${l[phase].split("\n").length} lines)`).join(" → ")}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor value={code} language="javascript" onChange={onChange} />
      </div>
    </div>
  );
}

/** Every text that gets {{vars}} resolved on send — feeds the "Unresolved" warning. */
export function usedTexts(def: RequestDef, node: RequestNode): string[] {
  const kv = (rows: RequestDef["headers"]) => rows.filter((r) => r.enabled).flatMap((r) => [r.key, r.value]);
  const b = def.body;
  return [
    composeUrl(def.url, def.params),
    ...def.pathVars.map((p) => p.value),
    ...kv(def.headers),
    ...(b.mode === "raw" ? [b.raw] : b.mode === "urlencoded" ? kv(b.urlencoded) : b.mode === "formdata" ? kv(b.formdata) : []),
    ...Object.values(effectiveAuth(def, node).auth.params),
  ];
}

export default function RequestPanel({ reqKey }: { reqKey: RequestKey }) {
  const hit = useStore((s) => lookup(s, reqKey));
  const def = useStore((s) => (hit ? effectiveDef(s, reqKey, hit.node) : null));
  const edited = useStore((s) => !!s.edits[reqKey]);
  const running = useStore((s) => !!s.running[reqKey]);
  const collections = useStore((s) => s.collections);
  const environment = useStore((s) => s.environment);
  const appVars = useStore((s) => s.appVars);
  const overrides = useStore((s) => s.collectionOverrides);
  const [tab, setTab] = useState<Tab>("params");
  const urlRef = useRef<HTMLInputElement>(null);

  const vars = useMemo(
    () => (hit ? scopes(getState(), hit.collection.path).all : {}),
    [hit, collections, environment, appVars, overrides],
  );

  if (!hit || !def) {
    return <div className="flex h-full items-center justify-center text-muted">This request is no longer in the collection file.</div>;
  }
  const { node, trail, collection } = hit;
  const edit = (f: (d: RequestDef) => RequestDef) => editRequest(reqKey, node, f);
  const prepared = prepare(def, node, vars);
  const userHeaderCount = def.headers.filter((h) => h.enabled && h.key).length;
  const autoHeaders = prepared.headers.slice(userHeaderCount);
  const missing = unresolvedIn(usedTexts(def, node), vars);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* breadcrumb */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="truncate text-muted">{[collection.name, ...trail].join(" / ")} /</span>
        <span className="truncate font-medium">{node.name}</span>
        {edited && (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Edited locally" />
            <button className="ml-1 shrink-0 rounded px-2 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-fg" onClick={() => resetEdits(reqKey)} title="Discard local edits">
              Reset to file
            </button>
          </>
        )}
        <button className="ml-auto shrink-0 rounded px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg" onClick={() => copyCurl(reqKey)} title="Copy as cURL">
          {"</>"} cURL
        </button>
      </div>

      {/* URL row */}
      <div className="flex shrink-0 gap-2 px-4 pt-3">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded border border-line bg-panel focus-within:border-[#555]">
          <select
            className="h-full w-[104px] shrink-0 cursor-pointer appearance-none border-r border-line bg-transparent bg-[length:10px] bg-[right_10px_center] bg-no-repeat pl-3 text-[12.5px] font-semibold"
            style={{ color: methodColor(def.method), backgroundImage: CARET }}
            value={METHODS.includes(def.method) ? def.method : "GET"}
            onChange={(e) => edit((d) => ({ ...d, method: e.target.value }))}
          >
            {METHODS.map((m) => (
              <option key={m} value={m} style={{ color: methodColor(m) }} className="bg-raised">
                {m}
              </option>
            ))}
          </select>
          <UrlInput def={def} inputRef={urlRef} onChange={(url, params) => edit((d) => ({ ...d, url, params }))} />
        </div>
        {running ? (
          <button className="h-9 w-24 shrink-0 rounded bg-raised font-semibold text-fg hover:bg-sel" onClick={() => cancel(reqKey)}>
            Cancel
          </button>
        ) : (
          <button className="h-9 w-24 shrink-0 rounded bg-send font-semibold text-white hover:bg-[#0a6fd6]" onClick={() => send(reqKey)} title="Send (Ctrl+Enter)">
            Send
          </button>
        )}
      </div>
      <div className="selectable h-5 shrink-0 truncate px-4 pt-1 font-mono text-[11px] text-dim" title={prepared.url}>
        {missing.length > 0 ? <span className="text-warn">Unresolved: {missing.map((m) => `{{${m}}}`).join(", ")}</span> : prepared.url !== composeUrl(def.url, def.params) ? `→ ${prepared.url}` : ""}
      </div>

      {/* tabs */}
      <div className="flex shrink-0 items-center border-b border-line px-1">
        <TabButton active={tab === "params"} onClick={() => setTab("params")}>
          Params<Count n={def.params.filter((p) => p.enabled).length} />
        </TabButton>
        <TabButton active={tab === "auth"} onClick={() => setTab("auth")}>
          Authorization
        </TabButton>
        <TabButton active={tab === "headers"} onClick={() => setTab("headers")}>
          Headers<Count n={prepared.headers.length} color="text-muted" />
        </TabButton>
        <TabButton active={tab === "body"} onClick={() => setTab("body")}>
          Body{def.body.mode !== "none" && <span className="ml-1 text-ok">•</span>}
        </TabButton>
        <TabButton active={tab === "pre"} onClick={() => setTab("pre")}>
          Pre-request Script{def.preRequest.trim() && <span className="ml-1 text-ok">•</span>}
        </TabButton>
        <TabButton active={tab === "tests"} onClick={() => setTab("tests")}>
          Tests{def.test.trim() && <span className="ml-1 text-ok">•</span>}
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "params" && (
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-2 text-[12px] text-muted">Query Params</div>
              <KvTable rows={def.params} onChange={(params) => edit((d) => ({ ...d, params }))} />
            </div>
            {def.pathVars.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] text-muted">Path Variables</div>
                <KvTable rows={def.pathVars} onChange={(pathVars) => edit((d) => ({ ...d, pathVars }))} />
              </div>
            )}
          </div>
        )}
        {tab === "auth" && <AuthView def={def} node={node} vars={vars} />}
        {tab === "headers" && (
          <div className="space-y-4 p-4">
            <KvTable rows={def.headers} onChange={(headers) => edit((d) => ({ ...d, headers }))} />
            {autoHeaders.length > 0 && (
              <div>
                <div className="mb-1.5 text-[12px] text-muted">Added on send (auth, body, defaults)</div>
                <div className="selectable space-y-0.5 font-mono text-[12px] text-dim">
                  {autoHeaders.map(([k, v], i) => (
                    <div key={i} className="truncate">
                      <span className="text-muted">{k}:</span> {k === "Authorization" ? mask(v) : v}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "body" && <BodyView body={def.body} onChange={(body) => edit((d) => ({ ...d, body }))} />}
        {tab === "pre" && <ScriptView node={node} phase="preRequest" code={def.preRequest} onChange={(preRequest) => edit((d) => ({ ...d, preRequest }))} />}
        {tab === "tests" && <ScriptView node={node} phase="test" code={def.test} onChange={(test) => edit((d) => ({ ...d, test }))} />}
      </div>
    </div>
  );
}
