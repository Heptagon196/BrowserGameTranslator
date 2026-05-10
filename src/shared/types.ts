export type ProviderType = "openai" | "deepseek";
export type TextStatus = "extracted" | "translated" | "failed" | "needs_review" | "excluded";
export type IssueSeverity = "info" | "warning" | "error";
export type IssueStatus = "open" | "fixed" | "ignored";
export type PromptScope = "global" | "workspace";
export type AiCostCurrency = "CNY" | "USD";
export type AiPermissionMode = "restricted" | "workspace" | "unrestricted";

export interface AiBalanceSnapshot {
  providerId: string;
  isAvailable: boolean;
  balances: Array<{
    currency: AiCostCurrency;
    totalBalance: string;
    grantedBalance: string;
    toppedUpBalance: string;
  }>;
  error?: string;
}

export interface ItchDownloadInput {
  url: string;
  outputDirectory: string;
}

export interface ItchDownloadProgress {
  bytesReceived: number;
  totalBytes?: number;
  fileName?: string;
}

export interface ItchDownloadEvent {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface ItchDownloadResult {
  status: boolean;
  message: string;
  filePath?: string;
  metadataPath?: string;
  html5Assets?: string[];
  bytesDownloaded?: number;
}

export interface AaOfflineDownloadInput {
  caseUrlOrId: string;
  outputPath: string;
  playerVersion: string;
  concurrentDownloads: number;
  continueOnAssetError: boolean;
  withUserscripts: "none" | "all" | "backlog" | "better-layout" | "keyboard-controls" | "alt-nametag";
}

export interface AaOfflineDownloadEvent {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface AaOfflineDownloadResult {
  status: boolean;
  message: string;
  outputPath: string;
  exitCode: number | null;
  logs: AaOfflineDownloadEvent[];
}

export type PackageFormat = "zip" | "7z" | "tar.xz";

export interface PackageProjectInput {
  fileName: string;
  format: PackageFormat;
  addLauncher: boolean;
  outputDirectory?: string;
}

export interface PackageProjectResult {
  archivePath: string;
  format: PackageFormat;
  bytes: number;
}

export interface PreviewStatus {
  running: boolean;
  url?: string;
}

export interface ProjectConfig {
  schemaVersion: 1;
  projectName: string;
  projectRoot: string;
  homePage: string;
  sourceLanguage: string;
  targetLanguage: string;
  scanProfile: "web-game-default";
  createdAt: string;
}

export interface RecentProject {
  projectName: string;
  projectRoot: string;
  projectPath: string;
  lastOpenedAt: string;
  exists: boolean;
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  displayName: string;
  baseUrl: string;
  model: string;
  chatModel: string;
  models?: string[];
  disabledModels?: string[];
  modelSettings?: Record<string, ProviderModelSettings>;
  apiKey: string;
  rpmLimit: number;
  tpmLimit: number;
  temperature: number;
  maxOutputTokens: number;
  parallelBatchLimit?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ProviderModelSettings {
  temperature?: number;
  maxOutputTokens?: number;
  rpmLimit?: number;
  tpmLimit?: number;
  parallelBatchLimit?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface PromptConfig {
  connectionTestSystem: string;
  analysisSystem: string;
  aiLocalizationPlanSystem: string;
  translationSystem: string;
  proofreadSystem: string;
  translationRules: string[];
}

export interface TextItem {
  id: string;
  sourceFile: string;
  locator: string;
  original: string;
  translation: string;
  status: TextStatus;
  context: {
    before?: string;
    after?: string;
  };
}

export interface OriginalSourceFile {
  sourceFile: string;
  content: string;
  bytes: number;
}

export interface ScanReport {
  scannedAt: string;
  fileCount: number;
  extractedCount: number;
  skippedCount: number;
  files: Array<{
    path: string;
    type: string;
    extractedCount: number;
    strategy?: string;
  }>;
}

export interface AiLocalizationPlan {
  schemaVersion: 1;
  createdAt: string;
  engine: string;
  summary: string;
  includeFiles: string[];
  excludeFiles: string[];
  extractionNotes: string[];
  backfillNotes: string[];
  risks: string[];
}

export interface CharacterEntry {
  id: string;
  source: string;
  target: string;
  familyName?: string;
  familyNameTranslation?: string;
  givenName?: string;
  givenNameTranslation?: string;
  nicknameOf?: string;
  note: string;
  enabled: boolean;
}

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  note: string;
  category: string;
  isRegex: boolean;
  enabled: boolean;
}

export interface NoTranslateEntry {
  id: string;
  marker: string;
  note: string;
  isRegex: boolean;
  enabled: boolean;
}

export interface AnalysisResult {
  characters: CharacterEntry[];
  glossary: GlossaryEntry[];
  noTranslate: NoTranslateEntry[];
}

export type ResourceTableType = "characters" | "glossary" | "noTranslate";
export type DictionaryScope = "global" | "project";

export interface DictionaryTableMeta {
  schemaVersion: 1;
  kind: "bgt.resourceTable";
  id: string;
  tableType: ResourceTableType;
  displayName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type DictionaryTableRows = CharacterEntry[] | GlossaryEntry[] | NoTranslateEntry[];

export interface DictionaryTable {
  meta: DictionaryTableMeta;
  rows: DictionaryTableRows;
}

export interface DictionaryTableSummary {
  scope: DictionaryScope | "projectDefault";
  id: string;
  tableType: ResourceTableType;
  displayName: string;
  description: string;
  rowCount: number;
  deletable: boolean;
}

export interface DictionaryImportResult {
  status: "cancelled" | "imported" | "conflict";
  table?: DictionaryTable;
  existing?: DictionaryTableSummary;
}

export interface ProofreadOptions {
  languageCheck: boolean;
  targetLanguageRatio: number;
  characterCheck: boolean;
  glossaryCheck: boolean;
  untranslatedStatusCheck: boolean;
  noTranslateCheck: boolean;
  numericResidueCheck: boolean;
  lineBreakCheck: boolean;
  placeholderCheck: boolean;
  htmlTagCheck: boolean;
  emptyTranslationCheck: boolean;
}

export interface ProofreadIssue {
  id: string;
  textItemId: string;
  rule: string;
  severity: IssueSeverity;
  message: string;
  status: IssueStatus;
}

export interface AgentRunRequest {
  input: unknown;
  provider: ProviderConfig;
  permissionMode?: AiPermissionMode;
  context?: {
    currentView?: string;
    currentTable?: string;
    currentTableId?: string;
    currentTableDescription?: string;
    projectName?: string;
  };
}

export interface AgentRunResult {
  events: unknown[];
}

export interface AgentRunStreamRequest extends AgentRunRequest {
  clientRunId: string;
}

export interface AgentCancelRequest {
  clientRunId: string;
}

export interface AgentRunEventPayload {
  clientRunId: string;
  event: unknown;
}

export interface AgentToolApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  permissionMode: AiPermissionMode;
}

export interface AgentChatHistoryItem {
  parentId: string | null;
  message: unknown;
}

export interface AgentChatHistoryRepository {
  headId: string | null;
  messages: AgentChatHistoryItem[];
}

export interface AgentContextMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

export interface AgentModelContext {
  schemaVersion: 1;
  updatedAt: string;
  summary: string;
  summaryFingerprint?: string;
  messages: AgentContextMessage[];
}

export interface AgentCheckpointToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary?: string;
  reasoningContent?: string;
}

export interface AgentCheckpoint {
  schemaVersion: 1;
  updatedAt: string;
  status: "idle" | "pending_approval";
  runId?: string;
  parentMessageId?: string;
  messages?: unknown[];
  toolCalls: AgentCheckpointToolCall[];
}

export type AgentTaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface AgentTaskPlanItem {
  id: string;
  description: string;
  status: AgentTaskStatus;
  evidence?: string;
  updatedAt: string;
}

export interface AgentTaskPlan {
  schemaVersion: 1;
  updatedAt: string;
  runId?: string;
  userGoal: string;
  needsLookup?: boolean;
  needsMutation?: boolean;
  needsUserApproval?: boolean;
  doneCriteria?: string;
  plannerSource?: "model" | "fallback";
  items: AgentTaskPlanItem[];
}

export interface ProgramAiIoEvent {
  id: string;
  title: string;
  createdAt: string;
  requestMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  ok: boolean;
  error?: string;
}

export interface CreateProjectInput {
  projectName: string;
  projectRoot: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface AppStateSnapshot {
  project: ProjectConfig | null;
  providers: ProviderConfig[];
  activeProviderId: string;
  activeChatProviderId: string;
  recentProjects: RecentProject[];
  textItems: TextItem[];
  scanReport: ScanReport | null;
  aiLocalizationPlan: AiLocalizationPlan | null;
  analysis: AnalysisResult;
  issues: ProofreadIssue[];
}

export interface PatchPreview {
  files: Array<{
    path: string;
    replacements: number;
    backupPath: string;
  }>;
  blocked: Array<{
    textItemId: string;
    reason: string;
  }>;
}
