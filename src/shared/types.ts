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

export interface WebGameDownloadInput {
  url: string;
  outputDirectory: string;
  runtimeCaptureSeconds?: number;
}

export interface WebGameDownloadProgress {
  phase: "download" | "runtime";
  completed: number;
  total: number;
  fileName?: string;
  message?: string;
}

export interface WebGameDownloadEvent {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface WebGameDownloadResult {
  status: boolean;
  message: string;
  filePath?: string;
  metadataPath?: string;
  indexPath?: string;
  assets?: string[];
  bytesDownloaded?: number;
  failures?: string[];
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

export interface AppVersionInfo {
  currentVersion: string;
  installedByUpdater: boolean;
  isPortable?: boolean;
  appId?: string;
  updatePendingRestart?: UpdateDescriptor;
  error?: string;
}

export interface UpdateDescriptor {
  targetVersion: string;
  releaseNotes?: string;
  releaseNotesHtml?: string;
  releaseUrl?: string;
  packageFileName?: string;
  packageSize?: number;
  raw: unknown;
}

export interface UpdateCheckResult {
  currentVersion: string;
  installedByUpdater: boolean;
  hasUpdate: boolean;
  update?: UpdateDescriptor;
  error?: string;
}

export interface UpdateDownloadProgress {
  percent: number;
}

export type NetworkProxyProtocol = "http" | "socks5";

export interface NetworkProxySettings {
  schemaVersion: 1;
  enabled: boolean;
  protocol: NetworkProxyProtocol;
  host: string;
  port: number;
  bypassList: string;
}

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
  previewPort?: number;
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
  aiExtractionRuleReviewSystem: string;
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
  context?: {
    before?: string;
    after?: string;
  };
}

export type ExtractionStrategyId =
  | "js-data-block"
  | "json-string"
  | "html-text"
  | "html-attr"
  | "js-string"
  | "js-object-key"
  | "js-val-string"
  | "plain-text"
  | "csv-cell"
  | "yaml-string";

export type ExtractionRisk =
  | "short_text"
  | "resource_like"
  | "code_like"
  | "placeholder_sensitive"
  | "html_fragment"
  | "technical_key"
  | "duplicate_locator"
  | "unsupported_backfill"
  | "validation_failed"
  | "minified_source"
  | "mixed_content";

export type ExtractionSourceRole =
  | "visible_text_value"
  | "ui_attribute"
  | "dialogue_field"
  | "resource_reference"
  | "mime_or_codec"
  | "event_name"
  | "css_or_selector"
  | "engine_runtime"
  | "unknown_js_value";

export interface ExtractionCandidateContext {
  keyPath?: string;
  keyName?: string;
  parentKeys?: string[];
  dataBlockName?: string;
  tagName?: string;
  attrName?: string;
  sourceRole?: ExtractionSourceRole;
  lineNumber?: number;
  before?: string;
  after?: string;
}

export interface ExtractionBackfillInfo {
  supported: boolean;
  method: "json-path" | "range" | "dom-range" | "engine-plugin" | "unsupported";
  validation: "not_checked" | "safe" | "warning" | "failed";
  message?: string;
}

export interface ExtractionCandidate {
  id: string;
  sourceFile: string;
  locator: string;
  original: string;
  normalizedOriginal: string;
  strategy: ExtractionStrategyId;
  groupKey: string;
  confidence: number;
  reasons: string[];
  risks: ExtractionRisk[];
  context: ExtractionCandidateContext;
  backfill: ExtractionBackfillInfo;
}

export interface ExtractionTextStats {
  minLength: number;
  maxLength: number;
  averageLength: number;
  uniqueCount: number;
  placeholderCount: number;
  htmlLikeCount: number;
}

export interface ExtractionBackfillSummary {
  safe: number;
  warning: number;
  failed: number;
  unsupported: number;
}

export type ExtractionDecision = "pending" | "include" | "exclude" | "deleted" | "partial";

export interface ExtractionUserDecision {
  decision: ExtractionDecision;
  origin?: "scan" | "ai" | "user";
  note?: string;
  includeCandidateIds?: string[];
  excludeCandidateIds?: string[];
  updatedAt?: string;
}

export interface ExtractionAiRecommendation {
  recommendation: "include" | "exclude" | "review";
  confidence: number;
  reason: string;
  suggestedLabel?: string;
  suggestedRisks?: string[];
  suggestedNoTranslatePatterns?: string[];
  suggestedSplitRules?: Array<{
    label: string;
    condition: string;
    reason: string;
  }>;
}

export interface ExtractionRuleMatcher {
  groupKey?: string;
  strategy?: ExtractionStrategyId;
  filePatterns?: string[];
  pathPatterns?: string[];
  locatorPrefixes?: string[];
  scriptVariables?: string[];
  risks?: ExtractionRisk[];
}

export interface ExtractionRule {
  id: string;
  strategy: ExtractionStrategyId;
  label: string;
  matcher: ExtractionRuleMatcher;
  decision: "include" | "exclude" | "partial";
  backfill: {
    method: ExtractionBackfillInfo["method"];
    requiresValidation: boolean;
  };
  risks: ExtractionRisk[];
}

export interface ExtractionRuleGroup {
  id: string;
  groupKey: string;
  label: string;
  strategy: ExtractionStrategyId;
  matcher: ExtractionRuleMatcher;
  candidateCount: number;
  sampleCandidateIds: string[];
  fileDistribution: Array<{ sourceFile: string; count: number }>;
  textStats: ExtractionTextStats;
  risks: ExtractionRisk[];
  backfillSummary: ExtractionBackfillSummary;
  ai: ExtractionAiRecommendation;
  userDecision: ExtractionUserDecision;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionRuleScanResult {
  candidates: ExtractionCandidate[];
  groups: ExtractionRuleGroup[];
  report: ExtractionRuleReport;
}

export interface ExtractionScanProgress {
  phase: "enumerating" | "scanning" | "grouping" | "saving" | "done";
  fileCurrent: number;
  fileTotal: number;
  currentFile?: string;
  fileProgress: number;
  fileStep: string;
  message: string;
}

export interface ExtractionAiReviewProgress {
  phase: "preparing" | "reviewing" | "saving" | "done";
  completedBatches: number;
  totalBatches: number;
  failedBatches: number;
  targetGroupCount: number;
  currentBatch?: number;
  message: string;
}

export interface ExtractionRuleReport {
  schemaVersion: 1;
  scannedAt: string;
  fileCount: number;
  candidateCount: number;
  groupCount: number;
  approvedCandidateCount: number;
  duplicateLocatorCount: number;
  failedValidationCount: number;
  unsupportedBackfillCount: number;
}

export interface ExtractionRulesFile {
  schemaVersion: 1;
  rules: ExtractionRule[];
  updatedAt: string;
}

export type ExtractionRuleScope = "project" | "global";

export type ExtractionRulePackageSourceKind = "user" | "online" | "generated";

export interface ExtractionRulePackageUpdateUrl {
  sourceId: string;
  discussionId: string;
  discussionNumber: number;
  url: string;
  revision: number;
  sha256: string;
  updatedAt: string;
}

export interface ExtractionRulePackage {
  schemaVersion: 1;
  kind: "bgt.extractionRulePackage";
  id: string;
  displayName: string;
  description: string;
  engine: string;
  tags: string[];
  ruleEngineVersion: string;
  minAppVersion?: string;
  sourceKind: ExtractionRulePackageSourceKind;
  readonly: boolean;
  derivedFrom?: {
    packageId: string;
    sourceKind: ExtractionRulePackageSourceKind;
    version?: string;
    url?: string;
  };
  rules: ExtractionRule[];
  createdAt: string;
  updatedAt: string;
  updateUrl?: ExtractionRulePackageUpdateUrl;
}

export interface ExtractionRulePackageSummary {
  scope: ExtractionRuleScope | "online";
  id: string;
  displayName: string;
  description: string;
  engine: string;
  tags: string[];
  sourceKind: ExtractionRulePackageSourceKind;
  readonly: boolean;
  ruleCount: number;
  updatedAt: string;
  updateUrl?: ExtractionRulePackageUpdateUrl;
  fileName?: string;
}

export interface ExtractionRulePackageImportResult {
  status: "cancelled" | "imported" | "conflict";
  package?: ExtractionRulePackage;
  existing?: ExtractionRulePackageSummary;
}

export interface ExtractionRulePackageDryRunResult {
  packageId: string;
  fileCount: number;
  candidateCount: number;
  matchedCandidateCount: number;
  groupCount: number;
  backfillSummary: ExtractionBackfillSummary;
  samples: ExtractionCandidate[];
  risks: ExtractionRisk[];
}

export interface OnlineExtractionRuleSource {
  id: string;
  displayName: string;
  url: string;
  owner: string;
  repo: string;
  dictionaryCategory: string;
  extractionRuleCategory: string;
  enabled: boolean;
  readonly?: boolean;
}

export interface OnlineExtractionRuleSettings {
  schemaVersion: 1;
  sources: OnlineExtractionRuleSource[];
  useToken: boolean;
}

export type OnlineExtractionRuleStorageMode = "inline" | "comments" | "compressedInline" | "compressedComments" | "attachment";

export interface OnlineExtractionRuleMeta {
  schemaVersion: 1;
  kind: "bgt.onlineExtractionRulePackage";
  id: string;
  displayName: string;
  description: string;
  engine: string;
  tags: string[];
  ruleEngineVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnlineExtractionRuleEncodedCommentPart {
  index: number;
  commentId: string;
  byteLength: number;
  sha256: string;
}

export type OnlineExtractionRuleManifest =
  | {
      schemaVersion: 1;
      storage: {
        mode: "inline";
        revision: number;
        ruleCount: number;
        sha256: string;
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "compressedInline";
        revision: number;
        ruleCount: number;
        sha256: string;
        compression: "gzip";
        encoding: "base64";
        byteLength: number;
        compressedByteLength: number;
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "comments" | "compressedComments" | "attachment";
        revision: number;
        ruleCount: number;
        sha256: string;
        parts?: OnlineExtractionRuleEncodedCommentPart[];
        url?: string;
        fileName?: string;
        compression?: "none" | "gzip" | "zip";
        encoding?: "base64";
        byteLength?: number;
        compressedByteLength?: number;
      };
    };

export interface OnlineExtractionRuleSummary {
  sourceId: string;
  discussionId: string;
  discussionNumber: number;
  url: string;
  title: string;
  author: string;
  updatedAt: string;
  introduction: string;
  introductionHtml?: string;
  meta: OnlineExtractionRuleMeta;
  manifest?: OnlineExtractionRuleManifest;
}

export interface OnlineExtractionRuleListResult {
  summaries: OnlineExtractionRuleSummary[];
  page: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface OnlineExtractionRulePackage {
  summary: OnlineExtractionRuleSummary;
  package: ExtractionRulePackage;
}

export interface OnlineExtractionRuleSubmissionOptions {
  sourceId: string;
  title: string;
  introduction: string;
}

export interface OnlineExtractionRuleInlineSubmissionResult {
  canInline: boolean;
  title: string;
  body?: string;
  comments?: Array<{
    index: number;
    body: string;
    byteLength?: number;
  }>;
  ruleCount: number;
  byteLength: number;
  limit: number;
  mode: OnlineExtractionRuleStorageMode;
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
  ambiguity?: CharacterNameAmbiguity;
  note: string;
  enabled: boolean;
}

export interface CharacterNameAmbiguity {
  source?: boolean;
  familyName?: boolean;
  givenName?: boolean;
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
  gameName: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string;
  updatedAt: string;
  remote?: DictionaryTableRemote;
}

export interface DictionaryTableRemote {
  sourceId: string;
  discussionId: string;
  discussionNumber: number;
  url: string;
  revision: number;
  sha256: string;
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
  fileName?: string;
  tableType: ResourceTableType;
  displayName: string;
  description: string;
  gameName: string;
  sourceLanguage: string;
  targetLanguage: string;
  updateUrl?: string;
  rowCount: number;
  deletable: boolean;
}

export interface DictionaryImportResult {
  status: "cancelled" | "imported" | "conflict";
  table?: DictionaryTable;
  existing?: DictionaryTableSummary;
}

export type OnlineDictionaryStorageMode = "inline" | "comments" | "compressedInline" | "compressedComments" | "attachment";
export type OnlineDictionaryCompression = "none" | "gzip" | "zip";

export interface OnlineDictionarySource {
  id: string;
  displayName: string;
  url: string;
  owner: string;
  repo: string;
  dictionaryCategory: string;
  extractionRuleCategory: string;
  enabled: boolean;
  readonly?: boolean;
}

export interface OnlineDictionarySettings {
  schemaVersion: 1;
  sources: OnlineDictionarySource[];
  useToken: boolean;
}

export interface OnlineDictionaryMeta {
  schemaVersion: 1;
  kind: "bgt.onlineDictionaryTable";
  id: string;
  tableType: ResourceTableType;
  displayName: string;
  description: string;
  sourceLanguage: string;
  targetLanguage: string;
  gameName: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnlineDictionaryCommentPart {
  index: number;
  commentId: string;
  rowCount: number;
  sha256: string;
}

export interface OnlineDictionaryEncodedCommentPart {
  index: number;
  commentId: string;
  byteLength: number;
  sha256: string;
}

export type OnlineDictionaryManifest =
  | {
      schemaVersion: 1;
      storage: {
        mode: "inline";
        revision: number;
        rowCount: number;
        sha256: string;
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "comments";
        revision: number;
        rowCount: number;
        sha256: string;
        parts: OnlineDictionaryCommentPart[];
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "compressedInline";
        revision: number;
        rowCount: number;
        sha256: string;
        compression: "gzip";
        encoding: "base64";
        byteLength: number;
        compressedByteLength: number;
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "compressedComments";
        revision: number;
        rowCount: number;
        sha256: string;
        compression: "gzip";
        encoding: "base64";
        byteLength: number;
        compressedByteLength: number;
        parts: OnlineDictionaryEncodedCommentPart[];
      };
    }
  | {
      schemaVersion: 1;
      storage: {
        mode: "attachment";
        revision: number;
        rowCount: number;
        sha256: string;
        url: string;
        fileName: string;
        compression: OnlineDictionaryCompression;
        contentType?: string;
      };
    };

export interface OnlineDictionarySummary {
  sourceId: string;
  discussionId: string;
  discussionNumber: number;
  url: string;
  title: string;
  author: string;
  updatedAt: string;
  introduction: string;
  introductionHtml?: string;
  meta: OnlineDictionaryMeta;
  manifest?: OnlineDictionaryManifest;
}

export interface OnlineDictionaryListResult {
  summaries: OnlineDictionarySummary[];
  page: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface OnlineDictionaryTable {
  summary: OnlineDictionarySummary;
  rows: DictionaryTableRows;
}

export interface OnlineDictionaryConnectionTest {
  ok: boolean;
  message: string;
}

export interface OnlineDictionaryTokenStatus {
  configured: boolean;
  enabled: boolean;
  login?: string;
}

export interface OnlineDictionarySubmissionOptions {
  sourceId: string;
  title: string;
  introduction: string;
  gameDisplayName: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface OnlineDictionaryUpdateOptions extends OnlineDictionarySubmissionOptions {
  discussion: string;
  expectedRevision?: number;
  expectedSha256?: string;
}

export interface OnlineDictionaryPublishResult {
  url: string;
  discussionId?: string;
  discussionNumber?: number;
  mode: OnlineDictionaryStorageMode;
  revision?: number;
  sha256?: string;
}

export interface OnlineDictionarySubmissionPackageResult {
  directory: string;
  bodyPath?: string;
  guidePath?: string;
  jsonlPath?: string;
  gzipPath?: string;
}

export interface OnlineDictionaryInlineSubmissionResult {
  canInline: boolean;
  title: string;
  body?: string;
  comments?: Array<{
    index: number;
    body: string;
    rowCount?: number;
    byteLength?: number;
  }>;
  rowCount: number;
  byteLength: number;
  limit: number;
}

export interface ProofreadOptions {
  languageCheck: boolean;
  targetLanguageRatio: number;
  characterCheck: boolean;
  characterAmbiguityCheck: boolean;
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

export interface PatchProgress {
  phase: "preparing" | "rebuilding" | "writing" | "saving" | "done";
  current: number;
  total: number;
  percent: number;
  message: string;
  currentFile?: string;
  replacements?: number;
  blocked?: number;
}
