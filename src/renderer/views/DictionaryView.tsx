import React, { useEffect, useMemo, useState } from "react";
import { Download, FileDown, FilePlus, Info, Save, Search, Trash2, Upload } from "lucide-react";
import type {
  AnalysisResult,
  AppStateSnapshot,
  CharacterEntry,
  DictionaryScope,
  DictionaryTable,
  DictionaryTableMeta,
  DictionaryTableRows,
  DictionaryTableSummary,
  GlossaryEntry,
  NoTranslateEntry,
  ResourceTableType
} from "../../shared/types";
import { AppDialog, StyledSelect } from "../components/ui/Primitives";
import { CharacterResourceTable, GlossaryResourceTable, NoTranslateResourceTable, type TableSettings } from "../components/table/DataTable";

const tableTypeOptions = [
  { value: "characters", label: "人物表" },
  { value: "glossary", label: "术语表" },
  { value: "noTranslate", label: "禁翻表" }
];

export default function DictionaryView({
  busy,
  snapshot,
  tableSettings,
  run,
  setSnapshot
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  tableSettings: TableSettings;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
}) {
  const [summaries, setSummaries] = useState<DictionaryTableSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [table, setTable] = useState<DictionaryTable | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ResourceTableType | "all">("all");
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDraft, setInfoDraft] = useState({ id: "", displayName: "", description: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    tableType: "glossary" as ResourceTableType,
    id: "user.glossary",
    displayName: "术语表",
    description: ""
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDraft, setExportDraft] = useState({ id: "", displayName: "", description: "" });

  const reload = async () => {
    const next = await window.bgt.listDictionaryTables();
    setSummaries(next);
    const global = next.filter((item) => item.scope === "global");
    const stillExists = selectedKey && global.some((item) => summaryKey(item) === selectedKey);
    if (!stillExists) setSelectedKey(global[0] ? summaryKey(global[0]) : "");
  };

  useEffect(() => {
    void reload();
  }, []);

  const globalTables = useMemo(() => summaries.filter((item) => item.scope === "global"), [summaries]);
  const visibleTables = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return globalTables.filter((item) => {
      if (typeFilter !== "all" && item.tableType !== typeFilter) return false;
      if (!keyword) return true;
      return `${item.id} ${item.displayName} ${item.description}`.toLowerCase().includes(keyword);
    });
  }, [globalTables, query, typeFilter]);

  const selectedSummary = globalTables.find((item) => summaryKey(item) === selectedKey);

  useEffect(() => {
    if (!infoOpen || !table) return;
    setInfoDraft({
      id: table.meta.id,
      displayName: table.meta.displayName,
      description: table.meta.description
    });
  }, [infoOpen, table?.meta.id, table?.meta.displayName, table?.meta.description]);

  useEffect(() => {
    if (!selectedSummary) {
      setTable(null);
      return;
    }
    void run("读取词典表", () => window.bgt.loadDictionaryTable("global", selectedSummary.id, selectedSummary.tableType), setTable);
  }, [selectedKey]);

  const saveTable = (nextTable: DictionaryTable) => {
    setTable(nextTable);
    void run("保存词典表", () => window.bgt.saveDictionaryTable("global", nextTable), (saved) => {
      setTable(saved);
      void reload();
    });
  };

  const openCreateDialog = () => {
    const tableType = typeFilter === "all" ? "glossary" : typeFilter;
    setCreateDraft({
      tableType,
      id: `user.${tableType}_${Date.now()}`,
      displayName: tableTypeLabel(tableType),
      description: ""
    });
    setCreateOpen(true);
  };

  const createEmpty = async () => {
    const id = createDraft.id.trim();
    const displayName = createDraft.displayName.trim();
    if (!id || !displayName) return;
    const meta = {
      id: normalizeUserId(id),
      displayName,
      description: createDraft.description.trim()
    };
    const created = await run("创建空词典表", () => window.bgt.createEmptyDictionaryTable("global", createDraft.tableType, meta), async (createdTable) => {
      await reload();
      setSelectedKey(`global:${createdTable.meta.id}`);
      setTable(createdTable);
      setCreateOpen(false);
    });
    if (created) setSelectedKey(`global:${created.meta.id}`);
  };

  const importTable = async () => {
    const result = await run("导入词典表", () => window.bgt.importDictionaryTable("global"));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      const overwrite = window.confirm(`已存在同 ID 的词典表：${result.existing?.displayName ?? result.table.meta.id}\n确定覆盖？取消则为导入表创建新 ID。`);
      const resolved = await run("处理词典表冲突", () => window.bgt.importDictionaryTable("global", overwrite ? "overwrite" : "newId", result.table));
      if (resolved?.table) setSelectedKey(`global:${resolved.table.meta.id}`);
    } else if (result.table) {
      setSelectedKey(`global:${result.table.meta.id}`);
    }
    await reload();
  };

  const exportTable = async () => {
    if (!table) return;
    const displayName = exportDraft.displayName.trim();
    if (!displayName) return;
    await run("导出词典表", () => window.bgt.exportDictionaryTable({
      ...table,
      meta: {
        ...table.meta,
        id: normalizeUserId(exportDraft.id || table.meta.id),
        displayName,
        description: exportDraft.description.trim(),
        updatedAt: new Date().toISOString()
      }
    }), (filePath) => {
      if (filePath) setExportOpen(false);
    });
  };

  const openExportDialog = () => {
    if (!table) return;
    setExportDraft({
      id: table.meta.id,
      displayName: table.meta.displayName,
      description: table.meta.description
    });
    setExportOpen(true);
  };

  const saveTableInfo = async () => {
    if (!table) return;
    const nextTable: DictionaryTable = {
      ...table,
      meta: {
        ...table.meta,
        id: normalizeUserId(infoDraft.id || table.meta.id),
        displayName: infoDraft.displayName.trim() || table.meta.displayName,
        description: infoDraft.description.trim(),
        updatedAt: new Date().toISOString()
      }
    };
    await run("保存表信息", () => window.bgt.saveDictionaryTable("global", nextTable), async (saved) => {
      setTable(saved);
      await reload();
      setSelectedKey(`global:${saved.meta.id}`);
      setInfoOpen(false);
    });
  };

  const deleteTable = async () => {
    if (!selectedSummary) return;
    await run("删除词典表", () => window.bgt.deleteDictionaryTable("global", selectedSummary.id), async () => {
      setDeleteOpen(false);
      setTable(null);
      await reload();
    });
  };

  const applyToProject = async () => {
    if (!table || !snapshot.project) return;
    const next = applyRowsToAnalysis(snapshot.analysis, table.meta.tableType, table.rows);
    await run("应用词典表到项目", () => window.bgt.saveAnalysis(next), (analysis) => setSnapshot((state) => ({ ...state, analysis })));
  };

  return (
    <div className="dictionary-view">
      <aside className="dictionary-list-panel">
        <div className="dictionary-list-header">
          <h2>词典</h2>
          <button className="icon-button" disabled={busy} onClick={openCreateDialog} title="增加空表"><FilePlus size={17} /></button>
          <button className="icon-button" disabled={busy} onClick={importTable} title="导入新表"><Upload size={17} /></button>
        </div>
        <div className="dictionary-search-row">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索词典表" />
        </div>
        <StyledSelect value={typeFilter} options={[{ value: "all", label: "全部类型" }, ...tableTypeOptions]} onChange={(value) => setTypeFilter(value as ResourceTableType | "all")} />
        <div className="dictionary-list">
          {visibleTables.map((item) => (
            <button key={summaryKey(item)} className={summaryKey(item) === selectedKey ? "dictionary-list-item active" : "dictionary-list-item"} onClick={() => setSelectedKey(summaryKey(item))}>
              <strong>{item.displayName}</strong>
              <span>{tableTypeLabel(item.tableType)} · {item.rowCount} 行</span>
              {item.description ? <small>{item.description}</small> : null}
            </button>
          ))}
          {!visibleTables.length ? <p className="empty">没有词典表</p> : null}
        </div>
      </aside>
      <section className="dictionary-table-panel">
        {table ? (
          <>
            <div className="table-toolbar dictionary-toolbar">
              <div>
                <h2>{table.meta.displayName}</h2>
                <p>{tableTypeLabel(table.meta.tableType)} · {table.rows.length} 行 · {table.meta.id}</p>
              </div>
              <div className="dictionary-toolbar-actions">
                <button disabled={!snapshot.project} onClick={applyToProject}><Save size={16} />应用到项目</button>
                <button className="secondary-button" onClick={() => setInfoOpen(true)}><Info size={16} />表信息</button>
                <button className="secondary-button" onClick={openExportDialog}><FileDown size={16} />导出表</button>
                <button className="secondary-button danger-button" onClick={() => setDeleteOpen(true)}><Trash2 size={16} />删除表</button>
              </div>
            </div>
            <DictionaryRowsEditor table={table} snapshot={snapshot} tableSettings={tableSettings} onChange={(rows) => saveTable({ ...table, rows })} />
          </>
        ) : (
          <div className="empty dictionary-empty">
            <Download size={26} />
            <p>选择左侧词典表，或导入一个 JSONL 表。</p>
          </div>
        )}
      </section>
      {table && (
        <AppDialog open={infoOpen} title="表信息" compact onOpenChange={setInfoOpen}>
          <div className="dictionary-create-form">
            <label>
              <span>识别符</span>
              <input value={infoDraft.id} onChange={(event) => setInfoDraft((draft) => ({ ...draft, id: event.target.value }))} />
            </label>
            <label>
              <span>显示名称</span>
              <input value={infoDraft.displayName} onChange={(event) => setInfoDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
            </label>
            <label>
              <span>类型</span>
              <input value={tableTypeLabel(table.meta.tableType)} disabled />
            </label>
            <label>
              <span>功能描述</span>
              <textarea value={infoDraft.description} onChange={(event) => setInfoDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <div className="dialog-actions">
              <button disabled={!infoDraft.id.trim() || !infoDraft.displayName.trim()} onClick={saveTableInfo}>
                <Save size={16} />
                保存
              </button>
            </div>
          </div>
        </AppDialog>
      )}
      <AppDialog open={createOpen} title="新建词典表" description="创建一个空的全局词典表。" compact onOpenChange={setCreateOpen}>
        <div className="dictionary-create-form">
          <label>
            <span>表类型</span>
            <StyledSelect
              value={createDraft.tableType}
              options={tableTypeOptions}
              onChange={(value) => {
                const tableType = value as ResourceTableType;
                setCreateDraft((draft) => ({
                  ...draft,
                  tableType,
                  id: draft.id && draft.id !== normalizeUserId(draft.id) ? draft.id : `user.${tableType}_${Date.now()}`,
                  displayName: draft.displayName || tableTypeLabel(tableType)
                }));
              }}
            />
          </label>
          <label>
            <span>识别符</span>
            <input value={createDraft.id} onChange={(event) => setCreateDraft((draft) => ({ ...draft, id: event.target.value }))} placeholder="user.my_table" />
          </label>
          <label>
            <span>显示名称</span>
            <input value={createDraft.displayName} onChange={(event) => setCreateDraft((draft) => ({ ...draft, displayName: event.target.value }))} placeholder="表名称" />
          </label>
          <label>
            <span>功能描述</span>
            <textarea value={createDraft.description} onChange={(event) => setCreateDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="说明这张表适合什么项目或用途" />
          </label>
          <div className="dialog-actions">
            <button disabled={busy || !createDraft.id.trim() || !createDraft.displayName.trim()} onClick={createEmpty}>
              <FilePlus size={16} />
              创建
            </button>
          </div>
        </div>
      </AppDialog>
      {table && (
        <AppDialog open={exportOpen} title="导出词典表" description="导出文件首行会写入这里的表信息。" compact onOpenChange={setExportOpen}>
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
              <input value={tableTypeLabel(table.meta.tableType)} disabled />
            </label>
            <label>
              <span>功能描述</span>
              <textarea value={exportDraft.description} onChange={(event) => setExportDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <div className="dialog-actions">
              <button disabled={busy || !exportDraft.id.trim() || !exportDraft.displayName.trim()} onClick={exportTable}>
                <FileDown size={16} />
                导出
              </button>
            </div>
          </div>
        </AppDialog>
      )}
      <AppDialog open={deleteOpen} title="删除词典表" description="此操作会删除全局词典中的这张表，无法撤销。" compact onOpenChange={setDeleteOpen}>
        <div className="delete-confirm-body">
          <p>
            确定删除 <strong>{selectedSummary?.displayName ?? "当前表"}</strong> 吗？
          </p>
          {selectedSummary ? (
            <p className="settings-note">
              {tableTypeLabel(selectedSummary.tableType)} · {selectedSummary.rowCount} 行 · {selectedSummary.id}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="danger-action-button" disabled={!selectedSummary || busy} onClick={deleteTable}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

export function DictionaryRowsEditor({ table, snapshot, tableSettings, onChange }: { table: DictionaryTable; snapshot: AppStateSnapshot; tableSettings: TableSettings; onChange: (rows: DictionaryTableRows) => void }) {
  if (table.meta.tableType === "characters") {
    return <CharacterResourceTable rows={table.rows as CharacterEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} />;
  }
  if (table.meta.tableType === "glossary") {
    return <GlossaryResourceTable rows={table.rows as GlossaryEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} />;
  }
  return <NoTranslateResourceTable rows={table.rows as NoTranslateEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} />;
}

function summaryKey(item: DictionaryTableSummary): string {
  return `${item.scope}:${item.id}`;
}

export function tableTypeLabel(tableType: ResourceTableType): string {
  if (tableType === "characters") return "人物表";
  if (tableType === "glossary") return "术语表";
  return "禁翻表";
}

function applyRowsToAnalysis(analysis: AnalysisResult, tableType: ResourceTableType, rows: DictionaryTableRows): AnalysisResult {
  if (tableType === "characters") return { ...analysis, characters: rows as CharacterEntry[] };
  if (tableType === "glossary") return { ...analysis, glossary: rows as GlossaryEntry[] };
  return { ...analysis, noTranslate: rows as NoTranslateEntry[] };
}

function normalizeUserId(id: string): string {
  const body = id.trim().replace(/^user\./, "").replace(/[^A-Za-z0-9_.-]/g, "_") || `table_${Date.now()}`;
  return `user.${body}`;
}
