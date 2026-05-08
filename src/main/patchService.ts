import fs from "node:fs/promises";
import path from "node:path";
import { PatchPreview, ProjectConfig, TextItem } from "../shared/types";
import { projectDirs, projectPaths, readJson, sha256, writeJson } from "./storage";

type RangeKind = "html-text" | "html-attr" | "js-string" | "js-val-string" | "plain";
const technicalJsValueKeys = new Set(["action_name", "base", "format", "path", "image", "icon", "sound", "src", "url"]);

interface ParsedRangeLocator {
  start: number;
  end: number;
  kind: RangeKind;
}

export async function previewPatch(project: ProjectConfig, items: TextItem[]): Promise<PatchPreview> {
  const dirs = projectDirs(project);
  const translated = items.filter((item) => item.translation && item.status === "translated");
  const byFile = groupBy(translated, (item) => item.sourceFile);
  const blocked: PatchPreview["blocked"] = [];
  const files: PatchPreview["files"] = [];
  for (const [sourceFile, fileItems] of byFile) {
    let replacements = 0;
    for (const item of fileItems) {
      if (!item.translation) continue;
      if (item.sourceType === "json") {
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

export async function applyPatch(project: ProjectConfig, items: TextItem[]): Promise<PatchPreview> {
  const preview = await previewPatch(project, items);
  const dirs = projectDirs(project);
  const translated = items.filter((item) => item.translation && item.status === "translated");
  const byFile = groupBy(translated, (item) => item.sourceFile);
  const appliedAt = new Date().toISOString();

  await rebuildWorkingCopy(project);

  for (const [sourceFile, fileItems] of byFile) {
    const originalPath = path.join(dirs.originalRoot, sourceFile);
    const fullPath = path.join(dirs.projectRoot, sourceFile);
    const originalContent = await fs.readFile(originalPath, "utf8");
    const backupPath = path.join(dirs.bgtRoot, "patches", "backup", `${appliedAt.replace(/[:.]/g, "-")}-${sourceFile.replace(/[\\/]/g, "__")}`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(originalPath, backupPath);

    const nextContent =
      fileItems[0]?.sourceType === "json"
        ? applyJsonTranslations(originalContent, fileItems, preview.blocked)
        : applyRangeTranslations(originalContent, fileItems, preview.blocked);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, nextContent, "utf8");
  }

  const manifestPath = projectPaths(project).patchManifest;
  const previous = await readJson<any[]>(manifestPath, []);
  previous.push({ appliedAt, files: preview.files, blocked: preview.blocked });
  await writeJson(manifestPath, previous);
  return preview;
}

export async function restoreWorkingCopy(project: ProjectConfig): Promise<void> {
  await rebuildWorkingCopy(project);
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

function applyRangeTranslations(content: string, items: TextItem[], blocked: PatchPreview["blocked"]): string {
  let next = content;
  const ranged = items
    .map((item) => ({ item, locator: parseRangeLocator(item.locator) }))
    .filter((entry): entry is { item: TextItem; locator: ParsedRangeLocator } => Boolean(entry.locator))
    .sort((a, b) => b.locator.start - a.locator.start);

  const seenRanges = new Set<string>();
  for (const { item, locator } of ranged) {
    const key = `${locator.start}:${locator.end}`;
    if (seenRanges.has(key)) {
      blocked.push({ textItemId: item.id, reason: "多个文本项指向同一范围，已跳过重复项。" });
      continue;
    }
    seenRanges.add(key);
    const raw = next.slice(locator.start, locator.end);
    if (isTechnicalJsRange(next, locator)) {
      blocked.push({ textItemId: item.id, reason: "AAOnline 内部脚本字段，已跳过，避免破坏流程或资源路径。" });
      continue;
    }
    const decoded = decodeRange(raw, locator.kind);
    if (sha256(item.original) !== item.originalHash || decoded !== item.original) {
      blocked.push({ textItemId: item.id, reason: "原始范围校验失败，已跳过。" });
      continue;
    }
    next = `${next.slice(0, locator.start)}${encodeRangeReplacement(item.translation, raw, locator.kind)}${next.slice(locator.end)}`;
  }

  for (const item of items) {
    if (!parseRangeLocator(item.locator)) blocked.push({ textItemId: item.id, reason: "缺少可回填的范围定位，已跳过。" });
  }
  return next;
}

function parseRangeLocator(locator: string): ParsedRangeLocator | null {
  const match = locator.match(/^range:(\d+):(\d+):(html-text|html-attr|js-string|js-val-string|plain)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  return { start, end, kind: match[3] as RangeKind };
}

function decodeRange(raw: string, kind: RangeKind): string {
  if (kind === "html-text" || kind === "html-attr") return decodeBasicHtml(raw);
  if (kind === "js-string") return decodeJsLiteral(raw);
  if (kind === "js-val-string") return decodeJsLiteral(raw).replace(/^val=/, "");
  return raw;
}

function isTechnicalJsRange(content: string, locator: ParsedRangeLocator): boolean {
  if (locator.kind !== "js-string" && locator.kind !== "js-val-string") return false;
  return isTechnicalJsValueKey(propertyKeyBeforeString(content, locator.start));
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
  if (kind === "js-string") return encodeJsLiteral(value, raw[0] === "`" ? "`" : raw[0] === "'" ? "'" : '"');
  if (kind === "js-val-string") return encodeJsLiteral(`val=${value}`, raw[0] === "`" ? "`" : raw[0] === "'" ? "'" : '"');
  return value;
}

function applyJsonTranslations(content: string, items: TextItem[], blocked: PatchPreview["blocked"]): string {
  const json = JSON.parse(content) as unknown;
  for (const item of items) {
    if (sha256(item.original) !== item.originalHash) {
      blocked.push({ textItemId: item.id, reason: "原文 hash 不一致，已跳过。" });
      continue;
    }
    if (!setJsonPath(json, item.locator, item.translation)) {
      blocked.push({ textItemId: item.id, reason: "JSON 路径不存在，已跳过。" });
    }
  }
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

function parseJsonPath(locator: string): string[] {
  if (locator === "$") return [];
  const parts: string[] = [];
  const pattern = /\[(?:"((?:\\.|[^"\\])*)"|(\d+))\]/g;
  for (const match of locator.matchAll(pattern)) {
    if (match[2]) parts.push(match[2]);
    else parts.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
  }
  return parts;
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
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(new RegExp(escapeRegExp(quote), "g"), `\\${quote}`)
    .replace(/\$\{/g, "\\${");
  return `${quote}${escaped}${quote}`;
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
