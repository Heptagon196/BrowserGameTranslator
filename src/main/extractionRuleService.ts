import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
  ExtractionCandidate,
  ExtractionDecision,
  ExtractionRule,
  ExtractionRuleGroup,
  ExtractionRulePackage,
  ExtractionRuleReport,
  ExtractionRuleScanResult,
  ExtractionScanProgress,
  ExtractionRulesFile,
  ProjectConfig,
  TextItem
} from "../shared/types";
import { groupExtractionCandidates, materializeTextItemsFromRules, rulesFromIncludedGroups, scanExtractionCandidates, type ScriptDataBlockHint } from "./extractors";
import { compactTextItems, projectDirs, projectPaths, readJson, readJsonl, writeJson, writeJsonl } from "./storage";

export interface ExtractionRuleDecisionUpdate {
  groupId: string;
  decision: ExtractionDecision;
  note?: string;
}

export interface MaterializeExtractionRulesOptions {
  requireIncluded?: boolean;
}

export async function scanProjectExtractionRules(project: ProjectConfig, onProgress?: (progress: ExtractionScanProgress) => void): Promise<ExtractionRuleScanResult> {
  const result = await scanExtractionCandidates(projectDirs(project).originalRoot, { scriptDataBlocks: await loadScriptDataBlockHints(project), onProgress });
  onProgress?.({
    phase: "saving",
    fileCurrent: result.report.fileCount,
    fileTotal: result.report.fileCount,
    fileProgress: 100,
    fileStep: "写入扫描结果",
    message: "正在保存候选文本和规则组..."
  });
  await writeExtractionArtifacts(project, result);
  const activeGroupCount = result.groups.filter((group) => group.userDecision.decision !== "deleted").length;
  onProgress?.({
    phase: "done",
    fileCurrent: result.report.fileCount,
    fileTotal: result.report.fileCount,
    fileProgress: 100,
    fileStep: "扫描完成",
    message: `扫描完成：${activeGroupCount} 个规则组，${result.candidates.length} 条候选文本。`
  });
  return result;
}

async function loadScriptDataBlockHints(project: ProjectConfig): Promise<ScriptDataBlockHint[]> {
  const dirs = [
    path.join(app.getPath("userData"), "extraction-rules"),
    projectRulePackagesDir(project)
  ];
  const hints: ScriptDataBlockHint[] = [];
  for (const dir of dirs) {
    for (const pkg of await readRulePackagesInDir(dir)) {
      for (const rule of pkg.rules) {
        if (rule.strategy !== "js-data-block" || !rule.matcher.scriptVariables?.length) continue;
        hints.push({
          id: rule.id,
          label: rule.label,
          variables: rule.matcher.scriptVariables
        });
      }
    }
  }
  return dedupeScriptDataBlockHints(hints);
}

async function readRulePackagesInDir(dir: string): Promise<ExtractionRulePackage[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const packages: ExtractionRulePackage[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const pkg = await readJson<ExtractionRulePackage | null>(path.join(dir, entry.name), null);
      if (pkg?.schemaVersion === 1 && pkg.kind === "bgt.extractionRulePackage" && Array.isArray(pkg.rules)) packages.push(pkg);
    }
    return packages;
  } catch {
    return [];
  }
}

function dedupeScriptDataBlockHints(hints: ScriptDataBlockHint[]): ScriptDataBlockHint[] {
  const seen = new Set<string>();
  const output: ScriptDataBlockHint[] = [];
  for (const hint of hints) {
    const variables = hint.variables.map((variable) => variable.trim()).filter(Boolean);
    const key = variables.join("\n");
    if (!variables.length || seen.has(key)) continue;
    seen.add(key);
    output.push({ ...hint, variables });
  }
  return output;
}

export async function loadExtractionCandidates(project: ProjectConfig): Promise<ExtractionCandidate[]> {
  return readJsonl<ExtractionCandidate>(extractionCandidatesPath(project));
}

export async function loadExtractionRuleGroups(project: ProjectConfig): Promise<ExtractionRuleGroup[]> {
  return readJson<ExtractionRuleGroup[]>(extractionRuleGroupsPath(project), []);
}

export async function loadConfirmedExtractionRules(project: ProjectConfig): Promise<ExtractionRulesFile> {
  return readJson<ExtractionRulesFile>(extractionRulesPath(project), { schemaVersion: 1, rules: [], updatedAt: "" });
}

export async function saveExtractionRuleDecisions(project: ProjectConfig, updates: ExtractionRuleDecisionUpdate[]): Promise<ExtractionRuleGroup[]> {
  const now = new Date().toISOString();
  const updateMap = new Map(updates.map((update) => [update.groupId, update]));
  const groups = (await loadExtractionRuleGroups(project)).map((group) => {
    const update = updateMap.get(group.id) ?? updateMap.get(group.groupKey);
    if (!update) return group;
    return {
      ...group,
      userDecision: {
        ...group.userDecision,
        decision: update.decision,
        origin: "user" as const,
        note: update.note ?? group.userDecision.note,
        updatedAt: now
      },
      updatedAt: now
    };
  });
  await writeJson(extractionRuleGroupsPath(project), groups);
  const included = groups.filter((group) => group.userDecision.decision === "include");
  await saveConfirmedRules(project, rulesFromIncludedGroups(included));
  return groups;
}

export async function materializeProjectTextItemsFromRules(project: ProjectConfig, options: MaterializeExtractionRulesOptions = {}): Promise<{ items: ReturnType<typeof materializeTextItemsFromRules>; report: ExtractionRuleReport }> {
  const candidates = await loadExtractionCandidates(project);
  const rulesFile = await loadConfirmedExtractionRules(project);
  if (options.requireIncluded !== false && !rulesFile.rules.length) throw new Error("还没有已纳入的提取规则组。");
  const existingItems = await readJsonl<TextItem>(projectPaths(project).textItems);
  const items = mergeMaterializedTextItems(materializeTextItemsFromRules(candidates, rulesFile.rules), existingItems);
  const report = await readJson<ExtractionRuleReport>(extractionRuleReportPath(project), {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    fileCount: 0,
    candidateCount: candidates.length,
    groupCount: 0,
    approvedCandidateCount: items.length,
    duplicateLocatorCount: 0,
    failedValidationCount: 0,
    unsupportedBackfillCount: 0
  });
  const nextReport = { ...report, approvedCandidateCount: items.length };
  await writeJsonl(projectPaths(project).textItems, compactTextItems(items));
  await writeJson(projectPaths(project).scanReport, {
    scannedAt: nextReport.scannedAt,
    fileCount: nextReport.fileCount,
    extractedCount: items.length,
    skippedCount: 0,
    files: []
  });
  await writeJson(extractionRuleReportPath(project), nextReport);
  return { items, report: nextReport };
}

function mergeMaterializedTextItems(nextItems: TextItem[], existingItems: TextItem[]): TextItem[] {
  const existingByStableKey = new Map(existingItems.map((item) => [textItemStableKey(item), item]));
  return nextItems.map((item) => {
    const existing = existingByStableKey.get(textItemStableKey(item));
    if (!existing) return item;
    return {
      ...item,
      translation: existing.translation ?? item.translation,
      status: existing.status ?? item.status
    };
  });
}

function textItemStableKey(item: TextItem): string {
  return `${item.sourceFile}\n${item.locator}\n${item.original}`;
}

export async function createProjectExtractionRulePackage(project: ProjectConfig, displayName?: string): Promise<ExtractionRulePackage> {
  const rulesFile = await loadConfirmedExtractionRules(project);
  const now = new Date().toISOString();
  const pkg: ExtractionRulePackage = {
    schemaVersion: 1,
    kind: "bgt.extractionRulePackage",
    id: normalizePackageId(displayName || `${project.projectName}.generated`),
    displayName: displayName || `${project.projectName} 提取规则`,
    description: "由智能扫描和规则组确认生成的项目提取规则包。",
    engine: "auto",
    tags: ["generated"],
    ruleEngineVersion: "1",
    sourceKind: "generated",
    readonly: false,
    rules: rulesFile.rules,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(projectRulePackagePath(project, pkg.id), pkg);
  return pkg;
}

export async function applyRulePackageToProject(project: ProjectConfig, pkg: ExtractionRulePackage): Promise<ExtractionRulePackage> {
  const now = new Date().toISOString();
  const cleanPackage = stripPackageContextFields(pkg);
  const projectPackage: ExtractionRulePackage = {
    ...cleanPackage,
    id: normalizePackageId(cleanPackage.id),
    sourceKind: cleanPackage.sourceKind === "generated" ? "generated" : "user",
    readonly: false,
    derivedFrom: cleanPackage.sourceKind === "online"
      ? {
          packageId: cleanPackage.id,
          sourceKind: cleanPackage.sourceKind,
          url: cleanPackage.updateUrl?.url
        }
      : cleanPackage.derivedFrom,
    createdAt: now,
    updatedAt: now,
    updateUrl: cleanPackage.sourceKind === "online" ? cleanPackage.updateUrl : undefined
  };
  await writeJson(projectRulePackagePath(project, projectPackage.id), projectPackage);
  await saveConfirmedRules(project, projectPackage.rules);
  return projectPackage;
}

function stripPackageContextFields(pkg: ExtractionRulePackage): ExtractionRulePackage {
  const { gameName: _gameName, sourceLanguage: _sourceLanguage, targetLanguage: _targetLanguage, remote: _remote, ...next } = pkg as ExtractionRulePackage & {
    gameName?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    remote?: unknown;
  };
  return next;
}

async function writeExtractionArtifacts(project: ProjectConfig, result: ExtractionRuleScanResult): Promise<void> {
  await writeJsonl(extractionCandidatesPath(project), result.candidates);
  await writeJson(extractionRuleGroupsPath(project), result.groups);
  await writeJson(extractionRuleReportPath(project), result.report);
  const included = result.groups.filter((group) => group.userDecision.decision === "include");
  await saveConfirmedRules(project, rulesFromIncludedGroups(included));
}

async function saveConfirmedRules(project: ProjectConfig, rules: ExtractionRule[]): Promise<void> {
  await writeJson(extractionRulesPath(project), { schemaVersion: 1, rules, updatedAt: new Date().toISOString() } satisfies ExtractionRulesFile);
}

export function extractionCandidatesPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extracted", "extraction-candidates.jsonl");
}

export function extractionRuleGroupsPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extracted", "extraction-rule-groups.json");
}

export function extractionRulesPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extracted", "extraction-rules.json");
}

export function extractionRuleAiReviewPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extracted", "extraction-rule-ai-review.json");
}

export function extractionRuleReportPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extracted", "extraction-rule-report.json");
}

export function projectRulePackagesDir(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "extraction-rules");
}

export function projectRulePackagePath(project: ProjectConfig, id: string): string {
  return path.join(projectRulePackagesDir(project), `${safeFileName(id)}.json`);
}

function normalizePackageId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || `rules.${Date.now()}`;
}

function safeFileName(value: string): string {
  return normalizePackageId(value).replace(/[<>:"/\\|?*]/g, "_");
}
