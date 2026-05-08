import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell, IpcMainInvokeEvent, Menu } from "electron";
import { getFonts } from "font-list";
import { downloadAaOnlineGame, validateAaOfflineOutputDirectory } from "./aaofflineService";
import { aiCommandSystemPrompt, executeAiCommands, extractAiCommands } from "./aiCommandService";
import { generateAiLocalizationPlanWithIo, loadAiLocalizationPlan } from "./aiLocalizationService";
import { AiResponseParseError, analyzeWithProviderWithIo, chatCompletion, chatCompletionStream, setAiUsageRecorder, testProvider, translateAnalysisResourcesWithProviderWithIo, translateWithProvider } from "./aiProvider";
import { loadProviderBalance } from "./costService";
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
import {
  AaOfflineDownloadInput,
  AiPermissionMode,
  ChatMessage,
  ItchDownloadInput,
  PackageProjectInput,
  ProofreadOptions,
  PromptConfig,
  PromptScope,
  ProjectConfig,
  ProviderConfig,
  TextItem
} from "../shared/types";

const projectService = new ProjectService();
let shellAuthorizationSerial = 0;

type AiProgramMessage = { role: string; content: string };

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
ipcMain.handle("system:fonts", async () => Array.from(new Set(await getFonts({ disableQuoting: true }))).sort((a, b) => a.localeCompare(b)));
ipcMain.handle("prompts:load", async (_event, scope: PromptScope) => projectService.loadPrompts(scope));
ipcMain.handle("prompts:save", async (_event, scope: PromptScope, prompts: PromptConfig) => projectService.savePrompts(scope, prompts));

async function appendProgramIo(project: ProjectConfig, title: string, requestMessages: AiProgramMessage[], responseContent: string): Promise<void> {
  const paths = projectPaths(project);
  const chat = await readJsonl<ChatMessage>(paths.chat);
  const createdAt = new Date().toISOString();
  const serial = Date.now();
  const promptMessage: ChatMessage = {
    id: `msg_${serial}_program_prompt`,
    role: "system",
    origin: "program",
    kind: "program_prompt",
    createdAt,
    content: [title, ...requestMessages.map((message) => `${message.role === "system" ? "System" : "User"}:\n${message.content}`)].join("\n\n")
  };
  const responseMessage: ChatMessage = {
    id: `msg_${serial}_program_response`,
    role: "assistant",
    origin: "program",
    kind: "program_response",
    createdAt,
    content: responseContent
  };
  await writeJsonl(paths.chat, [...chat, promptMessage, responseMessage]);
}

ipcMain.handle("tools:itch:downloadHtml5", async (event, input: ItchDownloadInput) => {
  return downloadItchHtml5Game(input, (logEvent) => event.sender.send("tools:itch:log", logEvent));
});
ipcMain.handle("tools:aaoffline:download", async (event, input: AaOfflineDownloadInput) => {
  return downloadAaOnlineGame(input, (logEvent) => event.sender.send("tools:aaoffline:log", logEvent));
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
  const { plan, requestMessages, responseContent } = await generateAiLocalizationPlanWithIo(project, provider, await projectService.loadEffectivePrompts());
  await appendProgramIo(project, "AI 生成提取方案", requestMessages, responseContent);
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
  let output: Awaited<ReturnType<typeof analyzeWithProviderWithIo>>;
  try {
    output = await analyzeWithProviderWithIo(provider, items, await projectService.loadEffectivePrompts());
  } catch (error) {
    if (error instanceof AiResponseParseError) {
      await appendProgramIo(project, "AI 分析资源（解析失败）", error.requestMessages, error.responseContent);
    }
    throw error;
  }
  const { result, requestMessages, responseContent } = output;
  await saveAnalysis(project, result);
  await appendProgramIo(project, "AI 分析资源", requestMessages, responseContent);
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
ipcMain.handle("analysis:translateMissing", async (_event, provider: ProviderConfig) => {
  const project = projectService.project;
  const analysis = await projectService.readAnalysis();
  const { result, translatedCount, requestMessages, responseContent } = await translateAnalysisResourcesWithProviderWithIo(provider, analysis, project.sourceLanguage, project.targetLanguage);
  if (requestMessages.length) await appendProgramIo(project, "AI 补译资源表", requestMessages, responseContent);
  await saveAnalysis(project, result);
  await appendLog(project, `Analysis resource translation filled ${translatedCount} rows.`);
  return result;
});
ipcMain.handle("analysis:translateRows", async (_event, provider: ProviderConfig, selection: { table: "characters" | "glossary"; ids: string[] }) => {
  const project = projectService.project;
  const analysis = await projectService.readAnalysis();
  const { result, translatedCount, requestMessages, responseContent } = await translateAnalysisResourcesWithProviderWithIo(provider, analysis, project.sourceLanguage, project.targetLanguage, selection);
  if (requestMessages.length) await appendProgramIo(project, "AI 翻译资源表选中行", requestMessages, responseContent);
  await saveAnalysis(project, result);
  await appendLog(project, `Analysis selected resource translation filled ${translatedCount} rows.`);
  return result;
});

ipcMain.handle("translation:start", async (_event, provider: ProviderConfig, targetLanguage: string, chat: ChatMessage[]) => {
  const project = projectService.project;
  const items = await projectService.readTextItems();
  const analysis = await projectService.readAnalysis();
  const translated = await translateWithProvider(provider, items, project.sourceLanguage, targetLanguage, chat, await projectService.loadEffectivePrompts(), analysis);
  await projectService.saveTextItems(translated);
  await appendLog(project, "Translation task completed.");
  return translated;
});
ipcMain.handle("translation:batch", async (_event, provider: ProviderConfig, targetLanguage: string, chat: ChatMessage[], items: TextItem[]) => {
  const analysis = await projectService.readAnalysis();
  return translateWithProvider(provider, items, projectService.project.sourceLanguage, targetLanguage, chat, await projectService.loadEffectivePrompts(), analysis);
});
ipcMain.handle("prompts:effective", async () => projectService.loadEffectivePrompts());

ipcMain.handle("proofread:start", async (_event, items: TextItem[], analysis, options?: ProofreadOptions) => {
  const project = projectService.project;
  const issues = proofreadItems(items, analysis, options ?? defaultProofreadOptions());
  await writeJsonl(projectPaths(project).issues, issues);
  await appendLog(project, `Proofreading found ${issues.length} issues.`);
  return issues;
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

ipcMain.handle("chat:save", async (_event, chat: ChatMessage[]) => {
  await writeJsonl(projectPaths(projectService.project).chat, chat);
  return chat;
});
ipcMain.handle("chat:reply", async (_event, provider: ProviderConfig, chat: ChatMessage[], permissionMode: AiPermissionMode = "restricted") => {
  const safePermissionMode: AiPermissionMode = ["restricted", "workspace", "full"].includes(permissionMode) ? permissionMode : "restricted";
  const baseMessages = buildChatMessages(chat, safePermissionMode);
  const firstContent = await chatCompletion(provider, baseMessages);
  const content = await resolveChatContent(_event, provider, baseMessages, firstContent, safePermissionMode);
  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content,
    createdAt: new Date().toISOString()
  } satisfies ChatMessage;
});

ipcMain.handle("chat:replyStream", async (_event, provider: ProviderConfig, chat: ChatMessage[], permissionMode: AiPermissionMode = "restricted", streamId: string) => {
  const safePermissionMode: AiPermissionMode = ["restricted", "workspace", "full"].includes(permissionMode) ? permissionMode : "restricted";
  const baseMessages = buildChatMessages(chat, safePermissionMode);
  const sendDelta = (delta: string) => _event.sender.send("chat:stream:delta", { id: streamId, delta });
  const firstContent = await chatCompletionStream(provider, baseMessages, sendDelta);
  const commands = extractAiCommands(firstContent);
  let content = firstContent;
  if (commands.length) {
    _event.sender.send("chat:stream:reset", { id: streamId });
    const commandResults = await executeAiCommands(projectService, commands, safePermissionMode, (request) => requestShellAuthorization(_event, request));
    const summary = await chatCompletionStream(
      provider,
      [
        ...baseMessages,
        { role: "assistant", content: firstContent },
        {
          role: "system",
          content: `BGT command results:\n${JSON.stringify(commandResults, null, 2)}\n\nNow answer the user in natural language. Mention changed records and errors. Do not include bgt-commands blocks.`
        }
      ],
      sendDelta
    );
    const cleanedSummary = stripBgtCommandBlocks(summary).trim();
    content = cleanedSummary && !/```bgt-commands/i.test(cleanedSummary) ? cleanedSummary : formatCommandResults(commandResults);
    const resultText = formatCommandResults(commandResults);
    if (!content.includes("命令执行结果")) {
      const suffix = `\n\n${resultText}`;
      content = `${content}${suffix}`;
      sendDelta(suffix);
    }
  }
  return {
    id: streamId,
    role: "assistant",
    content,
    createdAt: new Date().toISOString()
  } satisfies ChatMessage;
});

function buildChatMessages(chat: ChatMessage[], permissionMode: AiPermissionMode): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: aiCommandSystemPrompt(projectService.project, permissionMode)
    },
    ...chat
      .filter((message) => message.kind !== "program_prompt" && message.kind !== "program_response")
      .slice(-20)
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: message.content
      }))
  ];
}

async function resolveChatContent(
  event: IpcMainInvokeEvent,
  provider: ProviderConfig,
  baseMessages: Array<{ role: string; content: string }>,
  firstContent: string,
  permissionMode: AiPermissionMode
): Promise<string> {
  const commands = extractAiCommands(firstContent);
  let content = firstContent;
  if (commands.length) {
    const commandResults = await executeAiCommands(projectService, commands, permissionMode, (request) => requestShellAuthorization(event, request));
    const summary = await chatCompletion(provider, [
        ...baseMessages,
        { role: "assistant", content: firstContent },
        {
          role: "system",
          content: `BGT command results:\n${JSON.stringify(commandResults, null, 2)}\n\nNow answer the user in natural language. Mention changed records and errors. Do not include bgt-commands blocks.`
        }
      ]);
    const cleanedSummary = stripBgtCommandBlocks(summary).trim();
    content = cleanedSummary && !/```bgt-commands/i.test(cleanedSummary) ? cleanedSummary : formatCommandResults(commandResults);
    if (!content.includes("命令执行结果")) {
      content = `${content}\n\n${formatCommandResults(commandResults)}`;
    }
  }
  return content;
}

function stripBgtCommandBlocks(content: string): string {
  return content.replace(/```bgt-commands\s*[\s\S]*?```/gi, "").trim();
}

function formatCommandResults(results: Array<Record<string, unknown>>): string {
  const lines = ["命令执行结果："];
  for (const result of results) {
    lines.push(`- ${String(result.command ?? "command")}：${result.ok ? "成功" : "失败"}`);
    if (typeof result.error === "string") lines.push(`  ${result.error}`);
    if (Array.isArray(result.rows)) {
      for (const row of result.rows.slice(0, 20)) lines.push(`  ${formatResultRow(row)}`);
    } else if (isRecord(result.item)) {
      lines.push(`  ${formatResultRow(result.item)}`);
    } else if (isRecord(result.row)) {
      lines.push(`  ${formatResultRow(result.row)}`);
    }
    if (typeof result.stdout === "string" && result.stdout.trim()) lines.push(`  stdout: ${result.stdout.trim().slice(0, 1000)}`);
    if (typeof result.stderr === "string" && result.stderr.trim()) lines.push(`  stderr: ${result.stderr.trim().slice(0, 1000)}`);
  }
  return lines.join("\n");
}

function formatResultRow(row: unknown): string {
  if (!isRecord(row)) return String(row);
  const pathValue = typeof row.path === "string" ? row.path : "";
  const typeValue = typeof row.type === "string" ? ` (${row.type})` : "";
  if (pathValue) return `${pathValue}${typeValue}`;
  const idValue = typeof row.id === "string" ? row.id : "";
  const source = typeof row.source === "string" ? row.source : typeof row.original === "string" ? row.original : "";
  const target = typeof row.target === "string" ? row.target : typeof row.translation === "string" ? row.translation : "";
  return [idValue, source, target].filter(Boolean).join(" | ") || JSON.stringify(row).slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestShellAuthorization(
  event: IpcMainInvokeEvent,
  request: { command: string; cwd: string; permissionMode: AiPermissionMode }
): Promise<boolean> {
  const id = `shell_auth_${Date.now()}_${++shellAuthorizationSerial}`;
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener("shell:authorize:response", onResponse);
    };
    const onResponse = (_event: Electron.IpcMainEvent, response: { id?: string; allowed?: boolean }) => {
      if (response?.id !== id) return;
      cleanup();
      resolve(Boolean(response.allowed));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 120_000);
    ipcMain.on("shell:authorize:response", onResponse);
    event.sender.send("shell:authorize:request", { id, ...request });
  });
}
