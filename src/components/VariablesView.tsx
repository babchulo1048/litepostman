import { clearEnvironment, pickEnvironment, setCollectionOverride, setState, useStore } from "../store";
import type { Kv } from "../types";
import KvTable from "./KvTable";
import { CONFIG_DIR } from "../lib/api";

function Section({ title, hint, actions, children }: { title: string; hint?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-1 flex items-center gap-3">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <div className="ml-auto flex gap-2">{actions}</div>
      </div>
      {hint && <p className="mb-3 text-[12px] text-dim">{hint}</p>}
      {children}
    </section>
  );
}

const btn = "rounded border border-line px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg";

export default function VariablesView() {
  const appVars = useStore((s) => s.appVars);
  const env = useStore((s) => s.environment);
  const collections = useStore((s) => s.collections);
  const overrides = useStore((s) => s.collectionOverrides);
  const appKeys = new Set(appVars.filter((v) => v.enabled).map((v) => v.key));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-6">
        <Section
          title="Variables"
          hint={
            <>
              Highest priority. <code className="text-muted">pm.environment.set()</code> writes here too. Saved to <code className="text-muted">{CONFIG_DIR}/variables.json</code>.
            </>
          }
        >
          <KvTable rows={appVars} onChange={(rows: Kv[]) => setState({ appVars: rows })} keyLabel="Variable" valueLabel="Value" />
        </Section>

        <Section
          title={env?.data ? `Environment: ${env.data.name}` : "Environment"}
          hint={env ? <span className="font-mono">{env.path}</span> : "Load a Postman environment JSON export. It's read-only here and reloads when the file changes."}
          actions={
            <>
              <button className={btn} onClick={pickEnvironment}>
                {env ? "Change file…" : "Load environment file…"}
              </button>
              {env && (
                <button className={btn} onClick={clearEnvironment}>
                  Remove
                </button>
              )}
            </>
          }
        >
          {env?.error && <div className="selectable mb-2 rounded bg-[#f97b6d1a] px-3 py-1.5 text-[12px] text-bad">{env.error}</div>}
          {env?.data && <KvTable rows={env.data.values} keyLabel="Variable" note={(r) => (appKeys.has(r.key) ? "overridden" : undefined)} />}
        </Section>

        {collections.map(
          (c) =>
            c.data && (
              <Section key={c.path} title={`Collection: ${c.data.name}`} hint="Lowest priority. From the collection file's variable list.">
                {c.data.variables.length ? (
                  <KvTable rows={c.data.variables} keyLabel="Variable" note={(r) => (overrides[c.path]?.[r.key] !== undefined ? "set by script" : undefined)} />
                ) : (
                  <p className="text-[12px] text-dim">No collection variables.</p>
                )}
                {Object.keys(overrides[c.path] ?? {}).length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 text-[12px] text-muted">
                      Set by <code>pm.collectionVariables.set()</code>
                    </div>
                    <table className="w-full border-collapse text-[12.5px]">
                      <tbody>
                        {Object.entries(overrides[c.path]).map(([k, v]) => (
                          <tr key={k} className="group border-b border-line">
                            <td className="w-1/3 py-1.5">{k}</td>
                            <td className="selectable py-1.5 font-mono text-[12px] break-all">{v}</td>
                            <td className="w-10 text-right">
                              <button className="invisible text-muted group-hover:visible hover:text-bad" onClick={() => setCollectionOverride(c.path, k, null)} title="Clear">
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            ),
        )}
      </div>
    </div>
  );
}
