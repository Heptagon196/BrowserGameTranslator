import fs from "node:fs/promises";
import path from "node:path";
import { ScanReport, TextItem } from "../shared/types";
import { toPosixPath } from "./storage";

const includeExts = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".json", ".txt", ".csv", ".yaml", ".yml"]);
const excludedNames = new Set(["node_modules", ".git", ".bgt"]);
const excludedFiles = new Set(["bgt-scan-report.json", "bgt-extracted-text-items.jsonl"]);
const vendorPattern = /(jquery|pixi|phaser|three|vendor|\.min\.)/i;
const technicalJsValueKeys = new Set(["action_name", "base", "format", "path", "image", "icon", "sound", "src", "url"]);
const technicalStrings = new Set([
  "use strict",
  "setState",
  "forceUpdate",
  "childList",
  "className",
  "htmlFor",
  "httpEquiv",
  "acceptCharset",
  "contentEditable",
  "spellCheck",
  "dangerouslySetInnerHTML",
  "defaultValue",
  "defaultChecked",
  "innerHTML",
  "Capture",
  "@@iterator",
  "<anonymous>",
  "Lazy",
  "Suspense",
  "SuspenseList",
  "Fragment",
  "Portal",
  "Profiler",
  "StrictMode",
  "Context",
  ".Consumer",
  ".Provider",
  "ForwardRef(",
  "ForwardRef",
  "Memo",
  "Cache",
  "DehydratedFragment",
  "Root",
  "Text",
  "Mode",
  "Offscreen",
  "Scope",
  "TracingMarker",
  "Webkit",
  "Moz",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown"
]);

interface ExtractionContext {
  gameRoot: string;
  nextId: () => string;
}

interface ExtractionOptions {
  includeFiles?: string[];
  excludeFiles?: string[];
}

interface SourceRange {
  start: number;
  end: number;
  kind: "html-text" | "html-attr" | "js-string" | "js-val-string" | "plain";
}

interface ExtractorStrategy {
  id: string;
  label: string;
  canHandle(input: StrategyInput): boolean;
  extract(input: StrategyInput): TextItem[];
}

interface StrategyInput {
  filePath: string;
  text: string;
  ext: string;
  context: ExtractionContext;
}

interface JsScanRange {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

const extractorStrategies: ExtractorStrategy[] = [
  {
    id: "aaonline-html",
    label: "AAOnline single HTML trial data",
    canHandle: ({ ext, text }) => (ext === ".html" || ext === ".htm") && findAaOnlineDataRanges(text).length > 0,
    extract: ({ filePath, text, context }) => extractHtmlFile(filePath, text, context, findAaOnlineDataRanges(text))
  },
  {
    id: "json",
    label: "JSON string values",
    canHandle: ({ ext }) => ext === ".json",
    extract: ({ filePath, text, context }) => extractJsonFile(filePath, text, context)
  },
  {
    id: "html",
    label: "Generic HTML with embedded scripts",
    canHandle: ({ ext }) => ext === ".html" || ext === ".htm",
    extract: ({ filePath, text, context }) => extractHtmlFile(filePath, text, context)
  },
  {
    id: "javascript",
    label: "Generic JavaScript string literals",
    canHandle: ({ ext }) => ext === ".js" || ext === ".mjs" || ext === ".cjs",
    extract: ({ filePath, text, context }) => extractJsFile(filePath, text, context)
  },
  {
    id: "plain-text",
    label: "Line based text files",
    canHandle: () => true,
    extract: ({ filePath, text, ext, context }) => extractPlainTextFile(filePath, text, context, ext)
  }
];

export async function extractGameTexts(gameRoot: string, options: ExtractionOptions = {}): Promise<{ items: TextItem[]; report: ScanReport }> {
  const files = filterCandidateFiles(await listCandidateFiles(gameRoot), gameRoot, options);
  const items: TextItem[] = [];
  const reportFiles: ScanReport["files"] = [];
  let skippedCount = 0;
  let index = 1;
  const context: ExtractionContext = {
    gameRoot,
    nextId: () => `txt_${String(index++).padStart(6, "0")}`
  };

  for (const filePath of files) {
    try {
      const before = items.length;
      const extracted = await extractFile(filePath, context);
      for (const item of extracted.items) items.push(item);
      reportFiles.push({
        path: toPosixPath(path.relative(gameRoot, filePath)),
        type: path.extname(filePath).toLowerCase().replace(".", ""),
        extractedCount: items.length - before,
        strategy: extracted.strategy.id
      });
    } catch {
      skippedCount += 1;
    }
  }

  return {
    items,
    report: {
      scannedAt: new Date().toISOString(),
      fileCount: files.length,
      extractedCount: items.length,
      skippedCount,
      files: reportFiles
    }
  };
}

function filterCandidateFiles(files: string[], root: string, options: ExtractionOptions): string[] {
  const includes = (options.includeFiles ?? []).map(normalizePlanPattern).filter(Boolean);
  const excludes = (options.excludeFiles ?? []).map(normalizePlanPattern).filter(Boolean);
  return files.filter((file) => {
    const relative = toPosixPath(path.relative(root, file));
    if (excludes.some((pattern) => matchesPlanPattern(relative, pattern))) return false;
    if (includes.length && !includes.some((pattern) => matchesPlanPattern(relative, pattern))) return false;
    return true;
  });
}

function normalizePlanPattern(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.?\//, "").trim();
}

function matchesPlanPattern(file: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === file) return true;
  if (!pattern.includes("*")) return file.endsWith(pattern) || file.includes(pattern);
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
  return regex.test(file);
}

async function listCandidateFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludedNames.has(entry.name) && !toPosixPath(path.relative(root, fullPath)).includes("dist/vendor")) {
          await walk(fullPath);
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (includeExts.has(ext) && !excludedFiles.has(entry.name) && !entry.name.endsWith(".map") && !vendorPattern.test(entry.name)) {
        output.push(fullPath);
      }
    }
  }
  await walk(root);
  return output;
}

async function extractFile(filePath: string, context: ExtractionContext): Promise<{ items: TextItem[]; strategy: ExtractorStrategy }> {
  const ext = path.extname(filePath).toLowerCase();
  const text = await fs.readFile(filePath, "utf8");
  const input = { filePath, text, ext, context };
  const strategy = extractorStrategies.find((entry) => entry.canHandle(input)) ?? extractorStrategies[extractorStrategies.length - 1];
  return { items: strategy.extract(input), strategy };
}

function makeItem(context: ExtractionContext, filePath: string, locator: string, original: string): TextItem {
  return {
    id: context.nextId(),
    sourceFile: toPosixPath(path.relative(context.gameRoot, filePath)),
    locator,
    original,
    translation: "",
    status: "extracted",
    context: {}
  };
}

function makeRangeItem(context: ExtractionContext, filePath: string, range: SourceRange, original: string): TextItem {
  return makeItem(context, filePath, `range:${range.start}:${range.end}:${range.kind}`, original);
}

function shouldExtractString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  if (/^(?:\{|\[)/.test(trimmed) && /(?:\}|\])$/.test(trimmed)) return false;
  if (/^<[/]?[a-z][\w:-]*>$/.test(trimmed)) return false;
  if (/^(https?:\/\/|www\.|data:|blob:|\.\/|\.\.\/|\/)/i.test(trimmed)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return false;
  if (trimmed.includes("/") && !/\s/.test(trimmed)) return false;
  if (/^[.#]?[A-Za-z0-9_-]+(?:\[[^\]]+\]|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+)+$/.test(trimmed)) return false;
  if (/^[\d\s.,:;+\-*/()[\]{}<>_=|\\'"`~!@#$%^&?]+$/.test(trimmed)) return false;
  if (/^[A-Za-z0-9_./ -]+\.(png|jpg|jpeg|webp|gif|ogg|mp3|wav|json|js|css|svg|woff2?|ttf|map)$/i.test(trimmed)) return false;
  if (/^(true|false|null|undefined|function|return|object|number|string|boolean)$/i.test(trimmed)) return false;
  if (technicalStrings.has(trimmed)) return false;
  if (/(React\.|ReactDOM|Minified React error|setState\(|forceUpdate|forceFrameRate|dangerouslySetInnerHTML|contentEditable|HTMLIFrameElement|HTMLInputElement)/.test(trimmed)) return false;
  if (/(object with keys|If you meant to render|allowFullScreen|accent-height|xlink:|xml:)/.test(trimmed)) return false;
  if (/(?:^|\s)(children|props|component|hydration|rendered|element|attribute|event handler|production builds)(?:\s|$)/i.test(trimmed) && /[{}()[\]#]/.test(trimmed)) return false;
  if (/\\[bswWdD]|\\b|\\s/.test(trimmed) && !/\s/.test(trimmed.replace(/\\[nrt]/g, ""))) return false;
  if (/^[&?][A-Za-z0-9_[\]=&;-]+$/.test(trimmed)) return false;
  if (/^(?:[a-z][a-zA-Z]*\s+){10,}[a-z][a-zA-Z]*$/.test(trimmed)) return false;
  if (/^[a-z]+:[a-z-]+$/.test(trimmed)) return false;
  if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(trimmed)) return false;
  if (looksLikeAttributeList(trimmed)) return false;
  if (/^[a-z_$][a-z0-9_$-]*$/.test(trimmed)) return false;
  if (/^[A-Z0-9_$-]+$/.test(trimmed)) return false;
  return /[\p{L}\u3040-\u30ff\u3400-\u9fff]/u.test(trimmed);
}

function looksLikeAttributeList(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const technical = words.filter((word) => /^[a-z]+(?:[-:][a-z]+|[A-Z][A-Za-z0-9]*)+$/.test(word));
  return technical.length / words.length > 0.55;
}

function extractJsonFile(filePath: string, text: string, context: ExtractionContext): TextItem[] {
  const json = JSON.parse(text) as unknown;
  const items: TextItem[] = [];
  function walk(value: unknown, pathParts: string[]): void {
    if (typeof value === "string") {
      if (shouldExtractString(value)) items.push(makeItem(context, filePath, `json:${toJsonPath(pathParts)}`, value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...pathParts, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, entry]) => walk(entry, [...pathParts, key]));
    }
  }
  walk(json, []);
  return items;
}

function extractHtmlFile(filePath: string, text: string, context: ExtractionContext, scriptScanRanges?: JsScanRange[]): TextItem[] {
  const items: TextItem[] = [];
  const scriptRanges = findTagRanges(text, "script");
  const styleRanges = findTagRanges(text, "style");
  const blockedRanges = [...scriptRanges, ...styleRanges].sort((a, b) => a.start - b.start);

  for (const range of scriptScanRanges ?? scriptRanges) {
    const script = text.slice(range.innerStart, range.innerEnd);
    for (const entry of extractJsStrings(script, range.innerStart)) {
      items.push(makeRangeItem(context, filePath, entry.range, entry.value));
    }
  }

  for (const match of text.matchAll(/<([a-z][\w:-]*)(?:\s[^<>]*)?>/gi)) {
    const tagStart = match.index ?? 0;
    const tagEnd = tagStart + match[0].length;
    if (isInsideAnyRange(tagStart, blockedRanges)) continue;
    const tag = match[0];
    for (const attr of tag.matchAll(/\s(title|alt|placeholder|aria-label|data-[\w-]+)=("([^"]*)"|'([^']*)')/gi)) {
      const value = attr[3] ?? attr[4] ?? "";
      const valueStart = tagStart + (attr.index ?? 0) + attr[0].lastIndexOf(value);
      const decoded = decodeBasicHtml(value.trim());
      if (!shouldExtractString(decoded)) continue;
      const trimmedStart = valueStart + leadingWhitespaceLength(value);
      const trimmedEnd = valueStart + value.length - trailingWhitespaceLength(value);
      items.push(makeRangeItem(context, filePath, { start: trimmedStart, end: trimmedEnd, kind: "html-attr" }, decoded));
    }
    if (tagEnd > tagStart) continue;
  }

  for (const match of text.matchAll(/>([^<>]+)</g)) {
    const rangeStart = (match.index ?? 0) + 1;
    const raw = match[1];
    if (isInsideAnyRange(rangeStart, blockedRanges)) continue;
    const decoded = decodeBasicHtml(raw.trim());
    if (!shouldExtractString(decoded)) continue;
    const trimmedStart = rangeStart + leadingWhitespaceLength(raw);
    const trimmedEnd = rangeStart + raw.length - trailingWhitespaceLength(raw);
    items.push(makeRangeItem(context, filePath, { start: trimmedStart, end: trimmedEnd, kind: "html-text" }, decoded));
  }

  return uniqueByLocator(items);
}

function findAaOnlineDataRanges(text: string): JsScanRange[] {
  const ranges = [
    findJsVariableValueRange(text, "trial_information"),
    findJsVariableValueRange(text, "initial_trial_data")
  ].filter((range): range is { start: number; end: number; innerStart: number; innerEnd: number } => Boolean(range));
  return ranges.length ? ranges : [];
}

function findJsVariableValueRange(text: string, variableName: string): JsScanRange | null {
  const declaration = new RegExp(`\\bvar\\s+${escapeRegExp(variableName)}\\s*=\\s*`, "g");
  const match = declaration.exec(text);
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  const valueEnd = findJsExpressionEnd(text, valueStart);
  if (valueEnd <= valueStart) return null;
  return { start: valueStart, end: valueEnd, innerStart: valueStart, innerEnd: valueEnd };
}

function findJsExpressionEnd(text: string, start: number): number {
  const stack: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const parsed = readJsString(text, index, char);
      if (!parsed) return index;
      index = parsed.end - 1;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      stack.pop();
      continue;
    }
    if (char === ";" && !stack.length) return index;
  }
  return text.length;
}

function extractJsFile(filePath: string, text: string, context: ExtractionContext): TextItem[] {
  return extractJsStrings(text, 0).map(({ range, value }) => makeRangeItem(context, filePath, range, value));
}

function extractJsStrings(text: string, offset: number): Array<{ range: SourceRange; value: string }> {
  const items: Array<{ range: SourceRange; value: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    if (char !== '"' && char !== "'" && char !== "`") continue;
    const parsed = readJsString(text, index, char);
    if (!parsed) continue;
    index = parsed.end - 1;
    if (char === "`" && parsed.raw.includes("${")) continue;
    if (isLikelyObjectKey(text, parsed.end)) continue;
    const propertyKey = propertyKeyBeforeString(text, parsed.start);
    if (isTechnicalJsValueKey(propertyKey)) continue;
    const value = unescapeJs(parsed.raw, char).trim();
    const aaValue = normalizeAaOnlineValString(value);
    if (aaValue !== null) {
      if (!shouldExtractString(aaValue)) continue;
      items.push({
        range: { start: offset + parsed.start, end: offset + parsed.end, kind: "js-val-string" },
        value: aaValue
      });
      continue;
    }
    if (!shouldExtractString(value)) continue;
    const leading = leadingWhitespaceLength(unescapeJs(parsed.raw, char));
    const trailing = trailingWhitespaceLength(unescapeJs(parsed.raw, char));
    if (leading || trailing) continue;
    items.push({
      range: { start: offset + parsed.start, end: offset + parsed.end, kind: "js-string" },
      value
    });
  }
  return items;
}

function normalizeAaOnlineValString(value: string): string | null {
  if (!value.startsWith("val=")) return null;
  return value.slice(4).trim();
}

function readJsString(text: string, start: number, quote: string): { start: number; end: number; raw: string } | null {
  let index = start + 1;
  let raw = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      raw += char + (text[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === quote) return { start, end: index + 1, raw };
    if ((char === "\n" || char === "\r") && quote !== "`") return null;
    raw += char;
    index += 1;
  }
  return null;
}

function isLikelyObjectKey(text: string, stringEnd: number): boolean {
  let index = stringEnd;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return text[index] === ":";
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

function extractPlainTextFile(filePath: string, text: string, context: ExtractionContext, ext: string): TextItem[] {
  const items: TextItem[] = [];
  let offset = 0;
  for (const line of text.split(/(\r?\n)/)) {
    if (/^\r?\n$/.test(line)) {
      offset += line.length;
      continue;
    }
    const trimmed = line.trim();
    if (shouldExtractString(trimmed)) {
      const start = offset + leadingWhitespaceLength(line);
      const end = offset + line.length - trailingWhitespaceLength(line);
      items.push(makeRangeItem(context, filePath, { start, end, kind: "plain" }, trimmed));
    }
    offset += line.length;
  }
  return items;
}

function findTagRanges(text: string, tagName: string): Array<{ start: number; end: number; innerStart: number; innerEnd: number }> {
  const ranges: Array<{ start: number; end: number; innerStart: number; innerEnd: number }> = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const innerStart = start + match[0].indexOf(">") + 1;
    const end = start + match[0].length;
    ranges.push({ start, end, innerStart, innerEnd: end - `</${tagName}>`.length });
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function skipLineComment(text: string, index: number): number {
  while (index < text.length && text[index] !== "\n") index += 1;
  return index;
}

function skipBlockComment(text: string, index: number): number {
  while (index < text.length - 1) {
    if (text[index] === "*" && text[index + 1] === "/") return index + 1;
    index += 1;
  }
  return index;
}

function toJsonPath(parts: string[]): string {
  if (!parts.length) return "$";
  return `$${parts.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `[${JSON.stringify(part)}]`)).join("")}`;
}

function uniqueByLocator(items: TextItem[]): TextItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceFile}:${item.locator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function leadingWhitespaceLength(value: string): number {
  return value.length - value.trimStart().length;
}

function trailingWhitespaceLength(value: string): number {
  return value.length - value.trimEnd().length;
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

function unescapeJs(value: string, quote: string): string {
  return value
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
