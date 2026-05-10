import { contextBridge, ipcRenderer } from "electron";
import {
  AaOfflineDownloadEvent,
  AaOfflineDownloadInput,
  AaOfflineDownloadResult,
  AnalysisResult,
  AiBalanceSnapshot,
  AgentChatHistoryItem,
  AgentChatHistoryRepository,
  AgentCancelRequest,
  AgentToolApprovalRequest,
  AgentRunRequest,
  AgentRunEventPayload,
  AgentRunResult,
  AgentRunStreamRequest,
  AppStateSnapshot,
  CreateProjectInput,
  DictionaryImportResult,
  DictionaryScope,
  DictionaryTable,
  DictionaryTableMeta,
  DictionaryTableSummary,
  ItchDownloadEvent,
  ItchDownloadInput,
  ItchDownloadProgress,
  ItchDownloadResult,
  OriginalSourceFile,
  PackageProjectInput,
  PackageProjectResult,
  PatchPreview,
  PreviewStatus,
  ProgramAiIoEvent,
  ProofreadIssue,
  ProofreadOptions,
  PromptConfig,
  PromptScope,
  ProjectConfig,
  ProviderConfig,
  ResourceTableType,
  TextItem
} from "../shared/types";

const api = {
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectDirectory"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("external:open", url),
  createProject: (input: CreateProjectInput): Promise<AppStateSnapshot> => ipcRenderer.invoke("project:create", input),
  validateCreateProject: (input: CreateProjectInput): Promise<string[]> => ipcRenderer.invoke("project:validateCreate", input),
  openProject: (): Promise<AppStateSnapshot | null> => ipcRenderer.invoke("project:open"),
  openProjectDirectory: (directory: string): Promise<AppStateSnapshot | null> => ipcRenderer.invoke("project:openDirectory", directory),
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
  onProgramAiIo: (listener: (event: ProgramAiIoEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ioEvent: ProgramAiIoEvent) => listener(ioEvent);
    ipcRenderer.on("ai-program:io", wrapped);
    return () => ipcRenderer.removeListener("ai-program:io", wrapped);
  },
  loadPrompts: (scope: PromptScope): Promise<PromptConfig> => ipcRenderer.invoke("prompts:load", scope),
  savePrompts: (scope: PromptScope, prompts: PromptConfig): Promise<PromptConfig> => ipcRenderer.invoke("prompts:save", scope, prompts),
  loadDefaultPrompts: (): Promise<PromptConfig> => ipcRenderer.invoke("prompts:defaults"),
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
  listDictionaryTables: (): Promise<DictionaryTableSummary[]> => ipcRenderer.invoke("dictionary:list"),
  loadDictionaryTable: (scope: DictionaryScope | "projectDefault", id: string, tableType: ResourceTableType): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:load", scope, id, tableType),
  saveDictionaryTable: (scope: DictionaryScope | "projectDefault", table: DictionaryTable): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:save", scope, table),
  createEmptyDictionaryTable: (scope: DictionaryScope, tableType: ResourceTableType, meta: Partial<DictionaryTableMeta>): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:createEmpty", scope, tableType, meta),
  deleteDictionaryTable: (scope: DictionaryScope, id: string): Promise<void> => ipcRenderer.invoke("dictionary:delete", scope, id),
  exportDictionaryTable: (table: DictionaryTable): Promise<string | null> => ipcRenderer.invoke("dictionary:export", table),
  importDictionaryTable: (scope: DictionaryScope, conflictMode?: "overwrite" | "newId", pendingTable?: DictionaryTable): Promise<DictionaryImportResult> =>
    ipcRenderer.invoke("dictionary:import", scope, conflictMode, pendingTable),
  translate: (provider: ProviderConfig, targetLanguage: string): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:start", provider, targetLanguage),
  translateBatch: (provider: ProviderConfig, targetLanguage: string, items: TextItem[]): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:batch", provider, targetLanguage, items),
  proofread: (items: TextItem[], analysis: AnalysisResult, options: ProofreadOptions): Promise<ProofreadIssue[]> =>
    ipcRenderer.invoke("proofread:start", items, analysis, options),
  aiProofread: (provider: ProviderConfig, issues: ProofreadIssue[]): Promise<TextItem[]> =>
    ipcRenderer.invoke("proofread:ai", provider, issues),
  previewPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:preview", items),
  applyPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:apply", items),
  applyAiPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:aiApply", items),
  restoreGame: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("patch:restore"),
  runAgent: (request: AgentRunRequest): Promise<AgentRunResult> => ipcRenderer.invoke("agent:run", request),
  runAgentStream: (request: AgentRunStreamRequest): Promise<AgentRunResult> => ipcRenderer.invoke("agent:runStream", request),
  cancelAgentRun: (request: AgentCancelRequest): Promise<void> => ipcRenderer.invoke("agent:cancel", request),
  onAgentEvent: (listener: (payload: AgentRunEventPayload) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentRunEventPayload) => listener(payload);
    ipcRenderer.on("agent:event", wrapped);
    return () => ipcRenderer.removeListener("agent:event", wrapped);
  },
  executeApprovedAgentTool: (request: AgentToolApprovalRequest): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke("agent:executeApprovedTool", request),
  loadAgentChatHistory: (): Promise<AgentChatHistoryRepository> => ipcRenderer.invoke("agent:history:load"),
  appendAgentChatHistory: (item: AgentChatHistoryItem): Promise<void> => ipcRenderer.invoke("agent:history:append", item),
  clearAgentChatHistory: (): Promise<void> => ipcRenderer.invoke("agent:history:clear")
};

contextBridge.exposeInMainWorld("bgt", api);

export type BrowserGameTranslatorApi = typeof api;
