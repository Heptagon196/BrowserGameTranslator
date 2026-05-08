import React from "react";
import { Bot, FileSearch, Languages, Save } from "lucide-react";
import type { AnalysisResult, AppStateSnapshot, ProviderConfig } from "../../shared/types";
import { EditableResourceSections, type TableSettings } from "../components/table/DataTable";
export default function AnalysisView({
  busy,
  snapshot,
  provider,
  tableSettings,
  run,
  setSnapshot
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  tableSettings: TableSettings;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
}) {
  const missingResourceTranslations = countMissingResourceTranslations(snapshot.analysis);
  const saveAnalysis = (analysis: AnalysisResult) => {
    setSnapshot((state) => ({ ...state, analysis }));
    return run("保存资源表", () => window.bgt.saveAnalysis(analysis), (saved) => setSnapshot((state) => ({ ...state, analysis: saved })));
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <button disabled={busy || !snapshot.project} onClick={() => run("保存资源表", () => window.bgt.saveAnalysis(snapshot.analysis), (analysis) => setSnapshot((state) => ({ ...state, analysis })))}>
          <Save size={16} />
          保存资源表
        </button>
        <button disabled={busy || !snapshot.textItems.length} onClick={() => run("本地分析资源", () => window.bgt.analyzeLocally(), (analysis) => setSnapshot((state) => ({ ...state, analysis })))}>
          <FileSearch size={16} />
          本地初筛
        </button>
        <button
          disabled={busy || !provider || !snapshot.textItems.length}
          onClick={() =>
            provider &&
            run("AI 分析资源", async () => {
              try {
                return await window.bgt.analyze(provider);
              } finally {
                const refreshed = await window.bgt.refreshProject();
                setSnapshot(refreshed);
              }
            })
          }
        >
          <Bot size={16} />
          AI 提取人名/术语/禁翻
        </button>
        <button
          disabled={busy || !provider || !snapshot.project || missingResourceTranslations === 0}
          onClick={() =>
            provider &&
            run("翻译资源表空白项", async () => {
              await window.bgt.translateMissingAnalysisResources(provider);
              return window.bgt.refreshProject();
            }, setSnapshot)
          }
        >
          <Languages size={16} />
          翻译（{missingResourceTranslations}）
        </button>
      </div>
      <EditableResourceSections
        analysis={snapshot.analysis}
        provider={provider}
        tableSettings={tableSettings}
        onChange={saveAnalysis}
        onTranslated={(analysis) => setSnapshot((state) => ({ ...state, analysis }))}
      />
    </div>
  );
}

function countMissingResourceTranslations(analysis: AnalysisResult): number {
  return (
    analysis.characters.filter((entry) => entry.enabled && entry.source.trim() && !entry.target.trim()).length +
    analysis.glossary.filter((entry) => entry.enabled && entry.source.trim() && !entry.target.trim()).length
  );
}



