import fs from "node:fs/promises";
import path from "node:path";
import { app, dialog } from "electron";
import {
  ExtractionCandidate,
  ExtractionRulePackage,
  ExtractionRulePackageDryRunResult,
  ExtractionRulePackageImportResult,
  ExtractionRulePackageUpdateUrl,
  ExtractionRulePackageSummary,
  ExtractionRuleScope,
  ProjectConfig
} from "../shared/types";
import { materializeTextItemsFromRules, scanExtractionCandidates, type ScriptDataBlockHint } from "./extractors";
import { applyRulePackageToProject, loadExtractionCandidates, projectRulePackagePath, projectRulePackagesDir } from "./extractionRuleService";
import { projectDirs, readJson, writeJson } from "./storage";

export async function listExtractionRulePackages(project?: ProjectConfig): Promise<ExtractionRulePackageSummary[]> {
  const [global, projectPackages] = await Promise.all([
    listPackagesInDir(globalRulePackagesDir(), "global", project),
    project ? listPackagesInDir(projectRulePackagesDir(project), "project", project) : Promise.resolve([])
  ]);
  return [...projectPackages, ...global].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.displayName.localeCompare(b.displayName));
}

export async function loadExtractionRulePackage(scope: ExtractionRuleScope, id: string, project?: ProjectConfig, fileName?: string): Promise<ExtractionRulePackage> {
  const filePath = packageFilePath(scope, id, project, fileName);
  const pkg = await readJson<ExtractionRulePackage | null>(filePath, null);
  if (!pkg) throw new Error("找不到提取规则包。");
  validateExtractionRulePackage(pkg);
  return stripPackageContextFields(pkg);
}

export async function saveExtractionRulePackage(scope: ExtractionRuleScope, pkg: ExtractionRulePackage, project?: ProjectConfig, fileName?: string): Promise<ExtractionRulePackage> {
  validateExtractionRulePackage(pkg);
  if (pkg.readonly) throw new Error("只读规则包不能直接保存，请先复制。");
  const now = new Date().toISOString();
  const cleanPackage = stripPackageContextFields(pkg);
  const next = { ...cleanPackage, readonly: false, updatedAt: now };
  await writeJson(packageFilePath(scope, next.id, project, fileName), next);
  return next;
}

export async function deleteExtractionRulePackage(scope: ExtractionRuleScope, id: string, project?: ProjectConfig, fileName?: string): Promise<void> {
  await fs.unlink(packageFilePath(scope, id, project, fileName));
}

export interface ClearExtractionRulePackageUpdateUrlsTarget {
  sourceId?: string;
  discussionId?: string;
  discussionNumber?: number;
  url?: string;
}

export async function clearExtractionRulePackageUpdateUrls(target: ClearExtractionRulePackageUpdateUrlsTarget, project?: ProjectConfig): Promise<{ updatedCount: number }> {
  let updatedCount = 0;
  const summaries = await listExtractionRulePackages(project);
  for (const summary of summaries) {
    if (summary.scope !== "global" && summary.scope !== "project") continue;
    const pkg = await loadExtractionRulePackage(summary.scope, summary.id, project, summary.fileName);
    if (!pkg.updateUrl || !updateUrlMatches(pkg.updateUrl, target)) continue;
    const next: ExtractionRulePackage = { ...pkg, updateUrl: undefined, updatedAt: new Date().toISOString() };
    await writeJson(packageFilePath(summary.scope, next.id, project, summary.fileName), next);
    updatedCount += 1;
  }
  return { updatedCount };
}

export async function importExtractionRulePackage(scope: ExtractionRuleScope, project?: ProjectConfig, conflictMode?: "overwrite" | "newId", pendingPackage?: ExtractionRulePackage): Promise<ExtractionRulePackageImportResult> {
  const pkg = pendingPackage ?? await pickRulePackageJson();
  if (!pkg) return { status: "cancelled" };
  validateExtractionRulePackage(pkg);
  const cleanPackage = stripPackageContextFields(pkg);
  const targetDir = scope === "project" ? projectRulePackagesDir(requireProject(project)) : globalRulePackagesDir();
  const existing = await findPackageSummary(targetDir, cleanPackage.id, scope);
  if (existing && conflictMode !== "overwrite") {
    if (conflictMode === "newId") {
      const next = { ...cleanPackage, id: suggestConflictPackageId(cleanPackage.id), displayName: `${cleanPackage.displayName} 副本`, readonly: false };
      await writeJson(path.join(targetDir, `${next.id}.json`), next);
      return { status: "imported", package: next };
    }
    return { status: "conflict", package: cleanPackage, existing };
  }
  const next = { ...cleanPackage, readonly: false };
  await writeJson(path.join(targetDir, `${safeFileName(next.id)}.json`), next);
  return { status: "imported", package: next };
}

export async function exportExtractionRulePackage(pkg: ExtractionRulePackage): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    defaultPath: `${safeFileName(pkg.id)}.json`,
    filters: [{ name: "Extraction rule package", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return null;
  await writeJson(result.filePath, stripPackageContextFields(pkg));
  return result.filePath;
}

export async function copyExtractionRulePackageToProject(pkg: ExtractionRulePackage, project: ProjectConfig): Promise<ExtractionRulePackage> {
  return applyRulePackageToProject(project, stripPackageContextFields(pkg));
}

export async function copyExtractionRulePackageToGlobal(pkg: ExtractionRulePackage): Promise<ExtractionRulePackage> {
  const now = new Date().toISOString();
  const cleanPackage = stripPackageContextFields(pkg);
  const next: ExtractionRulePackage = {
    ...cleanPackage,
    sourceKind: "user",
    readonly: false,
    derivedFrom: cleanPackage.sourceKind === "online"
      ? { packageId: cleanPackage.id, sourceKind: cleanPackage.sourceKind, url: cleanPackage.updateUrl?.url }
      : cleanPackage.derivedFrom,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(path.join(globalRulePackagesDir(), `${safeFileName(next.id)}.json`), next);
  return next;
}

export async function dryRunExtractionRulePackage(project: ProjectConfig, pkg: ExtractionRulePackage): Promise<ExtractionRulePackageDryRunResult> {
  validateExtractionRulePackage(pkg);
  const cachedCandidates = await loadExtractionCandidates(project);
  const candidates = cachedCandidates.length ? cachedCandidates : (await scanExtractionCandidates(projectDirs(project).originalRoot, { scriptDataBlocks: scriptDataBlocksFromPackage(pkg) })).candidates;
  const matched = candidates.filter((candidate) => pkg.rules.some((rule) => candidateMatchesPackageRule(candidate, rule.matcher)));
  const materialized = materializeTextItemsFromRules(candidates, pkg.rules);
  return {
    packageId: pkg.id,
    fileCount: new Set(matched.map((candidate) => candidate.sourceFile)).size,
    candidateCount: candidates.length,
    matchedCandidateCount: materialized.length,
    groupCount: new Set(matched.map((candidate) => candidate.groupKey)).size,
    backfillSummary: {
      safe: matched.filter((candidate) => candidate.backfill.validation === "safe").length,
      warning: matched.filter((candidate) => candidate.backfill.validation === "warning").length,
      failed: matched.filter((candidate) => candidate.backfill.validation === "failed").length,
      unsupported: matched.filter((candidate) => !candidate.backfill.supported).length
    },
    samples: matched.slice(0, 20),
    risks: Array.from(new Set(matched.flatMap((candidate) => candidate.risks)))
  };
}

export function validateExtractionRulePackage(pkg: ExtractionRulePackage): void {
  if (pkg.schemaVersion !== 1 || pkg.kind !== "bgt.extractionRulePackage") throw new Error("不是有效的提取规则包。");
  if (!pkg.id.trim() || !pkg.displayName.trim()) throw new Error("规则包缺少 id 或名称。");
  if (pkg.ruleEngineVersion !== "1") throw new Error(`不支持的规则引擎版本：${pkg.ruleEngineVersion}`);
  if (!Array.isArray(pkg.rules)) throw new Error("规则包 rules 必须是数组。");
  for (const rule of pkg.rules) {
    if (!rule.id || !rule.strategy || !rule.matcher || rule.decision !== "include") throw new Error("规则包包含不支持的规则。");
  }
}

export function globalRulePackagesDir(): string {
  return path.join(app.getPath("userData"), "extraction-rules");
}

async function listPackagesInDir(dir: string, scope: ExtractionRulePackageSummary["scope"], project?: ProjectConfig): Promise<ExtractionRulePackageSummary[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const summaries: ExtractionRulePackageSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const pkg = await readJson<ExtractionRulePackage | null>(path.join(dir, entry.name), null);
      if (!pkg) continue;
      try {
        validateExtractionRulePackage(pkg);
        summaries.push(toSummary(scope, pkg, entry.name, project));
      } catch {
        continue;
      }
    }
    return summaries;
  } catch {
    return [];
  }
}

function toSummary(scope: ExtractionRulePackageSummary["scope"], pkg: ExtractionRulePackage, fileName: string, project?: ProjectConfig): ExtractionRulePackageSummary {
  return {
    scope,
    id: pkg.id,
    displayName: pkg.displayName,
    description: pkg.description,
    engine: pkg.engine,
    tags: pkg.tags,
    sourceKind: pkg.sourceKind,
    readonly: pkg.readonly,
    ruleCount: pkg.rules.length,
    updatedAt: pkg.updatedAt,
    updateUrl: pkg.updateUrl,
    fileName
  };
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

async function pickRulePackageJson(): Promise<ExtractionRulePackage | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Extraction rule package", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readJson<ExtractionRulePackage | null>(result.filePaths[0], null);
}

async function findPackageSummary(dir: string, id: string, scope: ExtractionRulePackageSummary["scope"]): Promise<ExtractionRulePackageSummary | undefined> {
  const summaries = await listPackagesInDir(dir, scope);
  return summaries.find((summary) => summary.id === id);
}

function packageFilePath(scope: ExtractionRuleScope, id: string, project?: ProjectConfig, fileName?: string): string {
  const dir = scope === "project" ? projectRulePackagesDir(requireProject(project)) : globalRulePackagesDir();
  return path.join(dir, fileName ?? `${safeFileName(id)}.json`);
}

function updateUrlMatches(updateUrl: ExtractionRulePackageUpdateUrl, target: ClearExtractionRulePackageUpdateUrlsTarget): boolean {
  if (target.url && normalizeRemoteUrl(updateUrl.url) === normalizeRemoteUrl(target.url)) return true;
  if (target.sourceId && target.discussionId && updateUrl.sourceId === target.sourceId && updateUrl.discussionId === target.discussionId) return true;
  if (target.sourceId && target.discussionNumber && updateUrl.sourceId === target.sourceId && updateUrl.discussionNumber === target.discussionNumber) return true;
  return false;
}

function normalizeRemoteUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function candidateMatchesPackageRule(candidate: ExtractionCandidate, matcher: ExtractionRulePackage["rules"][number]["matcher"]): boolean {
  if (matcher.groupKey && matcher.groupKey !== candidate.groupKey) return false;
  if (matcher.strategy && matcher.strategy !== candidate.strategy) return false;
  if (matcher.scriptVariables?.length && !matcher.scriptVariables.includes(candidate.context.dataBlockName ?? "")) return false;
  if (matcher.locatorPrefixes?.length && !matcher.locatorPrefixes.some((prefix) => candidate.locator.startsWith(prefix))) return false;
  if (matcher.filePatterns?.length && !matcher.filePatterns.some((pattern) => wildcardMatch(candidate.sourceFile, pattern))) return false;
  if (matcher.pathPatterns?.length && !matcher.pathPatterns.some((pattern) => wildcardMatch(candidate.context.keyPath ?? candidate.locator, pattern))) return false;
  return true;
}

function scriptDataBlocksFromPackage(pkg: ExtractionRulePackage): ScriptDataBlockHint[] {
  return pkg.rules
    .filter((rule) => rule.strategy === "js-data-block" && rule.matcher.scriptVariables?.length)
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      variables: rule.matcher.scriptVariables ?? []
    }));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (!normalized.includes("*")) return value === normalized || value.includes(normalized);
  const regex = new RegExp(`^${normalized.split("*").map(escapeRegExp).join(".*")}$`, "i");
  return regex.test(value);
}

function scopeRank(scope: ExtractionRulePackageSummary["scope"]): number {
  return scope === "project" ? 0 : scope === "global" ? 1 : 2;
}

function requireProject(project?: ProjectConfig): ProjectConfig {
  if (!project) throw new Error("No project is open.");
  return project;
}

function safeFileName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || `rules.${Date.now()}`;
}

function suggestConflictPackageId(id: string): string {
  return `${safeFileName(id)}.copy.${Date.now()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
