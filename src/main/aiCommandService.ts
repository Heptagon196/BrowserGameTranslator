import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import {
  AnalysisResult,
  AiPermissionMode,
  CharacterEntry,
  GlossaryEntry,
  NoTranslateEntry,
  ProjectConfig,
  TextItem,
  TextStatus
} from "../shared/types";
import { ProjectService } from "./projectService";
import { projectDirs, sha256 } from "./storage";

type AiCommand = {
  command: string;
  args?: Record<string, unknown>;
};

type AnalysisTable = "characters" | "glossary" | "noTranslate";
type ShellAuthorizationRequester = (request: { command: string; cwd: string; permissionMode: AiPermissionMode }) => Promise<boolean>;

const textStatuses: TextStatus[] = ["extracted", "translated", "failed", "needs_review", "excluded"];
const sourceTypes: TextItem["sourceType"][] = ["html", "json", "js", "txt", "csv", "yaml"];
const analysisTables: AnalysisTable[] = ["characters", "glossary", "noTranslate"];

export function aiCommandSystemPrompt(project: ProjectConfig | null, permissionMode: AiPermissionMode): string {
  const fileCommands =
    permissionMode === "restricted"
      ? ["File commands are disabled in restricted mode."]
      : [
          permissionMode === "workspace"
            ? "File commands are enabled, but every path is confined to the current project root."
            : "File commands are enabled for arbitrary paths. Use absolute paths when the user asks for files outside the project.",
          "- file.list { path?, recursive?, limit? }",
          "- file.read { path, maxBytes? }",
          "- file.write { path, content, createDirs? }",
          "- file.delete { path }",
          "- file.mkdir { path }",
          "- file.search { path?, query, limit? }",
          "Shell commands are enabled, but every shell.run must be authorized by the user before execution.",
          "- shell.run { command, cwd?, timeoutMs? }"
        ];
  return [
    "You are an assistant embedded in an offline browser game translation tool.",
    "You can answer normally, and you can also operate project data by emitting a single fenced block named bgt-commands.",
    "Project structure note: the .bgt folder contains BrowserGameTranslator project configuration, extracted resources, logs, prompts, and the original game snapshot under .bgt/original. Treat .bgt as tool metadata and source backup, not as the playable translated game content.",
    "Only use commands when the user asks to inspect, add, update, or delete project data. Do not invent IDs; search or get records first if needed.",
    "Never request network, provider, API key, patch-apply, or settings operations. Those are not available.",
    `Current permission mode: ${permissionMode}.`,
    "Command format:",
    "```bgt-commands",
    "[{\"command\":\"text.search\",\"args\":{\"query\":\"menu\",\"limit\":10}}]",
    "```",
    "Available commands:",
    "- project.summary {}",
    "- text.search { query?, status?, limit? } for imported/extracted text rows.",
    "- text.get { id }",
    "- text.add { item: { original, sourceFile?, sourceType?, locator?, translation?, status? } }",
    "- text.update { id, patch: { original?, translation?, status?, sourceFile?, sourceType?, locator? } }",
    "- text.delete { id }",
    "- translation.search/get/add/update/delete are aliases for text.* focused on the translation table.",
    "- analysis.search { table: \"characters\"|\"glossary\"|\"noTranslate\", query?, limit? }",
    "- analysis.get { table, id }",
    "- analysis.add { table, row }",
    "- analysis.update { table, id, patch }",
    "- analysis.delete { table, id }",
    ...fileCommands,
    "After command results are returned, summarize exactly what changed or what you found.",
    project ? `Current project: ${project.projectName}, ${project.sourceLanguage} -> ${project.targetLanguage}.` : "No project is open."
  ].join("\n");
}

export function extractAiCommands(content: string): AiCommand[] {
  const match = content.match(/```bgt-commands\s*([\s\S]*?)```/i);
  if (!match) return [];
  const parsed = JSON.parse(match[1].trim()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("bgt-commands block must contain a JSON array.");
  return parsed.map((entry) => {
    if (!isRecord(entry) || typeof entry.command !== "string") throw new Error("Every AI command must include a command string.");
    return { command: entry.command, args: isRecord(entry.args) ? entry.args : {} };
  });
}

export async function executeAiCommands(
  projectService: ProjectService,
  commands: AiCommand[],
  permissionMode: AiPermissionMode,
  authorizeShell: ShellAuthorizationRequester
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const command of commands.slice(0, 12)) {
    try {
      results.push(await executeAiCommand(projectService, normalizeCommand(command.command), command.args ?? {}, permissionMode, authorizeShell));
    } catch (error) {
      results.push({
        command: command.command,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function executeAiCommand(
  projectService: ProjectService,
  command: string,
  args: Record<string, unknown>,
  permissionMode: AiPermissionMode,
  authorizeShell: ShellAuthorizationRequester
): Promise<Record<string, unknown>> {
  if (command === "project.summary") {
    const items = await projectService.readTextItems();
    const analysis = await projectService.readAnalysis();
    return {
      command,
      ok: true,
      project: projectService.project,
      counts: {
        textItems: items.length,
        characters: analysis.characters.length,
        glossary: analysis.glossary.length,
        noTranslate: analysis.noTranslate.length
      }
    };
  }

  if (command.startsWith("text.")) return executeTextCommand(projectService, command, args);
  if (command.startsWith("analysis.")) return executeAnalysisCommand(projectService, command, args);
  if (command.startsWith("file.")) return executeFileCommand(projectService, command, args, permissionMode);
  if (command === "shell.run") return executeShellRun(projectService, args, permissionMode, authorizeShell);
  throw new Error(`Unsupported command: ${command}`);
}

async function executeShellRun(
  projectService: ProjectService,
  args: Record<string, unknown>,
  permissionMode: AiPermissionMode,
  authorizeShell: ShellAuthorizationRequester
): Promise<Record<string, unknown>> {
  if (permissionMode === "restricted") throw new Error("Shell commands are disabled in restricted mode.");
  const shellCommand = requiredString(args.command, "command");
  const cwd = resolveAiPath(projectService, args.cwd, permissionMode);
  const timeoutMs = Math.min(300_000, Math.max(1_000, Number(args.timeoutMs ?? 120_000)));
  const allowed = await authorizeShell({ command: shellCommand, cwd, permissionMode });
  if (!allowed) return { command: "shell.run", ok: false, cwd, denied: true, error: "User denied shell execution." };
  const result = await runShell(shellCommand, cwd, timeoutMs);
  return { command: "shell.run", ok: result.exitCode === 0, cwd, ...result };
}

async function executeFileCommand(
  projectService: ProjectService,
  command: string,
  args: Record<string, unknown>,
  permissionMode: AiPermissionMode
): Promise<Record<string, unknown>> {
  if (permissionMode === "restricted") throw new Error("File commands are disabled in restricted mode.");
  const action = command.split(".")[1];
  const targetPath = resolveAiPath(projectService, args.path, permissionMode);

  if (action === "list") {
    const limit = limitArg(args.limit);
    const recursive = booleanArg(args.recursive, false);
    const rows = await listFiles(targetPath, recursive, limit);
    return { command, ok: true, path: targetPath, count: rows.length, rows };
  }

  if (action === "read") {
    const maxBytes = Math.min(200_000, Math.max(1, Number(args.maxBytes ?? 50_000)));
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${targetPath}`);
    const handle = await fs.open(targetPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      return { command, ok: true, path: targetPath, size: stat.size, truncated: stat.size > buffer.length, content: buffer.toString("utf8") };
    } finally {
      await handle.close();
    }
  }

  if (action === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (booleanArg(args.createDirs, true)) await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    return { command, ok: true, path: targetPath, bytes: Buffer.byteLength(content, "utf8") };
  }

  if (action === "delete") {
    await fs.rm(targetPath, { recursive: true, force: false });
    return { command, ok: true, path: targetPath, deleted: true };
  }

  if (action === "mkdir") {
    await fs.mkdir(targetPath, { recursive: true });
    return { command, ok: true, path: targetPath };
  }

  if (action === "search") {
    const query = requiredString(args.query, "query");
    const limit = limitArg(args.limit);
    const rows = await searchFiles(targetPath, query, limit);
    return { command, ok: true, path: targetPath, count: rows.length, rows };
  }

  throw new Error(`Unsupported file action: ${action}`);
}

async function executeTextCommand(projectService: ProjectService, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const items = await projectService.readTextItems();
  const action = command.split(".")[1];
  if (action === "search") {
    const query = stringArg(args.query).toLowerCase();
    const status = optionalStatus(args.status);
    const limit = limitArg(args.limit);
    const rows = items
      .filter((item) => !status || item.status === status)
      .filter((item) => !query || textItemSearchText(item).toLowerCase().includes(query))
      .slice(0, limit)
      .map(summarizeTextItem);
    return { command, ok: true, count: rows.length, rows };
  }

  const id = requiredString(args.id, "id");
  const index = items.findIndex((item) => item.id === id);

  if (action === "get") {
    if (index < 0) throw new Error(`Text item not found: ${id}`);
    return { command, ok: true, item: items[index] };
  }

  if (action === "add") {
    const itemArg = recordArg(args.item, "item");
    const item = makeTextItem(itemArg, items.length + 1);
    if (items.some((entry) => entry.id === item.id)) throw new Error(`Text item already exists: ${item.id}`);
    const next = [...items, item];
    await projectService.saveTextItems(next);
    return { command, ok: true, item: summarizeTextItem(item), count: next.length };
  }

  if (index < 0) throw new Error(`Text item not found: ${id}`);

  if (action === "update") {
    const patch = recordArg(args.patch, "patch");
    const updated = patchTextItem(items[index], patch);
    const next = items.map((item) => (item.id === id ? updated : item));
    await projectService.saveTextItems(next);
    return { command, ok: true, item: summarizeTextItem(updated) };
  }

  if (action === "delete") {
    const next = items.filter((item) => item.id !== id);
    await projectService.saveTextItems(next);
    return { command, ok: true, deletedId: id, count: next.length };
  }

  throw new Error(`Unsupported text action: ${action}`);
}

async function executeAnalysisCommand(projectService: ProjectService, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const table = tableArg(args.table);
  const analysis = await projectService.readAnalysis();
  const rows = analysis[table] as unknown as Array<Record<string, unknown> & { id: string }>;
  const action = command.split(".")[1];

  if (action === "search") {
    const query = stringArg(args.query).toLowerCase();
    const limit = limitArg(args.limit);
    const matches = rows
      .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query))
      .slice(0, limit);
    return { command, ok: true, table, count: matches.length, rows: matches };
  }

  const id = requiredString(args.id, "id");
  const index = rows.findIndex((row) => row.id === id);

  if (action === "get") {
    if (index < 0) throw new Error(`Analysis row not found: ${table}/${id}`);
    return { command, ok: true, table, row: rows[index] };
  }

  if (action === "add") {
    const row = makeAnalysisRow(table, recordArg(args.row, "row"), rows.length + 1);
    if (rows.some((entry) => entry.id === row.id)) throw new Error(`Analysis row already exists: ${table}/${row.id}`);
    const nextAnalysis = { ...analysis, [table]: [...rows, row] } as AnalysisResult;
    await projectService.saveAnalysis(nextAnalysis);
    return { command, ok: true, table, row };
  }

  if (index < 0) throw new Error(`Analysis row not found: ${table}/${id}`);

  if (action === "update") {
    const row = { ...rows[index], ...recordArg(args.patch, "patch"), id };
    const nextRows = rows.map((entry) => (entry.id === id ? row : entry));
    await projectService.saveAnalysis({ ...analysis, [table]: nextRows } as AnalysisResult);
    return { command, ok: true, table, row };
  }

  if (action === "delete") {
    const nextRows = rows.filter((entry) => entry.id !== id);
    await projectService.saveAnalysis({ ...analysis, [table]: nextRows } as AnalysisResult);
    return { command, ok: true, table, deletedId: id, count: nextRows.length };
  }

  throw new Error(`Unsupported analysis action: ${action}`);
}

function normalizeCommand(command: string): string {
  if (command.startsWith("translation.")) return `text.${command.split(".")[1]}`;
  return command;
}

function resolveAiPath(projectService: ProjectService, value: unknown, permissionMode: AiPermissionMode): string {
  const rawPath = stringArg(value) || ".";
  const baseRoot = projectDirs(projectService.project).projectRoot;
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(baseRoot, rawPath));
  if (permissionMode === "workspace" && !isPathInsideOrSame(resolved, baseRoot)) {
    throw new Error(`Path is outside the current project root: ${rawPath}`);
  }
  return resolved;
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

async function searchFiles(root: string, query: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const files = await listFiles(root, true, 500);
  const output: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (output.length >= limit) break;
    if (file.type !== "file" || typeof file.path !== "string") continue;
    const size = Number(file.size ?? 0);
    if (size > 250_000) continue;
    try {
      const content = await fs.readFile(file.path, "utf8");
      const lineIndex = content.toLowerCase().indexOf(query.toLowerCase());
      if (lineIndex >= 0) {
        output.push({
          path: file.path,
          preview: content.slice(Math.max(0, lineIndex - 120), lineIndex + query.length + 120)
        });
      }
    } catch {
      // Skip binary or unreadable files.
    }
  }
  return output;
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

function isPathInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function makeTextItem(input: Record<string, unknown>, index: number): TextItem {
  const original = requiredString(input.original, "item.original");
  const sourceType = sourceTypes.includes(input.sourceType as TextItem["sourceType"]) ? (input.sourceType as TextItem["sourceType"]) : "txt";
  return {
    id: stringArg(input.id) || `ai_text_${String(index).padStart(4, "0")}`,
    sourceFile: stringArg(input.sourceFile) || "ai-added",
    sourceType,
    locator: stringArg(input.locator) || `ai-added:${index}`,
    original,
    translation: stringArg(input.translation),
    status: optionalStatus(input.status) ?? (stringArg(input.translation) ? "translated" : "extracted"),
    originalHash: sha256(original),
    context: {},
    metadata: {
      lineBreakCount: countLineBreaks(original),
      placeholders: [],
      tags: [],
      numericPrefix: null
    }
  };
}

function patchTextItem(item: TextItem, patch: Record<string, unknown>): TextItem {
  const original = typeof patch.original === "string" ? patch.original : item.original;
  const sourceType = sourceTypes.includes(patch.sourceType as TextItem["sourceType"]) ? (patch.sourceType as TextItem["sourceType"]) : item.sourceType;
  return {
    ...item,
    sourceFile: typeof patch.sourceFile === "string" ? patch.sourceFile : item.sourceFile,
    sourceType,
    locator: typeof patch.locator === "string" ? patch.locator : item.locator,
    original,
    translation: typeof patch.translation === "string" ? patch.translation : item.translation,
    status: optionalStatus(patch.status) ?? item.status,
    originalHash: original === item.original ? item.originalHash : sha256(original),
    metadata: {
      ...item.metadata,
      lineBreakCount: original === item.original ? item.metadata.lineBreakCount : countLineBreaks(original)
    }
  };
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
      category: stringArg(input.category) || "character",
      note: stringArg(input.note),
      confidence: numberArg(input.confidence, 0.8),
      enabled: booleanArg(input.enabled, true),
      sourceExamples: stringArrayArg(input.sourceExamples)
    };
  }
  if (table === "glossary") {
    return {
      id: stringArg(input.id) || `term_ai_${String(index).padStart(4, "0")}`,
      source: stringArg(input.source),
      target: stringArg(input.target),
      description: stringArg(input.description),
      category: stringArg(input.category) || "term",
      isRegex: booleanArg(input.isRegex, false),
      enabled: booleanArg(input.enabled, true),
      sourceExamples: stringArrayArg(input.sourceExamples)
    };
  }
  return {
    id: stringArg(input.id) || `nt_ai_${String(index).padStart(4, "0")}`,
    marker: stringArg(input.marker),
    note: stringArg(input.note),
    isRegex: booleanArg(input.isRegex, false),
    enabled: booleanArg(input.enabled, true),
    sourceExamples: stringArrayArg(input.sourceExamples)
  };
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

function requiredString(value: unknown, name: string): string {
  const output = stringArg(value);
  if (!output) throw new Error(`${name} is required.`);
  return output;
}

function recordArg(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function tableArg(value: unknown): AnalysisTable {
  if (!analysisTables.includes(value as AnalysisTable)) throw new Error("table must be characters, glossary, or noTranslate.");
  return value as AnalysisTable;
}

function optionalStatus(value: unknown): TextStatus | undefined {
  return textStatuses.includes(value as TextStatus) ? (value as TextStatus) : undefined;
}

function limitArg(value: unknown): number {
  const limit = Number(value ?? 20);
  return Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
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
  return Array.isArray(value) ? value.map(String) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLineBreaks(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}
