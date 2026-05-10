import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, WidgetType } from "@codemirror/view";
import { css as codemirrorCss } from "@codemirror/lang-css";
import { html as codemirrorHtml } from "@codemirror/lang-html";
import { javascript as codemirrorJavascript } from "@codemirror/lang-javascript";
import { json as codemirrorJson } from "@codemirror/lang-json";
import * as Switch from "@radix-ui/react-switch";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { AppDialog } from "../ui/Primitives";
import { CommandSelect } from "../ui/Selectors";
import type { SourceHighlight, SourceViewerState } from "./types";

export default function SourceFileViewerModal({ state, onClose }: { state: SourceViewerState; onClose: () => void }) {
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);
  const [editorLoading, setEditorLoading] = useState(true);
  const [syntaxHighlightEnabled, setSyntaxHighlightEnabled] = useState(true);
  const [selectedHighlightKey, setSelectedHighlightKey] = useState(state.highlights[0]?.key ?? "");
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const sourceEditorViewRef = useRef<EditorView | null>(null);
  const pendingSourceOffsetRef = useRef<number | null>(null);
  const content = state.file.content;
  const firstHighlight = state.highlights[0];
  const startOffset = clampOffset(firstHighlight?.start ?? state.startOffset, content);
  const lineCount = useMemo(() => countSourceLines(content), [content]);
  const highlightButtons = useMemo(() => {
    const seen = new Set<string>();
    return state.highlights.filter((highlight) => {
      if (seen.has(highlight.key)) return false;
      seen.add(highlight.key);
      return true;
    });
  }, [state.highlights]);
  const highlightOptions = useMemo(
    () =>
      highlightButtons.map((highlight) => ({
        id: highlight.key,
        label: highlight.key,
        description: highlight.original ? truncateInlineText(highlight.original) : undefined,
        tooltip: formatSourceHighlightTooltip(highlight)
      })),
    [highlightButtons]
  );

  const jumpToSourceOffset = useCallback((offset: number) => {
    pendingSourceOffsetRef.current = offset;
    const view = sourceEditorViewRef.current;
    if (!view) return;
    const safeOffset = clampOffset(offset, content);
    view.dispatch({
      effects: EditorView.scrollIntoView(safeOffset, { y: "center", x: "nearest" }),
      selection: { anchor: safeOffset }
    });
    view.focus();
  }, [content]);

  const jumpToHighlight = useCallback((highlight: SourceHighlight) => {
    setSelectedHighlightKey(highlight.key);
    jumpToSourceOffset(highlight.start);
  }, [jumpToSourceOffset]);

  const jumpByHighlight = useCallback((direction: -1 | 1) => {
    if (highlightButtons.length < 2) return;
    const currentIndex = Math.max(0, highlightButtons.findIndex((highlight) => highlight.key === selectedHighlightKey));
    const nextIndex = (currentIndex + direction + highlightButtons.length) % highlightButtons.length;
    jumpToHighlight(highlightButtons[nextIndex]);
  }, [highlightButtons, jumpToHighlight, selectedHighlightKey]);

  const toggleSearchPanel = useCallback(() => {
    const view = sourceEditorViewRef.current;
    if (!view) return;
    if (searchPanelOpen) {
      closeSearchPanel(view);
      setSearchPanelOpen(false);
    } else {
      openSearchPanel(view);
      setSearchPanelOpen(true);
    }
    view.focus();
  }, [searchPanelOpen]);

  useEffect(() => {
    setSyntaxHighlightEnabled(true);
    setSelectedHighlightKey(state.highlights[0]?.key ?? "");
  }, [state.file.sourceFile]);

  useEffect(() => {
    if (!editorHost) return;
    setEditorLoading(true);
    editorHost.replaceChildren();
    let view: EditorView | null = null;
    let frame = 0;
    let secondFrame = 0;
    let startTimer = 0;
    startTimer = window.setTimeout(() => {
      const editorState = EditorState.create({
        doc: content,
        selection: { anchor: startOffset },
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({ spellcheck: "false" }),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          search({ top: false }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          sourceLanguageExtension(state.file.sourceFile, syntaxHighlightEnabled),
          sourceHighlightExtension(state.highlights, content),
          sourceViewerTheme
        ]
      });
      view = new EditorView({ parent: editorHost, state: editorState });
      sourceEditorViewRef.current = view;
      setSearchPanelOpen(false);
      const scrollToHighlight = () => {
        if (!view) return;
        const targetOffset = pendingSourceOffsetRef.current ?? startOffset;
        view.dispatch({
          effects: EditorView.scrollIntoView(targetOffset, { y: "center", x: "nearest" }),
          selection: { anchor: targetOffset }
        });
        view.focus();
      };
      frame = window.requestAnimationFrame(() => {
        scrollToHighlight();
        secondFrame = window.requestAnimationFrame(() => {
          scrollToHighlight();
          setEditorLoading(false);
        });
      });
    }, 0);
    return () => {
      if (startTimer) window.clearTimeout(startTimer);
      if (frame) window.cancelAnimationFrame(frame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      view?.destroy();
      if (sourceEditorViewRef.current === view) sourceEditorViewRef.current = null;
    };
  }, [content, editorHost, startOffset, state.file.sourceFile, state.highlights, syntaxHighlightEnabled]);

  return (
    <AppDialog open title="源文件位置" className="source-file-modal" disableOutsideClose onOpenChange={(open) => { if (!open) onClose(); }}>
      <div className="source-file-toolbar">
        <div className="source-file-meta">
          <strong>{state.file.sourceFile}</strong>
          {highlightButtons.length === 1 ? (
            <div className="source-file-keys under-title" aria-label="高亮项">
              {highlightButtons.map((highlight) => (
                <button
                  className="source-file-key-chip"
                  key={highlight.key}
                  onClick={() => jumpToSourceOffset(highlight.start)}
                  title={formatSourceHighlightTooltip(highlight)}
                  type="button"
                >
                  {highlight.key}
                </button>
              ))}
            </div>
          ) : highlightButtons.length > 1 ? (
            <div className="source-file-keys source-file-key-select-wrap under-title" aria-label="高亮项">
              <CommandSelect
                compact
                value={selectedHighlightKey}
                options={highlightOptions}
                placeholder="选择文本项"
                emptyText="没有高亮项"
                onChange={(key) => {
                  const highlight = highlightButtons.find((entry) => entry.key === key);
                  if (highlight) jumpToHighlight(highlight);
                }}
              />
              <button
                className="source-file-key-nav-button"
                onClick={() => jumpByHighlight(-1)}
                title="上一个文本项"
                type="button"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="source-file-key-nav-button"
                onClick={() => jumpByHighlight(1)}
                title="下一个文本项"
                type="button"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="source-file-actions">
          <label className="source-syntax-toggle">
            <Switch.Root className="toggle-switch" checked={syntaxHighlightEnabled} onCheckedChange={setSyntaxHighlightEnabled}>
              <Switch.Thumb className="toggle-switch-thumb" />
            </Switch.Root>
            <span>语法高亮</span>
          </label>
        </div>
      </div>
      <div className="source-file-editor-shell">
        <div className="source-file-editor" ref={setEditorHost} />
        {editorLoading ? (
          <div className="source-file-editor-loading">
            <div className="loading-spinner" />
            <span>正在加载源文件...</span>
          </div>
        ) : null}
      </div>
      <div className="source-file-footer">
        <span>{formatByteSize(state.file.bytes)} · {content.length.toLocaleString()} 字符 · {lineCount.toLocaleString()} 行 · 高亮 {highlightButtons.length.toLocaleString()} 项</span>
        <button className={searchPanelOpen ? "secondary-button active" : "secondary-button"} onClick={toggleSearchPanel}>
          <Search size={15} />
          搜索
        </button>
      </div>
    </AppDialog>
  );
}

class SourceKeyWidget extends WidgetType {
  constructor(private readonly highlight: SourceHighlight) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "bgt-source-highlight-key";
    element.textContent = this.highlight.key;
    element.title = formatSourceHighlightTooltip(this.highlight);
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const sourceViewerTheme = EditorView.theme({
  "&": {
    height: "100%"
  },
  ".cm-scroller": {
    fontFamily: "\"Cascadia Code\", Consolas, monospace",
    fontSize: "12px",
    height: "100%",
    lineHeight: "21px"
  },
  ".cm-line": {
    padding: "0 8px"
  },
  ".cm-content": {
    caretColor: "transparent",
    minHeight: "100%",
    padding: "10px 0 18px"
  },
  ".bgt-source-highlight": {
    backgroundColor: "#ffe08a",
    borderRadius: "3px",
    color: "#17242d"
  }
});

function sourceHighlightExtension(highlights: SourceHighlight[], content: string): Extension {
  if (!content.length || !highlights.length) return [];
  const ranges = highlights
    .map((highlight) => {
      const start = clampOffset(highlight.start, content);
      const end = Math.max(start + 1, clampOffset(highlight.end, content));
      return { ...highlight, start, end: Math.min(content.length, end) };
    })
    .filter((highlight) => highlight.start < highlight.end)
    .flatMap((highlight) => [
      Decoration.widget({ widget: new SourceKeyWidget(highlight), side: -1 }).range(highlight.start),
      Decoration.mark({ attributes: { title: formatSourceHighlightTooltip(highlight) }, class: "bgt-source-highlight" }).range(highlight.start, highlight.end)
    ]);
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

function sourceLanguageExtension(sourceFile: string, enabled: boolean): Extension {
  if (!enabled) return [];
  const extension = sourceFile.split(".").pop()?.toLowerCase();
  const highlightTheme = syntaxHighlighting(defaultHighlightStyle, { fallback: true });
  if (extension === "html" || extension === "htm") return [codemirrorHtml(), highlightTheme];
  if (extension === "js" || extension === "mjs" || extension === "cjs") return [codemirrorJavascript(), highlightTheme];
  if (extension === "json") return [codemirrorJson(), highlightTheme];
  if (extension === "css") return [codemirrorCss(), highlightTheme];
  return [];
}

function countSourceLines(content: string): number {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function formatSourceHighlightTooltip(highlight: SourceHighlight): string {
  const lines = [`文本项：${highlight.key}`];
  if (highlight.original) lines.push(`原文：${highlight.original}`);
  if (highlight.translation) lines.push(`译文：${highlight.translation}`);
  return lines.join("\n");
}

function truncateInlineText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized;
}

function clampOffset(value: number, content: string): number {
  return Math.max(0, Math.min(content.length, value));
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
