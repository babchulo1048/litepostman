import type { ScriptInput, ScriptOutput } from "./scriptTypes";

const TIMEOUT_MS = 5000;

const empty = (): ScriptOutput => ({ envOps: [], collectionOps: [], headerOps: [], localVars: {}, tests: [], logs: [], errors: [] });

/**
 * Run scripts in a fresh worker. The timeout is enforced from here (the main
 * thread): an infinite loop in a script can only be stopped by terminate().
 */
export function runScripts(input: ScriptInput, signal: AbortSignal): Promise<ScriptOutput> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("../worker/scriptWorker.ts", import.meta.url), { type: "module" });
    const finish = (out: ScriptOutput) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(out);
    };
    const fail = (msg: string) => finish({ ...empty(), errors: [msg], killed: true });
    const timer = setTimeout(() => fail(`${input.phase === "prerequest" ? "Pre-request" : "Test"} scripts timed out after ${TIMEOUT_MS / 1000}s (worker stopped)`), TIMEOUT_MS);
    const onAbort = () => fail("Cancelled");
    signal.addEventListener("abort", onAbort);
    worker.onmessage = (e: MessageEvent<ScriptOutput>) => finish(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      fail(`Script worker error: ${e.message}`);
    };
    worker.postMessage(input);
  });
}
