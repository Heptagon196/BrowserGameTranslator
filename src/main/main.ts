import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell, Menu } from "electron";
import { getFonts } from "font-list";
import { downloadAaOnlineGame, validateAaOfflineOutputDirectory } from "./aaofflineService";
import { AgentChatHistoryService } from "./agent/agentChatHistoryService";
import { recordAgentToolResultInTaskPlan, runAgent } from "./agent/agentRuntime";
import { executeAgentTool } from "./agent/agentTools";
import { generateAiLocalizationPlanWithIo, loadAiLocalizationPlan } from "./aiLocalizationService";
import { AiResponseParseError, analyzeWithProviderWithIo, proofreadWithProviderWithIo, setAiUsageRecorder, testProvider, translateAnalysisResourcesWithProviderWithIo, translateWithProvider } from "./aiProvider";
import { loadProviderBalance } from "./costService";
import { createEmptyDictionaryTable, deleteDictionaryTable, exportDictionaryTable, importDictionaryTable, listDictionaryTables, loadDictionaryTable, saveDictionaryTable as saveDictionaryTableFile } from "./dictionaryService";
import { extractGameTexts } from "./extractors";
import { exportTextItems, importTextItems } from "./importExport";
import { analyzeLocally } from "./localAnalysis";
import { downloadItchHtml5Game } from "./itchService";
import { applyPatch, previewPatch, restoreWorkingCopy } from "./patchService";
import { openProjectDirectory as openProjectDirectoryInShell, packageProject } from "./packageService";
import { getProjectPreviewStatus, previewProjectGame, stopProjectGamePreview } from "./previewService";
import { ProjectService } from "./projectService";
import { defaultProofreadOptions, proofreadItems } from "./proofread";
import { appendLog, projectDirs, projectPaths, readJsonl, saveAnalysis, writeJson, writeJsonl } from "./storage";
import { isWebSearchCdpHostProcess, runWebSearchCdpHost } from "./webSearchCdpHost";
import {
  AaOfflineDownloadInput,
  AgentChatHistoryItem,
  AgentCancelRequest,
  AgentRunRequest,
  AgentRunStreamRequest,
  AgentToolApprovalRequest,
  ItchDownloadInput,
  PackageProjectInput,
  ProgramAiIoEvent,
  ProofreadIssue,
  ProofreadOptions,
  PromptConfig,
  PromptScope,
  ProviderConfig,
  TextItem
} from "../shared/types";

if (isWebSearchCdpHostProcess()) {
  runWebSearchCdpHost(app).catch((error) => {
    console.error(error);
    app.quit();
  });
} else {
const projectService = new ProjectService();
const agentChatHistoryService = new AgentChatHistoryService(projectService);
const activeAgentRuns = new Map<string, AbortController>();

function optionalProject() {
  try {
    return projectService.project;
  } catch {
    return undefined;
  }
}

function publishProgramAiIo(event: Omit<ProgramAiIoEvent, "id" | "createdAt">): void {
  const payload: ProgramAiIoEvent = {
    id: `program_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...event
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("ai-program:io", payload);
  }
}

async function withProgramAiIo<T>(
  title: string,
  task: () => Promise<T & { requestMessages?: Array<{ role: string; content: string }>; responseContent?: string }>
): Promise<T> {
  try {
    const result = await task();
    if (result.requestMessages?.length || result.responseContent) {
      publishProgramAiIo({
        title,
        requestMessages: result.requestMessages ?? [],
        responseContent: result.responseContent ?? "",
        ok: true
      });
    }
    return result;
  } catch (error) {
    if (error instanceof AiResponseParseError) {
      publishProgramAiIo({
        title,
        requestMessages: error.requestMessages,
        responseContent: error.responseContent,
        ok: false,
        error: error.message
      });
    }
    throw error;
  }
}

setAiUsageRecorder((provider, usage) => {
  if (!usage) return;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("ai-cost:update");
  }
});

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null);
  const icon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "BrowserGameTranslator",
    icon,
    webPreferences: {
      partition: "persist:bgt-main",
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenu(null);

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function resolveAppIcon(): string | undefined {
  const relativePath = path.join("resources", "icon", "app.ico");
  const candidates = [
    path.join(process.cwd(), relativePath),
    path.join(__dirname, "..", "..", relativePath),
    path.join(process.resourcesPath, relativePath),
    path.join(process.resourcesPath, "icon", "app.ico")
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function isPathInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

ipcMain.handle("dialog:selectDirectory", () => projectService.selectDirectory());
ipcMain.handle("external:open", async (_event, url: string) => {
  if (!/^https:\/\/[A-Za-z0-9.-]+\//.test(url)) throw new Error("Only HTTPS URLs can be opened externally.");
  await shell.openExternal(url);
});
ipcMain.handle("project:create", async (_event, input) => projectService.createProject(input));
ipcMain.handle("project:open", async () => projectService.openProject());
ipcMain.handle("project:openDirectory", async (_event, directory: string) => projectService.openProjectDirectory(directory));
ipcMain.handle("project:openRecent", async (_event, projectPath: string) => projectService.openProjectAt(projectPath));
ipcMain.handle("project:validateCreate", async (_event, input) => projectService.validateCreateProject(input));
ipcMain.handle("project:recent", async () => projectService.loadRecentProjects());
ipcMain.handle("project:refresh", async () => projectService.refresh());
ipcMain.handle("project:update", async (_event, project) => projectService.updateProject(project));
ipcMain.handle("project:previewGame", async () => previewProjectGame(projectService.project));
ipcMain.handle("project:previewStatus", async () => getProjectPreviewStatus(projectService.project));
ipcMain.handle("project:stopPreview", async () => stopProjectGamePreview(projectService.project));
ipcMain.handle("project:openDirectoryInShell", async () => openProjectDirectoryInShell(projectService.project, shell.openPath));
ipcMain.handle("project:package", async (_event, input: PackageProjectInput) => packageProject(projectService.project, input));
ipcMain.handle("providers:load", async () => projectService.loadProviderSettings());
ipcMain.handle("providers:save", async (_event, providers: ProviderConfig[]) => projectService.saveProviders(providers));
ipcMain.handle("providers:setActive", async (_event, activeProviderId: string) => projectService.saveActiveProviderId(activeProviderId));
ipcMain.handle("providers:setActiveChat", async (_event, activeChatProviderId: string) => projectService.saveActiveChatProviderId(activeChatProviderId));
ipcMain.handle("providers:test", async (_event, provider: ProviderConfig) => testProvider(provider, await projectService.loadEffectivePrompts()));
ipcMain.handle("ai-balance:load", async (_event, provider: ProviderConfig) => loadProviderBalance(provider));
ipcMain.handle("agent:run", async (_event, request: AgentRunRequest) => runAgent(projectService, request));
ipcMain.handle("agent:runStream", async (event, request: AgentRunStreamRequest) => {
  const controller = new AbortController();
  const sender = event.sender;
  activeAgentRuns.set(request.clientRunId, controller);
  try {
    return await runAgent(
      projectService,
      request,
      (agentEvent) => {
        if (!sender.isDestroyed()) sender.send("agent:event", { clientRunId: request.clientRunId, event: agentEvent });
      },
      controller.signal
    );
  } finally {
    activeAgentRuns.delete(request.clientRunId);
  }
});
ipcMain.handle("agent:cancel", async (_event, request: AgentCancelRequest) => {
  activeAgentRuns.get(request.clientRunId)?.abort();
});
ipcMain.handle("agent:executeApprovedTool", async (_event, request: AgentToolApprovalRequest) => {
  const result = await executeAgentTool(projectService, request.toolName, request.args, { permissionMode: request.permissionMode, approved: true });
  await recordAgentToolResultInTaskPlan(projectService, request.toolName, result);
  return result;
});
ipcMain.handle("agent:history:load", async () => agentChatHistoryService.load());
ipcMain.handle("agent:history:append", async (_event, item: AgentChatHistoryItem) => agentChatHistoryService.append(item));
ipcMain.handle("agent:history:clear", async () => agentChatHistoryService.clear());
ipcMain.handle("system:fonts", async () => Array.from(new Set(await getFonts({ disableQuoting: true }))).sort((a, b) => a.localeCompare(b)));
ipcMain.handle("prompts:load", async (_event, scope: PromptScope) => projectService.loadPrompts(scope));
ipcMain.handle("prompts:save", async (_event, scope: PromptScope, prompts: PromptConfig) => projectService.savePrompts(scope, prompts));
ipcMain.handle("prompts:defaults", async () => projectService.loadDefaultPrompts());

ipcMain.handle("tools:itch:downloadHtml5", async (event, input: ItchDownloadInput) => {
  const sender = event.sender;
  return downloadItchHtml5Game(input, (logEvent) => {
    if (!sender.isDestroyed()) sender.send("tools:itch:log", logEvent);
  });
});
ipcMain.handle("tools:aaoffline:download", async (event, input: AaOfflineDownloadInput) => {
  const sender = event.sender;
  return downloadAaOnlineGame(input, (logEvent) => {
    if (!sender.isDestroyed()) sender.send("tools:aaoffline:log", logEvent);
  });
});
ipcMain.handle("tools:aaoffline:validateOutput", async (_event, outputPath: string) => validateAaOfflineOutputDirectory(outputPath));

ipcMain.handle("extract:start", async () => {
  const project = projectService.project;
  const result = await extractGameTexts(projectDirs(project).originalRoot);
  await writeJsonl(projectPaths(project).textItems, result.items);
  await writeJson(projectPaths(project).scanReport, result.report);
  await appendLog(project, `Extracted ${result.items.length} text items from ${result.report.fileCount} files.`);
  return projectService.refresh();
});

ipcMain.handle("extract:aiPlan", async (_event, provider: ProviderConfig) => {
  const project = projectService.project;
  const { plan } = await withProgramAiIo("AI 生成提取方案", async () =>
    generateAiLocalizationPlanWithIo(project, provider, await projectService.loadEffectivePrompts())
  );
  await appendLog(project, `AI localization plan generated for ${plan.engine}.`);
  return projectService.refresh();
});

ipcMain.handle("extract:ai", async () => {
  const project = projectService.project;
  const plan = await loadAiLocalizationPlan(project);
  if (!plan) throw new Error("没有 AI 本地化方案。请先生成 AI 方案。");
  const result = await extractGameTexts(projectDirs(project).originalRoot, { includeFiles: plan.includeFiles, excludeFiles: plan.excludeFiles });
  await writeJsonl(projectPaths(project).textItems, result.items);
  await writeJson(projectPaths(project).scanReport, result.report);
  await appendLog(project, `AI-guided extraction completed with ${result.items.length} text items using ${plan.engine}.`);
  return projectService.refresh();
});

ipcMain.handle("items:save", async (_event, items: TextItem[]) => projectService.saveTextItems(items));
ipcMain.handle("items:export", async (_event, items: TextItem[], format: "jsonl" | "csv") => exportTextItems(projectService.project, items, format));
ipcMain.handle("items:import", async () => importTextItems(projectService.project));
ipcMain.handle("source:readOriginalFile", async (_event, sourceFile: string) => {
  const project = projectService.project;
  const normalizedSourceFile = sourceFile.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = projectDirs(project).originalRoot;
  const filePath = path.resolve(root, normalizedSourceFile);
  if (!isPathInsideOrSame(filePath, root)) throw new Error("源文件路径不能指向 .bgt/original 外。");
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("源文件不存在。");
  const content = await fs.readFile(filePath, "utf8");
  return { sourceFile: normalizedSourceFile, content, bytes: stats.size };
});

ipcMain.handle("analysis:start", async (_event, provider: ProviderConfig) => {
  const project = projectService.project;
  const items = await projectService.readTextItems();
  const output = await withProgramAiIo("AI 分析资源", async () => analyzeWithProviderWithIo(provider, items, await projectService.loadEffectivePrompts()));
  const { result } = output;
  await saveAnalysis(project, result);
  await appendLog(project, `Analysis produced ${result.characters.length} characters, ${result.glossary.length} terms, ${result.noTranslate.length} no-translate items.`);
  return result;
});
ipcMain.handle("analysis:local", async () => {
  const project = projectService.project;
  const items = await projectService.readTextItems();
  const result = analyzeLocally(items);
  await saveAnalysis(project, result);
  await appendLog(project, `Local analysis produced ${result.glossary.length} term candidates and ${result.noTranslate.length} no-translate items.`);
  return result;
});
ipcMain.handle("analysis:save", async (_event, analysis) => projectService.saveAnalysis(analysis));
ipcMain.handle("dictionary:list", async () => listDictionaryTables(optionalProject()));
ipcMain.handle("dictionary:load", async (_event, scope, id, tableType) => loadDictionaryTable(scope, id, tableType, optionalProject()));
ipcMain.handle("dictionary:save", async (_event, scope, table) => saveDictionaryTableFile(scope, table, optionalProject()));
ipcMain.handle("dictionary:createEmpty", async (_event, scope, tableType, meta) => createEmptyDictionaryTable(scope, tableType, meta, optionalProject()));
ipcMain.handle("dictionary:delete", async (_event, scope, id) => deleteDictionaryTable(scope, id, optionalProject()));
ipcMain.handle("dictionary:export", async (_event, table) => exportDictionaryTable(table));
ipcMain.handle("dictionary:import", async (_event, scope, conflictMode, pendingTable) => importDictionaryTable(scope, optionalProject(), conflictMode, pendingTable));
ipcMain.handle("analysis:translateMissing", async (_event, provider: ProviderConfig) => {
  const project = projectService.project;
  const analysis = await projectService.readAnalysis();
  const { result, translatedCount } = await withProgramAiIo("AI 翻译资源表", () => translateAnalysisResourcesWithProviderWithIo(provider, analysis, project.sourceLanguage, project.targetLanguage));
  await saveAnalysis(project, result);
  await appendLog(project, `Analysis resource translation filled ${translatedCount} rows.`);
  return result;
});
ipcMain.handle("analysis:translateRows", async (_event, provider: ProviderConfig, selection: { table: "characters" | "glossary"; ids: string[] }) => {
  const project = projectService.project;
  const analysis = await projectService.readAnalysis();
  const { result, translatedCount } = await withProgramAiIo("AI 翻译资源表选中行", () => translateAnalysisResourcesWithProviderWithIo(provider, analysis, project.sourceLanguage, project.targetLanguage, selection));
  await saveAnalysis(project, result);
  await appendLog(project, `Analysis selected resource translation filled ${translatedCount} rows.`);
  return result;
});

ipcMain.handle("translation:start", async (_event, provider: ProviderConfig, targetLanguage: string) => {
  const project = projectService.project;
  const items = await projectService.readTextItems();
  const analysis = await projectService.readAnalysis();
  const translated = await translateWithProvider(provider, items, project.sourceLanguage, targetLanguage, await projectService.loadEffectivePrompts(), analysis, (io) =>
    publishProgramAiIo({ title: io.title ?? "AI 翻译", requestMessages: io.requestMessages, responseContent: io.responseContent, ok: true })
  );
  await projectService.saveTextItems(translated);
  await appendLog(project, "Translation task completed.");
  return translated;
});
ipcMain.handle("translation:batch", async (_event, provider: ProviderConfig, targetLanguage: string, items: TextItem[]) => {
  const analysis = await projectService.readAnalysis();
  const titlePrefix = items.length === 1 ? `AI 翻译单行 ${items[0]?.id ?? ""} ` : `AI 翻译选中行（${items.length} 行） `;
  return translateWithProvider(
    provider,
    items,
    projectService.project.sourceLanguage,
    targetLanguage,
    await projectService.loadEffectivePrompts(),
    analysis,
    (io) => publishProgramAiIo({ title: io.title ?? "AI 翻译选中行", requestMessages: io.requestMessages, responseContent: io.responseContent, ok: true }),
    { force: true, titlePrefix }
  );
});
ipcMain.handle("prompts:effective", async () => projectService.loadEffectivePrompts());

ipcMain.handle("proofread:start", async (_event, items: TextItem[], analysis, options?: ProofreadOptions) => {
  const project = projectService.project;
  const issues = proofreadItems(items, analysis, options ?? defaultProofreadOptions());
  await writeJsonl(projectPaths(project).issues, issues);
  await appendLog(project, `Proofreading found ${issues.length} issues.`);
  return issues;
});
ipcMain.handle("proofread:ai", async (_event, provider: ProviderConfig, issues: ProofreadIssue[]) => {
  const project = projectService.project;
  const items = await projectService.readTextItems();
  const analysis = await projectService.readAnalysis();
  const { items: proofreadItemsResult, updatedCount } = await withProgramAiIo(
    "AI 自动校对",
    async () => proofreadWithProviderWithIo(
      provider,
      items,
      issues,
      project.sourceLanguage,
      project.targetLanguage,
      await projectService.loadEffectivePrompts(),
      analysis
    )
  );
  await projectService.saveTextItems(proofreadItemsResult);
  await appendLog(project, `AI proofreading updated ${updatedCount} items.`);
  return proofreadItemsResult;
});

ipcMain.handle("patch:preview", async (_event, items: TextItem[]) => previewPatch(projectService.project, items));
ipcMain.handle("patch:apply", async (_event, items: TextItem[]) => applyPatch(projectService.project, items));
ipcMain.handle("patch:aiApply", async (_event, items: TextItem[]) => {
  const plan = await loadAiLocalizationPlan(projectService.project);
  if (!plan) throw new Error("没有 AI 本地化方案。请先生成 AI 方案。");
  return applyPatch(projectService.project, items);
});
ipcMain.handle("patch:restore", async () => {
  await restoreWorkingCopy(projectService.project);
  await appendLog(projectService.project, "Working copy restored from original snapshot.");
  return projectService.refresh();
});
}
