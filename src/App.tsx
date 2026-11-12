import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getState, importPaths, init, pickAndImport, reloadFile, setState, useStore } from "./store";
import { cancel, send } from "./run";
import Sidebar from "./components/Sidebar";
import RequestPanel from "./components/RequestPanel";
import ResponsePanel from "./components/ResponsePanel";
import VariablesView from "./components/VariablesView";

/** Drag handle; reports the pointer delta while dragging. */
function Splitter({ dir, onDrag }: { dir: "x" | "y"; onDrag: (delta: number) => void }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    let last = dir === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = dir === "x" ? ev.clientX : ev.clientY;
      onDrag(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = dir === "x" ? "col-resize" : "row-resize";
  };
  return dir === "x" ? (
    <div className="-mx-[3px] w-[6px] shrink-0 cursor-col-resize hover:bg-accent/40 z-10" onPointerDown={start} />
  ) : (
    <div className="-my-[3px] h-[6px] shrink-0 cursor-row-resize hover:bg-accent/40 z-10" onPointerDown={start} />
  );
}

function SettingsMenu({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const set = (p: Partial<typeof settings>) => setState((s) => ({ settings: { ...s.settings, ...p } }));
  return (
    <div className="absolute top-9 right-2 z-30 w-72 rounded border border-line bg-raised p-3 shadow-xl" onMouseLeave={onClose}>
      <label className="mb-3 flex items-center justify-between">
        <span>Request timeout (s)</span>
        <input
          type="number"
          min={1}
          className="w-20 rounded border border-line bg-panel px-2 py-1 text-right"
          value={settings.timeoutMs / 1000}
          onChange={(e) => set({ timeoutMs: Math.max(1, Number(e.target.value) || 30) * 1000 })}
        />
      </label>
      <label className="mb-3 flex cursor-pointer items-center justify-between">
        <span>SSL certificate verification</span>
        <input type="checkbox" className="accent-accent" checked={!settings.insecure} onChange={(e) => set({ insecure: !e.target.checked })} />
      </label>
      <label className="flex cursor-pointer items-center justify-between">
        <span>Follow redirects (max 10)</span>
        <input type="checkbox" className="accent-accent" checked={settings.followRedirects} onChange={(e) => set({ followRedirects: e.target.checked })} />
      </label>
    </div>
  );
}

function Header() {
  const view = useStore((s) => s.view);
  const env = useStore((s) => s.environment);
  const insecure = useStore((s) => s.settings.insecure);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <div className="flex items-center gap-2 pr-3">
        <span className="h-4 w-4 rounded-full bg-accent" />
        <span className="font-semibold">LitePostman</span>
      </div>
      <button className="rounded px-2.5 py-1 text-muted hover:bg-hover hover:text-fg" onClick={pickAndImport} title="Import collection or environment (Ctrl+O)">
        Import
      </button>
      <div className="ml-auto flex items-center gap-1">
        {insecure && <span className="mr-2 text-[11.5px] text-warn" title="SSL verification is off">SSL off</span>}
        <button
          className={`flex items-center gap-2 rounded border px-2.5 py-1 ${view === "variables" ? "border-accent text-fg" : "border-line text-muted hover:text-fg"}`}
          onClick={() => setState((s) => ({ view: s.view === "variables" ? "request" : "variables" }))}
          title="Variables & environment"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${env?.data ? (env.error ? "bg-bad" : "bg-ok") : "bg-dim"}`} />
          {env?.data ? env.data.name : "No environment"}
          <span className="text-dim">·</span>
          Variables
        </button>
        <button className="rounded px-2 py-1 text-[15px] text-muted hover:bg-hover hover:text-fg" title="Settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          ⚙
        </button>
      </div>
      {settingsOpen && <SettingsMenu onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

function Main() {
  const view = useStore((s) => s.view);
  const selected = useStore((s) => s.selected);
  const [split, setSplit] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);

  if (view === "variables") return <VariablesView />;
  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <div className="text-[15px]">Select a request from the sidebar</div>
        <div className="text-[12px] text-dim">Ctrl+Enter send · Esc cancel · Ctrl+O import · Ctrl+L focus URL</div>
      </div>
    );
  }
  return (
    <div ref={box} className="flex h-full min-h-0 flex-col">
      <div className="min-h-[150px]" style={{ flex: `${split} 1 0` }}>
        <RequestPanel key={selected} reqKey={selected} />
      </div>
      <div className="border-t border-line" />
      <Splitter dir="y" onDrag={(d) => setSplit((s) => Math.min(0.85, Math.max(0.15, s + d / (box.current?.clientHeight || 600))))} />
      <div className="min-h-[120px]" style={{ flex: `${1 - split} 1 0` }}>
        <ResponsePanel key={selected} reqKey={selected} />
      </div>
    </div>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const toastMsg = useStore((s) => s.toast);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    init();
    // No-op unless LITEPOSTMAN_SELFTEST is set (see README)
    import("./selftest").then((m) => m.runSelfTest());
    const unFile = listen<string>("file-changed", (e) => reloadFile(e.payload));
    const unDrop = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        const json = p.paths.filter((x) => x.toLowerCase().endsWith(".json"));
        if (json.length) importPaths(json);
      }
    });

    // Capture phase so these win over CodeMirror's own bindings
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (s.selected && s.view === "request") send(s.selected);
      } else if (e.key === "Escape" && s.selected && s.running[s.selected]) {
        e.preventDefault();
        cancel(s.selected);
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pickAndImport();
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setState({ view: "request" });
        setTimeout(() => (document.querySelector("[data-url-input]") as HTMLInputElement | null)?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      unFile.then((f) => f());
      unDrop.then((f) => f());
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  if (!ready) return <div className="h-full bg-base" />;

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Splitter dir="x" onDrag={(d) => setState((s) => ({ sidebarWidth: Math.min(600, Math.max(180, s.sidebarWidth + d)) }))} />
        <main className="min-w-0 flex-1">
          <Main />
        </main>
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-black/50 text-[15px]">
          Drop Postman collection or environment JSON
        </div>
      )}
      {toastMsg && (
        <div
          key={toastMsg.id}
          className={`selectable fixed bottom-4 left-1/2 z-50 max-w-[70%] -translate-x-1/2 rounded border px-4 py-2 shadow-xl ${toastMsg.error ? "border-[#f97b6d66] bg-[#3a2220] text-bad" : "border-line bg-raised text-fg"}`}
        >
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
