import type { Body, Kv, LogEntry, TestResult } from "../types";

export type ScriptInput = {
  phase: "prerequest" | "test";
  scripts: { source: string; code: string }[];
  vars: { collection: Record<string, string>; environment: Record<string, string> };
  request: { method: string; url: string; headers: Kv[]; body: Body };
  response?: { code: number; status: string; headers: [string, string][]; body: string; responseTime: number; size: number };
  info: { requestName: string; requestId: string };
};

export type VarOp = { op: "set" | "unset"; key: string; value?: string };
export type HeaderOp = { op: "add" | "upsert" | "remove"; key: string; value: string };

export type ScriptOutput = {
  envOps: VarOp[];
  collectionOps: VarOp[];
  headerOps: HeaderOp[];
  localVars: Record<string, string>;
  tests: TestResult[];
  logs: LogEntry[];
  errors: string[];
  /** worker was killed (timeout or cancel) */
  killed?: boolean;
};
