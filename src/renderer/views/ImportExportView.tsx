import React, { useState } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { Bot, Download, FileSearch, RotateCcw, Save, Upload } from "lucide-react";
import type { AppStateSnapshot, PatchPreview, ProviderConfig, TextItem } from "../../shared/types";
import { TextTable, type TableSettings } from "../components/table/DataTable";
import { AppDialog, ProgressBar, StyledSelect } from "../components/ui/Primitives";
import { replaceItem } from "../appUtils";
export default function ImportExportView({
  busy,
  items,
  snapshot,
  provider,
  tableSettings,
  run,
  setSnapshot,
  saveItems
}: {
  busy: boolean;
  items: TextItem[];
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  tableSettings: TableSettings;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  saveItems: (items: TextItem[]) => Promise<TextItem[] | undefined>;
}) {
  const hasAiPlan = Boolean(snapshot.aiLocalizationPlan);
  const [mode, setMode] = useState<"extract" | "files" | "patch">("extract");
  const [exportFormat, setExportFormat] = useState<"jsonl" | "csv">("jsonl");
  const [patchProgress, setPatchProgress] = useState<{ title: string; detail: string; value: number } | null>(null);
  const patchBusy = busy || Boolean(patchProgress);

  const runPatchTask = async (title: string, task: () => Promise<PatchPreview | AppStateSnapshot>, onDone?: (value: PatchPreview | AppStateSnapshot) => void) => {
    setPatchProgress({ title, detail: "准备处理文件...", value: 12 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    try {
      setPatchProgress({ title, detail: "正在重建游戏工作区...", value: 42 });
      const value = await run(title, task);
      if (!value) return;
      const summary = isPatchPreview(value)
        ? `完成：${value.files.length} 个文件，${value.files.reduce((sum, file) => sum + file.replacements, 0)} 处替换，${value.blocked.length} 项跳过。`
        : "完成：游戏已还原。";
      setPatchProgress({ title, detail: summary, value: 100 });
      onDone?.(value);
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    } finally {
      setPatchProgress(null);
    }
  };

  return (
    <div className="stack">
      <RadixTabs.Root value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
        <RadixTabs.List className="segmented workflow-tabs">
        <RadixTabs.Trigger value="extract" className={mode === "extract" ? "active" : ""}>
          提取文本
        </RadixTabs.Trigger>
        <RadixTabs.Trigger value="files" className={mode === "files" ? "active" : ""}>
          导入/导出文本表
        </RadixTabs.Trigger>
        <RadixTabs.Trigger value="patch" className={mode === "patch" ? "active" : ""}>
          回填游戏
        </RadixTabs.Trigger>
        </RadixTabs.List>
      </RadixTabs.Root>

      {mode === "extract" && (
        <div className="panel workflow-panel">
          <div>
            <h2>提取文本</h2>
            <p>从游戏原始副本中扫描玩家可见文本，生成可翻译文本表。</p>
          </div>
          <div className="workflow-actions">
            <button disabled={busy || !snapshot.project} onClick={() => run("提取文本", () => window.bgt.extractTexts(), (next) => setSnapshot(next))}>
            <FileSearch size={16} />
              自动提取
            </button>
            <button className="secondary-button" disabled={busy || !snapshot.project || !provider} onClick={() => provider && run("尝试 AI 生成提取方案", () => window.bgt.generateAiLocalizationPlan(provider), (next) => setSnapshot(next))}>
              <Bot size={16} />
              尝试 AI 生成提取方案
            </button>
            <button className="secondary-button" disabled={busy || !snapshot.project || !hasAiPlan} onClick={() => run("AI 方案提取", () => window.bgt.extractTextsWithAiPlan(), (next) => setSnapshot(next))}>
              <FileSearch size={16} />
              按 AI 方案提取
            </button>
          </div>
          {snapshot.aiLocalizationPlan && (
            <div className="info-box">
              <p>AI 方案：{snapshot.aiLocalizationPlan.engine} - {snapshot.aiLocalizationPlan.summary}</p>
              <p>扫描范围：{snapshot.aiLocalizationPlan.includeFiles.join(", ") || "未指定"}</p>
            </div>
          )}
        </div>
      )}

      {mode === "files" && (
        <div className="panel workflow-panel">
          <div>
            <h2>导入/导出文本表</h2>
            <p>把当前文本表导出到文件，或导入已经编辑完成的文本表。</p>
          </div>
          <div className="workflow-actions workflow-actions-split">
            <div className="export-inline">
              <StyledSelect
                value={exportFormat}
                options={[
                  { value: "jsonl", label: "JSONL" },
                  { value: "csv", label: "CSV" }
                ]}
                onChange={(value) => setExportFormat(value as "jsonl" | "csv")}
              />
              <button disabled={!items.length} onClick={() => run(`导出 ${exportFormat.toUpperCase()}`, () => window.bgt.exportTextItems(snapshot.textItems, exportFormat))}>
                <Download size={16} />
                导出
              </button>
            </div>
            <button disabled={!snapshot.project} onClick={() => run("导入翻译", () => window.bgt.importTextItems(), (next) => setSnapshot((state) => ({ ...state, textItems: next })))}>
              <Upload size={16} />
              导入译文
            </button>
          </div>
        </div>
      )}

      {mode === "patch" && (
        <div className="panel workflow-panel">
          <div>
            <h2>回填游戏</h2>
            <p>把当前文本表中的译文写回游戏工作区，生成可预览、可打包的版本。</p>
          </div>
          <div className="workflow-actions">
            <button disabled={patchBusy || !items.length} onClick={() => void runPatchTask("应用回游戏", () => window.bgt.applyPatch(snapshot.textItems))}>
              <Save size={16} />
              应用回游戏
            </button>
            <button className="secondary-button" disabled={patchBusy || !snapshot.project || !items.length || !hasAiPlan} onClick={() => void runPatchTask("按 AI 方案回填", () => window.bgt.applyAiPatch(snapshot.textItems))}>
              <Bot size={16} />
              按 AI 方案回填
            </button>
            <button
              className="secondary-button"
              disabled={patchBusy || !snapshot.project}
              onClick={() => {
                if (!window.confirm("还原游戏会用 .bgt/original 覆盖项目根目录中的当前游戏文件，保留 .bgt。确定继续吗？")) return;
                void runPatchTask("还原游戏", () => window.bgt.restoreGame(), (next) => {
                  if (!isPatchPreview(next)) setSnapshot(next);
                });
              }}
            >
              <RotateCcw size={16} />
              还原游戏
            </button>
          </div>
          {!hasAiPlan && <p className="settings-note">没有 AI 提取/回填方案时，AI 回填不可用。</p>}
        </div>
      )}
      {patchProgress && <ProgressModal title={patchProgress.title} detail={patchProgress.detail} value={patchProgress.value} />}
      <TextTable
        items={items}
        enableFileFilter
        tableSettings={tableSettings}
        onChange={(changed) => saveItems(replaceItem(snapshot.textItems, changed))}
        onBulkChange={async (nextItems) => {
          await saveItems(nextItems);
        }}
        onTranslateItems={
          provider && snapshot.project
            ? async (selectedItems) => {
                const translated = await window.bgt.translateBatch(provider, snapshot.project!.targetLanguage, selectedItems);
                const byId = new Map(translated.map((item) => [item.id, item]));
                await saveItems(snapshot.textItems.map((item) => byId.get(item.id) ?? item));
              }
            : undefined
        }
      />
    </div>
  );
}

function isPatchPreview(value: PatchPreview | AppStateSnapshot): value is PatchPreview {
  return "files" in value && "blocked" in value;
}

function ProgressModal({ title, detail, value }: { title: string; detail: string; value: number }) {
  return (
    <AppDialog open title={title} description={detail} className="progress-modal">
        <ProgressBar value={value} className="progress-track" />
        <div className="progress-summary">
          <span>{value >= 100 ? "已完成" : "处理中"}</span>
          <strong>{Math.round(value)}%</strong>
        </div>
    </AppDialog>
  );
}

