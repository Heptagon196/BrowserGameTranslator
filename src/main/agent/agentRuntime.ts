import { chatCompletion, chatCompletionWithToolsStream, parseJsonObject } from "../aiProvider";
import type { AiToolCall } from "../aiProvider";
import { agentToolDefinitions, evaluateAgentToolPolicy, executeAgentTool, projectTableInfos } from "./agentTools";
import type { ProjectService } from "../projectService";
import { projectPaths, readJson, writeJson } from "../storage";
import type { AgentCheckpoint, AgentModelContext, AgentRunRequest, AgentRunResult, AgentTaskPlan, AgentTaskPlanItem, AgentTaskStatus, AiPermissionMode } from "../../shared/types";

type AgUiInput = {
  messages?: AgUiMessage[];
  context?: Array<{ description?: string; value?: string }>;
  forwardedProps?: Record<string, unknown>;
};

type AgUiMessage = {
  role?: string;
  content?: unknown;
  parts?: Array<{ type?: string; text?: string }>;
  toolCallId?: string;
  toolCalls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type AgentEvent = Record<string, unknown> & { type: string };

type AgentTaskPlanDraft = {
  needsLookup: boolean;
  needsMutation: boolean;
  needsUserApproval: boolean;
  doneCriteria: string;
  reason?: string;
};

type AgentCompletionState = "completed" | "blocked" | "needs_user" | "needs_action";

const MAX_AGENT_STEPS = 8;
const MAX_CONTEXT_MESSAGES = 28;
const MAX_CONTEXT_CHARS = 24000;
const MAX_MESSAGE_CHARS = 3500;
const MAX_TOOL_RESULT_CHARS = 1400;
const pendingReasoningByToolCallId = new Map<string, string>();

export async function runAgent(projectService: ProjectService, request: AgentRunRequest, onEvent?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentRunResult> {
  const input = normalizeAgUiInput(request.input);
  const events: AgentEvent[] = [];
  let eventSequence = 0;
  const permissionMode = request.permissionMode ?? "workspace";
  const clientRunId = (request as AgentRunRequest & { clientRunId?: unknown }).clientRunId;
  const runId = typeof clientRunId === "string" ? clientRunId : `agent_run_${Date.now()}`;
  const emit = (event: AgentEvent) => {
    const sequencedEvent = { ...event, sequence: eventSequence };
    eventSequence += 1;
    events.push(sequencedEvent);
    onEvent?.(sequencedEvent);
  };
  const finishRun = () => emit({ type: "RUN_FINISHED", runId });
  const inputModelMessages = toModelMessages(input.messages ?? []);
  const projectContext = await buildProjectContextLine(projectService);
  let taskPlan = await loadOrCreateAgentTaskPlan(projectService, request, runId, inputModelMessages, projectContext);
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(input, request, projectContext)
    },
    taskPlanMessage(taskPlan),
    ...buildModelContext(await buildAgentContextMessages(projectService, inputModelMessages))
  ];
  const syncTaskPlanMessage = () => {
    messages[1] = taskPlanMessage(taskPlan);
  };

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      throwIfAborted(signal);
      const messageId = `agent_${Date.now()}_${step}`;
      let textStarted = false;
      const completion = await chatCompletionWithToolsStream(request.provider, messages, agentToolDefinitions, (delta) => {
        throwIfAborted(signal);
        if (!textStarted) {
          emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          textStarted = true;
        }
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
      }, signal);
      throwIfAborted(signal);

      if (textStarted) {
        emit({ type: "TEXT_MESSAGE_END", messageId });
      }

      const toolCalls = coalesceApprovalToolCalls(completion.toolCalls);
      const reconciledTaskPlan = reconcileTaskPlanWithToolMessages(taskPlan, messages);
      if (reconciledTaskPlan !== taskPlan) {
        taskPlan = reconciledTaskPlan;
        syncTaskPlanMessage();
        await writeAgentTaskPlan(projectService, taskPlan);
      }

      if (toolCalls.length === 0) {
        const shouldContinue = await shouldContinueAfterNoToolCalls(request, completion.content, taskPlan, messages);
        if (shouldContinue) {
          if (completion.content.trim()) {
            messages.push({ role: "assistant", content: completion.content });
          }
          messages.push({
            role: "system",
            content: continuationInstruction(taskPlan, completion.content)
          });
          taskPlan = markTaskPlanContinuation(taskPlan, "模型没有继续调用工具，但任务计划仍有未完成步骤。");
          syncTaskPlanMessage();
          await writeAgentTaskPlan(projectService, taskPlan);
          continue;
        }
        if (!completion.content.trim()) {
          emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "已完成。" });
          emit({ type: "TEXT_MESSAGE_END", messageId });
        }
        taskPlan = markTaskPlanCompleted(taskPlan, completion.content.trim() ? "模型给出了最终回复。" : "模型返回空内容，运行器按无未完成任务结束。");
        syncTaskPlanMessage();
        await writeAgentTaskPlan(projectService, taskPlan);
        await clearAgentCheckpoint(projectService);
        finishRun();
        return { events };
      }

      messages.push({
        role: "assistant",
        content: completion.content,
        reasoning_content: completion.reasoningContent,
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments)
          }
        }))
      });

      const pendingApprovalToolCalls: AiToolCall[] = [];
      for (const toolCall of toolCalls) {
        throwIfAborted(signal);
        const argsJson = JSON.stringify(toolCall.arguments);
        emit({
          type: "TOOL_CALL_START",
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          parentMessageId: messageId
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: toolCall.id, delta: argsJson });
        emit({ type: "TOOL_CALL_END", toolCallId: toolCall.id });

        const policy = evaluateAgentToolPolicy(projectService, toolCall.name, toolCall.arguments, permissionMode);
        if (!policy.allowed) {
          const result = { tool: toolCall.name, ok: false, denied: true, error: policy.reason ?? "当前权限模式不允许执行该操作。" };
          const content = JSON.stringify(result);
          emit({
            type: "TOOL_CALL_RESULT",
            messageId: `tool_${toolCall.id}`,
            toolCallId: toolCall.id,
            content,
            role: "tool"
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content
          });
          continue;
        }

        if (policy.requiresApproval) {
          if (completion.reasoningContent) {
            pendingReasoningByToolCallId.set(toolCall.id, completion.reasoningContent);
          }
          pendingApprovalToolCalls.push(toolCall);
          continue;
        }

        const result = await executeAgentTool(projectService, toolCall.name, toolCall.arguments, { permissionMode, approved: true });
        throwIfAborted(signal);
        const content = JSON.stringify(result);
        emit({
          type: "TOOL_CALL_RESULT",
          messageId: `tool_${toolCall.id}`,
          toolCallId: toolCall.id,
          content,
          role: "tool"
        });
        pendingReasoningByToolCallId.delete(toolCall.id);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content
        });
        taskPlan = await recordToolResultAndMergeTaskPlan(projectService, taskPlan, toolCall.name, result);
        syncTaskPlanMessage();
      }

      if (pendingApprovalToolCalls.length) {
        await writeAgentCheckpoint(projectService, {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          status: "pending_approval",
          runId,
          parentMessageId: messageId,
          messages,
          toolCalls: pendingApprovalToolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments,
            reasoningContent: completion.reasoningContent
          }))
        });
        finishRun();
        return { events };
      }
    }

    const messageId = `agent_${Date.now()}_limit`;
    emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    emit({
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: "工具调用次数已达到上限。请缩小问题范围，或让我继续处理下一批。"
    });
    emit({ type: "TEXT_MESSAGE_END", messageId });
    await clearAgentCheckpoint(projectService);
    taskPlan = markTaskPlanContinuation(taskPlan, "工具调用次数达到上限，需要用户确认是否继续。");
    syncTaskPlanMessage();
    await writeAgentTaskPlan(projectService, taskPlan);
    finishRun();
    return { events };
  } catch (error) {
    if (isAgentRunCancelled(error) || signal?.aborted) {
      pendingReasoningByToolCallId.clear();
      await clearAgentCheckpoint(projectService);
      emit({ type: "RUN_CANCELLED", runId });
      return { events };
    }
    throw error;
  }
}

export async function recordAgentToolResultInTaskPlan(projectService: ProjectService, toolName: string, result: Record<string, unknown>): Promise<void> {
  const taskPlan = await readAgentTaskPlan(projectService);
  if (!taskPlan.items.length) return;
  await recordToolResultAndMergeTaskPlan(projectService, taskPlan, toolName, result);
}

async function recordToolResultAndMergeTaskPlan(
  projectService: ProjectService,
  taskPlan: AgentTaskPlan,
  toolName: string,
  result: Record<string, unknown>
): Promise<AgentTaskPlan> {
  const latest = await readAgentTaskPlan(projectService);
  const base = sameGoal(latest.userGoal, taskPlan.userGoal) ? mergeTaskPlanProgress(taskPlan, latest) : taskPlan;
  const updated = updateTaskPlanAfterToolResult(base, toolName, result);
  await writeAgentTaskPlan(projectService, updated);
  return updated;
}

function coalesceApprovalToolCalls(toolCalls: AiToolCall[]): AiToolCall[] {
  const output: AiToolCall[] = [];
  const updatesByTable = new Map<string, AiToolCall[]>();
  const deletesByTable = new Map<string, AiToolCall[]>();

  for (const toolCall of toolCalls) {
    if (toolCall.name === "table_update") {
      const table = typeof toolCall.arguments.table === "string" ? toolCall.arguments.table : "project.text";
      if (table) {
        const rows = updatesByTable.get(table) ?? [];
        rows.push(toolCall);
        updatesByTable.set(table, rows);
        continue;
      }
    }
    if (toolCall.name === "table_delete") {
      const table = typeof toolCall.arguments.table === "string" ? toolCall.arguments.table : "project.text";
      if (table) {
        const rows = deletesByTable.get(table) ?? [];
        rows.push(toolCall);
        deletesByTable.set(table, rows);
        continue;
      }
    }
    output.push(toolCall);
  }

  for (const [table, updates] of updatesByTable) {
    if (updates.length === 1) {
      output.push(updates[0]);
      continue;
    }
    output.push({
      id: `tool_table_update_${table}_${Date.now()}`,
      name: "table_update",
      arguments: {
        table,
        updates: updates.map((toolCall) => ({
          id: toolCall.arguments.id,
          patch: toolCall.arguments.patch
        }))
      }
    });
  }

  for (const [table, deletes] of deletesByTable) {
    if (deletes.length === 1) {
      output.push(deletes[0]);
      continue;
    }
    output.push({
      id: `tool_table_delete_${table}_${Date.now()}`,
      name: "table_delete",
      arguments: {
        table,
        ids: deletes.map((toolCall) => toolCall.arguments.id)
      }
    });
  }

  return output;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error("AGENT_RUN_CANCELLED");
}

function isAgentRunCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AGENT_RUN_CANCELLED") || message.includes("AbortError") || message.includes("aborted") || message.includes("cancelled");
}

async function writeAgentCheckpoint(projectService: ProjectService, checkpoint: AgentCheckpoint): Promise<void> {
  await writeJson(projectPaths(projectService.project).agentCheckpoint, checkpoint);
}

async function clearAgentCheckpoint(projectService: ProjectService): Promise<void> {
  await writeAgentCheckpoint(projectService, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    status: "idle",
    toolCalls: []
  });
}

async function readAgentTaskPlan(projectService: ProjectService): Promise<AgentTaskPlan> {
  return readJson<AgentTaskPlan>(projectPaths(projectService.project).agentTaskPlan, emptyAgentTaskPlan());
}

async function writeAgentTaskPlan(projectService: ProjectService, taskPlan: AgentTaskPlan): Promise<void> {
  await writeJson(projectPaths(projectService.project).agentTaskPlan, taskPlan);
}

async function loadOrCreateAgentTaskPlan(projectService: ProjectService, request: AgentRunRequest, runId: string, inputMessages: ModelMessage[], projectContext: string): Promise<AgentTaskPlan> {
  const existing = await readAgentTaskPlan(projectService);
  const latestUserGoal = latestUserMessage(inputMessages);
  if (hasOpenTaskItems(existing) && (!latestUserGoal || sameGoal(existing.userGoal, latestUserGoal))) {
    return { ...existing, runId, updatedAt: new Date().toISOString() };
  }
  if (!latestUserGoal) return { ...emptyAgentTaskPlan(), runId, updatedAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const draft = await planAgentTaskWithModel(request, latestUserGoal, projectContext).catch(() => fallbackTaskPlanDraft(latestUserGoal));
  const items = taskPlanItemsFromDraft(draft, now);
  return {
    schemaVersion: 1,
    updatedAt: now,
    runId,
    userGoal: latestUserGoal,
    needsLookup: draft.needsLookup,
    needsMutation: draft.needsMutation,
    needsUserApproval: draft.needsUserApproval,
    doneCriteria: draft.doneCriteria,
    plannerSource: draft.reason === "fallback" ? "fallback" : "model",
    items
  };
}

function emptyAgentTaskPlan(): AgentTaskPlan {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    userGoal: "",
    needsLookup: false,
    needsMutation: false,
    needsUserApproval: false,
    doneCriteria: "",
    plannerSource: "fallback",
    items: []
  };
}

function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user" && message.content.trim() && !isInternalContinuationPrompt(message.content))?.content.trim() ?? "";
}

function sameGoal(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function isInternalContinuationPrompt(content: string): boolean {
  return content.trim().startsWith("内部续行提示：");
}

async function planAgentTaskWithModel(request: AgentRunRequest, userGoal: string, projectContext: string): Promise<AgentTaskPlanDraft> {
  const contextLines = [
    projectContext,
    request.context?.currentView ? `当前页面：${request.context.currentView}` : "",
    request.context?.currentTableId ? `当前表：${request.context.currentTableId}（${request.context.currentTableDescription ?? ""}）` : ""
  ].filter(Boolean).join("\n");
  const content = await chatCompletion(request.provider, [
    {
      role: "system",
      content: [
        "你是 Agent 运行器的内部任务规划器，只返回 JSON，不要输出解释。",
        "判断用户这条消息是否需要查询项目数据、是否需要修改项目数据、是否需要先取得用户确认，以及完成标准。",
        "不要把“检查、看看、发现问题、分析原因、指出问题”误判为必须修改。",
        "只有用户明确要求改、写入、替换、删除、修复、补译、重翻、批量执行，或说“直接改/不用确认直接改”时，needsMutation 才为 true。",
        "如果用户只是问问题或要求诊断，needsMutation 必须为 false。",
        "输出 schema：{\"needsLookup\":boolean,\"needsMutation\":boolean,\"needsUserApproval\":boolean,\"doneCriteria\":\"一句话完成标准\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({ userGoal, context: contextLines }, null, 2)
    }
  ]);
  const parsed = parseJsonObject(content);
  return normalizeTaskPlanDraft(parsed, userGoal);
}

function normalizeTaskPlanDraft(value: Record<string, unknown>, userGoal: string): AgentTaskPlanDraft {
  return {
    needsLookup: typeof value.needsLookup === "boolean" ? value.needsLookup : looksLikeNeedsLookup(userGoal),
    needsMutation: typeof value.needsMutation === "boolean" ? value.needsMutation : looksLikeMutationGoal(userGoal),
    needsUserApproval: typeof value.needsUserApproval === "boolean" ? value.needsUserApproval : false,
    doneCriteria: typeof value.doneCriteria === "string" && value.doneCriteria.trim() ? value.doneCriteria.trim().slice(0, 400) : "完成用户请求并报告结果。"
  };
}

function fallbackTaskPlanDraft(goal: string): AgentTaskPlanDraft {
  return {
    needsLookup: looksLikeNeedsLookup(goal),
    needsMutation: looksLikeMutationGoal(goal),
    needsUserApproval: false,
    doneCriteria: "完成用户请求并报告结果。",
    reason: "fallback"
  };
}

function taskPlanItemsFromDraft(draft: AgentTaskPlanDraft, now: string): AgentTaskPlanItem[] {
  const items: AgentTaskPlanItem[] = [];
  if (draft.needsLookup) {
    items.push(makeTaskPlanItem("lookup", "查询完成任务所需的项目数据或文件内容", "pending", now));
  }
  if (draft.needsMutation) {
    items.push(makeTaskPlanItem("mutate", "执行用户要求的修改、替换、删除、写入或校对操作", "pending", now));
  }
  items.push(makeTaskPlanItem("respond", "向用户报告执行结果和未完成原因", "pending", now));
  return items;
}

function makeTaskPlanItem(id: string, description: string, status: AgentTaskPlanItem["status"], updatedAt: string, evidence?: string): AgentTaskPlanItem {
  return { id, description, status, updatedAt, evidence };
}

function looksLikeNeedsLookup(goal: string): boolean {
  return /查|找|搜索|定位|读取|看|列出|统计|检查|校对|翻译|替换|修改|删除|写入|保存|打开|分析|extract|search|find|read|list|check|replace|update|delete|write|save/i.test(goal);
}

function looksLikeMutationGoal(goal: string): boolean {
  return /改|修改|替换|删除|写入|保存|加入|添加|更新|修复|批量|执行|直接.*(改|修|替换|写入|保存)|把.+(改成|换成|替换为|译为|翻成)|补译|重翻|apply|replace|update|delete|write|save|add|fix/i.test(goal);
}

function hasOpenTaskItems(taskPlan: AgentTaskPlan): boolean {
  return taskPlan.items.some((item) => item.status === "pending" || item.status === "running");
}

function hasOpenActionTask(taskPlan: AgentTaskPlan, id: "lookup" | "mutate"): boolean {
  return taskPlan.items.some((item) => item.id === id && (item.status === "pending" || item.status === "running"));
}

function taskPlanMessage(taskPlan: AgentTaskPlan): ModelMessage {
  return {
    role: "system",
    content: [
      "持久化任务计划（运行器维护，不是普通聊天建议）：",
      taskPlan.userGoal ? `用户目标：${taskPlan.userGoal}` : "用户目标：[未记录]",
      `规划来源：${taskPlan.plannerSource ?? "fallback"}`,
      `结构化意图：needsLookup=${Boolean(taskPlan.needsLookup)}, needsMutation=${Boolean(taskPlan.needsMutation)}, needsUserApproval=${Boolean(taskPlan.needsUserApproval)}`,
      taskPlan.doneCriteria ? `完成标准：${taskPlan.doneCriteria}` : "完成标准：完成用户请求并报告结果。",
      ...taskPlan.items.map((item) => `- ${item.id}: ${item.status} - ${item.description}${item.evidence ? `（${item.evidence}）` : ""}`),
      "如果存在 pending/running 的 lookup 或 mutate 项，不能只说将要执行；必须继续调用合适工具，或明确说明阻塞原因。",
      "如果只剩 respond 项，当前非空回复就是对用户的报告；不要擅自开始计划外的新任务。"
    ].join("\n")
  };
}

async function shouldContinueAfterNoToolCalls(request: AgentRunRequest, content: string, taskPlan: AgentTaskPlan, messages: ModelMessage[]): Promise<boolean> {
  if (!hasOpenTaskItems(taskPlan)) return false;
  if (!content.trim()) return true;
  const pendingLookup = hasOpenActionTask(taskPlan, "lookup");
  const pendingMutation = hasOpenActionTask(taskPlan, "mutate");
  if (!pendingLookup && !pendingMutation) return false;
  const state = await classifyAgentCompletionState(request, content, taskPlan, messages).catch(() => fallbackCompletionState(content, pendingLookup, pendingMutation));
  if (pendingMutation) {
    return state !== "blocked" && state !== "needs_user";
  }
  return state === "needs_action";
}

async function classifyAgentCompletionState(request: AgentRunRequest, assistantContent: string, taskPlan: AgentTaskPlan, messages: ModelMessage[]): Promise<AgentCompletionState> {
  const recentToolMessages = messages
    .filter((message) => message.role === "tool")
    .slice(-4)
    .map((message) => message.content.slice(0, 1000));
  const content = await chatCompletion(request.provider, [
    {
      role: "system",
      content: [
        "你是 Agent 运行器的内部完成状态分类器，只返回 JSON，不要输出解释。",
        "根据任务计划、最近工具结果和助手当前回复，判断当前 run 应该结束还是继续。",
        "state 只能是：",
        "- completed：已经满足完成标准，或当前回复已足够报告结果。",
        "- blocked：无法继续，且回复说明了失败、权限、缺数据等原因。",
        "- needs_user：需要用户确认、选择或补充信息。",
        "- needs_action：仍有计划内 lookup/mutate 行动步骤未完成，且助手只是承诺要做或还没真正做。",
        "不要因为助手提出计划外的“下一步”就返回 needs_action。只看原任务计划中的 pending lookup/mutate。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        taskPlan: {
          userGoal: taskPlan.userGoal,
          needsLookup: taskPlan.needsLookup,
          needsMutation: taskPlan.needsMutation,
          doneCriteria: taskPlan.doneCriteria,
          items: taskPlan.items
        },
        recentToolResults: recentToolMessages,
        assistantContent
      }, null, 2)
    }
  ]);
  const parsed = parseJsonObject(content);
  const state = String(parsed.state ?? "").trim();
  return state === "completed" || state === "blocked" || state === "needs_user" || state === "needs_action" ? state : fallbackCompletionState(assistantContent, hasOpenActionTask(taskPlan, "lookup"), hasOpenActionTask(taskPlan, "mutate"));
}

function fallbackCompletionState(content: string, pendingLookup: boolean, pendingMutation: boolean): AgentCompletionState {
  if (looksLikeTaskBlocked(content)) return "blocked";
  if (pendingMutation) return "needs_action";
  if (pendingLookup && looksLikePromiseToAct(content)) return "needs_action";
  return "completed";
}

function looksLikePromiseToAct(content: string): boolean {
  return /我(会|将|来|现在|接下来|准备)|开始|继续|先.*再|需要.*执行|I'll|I will|let me|going to/i.test(content);
}

function looksLikeTaskBlocked(content: string): boolean {
  return /无法|不能|失败|需要你|请提供|没有权限|被拒绝|找不到|not found|denied|failed|cannot|need you/i.test(content);
}

function continuationInstruction(taskPlan: AgentTaskPlan, lastContent: string): string {
  const pending = taskPlan.items
    .filter((item) => item.status === "pending" || item.status === "running")
    .map((item) => `- ${item.id}: ${item.description}`)
    .join("\n");
  return [
    "内部续行提示：你刚才没有继续调用工具，但任务计划仍有未完成步骤。",
    pending ? `未完成步骤：\n${pending}` : "",
    lastContent.trim() ? `上一条回复：${lastContent.trim()}` : "",
    "请现在继续执行下一步工具调用；如果无法继续，必须说明具体阻塞原因。"
  ].filter(Boolean).join("\n");
}

function markTaskPlanContinuation(taskPlan: AgentTaskPlan, evidence: string): AgentTaskPlan {
  const now = new Date().toISOString();
  return {
    ...taskPlan,
    updatedAt: now,
    items: taskPlan.items.map((item) => item.status === "running" ? { ...item, status: "pending", evidence, updatedAt: now } : item)
  };
}

function markTaskPlanCompleted(taskPlan: AgentTaskPlan, evidence: string): AgentTaskPlan {
  const now = new Date().toISOString();
  return {
    ...taskPlan,
    updatedAt: now,
    items: taskPlan.items.map((item) => {
      if (item.status === "done" || item.status === "failed" || item.status === "skipped") return item;
      if (item.id === "respond") return { ...item, status: "done", evidence, updatedAt: now };
      return { ...item, status: "failed", evidence: `运行结束时该步骤没有对应的工具执行证据：${evidence}`, updatedAt: now };
    })
  };
}

function mergeTaskPlanProgress(base: AgentTaskPlan, latest: AgentTaskPlan): AgentTaskPlan {
  const latestById = new Map(latest.items.map((item) => [item.id, item]));
  return {
    ...base,
    updatedAt: latest.updatedAt || base.updatedAt,
    items: base.items.map((item) => {
      const latestItem = latestById.get(item.id);
      if (!latestItem) return item;
      if (isTerminalTaskStatus(latestItem.status) && !isTerminalTaskStatus(item.status)) return latestItem;
      if (isTerminalTaskStatus(latestItem.status) && taskStatusRank(latestItem.status) >= taskStatusRank(item.status)) return latestItem;
      return item;
    })
  };
}

function reconcileTaskPlanWithToolMessages(taskPlan: AgentTaskPlan, messages: ModelMessage[]): AgentTaskPlan {
  const toolResultIds = new Set(messages.filter((message) => message.role === "tool" && isSuccessfulToolMessage(message.content)).map((message) => message.tool_call_id).filter(Boolean));
  if (!toolResultIds.size) return taskPlan;
  const successfulToolNames = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const toolCall of message.tool_calls) {
      if (toolResultIds.has(toolCall.id)) successfulToolNames.add(toolCall.function.name);
    }
  }
  if (!successfulToolNames.size) return taskPlan;
  const now = new Date().toISOString();
  let changed = false;
  const items = taskPlan.items.map((item) => {
    if (item.status !== "pending" && item.status !== "running") return item;
    if (item.id === "lookup" && [...successfulToolNames].some(isLookupTool)) {
      changed = true;
      return { ...item, status: "done" as const, evidence: "已从历史工具结果恢复查询完成状态。", updatedAt: now };
    }
    if (item.id === "mutate" && [...successfulToolNames].some(isMutationTool)) {
      changed = true;
      return { ...item, status: "done" as const, evidence: "已从历史工具结果恢复修改完成状态。", updatedAt: now };
    }
    return item;
  });
  return changed ? { ...taskPlan, updatedAt: now, items } : taskPlan;
}

function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped";
}

function taskStatusRank(status: AgentTaskStatus): number {
  if (status === "done") return 3;
  if (status === "failed") return 3;
  if (status === "skipped") return 3;
  if (status === "running") return 2;
  return 1;
}

function isSuccessfulToolMessage(content: string): boolean {
  if (!content.trim()) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.ok !== false;
  } catch {
    return !/失败|错误|拒绝|denied|failed|error/i.test(content);
  }
}

function updateTaskPlanAfterToolResult(taskPlan: AgentTaskPlan, toolName: string, result: Record<string, unknown>): AgentTaskPlan {
  const now = new Date().toISOString();
  const ok = result.ok !== false;
  return {
    ...taskPlan,
    updatedAt: now,
    items: taskPlan.items.map((item) => {
      if (isLookupTool(toolName) && item.id === "lookup" && ok) {
        return { ...item, status: "done", evidence: toolSummary(result, "查询工具已返回结果。"), updatedAt: now };
      }
      if (isMutationTool(toolName) && item.id === "mutate") {
        return { ...item, status: ok ? "done" : "failed", evidence: toolSummary(result, ok ? "修改工具已执行。" : "修改工具执行失败。"), updatedAt: now };
      }
      return item;
    })
  };
}

function isLookupTool(toolName: string): boolean {
  return ["table_search", "table_get", "file_list", "file_read", "file_stat", "file_grep", "source_lookup", "web_search", "web_extract"].includes(toolName);
}

function isMutationTool(toolName: string): boolean {
  return ["table_add", "table_update", "table_replace", "table_delete", "file_write", "file_patch", "file_delete", "shell_run"].includes(toolName);
}

function toolSummary(result: Record<string, unknown>, fallback: string): string {
  return typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : fallback;
}

function normalizeAgUiInput(input: unknown): AgUiInput {
  if (!input || typeof input !== "object") {
    return {};
  }
  return input as AgUiInput;
}

function toModelMessages(messages: AgUiMessage[]): ModelMessage[] {
  return messages
    .map((message): ModelMessage | null => {
      const role = normalizeRole(message.role);
      const content = extractMessageText(message);
      if (!role) {
        return null;
      }
      if (role === "assistant" && message.toolCalls?.length) {
        const toolCalls = message.toolCalls
          .map((toolCall) => {
            const id = toolCall.id;
            const name = toolCall.function?.name;
            const args = toolCall.function?.arguments ?? "{}";
            return id && name
              ? {
                  id,
                  type: "function" as const,
                  function: {
                    name,
                    arguments: args
                  }
                }
              : null;
          })
          .filter((toolCall): toolCall is NonNullable<typeof toolCall> => Boolean(toolCall));
        if (!toolCalls.length && !content.trim()) return null;
        return {
          role,
          content,
          reasoning_content: reasoningContentForToolCalls(toolCalls.map((toolCall) => toolCall.id)),
          tool_calls: toolCalls
        };
      }
      if (role === "tool") {
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        return toolCallId ? { role, content, tool_call_id: toolCallId } : null;
      }
      if (!content.trim()) {
        return null;
      }
      return { role, content };
    })
    .filter((message): message is ModelMessage => Boolean(message));
}

async function buildAgentContextMessages(projectService: ProjectService, inputMessages: ModelMessage[]): Promise<ModelMessage[]> {
  const storedContext = await readJson<AgentModelContext>(projectPaths(projectService.project).aiContext, emptyAgentModelContext());
  const checkpoint = await readJson<AgentCheckpoint>(projectPaths(projectService.project).agentCheckpoint, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    status: "idle",
    toolCalls: []
  });
  const contextMessages: ModelMessage[] = [];
  if (storedContext.summary.trim()) {
    contextMessages.push({
      role: "system",
      content: `较早对话摘要：\n${storedContext.summary}`
    });
  }
  for (const message of storedContext.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.content.trim()) continue;
    contextMessages.push({ role: message.role, content: message.content });
  }

  const existing = new Set(contextMessages.map(naturalMessageKey));
  const recentNaturalInput = inputMessages
    .filter((message) => (message.role === "user" || message.role === "assistant") && !message.tool_calls?.length && message.content.trim() && !isInternalContinuationPrompt(message.content))
    .slice(-8);
  for (const message of recentNaturalInput) {
    const key = naturalMessageKey(message);
    if (existing.has(key)) continue;
    existing.add(key);
    contextMessages.push({ role: message.role, content: message.content });
  }

  const checkpointMessages = Array.isArray(checkpoint.messages)
    ? checkpoint.messages.map((message) => sanitizeModelMessage(message as ModelMessage)).filter((message): message is ModelMessage => Boolean(message))
    : [];
  return [...contextMessages, ...extractToolResumeMessages([...checkpointMessages, ...inputMessages], checkpoint)];
}

function emptyAgentModelContext(): AgentModelContext {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    summary: "",
    messages: []
  };
}

function naturalMessageKey(message: Pick<ModelMessage, "role" | "content">): string {
  return `${message.role}:${message.content}`;
}

function extractToolResumeMessages(messages: ModelMessage[], checkpoint: AgentCheckpoint): ModelMessage[] {
  if (checkpoint.status !== "pending_approval" || !checkpoint.toolCalls.length) return [];
  const checkpointToolCalls = new Map(checkpoint.toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const toolMessages = messages.filter((message) => message.role === "tool" && message.tool_call_id);
  if (!toolMessages.length) return [];
  const toolIds = new Set(
    toolMessages
      .map((message) => message.tool_call_id)
      .filter((id): id is string => typeof id === "string" && checkpointToolCalls.has(id))
  );
  if (!toolIds.size) return [];
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.tool_calls?.some((toolCall) => toolIds.has(toolCall.id)));
  if (!assistant?.tool_calls?.length) return [];
  const toolCalls = assistant.tool_calls.filter((toolCall) => toolIds.has(toolCall.id));
  if (!toolCalls.length) return [];
  const pairedToolMessages = toolMessages.filter((message) => message.tool_call_id && toolCalls.some((toolCall) => toolCall.id === message.tool_call_id));
  const reasoningContent =
    assistant.reasoning_content ||
    toolCalls.map((toolCall) => checkpointToolCalls.get(toolCall.id)?.reasoningContent || pendingReasoningByToolCallId.get(toolCall.id)).find(Boolean);
  if (!reasoningContent) return [];
  return [
    {
      ...assistant,
      reasoning_content: reasoningContent,
      tool_calls: toolCalls
    },
    ...pairedToolMessages
  ];
}

function buildModelContext(messages: ModelMessage[]): ModelMessage[] {
  const sanitized = messages.map(sanitizeModelMessage).filter((message): message is ModelMessage => Boolean(message));
  const windowed: ModelMessage[] = [];
  let chars = 0;
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const message = sanitized[index];
    const size = message.content.length + JSON.stringify(message.tool_calls ?? []).length;
    if (windowed.length >= MAX_CONTEXT_MESSAGES || chars + size > MAX_CONTEXT_CHARS) break;
    windowed.unshift(message);
    chars += size;
  }
  return repairToolMessagePairs(windowed);
}

function sanitizeModelMessage(message: ModelMessage): ModelMessage | null {
  if (message.role === "tool") {
    return { ...message, content: summarizeToolContent(message.content) };
  }
  const content = truncateForModel(message.content, MAX_MESSAGE_CHARS);
  if (!content.trim() && !message.tool_calls?.length) return null;
  return { ...message, content };
}

function summarizeToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const total = typeof parsed.total === "number" ? parsed.total : undefined;
    const returned = typeof parsed.returned === "number" ? parsed.returned : Array.isArray(parsed.items) ? parsed.items.length : undefined;
    const meta = [
      summary,
      total !== undefined ? `total=${total}` : "",
      returned !== undefined ? `returned=${returned}` : "",
      parsed.ok === false && typeof parsed.error === "string" ? `error=${parsed.error}` : ""
    ].filter(Boolean).join("；");
    return meta || truncateForModel(content, MAX_TOOL_RESULT_CHARS);
  } catch {
    return truncateForModel(content, MAX_TOOL_RESULT_CHARS);
  }
}

function truncateForModel(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[已截断 ${value.length - maxChars} 字符]` : value;
}

function repairToolMessagePairs(messages: ModelMessage[]): ModelMessage[] {
  const toolResultIds = new Set(messages.filter((message) => message.role === "tool" && message.tool_call_id).map((message) => message.tool_call_id));
  const assistantToolIds = new Set<string>();
  const repaired = messages
    .map((message): ModelMessage | null => {
      if (message.role === "assistant" && message.tool_calls?.length) {
        const toolCalls = message.tool_calls.filter((toolCall) => toolResultIds.has(toolCall.id));
        for (const toolCall of toolCalls) assistantToolIds.add(toolCall.id);
        if (!message.content.trim() && !toolCalls.length) return null;
        return { ...message, tool_calls: toolCalls.length ? toolCalls : undefined };
      }
      return message;
    })
    .filter((message): message is ModelMessage => Boolean(message));
  return repaired.filter((message) => message.role !== "tool" || (message.tool_call_id && assistantToolIds.has(message.tool_call_id)));
}

function reasoningContentForToolCalls(toolCallIds: string[]): string | undefined {
  for (const toolCallId of toolCallIds) {
    const reasoningContent = pendingReasoningByToolCallId.get(toolCallId);
    if (reasoningContent) return reasoningContent;
  }
  return undefined;
}

function normalizeRole(role: string | undefined): ModelMessage["role"] | null {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  return null;
}

function extractMessageText(message: AgUiMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

async function buildProjectContextLine(projectService: ProjectService): Promise<string> {
  const [items, analysis] = await Promise.all([
    projectService.readTextItems(),
    projectService.readAnalysis()
  ]);
  return [
    `项目名：${projectService.project.projectName}`,
    `语言：${projectService.project.sourceLanguage} -> ${projectService.project.targetLanguage}`,
    `文本行：${items.length}`,
    `人物：${analysis.characters.length}`,
    `术语：${analysis.glossary.length}`,
    `禁翻：${analysis.noTranslate.length}`
  ].join("；");
}

function buildAgentSystemPrompt(input: AgUiInput, request: AgentRunRequest, projectContext: string): string {
  const contextLines = [
    request.context?.projectName ? `当前项目：${request.context.projectName}` : "",
    request.context?.currentView ? `当前页面：${request.context.currentView}` : "",
    request.context?.currentTable ? `当前打开的表：${request.context.currentTable}` : "",
    request.context?.currentTableId ? `当前打开的表 ID：${request.context.currentTableId}` : "",
    request.context?.currentTableDescription ? `当前打开的表用途：${request.context.currentTableDescription}` : "",
    ...(input.context ?? []).map((item) => `${item.description ?? "context"}：${item.value ?? ""}`)
  ].filter(Boolean);
  const projectTableDescription = projectTableInfos.map((table) => `${table.id}（${table.label}）：${table.description}`).join("\n");

  return [
    "你是 BrowserGameTranslator 的本地 AI 助手，负责帮助用户查看、编辑和理解当前网页游戏翻译项目。",
    `当前项目摘要：${projectContext}`,
    "项目的 .bgt 文件夹包含项目配置和游戏原始副本；项目根目录是当前可编辑的工作区。",
    "你必须优先使用工具读取真实项目数据，不能凭空猜测表格内容、文件内容或统计结果。",
    "回答用户时不要暴露工具名、JSON、命令格式、内部 limit/offset 细节或执行日志；只给出用户需要的结论和下一步建议。",
    "当工具结果包含 total、returned、items 时，要基于 total 判断是否只是部分结果，不能把部分结果当成全部结果。",
    permissionPromptLine(request.permissionMode ?? "workspace"),
    "修改项目数据前先确认用户意图；用户明确要求修改、删除、翻译或校对时可以直接调用相应工具。",
    "读写项目表格时统一使用 table_search、table_get、table_add、table_update、table_replace、table_delete，并用 table 参数指定项目表 ID；需要最新计数时用 table_search 查看 total。",
    `项目表 ID 和用途：\n${projectTableDescription}`,
    "需要查看某条文本对应的原始文件片段时使用 source_lookup。",
    "搜索文件内容时优先使用 file_grep；查看文件元数据使用 file_stat；修改文件时优先生成 unified diff 并使用 file_patch。",
    "做大量同规则文本替换时优先使用 table_replace，不要为每一行构造 table_update；只有每行目标内容都不同时才使用 table_update 的 updates 数组。批量删除时仍使用 table_delete，但参数传 ids 数组，避免让用户逐行审批。",
    "如果需要批量处理大量记录，分批执行并在回答中说明已完成的范围。",
    contextLines.length > 0 ? `\n当前界面上下文：\n${contextLines.map((line) => `- ${line}`).join("\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function permissionPromptLine(mode: AiPermissionMode): string {
  if (mode === "restricted") {
    return "当前权限模式：受限。你只能操作文本表和资源表，不能访问文件或执行 Shell；表格写入会要求用户批准。";
  }
  if (mode === "workspace") {
    return "当前权限模式：工作区访问。你可以访问当前项目工作区内的文件和项目数据；写入、删除、Shell 和批量修改会要求用户批准。";
  }
  return "当前权限模式：无限制。你可以请求访问任意路径并执行 Shell；写入、删除、Shell 和批量修改会要求用户批准。";
}
