import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";

// Postman-like dark highlighting
const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "#9cdcfe" },
  { tag: [t.string, t.special(t.string)], color: "#ce9178" },
  { tag: [t.number, t.bool, t.null], color: "#b5cea8" },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: "#c586c0" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#dcdcaa" },
  { tag: [t.variableName], color: "#9cdcfe" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [t.tagName], color: "#569cd6" },
  { tag: [t.attributeName], color: "#9cdcfe" },
  { tag: [t.attributeValue], color: "#ce9178" },
  { tag: [t.angleBracket, t.bracket, t.punctuation], color: "#a6a6a6" },
  { tag: t.invalid, color: "#f97b6d" },
]);

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#e8e8e8" },
    ".cm-content": { caretColor: "#ffffff", padding: "4px 0" },
    ".cm-gutters": { backgroundColor: "transparent", color: "#5c5c5c", border: "none" },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#a6a6a6" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#264f78 !important" },
    ".cm-cursor": { borderLeftColor: "#ffffff" },
    ".cm-foldPlaceholder": { backgroundColor: "#333", border: "none", color: "#aaa" },
    ".cm-panels": { backgroundColor: "#2b2b2b", color: "#e8e8e8", borderColor: "#363636" },
    ".cm-searchMatch": { backgroundColor: "#ffc65c44" },
    ".cm-searchMatch-selected": { backgroundColor: "#ff6c3766" },
    ".cm-selectionMatch": { backgroundColor: "#ffffff14" },
    ".cm-textfield": { backgroundColor: "#1c1c1c", border: "1px solid #444", color: "#e8e8e8" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#333", border: "1px solid #444", color: "#e8e8e8" },
  },
  { dark: true },
);

function langExt(language: string): Extension {
  switch (language) {
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "xml":
      return xml();
    case "html":
      return html();
    default:
      return [];
  }
}

type Props = {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  readOnly?: boolean;
  wrap?: boolean;
  placeholder?: string;
};

export default function CodeEditor({ value, onChange, language = "text", readOnly = false, wrap = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Compartments let us swap one extension (language, read-only…) without rebuilding the editor
  const comp = useRef({ lang: new Compartment(), ro: new Compartment(), wrap: new Compartment() });

  useEffect(() => {
    const c = comp.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
          c.lang.of(langExt(language)),
          c.ro.of([EditorState.readOnly.of(readOnly), readOnly ? [] : highlightActiveLine()]),
          c.wrap.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.lang.reconfigure(langExt(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: comp.current.ro.reconfigure([EditorState.readOnly.of(readOnly), readOnly ? [] : highlightActiveLine()]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
