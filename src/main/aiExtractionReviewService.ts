import {
  ExtractionAiRecommendation,
  ExtractionAiReviewProgress,
  ExtractionCandidate,
  ExtractionDecision,
  ExtractionRuleGroup,
  ExtractionRulesFile,
  ProgramAiIoEvent,
  ProjectConfig,
  PromptConfig,
  ProviderConfig
} from "../shared/types";
import { chatCompletion, parseJsonObject } from "./aiProvider";
import { rulesFromIncludedGroups } from "./extractors";
import { extractionRuleAiReviewPath, extractionRuleGroupsPath, extractionRulesPath, loadExtractionCandidates, loadExtractionRuleGroups } from "./extractionRuleService";
import { writeJson } from "./storage";

const AI_REVIEW_MAX_BATCH_SAMPLE_ROWS = 30;
const AI_REVIEW_CONCURRENCY = 3;
const AI_REVIEW_RETRY_COUNT = 5;

type AiReviewBatchResult = {
  batchIndex: number;
  groupIds: string[];
  requestMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  recommendations: Map<string, ExtractionAiRecommendation>;
  error?: string;
};

export async function reviewExtractionRuleGroupsWithAi(
  project: ProjectConfig,
  provider: ProviderConfig,
  prompts: PromptConfig,
  options: { decisions?: ExtractionDecision[] } = {},
  runtime: {
    onProgramAiIoEvent?: (event: Omit<ProgramAiIoEvent, "id" | "createdAt">) => void;
    onProgress?: (progress: ExtractionAiReviewProgress) => void;
  } = {}
): Promise<{
  groups: ExtractionRuleGroup[];
  requestMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  programAiIoEvents: Array<Omit<ProgramAiIoEvent, "id" | "createdAt">>;
}> {
  const [groups, candidates] = await Promise.all([loadExtractionRuleGroups(project), loadExtractionCandidates(project)]);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const reviewDecisions = new Set<ExtractionDecision>(options.decisions?.length ? options.decisions : ["pending"]);
  const reviewTargets = groups.filter((group) => shouldReviewGroupWithAi(group, reviewDecisions));
  const batches = buildAiReviewBatches(project, reviewTargets, byId);
  let completedBatches = 0;
  let failedBatchCount = 0;
  runtime.onProgress?.({
    phase: "reviewing",
    completedBatches,
    totalBatches: batches.length,
    failedBatches: failedBatchCount,
    targetGroupCount: reviewTargets.length,
    message: reviewTargets.length ? `准备排查 ${reviewTargets.length} 个规则组。` : "没有需要 AI 排查的规则组。"
  });
  const batchResults = await runAiReviewBatches(batches, async (batch, batchIndex) => {
    const result = await reviewExtractionRuleBatchWithRetry(project, provider, prompts, byId, batch, batchIndex, (attempt) => {
      runtime.onProgramAiIoEvent?.(buildAttemptAiReviewIoEvent(attempt, batches.length));
    });
    completedBatches += 1;
    if (result.error) failedBatchCount += 1;
    runtime.onProgramAiIoEvent?.(buildBatchAiReviewIoEvent(result, batches.length));
    runtime.onProgress?.({
      phase: "reviewing",
      completedBatches,
      totalBatches: batches.length,
      failedBatches: failedBatchCount,
      targetGroupCount: reviewTargets.length,
      currentBatch: batchIndex + 1,
      message: `已完成 ${completedBatches}/${batches.length} 个批次。`
    });
    return result;
  });
  const failedBatches = batchResults.filter((batch) => batch.error);
  if (reviewTargets.length && failedBatches.length === batchResults.length) {
    throw new Error(`AI 智能排查全部批次失败，已重试 ${AI_REVIEW_RETRY_COUNT} 次。`);
  }
  const reviewMap = new Map<string, ExtractionAiRecommendation>();
  for (const batch of batchResults) {
    for (const [id, recommendation] of batch.recommendations.entries()) {
      reviewMap.set(id, recommendation);
    }
  }
  const now = new Date().toISOString();
  runtime.onProgress?.({
    phase: "saving",
    completedBatches,
    totalBatches: batches.length,
    failedBatches: failedBatchCount,
    targetGroupCount: reviewTargets.length,
    message: "正在保存 AI 排查结果..."
  });
  const reviewed = groups.map((group) => {
    const ai = reviewMap.get(group.id);
    const nextDecision = ai && shouldApplyAiDecision(group, reviewDecisions)
      ? decisionFromAiRecommendation(ai)
      : group.userDecision.decision;
    return {
      ...group,
      label: ai?.suggestedLabel || group.label,
      ai: ai ?? group.ai,
      userDecision: nextDecision === group.userDecision.decision
        ? group.userDecision
        : { ...group.userDecision, decision: nextDecision, origin: "ai" as const, updatedAt: now },
      updatedAt: now
    };
  });
  await writeJson(extractionRuleAiReviewPath(project), {
    schemaVersion: 1,
    reviewedAt: now,
    maxBatchSampleRows: AI_REVIEW_MAX_BATCH_SAMPLE_ROWS,
    concurrency: AI_REVIEW_CONCURRENCY,
    retryCount: AI_REVIEW_RETRY_COUNT,
    selectedDecisions: Array.from(reviewDecisions),
    targetGroupCount: reviewTargets.length,
    successfulBatchCount: batchResults.length - failedBatches.length,
    failedBatches: failedBatches.map((batch) => ({ batchIndex: batch.batchIndex, groupIds: batch.groupIds, error: batch.error }))
  });
  await writeJson(extractionRuleGroupsPath(project), reviewed);
  await writeJson(extractionRulesPath(project), {
    schemaVersion: 1,
    rules: rulesFromIncludedGroups(reviewed),
    updatedAt: now
  } satisfies ExtractionRulesFile);
  runtime.onProgress?.({
    phase: "done",
    completedBatches,
    totalBatches: batches.length,
    failedBatches: failedBatchCount,
    targetGroupCount: reviewTargets.length,
    message: `AI 排查完成：${reviewTargets.length} 个规则组，${failedBatchCount} 个批次失败。`
  });
  return {
    groups: reviewed,
    requestMessages: [],
    responseContent: "",
    programAiIoEvents: runtime.onProgramAiIoEvent ? [] : buildBatchAiReviewIoEvents(batchResults)
  };
}

async function reviewExtractionRuleBatchWithRetry(
  project: ProjectConfig,
  provider: ProviderConfig,
  prompts: PromptConfig,
  byId: Map<string, ExtractionCandidate>,
  batch: ExtractionRuleGroup[],
  batchIndex: number,
  onFailedAttempt?: (attempt: AiReviewBatchResult & { attempt: number }) => void
): Promise<AiReviewBatchResult> {
  let lastRequestMessages: Array<{ role: string; content: string }> = [];
  let lastResponseContent = "";
  let lastError = "";
  for (let attempt = 0; attempt <= AI_REVIEW_RETRY_COUNT; attempt += 1) {
    const request = buildAiReviewRequest(project, batch, byId, {
      batchIndex,
      groupCount: batch.length,
      attempt: attempt + 1,
      previousError: attempt > 0 ? lastError : undefined,
      previousResponsePreview: attempt > 0 ? previewText(lastResponseContent, 1200) : undefined
    });
    const requestMessages = [
      { role: "system", content: prompts.aiExtractionRuleReviewSystem },
      { role: "user", content: JSON.stringify(request, null, 2) }
    ];
    lastRequestMessages = requestMessages;
    try {
      const responseContent = await chatCompletion(provider, requestMessages);
      lastResponseContent = responseContent;
      const parsed = parseJsonObject(responseContent);
      return {
        batchIndex,
        groupIds: batch.map((group) => group.id),
        requestMessages,
        responseContent,
        recommendations: recommendationsFromParsedReview(parsed)
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      onFailedAttempt?.({
        batchIndex,
        groupIds: batch.map((group) => group.id),
        requestMessages,
        responseContent: lastResponseContent,
        recommendations: new Map(),
        error: lastError || "批次失败。",
        attempt: attempt + 1
      });
      if (attempt < AI_REVIEW_RETRY_COUNT) await delay(500 * (attempt + 1));
    }
  }
  return {
    batchIndex,
    groupIds: batch.map((group) => group.id),
    requestMessages: lastRequestMessages,
    responseContent: lastResponseContent,
    recommendations: new Map(),
    error: lastError || "批次失败。"
  };
}

async function runAiReviewBatches<T>(
  batches: ExtractionRuleGroup[][],
  worker: (batch: ExtractionRuleGroup[], batchIndex: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(batches.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < batches.length) {
      const batchIndex = nextIndex;
      nextIndex += 1;
      results[batchIndex] = await worker(batches[batchIndex], batchIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AI_REVIEW_CONCURRENCY, batches.length) }, () => runWorker()));
  return results;
}

function recommendationsFromParsedReview(parsed: Record<string, any>): Map<string, ExtractionAiRecommendation> {
  const reviewMap = new Map<string, ExtractionAiRecommendation>();
  for (const row of Array.isArray(parsed.groups) ? parsed.groups : []) {
    const id = String(row.id ?? "");
    if (!id) continue;
    reviewMap.set(id, normalizeRecommendation(row));
  }
  return reviewMap;
}

function shouldReviewGroupWithAi(group: ExtractionRuleGroup, decisions: Set<ExtractionDecision>): boolean {
  if (group.userDecision.decision === "deleted") return false;
  return decisions.has(group.userDecision.decision);
}

function shouldApplyAiDecision(group: ExtractionRuleGroup, decisions: Set<ExtractionDecision>): boolean {
  if (group.userDecision.decision === "deleted") return false;
  return decisions.has(group.userDecision.decision);
}

function buildAiReviewRequest(
  project: ProjectConfig,
  groups: ExtractionRuleGroup[],
  byId: Map<string, ExtractionCandidate>,
  batch?: { batchIndex: number; groupCount: number; attempt: number; previousError?: string; previousResponsePreview?: string }
) {
  return {
    project: {
      name: project.projectName,
      sourceLanguage: project.sourceLanguage,
      targetLanguage: project.targetLanguage,
      homePage: project.homePage
    },
    batch: batch
      ? {
          ...batch,
          retryInstruction: batch.previousError
            ? "上一次 AI 智能排查响应用法不合格。请根据 previousError 修正输出，只返回符合要求的 JSON，不要输出解释文本或 Markdown。"
            : undefined
        }
      : undefined,
    groups: groups.map((group) => ({
      id: group.id,
      label: group.label,
      strategy: group.strategy,
      candidateCount: group.candidateCount,
      fileDistribution: group.fileDistribution.slice(0, 10),
      backfillSummary: group.backfillSummary,
      risks: group.risks,
      samples: group.sampleCandidateIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((candidate) => ({
          original: candidate!.original,
          context: candidate!.context,
          sourceFile: candidate!.sourceFile,
          locator: candidate!.locator
        }))
    }))
  };
}

function previewText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function buildBatchAiReviewIoEvents(batchResults: AiReviewBatchResult[]): Array<Omit<ProgramAiIoEvent, "id" | "createdAt">> {
  const total = batchResults.length;
  return batchResults.map((batch) => buildBatchAiReviewIoEvent(batch, total));
}

function buildBatchAiReviewIoEvent(batch: AiReviewBatchResult, total: number): Omit<ProgramAiIoEvent, "id" | "createdAt"> {
  return {
    title: `AI 规则组评审 ${batch.batchIndex + 1}/${total}`,
    requestMessages: batch.requestMessages,
    responseContent: batch.responseContent,
    ok: !batch.error,
    error: batch.error
  };
}

function buildAttemptAiReviewIoEvent(batch: AiReviewBatchResult & { attempt: number }, total: number): Omit<ProgramAiIoEvent, "id" | "createdAt"> {
  return {
    title: `AI 规则组评审 ${batch.batchIndex + 1}/${total} 重试 ${batch.attempt}/${AI_REVIEW_RETRY_COUNT + 1}`,
    requestMessages: batch.requestMessages,
    responseContent: batch.responseContent,
    ok: false,
    error: batch.error
  };
}

function normalizeRecommendation(row: Record<string, any>): ExtractionAiRecommendation {
  const recommendation = row.recommendation === "include" || row.recommendation === "exclude" || row.recommendation === "review" ? row.recommendation : "review";
  const confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0.5));
  return {
    recommendation,
    confidence,
    reason: String(row.reason ?? "AI 未提供理由。"),
    suggestedLabel: typeof row.suggestedLabel === "string" ? row.suggestedLabel : undefined,
    suggestedRisks: Array.isArray(row.suggestedRisks) ? row.suggestedRisks.map(String) : undefined,
    suggestedNoTranslatePatterns: Array.isArray(row.suggestedNoTranslatePatterns) ? row.suggestedNoTranslatePatterns.map(String) : undefined,
    suggestedSplitRules: Array.isArray(row.suggestedSplitRules)
      ? row.suggestedSplitRules.map((entry: Record<string, unknown>) => ({
          label: String(entry.label ?? ""),
          condition: String(entry.condition ?? ""),
          reason: String(entry.reason ?? "")
        }))
      : undefined
  };
}

function decisionFromAiRecommendation(ai: ExtractionAiRecommendation): ExtractionDecision {
  if (ai.recommendation === "include") return "include";
  if (ai.recommendation === "exclude") return "exclude";
  return "pending";
}

function buildAiReviewBatches(project: ProjectConfig, groups: ExtractionRuleGroup[], byId: Map<string, ExtractionCandidate>): ExtractionRuleGroup[][] {
  void project;
  const batches: ExtractionRuleGroup[][] = [];
  let current: ExtractionRuleGroup[] = [];
  let currentSampleRows = 0;
  for (const group of groups) {
    const groupSampleRows = countAiReviewSampleRows(group, byId);
    const wouldOverflowSamples = current.length > 0 && currentSampleRows + groupSampleRows > AI_REVIEW_MAX_BATCH_SAMPLE_ROWS;
    if (wouldOverflowSamples) {
      batches.push(current);
      current = [];
      currentSampleRows = 0;
    }
    current.push(group);
    currentSampleRows += groupSampleRows;
  }
  if (current.length) batches.push(current);
  return batches;
}

function countAiReviewSampleRows(group: ExtractionRuleGroup, byId: Map<string, ExtractionCandidate>): number {
  return group.sampleCandidateIds.filter((id) => byId.has(id)).length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
