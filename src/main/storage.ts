import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AnalysisResult,
  AppStateSnapshot,
  AiLocalizationPlan,
  ChatMessage,
  ProjectConfig,
  ProviderConfig,
  ProofreadIssue,
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
    fs.mkdir(path.join(dirs.bgtRoot, "translations"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "qa"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "patches", "backup"), { recursive: true }),
    fs.mkdir(path.join(dirs.bgtRoot, "logs"), { recursive: true })
  ]);
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
    issues: path.join(dirs.bgtRoot, "qa", "issues.jsonl"),
    chat: path.join(dirs.bgtRoot, "logs", "ai-chat.jsonl"),
    patchManifest: path.join(dirs.bgtRoot, "patches", "patch-manifest.json")
  };
};

export async function loadSnapshot(project: ProjectConfig): Promise<AppStateSnapshot> {
  const paths = projectPaths(project);
  const analysis = emptyAnalysis();
  analysis.characters = await readJsonl(paths.characters);
  analysis.glossary = await readJsonl(paths.glossary);
  analysis.noTranslate = await readJsonl(paths.noTranslate);
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
    issues: await readJsonl<ProofreadIssue>(paths.issues),
    chat: await readJsonl<ChatMessage>(paths.chat)
  };
}

export async function saveAnalysis(project: ProjectConfig, analysis: AnalysisResult): Promise<void> {
  const paths = projectPaths(project);
  await Promise.all([
    writeJsonl(paths.characters, analysis.characters),
    writeJsonl(paths.glossary, analysis.glossary),
    writeJsonl(paths.noTranslate, analysis.noTranslate)
  ]);
}

export async function appendLog(project: ProjectConfig, message: string): Promise<void> {
  const redacted = message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
  await fs.appendFile(path.join(projectDirs(project).bgtRoot, "logs", "tasks.log"), `${new Date().toISOString()} ${redacted}\n`, "utf8");
}
