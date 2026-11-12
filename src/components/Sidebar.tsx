import { memo, useState } from "react";
import { keyOf, pickAndImport, reloadFile, removeCollection, select, toggleExpanded, useStore, type CollectionSlot } from "../store";
import type { TreeNode } from "../types";
import { baseName } from "../lib/api";

// Postman's dark-theme method colors
export const METHOD_COLORS: Record<string, string> = {
  GET: "#6bdd9a",
  POST: "#ffe47e",
  PUT: "#74aef6",
  PATCH: "#c0a8e1",
  DELETE: "#f79a8e",
  HEAD: "#6bdd9a",
  OPTIONS: "#f15eb0",
};

export function methodColor(m: string) {
  return METHOD_COLORS[m.toUpperCase()] ?? "#a6a6a6";
}

function badgeText(m: string) {
  const u = m.toUpperCase();
  return u === "DELETE" ? "DEL" : u === "OPTIONS" ? "OPT" : u;
}

const INDENT = 14;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 text-muted">
      <path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

const Node = memo(function Node({ node, path, depth }: { node: TreeNode; path: string; depth: number }) {
  const key = keyOf(path, node.id);
  const open = useStore((s) => !!s.expanded[key]);
  const selected = useStore((s) => s.selected === key);
  const edited = useStore((s) => node.type === "request" && !!s.edits[key]);
  const method = useStore((s) => (node.type === "request" ? (s.edits[key]?.method ?? node.request.method) : ""));
  const pad = { paddingLeft: 8 + depth * INDENT };

  if (node.type === "folder") {
    return (
      <>
        <div className="flex h-7 cursor-pointer items-center gap-1.5 pr-2 hover:bg-hover" style={pad} onClick={() => toggleExpanded(key)}>
          <Chevron open={open} />
          <FolderIcon />
          <span className="truncate text-fg">{node.name}</span>
        </div>
        {open && node.children.map((c) => <Node key={c.id} node={c} path={path} depth={depth + 1} />)}
      </>
    );
  }
  return (
    <div
      className={`flex h-7 cursor-pointer items-center gap-1.5 pr-2 ${selected ? "bg-sel" : "hover:bg-hover"}`}
      style={{ paddingLeft: 8 + depth * INDENT + 16 }}
      onClick={() => select(key)}
      title={node.name}
    >
      <span className="w-[34px] shrink-0 text-right text-[10px] font-bold tracking-tight" style={{ color: methodColor(method) }}>
        {badgeText(method)}
      </span>
      <span className={`truncate ${selected ? "text-white" : "text-fg"}`}>{node.name}</span>
      {edited && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Edited locally" />}
    </div>
  );
});

function CollectionRow({ slot }: { slot: CollectionSlot }) {
  const open = useStore((s) => !!s.expanded[slot.path]);
  const [menu, setMenu] = useState(false);
  const name = slot.data?.name ?? baseName(slot.path);
  return (
    <div>
      <div className="group relative flex h-8 cursor-pointer items-center gap-1.5 pr-1 pl-2 hover:bg-hover" onClick={() => toggleExpanded(slot.path)} title={slot.path}>
        <Chevron open={open} />
        <span className="truncate font-medium text-fg">{name}</span>
        {slot.error && (
          <span className="shrink-0 text-bad" title={slot.error}>
            ⚠
          </span>
        )}
        <button
          className="ml-auto rounded px-1.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-fg"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
        >
          ⋯
        </button>
        {menu && (
          <div className="absolute top-7 right-1 z-20 w-36 rounded border border-line bg-raised py-1 shadow-lg" onMouseLeave={() => setMenu(false)} onClick={(e) => e.stopPropagation()}>
            <button className="block w-full px-3 py-1.5 text-left hover:bg-sel" onClick={() => (setMenu(false), reloadFile(slot.path))}>
              Reload
            </button>
            <button className="block w-full px-3 py-1.5 text-left text-bad hover:bg-sel" onClick={() => (setMenu(false), removeCollection(slot.path))}>
              Remove
            </button>
          </div>
        )}
      </div>
      {slot.error && open && <div className="selectable mx-2 mb-1 rounded bg-[#f97b6d1a] px-2 py-1 text-[11.5px] text-bad">{slot.error}</div>}
      {open && slot.data?.items.map((n) => <Node key={n.id} node={n} path={slot.path} depth={1} />)}
    </div>
  );
}

export default function Sidebar() {
  const collections = useStore((s) => s.collections);
  const width = useStore((s) => s.sidebarWidth);
  return (
    <aside className="flex shrink-0 flex-col border-r border-line bg-base" style={{ width }}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[12px] font-semibold tracking-wide text-muted uppercase">Collections</span>
        <button className="rounded px-1.5 text-[16px] leading-none text-muted hover:bg-sel hover:text-fg" title="Import (Ctrl+O)" onClick={pickAndImport}>
          +
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {collections.length === 0 && (
          <div className="px-4 py-8 text-center text-muted">
            <p className="mb-3">No collections yet.</p>
            <button className="rounded border border-line px-3 py-1.5 hover:bg-hover" onClick={pickAndImport}>
              Import collection
            </button>
            <p className="mt-3 text-[11.5px] text-dim">or drop a Postman JSON file anywhere</p>
          </div>
        )}
        {collections.map((c) => (
          <CollectionRow key={c.path} slot={c} />
        ))}
      </div>
    </aside>
  );
}
