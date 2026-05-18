import fs from "node:fs/promises";
import path from "node:path";
import { PatchPreview, PatchProgress, ProjectConfig, TextItem } from "../shared/types";
import { projectDirs, projectPaths, readJson, writeJson } from "./storage";

export type RangeKind = "html-text" | "html-attr" | "js-string" | "js-template-content" | "js-object-key" | "js-val-string" | "plain";
const technicalJsValueKeys = new Set(["action_name", "base", "format", "path", "image", "icon", "sound", "src", "url"]);

export interface ParsedRangeLocator {
  start: number;
  end: number;
  kind: RangeKind;
}

export interface LocatorValidationResult {
  ok: boolean;
  method: "json-path" | "range" | "unsupported";
  message?: string;
}

export type PatchProgressReporter = (progress: PatchProgress) => void;
type ApplyItemProgressReporter = (processed: number, total: number, message: string, force?: boolean) => void;

export async function previewPatch(project: ProjectConfig, items: TextItem[]): Promise<PatchPreview> {
  const dirs = projectDirs(project);
  const translated = items.filter(isPatchableTextItem);
  const byFile = groupBy(translated, (item) => item.sourceFile);
  const blocked: PatchPreview["blocked"] = [];
  const files: PatchPreview["files"] = [];
  for (const [sourceFile, fileItems] of byFile) {
    let replacements = 0;
    for (const item of fileItems) {
      if (!item.translation) continue;
      if (isJsonLocator(item.locator)) {
        replacements += 1;
        continue;
      }
      if (parseRangeLocator(item.locator)) {
        replacements += 1;
      } else {
        blocked.push({ textItemId: item.id, reason: "缺少可回填的范围定位，已跳过。" });
      }
    }
    if (replacements) {
      files.push({
        path: sourceFile,
        replacements,
        backupPath: path.join(dirs.bgtRoot, "patches", "backup", `${Date.now()}-${path.basename(sourceFile)}`)
      });
    }
  }
  return { files, blocked };
}

export async function applyPatch(project: ProjectConfig, items: TextItem[], onProgress?: PatchProgressReporter): Promise<PatchPreview> {
  onProgress?.({
    phase: "preparing",
    current: 0,
    total: 0,
    percent: 4,
    message: "正在预检查可回填文本..."
  });
  const preview = await previewPatch(project, items);
  const dirs = projectDirs(project);
  const translated = items.filter(isPatchableTextItem);
  const byFileEntries = Array.from(groupBy(translated, (item) => item.sourceFile).entries());
  const appliedAt = new Date().toISOString();

  onProgress?.({
    phase: "rebuilding",
    current: 0,
    total: byFileEntries.length,
    percent: 18,
    message: "正在从原始副本重建游戏工作区..."
  });
  await rebuildWorkingCopy(project);

  for (let fileIndex = 0; fileIndex < byFileEntries.length; fileIndex += 1) {
    const [sourceFile, fileItems] = byFileEntries[fileIndex];
    const jsonItems = fileItems.filter((item) => isJsonLocator(item.locator));
    const rangeItems = fileItems.filter((item) => parseRangeLocator(item.locator));
    const writeItemTotal = Math.max(1, jsonItems.length + rangeItems.length);
    let writeItemProcessed = 0;
    let lastWriteProgressAt = 0;
    const emitWriteProgress = (message: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastWriteProgressAt < 90 && writeItemProcessed < writeItemTotal) return;
      lastWriteProgressAt = now;
      const fileProgress = Math.max(0, Math.min(0.98, writeItemProcessed / writeItemTotal));
      onProgress?.({
        phase: "writing",
        current: fileIndex + fileProgress,
        total: byFileEntries.length,
        percent: progressPercent(32, 88, fileIndex + fileProgress, byFileEntries.length),
        message,
        currentFile: sourceFile,
        replacements: writeItemProcessed,
        blocked: preview.blocked.length
      });
    };
    emitWriteProgress("正在读取原文...", true);
    const originalPath = path.join(dirs.originalRoot, sourceFile);
    const fullPath = path.join(dirs.projectRoot, sourceFile);
    const originalContent = await fs.readFile(originalPath, "utf8");
    emitWriteProgress("正在备份原始文件...", true);
    const backupPath = path.join(dirs.bgtRoot, "patches", "backup", `${appliedAt.replace(/[:.]/g, "-")}-${sourceFile.replace(/[\\/]/g, "__")}`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(originalPath, backupPath);

    let nextContent = originalContent;
    if (jsonItems.length) {
      const stageOffset = writeItemProcessed;
      nextContent = applyJsonTranslations(nextContent, jsonItems, preview.blocked, (processed, total, message, force) => {
        writeItemProcessed = stageOffset + processed;
        emitWriteProgress(`${message} ${processed}/${total}`, force);
      });
    }
    if (rangeItems.length) {
      const stageOffset = writeItemProcessed;
      nextContent = applyRangeTranslations(nextContent, rangeItems, preview.blocked, (processed, total, message, force) => {
        writeItemProcessed = stageOffset + processed;
        emitWriteProgress(`${message} ${processed}/${total}`, force);
      });
    }
    for (const item of fileItems) {
      if (!isJsonLocator(item.locator) && !parseRangeLocator(item.locator)) {
        preview.blocked.push({ textItemId: item.id, reason: "缺少可回填的定位，已跳过。" });
      }
    }
    writeItemProcessed = writeItemTotal;
    emitWriteProgress("正在写入文件...", true);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, nextContent, "utf8");
    onProgress?.({
      phase: "writing",
      current: fileIndex + 1,
      total: byFileEntries.length,
      percent: progressPercent(32, 88, fileIndex + 1, byFileEntries.length),
      message: "当前文件写入完成。",
      currentFile: sourceFile,
      replacements: fileItems.length,
      blocked: preview.blocked.length
    });
  }

  onProgress?.({
    phase: "saving",
    current: byFileEntries.length,
    total: byFileEntries.length,
    percent: 94,
    message: "正在保存回填记录..."
  });
  const manifestPath = projectPaths(project).patchManifest;
  const previous = await readJson<any[]>(manifestPath, []);
  previous.push({ appliedAt, files: preview.files, blocked: preview.blocked });
  await writeJson(manifestPath, previous);
  onProgress?.({
    phase: "done",
    current: byFileEntries.length,
    total: byFileEntries.length,
    percent: 100,
    message: `回填完成：${preview.files.length} 个文件，${preview.files.reduce((sum, file) => sum + file.replacements, 0)} 处替换，${preview.blocked.length} 项跳过。`,
    replacements: preview.files.reduce((sum, file) => sum + file.replacements, 0),
    blocked: preview.blocked.length
  });
  return preview;
}

function isPatchableTextItem(item: TextItem): boolean {
  return Boolean(item.translation.trim()) && item.status !== "excluded" && item.status !== "failed";
}

export async function restoreWorkingCopy(project: ProjectConfig, onProgress?: PatchProgressReporter): Promise<void> {
  onProgress?.({
    phase: "rebuilding",
    current: 0,
    total: 1,
    percent: 12,
    message: "正在从原始副本还原游戏工作区..."
  });
  await rebuildWorkingCopy(project);
  onProgress?.({
    phase: "done",
    current: 1,
    total: 1,
    percent: 100,
    message: "游戏工作区已还原。"
  });
}

function progressPercent(start: number, end: number, current: number, total: number): number {
  if (!total) return end;
  return Math.max(start, Math.min(end, start + ((end - start) * current) / total));
}

async function rebuildWorkingCopy(project: ProjectConfig): Promise<void> {
  const dirs = projectDirs(project);
  const gameRoot = path.resolve(dirs.projectRoot);
  const bgtRoot = path.resolve(dirs.bgtRoot);
  const originalRoot = path.resolve(dirs.originalRoot);
  if (gameRoot === path.parse(gameRoot).root) throw new Error("拒绝重建磁盘根目录。");
  if (!isPathInsideOrSame(bgtRoot, gameRoot)) throw new Error(".bgt 不在项目根目录内，拒绝重建工作区。");
  if (!isPathInsideOrSame(originalRoot, bgtRoot)) throw new Error("原始副本不在 .bgt 内，拒绝重建工作区。");

  const entries = await fs.readdir(gameRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".bgt") continue;
    await fs.rm(path.join(gameRoot, entry.name), { recursive: true, force: true });
  }
  await copyDirectory(originalRoot, gameRoot);
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".bgt" || entry.name === ".git" || entry.name === "node_modules") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

function isPathInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function applyRangeTranslations(content: string, items: TextItem[], blocked: PatchPreview["blocked"], onProgress?: ApplyItemProgressReporter): string {
  const ranged = items
    .map((item) => ({ item, locator: parseRangeLocator(item.locator) }))
    .filter((entry): entry is { item: TextItem; locator: ParsedRangeLocator } => Boolean(entry.locator))
    .sort((a, b) => a.locator.start - b.locator.start || a.locator.end - b.locator.end);

  const seenRanges = new Set<string>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let lastAcceptedEnd = -1;
  onProgress?.(0, Math.max(1, ranged.length), "正在替换范围文本", true);
  for (let index = 0; index < ranged.length; index += 1) {
    const { item, locator } = ranged[index];
    const key = `${locator.start}:${locator.end}`;
    if (seenRanges.has(key)) {
      blocked.push({ textItemId: item.id, reason: "多个文本项指向同一范围，已跳过重复项。" });
      onProgress?.(index + 1, ranged.length, "正在替换范围文本");
      continue;
    }
    seenRanges.add(key);
    if (locator.start < lastAcceptedEnd) {
      blocked.push({ textItemId: item.id, reason: "文本范围与其他回填项重叠，已跳过。" });
      onProgress?.(index + 1, ranged.length, "正在替换范围文本");
      continue;
    }
    const raw = content.slice(locator.start, locator.end);
    if (isTechnicalJsRange(content, locator)) {
      blocked.push({ textItemId: item.id, reason: "脚本内部技术字段，已跳过，避免破坏流程或资源路径。" });
      onProgress?.(index + 1, ranged.length, "正在替换范围文本");
      continue;
    }
    if (isTechnicalHtmlAttributeRange(content, locator)) {
      blocked.push({ textItemId: item.id, reason: "HTML 技术属性，已跳过，避免破坏脚本选择器或运行时定位。" });
      onProgress?.(index + 1, ranged.length, "正在替换范围文本");
      continue;
    }
    const decoded = decodeRange(raw, locator.kind);
    if (decoded !== item.original) {
      blocked.push({ textItemId: item.id, reason: "原始范围校验失败，已跳过。" });
      onProgress?.(index + 1, ranged.length, "正在替换范围文本");
      continue;
    }
    replacements.push({
      start: locator.start,
      end: locator.end,
      value: encodeRangeReplacement(item.translation, raw, locator.kind)
    });
    lastAcceptedEnd = locator.end;
    onProgress?.(index + 1, ranged.length, "正在替换范围文本");
  }

  for (const item of items) {
    if (!parseRangeLocator(item.locator)) blocked.push({ textItemId: item.id, reason: "缺少可回填的范围定位，已跳过。" });
  }
  onProgress?.(ranged.length, Math.max(1, ranged.length), "范围文本替换完成", true);
  if (!replacements.length) return content;

  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    parts.push(content.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

export function parseRangeLocator(locator: string): ParsedRangeLocator | null {
  const match = locator.match(/^range:(\d+):(\d+):(html-text|html-attr|js-string|js-template-content|js-object-key|js-val-string|plain)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  return { start, end, kind: match[3] as RangeKind };
}

export function decodeRange(raw: string, kind: RangeKind): string {
  if (kind === "html-text" || kind === "html-attr") return decodeBasicHtml(raw);
  if (kind === "js-template-content") return decodeJsStringBody(raw, "`");
  if (kind === "js-string" || kind === "js-object-key") return decodeJsLiteral(raw);
  if (kind === "js-val-string") return decodeJsLiteral(raw).replace(/^val=/, "");
  return raw;
}

function isTechnicalJsRange(content: string, locator: ParsedRangeLocator): boolean {
  if (locator.kind !== "js-string" && locator.kind !== "js-template-content" && locator.kind !== "js-val-string" && locator.kind !== "js-object-key") return false;
  return isTechnicalJsValueKey(propertyKeyBeforeString(content, locator.start));
}

function isTechnicalHtmlAttributeRange(content: string, locator: ParsedRangeLocator): boolean {
  if (locator.kind !== "html-attr") return false;
  const tagStart = content.lastIndexOf("<", locator.start);
  if (tagStart < 0) return false;
  const beforeValue = content.slice(tagStart, locator.start);
  const attrName = beforeValue.match(/([:\w-]+)\s*=\s*["'][^"']*$/)?.[1]?.toLowerCase();
  if (!attrName) return false;
  return attrName === "alt"
    || attrName === "src"
    || attrName === "href"
    || attrName === "id"
    || attrName === "class"
    || attrName === "style"
    || attrName.startsWith("data-");
}

function propertyKeyBeforeString(text: string, stringStart: number): string {
  let index = stringStart - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (text[index] !== ":") return "";
  index -= 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (text[index] !== '"' && text[index] !== "'") return "";
  const quote = text[index];
  const end = index;
  index -= 1;
  while (index >= 0) {
    if (text[index] === quote && text[index - 1] !== "\\") return text.slice(index + 1, end);
    index -= 1;
  }
  return "";
}

function isTechnicalJsValueKey(key: string): boolean {
  return technicalJsValueKeys.has(key);
}

function encodeRangeReplacement(value: string, raw: string, kind: RangeKind): string {
  if (kind === "html-text") return escapeHtmlText(value);
  if (kind === "html-attr") return escapeHtmlAttr(value);
  if (kind === "js-template-content") return encodeJsStringBody(value, "`");
  if (kind === "js-string" || kind === "js-object-key") return encodeJsLiteral(value, raw[0] === "`" ? "`" : raw[0] === "'" ? "'" : '"');
  if (kind === "js-val-string") return encodeJsLiteral(`val=${value}`, raw[0] === "`" ? "`" : raw[0] === "'" ? "'" : '"');
  return value;
}

function applyJsonTranslations(content: string, items: TextItem[], blocked: PatchPreview["blocked"], onProgress?: ApplyItemProgressReporter): string {
  const json = JSON.parse(content) as unknown;
  onProgress?.(0, Math.max(1, items.length), "正在替换 JSON 文本", true);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!setJsonPath(json, item.locator, item.translation)) {
      blocked.push({ textItemId: item.id, reason: "JSON 路径不存在，已跳过。" });
    }
    onProgress?.(index + 1, items.length, "正在替换 JSON 文本");
  }
  onProgress?.(items.length, Math.max(1, items.length), "JSON 文本替换完成", true);
  return `${JSON.stringify(json, null, 2)}\n`;
}

function setJsonPath(root: unknown, locator: string, value: string): boolean {
  const parts = parseJsonPath(locator);
  let current: any = root;
  for (let index = 0; index < parts.length - 1; index += 1) current = current?.[parts[index]];
  if (current && parts.length && parts[parts.length - 1] in current) {
    current[parts[parts.length - 1]] = value;
    return true;
  }
  return false;
}

export function parseJsonPath(locator: string): string[] {
  const pathLocator = locator.startsWith("json:") ? locator.slice("json:".length) : locator;
  if (pathLocator === "$") return [];
  const parts: string[] = [];
  const pattern = /\[(?:"((?:\\.|[^"\\])*)"|(\d+))\]/g;
  for (const match of pathLocator.matchAll(pattern)) {
    if (match[2]) parts.push(match[2]);
    else parts.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
  }
  return parts;
}

export function isJsonLocator(locator: string): boolean {
  return locator.startsWith("json:");
}

export function validateLocatorAgainstContent(content: string, locator: string, original: string): LocatorValidationResult {
  if (isJsonLocator(locator)) {
    try {
      const root = JSON.parse(content) as unknown;
      const value = getJsonPath(root, locator);
      if (value !== original) return { ok: false, method: "json-path", message: "JSON path 指向内容与原文不一致。" };
      return { ok: true, method: "json-path" };
    } catch (error) {
      return { ok: false, method: "json-path", message: error instanceof Error ? error.message : "JSON path 校验失败。" };
    }
  }
  const range = parseRangeLocator(locator);
  if (range) {
    if (range.end > content.length) return { ok: false, method: "range", message: "范围超出文件长度。" };
    const decoded = decodeRange(content.slice(range.start, range.end), range.kind);
    if (decoded !== original) return { ok: false, method: "range", message: "原始范围校验失败。" };
    return { ok: true, method: "range" };
  }
  return { ok: false, method: "unsupported", message: "不支持的 locator。" };
}

function getJsonPath(root: unknown, locator: string): unknown {
  const parts = parseJsonPath(locator);
  let current: any = root;
  for (const part of parts) current = current?.[part];
  return current;
}

function decodeBasicHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function decodeJsLiteral(raw: string): string {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  return decodeJsStringBody(body, quote);
}

function decodeJsStringBody(body: string, quote: string): string {
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\v/g, "\v")
    .replace(/\\`/g, "`")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(new RegExp(`\\\\${escapeRegExp(quote)}`, "g"), quote);
}

function encodeJsLiteral(value: string, quote: string): string {
  return `${quote}${encodeJsStringBody(value, quote)}${quote}`;
}

function encodeJsStringBody(value: string, quote: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(new RegExp(escapeRegExp(quote), "g"), `\\${quote}`)
    .replace(/\$\{/g, "\\${");
  return escaped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) {
    const group = key(item);
    output.set(group, [...(output.get(group) ?? []), item]);
  }
  return output;
}
