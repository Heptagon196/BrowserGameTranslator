import crypto from "node:crypto";
import { chatCompletion } from "../aiProvider";
import type { ProjectService } from "../projectService";
import { projectPaths, readJson, readJsonl, writeJson, writeJsonl } from "../storage";
import type {
  AgentChatHistoryItem,
  AgentChatHistoryRepository,
  AgentCheckpoint,
  AgentContextMessage,
  AgentModelContext,
  ProviderConfig
} from "../../shared/types";

const AGENT_CONTEXT_RECENT_LIMIT = 24;
const AGENT_CONTEXT_RECENT_MAX_CHARS = 18000;
const AGENT_CONTEXT_AI_SUMMARY_MIN_MESSAGES = 8;
const AGENT_CONTEXT_AI_SUMMARY_MIN_CHARS = 6000;

type AgentChatHistoryLine = AgentChatHistoryItem & {
  createdAt: string;
};

export class AgentChatHistoryService {
  private writeQueue = Promise.resolve();

  constructor(private readonly projectService: ProjectService) {}

  async load(): Promise<AgentChatHistoryRepository> {
    const rows = await readJsonl<AgentChatHistoryLine>(projectPaths(this.projectService.project).aiChat);
    const byId = new Map<string, AgentChatHistoryItem>();
    const order: string[] = [];
    for (const row of rows) {
      const id = getHistoryMessageId(row.message);
      if (!id) continue;
      if (byId.has(id)) {
        const existingIndex = order.indexOf(id);
        if (existingIndex >= 0) order.splice(existingIndex, 1);
      }
      byId.set(id, { parentId: row.parentId ?? null, message: row.message });
      order.push(id);
    }
    const messages = order.slice(-160).map((id) => byId.get(id)).filter((item): item is AgentChatHistoryItem => Boolean(item));
    return {
      headId: getHistoryMessageId(messages.at(-1)?.message) ?? null,
      messages
    };
  }

  async append(item: AgentChatHistoryItem): Promise<void> {
    const id = getHistoryMessageId(item.message);
    if (!id) return;
    await this.enqueueWrite(async () => {
      const filePath = projectPaths(this.projectService.project).aiChat;
      const rows = await readJsonl<AgentChatHistoryLine>(filePath);
      const line: AgentChatHistoryLine = {
        parentId: item.parentId ?? null,
        message: item.message,
        createdAt: new Date().toISOString()
      };
      const compacted = compactAgentChatHistoryRows([...rows, line]);
      await writeJsonl(filePath, compacted);
      await this.writeModelContextFromHistory(compacted);
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      const paths = projectPaths(this.projectService.project);
      await Promise.all([
        writeJsonl(paths.aiChat, []),
        writeJson(paths.aiContext, emptyAgentModelContext()),
        writeJson(paths.agentCheckpoint, emptyAgentCheckpoint())
      ]);
    });
  }

  private async enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(work, work);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async writeModelContextFromHistory(rows: AgentChatHistoryLine[]): Promise<void> {
    const naturalMessages = rows
      .map((row) => toAgentContextMessage(row.message))
      .filter((message): message is AgentContextMessage => Boolean(message));
    const paths = projectPaths(this.projectService.project);
    const previousContext = await readJson<AgentModelContext>(paths.aiContext, emptyAgentModelContext());
    await writeJson(paths.aiContext, await this.compactModelContext(naturalMessages, previousContext));
  }

  private async compactModelContext(messages: AgentContextMessage[], previousContext: AgentModelContext): Promise<AgentModelContext> {
    const recent: AgentContextMessage[] = [];
    const older: AgentContextMessage[] = [];
    let chars = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const size = message.content.length;
      if (recent.length < AGENT_CONTEXT_RECENT_LIMIT && chars + size <= AGENT_CONTEXT_RECENT_MAX_CHARS) {
        recent.unshift(message);
        chars += size;
      } else {
        older.unshift(message);
      }
    }
    const summaryFingerprint = older.length ? hashAgentContextMessages(older) : "";
    const summary =
      !older.length
        ? ""
        : previousContext.summary && previousContext.summaryFingerprint === summaryFingerprint
          ? previousContext.summary
          : await this.summarizeOlderContext(older);
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      summary,
      summaryFingerprint,
      messages: recent
    };
  }

  private async summarizeOlderContext(messages: AgentContextMessage[]): Promise<string> {
    if (!messages.length) return "";
    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (messages.length >= AGENT_CONTEXT_AI_SUMMARY_MIN_MESSAGES || totalChars >= AGENT_CONTEXT_AI_SUMMARY_MIN_CHARS) {
      const aiSummary = await this.summarizeOlderContextWithAi(messages).catch((error) => {
        console.warn("[agent] failed to summarize context with AI", error);
        return "";
      });
      if (aiSummary.trim()) return aiSummary.trim();
    }
    const samples = messages.slice(-8).map((message) => `${message.role === "user" ? "用户" : "AI"}：${truncateInline(message.content, 180)}`);
    return `更早对话共 ${messages.length} 条。最近片段：\n${samples.join("\n")}`;
  }

  private async summarizeOlderContextWithAi(messages: AgentContextMessage[]): Promise<string> {
    const provider = await this.loadActiveChatProviderForContext();
    if (!provider?.apiKey?.trim()) return "";
    const content = formatAgentContextMessagesForSummary(messages);
    const response = await chatCompletion(provider, [
      {
        role: "system",
        content: [
          "你是 BrowserGameTranslator 的 AI 对话上下文压缩器。",
          "请把较早的用户与 AI 对话压缩成后续对话可直接使用的上下文摘要。",
          "重点保留：用户偏好、已确认的产品/UI/架构决策、当前项目状态、重要文件或表格信息、未完成事项、用户明确纠正过的问题。",
          "删除：寒暄、重复内容、工具调用日志、JSON 细节、无意义状态描述。",
          "用中文输出，结构清晰，控制在 1200 字以内。"
        ].join("\n")
      },
      {
        role: "user",
        content: `请总结以下较早对话：\n\n${content}`
      }
    ]);
    return response.trim();
  }

  private async loadActiveChatProviderForContext(): Promise<ProviderConfig | null> {
    const settings = await this.projectService.loadProviderSettings();
    const provider =
      settings.providers.find((entry) => entry.id === settings.activeChatProviderId) ??
      settings.providers.find((entry) => entry.id === settings.activeProviderId) ??
      null;
    return provider?.apiKey ? provider : null;
  }
}

export function emptyAgentModelContext(): AgentModelContext {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    summary: "",
    messages: []
  };
}

export function emptyAgentCheckpoint(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    status: "idle",
    toolCalls: []
  };
}

function getHistoryMessageId(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function compactAgentChatHistoryRows(rows: AgentChatHistoryLine[]): AgentChatHistoryLine[] {
  const byId = new Map<string, AgentChatHistoryLine>();
  const order: string[] = [];
  for (const row of rows) {
    const id = getHistoryMessageId(row.message);
    if (!id) continue;
    if (byId.has(id)) {
      const existingIndex = order.indexOf(id);
      if (existingIndex >= 0) order.splice(existingIndex, 1);
    }
    byId.set(id, row);
    order.push(id);
  }
  return order.map((id) => byId.get(id)).filter((row): row is AgentChatHistoryLine => Boolean(row));
}

function toAgentContextMessage(message: unknown): AgentContextMessage | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  const role = value.role;
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant" && !isCompletedAssistantMessage(value)) return null;
  const content = extractThreadMessageNaturalText(value);
  if (!content.trim()) return null;
  const id = typeof value.id === "string" ? value.id : undefined;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : undefined;
  return { id, role, content: truncateForStoredContext(content.trim(), 5000), createdAt };
}

function isCompletedAssistantMessage(message: Record<string, unknown>): boolean {
  const status = message.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return true;
  return (status as { type?: unknown }).type === "complete";
}

function extractThreadMessageNaturalText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const value = part as Record<string, unknown>;
      if ((value.type === "text" || value.type === "reasoning") && typeof value.text === "string") return value.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatAgentContextMessagesForSummary(messages: AgentContextMessage[]): string {
  return messages
    .map((message, index) => {
      const role = message.role === "user" ? "用户" : "AI";
      const time = message.createdAt ? ` (${message.createdAt})` : "";
      return `#${index + 1} ${role}${time}\n${truncateForStoredContext(message.content, 2200)}`;
    })
    .join("\n\n---\n\n")
    .slice(-30000);
}

function hashAgentContextMessages(messages: AgentContextMessage[]): string {
  const payload = messages.map((message) => [message.id ?? "", message.role, message.createdAt ?? "", message.content]).join("\n---\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function truncateForStoredContext(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[已截断 ${value.length - maxChars} 字符]` : value;
}

function truncateInline(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
