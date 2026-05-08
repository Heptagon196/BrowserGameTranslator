export type ProviderType = "openai" | "deepseek";
export type TextStatus = "extracted" | "translated" | "failed" | "needs_review" | "excluded";
export type IssueSeverity = "info" | "warning" | "error";
export type IssueStatus = "open" | "fixed" | "ignored";
export type PromptScope = "global" | "workspace";
export type AiPermissionMode = "restricted" | "workspace" | "full";
export type AiCostCurrency = "CNY" | "USD";

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

export interface AiShellAuthorizationRequest {
  id: string;
  command: string;
  cwd: string;
  permissionMode: AiPermissionMode;
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
  translationRules: string[];
}

export interface TextMetadata {
  lineBreakCount: number;
  placeholders: string[];
  tags: string[];
  numericPrefix: string | null;
}

export interface TextItem {
  id: string;
  sourceFile: string;
  sourceType: "html" | "json" | "js" | "txt" | "csv" | "yaml";
  locator: string;
  original: string;
  translation: string;
  status: TextStatus;
  originalHash: string;
  context: {
    before?: string;
    after?: string;
  };
  metadata: TextMetadata;
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
  category: string;
  note: string;
  confidence: number;
  enabled: boolean;
  sourceExamples: string[];
}

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  description: string;
  category: string;
  isRegex: boolean;
  enabled: boolean;
  sourceExamples: string[];
}

export interface NoTranslateEntry {
  id: string;
  marker: string;
  note: string;
  isRegex: boolean;
  enabled: boolean;
  sourceExamples: string[];
}

export interface AnalysisResult {
  characters: CharacterEntry[];
  glossary: GlossaryEntry[];
  noTranslate: NoTranslateEntry[];
}

export interface ProofreadOptions {
  languageCheck: boolean;
  targetLanguageRatio: number;
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  origin?: "user" | "program";
  kind?: "chat" | "rule" | "program_prompt" | "program_response" | "program_summary";
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
  chat: ChatMessage[];
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
