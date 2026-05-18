import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { app, BrowserWindow, clipboard, ipcMain, shell, Menu, type IpcMainInvokeEvent } from "electron";
import { getFonts } from "font-list";
import { downloadAaOnlineGame, validateAaOfflineOutputDirectory } from "./aaofflineService";
import { AgentChatHistoryService } from "./agent/agentChatHistoryService";
import { recordAgentToolResultInTaskPlan, runAgent } from "./agent/agentRuntime";
import { executeAgentTool } from "./agent/agentTools";
import { loadAiLocalizationPlan } from "./aiLocalizationService";
import { reviewExtractionRuleGroupsWithAi } from "./aiExtractionReviewService";
import { AiResponseParseError, analyzeWithProviderWithIo, proofreadWithProviderWithIo, setAiUsageRecorder, testProvider, translateAnalysisResourcesWithProviderWithIo, translateWithProvider } from "./aiProvider";
import { loadProviderBalance } from "./costService";
import { createEmptyDictionaryTable, deleteDictionaryTable, exportDictionaryTable, importDictionaryTable, listDictionaryTables, loadDictionaryTable, saveDictionaryTable as saveDictionaryTableFile } from "./dictionaryService";
import { createProjectExtractionRulePackage, loadConfirmedExtractionRules, loadExtractionCandidates, loadExtractionRuleGroups, materializeProjectTextItemsFromRules, saveExtractionRuleDecisions, scanProjectExtractionRules } from "./extractionRuleService";
import { copyExtractionRulePackageToGlobal, copyExtractionRulePackageToProject, deleteExtractionRulePackage, dryRunExtractionRulePackage, exportExtractionRulePackage, importExtractionRulePackage, listExtractionRulePackages, loadExtractionRulePackage, saveExtractionRulePackage } from "./extractionRulePackageService";
import { exportTextItems, importTextItems } from "./importExport";
import { analyzeLocally } from "./localAnalysis";
import { buildOnlineDictionaryInlineSubmission, deleteOnlineDictionaryTable, exportOnlineDictionarySubmissionPackage, getOnlineDictionaryTokenStatus, importOnlineDictionaryTable as importRemoteDictionaryTable, listOnlineDictionarySources, listOnlineDictionaryTables, loadOnlineDictionaryTable, loadOnlineDictionaryTableByUrl, publishOnlineDictionaryTable, saveOnlineDictionarySources, saveOnlineDictionaryToken, testOnlineDictionarySource, updateOnlineDictionaryTable } from "./onlineDictionaryService";
import { buildOnlineExtractionRuleInlineSubmission, deleteOnlineExtractionRulePackage, getOnlineExtractionRuleTokenStatus, importOnlineExtractionRulePackage, listOnlineExtractionRulePackages, listOnlineExtractionRuleSources, loadOnlineExtractionRulePackage, publishOnlineExtractionRulePackage, saveOnlineExtractionRuleSources, saveOnlineExtractionRuleToken, testOnlineExtractionRuleSource, updateOnlineExtractionRulePackage } from "./onlineExtractionRuleService";
import { downloadWebGame, validateWebGameOutputDirectory } from "./webGameDownloadService";
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
  PackageProjectInput,
  ProgramAiIoEvent,
  ProofreadIssue,
  ProofreadOptions,
  PromptConfig,
  PromptScope,
  ProviderConfig,
  OnlineDictionarySettings,
  OnlineDictionarySubmissionOptions,
  OnlineDictionaryUpdateOptions,
  OnlineExtractionRuleSettings,
  OnlineExtractionRuleSubmissionOptions,
  ExtractionDecision,
  ExtractionRulePackage,
  ExtractionRuleScope,
  TextItem,
  WebGameDownloadInput
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
const programAiIoEvents: ProgramAiIoEvent[] = [];

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
  programAiIoEvents.push(payload);
  if (programAiIoEvents.length > 200) programAiIoEvents.splice(0, programAiIoEvents.length - 200);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("ai-program:io", payload);
  }
}

async function withProgramAiIo<T>(
  title: string,
  task: () => Promise<T & {
    requestMessages?: Array<{ role: string; content: string }>;
    responseContent?: string;
    programAiIoEvents?: Array<Omit<ProgramAiIoEvent, "id" | "createdAt">>;
  }>
): Promise<T> {
  try {
    const result = await task();
    if (result.programAiIoEvents?.length) {
      for (const event of result.programAiIoEvents) publishProgramAiIo(event);
    } else if (result.requestMessages?.length || result.responseContent) {
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
ipcMain.handle("project:previewGame", async () => previewProjectGame(await projectService.ensurePreviewPort()));
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
ipcMain.handle("ai-program:list-io", async () => programAiIoEvents);
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

ipcMain.handle("tools:webGame:download", async (event, input: WebGameDownloadInput) => {
  const sender = event.sender;
  return downloadWebGame(input, {
    onEvent: (logEvent) => {
      if (!sender.isDestroyed()) sender.send("tools:webGame:log", logEvent);
    },
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("tools:webGame:progress", progress);
    }
  });
});
ipcMain.handle("tools:webGame:validateOutput", async (_event, outputPath: string) => validateWebGameOutputDirectory(outputPath));
ipcMain.handle("tools:aaoffline:download", async (event, input: AaOfflineDownloadInput) => {
  const sender = event.sender;
  return downloadAaOnlineGame(input, (logEvent) => {
    if (!sender.isDestroyed()) sender.send("tools:aaoffline:log", logEvent);
  });
});
ipcMain.handle("tools:aaoffline:validateOutput", async (_event, outputPath: string) => validateAaOfflineOutputDirectory(outputPath));

ipcMain.handle("extractionRules:scan", async (event) => {
  const sender = event.sender;
  return scanProjectExtractionRules(projectService.project, (progress) => {
    if (!sender.isDestroyed()) sender.send("extractionRules:scanProgress", progress);
  });
});
ipcMain.handle("extractionRules:listCandidates", async () => loadExtractionCandidates(projectService.project));
ipcMain.handle("extractionRules:listGroups", async () => loadExtractionRuleGroups(projectService.project));
ipcMain.handle("extractionRules:listRules", async () => loadConfirmedExtractionRules(projectService.project));
ipcMain.handle("extractionRules:reviewWithAi", async (event, provider: ProviderConfig, options?: { decisions?: ExtractionDecision[] }) => {
  const sender = event.sender;
  const output = await reviewExtractionRuleGroupsWithAi(projectService.project, provider, await projectService.loadEffectivePrompts(), options, {
    onProgramAiIoEvent: publishProgramAiIo,
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("extractionRules:aiReviewProgress", progress);
    }
  });
  return output.groups;
});
ipcMain.handle("extractionRules:saveDecisions", async (_event, updates: Array<{ groupId: string; decision: ExtractionDecision; note?: string }>) => saveExtractionRuleDecisions(projectService.project, updates));
ipcMain.handle("extractionRules:materializeTextItems", async () => {
  await materializeProjectTextItemsFromRules(projectService.project);
  return projectService.refresh();
});
ipcMain.handle("extractionRules:createProjectPackage", async (_event, displayName?: string) => createProjectExtractionRulePackage(projectService.project, displayName));

ipcMain.handle("extractionRulePackages:list", async () => listExtractionRulePackages(optionalProject()));
ipcMain.handle("extractionRulePackages:load", async (_event, scope: ExtractionRuleScope, id: string, fileName?: string) => loadExtractionRulePackage(scope, id, optionalProject(), fileName));
ipcMain.handle("extractionRulePackages:save", async (_event, scope: ExtractionRuleScope, pkg: ExtractionRulePackage, fileName?: string) => saveExtractionRulePackage(scope, pkg, optionalProject(), fileName));
ipcMain.handle("extractionRulePackages:delete", async (_event, scope: ExtractionRuleScope, id: string, fileName?: string) => deleteExtractionRulePackage(scope, id, optionalProject(), fileName));
ipcMain.handle("extractionRulePackages:import", async (_event, scope: ExtractionRuleScope, conflictMode?: "overwrite" | "newId", pendingPackage?: ExtractionRulePackage) => importExtractionRulePackage(scope, optionalProject(), conflictMode, pendingPackage));
ipcMain.handle("extractionRulePackages:export", async (_event, pkg: ExtractionRulePackage) => exportExtractionRulePackage(pkg));
ipcMain.handle("extractionRulePackages:dryRun", async (_event, pkg: ExtractionRulePackage) => dryRunExtractionRulePackage(projectService.project, pkg));
ipcMain.handle("extractionRulePackages:applyToProject", async (_event, pkg: ExtractionRulePackage) => copyExtractionRulePackageToProject(pkg, projectService.project));
ipcMain.handle("extractionRulePackages:copyToGlobal", async (_event, pkg: ExtractionRulePackage) => copyExtractionRulePackageToGlobal(pkg));

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
ipcMain.handle("dictionary:load", async (_event, scope, id, tableType, fileName) => loadDictionaryTable(scope, id, tableType, optionalProject(), fileName));
ipcMain.handle("dictionary:save", async (_event, scope, table, fileName) => saveDictionaryTableFile(scope, table, optionalProject(), fileName));
ipcMain.handle("dictionary:createEmpty", async (_event, scope, tableType, meta) => createEmptyDictionaryTable(scope, tableType, meta, optionalProject()));
ipcMain.handle("dictionary:delete", async (_event, scope, id, fileName) => deleteDictionaryTable(scope, id, optionalProject(), fileName));
ipcMain.handle("dictionary:export", async (_event, table) => exportDictionaryTable(table));
ipcMain.handle("dictionary:import", async (_event, scope, conflictMode, pendingTable) => importDictionaryTable(scope, optionalProject(), conflictMode, pendingTable));
ipcMain.handle("clipboard:write-text", async (_event, text: string) => {
  clipboard.writeText(text);
});
ipcMain.handle("online-dictionaries:list-sources", async () => listOnlineDictionarySources());
ipcMain.handle("online-dictionaries:save-sources", async (_event, settings: OnlineDictionarySettings) => saveOnlineDictionarySources(settings));
ipcMain.handle("online-dictionaries:token-status", async () => getOnlineDictionaryTokenStatus());
ipcMain.handle("online-dictionaries:save-token", async (_event, token: string) => saveOnlineDictionaryToken(token));
ipcMain.handle("online-dictionaries:test-source", async (_event, sourceId: string) => testOnlineDictionarySource(sourceId));
ipcMain.handle("online-dictionaries:list-tables", async (_event, sourceId: string, webSearchQuery?: string, page?: number, mineOnly?: boolean) => listOnlineDictionaryTables(sourceId, webSearchQuery, page, mineOnly));
ipcMain.handle("online-dictionaries:load-table", async (_event, sourceId: string, discussionId: string) => loadOnlineDictionaryTable(sourceId, discussionId));
ipcMain.handle("online-dictionaries:load-table-by-url", async (_event, url: string) => loadOnlineDictionaryTableByUrl(url));
ipcMain.handle("online-dictionaries:import-table", async (_event, arg1, arg2, arg3, arg4, arg5) => {
  const hasExplicitScope = arg1 === "global" || arg1 === "project";
  const scope = hasExplicitScope ? arg1 : (optionalProject() ? "project" : "global");
  const sourceId = hasExplicitScope ? arg2 : arg1;
  const discussionId = hasExplicitScope ? arg3 : arg2;
  const conflictMode = hasExplicitScope ? arg4 : arg3;
  const pendingTable = hasExplicitScope ? arg5 : arg4;
  return importRemoteDictionaryTable(scope, sourceId, discussionId, optionalProject(), conflictMode, pendingTable);
});
ipcMain.handle("online-dictionaries:publish-table", async (_event, table, options: OnlineDictionarySubmissionOptions) => publishOnlineDictionaryTable(table, options));
ipcMain.handle("online-dictionaries:update-table", async (_event, table, options: OnlineDictionaryUpdateOptions) => updateOnlineDictionaryTable(table, options));
ipcMain.handle("online-dictionaries:delete-table", async (_event, sourceId: string, discussionId: string) => deleteOnlineDictionaryTable(sourceId, discussionId, optionalProject()));
ipcMain.handle("online-dictionaries:export-submission-package", async (_event, table, options: OnlineDictionarySubmissionOptions) => exportOnlineDictionarySubmissionPackage(table, options));
ipcMain.handle("online-dictionaries:inline-submission", async (_event, table, options: OnlineDictionarySubmissionOptions) => buildOnlineDictionaryInlineSubmission(table, options));
ipcMain.handle("online-extraction-rules:list-sources", async () => listOnlineExtractionRuleSources());
ipcMain.handle("online-extraction-rules:save-sources", async (_event, settings: OnlineExtractionRuleSettings) => saveOnlineExtractionRuleSources(settings));
ipcMain.handle("online-extraction-rules:token-status", async () => getOnlineExtractionRuleTokenStatus());
ipcMain.handle("online-extraction-rules:save-token", async (_event, token: string) => saveOnlineExtractionRuleToken(token));
ipcMain.handle("online-extraction-rules:test-source", async (_event, sourceId: string) => testOnlineExtractionRuleSource(sourceId));
ipcMain.handle("online-extraction-rules:list-packages", async (_event, sourceId: string, webSearchQuery?: string, page?: number, mineOnly?: boolean) => listOnlineExtractionRulePackages(sourceId, webSearchQuery, page, mineOnly));
ipcMain.handle("online-extraction-rules:load-package", async (_event, sourceId: string, discussionId: string) => loadOnlineExtractionRulePackage(sourceId, discussionId));
ipcMain.handle("online-extraction-rules:import-package", async (_event, sourceId: string, discussionId: string) => importOnlineExtractionRulePackage(sourceId, discussionId));
ipcMain.handle("online-extraction-rules:publish-package", async (_event, pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions) => publishOnlineExtractionRulePackage(pkg, options));
ipcMain.handle("online-extraction-rules:update-package", async (_event, pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions & { discussionId: string; expectedRevision?: number }) => updateOnlineExtractionRulePackage(pkg, options));
ipcMain.handle("online-extraction-rules:delete-package", async (_event, sourceId: string, discussionId: string) => deleteOnlineExtractionRulePackage(sourceId, discussionId, optionalProject()));
ipcMain.handle("online-extraction-rules:inline-submission", async (_event, pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions) => buildOnlineExtractionRuleInlineSubmission(pkg, options));
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
ipcMain.handle("translation:batch", async (_event, provider: ProviderConfig, targetLanguage: string, items: TextItem[], options?: { titlePrefix?: string; batchIndexOffset?: number; batchTotal?: number }) => {
  const analysis = await projectService.readAnalysis();
  const titlePrefix = options?.titlePrefix ?? (items.length === 1 ? `AI 翻译单行 ${items[0]?.id ?? ""} ` : `AI 翻译选中行（${items.length} 行） `);
  return translateWithProvider(
    provider,
    items,
    projectService.project.sourceLanguage,
    targetLanguage,
    await projectService.loadEffectivePrompts(),
    analysis,
    (io) => publishProgramAiIo({ title: io.title ?? "AI 翻译选中行", requestMessages: io.requestMessages, responseContent: io.responseContent, ok: true }),
    { force: true, titlePrefix, batchIndexOffset: options?.batchIndexOffset, batchTotal: options?.batchTotal }
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
ipcMain.handle("proofread:ai", async (_event, provider: ProviderConfig, issues: ProofreadIssue[], options?: { titlePrefix?: string; batchIndexOffset?: number; batchTotal?: number }) => {
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
      analysis,
      (io) => publishProgramAiIo({ title: io.title ?? "AI 自动校对", requestMessages: io.requestMessages, responseContent: io.responseContent, ok: true }),
      options
    )
  );
  await projectService.saveTextItems(proofreadItemsResult);
  await appendLog(project, `AI proofreading updated ${updatedCount} items.`);
  return proofreadItemsResult;
});

ipcMain.handle("patch:preview", async (_event, items: TextItem[]) => previewPatch(projectService.project, items));
ipcMain.handle("patch:apply", async (event, items: TextItem[]) =>
  runPatchWithProgress(event, () => applyPatch(projectService.project, items, (progress) => event.sender.send("patch:progress", progress)))
);
ipcMain.handle("patch:aiApply", async (event, items: TextItem[]) => {
  const plan = await loadAiLocalizationPlan(projectService.project);
  if (!plan) throw new Error("没有 AI 本地化方案。请先生成 AI 方案。");
  return runPatchWithProgress(event, () => applyPatch(projectService.project, items, (progress) => event.sender.send("patch:progress", progress)));
});
ipcMain.handle("patch:restore", async (event) => {
  return runPatchWithProgress(event, async () => {
    await restoreWorkingCopy(projectService.project, (progress) => event.sender.send("patch:progress", progress));
    await appendLog(projectService.project, "Working copy restored from original snapshot.");
    return projectService.refresh();
  });
});
}

async function runPatchWithProgress<T>(event: IpcMainInvokeEvent, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    event.sender.send("patch:progress", {
      phase: "done",
      current: 0,
      total: 0,
      percent: 100,
      message: `回填失败：${error instanceof Error ? error.message : String(error)}`
    });
    throw error;
  }
}
