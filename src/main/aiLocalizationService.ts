import fs from "node:fs/promises";
import path from "node:path";
import { AiLocalizationPlan, ProjectConfig, PromptConfig, ProviderConfig } from "../shared/types";
import { chatCompletion } from "./aiProvider";
import { projectDirs, projectPaths, readJson, toPosixPath, writeJson } from "./storage";

type AiMessage = { role: string; content: string };

interface FileSample {
  path: string;
  bytes: number;
  head: string;
  notableLines: string[];
}

const sampleBytes = 80 * 1024;

export async function loadAiLocalizationPlan(project: ProjectConfig): Promise<AiLocalizationPlan | null> {
  return readJson<AiLocalizationPlan | null>(projectPaths(project).aiLocalizationPlan, null);
}

export async function saveAiLocalizationPlan(project: ProjectConfig, plan: AiLocalizationPlan): Promise<AiLocalizationPlan> {
  await writeJson(projectPaths(project).aiLocalizationPlan, plan);
  return plan;
}

export async function generateAiLocalizationPlan(project: ProjectConfig, provider: ProviderConfig, prompts: PromptConfig): Promise<AiLocalizationPlan> {
  return (await generateAiLocalizationPlanWithIo(project, provider, prompts)).plan;
}

export async function generateAiLocalizationPlanWithIo(project: ProjectConfig, provider: ProviderConfig, prompts: PromptConfig): Promise<{ plan: AiLocalizationPlan; requestMessages: AiMessage[]; responseContent: string }> {
  const samples = await collectFileSamples(projectDirs(project).originalRoot);
  const requestMessages = [
    { role: "system", content: prompts.aiLocalizationPlanSystem },
    {
      role: "user",
      content: JSON.stringify(
        {
          projectName: project.projectName,
          homePage: project.homePage,
          fileCount: samples.length,
          files: samples
        },
        null,
        2
      )
    }
  ];
  const content = await chatCompletion(provider, requestMessages);
  const parsed = parsePlanJson(content);
  const plan: AiLocalizationPlan = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    engine: stringValue(parsed.engine, "Unknown HTML game"),
    summary: stringValue(parsed.summary, "AI generated localization plan."),
    includeFiles: stringArray(parsed.includeFiles).filter(isAllowedPlanPath),
    excludeFiles: Array.from(new Set([...stringArray(parsed.excludeFiles), ".bgt/**", "node_modules/**", "bgt-scan-report.json", "bgt-extracted-text-items.jsonl"])).filter(Boolean),
    extractionNotes: stringArray(parsed.extractionNotes),
    backfillNotes: stringArray(parsed.backfillNotes),
    risks: stringArray(parsed.risks)
  };
  if (!plan.includeFiles.length) {
    plan.includeFiles = samples.filter((sample) => /\.(html?|mjs|cjs|js|json|txt)$/i.test(sample.path)).slice(0, 20).map((sample) => sample.path);
  }
  return { plan: await saveAiLocalizationPlan(project, plan), requestMessages, responseContent: content };
}

async function collectFileSamples(root: string): Promise<FileSample[]> {
  const files: FileSample[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".bgt" || entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toPosixPath(path.relative(root, fullPath));
      if (!isAllowedPlanPath(relative) || !/\.(html?|mjs|cjs|js|json|txt|csv|ya?ml)$/i.test(relative)) continue;
      const stat = await fs.stat(fullPath);
      const text = await readTextHead(fullPath, sampleBytes);
      files.push({
        path: relative,
        bytes: stat.size,
        head: text.slice(0, 1600),
        notableLines: notableLines(text).slice(0, 20)
      });
    }
  }
  await walk(root);
  return files.sort((a, b) => scoreSample(b) - scoreSample(a)).slice(0, 40);
}

async function readTextHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function notableLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /trial_|initial_|story|passage|dialog|text|message|name|title|content|frames|profiles|evidence|Twine|RPG|Unity|Ren'Py|Vite|React/i.test(line))
    .map((line) => line.slice(0, 260));
}

function scoreSample(sample: FileSample): number {
  const haystack = `${sample.path}\n${sample.head}\n${sample.notableLines.join("\n")}`;
  let score = 0;
  if (/index\.html$/i.test(sample.path)) score += 30;
  if (/Twine|SugarCube|RPG Maker|UnityLoader|__NEXT_DATA__|vite|React|story|passage|dialog|message|frames/i.test(haystack)) score += 60;
  if (/\.(json)$/i.test(sample.path)) score += 20;
  if (/\.(js|mjs)$/i.test(sample.path)) score += 10;
  return score;
}

function parsePlanJson(content: string): Record<string, unknown> {
  const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 未返回有效的本地化方案 JSON。");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

function isAllowedPlanPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.?\//, "");
  return Boolean(normalized) && !normalized.startsWith(".bgt/") && normalized !== "bgt-scan-report.json" && normalized !== "bgt-extracted-text-items.jsonl";
}
