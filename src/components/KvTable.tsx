import { open } from "@tauri-apps/plugin-dialog";
import { baseName } from "../lib/api";
import type { Kv } from "../types";

type Props = {
  rows: Kv[];
  onChange?: (rows: Kv[]) => void;
  keyLabel?: string;
  valueLabel?: string;
  /** optional per-row note shown dimmed on the right (e.g. "overridden") */
  note?: (row: Kv) => string | undefined;
  /** form-data: each row can be Text or File */
  allowFiles?: boolean;
};

const cell = "h-[30px] w-full bg-transparent px-2 text-[12.5px] text-fg placeholder:text-dim focus:bg-raised";

/** Postman-style key/value table: checkbox, key, value, delete; always one blank row for adding. */
export default function KvTable({ rows, onChange, keyLabel = "Key", valueLabel = "Value", note, allowFiles }: Props) {
  const readOnly = !onChange;
  const shown = readOnly ? rows : [...rows, { key: "", value: "", enabled: true }];

  const update = (i: number, patch: Partial<Kv>) => {
    if (!onChange) return;
    const next = rows.map((r) => ({ ...r }));
    if (i === rows.length) next.push({ key: "", value: "", enabled: true, ...patch });
    else next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange?.(rows.filter((_, j) => j !== i));
  const pickFile = async (i: number) => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") update(i, { value: picked, file: true });
  };

  return (
    <table className="w-full table-fixed border-collapse border border-line text-left">
      <thead>
        <tr className="text-[11.5px] text-muted">
          <th className="w-8 border border-line" />
          <th className="border border-line px-2 py-1.5 font-medium">{keyLabel}</th>
          <th className="border border-line px-2 py-1.5 font-medium">{valueLabel}</th>
          {(!readOnly || note) && <th className="w-24 border border-line" />}
        </tr>
      </thead>
      <tbody>
        {shown.map((row, i) => {
          const isNew = !readOnly && i === rows.length;
          const n = note?.(row);
          return (
            <tr key={i} className={`group ${row.enabled || isNew ? "" : "opacity-50"}`}>
              <td className="border border-line text-center">
                {!isNew && (
                  <input
                    type="checkbox"
                    className="accent-accent align-middle"
                    checked={row.enabled}
                    disabled={readOnly}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                  />
                )}
              </td>
              <td className="border border-line p-0">
                <div className="flex items-center">
                  <input
                    className={cell}
                    value={row.key}
                    readOnly={readOnly}
                    placeholder={isNew ? keyLabel : ""}
                    spellCheck={false}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                  {allowFiles && !readOnly && (
                    <select
                      className="mr-1 shrink-0 cursor-pointer appearance-none rounded bg-transparent px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
                      title="Field type"
                      value={row.file ? "file" : "text"}
                      onChange={(e) => update(i, { file: e.target.value === "file", value: "" })}
                    >
                      <option value="text">Text</option>
                      <option value="file">File</option>
                    </select>
                  )}
                </div>
              </td>
              <td className="border border-line p-0">
                {row.file ? (
                  <div className="flex h-[30px] items-center gap-2 px-2 text-[12.5px]">
                    {row.value ? (
                      <span className="min-w-0 truncate" title={row.value}>
                        📄 {baseName(row.value)}
                      </span>
                    ) : (
                      <span className="text-dim">No file selected</span>
                    )}
                    {!readOnly && (
                      <button className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg" onClick={() => pickFile(i)}>
                        {row.value ? "Change" : "Select file"}
                      </button>
                    )}
                  </div>
                ) : (
                  <input
                    className={`${cell} font-mono`}
                    value={row.value}
                    readOnly={readOnly}
                    placeholder={isNew ? valueLabel : ""}
                    spellCheck={false}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                )}
              </td>
              {(!readOnly || note) && (
                <td className="border border-line px-2 text-right text-[11px] text-dim">
                  {n && <span className="mr-2">{n}</span>}
                  {!readOnly && !isNew && (
                    <button className="invisible text-muted hover:text-bad group-hover:visible" title="Delete" onClick={() => remove(i)}>
                      ✕
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
