import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AnalysisResult,
  AppStateSnapshot,
  AiLocalizationPlan,
  CharacterEntry,
  DictionaryTableMeta,
  GlossaryEntry,
  NoTranslateEntry,
  ProjectConfig,
  ProviderConfig,
  ProofreadIssue,
  ResourceTableType,
  ScanReport,
  TextItem
} from "../shared/types";

export const emptyAnalysis = (): AnalysisResult => ({
  characters: [],
  glossary: [],
  noTranslate: []
});

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export async function ensureProjectDirs(project: ProjectConfig): Promise<void> {
  const dirs = projectDirs(project);
  await Promise.all([
    fs.mkdir(dirs.originalRoot, { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "extracted"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "resources"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "dictionaries"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "translations"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "qa"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "patches", "backup"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "logs"), { recursive: true })
  ]);
  await ensureBgtGitignore(project);
}

export async function ensureBgtGitignore(project: ProjectConfig): Promise<void> {
  const filePath = path.join(projectDirs(project).bgtRoot, ".gitignore");
  const defaults = defaultBgtGitignoreLines();
  try {
    const existing = await fs.readFile(filePath, "utf8");
    const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const requiredPatterns = defaults.filter((line) => line.trim() && !line.trim().startsWith("#"));
    const missing = requiredPatterns.filter((line) => !existingLines.has(line));
    if (missing.length) {
      const prefix = existing.endsWith("\n") ? "\n" : "\n\n";
      await fs.appendFile(filePath, `${prefix}# BrowserGameTranslator local runtime files\n${missing.join("\n")}\n`, "utf8");
    }
  } catch {
    await fs.writeFile(filePath, `${defaults.join("\n")}\n`, "utf8");
  }
}

function defaultBgtGitignoreLines(): string[] {
  return [
    "# BrowserGameTranslator local runtime files",
    "",
    "# AI chat/session state is local to each collaborator.",
    "/logs/ai-chat.jsonl",
    "/logs/ai-context.json",
    "/logs/agent-checkpoint.json",
    "/logs/agent-task-plan.json",
    "/logs/tasks.log",
    "/logs/*.log",
    "",
    "# Packaging and temporary work directories are regenerated locally.",
    "/package-temp/",
    "/package-staging/",
    "/package-output/",
    "",
    "# Patch backups are local safety copies; keep patch-manifest.json if you need to share applied patch metadata.",
    "/patches/backup/",
    "",
    "# OS/editor noise.",
    ".DS_Store",
    "Thumbs.db",
    "*.tmp",
    "*.bak"
  ];
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export async function writeJsonl<T>(filePath: string, rows: T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

function isResourceTableMeta(value: unknown): value is DictionaryTableMeta {
  return Boolean(value && typeof value === "object" && (value as DictionaryTableMeta).kind === "bgt.resourceTable");
}

export async function readResourceJsonl<T>(filePath: string): Promise<{ meta: DictionaryTableMeta | null; rows: T[] }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const values = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const first = values[0];
    const meta = isResourceTableMeta(first) ? first : null;
    return { meta, rows: (meta ? values.slice(1) : values) as T[] };
  } catch {
    return { meta: null, rows: [] };
  }
}

export async function writeResourceJsonl<T>(filePath: string, meta: DictionaryTableMeta, rows: T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = [meta, ...rows].map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

export function projectDirs(project: ProjectConfig) {
  const projectRoot = path.resolve(project.projectRoot);
  const bgtRoot = path.join(projectRoot, ".bgt");
  return {
    projectRoot,
    bgtRoot,
    originalRoot: path.join(bgtRoot, "original")
  };
}

export const projectPaths = (project: ProjectConfig) => {
  const dirs = projectDirs(project);
  return {
    project: path.join(dirs.bgtRoot, "project.json"),
    textItems: path.join(dirs.bgtRoot, "extracted", "text-items.jsonl"),
    scanReport: path.join(dirs.bgtRoot, "extracted", "scan-report.json"),
    aiLocalizationPlan: path.join(dirs.bgtRoot, "extracted", "ai-localization-plan.json"),
    characters: path.join(dirs.bgtRoot, "resources", "characters.jsonl"),
    glossary: path.join(dirs.bgtRoot, "resources", "glossary.jsonl"),
    noTranslate: path.join(dirs.bgtRoot, "resources", "no-translate.jsonl"),
    dictionaries: path.join(dirs.bgtRoot, "dictionaries"),
    issues: path.join(dirs.bgtRoot, "qa", "issues.jsonl"),
    aiChat: path.join(dirs.bgtRoot, "logs", "ai-chat.jsonl"),
    aiContext: path.join(dirs.bgtRoot, "logs", "ai-context.json"),
    agentCheckpoint: path.join(dirs.bgtRoot, "logs", "agent-checkpoint.json"),
    agentTaskPlan: path.join(dirs.bgtRoot, "logs", "agent-task-plan.json"),
    patchManifest: path.join(dirs.bgtRoot, "patches", "patch-manifest.json")
  };
};

export function defaultResourceTableMeta(project: ProjectConfig, tableType: ResourceTableType): DictionaryTableMeta {
  const now = new Date().toISOString();
  const labels: Record<ResourceTableType, string> = {
    characters: "项目人物表",
    glossary: "项目术语表",
    noTranslate: "项目禁翻表"
  };
  return {
    schemaVersion: 1,
    kind: "bgt.resourceTable",
    id: `project.${tableType}`,
    tableType,
    displayName: labels[tableType],
    description: `${project.projectName} 的默认${labels[tableType].replace("项目", "")}`,
    gameName: project.projectName,
    sourceLanguage: project.sourceLanguage,
    targetLanguage: project.targetLanguage,
    createdAt: project.createdAt || now,
    updatedAt: now
  };
}

export async function loadSnapshot(project: ProjectConfig): Promise<AppStateSnapshot> {
  const paths = projectPaths(project);
  const analysis = emptyAnalysis();
  analysis.characters = (await readResourceJsonl<CharacterEntry>(paths.characters)).rows;
  analysis.glossary = (await readResourceJsonl<GlossaryEntry>(paths.glossary)).rows;
  analysis.noTranslate = (await readResourceJsonl<NoTranslateEntry>(paths.noTranslate)).rows;
  return {
    project,
    providers: [] as ProviderConfig[],
    activeProviderId: "deepseek-main",
    activeChatProviderId: "deepseek-main",
    recentProjects: [],
    textItems: await readJsonl<TextItem>(paths.textItems),
    scanReport: await readJson<ScanReport | null>(paths.scanReport, null),
    aiLocalizationPlan: await readJson<AiLocalizationPlan | null>(paths.aiLocalizationPlan, null),
    analysis,
    issues: await readJsonl<ProofreadIssue>(paths.issues)
  };
}

export async function saveAnalysis(project: ProjectConfig, analysis: AnalysisResult): Promise<void> {
  const paths = projectPaths(project);
  const [charactersMeta, glossaryMeta, noTranslateMeta] = await Promise.all([
    readResourceJsonl<CharacterEntry>(paths.characters),
    readResourceJsonl<GlossaryEntry>(paths.glossary),
    readResourceJsonl<NoTranslateEntry>(paths.noTranslate)
  ]);
  await Promise.all([
    writeResourceJsonl(paths.characters, updateResourceMeta(charactersMeta.meta ?? defaultResourceTableMeta(project, "characters")), analysis.characters),
    writeResourceJsonl(paths.glossary, updateResourceMeta(glossaryMeta.meta ?? defaultResourceTableMeta(project, "glossary")), analysis.glossary),
    writeResourceJsonl(paths.noTranslate, updateResourceMeta(noTranslateMeta.meta ?? defaultResourceTableMeta(project, "noTranslate")), analysis.noTranslate)
  ]);
}

function updateResourceMeta(meta: DictionaryTableMeta): DictionaryTableMeta {
  return { ...meta, updatedAt: new Date().toISOString() };
}

export async function appendLog(project: ProjectConfig, message: string): Promise<void> {
  const redacted = message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
  await fs.appendFile(path.join(projectDirs(project).bgtRoot, "logs", "tasks.log"), `${new Date().toISOString()} ${redacted}\n`, "utf8");
}
