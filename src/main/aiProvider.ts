import { AnalysisResult, PromptConfig, ProofreadIssue, ProviderConfig, TextItem } from "../shared/types";
import { extractHtmlTags, extractPlaceholders } from "./textAnalysisUtils";

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

type AiMessage = { role: string; content: string };
export type AiProgramIo = { requestMessages: AiMessage[]; responseContent: string; title?: string };
type ChatBodyMessage = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  reasoning_content?: string;
};
export type AiToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type AiToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AiToolCompletion = {
  content: string;
  reasoningContent?: string;
  toolCalls: AiToolCall[];
};

export class AiResponseParseError extends Error {
  requestMessages: AiMessage[];
  responseContent: string;

  constructor(message: string, requestMessages: AiMessage[], responseContent: string, cause: unknown) {
    super(message);
    this.name = "AiResponseParseError";
    this.requestMessages = requestMessages;
    this.responseContent = responseContent;
    this.cause = cause;
  }
}

let usageRecorder: ((provider: ProviderConfig, usage: ChatUsage) => void) | null = null;

export function setAiUsageRecorder(recorder: (provider: ProviderConfig, usage: ChatUsage) => void): void {
  usageRecorder = recorder;
}

export async function testProvider(provider: ProviderConfig, prompts: PromptConfig): Promise<string> {
  const result = await chatCompletion(provider, [
    { role: "system", content: prompts.connectionTestSystem },
    { role: "user", content: "连接测试" }
  ]);
  return result.trim();
}

export async function analyzeWithProvider(provider: ProviderConfig, items: TextItem[], prompts: PromptConfig): Promise<AnalysisResult> {
  return (await analyzeWithProviderWithIo(provider, items, prompts)).result;
}

export async function translateAnalysisResourcesWithProviderWithIo(
  provider: ProviderConfig,
  analysis: AnalysisResult,
  sourceLanguage: string,
  targetLanguage: string,
  selection?: { table: "characters" | "glossary"; ids: string[] }
): Promise<{ result: AnalysisResult; translatedCount: number; requestMessages: AiMessage[]; responseContent: string }> {
  const selectedIds = selection ? new Set(selection.ids) : null;
  const matchesSelection = (table: "characters" | "glossary", id: string) => !selection || (selection.table === table && selectedIds?.has(id));
  const rows = [
    ...analysis.characters
      .filter((entry) => entry.enabled && entry.source.trim() && matchesSelection("characters", entry.id) && (selection || !entry.target.trim()))
      .map((entry) => ({
        table: "characters",
        id: entry.id,
        source: entry.source,
        familyName: entry.familyName ?? "",
        givenName: entry.givenName ?? "",
        note: entry.note
      })),
    ...analysis.glossary
      .filter((entry) => entry.enabled && entry.source.trim() && matchesSelection("glossary", entry.id) && (selection || !entry.target.trim()))
      .map((entry) => ({
        table: "glossary",
        id: entry.id,
        source: entry.source,
        category: entry.category,
        note: entry.note
      }))
  ];

  if (!rows.length) {
    return { result: analysis, translatedCount: 0, requestMessages: [], responseContent: "" };
  }

  const requestMessages = [
    {
      role: "system",
      content: [
        "你是一名专业的游戏本地化术语表翻译员。",
        `请将资源表条目的 source 从 ${sourceLanguage} 翻译为 ${targetLanguage}。`,
        "只补全 target 为空的条目，不要解释，不要输出 Markdown。",
        "保持专名、术语风格统一；无法确定时给出最自然、最短的译名。",
        "必须返回 JSON 数组，每项格式为：",
        "{\"table\":\"characters|glossary\",\"id\":\"原 id\",\"target\":\"译文\",\"familyNameTranslation\":\"可选\",\"givenNameTranslation\":\"可选\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({ rows }, null, 2)
    }
  ];

  const content = await chatCompletion(provider, requestMessages);
  let parsedRows: Array<Record<string, any>>;
  try {
    parsedRows = parseJsonArray(content);
  } catch (error) {
    throw new AiResponseParseError("AI 资源表补译返回的 JSON 无法解析。请在右侧后台查看原始回复。", requestMessages, content, error);
  }

  const byKey = new Map(parsedRows.map((row) => [`${String(row.table ?? "")}:${String(row.id ?? "")}`, row]));
  let translatedCount = 0;
  const result: AnalysisResult = {
    characters: analysis.characters.map((entry) => {
      const translated = byKey.get(`characters:${entry.id}`);
      const target = String(translated?.target ?? "").trim();
      if (!target || entry.target.trim()) return entry;
      translatedCount += 1;
      return {
        ...entry,
        target,
        familyNameTranslation: entry.familyNameTranslation || stringOrUndefined(translated?.familyNameTranslation),
        givenNameTranslation: entry.givenNameTranslation || stringOrUndefined(translated?.givenNameTranslation)
      };
    }),
    glossary: analysis.glossary.map((entry) => {
      const translated = byKey.get(`glossary:${entry.id}`);
      const target = String(translated?.target ?? "").trim();
      if (!target || entry.target.trim()) return entry;
      translatedCount += 1;
      return { ...entry, target };
    }),
    noTranslate: analysis.noTranslate
  };

  return { result, translatedCount, requestMessages, responseContent: content };
}

export async function analyzeWithProviderWithIo(provider: ProviderConfig, items: TextItem[], prompts: PromptConfig): Promise<{ result: AnalysisResult; requestMessages: AiMessage[]; responseContent: string }> {
  const sample = buildAnalysisSample(items);
  const requestMessages = [
    {
      role: "system",
      content: prompts.analysisSystem
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          characters: [{ source: "", target: "", familyName: "", familyNameTranslation: "", givenName: "", givenNameTranslation: "", nicknameOf: "", note: "" }],
          glossary: [{ source: "", target: "", note: "", category: "", isRegex: false }],
          noTranslate: [{ marker: "", note: "", isRegex: false }]
        },
        extractionRules: [
          "人物名、称号、地名、组织名、技能名、道具名、UI 固定文案都可以进入术语表。",
          "变量、控制代码、HTML 标签、占位符、文件路径、URL、格式化符号、脚本片段应进入禁翻表。"
        ],
        items: sample
      })
    }
  ];
  const content = await chatCompletion(provider, requestMessages);
  let parsed: Record<string, any>;
  try {
    parsed = parseAnalysisResponse(content);
  } catch (error) {
    throw new AiResponseParseError("AI 分析返回的 JSON 无法解析。请在右侧输入输出查看原始回复。", requestMessages, content, error);
  }
  const result = {
    characters: uniqueRows(parsed.characters ?? [], "source").map((entry: Record<string, unknown>, index: number) => ({
      id: `char_${String(index + 1).padStart(4, "0")}`,
      source: String(entry.source ?? ""),
      target: String(entry.target ?? ""),
      familyName: stringOrUndefined(entry.familyName),
      familyNameTranslation: stringOrUndefined(entry.familyNameTranslation),
      givenName: stringOrUndefined(entry.givenName),
      givenNameTranslation: stringOrUndefined(entry.givenNameTranslation),
      nicknameOf: stringOrUndefined(entry.nicknameOf),
      note: String(entry.note ?? ""),
      enabled: true
    })),
    glossary: uniqueRows(parsed.glossary ?? [], "source").map((entry: Record<string, unknown>, index: number) => ({
      id: `term_${String(index + 1).padStart(4, "0")}`,
      source: String(entry.source ?? ""),
      target: String(entry.target ?? ""),
      note: String(entry.note ?? ""),
      category: String(entry.category ?? "term"),
      isRegex: Boolean(entry.isRegex),
      enabled: true
    })),
    noTranslate: uniqueRows(parsed.noTranslate ?? [], "marker").map((entry: Record<string, unknown>, index: number) => ({
      id: `nt_${String(index + 1).padStart(4, "0")}`,
      marker: String(entry.marker ?? ""),
      note: String(entry.note ?? ""),
      isRegex: Boolean(entry.isRegex),
      enabled: true
    }))
  };
  return { result, requestMessages, responseContent: content };
}

export async function translateWithProvider(
  provider: ProviderConfig,
  items: TextItem[],
  sourceLanguage: string,
  targetLanguage: string,
  prompts: PromptConfig,
  analysis?: AnalysisResult,
  onIo?: (io: AiProgramIo) => void,
  options?: { force?: boolean; titlePrefix?: string }
): Promise<TextItem[]> {
  const activeItems = items.filter((item) => item.status !== "excluded" && (options?.force || !item.translation));
  const batches = chunk(activeItems, 20);
  const updated = new Map(items.map((item) => [item.id, item]));
  for (const [batchIndex, batch] of batches.entries()) {
    const systemPrompt = buildTranslationSystemPrompt(prompts, sourceLanguage, targetLanguage, batch, analysis);
    const userPrompt = buildTranslationUserPrompt(batch);
    const requestMessages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ];
    const content = await chatCompletion(provider, requestMessages);
    onIo?.({ title: `${options?.titlePrefix ?? "AI 翻译"}批次 ${batchIndex + 1}/${batches.length}`, requestMessages, responseContent: content });
    const rows = parseTranslatedRows(content, batch);
    for (const row of rows) {
      const item = updated.get(row.id);
      if (!item) continue;
      const translation = row.translation.trim();
      const validationIssues = validateTranslation(item, translation, analysis);
      updated.set(row.id, {
        ...item,
        translation,
        status: translation ? (validationIssues.length ? "needs_review" : "translated") : "failed"
      });
    }
  }
  return Array.from(updated.values());
}

type ProofreadJob = {
  id: string;
  original: string;
  translation: string;
  issues: Array<{ rule: string; message: string; severity: string }>;
};

export async function proofreadWithProviderWithIo(
  provider: ProviderConfig,
  items: TextItem[],
  issues: ProofreadIssue[],
  sourceLanguage: string,
  targetLanguage: string,
  prompts: PromptConfig,
  analysis?: AnalysisResult
): Promise<{ items: TextItem[]; updatedCount: number; requestMessages: Array<{ role: string; content: string }>; responseContent: string }> {
  const jobs = buildProofreadJobs(items, issues);
  if (!jobs.length) return { items, updatedCount: 0, requestMessages: [], responseContent: "" };
  const updated = new Map(items.map((item) => [item.id, item]));
  const requestMessages: Array<{ role: string; content: string }> = [];
  const responseParts: string[] = [];
  let updatedCount = 0;

  for (const batch of chunk(jobs, 20)) {
    const currentBatch = batch.map((job) => {
      const current = updated.get(job.id);
      return current ? { ...job, translation: current.translation } : job;
    });
    const messages = [
      { role: "system", content: renderProofreadSystemPrompt(prompts.proofreadSystem, sourceLanguage, targetLanguage) },
      { role: "user", content: buildProofreadUserPrompt(currentBatch, targetLanguage) }
    ];
    const content = await chatCompletion(provider, messages);
    requestMessages.push(...messages);
    responseParts.push(content);
    const rows = parseProofreadRows(content);
    for (const row of rows) {
      const item = updated.get(row.id);
      if (!item) continue;
      const translation = row.translation.trim();
      if (!translation) continue;
      const validationIssues = validateTranslation(item, translation, analysis);
      updated.set(row.id, {
        ...item,
        translation,
        status: validationIssues.length ? "needs_review" : "translated"
      });
      updatedCount += 1;
    }
  }

  return { items: Array.from(updated.values()), updatedCount, requestMessages, responseContent: responseParts.join("\n\n---\n\n") };
}

function buildProofreadJobs(items: TextItem[], issues: ProofreadIssue[]): ProofreadJob[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const jobs = new Map<string, ProofreadJob>();
  for (const issue of issues) {
    const item = byId.get(issue.textItemId);
    if (!item || item.status === "excluded") continue;
    const job = jobs.get(item.id) ?? {
      id: item.id,
      original: item.original,
      translation: item.translation,
      issues: []
    };
    job.issues.push({ rule: issue.rule, message: issue.message, severity: issue.severity });
    jobs.set(item.id, job);
  }
  return Array.from(jobs.values());
}

function renderProofreadSystemPrompt(template: string, sourceLanguage: string, targetLanguage: string): string {
  return template.replaceAll("{source_language}", sourceLanguage).replaceAll("{target_language}", targetLanguage);
}

function buildProofreadUserPrompt(jobs: ProofreadJob[], targetLanguage: string): string {
  return [
    `目标语言：${targetLanguage}`,
    "请校对以下条目，只返回 JSON 数组。",
    JSON.stringify(
      jobs.map((job) => ({
        id: job.id,
        issues: job.issues,
        original: job.original,
        currentTranslation: job.translation || "[空]"
      })),
      null,
      2
    )
  ].join("\n\n");
}

function parseProofreadRows(content: string): Array<{ id: string; translation: string }> {
  const json = extractJsonArray(content);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const value = row as Record<string, unknown>;
        const id = String(value.id ?? "").trim();
        const translation = String(value.translation ?? "").trim();
        return id && translation ? { id, translation } : null;
      })
      .filter((row): row is { id: string; translation: string } => Boolean(row));
  } catch {
    return [];
  }
}

function extractJsonArray(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? content;
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  return start >= 0 && end > start ? source.slice(start, end + 1) : null;
}

export async function chatCompletion(provider: ProviderConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  if (!provider.apiKey.trim()) throw new Error("API Key is required.");
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const body = createChatBody(provider, messages);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI request failed: ${response.status} ${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: ChatUsage };
  if (data.usage) usageRecorder?.(provider, data.usage);
  return data.choices?.[0]?.message?.content ?? "";
}

export async function chatCompletionWithTools(
  provider: ProviderConfig,
  messages: ChatBodyMessage[],
  tools: AiToolDefinition[]
): Promise<AiToolCompletion> {
  if (!provider.apiKey.trim()) throw new Error("API Key is required.");
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const body = createChatBody(provider, messages);
  body.tools = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} }
    }
  }));
  body.tool_choice = "auto";
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`AI request failed: ${response.status} ${bodyText.slice(0, 500)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: ChatUsage;
  };
  if (data.usage) usageRecorder?.(provider, data.usage);
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? "",
    reasoningContent: message?.reasoning_content,
    toolCalls: (message?.tool_calls ?? [])
      .map((call, index) => ({
        id: call.id || `tool_${Date.now()}_${index}`,
        name: call.function?.name ?? "",
        arguments: parseToolArguments(call.function?.arguments ?? "{}")
      }))
      .filter((call) => call.name)
  };
}

export async function chatCompletionWithToolsStream(
  provider: ProviderConfig,
  messages: ChatBodyMessage[],
  tools: AiToolDefinition[],
  onContentDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<AiToolCompletion> {
  if (!provider.apiKey.trim()) throw new Error("API Key is required.");
  throwIfAborted(signal);
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const body = createChatBody(provider, messages, true);
  body.tools = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} }
    }
  }));
  body.tool_choice = "auto";
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`AI request failed: ${response.status} ${bodyText.slice(0, 500)}`);
  }
  if (!response.body) return { content: "", toolCalls: [] };

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  const toolCallParts = new Map<number, { id: string; name: string; argumentsText: string }>();
  let currentToolCallIndex = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        throwIfAborted(signal);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            message?: { content?: string | null };
          }>;
          usage?: ChatUsage;
        };
        if (parsed.usage) usageRecorder?.(provider, parsed.usage);
        const delta = parsed.choices?.[0]?.delta;
        const contentDelta = delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
        if (contentDelta) {
          content += contentDelta;
          onContentDelta(contentDelta);
        }
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content;
        }
        for (const toolDelta of delta?.tool_calls ?? []) {
          const index = typeof toolDelta.index === "number" ? toolDelta.index : currentToolCallIndex;
          currentToolCallIndex = index;
          const current = toolCallParts.get(index) ?? { id: "", name: "", argumentsText: "" };
          toolCallParts.set(index, {
            id: toolDelta.id ?? current.id,
            name: toolDelta.function?.name ?? current.name,
            argumentsText: current.argumentsText + (toolDelta.function?.arguments ?? "")
          });
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  return {
    content,
    reasoningContent: reasoningContent || undefined,
    toolCalls: Array.from(toolCallParts.values())
      .map((call, index) => ({
        id: call.id || `tool_${Date.now()}_${index}`,
        name: call.name,
        arguments: parseToolArguments(call.argumentsText || "{}")
      }))
      .filter((call) => call.name)
  };
}

export async function chatCompletionStream(
  provider: ProviderConfig,
  messages: Array<{ role: string; content: string }>,
  onDelta: (delta: string) => void
): Promise<string> {
  if (!provider.apiKey.trim()) throw new Error("API Key is required.");
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const body = createChatBody(provider, messages, true);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI request failed: ${response.status} ${body.slice(0, 500)}`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>; usage?: ChatUsage };
      if (parsed.usage) usageRecorder?.(provider, parsed.usage);
      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (!delta) continue;
      output += delta;
      onDelta(delta);
    }
  }
  return output;
}

function createChatBody(provider: ProviderConfig, messages: ChatBodyMessage[], stream = false): Record<string, unknown> {
  const modelSettings = provider.modelSettings?.[provider.model] ?? {};
  const body: Record<string, unknown> = {
    model: provider.model,
    temperature: modelSettings.temperature ?? provider.temperature,
    max_tokens: modelSettings.maxOutputTokens ?? provider.maxOutputTokens,
    messages: normalizeChatMessages(provider, messages)
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (provider.type === "deepseek") {
    body.thinking = {
      type: (modelSettings.thinkingEnabled ?? provider.thinkingEnabled) === false ? "disabled" : "enabled",
      reasoning_effort: (modelSettings.reasoningEffort ?? provider.reasoningEffort) === "max" ? "max" : "high"
    };
  } else if (provider.type === "openai" && supportsOpenAiReasoning(provider.model)) {
    body.reasoning_effort = (modelSettings.thinkingEnabled ?? provider.thinkingEnabled) === false ? "none" : normalizeOpenAiReasoningEffort(modelSettings.reasoningEffort ?? provider.reasoningEffort);
  }
  return body;
}

function normalizeChatMessages(provider: ProviderConfig, messages: ChatBodyMessage[]): ChatBodyMessage[] {
  return messages.map((message) => {
    const normalized: ChatBodyMessage = {
      role: message.role,
      content: message.content
    };
    if (message.tool_call_id) {
      normalized.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls) {
      normalized.tool_calls = message.tool_calls;
    }
    if (provider.type === "deepseek" && message.reasoning_content) {
      normalized.reasoning_content = message.reasoning_content;
    }
    return normalized;
  });
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (Array.isArray(parsed)) return { updates: parsed };
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error("AGENT_RUN_CANCELLED");
}

function supportsOpenAiReasoning(model: string): boolean {
  return /^(gpt-5|o\d|o[1-9]|o[1-9]-|o[1-9a-z.-]*|gpt-oss)/i.test(model);
}

function normalizeOpenAiReasoningEffort(value: ProviderConfig["reasoningEffort"]): string {
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(value))) return String(value);
  if (value === "max") return "xhigh";
  return "medium";
}

export function parseJsonObject(content: string): Record<string, any> {
  const cleaned = stripCodeFence(content);
  return parseJsonWithRepair(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as Record<string, any>;
}

function parseJsonArray(content: string): Array<Record<string, any>> {
  const cleaned = stripCodeFence(content);
  return parseJsonWithRepair(cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)) as Array<Record<string, any>>;
}

function stripCodeFence(content: string): string {
  return content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function parseAnalysisResponse(content: string): Record<string, any> {
  try {
    return parseJsonObject(content);
  } catch (error) {
    const cleaned = stripCodeFence(content);
    const characters = parseLooseNamedArray(cleaned, "characters");
    const glossary = parseLooseNamedArray(cleaned, "glossary");
    const noTranslate = parseLooseNamedArray(cleaned, "noTranslate");
    if (characters.length || glossary.length || noTranslate.length) return { characters, glossary, noTranslate };
    throw error;
  }
}

function parseJsonWithRepair(jsonText: string): unknown {
  const candidates = [jsonText, repairJsonText(jsonText)];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function repairJsonText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/}\s*{/g, "},{")
    .replace(/]\s*"/g, "],\"")
    .replace(/"\s*\n\s*"/g, "\",\n\"");
}

function parseLooseNamedArray(content: string, key: string): Array<Record<string, unknown>> {
  const body = extractNamedArrayBody(content, key);
  if (!body) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const objectText of extractObjectTexts(body)) {
    const normalized = objectText;
    try {
      const parsed = parseJsonWithRepair(normalized);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      // Skip malformed individual rows instead of failing the whole analysis.
    }
  }
  return rows;
}

function extractNamedArrayBody(content: string, key: string): string | null {
  const keyIndex = content.search(new RegExp(`"${key}"\\s*:`));
  if (keyIndex < 0) return null;
  const start = content.indexOf("[", keyIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return content.slice(start + 1, index);
    }
  }
  return null;
}

function extractObjectTexts(content: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value ?? "");
  return text ? text : undefined;
}

function buildAnalysisSample(items: TextItem[]): Array<{ id: string; text: string; file: string; before?: string; after?: string }> {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const normalized = item.original.replace(/\s+/g, " ").trim();
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .sort((a, b) => scoreForAnalysis(b) - scoreForAnalysis(a))
    .slice(0, 500)
    .map((item) => ({ id: item.id, text: item.original, file: item.sourceFile, before: item.context.before, after: item.context.after }));
}

function scoreForAnalysis(item: TextItem): number {
  let score = Math.min(item.original.length, 240);
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(item.original)) score += 80;
  if (/[%$][\w\d]+|\\[A-Za-z]+\[|<[^>]+>|\{[^}]+\}/.test(item.original)) score += 60;
  if (item.context.before || item.context.after) score += 20;
  return score;
}

function uniqueRows(rows: unknown, identityKey: string): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const output: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const identity = String(record[identityKey] ?? "").trim();
    if (!identity || seen.has(identity.toLowerCase())) continue;
    seen.add(identity.toLowerCase());
    output.push(record);
  }
  return output;
}

function renderTranslationSystemPrompt(template: string, sourceLanguage: string, targetLanguage: string): string {
  const sourceName = languageName(sourceLanguage);
  const targetName = languageName(targetLanguage);
  return template
    .replaceAll("{source_language}", sourceName)
    .replaceAll("{target_language}", targetName)
    .trim();
}

function buildTranslationSystemPrompt(prompts: PromptConfig, sourceLanguage: string, targetLanguage: string, batch: TextItem[], analysis?: AnalysisResult): string {
  return [
    renderTranslationSystemPrompt(prompts.translationSystem, sourceLanguage, targetLanguage),
    buildResourceSections(batch, analysis),
    buildUserRulesSection(prompts.translationRules)
  ].filter(Boolean).join("\n\n").trim();
}

function buildTranslationUserPrompt(batch: TextItem[]): string {
  const lines = [
    "###这是你接下来的翻译任务，原文文本如下",
    "###原文",
    "<textarea>",
    ...formatSourceTextarea(batch),
    "</textarea>"
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function languageName(value: string): string {
  const names: Record<string, string> = {
    en: "英语",
    ja: "日语",
    "zh-CN": "简体中文",
    "zh-TW": "繁体中文",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    ru: "俄语"
  };
  return names[value] ?? value;
}

function buildResourceSections(batch: TextItem[], analysis?: AnalysisResult): string {
  if (!analysis) return "";
  const sourceText = batch.map((item) => item.original).join("\n");
  const sections: string[] = [];
  const characters = analysis.characters.filter((entry) => entry.enabled && entry.source && matchesSource(sourceText, entry.source, false));
  if (characters.length) {
    sections.push(
      [
        "###角色表",
        "原文|译文|备注",
        ...characters.slice(0, 80).map((entry) => `${entry.source}|${entry.target || "待定"}|${entry.note}`)
      ].join("\n")
    );
  }
  const terms = analysis.glossary.filter((entry) => entry.enabled && entry.source && matchesSource(sourceText, entry.source, entry.isRegex));
  if (terms.length) {
    sections.push(
      [
        "###术语表",
        "原文|译文|备注",
        ...terms.slice(0, 120).map((entry) => `${entry.source}|${entry.target || "待定"}|${entry.note || entry.category}`)
      ].join("\n")
    );
  }
  const noTranslate = analysis.noTranslate.filter((entry) => entry.enabled && entry.marker && matchesSource(sourceText, entry.marker, entry.isRegex));
  if (noTranslate.length) {
    sections.push(
      [
        "###禁翻表，以下特殊标记符无须翻译",
        "特殊标记符|备注",
        ...noTranslate.slice(0, 160).map((entry) => `${entry.marker}|${entry.note}`)
      ].join("\n")
    );
  }
  return sections.join("\n\n");
}

function buildUserRulesSection(rules: string[]): string {
  const activeRules = rules.map((rule) => rule.trim()).filter(Boolean);
  if (!activeRules.length) return "";
  return ["###用户规则", ...activeRules.map((rule, index) => `${index + 1}.${rule}`)].join("\n");
}

function formatSourceTextarea(batch: TextItem[]): string[] {
  return batch.map((item, index) => {
    const lineNumber = index + 1;
    if (!item.original.includes("\n")) return `${lineNumber}.${item.original}`;
    const lines = item.original.split("\n");
    const body = lines.map((line, lineIndex) => `"${lineNumber}.${lines.length - lineIndex}.,${line.replaceAll('"', '\\"')}",`).join("\n").replace(/,$/, "");
    return `${lineNumber}.[\n${body}\n]`;
  });
}

function parseTranslatedRows(content: string, batch: TextItem[]): Array<{ id: string; translation: string }> {
  try {
    return parseJsonArray(content).map((row) => ({ id: String(row.id ?? ""), translation: String(row.translation ?? "") })).filter((row) => row.id);
  } catch {
    const textarea = extractTextarea(content);
    return parseTextareaRows(textarea, batch);
  }
}

function extractTextarea(content: string): string {
  const match = content.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  return (match?.[1] ?? content).trim();
}

function parseTextareaRows(textarea: string, batch: TextItem[]): Array<{ id: string; translation: string }> {
  const lines = textarea.split(/\r?\n/);
  const byNumber = new Map<number, string[]>();
  let currentNumber: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const multiStart = line.match(/^(\d+)\.\[$/);
    if (multiStart) {
      currentNumber = Number(multiStart[1]);
      byNumber.set(currentNumber, []);
      continue;
    }
    if (currentNumber !== null) {
      if (line.trim() === "]") {
        currentNumber = null;
        continue;
      }
      const content = line.replace(/^\s*"?\d+\.\d+\.,/, "").replace(/",?\s*$/, "").replace(/\\"/g, '"');
      byNumber.get(currentNumber)?.push(content);
      continue;
    }
    const single = line.match(/^(\d+)\.(.*)$/);
    if (!single) continue;
    byNumber.set(Number(single[1]), [single[2]]);
  }

  return batch.map((item, index) => ({ id: item.id, translation: (byNumber.get(index + 1) ?? [""]).join("\n").trim() }));
}

function validateTranslation(item: TextItem, translation: string, analysis?: AnalysisResult): string[] {
  const issues: string[] = [];
  if (!translation) issues.push("empty");
  if (newlineCount(item.original) !== newlineCount(translation)) issues.push("newline");
  for (const token of [...extractPlaceholders(item.original), ...extractHtmlTags(item.original)]) {
    if (token && !translation.includes(token)) issues.push(`missing:${token}`);
  }
  if (/\d+\.\d+\./.test(translation)) issues.push("numbering_residue");
  if (analysis) {
    for (const entry of analysis.noTranslate.filter((row) => row.enabled)) {
      for (const marker of findMatches(item.original, entry.marker, entry.isRegex)) {
        if (marker && !translation.includes(marker)) issues.push(`no_translate:${marker}`);
      }
    }
  }
  return issues;
}

function newlineCount(value: string): number {
  const trimmed = value.trim();
  return (trimmed.match(/\n/g) ?? []).length + (trimmed.match(/\\n/g) ?? []).length;
}

function matchesSource(sourceText: string, needle: string, isRegex: boolean): boolean {
  if (!needle) return false;
  if (!isRegex) return sourceText.toLowerCase().includes(needle.toLowerCase());
  try {
    return new RegExp(needle, "i").test(sourceText);
  } catch {
    return false;
  }
}

function findMatches(value: string, marker: string, isRegex: boolean): string[] {
  if (!marker) return [];
  if (!isRegex) return value.includes(marker) ? [marker] : [];
  try {
    return Array.from(new Set(value.match(new RegExp(marker, "g")) ?? []));
  } catch {
    return [];
  }
}
