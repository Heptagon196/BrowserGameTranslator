import fs from "node:fs/promises";
import path from "node:path";
import { app, dialog } from "electron";
import {
  CharacterEntry,
  DictionaryImportResult,
  DictionaryScope,
  DictionaryTable,
  DictionaryTableMeta,
  DictionaryTableRows,
  DictionaryTableSummary,
  GlossaryEntry,
  NoTranslateEntry,
  ProjectConfig,
  ResourceTableType
} from "../shared/types";
import {
  defaultResourceTableMeta,
  projectPaths,
  readResourceJsonl,
  writeResourceJsonl
} from "./storage";

type ResourceRow = CharacterEntry | GlossaryEntry | NoTranslateEntry;

function globalDictionaryRoot(): string {
  return path.join(app.getPath("userData"), "dictionaries");
}

function projectDictionaryRoot(project: ProjectConfig): string {
  return projectPaths(project).dictionaries;
}

function scopeRoot(scope: DictionaryScope, project?: ProjectConfig): string {
  if (scope === "global") return globalDictionaryRoot();
  if (!project) throw new Error("No project is open.");
  return projectDictionaryRoot(project);
}

function tableFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
}

function tablePath(scope: DictionaryScope, id: string, project?: ProjectConfig): string {
  return path.join(scopeRoot(scope, project), tableFileName(id));
}

function ensureUserId(id: string): string {
  const body = id.trim().replace(/^user\./, "").replace(/[^A-Za-z0-9_.-]/g, "_") || `table_${Date.now()}`;
  return `user.${body}`;
}

function normalizeMeta(input: Partial<DictionaryTableMeta>, tableType: ResourceTableType): DictionaryTableMeta {
  const now = new Date().toISOString();
  const id = ensureUserId(input.id || input.displayName || `table_${Date.now()}`);
  return {
    schemaVersion: 1,
    kind: "bgt.resourceTable",
    id,
    tableType,
    displayName: input.displayName?.trim() || id,
    description: input.description?.trim() || "",
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function normalizeProjectDefaultMeta(input: Partial<DictionaryTableMeta>, project: ProjectConfig, tableType: ResourceTableType): DictionaryTableMeta {
  const fallback = defaultResourceTableMeta(project, tableType);
  return {
    ...fallback,
    displayName: input.displayName?.trim() || fallback.displayName,
    description: input.description?.trim() || "",
    createdAt: input.createdAt || fallback.createdAt,
    updatedAt: new Date().toISOString()
  };
}

function isMeta(value: unknown): value is DictionaryTableMeta {
  return Boolean(value && typeof value === "object" && (value as DictionaryTableMeta).kind === "bgt.resourceTable");
}

function inferTypeFromRows(rows: unknown[]): ResourceTableType {
  const row = rows.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  if (!row) return "glossary";
  if ("marker" in row) return "noTranslate";
  if ("familyName" in row || "givenName" in row || "nicknameOf" in row) return "characters";
  return "glossary";
}

async function readDictionaryFile(filePath: string): Promise<DictionaryTable> {
  const text = await fs.readFile(filePath, "utf8");
  const values = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const first = values[0];
  const meta = isMeta(first) ? first : normalizeMeta({ id: path.basename(filePath, ".jsonl"), displayName: path.basename(filePath, ".jsonl") }, inferTypeFromRows(values));
  const rows = (isMeta(first) ? values.slice(1) : values) as DictionaryTableRows;
  return { meta, rows };
}

async function listScope(scope: DictionaryScope, project?: ProjectConfig): Promise<DictionaryTableSummary[]> {
  const root = scopeRoot(scope, project);
  await fs.mkdir(root, { recursive: true });
  const files = await fs.readdir(root).catch(() => []);
  const summaries: DictionaryTableSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    try {
      const table = await readDictionaryFile(path.join(root, file));
      summaries.push({
        scope,
        id: table.meta.id,
        tableType: table.meta.tableType,
        displayName: table.meta.displayName,
        description: table.meta.description,
        rowCount: table.rows.length,
        deletable: true
      });
    } catch {
      // Skip broken dictionary files so a single bad import does not break the page.
    }
  }
  return summaries.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listDictionaryTables(project?: ProjectConfig): Promise<DictionaryTableSummary[]> {
  const output: DictionaryTableSummary[] = [];
  if (project) {
    const paths = projectPaths(project);
    const [characters, glossary, noTranslate] = await Promise.all([
      readResourceJsonl<CharacterEntry>(paths.characters),
      readResourceJsonl<GlossaryEntry>(paths.glossary),
      readResourceJsonl<NoTranslateEntry>(paths.noTranslate)
    ]);
    output.push(
      { scope: "projectDefault", ...summaryFromProject(project, "characters", characters.rows.length, characters.meta), deletable: false },
      { scope: "projectDefault", ...summaryFromProject(project, "glossary", glossary.rows.length, glossary.meta), deletable: false },
      { scope: "projectDefault", ...summaryFromProject(project, "noTranslate", noTranslate.rows.length, noTranslate.meta), deletable: false },
      ...(await listScope("project", project))
    );
  }
  output.push(...(await listScope("global", project)));
  return output;
}

function summaryFromProject(project: ProjectConfig, tableType: ResourceTableType, rowCount: number, storedMeta?: DictionaryTableMeta | null) {
  const meta = storedMeta ?? defaultResourceTableMeta(project, tableType);
  return {
    id: meta.id,
    tableType,
    displayName: meta.displayName,
    description: meta.description,
    rowCount
  };
}

export async function loadDictionaryTable(scope: DictionaryScope | "projectDefault", id: string, tableType: ResourceTableType, project?: ProjectConfig): Promise<DictionaryTable> {
  if (scope === "projectDefault") {
    if (!project) throw new Error("No project is open.");
    const paths = projectPaths(project);
    if (tableType === "characters") {
      const table = await readResourceJsonl<CharacterEntry>(paths.characters);
      return { meta: table.meta ?? defaultResourceTableMeta(project, tableType), rows: table.rows };
    }
    if (tableType === "glossary") {
      const table = await readResourceJsonl<GlossaryEntry>(paths.glossary);
      return { meta: table.meta ?? defaultResourceTableMeta(project, tableType), rows: table.rows };
    }
    const table = await readResourceJsonl<NoTranslateEntry>(paths.noTranslate);
    return { meta: table.meta ?? defaultResourceTableMeta(project, tableType), rows: table.rows };
  }
  return readDictionaryFile(tablePath(scope, id, project));
}

export async function saveDictionaryTable(scope: DictionaryScope | "projectDefault", table: DictionaryTable, project?: ProjectConfig): Promise<DictionaryTable> {
  if (scope === "projectDefault") {
    if (!project) throw new Error("No project is open.");
    const meta = normalizeProjectDefaultMeta(table.meta, project, table.meta.tableType);
    const paths = projectPaths(project);
    const filePath = table.meta.tableType === "characters" ? paths.characters : table.meta.tableType === "glossary" ? paths.glossary : paths.noTranslate;
    await writeResourceJsonl(filePath, meta, table.rows as ResourceRow[]);
    return { meta, rows: table.rows };
  }
  const meta = normalizeMeta(table.meta, table.meta.tableType);
  await writeResourceJsonl(tablePath(scope, meta.id, project), meta, table.rows as ResourceRow[]);
  return { meta, rows: table.rows };
}

export async function createEmptyDictionaryTable(scope: DictionaryScope, tableType: ResourceTableType, input: Partial<DictionaryTableMeta>, project?: ProjectConfig): Promise<DictionaryTable> {
  return saveDictionaryTable(scope, { meta: normalizeMeta(input, tableType), rows: [] }, project);
}

export async function deleteDictionaryTable(scope: DictionaryScope, id: string, project?: ProjectConfig): Promise<void> {
  await fs.unlink(tablePath(scope, id, project));
}

export async function exportDictionaryTable(table: DictionaryTable): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: "导出词典表",
    defaultPath: `${table.meta.id}.jsonl`,
    filters: [{ name: "JSONL", extensions: ["jsonl"] }]
  });
  if (result.canceled || !result.filePath) return null;
  await writeResourceJsonl(result.filePath, table.meta, table.rows as ResourceRow[]);
  return result.filePath;
}

export async function importDictionaryTable(scope: DictionaryScope, project?: ProjectConfig, conflictMode?: "overwrite" | "newId", pendingTable?: DictionaryTable): Promise<DictionaryImportResult> {
  let table = pendingTable;
  if (!table) {
    const result = await dialog.showOpenDialog({
      title: "导入词典表",
      properties: ["openFile"],
      filters: [{ name: "JSONL", extensions: ["jsonl"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" };
    table = await readDictionaryFile(result.filePaths[0]);
  }
  const normalized = { ...table, meta: normalizeMeta(table.meta, table.meta.tableType) };
  const existing = (await listDictionaryTables(project)).find((item) => item.scope === scope && item.id === normalized.meta.id);
  if (existing && !conflictMode) return { status: "conflict", table: normalized, existing };
  const tableToSave = conflictMode === "newId"
    ? { ...normalized, meta: normalizeMeta({ ...normalized.meta, id: `${normalized.meta.id}_${Date.now()}` }, normalized.meta.tableType) }
    : normalized;
  const saved = await saveDictionaryTable(scope, tableToSave, project);
  return { status: "imported", table: saved };
}
