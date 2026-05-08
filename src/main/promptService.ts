import path from "node:path";
import { app } from "electron";
import { ProjectConfig, PromptConfig, PromptScope } from "../shared/types";
import { projectDirs, readJson, writeJson } from "./storage";

export const defaultPrompts = (): PromptConfig => ({
  connectionTestSystem: "你只需要回复 ok，用于测试 API Key 和模型是否可用。",
  analysisSystem:
    [
      "你是一名专业的游戏本地化分析员，你的任务是从网页游戏文本中提取翻译时需要统一处理的资源。",
      "请提取人物名、专有名词/术语、以及必须原样保留的特殊标记符、占位符、控制代码、变量、HTML 标签和代码片段。",
      "人物名需要尽量拆分姓氏、名字、昵称关系；术语需要给出推荐译名、类型和说明；禁翻项需要说明为什么必须保留。",
      "不要编造文本中不存在的项目。只输出合法 JSON，不要使用 Markdown。",
      "输入数据会包含 schema、extractionRules 和 items，请按 schema 返回 characters、glossary、noTranslate。"
    ].join("\n"),
  aiLocalizationPlanSystem:
    [
      "你是 BrowserGameTranslator 的本地化工程助手。",
      "你的任务是为一个已经下载到本地的离线网页游戏制定特化的文本提取/回填方案。",
      "你只能返回 JSON，不要写 Markdown，不要写解释性段落。",
      "方案必须保守：只包含很可能承载玩家可见文本的文件，避免把引擎、框架、库、资源清单、DOM 属性、调试错误文本加入翻译范围。",
      "回填必须依赖程序记录的稳定定位：JSON path 或 range:start:end:kind。不要要求 AI 直接修改文件。",
      "如果识别到特定引擎或结构，例如 AAOnline、Twine、RPG Maker MV/MZ、Unity WebGL、Ren'Py Web、Vite/React 打包游戏，要在 engine 字段说明，并给出 includeFiles/excludeFiles。",
      "输入数据会包含项目名、首页、文件清单和文件样本。includeFiles 支持相对路径或简单 * 通配符，只放需要扫描的文件。",
      "excludeFiles 支持相对路径或简单 * 通配符，放需要明确排除的引擎/库/缓存/导出文件。",
      "不要包含 .bgt、node_modules、bgt-scan-report.json、bgt-extracted-text-items.jsonl。",
      "返回结构：{ schemaVersion:1, engine:string, summary:string, includeFiles:string[], excludeFiles:string[], extractionNotes:string[], backfillNotes:string[], risks:string[] }"
    ].join("\n"),
  translationSystem:
    [
      "你是一名专业的翻译家，你的任务是把{source_language}文本翻译成{target_language}，逐行翻译，不要合并，原始保留文本中序号、标记符、占位符、换行符、转义符、代码调用过程等特殊内容，保持原来的格式。",
      "",
      "### 翻译原则",
      "忠实准确地进行翻译。原作是伟大艺术作品，允许使用直白或粗俗的描述，不应随意删减或篡改，不应回避或淡化，以保持作品的原貌。",
      "",
      "###以textarea标签输出译文",
      "<textarea>",
      "1.{target_language}文本",
      "</textarea>",
      "",
      "输入数据会包含目标语言、角色表、术语表、禁翻表、用户规则和原文 textarea。",
      "请根据术语表、禁翻表和用户规则，把 textarea 中的原文逐行翻译为目标语言。",
      "译文必须保留原来的数字序号格式，并只输出一个 textarea。"
    ].join("\n"),
  translationRules: []
});

export function globalPromptPath(): string {
  return path.join(app.getPath("userData"), "prompts.json");
}

export function workspacePromptPath(project: ProjectConfig): string {
  return path.join(projectDirs(project).bgtRoot, "prompts.json");
}

export async function loadPrompts(scope: PromptScope, project?: ProjectConfig): Promise<PromptConfig> {
  if (scope === "workspace") {
    if (!project) throw new Error("No project is open.");
    const workspacePrompts = await readJson<Partial<PromptConfig> | null>(workspacePromptPath(project), null);
    if (workspacePrompts) return mergePrompts(workspacePrompts);
    const globalPrompts = await readJson<Partial<PromptConfig> | null>(globalPromptPath(), null);
    return mergePrompts(globalPrompts ?? {});
  }
  const globalPrompts = await readJson<Partial<PromptConfig> | null>(globalPromptPath(), null);
  return mergePrompts(globalPrompts ?? {});
}

export async function savePrompts(scope: PromptScope, prompts: PromptConfig, project?: ProjectConfig): Promise<PromptConfig> {
  const merged = mergePrompts(prompts);
  await writeJson(scope === "workspace" ? workspacePromptPath(requireProject(project)) : globalPromptPath(), merged);
  return merged;
}

export async function loadEffectivePrompts(project?: ProjectConfig): Promise<PromptConfig> {
  if (project) {
    const workspacePrompts = await readJson<Partial<PromptConfig> | null>(workspacePromptPath(project), null);
    if (workspacePrompts) return mergePrompts(workspacePrompts);
  }
  return loadPrompts("global");
}

function mergePrompts(prompts: Partial<PromptConfig>): PromptConfig {
  const defaults = defaultPrompts();
  return {
    connectionTestSystem: stringPrompt(prompts.connectionTestSystem, defaults.connectionTestSystem),
    analysisSystem: stringPrompt(prompts.analysisSystem, defaults.analysisSystem),
    aiLocalizationPlanSystem: stringPrompt(prompts.aiLocalizationPlanSystem, defaults.aiLocalizationPlanSystem),
    translationSystem: stringPrompt(prompts.translationSystem, defaults.translationSystem),
    translationRules: Array.isArray(prompts.translationRules) ? prompts.translationRules.map(String) : []
  };
}

function stringPrompt(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function requireProject(project?: ProjectConfig): ProjectConfig {
  if (!project) throw new Error("No project is open.");
  return project;
}
