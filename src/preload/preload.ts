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
  AppVersionInfo,
  AppStateSnapshot,
  CreateProjectInput,
  DictionaryImportResult,
  DictionaryScope,
  DictionaryTable,
  DictionaryTableMeta,
  DictionaryTableSummary,
  ExtractionCandidate,
  ExtractionAiReviewProgress,
  ExtractionDecision,
  ExtractionRuleGroup,
  ExtractionRulePackage,
  ExtractionRulePackageDryRunResult,
  ExtractionRulePackageImportResult,
  ExtractionRulePackageSummary,
  ExtractionRuleScanResult,
  ExtractionRuleScope,
  ExtractionScanProgress,
  ExtractionRulesFile,
  OriginalSourceFile,
  OnlineDictionaryConnectionTest,
  OnlineDictionaryInlineSubmissionResult,
  OnlineDictionaryListResult,
  OnlineDictionaryPublishResult,
  OnlineDictionarySettings,
  OnlineDictionarySubmissionOptions,
  OnlineDictionarySubmissionPackageResult,
  OnlineDictionaryTable,
  OnlineDictionaryTokenStatus,
  OnlineDictionaryUpdateOptions,
  OnlineExtractionRuleListResult,
  OnlineExtractionRuleInlineSubmissionResult,
  OnlineExtractionRulePackage,
  OnlineExtractionRuleSettings,
  OnlineExtractionRuleSubmissionOptions,
  NetworkProxySettings,
  PackageProjectInput,
  PackageProjectResult,
  PatchProgress,
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
  TextItem,
  UpdateCheckResult,
  UpdateDownloadProgress,
  WebGameDownloadEvent,
  WebGameDownloadInput,
  WebGameDownloadProgress,
  WebGameDownloadResult
} from "../shared/types";

const api = {
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write-text", text),
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
  loadNetworkProxySettings: (): Promise<NetworkProxySettings> => ipcRenderer.invoke("network-proxy:load"),
  saveNetworkProxySettings: (settings: NetworkProxySettings): Promise<NetworkProxySettings> => ipcRenderer.invoke("network-proxy:save", settings),
  getAppVersion: (): Promise<AppVersionInfo> => ipcRenderer.invoke("updates:getVersion"),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("updates:check"),
  downloadUpdate: (update: unknown): Promise<void> => ipcRenderer.invoke("updates:download", update),
  applyUpdate: (update: unknown): Promise<void> => ipcRenderer.invoke("updates:apply", update),
  onUpdateDownloadProgress: (listener: (progress: UpdateDownloadProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: UpdateDownloadProgress) => listener(progress);
    ipcRenderer.on("updates:download-progress", wrapped);
    return () => ipcRenderer.removeListener("updates:download-progress", wrapped);
  },
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
  listProgramAiIo: (): Promise<ProgramAiIoEvent[]> => ipcRenderer.invoke("ai-program:list-io"),
  loadPrompts: (scope: PromptScope): Promise<PromptConfig> => ipcRenderer.invoke("prompts:load", scope),
  savePrompts: (scope: PromptScope, prompts: PromptConfig): Promise<PromptConfig> => ipcRenderer.invoke("prompts:save", scope, prompts),
  loadDefaultPrompts: (): Promise<PromptConfig> => ipcRenderer.invoke("prompts:defaults"),
  loadEffectivePrompts: (): Promise<PromptConfig> => ipcRenderer.invoke("prompts:effective"),
  downloadWebGame: (input: WebGameDownloadInput): Promise<WebGameDownloadResult> => ipcRenderer.invoke("tools:webGame:download", input),
  validateWebGameOutputDirectory: (outputPath: string): Promise<string[]> => ipcRenderer.invoke("tools:webGame:validateOutput", outputPath),
  onWebGameDownloadLog: (listener: (event: WebGameDownloadEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, logEvent: WebGameDownloadEvent) => listener(logEvent);
    ipcRenderer.on("tools:webGame:log", wrapped);
    return () => ipcRenderer.removeListener("tools:webGame:log", wrapped);
  },
  onWebGameDownloadProgress: (listener: (progress: WebGameDownloadProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: WebGameDownloadProgress) => listener(progress);
    ipcRenderer.on("tools:webGame:progress", wrapped);
    return () => ipcRenderer.removeListener("tools:webGame:progress", wrapped);
  },
  downloadAaOnlineGame: (input: AaOfflineDownloadInput): Promise<AaOfflineDownloadResult> => ipcRenderer.invoke("tools:aaoffline:download", input),
  validateAaOfflineOutputDirectory: (outputPath: string): Promise<string[]> => ipcRenderer.invoke("tools:aaoffline:validateOutput", outputPath),
  onAaOfflineDownloadLog: (listener: (event: AaOfflineDownloadEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, logEvent: AaOfflineDownloadEvent) => listener(logEvent);
    ipcRenderer.on("tools:aaoffline:log", wrapped);
    return () => ipcRenderer.removeListener("tools:aaoffline:log", wrapped);
  },
  scanExtractionRules: (): Promise<ExtractionRuleScanResult> => ipcRenderer.invoke("extractionRules:scan"),
  onExtractionScanProgress: (listener: (progress: ExtractionScanProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ExtractionScanProgress) => listener(progress);
    ipcRenderer.on("extractionRules:scanProgress", wrapped);
    return () => ipcRenderer.removeListener("extractionRules:scanProgress", wrapped);
  },
  onExtractionAiReviewProgress: (listener: (progress: ExtractionAiReviewProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ExtractionAiReviewProgress) => listener(progress);
    ipcRenderer.on("extractionRules:aiReviewProgress", wrapped);
    return () => ipcRenderer.removeListener("extractionRules:aiReviewProgress", wrapped);
  },
  listExtractionCandidates: (): Promise<ExtractionCandidate[]> => ipcRenderer.invoke("extractionRules:listCandidates"),
  listExtractionRuleGroups: (): Promise<ExtractionRuleGroup[]> => ipcRenderer.invoke("extractionRules:listGroups"),
  listConfirmedExtractionRules: (): Promise<ExtractionRulesFile> => ipcRenderer.invoke("extractionRules:listRules"),
  reviewExtractionRulesWithAi: (provider: ProviderConfig, options?: { decisions?: ExtractionDecision[] }): Promise<ExtractionRuleGroup[]> =>
    ipcRenderer.invoke("extractionRules:reviewWithAi", provider, options),
  saveExtractionRuleDecisions: (updates: Array<{ groupId: string; decision: ExtractionDecision; note?: string }>): Promise<ExtractionRuleGroup[]> =>
    ipcRenderer.invoke("extractionRules:saveDecisions", updates),
  materializeExtractionTextItems: (): Promise<AppStateSnapshot> => ipcRenderer.invoke("extractionRules:materializeTextItems"),
  createProjectExtractionRulePackage: (displayName?: string): Promise<ExtractionRulePackage> => ipcRenderer.invoke("extractionRules:createProjectPackage", displayName),
  listExtractionRulePackages: (): Promise<ExtractionRulePackageSummary[]> => ipcRenderer.invoke("extractionRulePackages:list"),
  loadExtractionRulePackage: (scope: ExtractionRuleScope, id: string, fileName?: string): Promise<ExtractionRulePackage> =>
    ipcRenderer.invoke("extractionRulePackages:load", scope, id, fileName),
  saveExtractionRulePackage: (scope: ExtractionRuleScope, pkg: ExtractionRulePackage, fileName?: string): Promise<ExtractionRulePackage> =>
    ipcRenderer.invoke("extractionRulePackages:save", scope, pkg, fileName),
  deleteExtractionRulePackage: (scope: ExtractionRuleScope, id: string, fileName?: string): Promise<void> =>
    ipcRenderer.invoke("extractionRulePackages:delete", scope, id, fileName),
  importExtractionRulePackage: (scope: ExtractionRuleScope, conflictMode?: "overwrite" | "newId", pendingPackage?: ExtractionRulePackage): Promise<ExtractionRulePackageImportResult> =>
    ipcRenderer.invoke("extractionRulePackages:import", scope, conflictMode, pendingPackage),
  exportExtractionRulePackage: (pkg: ExtractionRulePackage): Promise<string | null> => ipcRenderer.invoke("extractionRulePackages:export", pkg),
  dryRunExtractionRulePackage: (pkg: ExtractionRulePackage): Promise<ExtractionRulePackageDryRunResult> => ipcRenderer.invoke("extractionRulePackages:dryRun", pkg),
  applyExtractionRulePackageToProject: (pkg: ExtractionRulePackage): Promise<ExtractionRulePackage> => ipcRenderer.invoke("extractionRulePackages:applyToProject", pkg),
  copyExtractionRulePackageToGlobal: (pkg: ExtractionRulePackage): Promise<ExtractionRulePackage> => ipcRenderer.invoke("extractionRulePackages:copyToGlobal", pkg),
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
  loadDictionaryTable: (scope: DictionaryScope | "projectDefault", id: string, tableType: ResourceTableType, fileName?: string): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:load", scope, id, tableType, fileName),
  saveDictionaryTable: (scope: DictionaryScope | "projectDefault", table: DictionaryTable, fileName?: string): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:save", scope, table, fileName),
  createEmptyDictionaryTable: (scope: DictionaryScope, tableType: ResourceTableType, meta: Partial<DictionaryTableMeta>): Promise<DictionaryTable> =>
    ipcRenderer.invoke("dictionary:createEmpty", scope, tableType, meta),
  deleteDictionaryTable: (scope: DictionaryScope, id: string, fileName?: string): Promise<void> => ipcRenderer.invoke("dictionary:delete", scope, id, fileName),
  exportDictionaryTable: (table: DictionaryTable): Promise<string | null> => ipcRenderer.invoke("dictionary:export", table),
  importDictionaryTable: (scope: DictionaryScope, conflictMode?: "overwrite" | "newId", pendingTable?: DictionaryTable): Promise<DictionaryImportResult> =>
    ipcRenderer.invoke("dictionary:import", scope, conflictMode, pendingTable),
  listOnlineDictionarySources: (): Promise<OnlineDictionarySettings> => ipcRenderer.invoke("online-dictionaries:list-sources"),
  saveOnlineDictionarySources: (settings: OnlineDictionarySettings): Promise<OnlineDictionarySettings> => ipcRenderer.invoke("online-dictionaries:save-sources", settings),
  getOnlineDictionaryTokenStatus: (): Promise<OnlineDictionaryTokenStatus> => ipcRenderer.invoke("online-dictionaries:token-status"),
  saveOnlineDictionaryToken: (token: string): Promise<OnlineDictionaryTokenStatus> => ipcRenderer.invoke("online-dictionaries:save-token", token),
  testOnlineDictionarySource: (sourceId: string): Promise<OnlineDictionaryConnectionTest> => ipcRenderer.invoke("online-dictionaries:test-source", sourceId),
  listOnlineDictionaryTables: (sourceId: string, webSearchQuery?: string, page?: number, mineOnly?: boolean): Promise<OnlineDictionaryListResult> =>
    ipcRenderer.invoke("online-dictionaries:list-tables", sourceId, webSearchQuery, page, mineOnly),
  loadOnlineDictionaryTable: (sourceId: string, discussionId: string): Promise<OnlineDictionaryTable> => ipcRenderer.invoke("online-dictionaries:load-table", sourceId, discussionId),
  loadOnlineDictionaryTableByUrl: (url: string): Promise<OnlineDictionaryTable> => ipcRenderer.invoke("online-dictionaries:load-table-by-url", url),
  importOnlineDictionaryTable: (scope: DictionaryScope, sourceId: string, discussionId: string, conflictMode?: "overwrite" | "newId", pendingTable?: DictionaryTable): Promise<DictionaryImportResult> =>
    ipcRenderer.invoke("online-dictionaries:import-table", scope, sourceId, discussionId, conflictMode, pendingTable),
  publishOnlineDictionaryTable: (table: DictionaryTable, options: OnlineDictionarySubmissionOptions): Promise<OnlineDictionaryPublishResult> =>
    ipcRenderer.invoke("online-dictionaries:publish-table", table, options),
  updateOnlineDictionaryTable: (table: DictionaryTable, options: OnlineDictionaryUpdateOptions): Promise<OnlineDictionaryPublishResult> =>
    ipcRenderer.invoke("online-dictionaries:update-table", table, options),
  deleteOnlineDictionaryTable: (sourceId: string, discussionId: string): Promise<{ clearedLocalLinks: number }> =>
    ipcRenderer.invoke("online-dictionaries:delete-table", sourceId, discussionId),
  exportOnlineDictionarySubmissionPackage: (table: DictionaryTable, options: OnlineDictionarySubmissionOptions): Promise<OnlineDictionarySubmissionPackageResult | null> =>
    ipcRenderer.invoke("online-dictionaries:export-submission-package", table, options),
  buildOnlineDictionaryInlineSubmission: (table: DictionaryTable, options: OnlineDictionarySubmissionOptions): Promise<OnlineDictionaryInlineSubmissionResult> =>
    ipcRenderer.invoke("online-dictionaries:inline-submission", table, options),
  listOnlineExtractionRuleSources: (): Promise<OnlineExtractionRuleSettings> => ipcRenderer.invoke("online-extraction-rules:list-sources"),
  saveOnlineExtractionRuleSources: (settings: OnlineExtractionRuleSettings): Promise<OnlineExtractionRuleSettings> =>
    ipcRenderer.invoke("online-extraction-rules:save-sources", settings),
  getOnlineExtractionRuleTokenStatus: (): Promise<OnlineDictionaryTokenStatus> => ipcRenderer.invoke("online-extraction-rules:token-status"),
  saveOnlineExtractionRuleToken: (token: string): Promise<OnlineDictionaryTokenStatus> => ipcRenderer.invoke("online-extraction-rules:save-token", token),
  testOnlineExtractionRuleSource: (sourceId: string): Promise<OnlineDictionaryConnectionTest> => ipcRenderer.invoke("online-extraction-rules:test-source", sourceId),
  listOnlineExtractionRulePackages: (sourceId: string, webSearchQuery?: string, page?: number, mineOnly?: boolean): Promise<OnlineExtractionRuleListResult> =>
    ipcRenderer.invoke("online-extraction-rules:list-packages", sourceId, webSearchQuery, page, mineOnly),
  loadOnlineExtractionRulePackage: (sourceId: string, discussionId: string): Promise<OnlineExtractionRulePackage> =>
    ipcRenderer.invoke("online-extraction-rules:load-package", sourceId, discussionId),
  importOnlineExtractionRulePackage: (sourceId: string, discussionId: string): Promise<ExtractionRulePackage> =>
    ipcRenderer.invoke("online-extraction-rules:import-package", sourceId, discussionId),
  publishOnlineExtractionRulePackage: (pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions): Promise<{ id: string; number: number; url: string; revision?: number; sha256?: string; mode?: string }> =>
    ipcRenderer.invoke("online-extraction-rules:publish-package", pkg, options),
  updateOnlineExtractionRulePackage: (pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions & { discussionId: string; expectedRevision?: number }): Promise<{ url: string; discussionId: string; discussionNumber: number; revision: number; sha256?: string; mode?: string }> =>
    ipcRenderer.invoke("online-extraction-rules:update-package", pkg, options),
  deleteOnlineExtractionRulePackage: (sourceId: string, discussionId: string): Promise<{ clearedLocalLinks: number }> =>
    ipcRenderer.invoke("online-extraction-rules:delete-package", sourceId, discussionId),
  buildOnlineExtractionRuleInlineSubmission: (pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions): Promise<OnlineExtractionRuleInlineSubmissionResult> =>
    ipcRenderer.invoke("online-extraction-rules:inline-submission", pkg, options),
  translate: (provider: ProviderConfig, targetLanguage: string): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:start", provider, targetLanguage),
  translateBatch: (provider: ProviderConfig, targetLanguage: string, items: TextItem[], options?: { titlePrefix?: string; batchIndexOffset?: number; batchTotal?: number }): Promise<TextItem[]> =>
    ipcRenderer.invoke("translation:batch", provider, targetLanguage, items, options),
  proofread: (items: TextItem[], analysis: AnalysisResult, options: ProofreadOptions): Promise<ProofreadIssue[]> =>
    ipcRenderer.invoke("proofread:start", items, analysis, options),
  aiProofread: (provider: ProviderConfig, issues: ProofreadIssue[], options?: { titlePrefix?: string; batchIndexOffset?: number; batchTotal?: number }): Promise<TextItem[]> =>
    ipcRenderer.invoke("proofread:ai", provider, issues, options),
  previewPatch: (items: TextItem[]): Promise<PatchPreview> => ipcRenderer.invoke("patch:preview", items),
  onPatchProgress: (listener: (progress: PatchProgress) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: PatchProgress) => listener(progress);
    ipcRenderer.on("patch:progress", wrapped);
    return () => ipcRenderer.removeListener("patch:progress", wrapped);
  },
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
