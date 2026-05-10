import React, { useEffect, useMemo, useState } from "react";
import { Bot, FileDown, FileSearch, Info, Languages, Save, Trash2, Upload } from "lucide-react";
import type { AnalysisResult, AppStateSnapshot, DictionaryTable, DictionaryTableMeta, DictionaryTableSummary, ProviderConfig, ResourceTableType } from "../../shared/types";
import { EditableResourceSections, type ResourceTableId, type TableSettings } from "../components/table/DataTable";
import { CommandSelect } from "../components/ui/Selectors";
import { AppDialog } from "../components/ui/Primitives";
import { tableTypeLabel } from "./DictionaryView";

export default function AnalysisView({
  busy,
  snapshot,
  provider,
  tableSettings,
  activeTable,
  onActiveTableChange,
  run,
  setSnapshot
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  tableSettings: TableSettings;
  activeTable: ResourceTableId;
  onActiveTableChange: (table: ResourceTableId) => void;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
}) {
  const missingResourceTranslations = countMissingResourceTranslations(snapshot.analysis);
  const [tableSummaries, setTableSummaries] = useState<DictionaryTableSummary[]>([]);
  const [selectedTables, setSelectedTables] = useState<Record<ResourceTableId, string>>({
    characters: "projectDefault:project.characters",
    glossary: "projectDefault:project.glossary",
    noTranslate: "projectDefault:project.noTranslate"
  });
  const [externalTable, setExternalTable] = useState<DictionaryTable | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDraft, setInfoDraft] = useState({ id: "", displayName: "", description: "" });
  const [saveToDictionaryOpen, setSaveToDictionaryOpen] = useState(false);
  const [saveToDictionaryDraft, setSaveToDictionaryDraft] = useState({ id: "", displayName: "", description: "" });
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDraft, setExportDraft] = useState({ id: "", displayName: "", description: "" });
  const [deleteOpen, setDeleteOpen] = useState(false);

  const activeSelection = selectedTables[activeTable];
  const activeSummary = tableSummaries.find((item) => tableKey(item) === activeSelection);
  const isProjectDefault = !activeSummary || activeSummary.scope === "projectDefault";
  const displayedAnalysis = useMemo(() => {
    if (!externalTable || isProjectDefault) return snapshot.analysis;
    return withRows(snapshot.analysis, activeTable, externalTable.rows);
  }, [snapshot.analysis, externalTable, isProjectDefault, activeTable]);

  const reloadTables = async () => {
    const next = await window.bgt.listDictionaryTables();
    setTableSummaries(next);
  };

  useEffect(() => {
    void reloadTables();
  }, [snapshot.project?.projectRoot]);

  useEffect(() => {
    if (!activeSummary || activeSummary.scope === "projectDefault") {
      setExternalTable(null);
      return;
    }
    void run("读取资源表", () => window.bgt.loadDictionaryTable(activeSummary.scope, activeSummary.id, activeSummary.tableType), setExternalTable);
  }, [activeSelection, activeSummary?.id, activeSummary?.scope, activeSummary?.tableType]);

  const saveAnalysis = (analysis: AnalysisResult) => {
    setSnapshot((state) => ({ ...state, analysis }));
    return run("保存资源表", () => window.bgt.saveAnalysis(analysis), (saved) => setSnapshot((state) => ({ ...state, analysis: saved })));
  };

  const saveDisplayedAnalysis = (analysis: AnalysisResult) => {
    if (!activeSummary || activeSummary.scope === "projectDefault" || !externalTable) return saveAnalysis(analysis);
    const rows = rowsFor(analysis, activeTable);
    setExternalTable({ ...externalTable, rows });
    return run("保存词典表", () => window.bgt.saveDictionaryTable(activeSummary.scope, { ...externalTable, rows }), setExternalTable);
  };

  const openSaveToDictionaryDialog = () => {
    const fallbackId = activeSummary?.id.startsWith("user.") ? activeSummary.id : `user.${activeTable}_${Date.now()}`;
    setSaveToDictionaryDraft({
      id: fallbackId,
      displayName: activeSummary?.displayName ?? tableTypeLabel(activeTable),
      description: activeSummary?.description ?? ""
    });
    setSaveToDictionaryOpen(true);
  };

  const saveCurrentTableToDictionary = async () => {
    const displayName = saveToDictionaryDraft.displayName.trim();
    if (!displayName) return;
    const now = new Date().toISOString();
    const meta: DictionaryTableMeta = {
      schemaVersion: 1,
      kind: "bgt.resourceTable",
      id: normalizeUserId(saveToDictionaryDraft.id || `${activeTable}_${Date.now()}`),
      tableType: activeTable,
      displayName,
      description: saveToDictionaryDraft.description.trim(),
      createdAt: now,
      updatedAt: now
    };
    const table: DictionaryTable = { meta, rows: rowsFor(displayedAnalysis, activeTable) };
    await run("保存表至词典", () => window.bgt.saveDictionaryTable("global", table), async (saved) => {
      setExternalTable(saved);
      await reloadTables();
      setSelectedTables((state) => ({ ...state, [activeTable]: `global:${saved.meta.id}` }));
      setSaveToDictionaryOpen(false);
    });
  };

  const openExportDialog = () => {
    const fallbackId = activeSummary?.id.startsWith("user.") ? activeSummary.id : `user.${activeTable}_${Date.now()}`;
    setExportDraft({
      id: fallbackId,
      displayName: activeSummary?.displayName ?? tableTypeLabel(activeTable),
      description: activeSummary?.description ?? ""
    });
    setExportOpen(true);
  };

  const exportCurrentTable = async () => {
    const displayName = exportDraft.displayName.trim();
    if (!displayName) return;
    const now = new Date().toISOString();
    const meta: DictionaryTableMeta = {
      schemaVersion: 1,
      kind: "bgt.resourceTable",
      id: normalizeUserId(exportDraft.id || `${activeTable}_${Date.now()}`),
      tableType: activeTable,
      displayName,
      description: exportDraft.description.trim(),
      createdAt: now,
      updatedAt: now
    };
    await run("导出资源表", () => window.bgt.exportDictionaryTable({ meta, rows: rowsFor(displayedAnalysis, activeTable) }), () => {
      setExportOpen(false);
    });
  };

  const importTable = async () => {
    const result = await run("导入资源表", () => window.bgt.importDictionaryTable("project"));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      const overwrite = window.confirm(`已存在同 ID 的表：${result.existing?.displayName ?? result.table.meta.id}\n确定覆盖？取消则新建 ID。`);
      const resolved = await run("处理导入表冲突", () => window.bgt.importDictionaryTable("project", overwrite ? "overwrite" : "newId", result.table));
      if (resolved?.table) setSelectedTables((state) => ({ ...state, [resolved.table!.meta.tableType]: `project:${resolved.table!.meta.id}` }));
    } else if (result.table) {
      setSelectedTables((state) => ({ ...state, [result.table!.meta.tableType]: `project:${result.table!.meta.id}` }));
    }
    await reloadTables();
  };

  const deleteCurrentTable = async () => {
    if (!activeSummary || activeSummary.scope === "projectDefault") return;
    await run("删除资源表", () => window.bgt.deleteDictionaryTable(activeSummary.scope, activeSummary.id), async () => {
      setDeleteOpen(false);
      await reloadTables();
      setSelectedTables((state) => ({ ...state, [activeTable]: `projectDefault:project.${activeTable}` }));
    });
  };

  const tableOptions = tableSummaries
    .filter((item) => item.tableType === activeTable)
    .map((item) => ({
      id: tableKey(item),
      label: item.displayName,
      description: `${scopeLabel(item.scope)} · ${item.rowCount} 行`,
      tooltip: item.description
    }));

  useEffect(() => {
    if (!infoOpen || !activeSummary) return;
    setInfoDraft({
      id: activeSummary.id,
      displayName: activeSummary.displayName,
      description: activeSummary.description
    });
  }, [infoOpen, activeSummary?.id, activeSummary?.displayName, activeSummary?.description]);

  const saveTableInfo = async () => {
    if (!activeSummary) return;
    const currentRows = rowsFor(displayedAnalysis, activeTable);
    const meta: DictionaryTableMeta = {
      schemaVersion: 1,
      kind: "bgt.resourceTable",
      id: activeSummary.scope === "projectDefault" ? activeSummary.id : normalizeUserId(infoDraft.id),
      tableType: activeSummary.tableType,
      displayName: infoDraft.displayName.trim() || activeSummary.displayName,
      description: infoDraft.description.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await run("保存表信息", () => window.bgt.saveDictionaryTable(activeSummary.scope, { meta, rows: currentRows }), async (saved) => {
      if (activeSummary.scope !== "projectDefault") setExternalTable(saved);
      await reloadTables();
      const nextKey = `${activeSummary.scope}:${saved.meta.id}`;
      setSelectedTables((state) => ({ ...state, [activeTable]: nextKey }));
      setInfoOpen(false);
    });
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
        analysis={displayedAnalysis}
        textItems={snapshot.textItems}
        sourceLanguage={snapshot.project?.sourceLanguage}
        provider={provider}
        tableSettings={tableSettings}
        activeTable={activeTable}
        onActiveTableChange={onActiveTableChange}
        tableControls={
          <div className="resource-table-control-row">
            <CommandSelect
              value={activeSelection}
              options={tableOptions}
              placeholder="选择资源表"
              emptyText="没有可用资源表"
              onChange={(value) => setSelectedTables((state) => ({ ...state, [activeTable]: value }))}
            />
            <div className="resource-table-control-actions">
              <button className="secondary-button" onClick={openSaveToDictionaryDialog}><Save size={16} />保存表至词典</button>
              <button className="secondary-button" disabled={!activeSummary} onClick={() => setInfoOpen(true)}><Info size={16} />表信息</button>
              <button className="secondary-button" onClick={importTable}><Upload size={16} />导入表</button>
              <button className="secondary-button" onClick={openExportDialog}><FileDown size={16} />导出表</button>
              <button className="secondary-button danger-button" disabled={!activeSummary || activeSummary.scope === "projectDefault"} onClick={() => setDeleteOpen(true)}><Trash2 size={16} />删除表</button>
            </div>
          </div>
        }
        onChange={saveDisplayedAnalysis}
        onTranslated={(analysis) => setSnapshot((state) => ({ ...state, analysis }))}
      />
      {activeSummary && (
        <AppDialog open={infoOpen} title="表信息" compact onOpenChange={setInfoOpen}>
          <div className="dictionary-create-form">
            <label>
              <span>识别符</span>
              <input value={infoDraft.id} disabled={activeSummary.scope === "projectDefault"} onChange={(event) => setInfoDraft((draft) => ({ ...draft, id: event.target.value }))} />
            </label>
            <label>
              <span>显示名称</span>
              <input value={infoDraft.displayName} onChange={(event) => setInfoDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
            </label>
            <label>
              <span>类型</span>
              <input value={tableTypeLabel(activeSummary.tableType)} disabled />
            </label>
            <label>
              <span>功能描述</span>
              <textarea value={infoDraft.description} onChange={(event) => setInfoDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <div className="dialog-actions">
              <button disabled={!infoDraft.displayName.trim()} onClick={saveTableInfo}>
                <Save size={16} />
                保存
              </button>
            </div>
          </div>
        </AppDialog>
      )}
      <AppDialog open={saveToDictionaryOpen} title="保存表至词典" description="填写保存到全局词典的表信息。" compact onOpenChange={setSaveToDictionaryOpen}>
        <div className="dictionary-create-form">
          <label>
            <span>识别符</span>
            <input value={saveToDictionaryDraft.id} onChange={(event) => setSaveToDictionaryDraft((draft) => ({ ...draft, id: event.target.value }))} />
          </label>
          <label>
            <span>显示名称</span>
            <input value={saveToDictionaryDraft.displayName} onChange={(event) => setSaveToDictionaryDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
          </label>
          <label>
            <span>类型</span>
            <input value={tableTypeLabel(activeTable)} disabled />
          </label>
          <label>
            <span>功能描述</span>
            <textarea value={saveToDictionaryDraft.description} onChange={(event) => setSaveToDictionaryDraft((draft) => ({ ...draft, description: event.target.value }))} />
          </label>
          <div className="dialog-actions">
            <button disabled={!saveToDictionaryDraft.displayName.trim()} onClick={saveCurrentTableToDictionary}>
              <Save size={16} />
              保存
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog open={exportOpen} title="导出表" description="填写导出文件首行保存的表信息。" compact onOpenChange={setExportOpen}>
        <div className="dictionary-create-form">
          <label>
            <span>识别符</span>
            <input value={exportDraft.id} onChange={(event) => setExportDraft((draft) => ({ ...draft, id: event.target.value }))} />
          </label>
          <label>
            <span>显示名称</span>
            <input value={exportDraft.displayName} onChange={(event) => setExportDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
          </label>
          <label>
            <span>类型</span>
            <input value={tableTypeLabel(activeTable)} disabled />
          </label>
          <label>
            <span>功能描述</span>
            <textarea value={exportDraft.description} onChange={(event) => setExportDraft((draft) => ({ ...draft, description: event.target.value }))} />
          </label>
          <div className="dialog-actions">
            <button disabled={!exportDraft.displayName.trim()} onClick={exportCurrentTable}>
              <FileDown size={16} />
              导出
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog open={deleteOpen} title="删除资源表" description="此操作会删除当前选择的资源表，无法撤销。项目默认表不可删除。" compact onOpenChange={setDeleteOpen}>
        <div className="delete-confirm-body">
          <p>
            确定删除 <strong>{activeSummary?.displayName ?? "当前表"}</strong> 吗？
          </p>
          {activeSummary ? (
            <p className="settings-note">
              {scopeLabel(activeSummary.scope)} · {tableTypeLabel(activeSummary.tableType)} · {activeSummary.rowCount} 行 · {activeSummary.id}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="secondary-button" onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button className="danger-button" disabled={!activeSummary || activeSummary.scope === "projectDefault" || busy} onClick={deleteCurrentTable}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

function countMissingResourceTranslations(analysis: AnalysisResult): number {
  return (
    analysis.characters.filter((entry) => entry.enabled && entry.source.trim() && !entry.target.trim()).length +
    analysis.glossary.filter((entry) => entry.enabled && entry.source.trim() && !entry.target.trim()).length
  );
}

function tableKey(summary: DictionaryTableSummary): string {
  return `${summary.scope}:${summary.id}`;
}

function scopeLabel(scope: DictionaryTableSummary["scope"]): string {
  if (scope === "global") return "全局词典";
  if (scope === "project") return "项目词典";
  return "项目默认";
}

function rowsFor(analysis: AnalysisResult, table: ResourceTableId) {
  if (table === "characters") return analysis.characters;
  if (table === "glossary") return analysis.glossary;
  return analysis.noTranslate;
}

function withRows(analysis: AnalysisResult, table: ResourceTableId, rows: DictionaryTable["rows"]): AnalysisResult {
  if (table === "characters") return { ...analysis, characters: rows as AnalysisResult["characters"] };
  if (table === "glossary") return { ...analysis, glossary: rows as AnalysisResult["glossary"] };
  return { ...analysis, noTranslate: rows as AnalysisResult["noTranslate"] };
}

function normalizeUserId(id: string): string {
  const body = id.trim().replace(/^user\./, "").replace(/[^A-Za-z0-9_.-]/g, "_") || `table_${Date.now()}`;
  return `user.${body}`;
}
