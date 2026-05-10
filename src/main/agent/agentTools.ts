import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import {
  AnalysisResult,
  AiPermissionMode,
  CharacterEntry,
  GlossaryEntry,
  NoTranslateEntry,
  TextItem,
  TextStatus
} from "../../shared/types";
import { ProjectService } from "../projectService";
import { projectDirs, projectPaths } from "../storage";
import { executeWebExtract, executeWebSearch } from "./openWebSearchService";

type AnalysisTable = "characters" | "glossary" | "noTranslate";
type AgentTable = "text" | AnalysisTable;
type ProjectTableId = "project.text" | "project.characters" | "project.glossary" | "project.noTranslate";
type ProjectTableInfo = {
  id: ProjectTableId;
  label: string;
  description: string;
};
type TableWriteMode = "add" | "update";
type ReplacementRule = {
  from: string;
  to: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
};
export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const analysisTables: AnalysisTable[] = ["characters", "glossary", "noTranslate"];
export const projectTableInfos: ProjectTableInfo[] = [
  {
    id: "project.text",
    label: "文本表",
    description: "保存从游戏中提取出的可翻译文本行，包含原文、译文、状态、源文件位置等信息；翻译、回填、校对上下文主要以它为准。"
  },
  {
    id: "project.characters",
    label: "人物表",
    description: "保存人物名资源，包含完整人名、姓、名、译名、备注和启用状态；用于统一角色名称翻译和术语检查。"
  },
  {
    id: "project.glossary",
    label: "术语表",
    description: "保存普通术语和固定译法，包含原文术语、目标译文、备注、分类和启用状态；用于统一专有名词、道具、组织等翻译。"
  },
  {
    id: "project.noTranslate",
    label: "禁翻表",
    description: "保存不应翻译或必须原样保留的标记、代码、占位符和特殊文本；用于翻译约束和校对检查。"
  }
];
const projectTableIds = projectTableInfos.map((table) => table.id);
const projectTableDescriptions = projectTableInfos.map((table) => `${table.id}（${table.label}）：${table.description}`).join(" ");
const restrictedProjectTools = new Set([
  "project_refresh",
  "table_search",
  "table_get",
  "table_add",
  "table_update",
  "table_replace",
  "table_delete"
]);
const approvalTools = new Set([
  "table_add",
  "table_update",
  "table_replace",
  "table_delete",
  "file_write",
  "file_delete",
  "file_patch",
  "shell_run"
]);

export type AgentToolPolicy = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

export const agentToolDefinitions: AgentToolDefinition[] = [
  {
    name: "project_refresh",
    description: "Refresh the renderer project snapshot after external changes.",
    parameters: objectSchema({})
  },
  {
    name: "table_search",
    description: `Search or filter a project table. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({
      table: { type: "string", enum: projectTableIds, description: "Target table id." },
      query: { type: "string", description: "Optional search text or regex." },
      regex: { type: "boolean", description: "Treat query as regular expression." },
      status: { type: "string", enum: ["extracted", "translated", "failed", "needs_review", "excluded"], description: "Optional row status filter." },
      statuses: { type: "array", items: { type: "string", enum: ["extracted", "translated", "failed", "needs_review", "excluded"] }, description: "Optional row status filters." },
      sourceFile: { type: "string", description: "Optional exact or substring source file filter." },
      file: { type: "string", description: "Alias of sourceFile." },
      emptyTranslation: { type: "boolean", description: "Filter rows with empty translation." },
      nonEmptyTranslation: { type: "boolean", description: "Filter rows with non-empty translation." },
      ids: { type: "array", items: { type: "string" }, description: "Optional exact ids to include. If any id is missing, the tool returns an error instead of an empty result." },
      sortBy: { type: "string", enum: ["id", "sourceFile", "status"], description: "Sort field." },
      sortDir: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      offset: { type: "number", description: "Zero-based result offset." },
      limit: { type: "number", description: "Maximum rows to return." }
    }, ["table"])
  },
  {
    name: "table_get",
    description: `Get a full row by table and id. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({ table: { type: "string", enum: projectTableIds }, id: { type: "string" } }, ["table", "id"])
  },
  {
    name: "table_add",
    description: `Add one row to a project table. Use item for project.text and row for resource tables. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({ table: { type: "string", enum: projectTableIds }, row: { type: "object" }, item: { type: "object" } }, ["table"])
  },
  {
    name: "table_update",
    description: `Update one or multiple rows in a project table. For multiple rows, pass updates: [{id, patch}]. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({
      table: { type: "string", enum: projectTableIds },
      id: { type: "string", description: "Single row id." },
      patch: { type: "object", description: "Single row patch." },
      updates: {
        type: "array",
        items: objectSchema({ id: { type: "string" }, patch: { type: "object" } }, ["id", "patch"])
      },
      items: { type: "array", items: { type: "object" }, description: "Alias of updates." },
      rows: { type: "array", items: { type: "object" }, description: "Alias of updates." }
    }, ["table"])
  },
  {
    name: "table_replace",
    description: `Replace text inside existing string fields for many rows in one project table. Prefer this over table_update for large same-pattern replacements. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({
      table: { type: "string", enum: projectTableIds },
      ids: { type: "array", items: { type: "string" }, description: "Exact row ids to edit. If any id is missing, the tool returns an error." },
      field: { type: "string", description: "Single string field to replace. Defaults: project.text=translation, project.characters/project.glossary=target, project.noTranslate=marker." },
      fields: { type: "array", items: { type: "string" }, description: "Multiple string fields to replace. Overrides field." },
      replacements: {
        type: "array",
        items: objectSchema({
          from: { type: "string" },
          to: { type: "string" },
          regex: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          wholeWord: { type: "boolean" }
        }, ["from", "to"])
      }
    }, ["table", "ids", "replacements"])
  },
  {
    name: "table_delete",
    description: `Delete one or multiple rows from a project table. For multiple rows, pass ids: string[]. Valid table ids and meanings: ${projectTableDescriptions}`,
    parameters: objectSchema({ table: { type: "string", enum: projectTableIds }, id: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, ["table"])
  },
  {
    name: "file_list",
    description: "List files from a path.",
    parameters: objectSchema({ path: { type: "string" }, recursive: { type: "boolean" }, limit: { type: "number" } })
  },
  {
    name: "file_read",
    description: "Read a file as UTF-8 text.",
    parameters: objectSchema({ path: { type: "string" }, maxBytes: { type: "number" } }, ["path"])
  },
  {
    name: "file_stat",
    description: "Get file or directory metadata including existence, type, size, mtime and sha256 for files.",
    parameters: objectSchema({ path: { type: "string" }, hash: { type: "boolean" } }, ["path"])
  },
  {
    name: "file_write",
    description: "Write UTF-8 text to a file. This tool requires explicit user approval before execution.",
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" }, createDirs: { type: "boolean" } }, ["path", "content"])
  },
  {
    name: "file_patch",
    description: "Apply a single-file unified diff patch to a UTF-8 file. This tool requires explicit user approval before execution.",
    parameters: objectSchema({ path: { type: "string" }, diff: { type: "string" }, createFile: { type: "boolean" } }, ["path", "diff"])
  },
  {
    name: "file_delete",
    description: "Delete a file or directory. This tool requires explicit user approval before execution.",
    parameters: objectSchema({ path: { type: "string" } }, ["path"])
  },
  {
    name: "file_grep",
    description: "Search files with text or regex, include/exclude globs, context lines and structured results.",
    parameters: objectSchema({
      path: { type: "string", description: "Root file or directory." },
      pattern: { type: "string", description: "Search pattern." },
      query: { type: "string", description: "Alias of pattern." },
      regex: { type: "boolean", description: "Treat pattern as regular expression." },
      caseSensitive: { type: "boolean" },
      include: { type: "array", items: { type: "string" }, description: "Glob patterns to include." },
      exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to exclude." },
      contextLines: { type: "number" },
      maxResults: { type: "number" },
      limit: { type: "number", description: "Alias of maxResults." },
      maxFileBytes: { type: "number" }
    }, ["pattern"])
  },
  {
    name: "source_lookup",
    description: "Look up original source file snippet for a text row id.",
    parameters: objectSchema({ id: { type: "string" }, contextChars: { type: "number" } }, ["id"])
  },
  {
    name: "web_search",
    description: "Search the public web with open-websearch. Use it only when local project tables/files are not enough. Supported engines: bing, baidu.",
    parameters: objectSchema({
      query: { type: "string", description: "Search query." },
      engine: { type: "string", enum: ["bing", "baidu"], description: "Optional single engine." },
      engines: { type: "array", items: { type: "string", enum: ["bing", "baidu"] }, description: "Optional engine list." },
      limit: { type: "number", description: "Maximum search results, 1-20." },
      searchMode: {
        type: "string",
        enum: ["playwright", "request", "auto"],
        description: "Optional. playwright uses Electron Chromium via CDP and is preferred for Bing; request uses direct HTTP; auto follows open-websearch defaults."
      }
    }, ["query"])
  },
  {
    name: "web_extract",
    description: "Extract readable text from a public HTTP(S) web page. Use after web_search when the result snippet is not enough. Use mode=browser for sites that block direct HTTP fetch or require normal browser rendering.",
    parameters: objectSchema({
      url: { type: "string", description: "Public HTTP(S) URL." },
      maxChars: { type: "number", description: "Maximum extracted characters, 1000-80000." },
      mode: { type: "string", enum: ["auto", "request", "browser"], description: "auto tries request first and falls back to browser; request uses direct HTTP; browser uses hidden Electron Chromium." },
      readability: { type: "boolean", description: "Use article readability extraction. Defaults to true." },
      extractContent: { type: "boolean", description: "Alias of readability. Defaults to true." },
      returnHtml: { type: "boolean", description: "Return HTML instead of Markdown. Defaults to false." },
      includeLinks: { type: "boolean", description: "Include page links in extracted output. Defaults to false." },
      waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "Browser navigation readiness. Defaults to load." },
      waitForNavigation: { type: "boolean", description: "Wait for an extra navigation/redirect after initial load. Useful for verification or redirect pages. Defaults to true." },
      navigationTimeout: { type: "number", description: "Extra navigation wait timeout, 2000-60000 ms." },
      disableMedia: { type: "boolean", description: "Block images, stylesheets, fonts and media during browser extraction. Defaults to true." }
    }, ["url"])
  },
  {
    name: "shell_run",
    description: "Run a shell command. This tool requires explicit user approval before execution.",
    parameters: objectSchema({ command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, ["command"])
  }
];

export function evaluateAgentToolPolicy(
  projectService: ProjectService,
  toolName: string,
  args: Record<string, unknown>,
  mode: AiPermissionMode = "workspace"
): AgentToolPolicy {
  if (mode === "restricted") {
    return restrictedProjectTools.has(toolName)
      ? { allowed: true, requiresApproval: approvalTools.has(toolName) }
      : { allowed: false, requiresApproval: false, reason: "当前为受限模式，只允许操作文本表和资源表。" };
  }

  if (mode === "workspace") {
    const workspaceRoot = projectDirs(projectService.project).projectRoot;
    if (toolName.startsWith("file_")) {
      const targetPath = resolveAgentPath(projectService, args.path);
      if (!isPathInsideOrSame(targetPath, workspaceRoot)) {
        return { allowed: false, requiresApproval: false, reason: "当前为工作区访问模式，文件路径必须位于当前项目工作区内。" };
      }
    }
    if (toolName === "shell_run") {
      const cwd = resolveAgentPath(projectService, args.cwd);
      if (!isPathInsideOrSame(cwd, workspaceRoot)) {
        return { allowed: false, requiresApproval: false, reason: "当前为工作区访问模式，Shell 工作目录必须位于当前项目工作区内。" };
      }
    }
  }

  return { allowed: true, requiresApproval: approvalTools.has(toolName) };
}

export async function executeAgentTool(
  projectService: ProjectService,
  toolName: string,
  args: Record<string, unknown>,
  options: { permissionMode?: AiPermissionMode; approved?: boolean } = {}
): Promise<Record<string, unknown>> {
  try {
    const policy = evaluateAgentToolPolicy(projectService, toolName, args, options.permissionMode);
    if (!policy.allowed) {
      return { tool: toolName, ok: false, denied: true, error: policy.reason ?? "当前权限模式不允许执行该工具。" };
    }
    if (policy.requiresApproval && !options.approved) {
      return { tool: toolName, ok: false, approvalRequired: true, summary: "该操作需要用户批准后才能执行。" };
    }
    return await runAgentTool(projectService, toolName, args);
  } catch (error) {
    return {
      tool: toolName,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runAgentTool(projectService: ProjectService, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (toolName === "project_refresh") {
    return {
      tool: toolName,
      ok: true,
      dataChanged: true,
      summary: "已请求刷新项目快照。"
    };
  }

  if (toolName.startsWith("table_")) return executeTableTool(projectService, toolName, args);
  if (toolName.startsWith("file_")) return executeFileTool(projectService, toolName, args);
  if (toolName === "source_lookup") return executeSourceLookup(projectService, args);
  if (toolName === "web_search") return executeWebSearch(args);
  if (toolName === "web_extract") return executeWebExtract(args);
  if (toolName === "shell_run") return executeShellRun(projectService, args);
  throw new Error(`Unsupported tool: ${toolName}`);
}

async function executeShellRun(
  projectService: ProjectService,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const shellCommand = requiredString(args.command, "command");
  const cwd = resolveAgentPath(projectService, args.cwd);
  const timeoutMs = Math.min(300_000, Math.max(1_000, Number(args.timeoutMs ?? 120_000)));
  const result = await runShell(shellCommand, cwd, timeoutMs);
  return { tool: "shell_run", ok: result.exitCode === 0, cwd, ...result };
}

async function executeFileTool(
  projectService: ProjectService,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const action = toolName.replace("file_", "");
  const targetPath = resolveAgentPath(projectService, args.path);

  if (action === "list") {
    const limit = limitArg(args.limit);
    const recursive = booleanArg(args.recursive, false);
    const rows = await listFiles(targetPath, recursive, limit);
    return { tool: toolName, ok: true, path: targetPath, count: rows.length, rows };
  }

  if (action === "read") {
    const maxBytes = Math.min(200_000, Math.max(1, Number(args.maxBytes ?? 50_000)));
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${targetPath}`);
    const handle = await fs.open(targetPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      return { tool: toolName, ok: true, path: targetPath, size: stat.size, truncated: stat.size > buffer.length, content: buffer.toString("utf8") };
    } finally {
      await handle.close();
    }
  }

  if (action === "stat") {
    const stat = await statFile(targetPath, booleanArg(args.hash, false));
    return { tool: toolName, ok: true, path: targetPath, ...stat };
  }

  if (action === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (booleanArg(args.createDirs, true)) await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    return { tool: toolName, ok: true, path: targetPath, bytes: Buffer.byteLength(content, "utf8") };
  }

  if (action === "patch") {
    const diff = requiredString(args.diff, "diff");
    const createFile = booleanArg(args.createFile, false);
    const result = await applyFilePatch(targetPath, diff, createFile);
    return { tool: toolName, ok: true, path: targetPath, dataChanged: true, ...result };
  }

  if (action === "delete") {
    await fs.rm(targetPath, { recursive: true, force: false });
    return { tool: toolName, ok: true, path: targetPath, deleted: true };
  }

  if (action === "grep") {
    const pattern = requiredString(args.pattern ?? args.query, "pattern");
    const rows = await grepFiles(targetPath, {
      pattern,
      regex: booleanArg(args.regex, false),
      caseSensitive: booleanArg(args.caseSensitive, false),
      include: stringArrayArg(args.include),
      exclude: stringArrayArg(args.exclude),
      contextLines: Math.min(5, Math.max(0, numberArg(args.contextLines, 0))),
      maxResults: Math.min(2000, Math.max(1, numberArg(args.maxResults ?? args.limit, 100))),
      maxFileBytes: Math.min(10_000_000, Math.max(1_000, numberArg(args.maxFileBytes, 2_000_000)))
    });
    return { tool: toolName, ok: true, path: targetPath, total: rows.length, returned: rows.length, rows };
  }

  throw new Error(`Unsupported file action: ${action}`);
}

async function executeTableTool(projectService: ProjectService, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const table = agentTableArg(args.table);
  const action = toolName.replace("table_", "");
  let result: Record<string, unknown>;
  if (table === "text") {
    if (action === "search") result = await executeTextTool(projectService, "text_filter", args);
    else if (action === "get") result = await executeTextTool(projectService, "text_get", args);
    else if (action === "add") result = await executeTextTool(projectService, "text_add", { ...args, item: args.item ?? args.row });
    else if (action === "update") result = await executeTextTool(projectService, "text_update", args);
    else if (action === "replace") result = await executeTextTool(projectService, "text_replace", args);
    else if (action === "delete") result = await executeTextTool(projectService, "text_delete", args);
    else throw new Error(`Unsupported table action: ${action}`);
  } else {
    const analysisArgs = { ...args, table };
    if (action === "search") result = await executeAnalysisTool(projectService, "analysis_search", analysisArgs);
    else if (action === "get") result = await executeAnalysisTool(projectService, "analysis_get", analysisArgs);
    else if (action === "add") result = await executeAnalysisTool(projectService, "analysis_add", { ...analysisArgs, row: args.row ?? args.item });
    else if (action === "update") result = await executeAnalysisTool(projectService, "analysis_update", analysisArgs);
    else if (action === "replace") result = await executeAnalysisTool(projectService, "analysis_replace", analysisArgs);
    else if (action === "delete") result = await executeAnalysisTool(projectService, "analysis_delete", analysisArgs);
    else throw new Error(`Unsupported table action: ${action}`);
  }
  return { ...result, tool: toolName, table: projectTableId(table) };
}

async function executeTextTool(projectService: ProjectService, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const items = await projectService.readTextItems();
  const action = toolName.replace("text_", "");
  if (action === "search") {
    const query = stringArg(args.query).toLowerCase();
    const status = optionalStatus(args.status);
    const offset = offsetArg(args.offset);
    const limit = limitArg(args.limit);
    const matches = items
      .filter((item) => !status || item.status === status)
      .filter((item) => !query || textItemSearchText(item).toLowerCase().includes(query));
    const rows = matches
      .slice(offset, offset + limit)
      .map(summarizeTextItem);
    return { tool: toolName, ok: true, total: matches.length, returned: rows.length, offset, limit, partial: offset + rows.length < matches.length, status, rows };
  }

  if (action === "filter") {
    assertExistingIds(items, stringArrayArg(args.ids), "project.text");
    const filtered = filterTextItems(items, args);
    const offset = offsetArg(args.offset);
    const limit = limitArg(args.limit);
    const rows = filtered.slice(offset, offset + limit).map(summarizeTextItem);
    return {
      tool: toolName,
      ok: true,
      total: filtered.length,
      returned: rows.length,
      offset,
      limit,
      partial: offset + rows.length < filtered.length,
      rows
    };
  }

  if (action === "add") {
    const itemArg = recordArg(args.item, "item");
    assertAllowedTableFields("text", itemArg, "add", "item");
    const item = makeTextItem(itemArg, items.length + 1);
    if (items.some((entry) => entry.id === item.id)) throw new Error(`project.text id already exists: ${item.id}`);
    const next = [...items, item];
    await projectService.saveTextItems(next);
    return { tool: toolName, ok: true, dataChanged: true, summary: `已新增文本行 ${item.id}。`, item: summarizeTextItem(item), count: next.length };
  }

  if (action === "update") {
    const updates = bulkUpdateArrayArg(args).map((entry, index) => ({
      id: entry.id,
      patch: validatedTablePatch("text", entry.patch, `updates[${index}].patch`)
    }));
    const updateById = new Map(updates.map((entry) => [entry.id, entry.patch]));
    const missingIds = updates.filter((entry) => !items.some((item) => item.id === entry.id)).map((entry) => entry.id);
    if (missingIds.length) throw new Error(formatMissingIdsError("project.text", missingIds));
    let changedCount = 0;
    const next = items.map((item) => {
      const patch = updateById.get(item.id);
      if (!patch) return item;
      changedCount += 1;
      return patchTextItem(item, patch);
    });
    await projectService.saveTextItems(next);
    if (changedCount === 1) {
      const updated = next.find((item) => item.id === updates[0].id);
      return { tool: toolName, ok: true, dataChanged: true, summary: `已修改文本行 ${updates[0].id}。`, item: updated ? summarizeTextItem(updated) : undefined };
    }
    return {
      tool: toolName,
      ok: true,
      dataChanged: true,
      summary: `已批量修改 ${changedCount} 条文本行。`,
      changedCount,
      ids: updates.map((entry) => entry.id)
    };
  }

  if (action === "replace") {
    const ids = idArrayArg(args.ids ?? args.id ?? args.items ?? args.rows);
    assertExistingIds(items, ids, "project.text");
    const idSet = new Set(ids);
    const fields = replaceFieldsArg(args, ["translation"], ["original", "translation", "sourceFile", "locator"]);
    const replacements = replacementRulesArg(args.replacements);
    let changedCount = 0;
    const changedIds = new Set<string>();
    const next = items.map((item) => {
      if (!idSet.has(item.id)) return item;
      let changed = false;
      const patched = { ...item };
      for (const field of fields) {
        const current = patched[field as keyof TextItem];
        if (typeof current !== "string") continue;
        const replaced = applyReplacementRules(current, replacements);
        if (replaced !== current) {
          (patched as unknown as Record<string, unknown>)[field] = replaced;
          changed = true;
        }
      }
      if (changed) {
        changedCount += 1;
        changedIds.add(item.id);
      }
      return patched;
    });
    if (changedCount > 0) await projectService.saveTextItems(next);
    return {
      tool: toolName,
      ok: true,
      dataChanged: changedCount > 0,
      summary: `已按替换规则修改 ${changedCount} 条文本行。`,
      changedCount,
      ids,
      changedIds: [...changedIds],
      fields,
      replacements: replacements.map(summarizeReplacementRule)
    };
  }

  if (action === "delete") {
    const ids = idArrayArg(args.ids ?? args.id ?? args.items ?? args.rows);
    const idSet = new Set(ids);
    const missingIds = ids.filter((id) => !items.some((item) => item.id === id));
    if (missingIds.length) throw new Error(formatMissingIdsError("project.text", missingIds));
    const next = items.filter((item) => !idSet.has(item.id));
    await projectService.saveTextItems(next);
    if (ids.length === 1) {
      return { tool: toolName, ok: true, dataChanged: true, summary: `已删除文本行 ${ids[0]}。`, deletedId: ids[0], count: next.length };
    }
    return { tool: toolName, ok: true, dataChanged: true, summary: `已批量删除 ${ids.length} 条文本行。`, deletedIds: ids, count: next.length };
  }

  const id = requiredString(args.id, "id");
  const index = items.findIndex((item) => item.id === id);

  if (action === "get") {
    if (index < 0) throw new Error(`project.text id not found: ${id}`);
    return { tool: toolName, ok: true, item: items[index] };
  }

  if (index < 0) throw new Error(`project.text id not found: ${id}`);

  throw new Error(`Unsupported text action: ${action}`);
}

async function executeAnalysisTool(projectService: ProjectService, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const table = tableArg(args.table);
  const analysis = await projectService.readAnalysis();
  const rows = analysis[table] as unknown as Array<Record<string, unknown> & { id: string }>;
  const action = toolName.replace("analysis_", "");
  const tableId = projectTableId(table);

  if (action === "search") {
    const query = stringArg(args.query).toLowerCase();
    const offset = offsetArg(args.offset);
    const limit = limitArg(args.limit);
    const ids = stringArrayArg(args.ids);
    assertExistingIds(rows, ids, tableId);
    const idSet = new Set(ids);
    const matches = rows
      .filter((row) => !idSet.size || idSet.has(row.id))
      .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query));
    const pageRows = matches.slice(offset, offset + limit);
    return { tool: toolName, ok: true, table, total: matches.length, returned: pageRows.length, offset, limit, partial: offset + pageRows.length < matches.length, rows: pageRows };
  }

  if (action === "add") {
    const rowArg = recordArg(args.row, "row");
    assertAllowedTableFields(table, rowArg, "add", "row");
    const row = makeAnalysisRow(table, rowArg, rows.length + 1);
    if (rows.some((entry) => entry.id === row.id)) throw new Error(`${tableId} id already exists: ${row.id}`);
    const nextAnalysis = { ...analysis, [table]: [...rows, row] } as AnalysisResult;
    await projectService.saveAnalysis(nextAnalysis);
    return { tool: toolName, ok: true, dataChanged: true, summary: `已新增${analysisTableLabel(table)} ${row.id}。`, table, row };
  }

  if (action === "update") {
    const updates = bulkUpdateArrayArg(args).map((entry, index) => ({
      id: entry.id,
      patch: validatedTablePatch(table, entry.patch, `updates[${index}].patch`)
    }));
    const updateById = new Map(updates.map((entry) => [entry.id, entry.patch]));
    const missingIds = updates.filter((entry) => !rows.some((row) => row.id === entry.id)).map((entry) => entry.id);
    if (missingIds.length) throw new Error(formatMissingIdsError(tableId, missingIds));
    let changedCount = 0;
    const nextRows = rows.map((row) => {
      const patch = updateById.get(row.id);
      if (!patch) return row;
      changedCount += 1;
      return patchAnalysisRow(table, row, patch);
    });
    await projectService.saveAnalysis({ ...analysis, [table]: nextRows } as AnalysisResult);
    if (changedCount === 1) {
      const row = nextRows.find((entry) => entry.id === updates[0].id);
      return { tool: toolName, ok: true, dataChanged: true, summary: `已修改${analysisTableLabel(table)} ${updates[0].id}。`, table, row };
    }
    return {
      tool: toolName,
      ok: true,
      dataChanged: true,
      summary: `已批量修改 ${changedCount} 条${analysisTableLabel(table)}。`,
      table,
      changedCount,
      ids: updates.map((entry) => entry.id)
    };
  }

  if (action === "replace") {
    const ids = idArrayArg(args.ids ?? args.id ?? args.items ?? args.rows);
    assertExistingIds(rows, ids, tableId);
    const idSet = new Set(ids);
    const fields = replaceFieldsArg(args, defaultAnalysisReplaceFields(table), analysisReplaceableFields(table));
    const replacements = replacementRulesArg(args.replacements);
    let changedCount = 0;
    const changedIds = new Set<string>();
    const nextRows = rows.map((row) => {
      if (!idSet.has(row.id)) return row;
      let changed = false;
      const patched = { ...row };
      for (const field of fields) {
        const current = patched[field];
        if (typeof current !== "string") continue;
        const replaced = applyReplacementRules(current, replacements);
        if (replaced !== current) {
          patched[field] = replaced;
          changed = true;
        }
      }
      if (changed) {
        changedCount += 1;
        changedIds.add(row.id);
      }
      return patched;
    });
    if (changedCount > 0) await projectService.saveAnalysis({ ...analysis, [table]: nextRows } as AnalysisResult);
    return {
      tool: toolName,
      ok: true,
      dataChanged: changedCount > 0,
      summary: `已按替换规则修改 ${changedCount} 条${analysisTableLabel(table)}。`,
      table,
      changedCount,
      ids,
      changedIds: [...changedIds],
      fields,
      replacements: replacements.map(summarizeReplacementRule)
    };
  }

  if (action === "delete") {
    const ids = idArrayArg(args.ids ?? args.id ?? args.items ?? args.rows);
    const idSet = new Set(ids);
    const missingIds = ids.filter((id) => !rows.some((row) => row.id === id));
    if (missingIds.length) throw new Error(formatMissingIdsError(tableId, missingIds));
    const nextRows = rows.filter((entry) => !idSet.has(entry.id));
    await projectService.saveAnalysis({ ...analysis, [table]: nextRows } as AnalysisResult);
    if (ids.length === 1) {
      return { tool: toolName, ok: true, dataChanged: true, summary: `已删除${analysisTableLabel(table)} ${ids[0]}。`, table, deletedId: ids[0], count: nextRows.length };
    }
    return { tool: toolName, ok: true, dataChanged: true, summary: `已批量删除 ${ids.length} 条${analysisTableLabel(table)}。`, table, deletedIds: ids, count: nextRows.length };
  }

  const id = requiredString(args.id, "id");
  const index = rows.findIndex((row) => row.id === id);

  if (action === "get") {
    if (index < 0) throw new Error(`${tableId} id not found: ${id}`);
    return { tool: toolName, ok: true, table, row: rows[index] };
  }

  if (index < 0) throw new Error(`${tableId} id not found: ${id}`);

  throw new Error(`Unsupported analysis action: ${action}`);
}

async function executeSourceLookup(projectService: ProjectService, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = requiredString(args.id, "id");
  const contextChars = Math.min(20_000, Math.max(200, numberArg(args.contextChars, 1200)));
  const items = await projectService.readTextItems();
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`project.text id not found: ${id}`);
  const dirs = projectDirs(projectService.project);
  const sourceFile = item.sourceFile || "";
  const sourcePath = path.resolve(dirs.originalRoot, sourceFile);
  if (!isPathInsideOrSame(sourcePath, dirs.originalRoot)) throw new Error("Source file path is outside original root.");
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) throw new Error(`Source path is not a file: ${sourceFile}`);
  const content = await fs.readFile(sourcePath, "utf8");
  const needle = item.original;
  let offset = needle ? content.indexOf(needle) : -1;
  if (offset < 0 && needle.length > 80) {
    offset = content.indexOf(needle.slice(0, 80));
  }
  const start = offset >= 0 ? Math.max(0, offset - contextChars) : 0;
  const end = offset >= 0 ? Math.min(content.length, offset + Math.max(needle.length, 1) + contextChars) : Math.min(content.length, contextChars * 2);
  return {
    tool: "source_lookup",
    ok: true,
    id,
    sourceFile,
    fileSize: stat.size,
    item: summarizeTextItem(item),
    match: {
      found: offset >= 0,
      offset,
      start,
      end,
      snippet: content.slice(start, end)
    }
  };
}

function resolveAgentPath(projectService: ProjectService, value: unknown): string {
  const rawPath = stringArg(value) || ".";
  const baseRoot = projectDirs(projectService.project).projectRoot;
  return path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(baseRoot, rawPath));
}

function isPathInsideOrSame(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function listFiles(root: string, recursive: boolean, limit: number): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  await collectFiles(root, recursive, limit, output);
  return output;
}

async function collectFiles(root: string, recursive: boolean, limit: number, output: Array<Record<string, unknown>>): Promise<void> {
  if (output.length >= limit) return;
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    output.push({ path: root, type: "file", size: stat.size });
    return;
  }
  if (!stat.isDirectory()) {
    output.push({ path: root, type: "other", size: stat.size });
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= limit) return;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push({ path: entryPath, type: "directory" });
      if (recursive) await collectFiles(entryPath, recursive, limit, output);
    } else if (entry.isFile()) {
      output.push({ path: entryPath, type: "file", size: (await fs.stat(entryPath)).size });
    } else {
      output.push({ path: entryPath, type: "other" });
    }
  }
}

async function statFile(targetPath: string, shouldHash: boolean): Promise<Record<string, unknown>> {
  try {
    const stat = await fs.stat(targetPath);
    const output: Record<string, unknown> = {
      exists: true,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString()
    };
    if (shouldHash && stat.isFile()) {
      output.sha256 = createHash("sha256").update(await fs.readFile(targetPath)).digest("hex");
    }
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function grepFiles(
  root: string,
  options: {
    pattern: string;
    regex: boolean;
    caseSensitive: boolean;
    include: string[];
    exclude: string[];
    contextLines: number;
    maxResults: number;
    maxFileBytes: number;
  }
): Promise<Array<Record<string, unknown>>> {
  const files = await listFiles(root, true, 20_000);
  const rootForRelative = (await fs.stat(root)).isDirectory() ? root : path.dirname(root);
  const matcher = makeLineMatcher(options.pattern, options.regex, options.caseSensitive);
  const rows: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (rows.length >= options.maxResults) break;
    if (file.type !== "file" || typeof file.path !== "string") continue;
    const size = Number(file.size ?? 0);
    if (size > options.maxFileBytes) continue;
    const relativePath = normalizeSlash(path.relative(rootForRelative, file.path));
    if (options.include.length && !matchesAnyGlob(relativePath, options.include)) continue;
    if (options.exclude.length && matchesAnyGlob(relativePath, options.exclude)) continue;
    let content = "";
    try {
      content = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (rows.length >= options.maxResults) break;
      const match = matcher(lines[lineIndex]);
      if (!match) continue;
      rows.push({
        path: file.path,
        relativePath,
        line: lineIndex + 1,
        column: match.index + 1,
        match: match.text,
        preview: previewAroundColumn(lines[lineIndex], match.index, match.text.length),
        context: contextAroundLines(lines, lineIndex, options.contextLines)
      });
    }
  }
  return rows;
}

function makeLineMatcher(pattern: string, regex: boolean, caseSensitive: boolean): (line: string) => { index: number; text: string } | null {
  if (regex) {
    const flags = caseSensitive ? "" : "i";
    const expression = new RegExp(pattern, flags);
    return (line) => {
      const match = expression.exec(line);
      return match?.index !== undefined ? { index: match.index, text: match[0] || pattern } : null;
    };
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const index = haystack.indexOf(needle);
    return index >= 0 ? { index, text: line.slice(index, index + pattern.length) } : null;
  };
}

function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeSlash(pattern.trim());
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function previewAroundColumn(line: string, index: number, length: number): string {
  const maxSide = 120;
  const start = Math.max(0, index - maxSide);
  const end = Math.min(line.length, index + length + maxSide);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

function contextAroundLines(lines: string[], lineIndex: number, contextLines: number): Array<Record<string, unknown>> {
  if (!contextLines) return [];
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length, lineIndex + contextLines + 1);
  return lines.slice(start, end).map((text, offset) => ({
    line: start + offset + 1,
    text: text.length > 500 ? `${text.slice(0, 500)}...` : text
  }));
}

async function applyFilePatch(targetPath: string, diff: string, createFile: boolean): Promise<Record<string, unknown>> {
  let original = "";
  try {
    original = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createFile) throw error;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  }
  const patched = applyUnifiedDiff(original, diff);
  await fs.writeFile(targetPath, patched, "utf8");
  return {
    bytes: Buffer.byteLength(patched, "utf8"),
    oldHash: createHash("sha256").update(original).digest("hex"),
    newHash: createHash("sha256").update(patched).digest("hex")
  };
}

function applyUnifiedDiff(original: string, diff: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const originalLines = splitPatchLines(original);
  const diffLines = diff.split(/\r?\n/);
  const output: string[] = [];
  let originalIndex = 0;
  let sawHunk = false;
  for (let index = 0; index < diffLines.length; index += 1) {
    const line = diffLines[index];
    if (!line.startsWith("@@")) continue;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (!match) throw new Error(`Invalid unified diff hunk header: ${line}`);
    sawHunk = true;
    const oldStart = Math.max(0, Number(match[1]) - 1);
    while (originalIndex < oldStart) output.push(originalLines[originalIndex++]);
    index += 1;
    for (; index < diffLines.length; index += 1) {
      const hunkLine = diffLines[index];
      if (hunkLine.startsWith("@@")) {
        index -= 1;
        break;
      }
      if (!hunkLine || hunkLine.startsWith("\\ No newline")) continue;
      const marker = hunkLine[0];
      const value = hunkLine.slice(1);
      if (marker === " ") {
        assertPatchLine(originalLines[originalIndex], value);
        output.push(originalLines[originalIndex++]);
      } else if (marker === "-") {
        assertPatchLine(originalLines[originalIndex], value);
        originalIndex += 1;
      } else if (marker === "+") {
        output.push(value);
      } else if (hunkLine.startsWith("--- ") || hunkLine.startsWith("+++ ")) {
        continue;
      } else {
        throw new Error(`Invalid unified diff line: ${hunkLine}`);
      }
    }
  }
  if (!sawHunk) throw new Error("diff must contain at least one unified diff hunk.");
  while (originalIndex < originalLines.length) output.push(originalLines[originalIndex++]);
  const hadFinalNewline = /\r?\n$/.test(original);
  return output.join(newline) + (hadFinalNewline ? newline : "");
}

function splitPatchLines(value: string): string[] {
  if (!value) return [];
  const withoutFinalNewline = value.replace(/\r?\n$/, "");
  return withoutFinalNewline ? withoutFinalNewline.split(/\r?\n/) : [];
}

function assertPatchLine(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Patch context mismatch. Expected "${expected.slice(0, 120)}", got "${(actual ?? "").slice(0, 120)}".`);
  }
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; signal: string | null }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const execError = error as NodeJS.ErrnoException & { code?: number | string; signal?: string };
        resolve({
          exitCode: typeof execError?.code === "number" ? execError.code : error ? 1 : 0,
          stdout: stdout.slice(0, 120_000),
          stderr: stderr.slice(0, 120_000),
          signal: execError?.signal ?? null
        });
      }
    );
  });
}

function makeTextItem(input: Record<string, unknown>, index: number): TextItem {
  const original = requiredString(input.original, "item.original");
  return {
    id: stringArg(input.id) || `ai_text_${String(index).padStart(4, "0")}`,
    sourceFile: stringArg(input.sourceFile) || "ai-added",
    locator: stringArg(input.locator) || `ai-added:${index}`,
    original,
    translation: stringArg(input.translation),
    status: optionalStatus(input.status) ?? (stringArg(input.translation) ? "translated" : "extracted"),
    context: {}
  };
}

function patchTextItem(item: TextItem, patch: Record<string, unknown>): TextItem {
  const original = typeof patch.original === "string" ? patch.original : item.original;
  return {
    ...item,
    sourceFile: typeof patch.sourceFile === "string" ? patch.sourceFile : item.sourceFile,
    locator: typeof patch.locator === "string" ? patch.locator : item.locator,
    original,
    translation: typeof patch.translation === "string" ? patch.translation : item.translation,
    status: optionalStatus(patch.status) ?? item.status
  };
}

function patchAnalysisRow<T extends Record<string, unknown> & { id: string }>(table: AnalysisTable, row: T, patch: Record<string, unknown>): T {
  const allowedFields = tableFieldSet(table, "update");
  const next: Record<string, unknown> = { ...row };
  for (const [field, value] of Object.entries(patch)) {
    if (allowedFields.has(field)) next[field] = value;
  }
  next.id = row.id;
  return next as T;
}

function makeAnalysisRow(table: AnalysisTable, input: Record<string, unknown>, index: number): CharacterEntry | GlossaryEntry | NoTranslateEntry {
  if (table === "characters") {
    return {
      id: stringArg(input.id) || `char_ai_${String(index).padStart(4, "0")}`,
      source: stringArg(input.source),
      target: stringArg(input.target),
      familyName: optionalString(input.familyName),
      familyNameTranslation: optionalString(input.familyNameTranslation),
      givenName: optionalString(input.givenName),
      givenNameTranslation: optionalString(input.givenNameTranslation),
      nicknameOf: optionalString(input.nicknameOf),
      note: stringArg(input.note),
      enabled: booleanArg(input.enabled, true),
    };
  }
  if (table === "glossary") {
    return {
      id: stringArg(input.id) || `term_ai_${String(index).padStart(4, "0")}`,
      source: stringArg(input.source),
      target: stringArg(input.target),
      note: stringArg(input.note),
      category: stringArg(input.category) || "term",
      isRegex: booleanArg(input.isRegex, false),
      enabled: booleanArg(input.enabled, true)
    };
  }
  return {
    id: stringArg(input.id) || `nt_ai_${String(index).padStart(4, "0")}`,
    marker: stringArg(input.marker),
    note: stringArg(input.note),
    isRegex: booleanArg(input.isRegex, false),
    enabled: booleanArg(input.enabled, true)
  };
}

function validatedTablePatch(table: AgentTable, patch: Record<string, unknown>, name: string): Record<string, unknown> {
  assertAllowedTableFields(table, patch, "update", name);
  return patch;
}

function assertAllowedTableFields(table: AgentTable, record: Record<string, unknown>, mode: TableWriteMode, name: string) {
  const allowed = tableFields(table, mode);
  const invalid = Object.keys(record).filter((field) => !allowed.includes(field));
  if (invalid.length) {
    throw new Error(`${name} contains unsupported field(s) for ${projectTableId(table)}: ${invalid.join(", ")}. allowed fields: ${allowed.join(", ")}`);
  }
}

function tableFieldSet(table: AgentTable, mode: TableWriteMode): Set<string> {
  return new Set(tableFields(table, mode));
}

function tableFields(table: AgentTable, mode: TableWriteMode): string[] {
  if (table === "text") {
    const fields = ["sourceFile", "locator", "original", "translation", "status"];
    return mode === "add" ? ["id", ...fields] : fields;
  }
  if (table === "characters") {
    const fields = ["source", "target", "familyName", "familyNameTranslation", "givenName", "givenNameTranslation", "nicknameOf", "note", "enabled"];
    return mode === "add" ? ["id", ...fields] : fields;
  }
  if (table === "glossary") {
    const fields = ["source", "target", "note", "category", "isRegex", "enabled"];
    return mode === "add" ? ["id", ...fields] : fields;
  }
  const fields = ["marker", "note", "isRegex", "enabled"];
  return mode === "add" ? ["id", ...fields] : fields;
}

function summarizeTextItem(item: TextItem): Pick<TextItem, "id" | "sourceFile" | "original" | "translation" | "status"> {
  return {
    id: item.id,
    sourceFile: item.sourceFile,
    original: item.original,
    translation: item.translation,
    status: item.status
  };
}

function textItemSearchText(item: TextItem): string {
  return [item.id, item.sourceFile, item.locator, item.original, item.translation, item.status].join("\n");
}

function filterTextItems(items: TextItem[], args: Record<string, unknown>): TextItem[] {
  const statuses = statusArrayArg(args.statuses ?? args.status);
  const ids = new Set(stringArrayArg(args.ids));
  const query = stringArg(args.query);
  const regex = booleanArg(args.regex, false);
  const caseSensitive = booleanArg(args.caseSensitive, false);
  const sourceFile = stringArg(args.sourceFile ?? args.file);
  const emptyTranslation = booleanArg(args.emptyTranslation, false);
  const nonEmptyTranslation = booleanArg(args.nonEmptyTranslation ?? args.hasTranslation, false);
  const matcher = query ? makeTextMatcher(query, regex, caseSensitive) : null;
  const sorted = items
    .filter((item) => !ids.size || ids.has(item.id))
    .filter((item) => !statuses.length || statuses.includes(item.status))
    .filter((item) => !sourceFile || item.sourceFile.toLowerCase().includes(sourceFile.toLowerCase()))
    .filter((item) => !emptyTranslation || !item.translation.trim())
    .filter((item) => !nonEmptyTranslation || Boolean(item.translation.trim()))
    .filter((item) => !matcher || matcher(textItemSearchText(item)));
  return sortTextItems(sorted, stringArg(args.sortBy), stringArg(args.sortDir));
}

function assertExistingIds(rows: Array<{ id: string }>, ids: string[], label: string) {
  if (!ids.length) return;
  const rowIds = new Set(rows.map((row) => row.id));
  const missingIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].filter((id) => !rowIds.has(id));
  if (missingIds.length) {
    throw new Error(formatMissingIdsError(label, missingIds, 12));
  }
}

function formatMissingIdsError(tableId: string, missingIds: string[], max = 8): string {
  return `${tableId} ids not found: ${missingIds.slice(0, max).join(", ")}${missingIds.length > max ? "..." : ""}`;
}

function replaceFieldsArg(args: Record<string, unknown>, defaults: string[], allowed: string[]): string[] {
  const rawFields = stringArrayArg(args.fields);
  const fields = rawFields.length ? rawFields : stringArrayArg(args.field);
  const output = fields.length ? fields : defaults;
  const allowedSet = new Set(allowed);
  const invalid = output.filter((field) => !allowedSet.has(field));
  if (invalid.length) throw new Error(`replace fields not allowed: ${invalid.join(", ")}. allowed fields: ${allowed.join(", ")}`);
  return [...new Set(output)];
}

function replacementRulesArg(value: unknown): ReplacementRule[] {
  if (!Array.isArray(value) || !value.length) throw new Error("replacements must be a non-empty array.");
  return value.map((entry, index) => {
    const record = recordArg(entry, `replacements[${index}]`);
    const from = decodeReplacementEscapes(requiredString(record.from, `replacements[${index}].from`));
    return {
      from,
      to: typeof record.to === "string" ? decodeReplacementEscapes(record.to) : "",
      regex: booleanArg(record.regex, false),
      caseSensitive: booleanArg(record.caseSensitive, true),
      wholeWord: booleanArg(record.wholeWord, false)
    };
  });
}

function decodeReplacementEscapes(value: string): string {
  return value
    .replace(/\\r\\n/g, "\r\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function applyReplacementRules(value: string, replacements: ReplacementRule[]): string {
  return replacements.reduce((output, rule) => replaceByRule(output, rule), value);
}

function replaceByRule(value: string, rule: ReplacementRule): string {
  if (rule.regex) {
    const flags = rule.caseSensitive ? "gu" : "giu";
    return value.replace(new RegExp(rule.from, flags), rule.to);
  }
  if (rule.caseSensitive && !rule.wholeWord) return value.split(rule.from).join(rule.to);
  const pattern = escapeRegExp(rule.from);
  const source = rule.wholeWord ? `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])` : pattern;
  const flags = rule.caseSensitive ? "gu" : "giu";
  return value.replace(new RegExp(source, flags), rule.to);
}

function summarizeReplacementRule(rule: ReplacementRule): Record<string, unknown> {
  return {
    from: rule.from,
    to: rule.to,
    regex: rule.regex,
    caseSensitive: rule.caseSensitive,
    wholeWord: rule.wholeWord
  };
}

function defaultAnalysisReplaceFields(table: AnalysisTable): string[] {
  if (table === "noTranslate") return ["marker"];
  return ["target"];
}

function analysisReplaceableFields(table: AnalysisTable): string[] {
  if (table === "characters") return ["source", "target", "familyName", "familyNameTranslation", "givenName", "givenNameTranslation", "nicknameOf", "note"];
  if (table === "glossary") return ["source", "target", "note", "category"];
  return ["marker", "note"];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeTextMatcher(query: string, regex: boolean, caseSensitive: boolean): (value: string) => boolean {
  if (regex) {
    const expression = new RegExp(query, caseSensitive ? "" : "i");
    return (value) => expression.test(value);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (value) => (caseSensitive ? value : value.toLowerCase()).includes(needle);
}

function sortTextItems(items: TextItem[], sortBy: string, sortDir: string): TextItem[] {
  if (!sortBy) return items;
  const factor = sortDir === "desc" ? -1 : 1;
  const getters: Record<string, (item: TextItem) => string> = {
    id: (item) => item.id,
    sourceFile: (item) => item.sourceFile,
    status: (item) => item.status
  };
  const getter = getters[sortBy];
  if (!getter) return items;
  return [...items].sort((a, b) => getter(a).localeCompare(getter(b), undefined, { numeric: true }) * factor);
}

function requiredString(value: unknown, name: string): string {
  const output = stringArg(value);
  if (!output) throw new Error(`${name} is required.`);
  return output;
}

function recordArg(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function bulkUpdateArrayArg(args: Record<string, unknown>): Array<{ id: string; patch: Record<string, unknown> }> {
  for (const value of [args.updates, args.items, args.rows, args.changes, args.update, args]) {
    const normalized = normalizeUpdateArray(value);
    if (normalized) return normalized;
  }
  throw new Error("批量修改需要传入 updates 数组，例如 {\"updates\":[{\"id\":\"txt_000001\",\"patch\":{\"translation\":\"...\"}}]}。");
}

function normalizeUpdateArray(value: unknown): Array<{ id: string; patch: Record<string, unknown> }> | null {
  if (Array.isArray(value)) return value.map(normalizeUpdateEntry);
  if (!isRecord(value)) return null;
  for (const key of ["updates", "items", "rows", "changes", "update"]) {
    if (Array.isArray(value[key])) return value[key].map(normalizeUpdateEntry);
  }
  if (typeof value.id === "string") return [normalizeUpdateEntry(value, 0)];
  const mapped = Object.entries(value)
    .filter(([, patch]) => isRecord(patch))
    .map(([id, patch]) => ({ id, patch: patch as Record<string, unknown> }));
  return mapped.length ? mapped : null;
}

function normalizeUpdateEntry(entry: unknown, index: number): { id: string; patch: Record<string, unknown> } {
  const record = recordArg(entry, `updates[${index}]`);
  const patch = isRecord(record.patch) ? record.patch : directPatchFromUpdateEntry(record);
  return {
    id: requiredString(record.id, `updates[${index}].id`),
    patch
  };
}

function directPatchFromUpdateEntry(record: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (["id", "table"].includes(key)) continue;
    patch[key] = value;
  }
  if (!Object.keys(patch).length) throw new Error("updates item must contain patch fields.");
  return patch;
}

function idArrayArg(value: unknown): string[] {
  const ids = stringArrayArg(value).map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error("ids must be a non-empty array.");
  return [...new Set(ids)];
}

function statusArrayArg(value: unknown): TextStatus[] {
  if (Array.isArray(value)) return value.map(optionalStatus).filter((status): status is TextStatus => Boolean(status));
  const status = optionalStatus(value);
  return status ? [status] : [];
}

function tableArg(value: unknown): AnalysisTable {
  if (!analysisTables.includes(value as AnalysisTable)) {
    throw new Error(`table not found: ${stringArg(value) || "[empty]"}. available tables: project.characters, project.glossary, project.noTranslate`);
  }
  return value as AnalysisTable;
}

function agentTableArg(value: unknown): AgentTable {
  const raw = stringArg(value);
  const normalized = raw.replace(/[\s-]+/g, "_");
  const aliases: Record<string, AgentTable> = {
    "project.text": "text",
    "project.characters": "characters",
    "project.glossary": "glossary",
    "project.noTranslate": "noTranslate"
  };
  const table = aliases[normalized];
  if (!table) {
    throw new Error(`table not found: ${raw || "[empty]"}. available tables: ${projectTableIds.join(", ")}`);
  }
  return table;
}

function projectTableId(table: AgentTable): ProjectTableId {
  if (table === "text") return "project.text";
  if (table === "characters") return "project.characters";
  if (table === "glossary") return "project.glossary";
  return "project.noTranslate";
}

function optionalStatus(value: unknown): TextStatus | undefined {
  const raw = stringArg(value);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, TextStatus> = {
    extracted: "extracted",
    pending: "extracted",
    untranslated: "extracted",
    not_translated: "extracted",
    todo: "extracted",
    未翻译: "extracted",
    待翻译: "extracted",
    translated: "translated",
    done: "translated",
    已翻译: "translated",
    failed: "failed",
    error: "failed",
    失败: "failed",
    needs_review: "needs_review",
    review: "needs_review",
    待复核: "needs_review",
    需复核: "needs_review",
    excluded: "excluded",
    ignored: "excluded",
    ignore: "excluded",
    已排除: "excluded",
    排除: "excluded"
  };
  const status = aliases[normalized];
  if (!status) throw new Error(`Invalid text status: ${raw}. Valid statuses are extracted/未翻译, translated/已翻译, failed/失败, needs_review/需复核, excluded/已排除.`);
  return status;
}

function limitArg(value: unknown): number {
  const limit = Number(value ?? 20);
  return Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
}

function offsetArg(value: unknown): number {
  const offset = Number(value ?? 0);
  return Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(value: unknown, fallback: number): number {
  const output = Number(value);
  return Number.isFinite(output) ? output : fallback;
}

function booleanArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayArg(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.map(String) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function analysisTableLabel(table: AnalysisTable): string {
  if (table === "characters") return "人物表";
  if (table === "glossary") return "术语表";
  return "禁翻表";
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}
