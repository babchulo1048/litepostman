// Dev-only: runs every request in the repo's sample collections (samples/*.json,
// local test server only) through the real send pipeline and writes a JSON report.
// Other imported collections are never run: they may point at real servers. Enabled by LITEPOSTMAN_SELFTEST=<report path>.
import { invoke } from "@tauri-apps/api/core";
import { cancel, preparedFor, send } from "./run";
import { editRequest, getState, keyOf, lookup, select, setState } from "./store";
import { toCurl } from "./lib/prepare";
import type { TreeNode } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let started = false;

export async function runSelfTest() {
  if (started) return; // StrictMode runs effects twice in dev
  started = true;
  const cfg = await invoke<[string, string] | null>("selftest_config");
  if (!cfg) return;
  const [, show] = cfg;
  while (!getState().ready) await sleep(50);
  const report: unknown[] = [];
  let showKey: string | null = null;

  const isSample = (p: string) => /[\\/]samples[\\/][^\\/]+\.json$/.test(p);
  for (const slot of getState().collections.filter((c) => isSample(c.path))) {
    const walk = async (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "folder") {
          await walk(n.children);
          continue;
        }
        const key = keyOf(slot.path, n.id);
        if (n.name === show) showKey = key;
        if (n.name.startsWith("Timeout")) continue;
        select(key);
        const started = performance.now();
        const p = send(key);
        if (n.name.startsWith("Slow")) {
          await sleep(800);
          cancel(key);
        }
        await p;
        const r = getState().results[key];
        report.push({
          name: n.id,
          ms: Math.round(performance.now() - started),
          status: r?.meta?.status,
          error: r?.error,
          tests: r?.tests,
          scriptErrors: r?.scriptErrors,
          logs: r?.logs.map((l) => `${l.source}: ${l.text}`),
          sentHeaders: r?.sent?.headers,
          url: r?.sent?.url,
          curl: n.name === "Raw JSON" ? toCurl(preparedFor(key)!) : undefined,
        });
      }
    };
    if (slot.data) await walk(slot.data.items);
  }
  const s = getState();
  report.push({ appVars: s.appVars, collectionOverrides: s.collectionOverrides });
  await invoke("write_selftest_report", { contents: JSON.stringify(report, null, 2) });
  if (showKey) {
    select(showKey);
    const hit = lookup(getState(), showKey);
    if (hit) editRequest(showKey, hit.node, (d) => ({ ...d, params: [...d.params, { key: "edited", value: "1", enabled: true }] }));
  }
  if (show === "__variables") setState({ view: "variables" });
}
