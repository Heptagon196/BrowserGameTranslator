import { contextBridge, ipcRenderer } from "electron";
import {
  AaOfflineDownloadEvent,
  AaOfflineDownloadInput,
  AaOfflineDownloadResult,
  AnalysisResult,
  AiBalanceSnapshot,
  AiPermissionMode,
  AiShellAuthorizationRequest,
  AppStateSnapshot,
  ChatMessage,
  CreateProjectInput,
  ItchDownloadEvent,
  ItchDownloadInput,
  ItchDownloadProgress,
  ItchDownloadResult,
  OriginalSourceFile,
  PackageProjectInput,
  PackageProjectResult,
  PatchPreview,
  PreviewStatus,
  ProofreadIssue,
  ProofreadOptions,
  PromptConfig,
  PromptScope,
  ProjectConfig,
  ProviderConfig,
  TextItem
} from "../shared/types";

const api = {
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectDirectory"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("external:open", url),
  createProject: (input: CreateProjectInput): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:create", input),
  validateCreateProject: (input: CreateProjectInput): Promise<string[]> => ipcRenderer.invoke("project:validateCreate", input),
  openProject: (): Promise<AppStateSnapshot | null> => ipcRenderer.invoke("project:open"),
  openProjectDirectory: (directory: string): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:openDirectory", directory),
  openRecentProject: (projectPath: string): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:openRecent", projectPath),
  loadRecentProjects: (): Promise<AppStateSnapshot["recentProjects"]> => ipcRenderer.invoke("project:recent"),
  refreshProject: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:refresh"),
  updateProject: (project: ProjectConfig): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:update", project),
  previewGame: (): Promise<string> => ipcRenderer.invoke("project:previewGame"),
  previewStatus: (): Promise<PreviewStatus> => ipcRenderer.invoke("project:previewStatus"),
  stopPreview: (): Promise<void> => ipcRenderer.invoke("project:stopPreview"),
  openProjectDirectoryInShell: (): Promise<void> => ipcRenderer.invoke("project:openDirectoryInShell"),
  packageProject: (input: PackageProjectInput): Promise<PackageProjectResult> => ipcRenderer.invoke("project:package", input),
  loadProviders: (): Promise<Pick<AppStateSnapshot, "providers" | "activeProviderId" | "activeChatProviderId">> => ipcRenderer.invoke("providers:load"),
  saveProviders: (providers: ProviderConfig[]): Promise<ProviderConfig[]> => ipcRenderer.invoke("providers:save", providers),
  setActiveProvider: (activeProviderId: string): Promise<string> => ipcRenderer.invoke("providers:setActive", activeProviderId),
  setActiveChatProvider: (activeChatProviderId: string): Promise<string> => ipcRenderer.invoke("providers:setActiveChat", activeChatProviderId),
  testProvider: (provider: ProviderConfig): Promise<string> => ipcRenderer.invoke("providers:test", provider),
  loadAiBalance: (provider: ProviderConfig): Promise<AiBalanceSnapshot> => ipcRenderer.invoke("ai-balance:load", provider),
  loadSystemFonts: (): Promise<string[]> => ipcRenderer.invoke("system:fonts"),
  onAiCostUpdate: (listener: () => void): (() => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("ai-cost:update", wrapped);
    return () => ipcRenderer.removeListener("ai-cost:update", wrapped);
  },
  loadPrompts: (scope: PromptScope): Promise<PromptConfig> => ipcRenderer.invoke("prompts:load", scope),
  savePrompts: (scope: PromptScope, prompts: PromptConfig): Promise<PromptConfig> => ipcRenderer.invoke("prompts:save", scope, prompts),
  loadEffectivePrompts: (): Promise<PromptConfig> => ipcRenderer.invoke("prompts:effective"),
  downloadItchHtml5Game: (input: ItchDownloadInput): Promise<ItchDownloadResult> => ipcRenderer.invoke("tools:itch:downloadHtml5", input),
  onItchDownloadLog: (listener: (event: ItchDownloadEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, logEvent: ItchDownloadEvent) => listener(logEvent);
    ipcRenderer.on("tools:itch:log", wrapped);
    return () => ipcRenderer.removeListener("tools:itch:log", wrapped);
  },
  onItchDownloadProgress: (listener: (progress: ItchDownloadProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ItchDownloadProgress) => listener(progress);
    ipcRenderer.on("tools:itch:progress", wrapped);
    return () => ipcRenderer.removeListener("tools:itch:progress", wrapped);
  },
  downloadAaOnlineGame: (input: AaOfflineDownloadInput): Promise<AaOfflineDownloadResult> => ipcRenderer.invoke("tools:aaoffline:download", input),
  validateAaOfflineOutputDirectory: (outputPath: string): Promise<string[]> => ipcRenderer.invoke("tools:aaoffline:validateOutput", outputPath),
  onAaOfflineDownloadLog: (listener: (event: AaOfflineDownloadEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, logEvent: AaOfflineDownloadEvent) => listener(logEvent);
    ipcRenderer.on("tools:aaoffline:log", wrapped);
    return () => ipcRenderer.removeListener("tools:aaoffline:log", wrapped);
  },
  extractTexts: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("extract:start"),
  generateAiLocalizationPlan: (provider: ProviderConfig): Promise<AppStateSnapshot> => ipcRenderer.invoke("extract:aiPlan", provider),
  extractTextsWithAiPlan: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("extract:ai"),
  saveTextItems: (items: TextItem[]): Promise<TextItem[]> => ipcRenderer.invoke("items:save", items),
  exportTextItems: (items: TextItem[], format: "jsonl" | "csv"): Promise<string | null> => ipcRenderer.invoke("items:export", items, format),
  importTextItems: (): Promise<TextItem[]> => ipcRenderer.invoke("items:import"),
  readOriginalSourceFile: (sourceFile: string): Promise<OriginalSourceFile> => ipcRenderer.invoke("source:readOriginalFile", sourceFile),
  analyze: (provider: ProviderConfig): Promise<AnalysisResult> => ipcRenderer.invoke("analysis:start", provider),
  analyzeLocally: (): Promise<AnalysisResult> => ipcRenderer.invoke("analysis:local"),
  saveAnalysis: (analysis: AnalysisResult): Promise<AnalysisResult> => ipcRenderer.invoke("analysis:save", analysis),
  translateMissingAnalysisResources: (provider: ProviderConfig): Promise<AnalysisResult> => ipcRenderer.invoke("analysis:translateMissing", provider),
  translateAnalysisRows: (provider: ProviderConfig, selection: { table: "characters" | "glossary"; ids: string[] }): Promise<AnalysisResult> =>
    ipcRenderer.invoke("analysis:translateRows", provider, selection),
  translate: (provider: ProviderConfig, targetLanguage: string, chat: ChatMessage[]): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:start", provider, targetLanguage, chat),
  translateBatch: (provider: ProviderConfig, targetLanguage: string, chat: ChatMessage[], items: TextItem[]): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:batch", provider, targetLanguage, chat, items),
  proofread: (items: TextItem[], analysis: AnalysisResult, options: ProofreadOptions): Promise<ProofreadIssue[]> =>
    ipcRenderer.invoke("proofread:start", items, analysis, options),
  previewPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:preview", items),
  applyPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:apply", items),
  applyAiPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:aiApply", items),
  restoreGame: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("patch:restore"),
  replyChat: (provider: ProviderConfig, chat: ChatMessage[], permissionMode: AiPermissionMode): Promise<ChatMessage> =>
    ipcRenderer.invoke("chat:reply", provider, chat, permissionMode),
  replyChatStream: (provider: ProviderConfig, chat: ChatMessage[], permissionMode: AiPermissionMode, streamId: string): Promise<ChatMessage> =>
    ipcRenderer.invoke("chat:replyStream", provider, chat, permissionMode, streamId),
  onChatStreamDelta: (listener: (event: { id: string; delta: string }) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { id: string; delta: string }) => listener(payload);
    ipcRenderer.on("chat:stream:delta", wrapped);
    return () => ipcRenderer.removeListener("chat:stream:delta", wrapped);
  },
  onChatStreamReset: (listener: (event: { id: string }) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { id: string }) => listener(payload);
    ipcRenderer.on("chat:stream:reset", wrapped);
    return () => ipcRenderer.removeListener("chat:stream:reset", wrapped);
  },
  onShellAuthorizationRequest: (listener: (request: AiShellAuthorizationRequest) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, request: AiShellAuthorizationRequest) => listener(request);
    ipcRenderer.on("shell:authorize:request", wrapped);
    return () => ipcRenderer.removeListener("shell:authorize:request", wrapped);
  },
  respondShellAuthorization: (id: string, allowed: boolean): void => {
    ipcRenderer.send("shell:authorize:response", { id, allowed });
  },
  saveChat: (chat: ChatMessage[]): Promise<ChatMessage[]> => ipcRenderer.invoke("chat:save", chat)
};

contextBridge.exposeInMainWorld("bgt", api);

export type BrowserGameTranslatorApi = typeof api;
