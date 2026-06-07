import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as acorn from "acorn";
import {
  ExtractionAiRecommendation,
  ExtractionBackfillSummary,
  ExtractionCandidate,
  ExtractionRisk,
  ExtractionRule,
  ExtractionRuleGroup,
  ExtractionRuleMatcher,
  ExtractionRuleReport,
  ExtractionRuleScanResult,
  ExtractionScanProgress,
  ExtractionSourceRole,
  ExtractionStrategyId,
  ExtractionTextStats,
  ScanReport,
  TextItem
} from "../shared/types";
import { toPosixPath } from "./storage";

const includeExts = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".json", ".txt", ".csv", ".yaml", ".yml"]);
const excludedNames = new Set(["node_modules", ".git", ".bgt"]);
const excludedFiles = new Set(["bgt-scan-report.json", "bgt-extracted-text-items.jsonl"]);
const vendorPattern = /(jquery|pixi|phaser|three|vendor|\.min\.)/i;
const technicalJsValueKeys = new Set([
  "action_name",
  "base",
  "className",
  "color",
  "colour",
  "d",
  "file",
  "files",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "format",
  "background_color",
  "background_colour",
  "conv_type",
  "event",
  "href",
  "icon",
  "id",
  "image",
  "links",
  "path",
  "src",
  "style",
  "sound",
  "scene_type",
  "section_type",
  "text_color",
  "text_colour",
  "trigger",
  "triggers",
  "type",
  "type_lock",
  "url"
]);
const jsRecordFieldKeys = new Set(["id", "content", "type", "theme", "links", "trigger", "triggers", "style", "hasDevilContent", "hasDevil2Content"]);
const technicalStrings = new Set([
  "use strict",
  "setState",
  "forceUpdate",
  "childList",
  "modulepreload",
  "use-credentials",
  "same-origin",
  "anonymous",
  "className",
  "htmlFor",
  "httpEquiv",
  "acceptCharset",
  "contentEditable",
  "d",
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
  "ArrowDown",
  "keydown",
  "keyup",
  "click",
  "change",
  "input",
  "submit"
]);

interface ExtractionContext {
  gameRoot: string;
  scriptDataBlocks: ScriptDataBlockHint[];
  nextId: () => string;
}

interface FileMetrics {
  lineStarts: number[];
  lineLengths: number[];
  minifiedRatio: number;
}

export interface ScriptDataBlockHint {
  id: string;
  label: string;
  variables: string[];
}

export interface ExtractionOptions {
  includeFiles?: string[];
  excludeFiles?: string[];
  scriptDataBlocks?: ScriptDataBlockHint[];
  onProgress?: (progress: ExtractionScanProgress) => void;
}

type FileProgressReporter = (fileProgress: number, fileStep: string, force?: boolean) => void;

interface SourceRange {
  start: number;
  end: number;
  kind: "html-text" | "html-attr" | "js-string" | "js-template-content" | "js-object-key" | "js-val-string" | "plain";
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
  onProgress?: FileProgressReporter;
}

interface JsScanRange {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  name?: string;
}

interface JsTemplateLiteral {
  start: number;
  end: number;
  parts: Array<{ start: number; end: number; raw: string }>;
}

interface JsStringExtraction {
  range: SourceRange;
  value: string;
  keyName?: string;
  keyPath?: string;
  sourceRole?: ExtractionSourceRole;
}

interface JsAstStringInfo {
  sourceRole: ExtractionSourceRole;
}

interface JsStructureFrame {
  type: "object" | "array";
  path: string[];
  pendingKey?: string;
}

const extractorStrategies: ExtractorStrategy[] = [
  {
    id: "json",
    label: "JSON string values",
    canHandle: ({ ext }) => ext === ".json",
    extract: ({ filePath, text, context, onProgress }) => extractJsonFile(filePath, text, context, onProgress)
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
    extract: ({ filePath, text, context, onProgress }) => extractJsFile(filePath, text, context, onProgress)
  },
  {
    id: "csv",
    label: "CSV cells",
    canHandle: ({ ext }) => ext === ".csv",
    extract: ({ filePath, text, context, onProgress }) => extractCsvFile(filePath, text, context, onProgress)
  },
  {
    id: "yaml",
    label: "YAML scalar strings",
    canHandle: ({ ext }) => ext === ".yaml" || ext === ".yml",
    extract: ({ filePath, text, context, onProgress }) => extractYamlFile(filePath, text, context, onProgress)
  },
  {
    id: "plain-text",
    label: "Line based text files",
    canHandle: () => true,
    extract: ({ filePath, text, ext, context, onProgress }) => extractPlainTextFile(filePath, text, context, ext, onProgress)
  }
];

export async function extractGameTexts(gameRoot: string, options: ExtractionOptions = {}): Promise<{ items: TextItem[]; report: ScanReport }> {
  const scan = await scanExtractionCandidates(gameRoot, options);
  const rules = rulesFromIncludedGroups(scan.groups.filter((group) => group.backfillSummary.failed === 0 && group.backfillSummary.unsupported === 0));
  const items = materializeTextItemsFromRules(scan.candidates, rules);
  return {
    items,
    report: {
      scannedAt: scan.report.scannedAt,
      fileCount: scan.report.fileCount,
      extractedCount: items.length,
      skippedCount: 0,
      files: scan.groups.flatMap((group) =>
        group.fileDistribution.map((file) => ({
          path: file.sourceFile,
          type: path.extname(file.sourceFile).replace(".", ""),
          extractedCount: file.count,
          strategy: group.strategy
        }))
      )
    }
  };
}

export async function scanExtractionCandidates(gameRoot: string, options: ExtractionOptions = {}): Promise<ExtractionRuleScanResult> {
  options.onProgress?.({
    phase: "enumerating",
    fileCurrent: 0,
    fileTotal: 0,
    fileProgress: 0,
    fileStep: "枚举文件",
    message: "正在枚举可扫描文件..."
  });
  const files = filterCandidateFiles(await listCandidateFiles(gameRoot), gameRoot, options);
  const candidates: ExtractionCandidate[] = [];
  let skippedCount = 0;
  let index = 1;
  const context: ExtractionContext = {
    gameRoot,
    scriptDataBlocks: options.scriptDataBlocks ?? [],
    nextId: () => `txt_${String(index++).padStart(6, "0")}`
  };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const filePath = files[fileIndex];
    const currentFile = toPosixPath(path.relative(gameRoot, filePath));
    let lastProgressEmit = 0;
    const emitFileProgress: FileProgressReporter = (fileProgress, fileStep, force = false) => {
      const safeProgress = Math.max(0, Math.min(100, fileProgress));
      const now = Date.now();
      if (!force && now - lastProgressEmit < 80 && safeProgress < 100) return;
      lastProgressEmit = now;
      options.onProgress?.({
        phase: "scanning",
        fileCurrent: fileIndex + safeProgress / 100,
        fileTotal: files.length,
        currentFile,
        fileProgress: safeProgress,
        fileStep,
        message: `正在扫描 ${fileIndex + 1}/${files.length}`
      });
    };
    try {
      emitFileProgress(3, "读取文件", true);
      const text = await fs.readFile(filePath, "utf8");
      emitFileProgress(10, "识别文件类型", true);
      const extracted = extractFile(filePath, text, context, emitFileProgress);
      const fileMetrics = buildFileMetrics(text);
      emitFileProgress(92, "生成候选记录", true);
      for (const item of extracted.items) candidates.push(makeCandidate(gameRoot, filePath, text, fileMetrics, item, extracted.strategy.id));
      emitFileProgress(100, "完成当前文件", true);
    } catch {
      skippedCount += 1;
      emitFileProgress(100, "跳过无法读取的文件", true);
    }
  }
  options.onProgress?.({
    phase: "grouping",
    fileCurrent: files.length,
    fileTotal: files.length,
    fileProgress: 100,
    fileStep: "整理规则组",
    message: "正在整理候选文本和规则组..."
  });
  const uniqueCandidates = markDuplicateLocators(candidates);
  const groups = groupExtractionCandidates(uniqueCandidates);
  const report = buildExtractionRuleReport(files.length, uniqueCandidates, groups, skippedCount);
  return { candidates: uniqueCandidates, groups, report };
}

export function groupExtractionCandidates(candidates: ExtractionCandidate[]): ExtractionRuleGroup[] {
  const now = new Date().toISOString();
  const byGroup = groupBy(candidates, (candidate) => candidate.groupKey);
  return Array.from(byGroup.entries())
    .map(([groupKey, rows], index) => {
      const risks = unique(rows.flatMap((candidate) => candidate.risks));
      const backfillSummary = summarizeBackfill(rows);
      const strategy = rows[0]?.strategy ?? "plain-text";
      const autoDelete = shouldAutoDeleteGroup(rows, risks);
      const ai = autoDelete ? markRecommendationAsDeleted(heuristicAiRecommendation(rows, risks, backfillSummary)) : heuristicAiRecommendation(rows, risks, backfillSummary);
      const initialDecision = autoDelete ? "deleted" : ai.recommendation === "include" ? "include" : ai.recommendation === "exclude" ? "exclude" : "pending";
      return {
        id: `grp_${String(index + 1).padStart(4, "0")}`,
        groupKey,
        label: labelForGroup(groupKey, rows),
        strategy,
        matcher: matcherForGroup(groupKey, strategy, rows),
        candidateCount: rows.length,
        sampleCandidateIds: sampleCandidates(rows).map((candidate) => candidate.id),
        fileDistribution: Array.from(groupBy(rows, (candidate) => candidate.sourceFile).entries())
          .map(([sourceFile, fileRows]) => ({ sourceFile, count: fileRows.length }))
          .sort((a, b) => b.count - a.count),
        textStats: buildTextStats(rows),
        risks,
        backfillSummary,
        ai,
        userDecision: { decision: initialDecision, origin: "scan", updatedAt: now },
        createdAt: now,
        updatedAt: now
      } satisfies ExtractionRuleGroup;
    })
    .sort(compareExtractionRuleGroups);
}

export function rulesFromIncludedGroups(groups: ExtractionRuleGroup[]): ExtractionRule[] {
  return groups
    .filter((group) => group.userDecision.decision === "include")
    .map((group) => ({
      id: `rule_${stableHash(group.groupKey).slice(0, 12)}`,
      strategy: group.strategy,
      label: group.label,
      matcher: group.matcher,
      decision: "include",
      backfill: {
        method: group.backfillSummary.safe > 0 ? (group.strategy === "json-string" ? "json-path" : "range") : "unsupported",
        requiresValidation: true
      },
      risks: group.risks
    }));
}

export function materializeTextItemsFromRules(candidates: ExtractionCandidate[], rules: ExtractionRule[]): TextItem[] {
  const includeRules = rules.filter((rule) => rule.decision === "include");
  const seen = new Set<string>();
  const items: TextItem[] = [];
  let index = 1;
  for (const candidate of candidates) {
    if (!candidate.backfill.supported || candidate.backfill.validation === "failed") continue;
    if (!includeRules.some((rule) => candidateMatchesRule(candidate, rule.matcher))) continue;
    const key = `${candidate.sourceFile}:${candidate.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `txt_${String(index++).padStart(6, "0")}`,
      sourceFile: candidate.sourceFile,
      locator: candidate.locator,
      original: candidate.original,
      translation: "",
      status: "extracted"
    });
  }
  return items;
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
      if (includeExts.has(ext) && !excludedFiles.has(entry.name) && !entry.name.endsWith(".map") && !entry.name.endsWith("-metadata.json") && !vendorPattern.test(entry.name)) {
        output.push(fullPath);
      }
    }
  }
  await walk(root);
  return output;
}

function extractFile(filePath: string, text: string, context: ExtractionContext, onProgress?: FileProgressReporter): { items: TextItem[]; strategy: ExtractorStrategy } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const htmlStrategy = extractorStrategies.find((entry) => entry.id === "html") ?? extractorStrategies[0];
    onProgress?.(14, "识别规则包声明的数据区块", true);
    const dataBlockRanges = findJsDataBlockRanges(text, context.scriptDataBlocks, (current, total) => {
      onProgress?.(14 + (total ? current / total : 1) * 10, "识别规则包声明的数据区块");
    });
    onProgress?.(25, dataBlockRanges.length ? "扫描 HTML 与脚本文本" : "扫描 HTML 文本", true);
    return { items: extractHtmlFile(filePath, text, context, dataBlockRanges, onProgress), strategy: htmlStrategy };
  }
  const input = { filePath, text, ext, context, onProgress };
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
  const bracketMarkupText = stripBracketInlineMarkupForTextCheck(trimmed);
  const hasBracketInlineText = bracketMarkupText !== trimmed && hasExtractableLetters(bracketMarkupText);
  if (trimmed.length < 2) return false;
  if (/^(?:\{|\[)/.test(trimmed) && /(?:\}|\])$/.test(trimmed) && !hasBracketInlineText) return false;
  if (/^<[/]?[a-z][\w:-]*>$/.test(trimmed)) return false;
  if (/^(https?:\/\/|www\.|data:|blob:|\.\/|\.\.\/|\/)/i.test(trimmed)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return false;
  if (trimmed.includes("/") && !/\s/.test(trimmed)) return false;
  if (/^[.#]?[A-Za-z0-9_-]+(?:\[[^\]]+\]|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+)+$/.test(trimmed)) return false;
  if (/^[\d\s.,:;+\-*/()[\]{}<>_=|\\'"`~!@#$%^&?]+$/.test(trimmed)) return false;
  if (/^[A-Za-z0-9_./ -]+\.(png|jpg|jpeg|webp|gif|ogg|mp3|wav|json|js|css|svg|woff2?|ttf|map)$/i.test(trimmed)) return false;
  if (/^(true|false|null|undefined|function|return|object|number|string|boolean)$/i.test(trimmed)) return false;
  if (technicalStrings.has(trimmed)) return false;
  if (looksLikeHtmlTagName(trimmed)) return false;
  if (looksLikeCssClassList(trimmed)) return false;
  if (/(React\.|ReactDOM|Minified React error|setState\(|forceUpdate|forceFrameRate|dangerouslySetInnerHTML|contentEditable|HTMLIFrameElement|HTMLInputElement)/.test(trimmed)) return false;
  if (/(object with keys|If you meant to render|allowFullScreen|accent-height|xlink:|xml:)/.test(trimmed)) return false;
  if (/(?:^|\s)(children|props|component|hydration|rendered|element|attribute|event handler|production builds)(?:\s|$)/i.test(trimmed) && /[{}()[\]#]/.test(trimmed)) return false;
  if (/\\[bswWdD]|\\b|\\s/.test(trimmed) && !/\s/.test(trimmed.replace(/\\[nrt]/g, ""))) return false;
  if (/^[&?][A-Za-z0-9_[\]=&;-]+$/.test(trimmed)) return false;
  if (/^(?:[a-z][a-zA-Z]*\s+){10,}[a-z][a-zA-Z]*$/.test(trimmed)) return false;
  if (/^[a-z]+:[a-z-]+$/.test(trimmed)) return false;
  if (looksLikeAttributeList(trimmed)) return false;
  if (looksLikeSvgPathData(trimmed)) return false;
  return hasExtractableLetters(trimmed);
}

function stripBracketInlineMarkupForTextCheck(value: string): string {
  return value.replace(/\[#\/?[^\]\r\n]*\]/g, " ").trim();
}

function hasExtractableLetters(value: string): boolean {
  return /[\p{L}\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

function looksLikeAttributeList(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const technical = words.filter((word) => /^[a-z]+(?:[-:][a-z]+|[A-Z][A-Za-z0-9]*)+$/.test(word));
  return technical.length / words.length > 0.55;
}

function looksLikeHtmlTagName(value: string): boolean {
  return /^(?:a|abbr|address|article|aside|audio|b|blockquote|body|br|button|canvas|code|dd|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|legend|li|main|nav|ol|option|p|pre|script|section|select|small|span|strong|style|svg|table|tbody|td|textarea|th|thead|title|tr|ul|video)$/i.test(value.trim());
}

function looksLikeSvgPathData(value: string): boolean {
  return /\d/.test(value) && /^[MmZzLlHhVvCcSsQqTtAaRr0-9,.\s+-]+$/.test(value.trim());
}

function looksLikeCssClassList(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const cssLike = words.filter((word) => {
    if (/[^\w:[\]/.%#()!,=-]/.test(word)) return false;
    if (/^(?:hover|focus|active|disabled|group-hover|md|lg|xl|sm|dark|motion-safe|motion-reduce):/.test(word)) return true;
    if (/^(?:bg|text|border|flex|grid|block|inline|hidden|fixed|absolute|relative|sticky|inset|top|right|bottom|left|z|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|min|max|font|leading|tracking|rounded|shadow|opacity|overflow|space|gap|items|justify|content|self|whitespace|animate|transition|duration|ease|cursor|select|pointer|object|aspect|list|decoration|underline|uppercase|lowercase|capitalize|truncate|container|sr)-/.test(word)) return true;
    if (/^(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|uppercase|lowercase|capitalize|truncate)$/.test(word)) return true;
    return false;
  });
  return cssLike.length / words.length >= 0.65;
}

function extractJsonFile(filePath: string, text: string, context: ExtractionContext, onProgress?: FileProgressReporter): TextItem[] {
  onProgress?.(18, "解析 JSON", true);
  const json = JSON.parse(text) as unknown;
  const items: TextItem[] = [];
  let visited = 0;
  function walk(value: unknown, pathParts: string[]): void {
    visited += 1;
    if (visited % 500 === 0) onProgress?.(20 + Math.min(65, visited / 500), "遍历 JSON 字段");
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
  onProgress?.(88, "JSON 字段扫描完成", true);
  return items;
}

function extractHtmlFile(filePath: string, text: string, context: ExtractionContext, dataBlockRanges: JsScanRange[] = [], onProgress?: FileProgressReporter): TextItem[] {
  const items: TextItem[] = [];
  onProgress?.(28, "定位脚本和样式区块", true);
  const scriptRanges = findTagRanges(text, "script");
  const styleRanges = findTagRanges(text, "style");
  const blockedRanges = [...scriptRanges, ...styleRanges].sort((a, b) => a.start - b.start);

  const activeScriptRanges: JsScanRange[] = scriptRanges;
  const scriptTotal = activeScriptRanges.reduce((sum, range) => sum + Math.max(1, range.innerEnd - range.innerStart), 0);
  let scriptScanned = 0;
  for (const range of activeScriptRanges) {
    const script = text.slice(range.innerStart, range.innerEnd);
    for (const entry of extractJsStrings(script, range.innerStart, (current, total) => {
      onProgress?.(30 + ((scriptScanned + current) / Math.max(1, scriptTotal)) * 45, "扫描脚本字符串");
      if (current >= total) scriptScanned += Math.max(1, total);
    })) {
      const item = makeRangeItem(context, filePath, entry.range, entry.value);
      const dataBlock = containingDataBlock(entry.range, dataBlockRanges);
      if (dataBlock?.name || entry.keyPath) {
        item.context = item.context ?? {};
        const keyPath = entry.keyPath ? `${dataBlock?.name ? `${dataBlock.name}.` : ""}${entry.keyPath}` : "";
        item.context.before = dataBlock?.name ? `data-block:${dataBlock.name}${keyPath ? `;path:${keyPath}` : ""}` : `js-path:${keyPath}`;
      }
      if (entry.sourceRole) {
        item.context = item.context ?? {};
        item.context.after = `source-role:${entry.sourceRole}`;
      }
      items.push(item);
    }
    if (!script.length) scriptScanned += 1;
  }

  onProgress?.(76, "扫描 HTML 属性", true);
  for (const match of text.matchAll(/<([a-z][\w:-]*)(?:\s[^<>]*)?>/gi)) {
    const tagStart = match.index ?? 0;
    if (tagStart % 100000 < 2000) onProgress?.(76 + (tagStart / Math.max(1, text.length)) * 8, "扫描 HTML 属性");
    const tagEnd = tagStart + match[0].length;
    if (isInsideAnyRange(tagStart, blockedRanges)) continue;
    const tag = match[0];
    for (const attr of tag.matchAll(/\s(title|alt|placeholder|aria-label|label|value)=("([^"]*)"|'([^']*)')/gi)) {
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

  onProgress?.(85, "扫描 HTML 可见文本", true);
  for (const match of text.matchAll(/>([^<>]+)</g)) {
    const rangeStart = (match.index ?? 0) + 1;
    if (rangeStart % 100000 < 2000) onProgress?.(85 + (rangeStart / Math.max(1, text.length)) * 5, "扫描 HTML 可见文本");
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

function findJsDataBlockRanges(text: string, dataBlocks: ScriptDataBlockHint[], onProgress?: (current: number, total: number) => void): JsScanRange[] {
  const variables = unique(dataBlocks.flatMap((block) => block.variables.map((variable) => variable.trim()).filter(Boolean)));
  if (!variables.length) return [];
  const ranges: JsScanRange[] = [];
  for (let index = 0; index < variables.length; index += 1) {
    const variableName = variables[index];
    const range = findJsVariableValueRange(text, variableName, (current, total) => {
      onProgress?.(index + (total ? current / total : 1), variables.length);
    });
    if (range) ranges.push({ ...range, name: variableName });
  }
  onProgress?.(variables.length, variables.length);
  return ranges;
}

function containingDataBlock(range: SourceRange, dataBlockRanges: JsScanRange[]): JsScanRange | undefined {
  return dataBlockRanges.find((block) => range.start >= block.innerStart && range.end <= block.innerEnd);
}

function findJsVariableValueRange(text: string, variableName: string, onProgress?: (current: number, total: number) => void): JsScanRange | null {
  const escaped = escapeRegExp(variableName);
  const patterns = [
    new RegExp(`\\b(?:var|let|const)\\s+${escaped}\\s*=\\s*`, "g"),
    new RegExp(`\\b(?:window|globalThis|self)\\.${escaped}\\s*=\\s*`, "g")
  ];
  const match = patterns.map((pattern) => pattern.exec(text)).filter(Boolean).sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))[0];
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  const valueEnd = findJsExpressionEnd(text, valueStart, onProgress);
  if (valueEnd <= valueStart) return null;
  return { start: valueStart, end: valueEnd, innerStart: valueStart, innerEnd: valueEnd };
}

function findJsExpressionEnd(text: string, start: number, onProgress?: (current: number, total: number) => void): number {
  const stack: string[] = [];
  const progressStep = Math.max(50000, Math.floor((text.length - start) / 100));
  for (let index = start; index < text.length; index += 1) {
    if ((index - start) % progressStep === 0) onProgress?.(index - start, text.length - start);
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
  onProgress?.(text.length - start, text.length - start);
  return text.length;
}

function extractJsFile(filePath: string, text: string, context: ExtractionContext, onProgress?: FileProgressReporter): TextItem[] {
  return extractJsStrings(text, 0, (current, total) => {
    onProgress?.(18 + (total ? current / total : 1) * 70, "扫描 JavaScript 字符串");
  }).map(({ range, value, keyPath, sourceRole }) => {
    const item = makeRangeItem(context, filePath, range, value);
    if (keyPath) {
      item.context = item.context ?? {};
      item.context.before = `js-path:${keyPath}`;
    }
    if (sourceRole) {
      item.context = item.context ?? {};
      item.context.after = `source-role:${sourceRole}`;
    }
    return item;
  });
}

function extractJsStrings(text: string, offset: number, onProgress?: (current: number, total: number) => void): JsStringExtraction[] {
  const items: JsStringExtraction[] = [];
  const stack: JsStructureFrame[] = [];
  const astStrings = buildJsAstStringInfo(text);
  const progressStep = Math.max(50000, Math.floor(text.length / 100));
  for (let index = 0; index < text.length; index += 1) {
    if (index % progressStep === 0) onProgress?.(index, text.length);
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
    if (char === "{" || char === "[") {
      const type = char === "{" ? "object" : "array";
      stack.push({ type, path: pathForNestedContainer(stack, type) });
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      clearConsumedObjectKey(stack);
      continue;
    }
    if (char === ",") {
      clearConsumedObjectKey(stack);
      continue;
    }
    if (char === ":") {
      const frame = stack.at(-1);
      const key = frame?.type === "object" ? objectKeyBeforeColon(text, index) : undefined;
      if (key) frame!.pendingKey = key;
      continue;
    }
    if (char !== '"' && char !== "'" && char !== "`") continue;
    if (char === "`") {
      if (!canStartJsTemplateLiteral(text, index)) continue;
      const parsedTemplate = readJsTemplateLiteral(text, index);
      if (!parsedTemplate) continue;
      index = parsedTemplate.end - 1;
      const propertyKey = propertyKeyBeforeString(text, parsedTemplate.start);
      if (isTechnicalJsValueKey(propertyKey)) continue;
      const keyName = keyNameForJsValue(stack, propertyKey);
      const keyPath = specializeAnonymousJsArrayPath(text, parsedTemplate.start, keyPathForJsValue(stack, propertyKey));
      if (keyName && isTechnicalJsValueKey(keyName)) continue;
      if (parsedTemplate.parts.length === 1) {
        const rawValue = unescapeJs(parsedTemplate.parts[0].raw, "`");
        const htmlTemplateParts = extractHtmlTemplateTextEntries(rawValue, offset + parsedTemplate.parts[0].start, keyName, keyPath);
        if (htmlTemplateParts.length) {
          items.push(...htmlTemplateParts);
          continue;
        }
      }
      for (const part of parsedTemplate.parts) {
        const rawValue = unescapeJs(part.raw, "`");
        const value = rawValue.trim();
        if (!shouldExtractString(value)) continue;
        const leading = leadingWhitespaceLength(rawValue);
        const trailing = trailingWhitespaceLength(rawValue);
        items.push({
          range: { start: offset + part.start + leading, end: offset + part.end - trailing, kind: "js-template-content" },
          value,
          keyName,
          keyPath,
          sourceRole: sourceRoleForExtractedJsString(value, keyName, keyPath, astStrings.get(`${parsedTemplate.start}:${parsedTemplate.end}`)?.sourceRole)
        });
      }
      continue;
    }
    const parsed = readJsString(text, index, char);
    if (!parsed) continue;
    index = parsed.end - 1;
    const rawValue = unescapeJs(parsed.raw, char);
    const astInfo = astStrings.get(`${parsed.start}:${parsed.end}`);
    if (isLikelyObjectKey(text, parsed.end)) {
      const frame = stack.at(-1);
      const objectKey = rawValue.trim();
      if (frame?.type === "object" && isReliableJsPathKey(objectKey)) {
        frame.pendingKey = objectKey;
      } else if (shouldExtractObjectKeyCandidate(objectKey)) {
        const leading = leadingWhitespaceLength(rawValue);
        const trailing = trailingWhitespaceLength(rawValue);
        items.push({
          range: { start: offset + parsed.start, end: offset + parsed.end, kind: "js-object-key" },
          value: objectKey,
          sourceRole: astInfo?.sourceRole ?? "visible_text_value"
        });
      }
      continue;
    }
    const propertyKey = propertyKeyBeforeString(text, parsed.start);
    if (isTechnicalJsValueKey(propertyKey)) continue;
    const value = rawValue.trim();
    const unreliableObjectKey = isValueOfUnreliableQuotedObjectKey(text, parsed.start);
    if (unreliableObjectKey && shouldSkipValueAfterUnreliableObjectKey(value)) continue;
    const keyName = keyNameForJsValue(stack, propertyKey);
    const keyPath = specializeAnonymousJsArrayPath(text, parsed.start, keyPathForJsValue(stack, propertyKey));
    if (keyName && isTechnicalJsValueKey(keyName)) continue;
    const prefixedValue = normalizePrefixedValueString(value);
    if (prefixedValue !== null) {
      if (!shouldExtractString(prefixedValue)) continue;
      items.push({
        range: { start: offset + parsed.start, end: offset + parsed.end, kind: "js-val-string" },
        value: prefixedValue,
        keyName,
        keyPath,
        sourceRole: sourceRoleForExtractedJsString(prefixedValue, keyName, keyPath, astInfo?.sourceRole)
      });
      continue;
    }
    if (!shouldExtractString(value)) continue;
    const leading = leadingWhitespaceLength(rawValue);
    const trailing = trailingWhitespaceLength(rawValue);
    if (leading || trailing) continue;
    items.push({
      range: { start: offset + parsed.start, end: offset + parsed.end, kind: "js-string" },
      value,
      keyName,
      keyPath,
      sourceRole: sourceRoleForExtractedJsString(value, keyName, keyPath, astInfo?.sourceRole)
    });
  }
  onProgress?.(text.length, text.length);
  return items;
}

function sourceRoleForExtractedJsString(value: string, keyName?: string, keyPath?: string, astRole?: ExtractionSourceRole): ExtractionSourceRole | undefined {
  const contextName = [keyPath, keyName].filter(Boolean).join(".");
  if (contextName && isVisibleTextContext(contextName, "", undefined)) return visibleRoleForContext(contextName, "");
  if ((astRole === undefined || astRole === "unknown_js_value" || astRole === "engine_runtime") && looksLikeNaturalLanguageContent(value)) return "visible_text_value";
  return astRole;
}

function extractHtmlTemplateTextEntries(raw: string, absoluteContentStart: number, keyName?: string, keyPath?: string): JsStringExtraction[] {
  if (!looksLikeHtmlFragment(raw)) return [];
  const entries: JsStringExtraction[] = [];
  for (const match of raw.matchAll(/>([^<>]+)</g)) {
    const rawText = match[1] ?? "";
    const decoded = decodeBasicHtml(rawText.trim());
    if (!shouldExtractString(decoded)) continue;
    const startInRaw = (match.index ?? 0) + 1 + leadingWhitespaceLength(rawText);
    const endInRaw = (match.index ?? 0) + 1 + rawText.length - trailingWhitespaceLength(rawText);
    entries.push({
      range: { start: absoluteContentStart + startInRaw, end: absoluteContentStart + endInRaw, kind: "html-text" },
      value: decoded,
      keyName,
      keyPath,
      sourceRole: "ui_attribute"
    });
  }
  for (const tag of raw.matchAll(/<([a-z][\w:-]*)(?:\s[^<>]*)?>/gi)) {
    const tagStart = tag.index ?? 0;
    for (const attr of tag[0].matchAll(/\s(title|placeholder|aria-label|label|value)=("([^"]*)"|'([^']*)')/gi)) {
      const rawValue = attr[3] ?? attr[4] ?? "";
      const decoded = decodeBasicHtml(rawValue.trim());
      if (!shouldExtractString(decoded)) continue;
      const attrStartInTag = attr.index ?? 0;
      const valueStartInAttr = attr[0].lastIndexOf(rawValue);
      const startInRaw = tagStart + attrStartInTag + valueStartInAttr + leadingWhitespaceLength(rawValue);
      const endInRaw = tagStart + attrStartInTag + valueStartInAttr + rawValue.length - trailingWhitespaceLength(rawValue);
      entries.push({
        range: { start: absoluteContentStart + startInRaw, end: absoluteContentStart + endInRaw, kind: "html-attr" },
        value: decoded,
        keyName,
        keyPath,
        sourceRole: "ui_attribute"
      });
    }
  }
  return entries.sort((a, b) => a.range.start - b.range.start);
}

function looksLikeHtmlFragment(value: string): boolean {
  return /<[a-z][\w:-]*(?:\s[^<>]*)?>[\s\S]*<\/[a-z][\w:-]*>/i.test(value);
}

function normalizePrefixedValueString(value: string): string | null {
  if (!value.startsWith("val=")) return null;
  return value.slice(4).trim();
}

function buildJsAstStringInfo(text: string): Map<string, JsAstStringInfo> {
  const output = new Map<string, JsAstStringInfo>();
  let root: any;
  try {
    root = acorn.parse(text, { ecmaVersion: "latest", sourceType: "script", ranges: true, allowHashBang: true });
  } catch {
    try {
      root = acorn.parse(text, { ecmaVersion: "latest", sourceType: "module", ranges: true, allowHashBang: true });
    } catch {
      return output;
    }
  }

  walkAst(root, undefined, (node, parent, key, index) => {
    if (node?.type !== "Literal" || typeof node.value !== "string" || !Array.isArray(node.range)) return;
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return;
    output.set(`${node.range[0]}:${node.range[1]}`, {
      sourceRole: classifyJsStringLiteral(node.value, node, parent, key, index)
    });
  });
  return output;
}

function walkAst(node: any, parent: any, visit: (node: any, parent: any, key?: string, index?: number) => void, key?: string, index?: number): void {
  if (!node || typeof node !== "object") return;
  visit(node, parent, key, index);
  for (const childKey of Object.keys(node)) {
    if (childKey === "parent" || childKey === "range" || childKey === "loc" || childKey === "start" || childKey === "end") continue;
    const child = node[childKey];
    if (Array.isArray(child)) {
      child.forEach((entry, childIndex) => {
        if (entry?.type) walkAst(entry, node, visit, childKey, childIndex);
      });
    } else if (child?.type) {
      walkAst(child, node, visit, childKey);
    }
  }
}

function classifyJsStringLiteral(value: string, node: any, parent: any, key?: string, index?: number): ExtractionSourceRole {
  const trimmed = value.trim();
  const propertyName = parent?.type === "Property" && parent.value === node ? propertyNameFromAst(parent.key) : "";
  const assignmentName = parent?.type === "AssignmentExpression" && parent.right === node ? memberNameFromAst(parent.left) : "";
  const callName = parent?.type === "CallExpression" || parent?.type === "NewExpression" ? calleeName(parent.callee) : "";
  const valueKey = propertyName || assignmentName;

  if (looksLikeMimeOrCodec(trimmed) || /(?:^|[._])(?:_?setupCodecs|codecs?)(?:$|[._])/.test(valueKey)) return "mime_or_codec";
  if (looksLikeResourceReference(trimmed)) return "resource_reference";
  if (looksLikeCssSelectorOrClass(trimmed) || isCssClassContext(valueKey, callName)) return "css_or_selector";
  if (isEventNameContext(trimmed, callName, index)) return "event_name";
  if (isEngineRuntimeContext(valueKey, callName, key)) return "engine_runtime";
  if (isVisibleTextContext(valueKey, callName, index)) return visibleRoleForContext(valueKey, callName);
  if (looksLikeNaturalLanguageContent(trimmed)) return "visible_text_value";
  return "unknown_js_value";
}

function propertyNameFromAst(node: any): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name ?? "";
  if (node.type === "Literal") return String(node.value ?? "");
  return "";
}

function memberNameFromAst(node: any): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name ?? "";
  if (node.type === "MemberExpression") {
    const objectName = memberNameFromAst(node.object);
    const propName = propertyNameFromAst(node.property);
    return [objectName, propName].filter(Boolean).join(".");
  }
  return "";
}

function calleeName(node: any): string {
  return memberNameFromAst(node);
}

function looksLikeMimeOrCodec(value: string): boolean {
  return /^(?:audio|video|image|font|text|application)\/[-+.\w]+(?:\s*;\s*[-\w]+=(?:"[^"]+"|[^;]+))*$/i.test(value) || /\bcodecs?\s*=/.test(value);
}

function looksLikeResourceReference(value: string): boolean {
  return /^(?:https?:\/\/|data:|blob:|\.{0,2}\/)/i.test(value)
    || /^[\w./ -]+\.(?:png|jpe?g|webp|gif|ogg|mp3|wav|m4a|webm|mp4|json|js|css|svg|woff2?|ttf|map)(?:[?#].*)?$/i.test(value);
}

function looksLikeCssSelectorOrClass(value: string): boolean {
  return /^#[A-Za-z][\w-]+$/.test(value)
    || /^\.[A-Za-z][\w-]+$/.test(value)
    || /^[.#]?[A-Za-z0-9_-]+(?:\[[^\]]+\]|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+)+$/.test(value)
    || looksLikeCssClassList(value);
}

function isCssClassContext(propertyName: string, callName: string): boolean {
  return /(?:^|\.)(?:className|classList|class|style)$/.test(propertyName)
    || /(?:^|\.)(?:querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName)$/.test(callName);
}

function isEventNameContext(value: string, callName: string, index?: number): boolean {
  if (/addEventListener|removeEventListener|dispatchEvent|registerEventHandler|on$|off$|emit$/i.test(callName) && index === 0) return true;
  return /^(?:click|change|input|submit|keydown|keyup|keypress|mousedown|mouseup|mousemove|mouseover|mouseout|pointerdown|pointerup|touchstart|touchend|load|error|play|pause|ended|resize|scroll|focus|blur|contextmenu|dragstart|dragend)$/i.test(value);
}

function isEngineRuntimeContext(propertyName: string, callName: string, key?: string): boolean {
  return /(?:^|[._-])(?:colou?r|text_colou?r|background_colou?r|font|fontSize|size|x|y|left|top|right|bottom|width|height|position|scale|rotation|opacity|type_lock|conv_type|scene_type|section_type|event|hidden|auto|bottomleft|bottomright)(?:$|[._-])/.test(propertyName)
    || /(?:^|\.)(?:rel|tagName|nodeName|type|crossOrigin|credentials|integrity|referrerPolicy|lang|locale|format|mode|state|key|keyCode)$/.test(propertyName)
    || /(?:^|[._-])type$/.test(propertyName)
    || /(?:createElement|setAttribute|removeAttribute|supports|split|join|replace|match|test|open|send)$/i.test(callName)
    || /(?:^|\.)(?:console\.(?:log|warn|error|debug|info|group|groupEnd|table)|Error|RegExp)$/.test(callName)
    || key === "arguments";
}

function isVisibleTextContext(propertyName: string, callName: string, index?: number): boolean {
  const lower = normalizeJsContextName(propertyName);
  if (/(?:^|[._-])(?:colou?r|text_colou?r|background_colou?r|font|fontsize|size|x|y|left|top|right|bottom|width|height|position|scale|rotation|opacity)(?:$|[._-])/.test(lower)) return false;
  if (/(?:^|[._\-[\]])save[._-]status(?:$|[._\-[\]])/.test(lower)) return true;
  if (/(?:^|[._\-[\]])(?:texts?|textcontent|innertext|messages?|dialogues?|dialogs?|titles?|headings?|names?|displaynames?|descriptions?|desc|contents?|labels?|choices?|questions?|answers?|replies|reply|body|bodies|lines?|captions?|speakers?|alt|aria|placeholder|tooltip|civil_status|children)(?:$|[._\-[\]])/.test(lower)) return true;
  if (/(?:^|\.)(?:alert|confirm|prompt|showMessage|showText|setText|createTextNode)$/.test(callName)) return index === 0 || index === undefined;
  return false;
}

function looksLikeNaturalLanguageContent(value: string): boolean {
  const text = value.trim();
  if (text.length < 12) return false;
  if (looksLikeMimeOrCodec(text) || looksLikeResourceReference(text) || looksLikeCssSelectorOrClass(text) || looksLikeAttributeList(text)) return false;
  if (/^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier|steps)\(/i.test(text)) return false;
  if (/^[a-z0-9_ -]+$/.test(text) && text.split(/\s+/).length >= 3) return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(text)) return false;
  if (/^[-A-Z0-9_./]+$/.test(text) && !/\s/.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  if (/[.!?。！？:;，,]/.test(text) && text.length >= 8) return true;
  if (words.length < 2) return false;
  if (text.startsWith("@") && words.length >= 3) return true;
  if (/[\r\n]/.test(text) && words.length >= 3) return true;
  if (/[.!?。！？:;，,]/.test(text) && /\s/.test(text)) return true;
  if (text.length >= 40 && words.length >= 6) return true;
  if (/^[A-Z0-9][A-Z0-9 '\-:,.!?()]+$/.test(text) && words.length >= 2 && /[\s:]/.test(text)) return true;
  return false;
}

function visibleRoleForContext(propertyName: string, callName: string): ExtractionSourceRole {
  const lower = normalizeJsContextName(`${propertyName}.${callName}`);
  if (/(dialogue|dialog|message|text|content|body|line|speaker|civil_status)/.test(lower)) return "dialogue_field";
  if (/(title|alt|placeholder|aria|label|caption|children|name|description|desc)/.test(lower)) return "ui_attribute";
  return "visible_text_value";
}

function normalizeJsContextName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1.$2").toLowerCase();
}

function canStartJsTemplateLiteral(text: string, start: number): boolean {
  const previous = previousSignificantIndex(text, start - 1);
  if (previous < 0) return true;
  const char = text[previous];
  if (/[[({,;:=?!&|+\-*/~^%<>]/.test(char)) return true;
  const prefix = text.slice(Math.max(0, previous - 16), previous + 1);
  return /\b(?:return|throw|yield|case|delete|void|typeof|new|in|of|await)$/.test(prefix);
}

function readJsTemplateLiteral(text: string, start: number): JsTemplateLiteral | null {
  let index = start + 1;
  let partStart = index;
  const parts: JsTemplateLiteral["parts"] = [];
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      if (partStart < index) parts.push({ start: partStart, end: index, raw: text.slice(partStart, index) });
      return { start, end: index + 1, parts };
    }
    if (char === "$" && text[index + 1] === "{") {
      if (partStart < index) parts.push({ start: partStart, end: index, raw: text.slice(partStart, index) });
      const expressionEnd = findTemplateExpressionEnd(text, index + 2);
      if (expressionEnd < 0) return null;
      index = expressionEnd + 1;
      partStart = index;
      continue;
    }
    index += 1;
  }
  return null;
}

function findTemplateExpressionEnd(text: string, start: number): number {
  let depth = 1;
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
    if (char === '"' || char === "'") {
      const parsed = readJsString(text, index, char);
      if (!parsed) return -1;
      index = parsed.end - 1;
      continue;
    }
    if (char === "`") {
      const parsed = readJsTemplateLiteral(text, index);
      if (!parsed) return -1;
      index = parsed.end - 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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

function objectKeyBeforeColon(text: string, colonIndex: number): string | undefined {
  let end = colonIndex - 1;
  while (end >= 0 && /\s/.test(text[end])) end -= 1;
  if (end < 0) return undefined;

  if (text[end] === '"' || text[end] === "'") {
    const quote = text[end];
    let start = end - 1;
    while (start >= 0) {
      if (text[start] === quote && text[start - 1] !== "\\") {
        const before = previousSignificantIndex(text, start - 1);
        if (before >= 0 && text[before] !== "{" && text[before] !== ",") return undefined;
        const key = text.slice(start + 1, end).trim();
        return isReliableJsPathKey(key) ? key : undefined;
      }
      start -= 1;
    }
    return undefined;
  }

  let start = end;
  while (start >= 0 && /[$\w]/.test(text[start])) start -= 1;
  const key = text.slice(start + 1, end + 1);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return undefined;
  const before = previousSignificantIndex(text, start);
  if (before >= 0 && text[before] !== "{" && text[before] !== ",") return undefined;
  return key;
}

function previousSignificantIndex(text: string, start: number): number {
  let index = start;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  return index;
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
    if (text[index] === quote && text[index - 1] !== "\\") {
      const key = text.slice(index + 1, end);
      return isReliableJsPathKey(key) ? key : "";
    }
    index -= 1;
  }
  return "";
}

function isValueOfUnreliableQuotedObjectKey(text: string, stringStart: number): boolean {
  let index = stringStart - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (text[index] !== ":") return false;
  index -= 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (text[index] !== '"' && text[index] !== "'") return false;
  const quote = text[index];
  const end = index;
  index -= 1;
  while (index >= 0) {
    if (text[index] === quote && text[index - 1] !== "\\") {
      return !isReliableJsPathKey(text.slice(index + 1, end));
    }
    index -= 1;
  }
  return false;
}

function shouldExtractObjectKeyCandidate(key: string): boolean {
  const text = key.trim();
  if (!shouldExtractString(text)) return false;
  if (looksLikeMimeOrCodec(text) || looksLikeResourceReference(text) || looksLikeCssSelectorOrClass(text) || looksLikeAttributeList(text)) return false;
  if (looksLikeCodeIdentifier(text)) return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.length >= 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

function shouldSkipValueAfterUnreliableObjectKey(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (looksLikeMimeOrCodec(text) || looksLikeResourceReference(text) || looksLikeCssSelectorOrClass(text)) return true;
  if (looksLikeCodeIdentifier(text)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(text)) return true;
  return false;
}

function isReliableJsPathKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(trimmed);
}

function pathForNestedContainer(stack: JsStructureFrame[], childType: JsStructureFrame["type"]): string[] {
  const parent = stack.at(-1);
  if (!parent) return childType === "array" ? ["*"] : [];
  if (parent.type === "array") return childType === "array" ? [...parent.path, "*"] : parent.path;
  const key = parent.pendingKey;
  const path = key ? [...parent.path, key] : parent.path;
  return childType === "array" ? [...path, "*"] : path;
}

function keyNameForJsValue(stack: JsStructureFrame[], fallback: string): string | undefined {
  const frame = stack.at(-1);
  if (!frame) return fallback || undefined;
  if (frame.type === "object") return frame.pendingKey || fallback || undefined;
  return fallback || undefined;
}

function keyPathForJsValue(stack: JsStructureFrame[], fallback: string): string | undefined {
  const frame = stack.at(-1);
  if (!frame) return fallback || undefined;
  const segments = frame.type === "object"
    ? [...frame.path, frame.pendingKey || fallback].filter(Boolean)
    : frame.path;
  return segments.length ? formatJsPath(segments) : fallback || undefined;
}

function specializeAnonymousJsArrayPath(text: string, stringStart: number, keyPath?: string): string | undefined {
  if (!keyPath || !/^(?:\[\*\])+$/.test(keyPath)) return keyPath;
  const arrayStart = nearestArrayStartBefore(text, stringStart);
  if (arrayStart < 0) return keyPath;
  const callName = callNameBeforeArrayArgument(text, arrayStart);
  if (callName) return `call.${callName}${keyPath}`;
  return keyPath;
}

function nearestArrayStartBefore(text: string, start: number): number {
  let depth = 0;
  const lowerBound = Math.max(0, start - 2000);
  for (let index = start - 1; index >= lowerBound; index -= 1) {
    const char = text[index];
    if (char === "]") {
      depth += 1;
      continue;
    }
    if (char === "[") {
      if (depth === 0) return index;
      depth -= 1;
      continue;
    }
    if (depth === 0 && char === ";") return -1;
  }
  return -1;
}

function callNameBeforeArrayArgument(text: string, arrayStart: number): string {
  let index = arrayStart - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (text[index] !== "(") return "";
  index -= 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  const end = index + 1;
  while (index >= 0 && /[A-Za-z0-9_$.\]]/.test(text[index])) index -= 1;
  const candidate = text.slice(index + 1, end).replace(/\[[^\]]*\]$/g, "");
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(candidate) ? candidate : "";
}

function clearConsumedObjectKey(stack: JsStructureFrame[]): void {
  const frame = stack.at(-1);
  if (frame?.type === "object") frame.pendingKey = undefined;
}

function formatJsPath(segments: string[]): string {
  let output = "";
  for (const segment of segments) {
    if (!segment) continue;
    if (segment === "*" || /^-?\d+$/.test(segment)) {
      output += "[*]";
      continue;
    }
    output += output ? `.${segment}` : segment;
  }
  return output;
}

function parseSemicolonMeta(value: string): { head: string; values: Record<string, string> } {
  const [head, ...pairs] = value.split(";");
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    values[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return { head, values };
}

function lastJsPathSegment(keyPath: string): string | undefined {
  return keyPath.replace(/\[\*\]/g, "").split(".").filter(Boolean).at(-1);
}

function isTechnicalJsValueKey(key: string): boolean {
  return technicalJsValueKeys.has(key);
}

function htmlContextForRange(fileText: string, lineStarts: number[], range: { start: number; end: number; kind: string }): ExtractionCandidate["context"] {
  const lineNumber = lineNumberAt(lineStarts, range.start);
  const tagStart = fileText.lastIndexOf("<", range.start);
  const tagEnd = fileText.indexOf(">", Math.max(range.end, tagStart));
  const tagText = tagStart >= 0 && tagEnd > tagStart ? fileText.slice(tagStart, tagEnd + 1) : "";
  const tagName = tagText.match(/^<\s*([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
  if (range.kind === "html-attr") {
    const beforeValue = tagStart >= 0 ? fileText.slice(tagStart, range.start) : "";
    const attrName = beforeValue.match(/([:\w-]+)\s*=\s*["'][^"']*$/)?.[1]?.toLowerCase();
    return {
      tagName,
      attrName,
      keyName: attrName,
      lineNumber
    };
  }
  return {
    tagName,
    keyName: tagName,
    lineNumber
  };
}

function extractPlainTextFile(filePath: string, text: string, context: ExtractionContext, ext: string, onProgress?: FileProgressReporter): TextItem[] {
  const items: TextItem[] = [];
  let offset = 0;
  for (const line of text.split(/(\r?\n)/)) {
    if (offset % 100000 < 2000) onProgress?.(18 + (offset / Math.max(1, text.length)) * 70, ext === ".txt" ? "扫描文本行" : "扫描文本内容");
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
  onProgress?.(88, "文本行扫描完成", true);
  return items;
}

function extractCsvFile(filePath: string, text: string, context: ExtractionContext, onProgress?: FileProgressReporter): TextItem[] {
  const items: TextItem[] = [];
  onProgress?.(18, "解析 CSV", true);
  const rows = parseCsvWithRanges(text);
  const headers = rows[0]?.cells.map((cell, index) => cell.value.trim() || `col_${index + 1}`) ?? [];
  for (let rowIndex = headers.length ? 1 : 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex % 200 === 0) onProgress?.(24 + (rowIndex / Math.max(1, rows.length)) * 62, "扫描 CSV 单元格");
    const row = rows[rowIndex];
    row.cells.forEach((cell, columnIndex) => {
      const value = cell.value.trim();
      if (!shouldExtractString(value)) return;
      const item = makeRangeItem(context, filePath, { start: cell.start + leadingWhitespaceLength(cell.value), end: cell.end - trailingWhitespaceLength(cell.value), kind: "plain" }, value);
      item.context = item.context ?? {};
      item.context.before = `column:${headers[columnIndex] || `col_${columnIndex + 1}`}`;
      items.push(item);
    });
  }
  onProgress?.(88, "CSV 单元格扫描完成", true);
  return items;
}

function extractYamlFile(filePath: string, text: string, context: ExtractionContext, onProgress?: FileProgressReporter): TextItem[] {
  const items: TextItem[] = [];
  const keyStack: Array<{ indent: number; key: string }> = [];
  let offset = 0;
  for (const line of text.split(/(\r?\n)/)) {
    if (offset % 100000 < 2000) onProgress?.(18 + (offset / Math.max(1, text.length)) * 70, "扫描 YAML 字段");
    if (/^\r?\n$/.test(line)) {
      offset += line.length;
      continue;
    }
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(["']?)(.*?)\3\s*(?:#.*)?$/);
    if (match) {
      const indent = match[1].length;
      const key = match[2];
      while (keyStack.length && keyStack[keyStack.length - 1].indent >= indent) keyStack.pop();
      keyStack.push({ indent, key });
      const rawValue = match[4] ?? "";
      const value = rawValue.trim();
      if (value && shouldExtractString(value)) {
        const valueStart = offset + line.indexOf(rawValue);
        const item = makeRangeItem(context, filePath, { start: valueStart + leadingWhitespaceLength(rawValue), end: valueStart + rawValue.length - trailingWhitespaceLength(rawValue), kind: "plain" }, value);
        item.context = item.context ?? {};
        item.context.before = `yaml:${keyStack.map((entry) => entry.key).join(".")}`;
        items.push(item);
      }
    }
    offset += line.length;
  }
  onProgress?.(88, "YAML 字段扫描完成", true);
  return items;
}

function parseCsvWithRanges(text: string): Array<{ cells: Array<{ value: string; start: number; end: number }> }> {
  const rows: Array<{ cells: Array<{ value: string; start: number; end: number }> }> = [];
  let row: Array<{ value: string; start: number; end: number }> = [];
  let value = "";
  let quoted = false;
  let cellStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "\n";
    if (quoted && char === '"' && text[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      if (!value) cellStart = index + 1;
    } else if ((char === "," || char === "\n" || char === "\r") && !quoted) {
      row.push({ value, start: cellStart, end: index });
      value = "";
      cellStart = index + 1;
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
        cellStart = index + 1;
      }
      if (char === "\n" || char === "\r" || index >= text.length) {
        rows.push({ cells: row });
        row = [];
      }
    } else {
      if (!value) cellStart = index;
      value += char;
    }
  }
  return rows;
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

function makeCandidate(gameRoot: string, filePath: string, fileText: string, fileMetrics: FileMetrics, item: TextItem, extractorStrategy: string): ExtractionCandidate {
  const strategy = strategyForItem(item, extractorStrategy);
  const sourceFile = toPosixPath(path.relative(gameRoot, filePath));
  const context = contextForItem(fileText, fileMetrics.lineStarts, item);
  const range = parseCandidateRange(item.locator);
  const lineLength = range ? lineLengthAt(fileMetrics, range.start) : 0;
  const risks = risksForText(item.original, context, item.locator, fileMetrics.minifiedRatio, lineLength);
  const backfill = backfillForItem(fileText, item);
  const groupKey = groupKeyForItem(sourceFile, item, strategy, context);
  return {
    id: `cand_${stableHash(`${sourceFile}:${item.locator}:${item.original}`).slice(0, 16)}`,
    sourceFile,
    locator: item.locator,
    original: item.original,
    normalizedOriginal: normalizeOriginal(item.original),
    strategy,
    groupKey,
    confidence: confidenceForCandidate(risks, backfill.supported),
    reasons: reasonsForCandidate(strategy, context),
    risks,
    context,
    backfill
  };
}

function strategyForItem(item: TextItem, extractorStrategy: string): ExtractionStrategyId {
  if (item.context?.before?.startsWith("data-block:")) return "js-data-block";
  if (extractorStrategy === "js-data-block") return "js-data-block";
  if (item.locator.startsWith("json:")) return "json-string";
  if (item.locator.endsWith(":html-text")) return "html-text";
  if (item.locator.endsWith(":html-attr")) return "html-attr";
  if (item.locator.endsWith(":js-object-key")) return "js-object-key";
  if (item.locator.endsWith(":js-val-string")) return "js-val-string";
  if (item.locator.endsWith(":js-string") || item.locator.endsWith(":js-template-content")) return "js-string";
  if (extractorStrategy === "csv") return "csv-cell";
  if (extractorStrategy === "yaml") return "yaml-string";
  return "plain-text";
}

function contextForItem(fileText: string, lineStarts: number[], item: TextItem): ExtractionCandidate["context"] {
  const sourceRole = sourceRoleFromItem(item);
  if (item.locator.startsWith("json:")) {
    const keyPath = item.locator.slice("json:".length);
    const parts = parseJsonLocatorParts(keyPath);
    return {
      keyPath,
      keyName: parts.at(-1),
      parentKeys: parts.slice(-4, -1),
      sourceRole
    };
  }
  const range = parseCandidateRange(item.locator);
  if (!range) return sourceRole ? { sourceRole } : {};
  if (item.context?.before?.startsWith("column:")) {
    return {
      keyName: item.context.before.slice("column:".length),
      lineNumber: lineNumberAt(lineStarts, range.start),
      sourceRole
    };
  }
  if (item.context?.before?.startsWith("yaml:")) {
    return {
      keyPath: item.context.before.slice("yaml:".length),
      keyName: item.context.before.slice("yaml:".length).split(".").at(-1),
      lineNumber: lineNumberAt(lineStarts, range.start),
      sourceRole
    };
  }
  if (item.context?.before?.startsWith("data-block:")) {
    const dataBlockMeta = parseSemicolonMeta(item.context.before);
    const dataBlockName = dataBlockMeta.head.slice("data-block:".length);
    const keyPath = dataBlockMeta.values.path;
    const keyName = keyPath ? lastJsPathSegment(keyPath) : range.kind === "js-string" || range.kind === "js-template-content" || range.kind === "js-val-string" || range.kind === "js-object-key" ? propertyKeyBeforeString(fileText, range.start) : "";
    return {
      dataBlockName,
      keyPath,
      keyName: keyName || dataBlockName,
      lineNumber: lineNumberAt(lineStarts, range.start),
      sourceRole
    };
  }
  if (item.context?.before?.startsWith("js-path:")) {
    const keyPath = item.context.before.slice("js-path:".length);
    return {
      keyPath,
      keyName: lastJsPathSegment(keyPath),
      lineNumber: lineNumberAt(lineStarts, range.start),
      sourceRole,
      before: fileText.slice(Math.max(0, range.start - 80), range.start),
      after: fileText.slice(range.end, Math.min(fileText.length, range.end + 80))
    };
  }
  if (range.kind === "js-string" || range.kind === "js-template-content" || range.kind === "js-val-string" || range.kind === "js-object-key") {
    const keyName = propertyKeyBeforeString(fileText, range.start);
    return {
      keyName: keyName || undefined,
      lineNumber: lineNumberAt(lineStarts, range.start),
      sourceRole,
      before: fileText.slice(Math.max(0, range.start - 80), range.start),
      after: fileText.slice(range.end, Math.min(fileText.length, range.end + 80))
    };
  }
  if (range.kind === "html-attr" || range.kind === "html-text") {
    return { ...htmlContextForRange(fileText, lineStarts, range), sourceRole };
  }
  const beforeStart = Math.max(0, range.start - 80);
  const afterEnd = Math.min(fileText.length, range.end + 80);
  return {
    lineNumber: lineNumberAt(lineStarts, range.start),
    sourceRole,
    before: fileText.slice(beforeStart, range.start),
    after: fileText.slice(range.end, afterEnd)
  };
}

function sourceRoleFromItem(item: TextItem): ExtractionSourceRole | undefined {
  const value = item.context?.after;
  if (!value?.startsWith("source-role:")) return undefined;
  return value.slice("source-role:".length) as ExtractionSourceRole;
}

function risksForText(original: string, context: ExtractionCandidate["context"], locator: string, fileMinifiedRatio: number, lineLength: number): ExtractionRisk[] {
  const text = original.trim();
  const risks: ExtractionRisk[] = [];
  if (text.length < 4) risks.push("short_text");
  if (/^(https?:\/\/|\.?\.?\/|data:|blob:)|\.(png|jpg|jpeg|webp|gif|ogg|mp3|wav|svg|woff2?)$/i.test(text)) risks.push("resource_like");
  if (context.sourceRole === "resource_reference" || context.sourceRole === "mime_or_codec") risks.push("resource_like");
  if (looksLikeCodeIdentifier(text) || (/[{}()[\];=<>]/.test(text) && !/\s/.test(text))) risks.push("code_like");
  if (/(\{[^}]+\}|%[sdif]|\\[nrt]|\$\{[^}]+\}|<<[^>]+>>)/.test(text)) risks.push("placeholder_sensitive");
  if (/<[a-z][\s\S]*>/i.test(text)) risks.push("html_fragment");
  if (context.keyName && technicalJsValueKeys.has(context.keyName)) risks.push("technical_key");
  if (context.sourceRole && isTechnicalSourceRole(context.sourceRole)) risks.push("technical_key");
  if (/\.min\.(js|css)\b/i.test(locator) || fileMinifiedRatio > 0.65 || lineLength > 1200) risks.push("minified_source");
  return unique(risks);
}

function backfillForItem(fileText: string, item: TextItem): ExtractionCandidate["backfill"] {
  if (item.locator.startsWith("json:")) {
    try {
      const value = getJsonValue(JSON.parse(fileText) as unknown, item.locator);
      return value === item.original
        ? { supported: true, method: "json-path", validation: "safe" }
        : { supported: true, method: "json-path", validation: "failed", message: "JSON path 指向内容与原文不一致。" };
    } catch (error) {
      return { supported: true, method: "json-path", validation: "failed", message: error instanceof Error ? error.message : "JSON path 校验失败。" };
    }
  }
  const range = parseCandidateRange(item.locator);
  if (!range) return { supported: false, method: "unsupported", validation: "failed", message: "不支持的 locator。" };
  if (range.end > fileText.length) return { supported: true, method: "range", validation: "failed", message: "范围超出文件长度。" };
  return { supported: true, method: "range", validation: "safe" };
}

function groupKeyForItem(sourceFile: string, item: TextItem, strategy: ExtractionStrategyId, context: ExtractionCandidate["context"]): string {
  if (strategy === "json-string") {
    const pattern = (context.keyPath ?? item.locator.slice("json:".length)).replace(/\[\d+\]/g, "[*]");
    return `json:path:${sourceFile}:${pattern}`;
  }
  if (strategy === "html-text") return `html:text:${sourceFile}:${context.tagName ?? "text"}`;
  if (strategy === "html-attr") return `html:attr:${sourceFile}:${context.attrName ?? "attr"}`;
  if (strategy === "js-data-block") return `js:data-block:${sourceFile}:${context.keyPath ?? `${context.dataBlockName ?? "script-data"}.${context.keyName ?? "values"}`}`;
  if (strategy === "js-object-key") return `js:object-key:${sourceFile}`;
  if (strategy === "js-val-string") return `js:val-string:${sourceFile}:${groupableJsPath(context.keyPath)}`;
  if (strategy === "js-string") {
    const pathKey = groupableJsPathForRole(context.keyPath, context.sourceRole);
    const roleKey = jsRoleGroupSuffix(context.sourceRole);
    return `js:string:${sourceFile}:${pathKey}${roleKey}`;
  }
  if (strategy === "csv-cell") return `csv:column:${sourceFile}:${context.keyName ?? "unknown"}`;
  if (strategy === "yaml-string") return `yaml:path:${sourceFile}:${context.keyPath ?? "line"}`;
  return `plain:line:${sourceFile}`;
}

function confidenceForCandidate(risks: ExtractionRisk[], supported: boolean): number {
  let confidence = supported ? 0.82 : 0.35;
  confidence -= risks.length * 0.08;
  if (risks.includes("resource_like") || risks.includes("code_like")) confidence -= 0.2;
  return Math.max(0.05, Math.min(0.98, confidence));
}

function reasonsForCandidate(strategy: ExtractionStrategyId, context: ExtractionCandidate["context"]): string[] {
  const reasons = [`${strategy} 扫描命中自然语言字符串。`];
  if (context.keyName) reasons.push(`位于 ${context.keyName} 字段。`);
  if (context.sourceRole) reasons.push(`AST 判断为${sourceRoleLabel(context.sourceRole)}。`);
  if (context.lineNumber) reasons.push(`位于第 ${context.lineNumber} 行附近。`);
  return reasons;
}

function markDuplicateLocators(candidates: ExtractionCandidate[]): ExtractionCandidate[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceFile}:${candidate.locator}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map((candidate) => {
    const key = `${candidate.sourceFile}:${candidate.locator}`;
    if ((counts.get(key) ?? 0) <= 1) return candidate;
    return { ...candidate, risks: unique([...candidate.risks, "duplicate_locator" as ExtractionRisk]) };
  });
}

function buildExtractionRuleReport(fileCount: number, candidates: ExtractionCandidate[], groups: ExtractionRuleGroup[], skippedCount: number): ExtractionRuleReport {
  void skippedCount;
  const activeGroups = groups.filter((group) => group.userDecision.decision !== "deleted");
  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    fileCount,
    candidateCount: candidates.length,
    groupCount: activeGroups.length,
    approvedCandidateCount: 0,
    duplicateLocatorCount: candidates.filter((candidate) => candidate.risks.includes("duplicate_locator")).length,
    failedValidationCount: candidates.filter((candidate) => candidate.backfill.validation === "failed").length,
    unsupportedBackfillCount: candidates.filter((candidate) => !candidate.backfill.supported).length
  };
}

function shouldAutoDeleteGroup(candidates: ExtractionCandidate[], risks: ExtractionRisk[]): boolean {
  if (!candidates.length) return false;
  if (candidates.every((candidate) => candidate.strategy === "html-attr" && candidate.context.attrName === "alt")) return true;
  const visibleRoleRatio = sourceRoleRatio(candidates, ["visible_text_value", "ui_attribute", "dialogue_field"]);
  const technicalRoleRatio = sourceRoleRatio(candidates, ["resource_reference", "mime_or_codec", "event_name", "css_or_selector", "engine_runtime"]);
  if (technicalRoleRatio >= 0.7 && visibleRoleRatio < 0.15) return true;
  if (sourceRoleRatio(candidates, ["mime_or_codec", "event_name", "css_or_selector"]) >= 0.85) return true;
  if (risks.includes("resource_like") && sourceRoleRatio(candidates, ["resource_reference", "mime_or_codec"]) >= 0.65) return true;
  return false;
}

function markRecommendationAsDeleted(ai: ExtractionAiRecommendation): ExtractionAiRecommendation {
  return {
    ...ai,
    reason: ai.reason.includes("默认排除") ? ai.reason.replace("默认排除", "默认移入待删除") : `${ai.reason} 默认移入待删除。`
  };
}

function summarizeBackfill(candidates: ExtractionCandidate[]): ExtractionBackfillSummary {
  return {
    safe: candidates.filter((candidate) => candidate.backfill.validation === "safe").length,
    warning: candidates.filter((candidate) => candidate.backfill.validation === "warning").length,
    failed: candidates.filter((candidate) => candidate.backfill.validation === "failed").length,
    unsupported: candidates.filter((candidate) => !candidate.backfill.supported).length
  };
}

function heuristicAiRecommendation(candidates: ExtractionCandidate[], risks: ExtractionRisk[], backfill: ExtractionBackfillSummary): ExtractionAiRecommendation {
  const total = Math.max(1, candidates.length);
  const dominantKey = dominantContextValue(candidates, (candidate) => candidate.context.keyName);
  const dominantPath = dominantContextValue(candidates, (candidate) => candidate.context.keyPath);
  const commonKey = dominantKey.ratio >= 0.6 ? dominantKey.value : undefined;
  const commonPath = dominantPath.ratio >= 0.6 ? dominantPath.value : undefined;
  const visibleKey = isVisibleTextKey(commonKey, commonPath);
  const resourceRatio = riskRatio(candidates, "resource_like");
  const codeRatio = riskRatio(candidates, "code_like");
  const minifiedRiskRatio = riskRatio(candidates, "minified_source");
  const identifierRatio = candidates.filter((candidate) => looksLikeCodeIdentifier(candidate.original)).length / total;
  const technicalRatio = riskRatio(candidates, "technical_key");
  const shortRatio = riskRatio(candidates, "short_text");
  const visibleRoleRatio = sourceRoleRatio(candidates, ["visible_text_value", "ui_attribute", "dialogue_field"]);
  const technicalRoleRatio = sourceRoleRatio(candidates, ["resource_reference", "mime_or_codec", "event_name", "css_or_selector", "engine_runtime"]);
  const badRatio = Math.max(resourceRatio, technicalRatio, codeRatio);
  const averageLength = candidates.reduce((sum, candidate) => sum + candidate.original.trim().length, 0) / total;
  if (backfill.failed || backfill.unsupported) {
    return { recommendation: "review", confidence: 0.68, reason: "该组存在回填校验失败或不支持回填的候选，需要人工复核。" };
  }
  if (technicalRoleRatio > 0.7) {
    const role = dominantContextValue(candidates, (candidate) => candidate.context.sourceRole).value as ExtractionSourceRole | undefined;
    return { recommendation: "exclude", confidence: 0.84, reason: `AST 判断该组主要是${role ? sourceRoleLabel(role) : "技术字符串"}，默认排除。` };
  }
  if (technicalRoleRatio > 0.35 && visibleRoleRatio < 0.35) {
    return { recommendation: "review", confidence: 0.72, reason: "AST 判断该组技术字符串占比较高，且缺少明确玩家可见文本证据，需要复核。" };
  }
  if (visibleKey) {
    if (identifierRatio > 0.75) {
      return { recommendation: "exclude", confidence: 0.82, reason: `该组位于 ${commonPath ?? commonKey} 字段，但大多数内容是下划线或驼峰式代码标识，默认排除。` };
    }
    if (identifierRatio > 0.35) {
      return { recommendation: "review", confidence: 0.72, reason: `该组位于 ${commonPath ?? commonKey} 字段，但代码式标识符占比较高，需要复核。` };
    }
    if (resourceRatio > 0.35 || technicalRatio > 0.35) {
      return { recommendation: "review", confidence: 0.7, reason: `该组位于 ${commonKey} 字段，但资源路径或技术字段占比较高，需要复核。` };
    }
    if (codeRatio > 0.75 && averageLength < 10) {
      return { recommendation: "review", confidence: 0.66, reason: `该组位于 ${commonKey} 字段，但短代码标识占比较高，需要复核。` };
    }
    return { recommendation: "include", confidence: Math.max(0.72, 0.9 - badRatio * 0.25), reason: `该组位于 ${commonPath ?? commonKey} 字段，主要是玩家可见文本；少量风险项不会否定整组。` };
  }
  if (visibleRoleRatio > 0.65 && badRatio < 0.45) {
    return { recommendation: "include", confidence: 0.78, reason: "AST 判断该组主要来自可见文本语境，且技术风险占比不高，默认纳入。" };
  }
  if (badRatio > 0.65 || resourceRatio > 0.3 || technicalRatio > 0.3 || (codeRatio > 0.55 && shortRatio > 0.5)) {
    return { recommendation: "exclude", confidence: 0.76, reason: "该组中资源路径、代码标识或技术字段占比较高，默认排除。" };
  }
  if (candidates.length > 20 && minifiedRiskRatio > 0.8 && (averageLength < 40 || codeRatio > 0.2 || shortRatio > 0.2)) {
    return { recommendation: "exclude", confidence: 0.78, reason: "该组主要来自压缩后的运行时代码或样式常量，默认排除。" };
  }
  if (averageLength >= 8 && risks.length <= 3) {
    return { recommendation: "review", confidence: 0.66, reason: "该组包含自然语言特征，但字段语义不够明确，需要用户确认。" };
  }
  return { recommendation: "review", confidence: 0.62, reason: "该组包含可翻译文本特征，但需要用户确认是否为玩家可见内容。" };
}

function looksLikeCodeIdentifier(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/\s/.test(text)) return false;
  if (!/^[A-Za-z0-9_$.-]+$/.test(text)) return false;
  if (/^[a-z]+(?:_[a-z0-9]+)+$/i.test(text)) return true;
  if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(text)) return true;
  if (/^[A-Z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+$/.test(text)) return true;
  if (/[.$-]/.test(text)) return true;
  if (/\d/.test(text) && /[A-Za-z]/.test(text)) return true;
  if (/^[A-Z0-9_]{2,}$/.test(text)) return true;
  return false;
}

function isTechnicalSourceRole(role: ExtractionSourceRole): boolean {
  return role === "resource_reference"
    || role === "mime_or_codec"
    || role === "event_name"
    || role === "css_or_selector"
    || role === "engine_runtime";
}

function sourceRoleRatio(candidates: ExtractionCandidate[], roles: ExtractionSourceRole[]): number {
  if (!candidates.length) return 0;
  const roleSet = new Set(roles);
  return candidates.filter((candidate) => candidate.context.sourceRole && roleSet.has(candidate.context.sourceRole)).length / candidates.length;
}

function sourceRoleLabel(role: ExtractionSourceRole): string {
  switch (role) {
    case "visible_text_value":
      return "可见文本值";
    case "ui_attribute":
      return "界面属性文本";
    case "dialogue_field":
      return "剧情/对白字段";
    case "resource_reference":
      return "资源引用";
    case "mime_or_codec":
      return "媒体类型或编码声明";
    case "event_name":
      return "事件名";
    case "css_or_selector":
      return "样式类名或选择器";
    case "engine_runtime":
      return "引擎运行时字段";
    case "unknown_js_value":
      return "语义不明确的 JS 字符串";
  }
}

function riskRatio(candidates: ExtractionCandidate[], risk: ExtractionRisk): number {
  if (!candidates.length) return 0;
  return candidates.filter((candidate) => candidate.risks.includes(risk)).length / candidates.length;
}

function dominantContextValue(candidates: ExtractionCandidate[], read: (candidate: ExtractionCandidate) => string | undefined): { value?: string; ratio: number } {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const value = read(candidate);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: { value?: string; count: number } = { count: 0 };
  for (const [value, count] of counts.entries()) {
    if (count > best.count) best = { value, count };
  }
  return { value: best.value, ratio: candidates.length ? best.count / candidates.length : 0 };
}

function isVisibleTextKey(key?: string, pathValue?: string): boolean {
  const value = `${key ?? ""}.${pathValue ?? ""}`.toLowerCase();
  if (!value.trim()) return false;
  if (/(?:^|[._-])(colou?r|type|id|url|uri|src|href|path|file|image|icon|sound|audio|format|base|action_name)(?:$|[._-])/.test(value)) return false;
  return /(?:^|[._-])(text|message|dialogue|dialog|title|name|description|desc|content|label|choice|question|answer|body|line|caption|speaker|civil_status)(?:$|[._-])/.test(value);
}

function labelForGroup(groupKey: string, candidates: ExtractionCandidate[]): string {
  const first = candidates[0];
  if (first?.strategy === "js-data-block" && first.context.keyPath) return `${first.strategy} ${first.context.keyPath}`;
  if (first?.strategy === "js-object-key") return `${first.strategy} object keys`;
  if ((first?.strategy === "js-string" || first?.strategy === "js-val-string") && first.context.keyPath) {
    const roleLabel = first.context.sourceRole && first.context.sourceRole !== "unknown_js_value" ? ` · ${sourceRoleLabel(first.context.sourceRole)}` : "";
    const pathLabel = first.strategy === "js-string" ? groupableJsPathForRole(first.context.keyPath, first.context.sourceRole) : groupableJsPath(first.context.keyPath);
    return `${first.strategy} ${pathLabel}${roleLabel}`;
  }
  if (first?.strategy === "js-string" && first.context.sourceRole) return `${first.strategy} ${sourceRoleLabel(first.context.sourceRole)}`;
  if (first?.context.dataBlockName) return `${first.strategy} ${first.context.dataBlockName}`;
  if (first?.context.keyPath) return `${first.strategy} ${first.context.keyPath.replace(/\[\d+\]/g, "[*]")}`;
  return groupKey.split(":").slice(0, 3).join(":");
}

function groupableJsPath(keyPath?: string): string {
  if (!keyPath) return "values";
  const normalized = normalizeJsRecordPath(keyPath);
  if (normalized.includes("[*]") || normalized.includes(".")) return normalized;
  return "top-level-values";
}

function groupableJsPathForRole(keyPath?: string, role?: ExtractionSourceRole): string {
  if (!keyPath) return "values";
  const normalized = normalizeJsRecordPath(keyPath);
  if (normalized.includes("[*]") || normalized.includes(".")) return normalized;
  if (!role || role === "unknown_js_value" || isVisibleSourceRole(role)) return normalized;
  return "top-level-values";
}

function isVisibleSourceRole(role: ExtractionSourceRole): boolean {
  return role === "visible_text_value" || role === "ui_attribute" || role === "dialogue_field";
}

function jsRoleGroupSuffix(role?: ExtractionSourceRole): string {
  return role ? `:${role}` : "";
}

function normalizeJsRecordPath(keyPath: string): string {
  const segments = keyPath.split(".").filter(Boolean);
  const recordFieldIndex = segments.findIndex((segment, index) => index > 0 && jsRecordFieldKeys.has(stripArraySuffix(segment)));
  if (recordFieldIndex > 0 && segments[0] !== "[*]") {
    return ["[*]", ...segments.slice(recordFieldIndex)].join(".");
  }
  return keyPath;
}

function stripArraySuffix(segment: string): string {
  return segment.replace(/\[\*\]$/g, "");
}

function matcherForGroup(groupKey: string, strategy: ExtractionStrategyId, candidates: ExtractionCandidate[]): ExtractionRuleMatcher {
  const matcher: ExtractionRuleMatcher = { groupKey, strategy };
  const dataBlockNames = unique(candidates.map((candidate) => candidate.context.dataBlockName).filter(Boolean) as string[]);
  if (dataBlockNames.length) matcher.scriptVariables = dataBlockNames;
  return matcher;
}

function sampleCandidates(candidates: ExtractionCandidate[]): ExtractionCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.original.length - b.original.length);
  const positionalSamples: ExtractionCandidate[] = [];
  const sampleSlots = Math.min(18, candidates.length);
  for (let index = 0; index < sampleSlots; index += 1) {
    const position = sampleSlots === 1 ? 0 : Math.round((index / (sampleSlots - 1)) * (candidates.length - 1));
    positionalSamples.push(candidates[position]);
  }
  return uniqueById([
    sorted[0],
    sorted[Math.floor(sorted.length * 0.25)],
    sorted[Math.floor(sorted.length * 0.5)],
    sorted[Math.floor(sorted.length * 0.75)],
    sorted[sorted.length - 1],
    ...candidates.slice(0, 10),
    ...positionalSamples
  ].filter(Boolean) as ExtractionCandidate[]).slice(0, 30);
}

function buildTextStats(candidates: ExtractionCandidate[]): ExtractionTextStats {
  const lengths = candidates.map((candidate) => candidate.original.length);
  return {
    minLength: lengths.length ? Math.min(...lengths) : 0,
    maxLength: lengths.length ? Math.max(...lengths) : 0,
    averageLength: lengths.length ? Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length) : 0,
    uniqueCount: new Set(candidates.map((candidate) => candidate.normalizedOriginal)).size,
    placeholderCount: candidates.filter((candidate) => candidate.risks.includes("placeholder_sensitive")).length,
    htmlLikeCount: candidates.filter((candidate) => candidate.risks.includes("html_fragment")).length
  };
}

function compareExtractionRuleGroups(a: ExtractionRuleGroup, b: ExtractionRuleGroup): number {
  return b.candidateCount - a.candidateCount
    || scoreGroupSort(a) - scoreGroupSort(b)
    || b.textStats.uniqueCount - a.textStats.uniqueCount
    || a.label.localeCompare(b.label);
}

function scoreGroupSort(group: ExtractionRuleGroup): number {
  if (group.ai.recommendation === "include" && !group.backfillSummary.failed && !group.backfillSummary.unsupported) return 0;
  if (group.ai.recommendation === "review") return 1;
  if (group.backfillSummary.failed || group.backfillSummary.unsupported) return 2;
  return 3;
}

function candidateMatchesRule(candidate: ExtractionCandidate, matcher: ExtractionRuleMatcher): boolean {
  if (matcher.groupKey && matcher.groupKey !== candidate.groupKey) return false;
  if (matcher.strategy && matcher.strategy !== candidate.strategy) return false;
  if (matcher.scriptVariables?.length && !matcher.scriptVariables.includes(candidate.context.dataBlockName ?? "")) return false;
  if (matcher.locatorPrefixes?.length && !matcher.locatorPrefixes.some((prefix) => candidate.locator.startsWith(prefix))) return false;
  if (matcher.filePatterns?.length && !matcher.filePatterns.some((pattern) => matchesPlanPattern(candidate.sourceFile, normalizePlanPattern(pattern)))) return false;
  if (matcher.pathPatterns?.length && !matcher.pathPatterns.some((pattern) => matchesPlanPattern(candidate.context.keyPath ?? candidate.locator, normalizePlanPattern(pattern)))) return false;
  return true;
}

function parseCandidateRange(locator: string): { start: number; end: number; kind: string } | null {
  const match = locator.match(/^range:(\d+):(\d+):([a-z-]+)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), kind: match[3] };
}

function parseJsonLocatorParts(locator: string): string[] {
  const pathLocator = locator.startsWith("json:") ? locator.slice("json:".length) : locator;
  const parts: string[] = [];
  for (const match of pathLocator.matchAll(/\[(?:"((?:\\.|[^"\\])*)"|(\d+))\]/g)) {
    parts.push(match[2] ?? (JSON.parse(`"${match[1] ?? ""}"`) as string));
  }
  return parts;
}

function getJsonValue(root: unknown, locator: string): unknown {
  let current: any = root;
  for (const part of parseJsonLocatorParts(locator)) current = current?.[part];
  return current;
}

function normalizeOriginal(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function minifiedRatio(value: string): number {
  if (!value.length) return 0;
  return 1 - value.split(/\r?\n/).length / Math.max(1, value.length / 80);
}

function buildFileMetrics(text: string): FileMetrics {
  const lineStarts = buildLineStarts(text);
  return {
    lineStarts,
    lineLengths: buildLineLengths(text, lineStarts),
    minifiedRatio: minifiedRatio(text)
  };
}

function buildLineLengths(text: string, lineStarts: number[]): number[] {
  return lineStarts.map((start, index) => {
    const next = lineStarts[index + 1] ?? text.length + 1;
    return Math.max(0, next - start - 1);
  });
}

function lineLengthAt(metrics: FileMetrics, offset: number): number {
  return metrics.lineLengths[lineNumberAt(metrics.lineStarts, offset) - 1] ?? 0;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(1, high + 1);
}

function stableHash(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) {
    const group = key(item);
    output.set(group, [...(output.get(group) ?? []), item]);
  }
  return output;
}
