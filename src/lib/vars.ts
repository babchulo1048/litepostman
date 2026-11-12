import type { Kv } from "../types";

export type Vars = Record<string, string>;

/** Enabled entries → object. Later lists override earlier ones. */
export function kvToVars(...lists: Kv[][]): Vars {
  const out: Vars = {};
  for (const list of lists) for (const kv of list) if (kv.enabled && kv.key) out[kv.key] = kv.value;
  return out;
}

const VAR_RE = /\{\{([^{}]+)\}\}/g;

function uuid(): string {
  return crypto.randomUUID();
}

/** Postman's built-in dynamic variables (the common ones). */
function dynamic(name: string): string | undefined {
  switch (name) {
    case "$guid":
    case "$randomUUID":
      return uuid();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$randomInt":
      return String(Math.floor(Math.random() * 1001));
  }
  return undefined;
}

/** Replace {{var}} using vars; unknown vars are left as-is. Nested refs resolve up to 5 levels. */
export function resolve(text: string, vars: Vars): string {
  let out = text;
  for (let i = 0; i < 5 && out.includes("{{"); i++) {
    const next = out.replace(VAR_RE, (m, raw: string) => {
      const name = raw.trim();
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      return dynamic(name) ?? m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

export function unresolvedIn(texts: string[], vars: Vars): string[] {
  const missing = new Set<string>();
  for (const t of texts) {
    for (const m of resolve(t, vars).matchAll(VAR_RE)) missing.add(m[1].trim());
  }
  return [...missing];
}
