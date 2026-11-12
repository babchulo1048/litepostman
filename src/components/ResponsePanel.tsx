import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../lib/api";
import { toast, useStore } from "../store";
import { cancel } from "../run";
import type { PrettyBody, RequestKey, RunResult } from "../types";
import CodeEditor from "./CodeEditor";

type Tab = "body" | "headers" | "tests" | "console";

export function statusColor(code: number) {
  if (code >= 200 && code < 300) return "text-ok";
  if (code >= 300 && code < 400) return "text-info";
  return "text-bad";
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function BodyTab({ reqKey, result }: { reqKey: RequestKey; result: RunResult }) {
  const [mode, setMode] = useState<"pretty" | "raw">("pretty");
  const [pretty, setPretty] = useState<PrettyBody | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPretty(null);
    setRaw(null);
    setErr(null);
    api.responsePretty(reqKey).then(setPretty, (e) => setErr(errorText(e)));
  }, [reqKey, result.seq]);

  // Raw text only fetched when needed (Raw mode, or "show raw" for big bodies)
  const needRaw = mode === "raw" || pretty?.tooLarge;
  const [showBig, setShowBig] = useState(false);
  useEffect(() => setShowBig(false), [result.seq]);
  useEffect(() => {
    if (needRaw && raw === null && pretty && !pretty.binary && (!pretty.tooLarge || showBig)) {
      api.responseText(reqKey).then(setRaw, (e) => setErr(errorText(e)));
    }
  }, [needRaw, raw, pretty, reqKey, showBig]);

  const saveToFile = async () => {
    const path = await save({ defaultPath: "response" + (pretty?.language === "json" ? ".json" : pretty?.language === "html" ? ".html" : ".txt") });
    if (!path) return;
    try {
      await api.saveResponse(reqKey, path);
      toast(`Saved to ${path}`);
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  if (err) return <div className="p-4 text-bad">{err}</div>;
  if (!pretty) return <div className="p-4 text-dim">Loading…</div>;
  if (pretty.size === 0) return <div className="p-6 text-center text-dim">Response body is empty</div>;
  if (pretty.binary || (pretty.tooLarge && !showBig)) {
    return (
      <div className="p-6 text-center text-muted">
        <p className="mb-3">{pretty.binary ? `Binary response (${formatSize(pretty.size)})` : `Response is ${formatSize(pretty.size)} — too large to highlight.`}</p>
        <div className="flex justify-center gap-2">
          {!pretty.binary && (
            <button className="rounded border border-line px-3 py-1.5 hover:bg-hover" onClick={() => setShowBig(true)}>
              Show raw
            </button>
          )}
          <button className="rounded border border-line px-3 py-1.5 hover:bg-hover" onClick={saveToFile}>
            Save to file
          </button>
        </div>
      </div>
    );
  }
  const big = pretty.tooLarge;
  const text = big || mode === "raw" ? raw : pretty.text;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-3 text-[12px]">
        {!big &&
          (["pretty", "raw"] as const).map((m) => (
            <button key={m} className={`rounded px-2 py-0.5 capitalize ${mode === m ? "bg-sel text-fg" : "text-muted hover:text-fg"}`} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        {!big && mode === "pretty" && <span className="ml-2 text-dim uppercase">{pretty.language}</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-muted">
          <input type="checkbox" className="accent-accent" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <button className="ml-2 rounded px-2 py-0.5 text-muted hover:bg-hover hover:text-fg" onClick={saveToFile}>
          Save
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {text === null ? (
          <div className="p-4 text-dim">Loading…</div>
        ) : (
          <CodeEditor value={text} readOnly wrap={wrap} language={big || mode === "raw" ? "text" : pretty.language} />
        )}
      </div>
    </div>
  );
}

function HeadersTab({ result }: { result: RunResult }) {
  const m = result.meta!;
  return (
    <div className="p-3">
      <table className="selectable w-full border-collapse text-[12.5px]">
        <tbody>
          {m.headers.map(([k, v], i) => (
            <tr key={i} className="border-b border-line align-top">
              <td className="w-1/3 py-1.5 pr-3 font-medium text-muted">{k}</td>
              <td className="py-1.5 font-mono text-[12px] break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.sent && (
        <div className="mt-4 text-[11.5px] text-dim">
          {m.httpVersion} · final URL <span className="selectable font-mono break-all text-muted">{m.finalUrl}</span>
        </div>
      )}
    </div>
  );
}

function TestsTab({ result }: { result: RunResult }) {
  const [filter, setFilter] = useState<"all" | "pass" | "fail" | "skip">("all");
  const tests = result.tests.filter((t) => filter === "all" || t.status === filter);
  if (!result.tests.length && !result.scriptErrors.length) return <div className="p-6 text-center text-dim">No tests for this request. Add them in the Tests tab with pm.test().</div>;
  return (
    <div className="p-3">
      {result.scriptErrors.map((e, i) => (
        <div key={i} className="selectable mb-2 rounded bg-[#f97b6d1a] px-3 py-1.5 text-[12px] text-bad">
          {e}
        </div>
      ))}
      {result.tests.length > 0 && (
        <div className="mb-2 flex gap-1 text-[12px]">
          {(["all", "pass", "skip", "fail"] as const).map((f) => (
            <button key={f} className={`rounded px-2 py-0.5 capitalize ${filter === f ? "bg-sel text-fg" : "text-muted hover:text-fg"}`} onClick={() => setFilter(f)}>
              {f === "pass" ? "Passed" : f === "fail" ? "Failed" : f === "skip" ? "Skipped" : "All"}
            </button>
          ))}
        </div>
      )}
      {tests.map((t, i) => (
        <div key={i} className="flex items-start gap-3 border-b border-line py-1.5">
          <span
            className={`mt-0.5 w-12 shrink-0 rounded px-1 text-center text-[10.5px] font-bold uppercase ${t.status === "pass" ? "bg-[#6bdd9a22] text-ok" : t.status === "fail" ? "bg-[#f97b6d22] text-bad" : "bg-sel text-muted"}`}
          >
            {t.status}
          </span>
          <div className="selectable min-w-0">
            <div>{t.name}</div>
            {t.error && <div className="font-mono text-[11.5px] text-muted">{t.error}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConsoleTab({ result }: { result: RunResult }) {
  const color = { log: "text-fg", info: "text-info", warn: "text-warn", error: "text-bad" };
  return (
    <div className="selectable p-3 font-mono text-[12px]">
      {result.sent && (
        <div className="mb-2 border-b border-line pb-2 text-muted">
          <span className="font-bold">{result.sent.method}</span> {result.sent.url}
          {result.meta && <span className={`ml-2 ${statusColor(result.meta.status)}`}>{result.meta.status}</span>}
          {result.meta && <span className="ml-2 text-dim">{formatTime(result.meta.timeMs)}</span>}
        </div>
      )}
      {result.logs.length === 0 && result.scriptErrors.length === 0 && <div className="text-dim">No console output.</div>}
      {result.logs.map((l, i) => (
        <div key={i} className={`flex gap-3 border-b border-[#2a2a2a] py-1 ${color[l.level]}`}>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap">{l.text}</pre>
          <span className="shrink-0 text-[11px] text-dim">{l.source}</span>
        </div>
      ))}
      {result.scriptErrors.map((e, i) => (
        <div key={"e" + i} className="border-b border-[#2a2a2a] py-1 text-bad">
          {e}
        </div>
      ))}
    </div>
  );
}

export default function ResponsePanel({ reqKey }: { reqKey: RequestKey }) {
  const result = useStore((s) => s.results[reqKey]);
  const running = useStore((s) => !!s.running[reqKey]);
  const [tab, setTab] = useState<Tab>("body");

  if (running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
        <div>Sending request…</div>
        <button className="rounded border border-line px-3 py-1 hover:bg-hover" onClick={() => cancel(reqKey)}>
          Cancel
        </button>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line px-4 text-[12.5px] text-muted">Response</div>
        <div className="flex flex-1 items-center justify-center text-dim">Click Send to get a response</div>
      </div>
    );
  }

  const m = result.meta;
  const passed = result.tests.filter((t) => t.status === "pass").length;
  const failed = result.tests.some((t) => t.status === "fail");
  const tabs: [Tab, React.ReactNode][] = [
    ["body", "Body"],
    ["headers", <>Headers{m && <sup className="ml-0.5 text-muted">{m.headers.length}</sup>}</>],
    [
      "tests",
      <>
        Test Results
        {result.tests.length > 0 && (
          <span className={`ml-1 ${failed ? "text-bad" : "text-ok"}`}>
            ({passed}/{result.tests.length})
          </span>
        )}
        {result.scriptErrors.length > 0 && <span className="ml-1 text-bad">⚠</span>}
      </>,
    ],
    ["console", <>Console{result.logs.length > 0 && <sup className="ml-0.5 text-muted">{result.logs.length}</sup>}</>],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-1">
        {tabs.map(([t, label]) => (
          <button key={t} className={`relative h-9 px-3 text-[12.5px] ${tab === t ? "text-fg" : "text-muted hover:text-fg"}`} onClick={() => setTab(t)}>
            {label}
            {tab === t && <span className="absolute right-3 bottom-0 left-3 h-[2px] rounded bg-accent" />}
          </button>
        ))}
        {m && (
          <div className="ml-auto flex items-center gap-4 pr-3 text-[12px]">
            <span>
              <span className="text-muted">Status: </span>
              <span className={`font-semibold ${statusColor(m.status)}`}>
                {m.status} {m.statusText}
              </span>
            </span>
            <span>
              <span className="text-muted">Time: </span>
              <span className="text-ok">{formatTime(m.timeMs)}</span>
            </span>
            <span>
              <span className="text-muted">Size: </span>
              <span className="text-ok">{formatSize(m.size)}</span>
            </span>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {result.error && !(tab === "console" || tab === "tests") ? (
          <div className="p-4">
            <div className="selectable rounded border border-[#f97b6d55] bg-[#f97b6d14] px-4 py-3 text-bad">
              <div className="mb-1 font-semibold">Could not send request</div>
              <div className="font-mono text-[12px]">{result.error}</div>
            </div>
            {result.sent && (
              <div className="mt-3 font-mono text-[12px] text-dim">
                {result.sent.method} {result.sent.url}
              </div>
            )}
          </div>
        ) : (
          <>
            {tab === "body" && m && <BodyTab reqKey={reqKey} result={result} />}
            {tab === "headers" && m && <HeadersTab result={result} />}
            {tab === "tests" && <TestsTab result={result} />}
            {tab === "console" && <ConsoleTab result={result} />}
          </>
        )}
      </div>
    </div>
  );
}
