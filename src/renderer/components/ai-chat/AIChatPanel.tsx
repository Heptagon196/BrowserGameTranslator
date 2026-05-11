import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as RadixTabs from "@radix-ui/react-tabs";
import DiffViewer from "react-diff-viewer-continued";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, makeAssistantToolUI, useMessage, useMessagePartText, useThread, useThreadRuntime } from "@assistant-ui/react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ExportedMessageRepository, ExportedMessageRepositoryItem, ThreadHistoryAdapter, ThreadMessage } from "@assistant-ui/core";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { ChevronDown, ChevronRight, Maximize2, MessageSquare, Minimize2, PanelRightClose, SendHorizontal, Square, Trash2 } from "lucide-react";
import type { AiBalanceSnapshot, AiPermissionMode, AnalysisResult, ProgramAiIoEvent, ProviderConfig, TextItem } from "../../../shared/types";
import { CommandSelect } from "../ui/Selectors";
import { AppDialog, AppTooltip, StyledSelect, ToggleSwitch } from "../ui/Primitives";
import { ExternalMarkdownLink } from "../../markdownLinks";

type AgentContext = {
  currentView?: string;
  currentTable?: string;
  currentTableId?: string;
  currentTableDescription?: string;
  projectName?: string;
};

type AgentEvent = Record<string, unknown> & { type?: string };
type AgentToolRuntimeContextValue = {
  permissionMode: AiPermissionMode;
  disabled: boolean;
  onProjectChanged?: () => Promise<void> | void;
  textItemsById: Map<string, TextItem>;
  resourceRowsByTable: Map<string, Map<string, Record<string, unknown>>>;
};

type AgentSubscriber = {
  onTextMessageStartEvent?: (payload: { event: unknown }) => void;
  onTextMessageContentEvent?: (payload: { event: unknown }) => void;
  onTextMessageEndEvent?: (payload: { event: unknown }) => void;
  onToolCallStartEvent?: (payload: { event: unknown }) => void;
  onToolCallArgsEvent?: (payload: { event: unknown }) => void;
  onToolCallEndEvent?: (payload: { event: unknown }) => void;
  onToolCallResultEvent?: (payload: { event: unknown }) => void;
  onStateSnapshotEvent?: (payload: { event: unknown }) => void;
  onStateDeltaEvent?: (payload: { event: unknown }) => void;
  onMessagesSnapshotEvent?: (payload: { event: unknown }) => void;
  onCustomEvent?: (payload: { event: unknown }) => void;
  onRunFinalized?: () => void;
  onRunFailed?: (payload: { error: Error }) => void;
};
type AgentRunOptions = {
  signal?: AbortSignal;
};

const toolNames = [
  "project_refresh",
  "table_search",
  "table_get",
  "table_add",
  "table_update",
  "table_replace",
  "table_delete",
  "file_list",
  "file_read",
  "file_stat",
  "file_write",
  "file_patch",
  "file_delete",
  "file_grep",
  "source_lookup",
  "web_search",
  "web_extract",
  "shell_run"
];

const approvalToolNames = new Set([
  "table_add",
  "table_update",
  "table_replace",
  "table_delete",
  "file_write",
  "file_patch",
  "file_delete",
  "shell_run"
]);

const ToolUIs = toolNames.map((toolName) =>
  makeAssistantToolUI<Record<string, unknown>, unknown>({
    toolName,
    render: AgentToolCall
  })
);

const permissionOptions: Array<{ id: AiPermissionMode; label: string; description: string; tooltip: string }> = [
  {
    id: "restricted",
    label: "受限",
    description: "只允许表操作",
    tooltip: "只允许操作文本表和资源表；不允许访问文件或执行 Shell，表格写入仍需要批准。"
  },
  {
    id: "workspace",
    label: "工作区",
    description: "项目内访问",
    tooltip: "允许访问当前项目工作区内的文件和项目数据；写入、删除、Shell 和批量修改需要批准。"
  },
  {
    id: "unrestricted",
    label: "无限制",
    description: "不限制路径",
    tooltip: "允许请求访问任意路径并执行 Shell；写入、删除、Shell 和批量修改仍需要批准。"
  }
];

const permissionSelectOptions = permissionOptions.map((option) => ({
  value: option.id,
  label: option.label,
  description: option.description,
  title: option.tooltip
}));

const AgentToolRuntimeContext = React.createContext<AgentToolRuntimeContextValue>({
  permissionMode: "workspace",
  disabled: true,
  textItemsById: new Map(),
  resourceRowsByTable: new Map()
});

export default function AIChatPanel({
  disabled,
  selectedModelId,
  modelOptions,
  onModelChange,
  aiBalance,
  fullscreen,
  onToggleFullscreen,
  onCollapse,
  provider,
  context,
  analysis,
  textItems,
  onProjectChanged
}: {
  disabled: boolean;
  selectedModelId?: string;
  modelOptions: Array<{ id: string; label: string }>;
  onModelChange: (modelId: string) => void;
  aiBalance: AiBalanceSnapshot | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onCollapse: () => void;
  provider?: ProviderConfig;
  context: AgentContext;
  analysis: AnalysisResult;
  textItems: TextItem[];
  onProjectChanged?: () => Promise<void> | void;
}) {
  const [activeTab, setActiveTab] = useState<"chat" | "backend">("chat");
  const [programIoEvents, setProgramIoEvents] = useState<ProgramAiIoEvent[]>([]);
  const [permissionMode, setPermissionMode] = useState<AiPermissionMode>(() => {
    const stored = localStorage.getItem("bgt.aiPermissionMode");
    return stored === "workspace" || stored === "unrestricted" || stored === "restricted" ? stored : "workspace";
  });
  const providerRef = useRef(provider);
  const contextRef = useRef(context);
  const permissionModeRef = useRef(permissionMode);
  providerRef.current = provider;
  contextRef.current = context;
  permissionModeRef.current = permissionMode;
  React.useEffect(() => {
    localStorage.setItem("bgt.aiPermissionMode", permissionMode);
  }, [permissionMode]);
  React.useEffect(() => {
    return window.bgt.onProgramAiIo((event) => {
      setProgramIoEvents((events) => [...events.slice(-199), event]);
    });
  }, []);
  const historyAdapter = useMemo(() => createWorkspaceThreadHistoryAdapter(), []);
  const textItemsById = useMemo(() => new Map(textItems.map((item) => [item.id, item])), [textItems]);
  const resourceRowsByTable = useMemo(() => buildResourceRowsByTable(analysis), [analysis]);

  const agent = useMemo(
    () => ({
      threadId: "bgt-main",
      messages: [],
      runAgent: async (input: unknown, subscriber: AgentSubscriber, options?: AgentRunOptions) => {
        const currentProvider = providerRef.current;
        if (disabled || !currentProvider?.apiKey) {
          throw new Error("请先打开项目并配置可用的 AI 模型。");
        }
        const clientRunId = createClientRunId();
        const dispatchedSequences = new Set<number>();
        const abortSignal = options?.signal;
        let unsubscribeAgentEvents = () => {};
        unsubscribeAgentEvents = window.bgt.onAgentEvent((payload) => {
          if (payload.clientRunId !== clientRunId) return;
          dispatchAgentEventOnce(subscriber, payload.event as AgentEvent, dispatchedSequences);
        });
        const cancelBackendRun = () => {
          void window.bgt.cancelAgentRun({ clientRunId });
        };
        abortSignal?.addEventListener("abort", cancelBackendRun, { once: true });
        try {
          const result = await window.bgt.runAgentStream({
            clientRunId,
            input,
            provider: currentProvider,
            permissionMode: permissionModeRef.current,
            context: contextRef.current
          });
          dispatchReturnedEvents(subscriber, result.events, dispatchedSequences);
        } catch (error) {
          if (abortSignal?.aborted || isAgentCancelledError(error)) {
            dispatchAgentEventOnce(subscriber, { type: "RUN_CANCELLED", runId: clientRunId }, dispatchedSequences);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const runtimeError = error instanceof Error ? error : new Error(message);
          subscriber.onRunFailed?.({ error: runtimeError });
          throw runtimeError;
        } finally {
          abortSignal?.removeEventListener("abort", cancelBackendRun);
          unsubscribeAgentEvents();
        }
      }
    }),
    [disabled]
  );
  const runtime = useAgUiRuntime({
    agent: agent as never,
    adapters: {
      history: historyAdapter
    },
    onError: (error) => {
      console.error("[agent]", error);
    }
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentToolRuntimeContext.Provider value={{ permissionMode, disabled, onProjectChanged, textItemsById, resourceRowsByTable }}>
      <aside className={fullscreen ? "chat-panel fullscreen" : "chat-panel"}>
        <ToolRegistrations />
        <ThreadHistorySync />
        <div className="chat-title">
          <div>
            <MessageSquare size={18} />
            <span>AI</span>
            {aiBalance?.balances.length ? <span className="chat-cost">{formatDeepSeekBalance(aiBalance)}</span> : null}
          </div>
          <div className="chat-title-actions">
            <ClearThreadButton disabled={disabled} />
            <AppTooltip content={fullscreen ? "退出全屏" : "全屏"}>
              <button className="icon-button" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={onToggleFullscreen}>
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </AppTooltip>
            <AppTooltip content="收起 AI 窗口">
              <button className="icon-button" aria-label="收起 AI 窗口" onClick={onCollapse}>
                <PanelRightClose size={16} />
              </button>
            </AppTooltip>
          </div>
        </div>
        <RadixTabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
          <RadixTabs.List className="chat-tabs">
            <RadixTabs.Trigger value="chat" className={activeTab === "chat" ? "active" : ""}>
              聊天
            </RadixTabs.Trigger>
            <RadixTabs.Trigger value="backend" className={activeTab === "backend" ? "active" : ""}>
              后台
              {programIoEvents.length ? <span>{programIoEvents.length}</span> : null}
            </RadixTabs.Trigger>
          </RadixTabs.List>
        </RadixTabs.Root>
        {activeTab === "chat" ? <AssistantThread /> : <BackendTrace events={programIoEvents} />}
        <ComposerPrimitive.Root className="chat-input">
          <ComposerPrimitive.Input
            className="chat-draft-input"
            disabled={disabled}
            maxRows={8}
            minRows={4}
            placeholder={disabled ? "打开项目后可介入翻译任务" : "输入消息，Enter 发送，Shift+Enter 换行"}
            submitMode="enter"
          />
          <div className="chat-input-actions">
            <CommandSelect
              disabled={!selectedModelId || !modelOptions.length}
              value={selectedModelId || ""}
              options={modelOptions}
              placeholder="选择 AI 模型"
              emptyText="没有可用模型"
              onChange={onModelChange}
            />
            <div className="chat-send-row">
              <span className="permission-mode-select-wrapper">
                <StyledSelect
                  className="permission-mode-select"
                  disabled={disabled}
                  value={permissionMode}
                  options={permissionSelectOptions}
                  onChange={(value) => setPermissionMode(value as AiPermissionMode)}
                />
              </span>
              <SendOrInterruptButton disabled={disabled} />
            </div>
          </div>
        </ComposerPrimitive.Root>
      </aside>
      </AgentToolRuntimeContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function SendOrInterruptButton({ disabled }: { disabled: boolean }) {
  const thread = useThreadRuntime();
  const isRunning = useThread((state) => state.isRunning);
  if (isRunning) {
    return (
      <AppTooltip content="打断当前回复">
        <button className="chat-interrupt-button" type="button" onClick={() => thread.cancelRun()}>
          <Square size={16} />
          打断
        </button>
      </AppTooltip>
    );
  }
  return (
    <ComposerPrimitive.Send disabled={disabled}>
      <SendHorizontal size={16} />
      发送
    </ComposerPrimitive.Send>
  );
}

function ToolRegistrations() {
  return (
    <>
      {ToolUIs.map((ToolUI) => (
        <ToolUI key={ToolUI.unstable_tool.toolName} />
      ))}
    </>
  );
}

function ThreadHistorySync() {
  const messages = useThread((state) => state.messages);
  const savedRef = useRef(new Map<string, string>());
  React.useEffect(() => {
    for (const [index, message] of messages.entries()) {
      if (!shouldPersistThreadMessage(message)) continue;
      const fingerprint = JSON.stringify({ status: message.status, content: message.content });
      if (savedRef.current.get(message.id) === fingerprint) continue;
      savedRef.current.set(message.id, fingerprint);
      const parentId = messages[index - 1]?.id ?? null;
      void window.bgt.appendAgentChatHistory({ parentId, message }).catch((error) => {
        console.error("[agent] failed to persist thread message", error);
      });
    }
  }, [messages]);
  return null;
}

function shouldPersistThreadMessage(message: ThreadMessage): boolean {
  return message.role === "assistant" && message.status?.type === "requires-action";
}

function AssistantThread() {
  return (
    <ThreadPrimitive.Root className="assistant-thread-root">
      <ThreadPrimitive.Viewport className="messages">
        <ThreadPrimitive.Empty>
          <div className="chat-empty">
            <strong>和 AI 讨论翻译</strong>
            <p>可以直接提问当前项目、表格、文件和翻译内容。需要固定影响翻译流程的规则，请到提示词页配置。</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ Message: AssistantMessage }} />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function AssistantMessage() {
  const role = useMessage((message) => message.role);
  const createdAt = useMessage((message) => message.createdAt);
  const status = useMessage((message) => message.status);
  const hasActiveToolCall = useMessage((message) =>
    message.role === "assistant" &&
    message.content.some((part) => part.type === "tool-call" && part.result === undefined)
  );
  const statusIndicator = role === "assistant" ? assistantStatusIndicator(status, hasActiveToolCall) : null;
  return (
    <MessagePrimitive.Root className={`message ${role}`}>
      <span>{role === "assistant" ? "AI" : role === "system" ? "系统" : "你"}{createdAt ? ` · ${formatTime(createdAt)}` : ""}</span>
      <MessagePrimitive.Parts components={{ Text: MarkdownTextPart }} />
      {statusIndicator?.kind === "running" ? <MessageLoadingIndicator label={statusIndicator.text} /> : null}
      {statusIndicator?.kind === "blocked" ? <MessageStatusText text={statusIndicator.text} /> : null}
      <AgentMessageError status={status} />
    </MessagePrimitive.Root>
  );
}

function MessageLoadingIndicator({ label }: { label: string }) {
  return (
    <div className="message-loading" aria-live="polite">
      <span className="message-loading-dot" />
      <span className="message-loading-dot" />
      <span className="message-loading-dot" />
      <em>{label}</em>
    </div>
  );
}

function MessageStatusText({ text }: { text: string }) {
  return (
    <div className="message-status-text" aria-live="polite">
      {text}
    </div>
  );
}

function AgentMessageError({ status }: { status: ThreadMessage["status"] }) {
  const [expanded, setExpanded] = useState(false);
  if (status?.type !== "incomplete" || status.reason !== "error") return null;
  const detail = formatErrorDetail(status.error ?? "任务执行失败。");
  const summary = previewInlineText(firstNonEmptyLine(detail) || "任务执行失败", 92);
  return (
    <div className="agent-error-fold">
      <button className="agent-error-inline" title={detail} onClick={() => setExpanded((value) => !value)}>
        <span>任务执行失败 · {summary}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {expanded ? (
        <div className="agent-error-detail">
          <pre>{detail}</pre>
        </div>
      ) : null}
    </div>
  );
}

function assistantStatusIndicator(status: ThreadMessage["status"], hasActiveToolCall = false): { kind: "running" | "blocked"; text: string } | null {
  if (status?.type === "running") return { kind: "running", text: hasActiveToolCall ? "正在调用工具" : "正在思考" };
  if (status?.type === "requires-action") {
    return {
      kind: "blocked",
      text: status.reason === "tool-calls" ? "等待审批中" : "等待用户处理"
    };
  }
  if (status?.type !== "incomplete") return null;
  const labels: Record<string, string> = {
    cancelled: "回复已打断",
    "tool-calls": "工具调用未完成",
    length: "回复因长度限制中断",
    "content-filter": "回复被内容过滤中断",
    error: "回复出错",
    other: "回复未完成"
  };
  return { kind: "blocked", text: labels[status.reason] ?? "回复未完成" };
}

function MarkdownTextPart() {
  const part = useMessagePartText();
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ExternalMarkdownLink
        }}
      >
        {part.text}
      </ReactMarkdown>
    </div>
  );
}

function AgentToolCall(props: ToolCallMessagePartProps<Record<string, unknown>, unknown>) {
  const { permissionMode, disabled, onProjectChanged, textItemsById, resourceRowsByTable } = React.useContext(AgentToolRuntimeContext);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const summary = summarizeToolResult(props.result);
  const approvalSummary = describeToolOperation(props.toolName, props.args, textItemsById);
  const inlineSummary = toolInlineSummary(props.toolName, props.args, props.result, textItemsById);
  const inlineTitle = `${toolLabel(props.toolName)}${inlineSummary ? ` · ${inlineSummary}` : ""}`;
  const completeArgs = hasCompleteToolArgs(props.args, props.argsText);
  const pendingApproval =
    props.result === undefined &&
    (props.status.type === "requires-action" || (permissionMode !== "restricted" && approvalToolNames.has(props.toolName) && completeArgs));
  const errorText = toolErrorText(props.result, props.isError);
  const approveToolCall = async (toolName: string, args: Record<string, unknown>, rejectedChanges: ApprovalRejectedChange[] = []) => {
    setApprovalBusy(true);
    try {
      const result = await window.bgt.executeApprovedAgentTool({
        toolName,
        args,
        permissionMode
      });
      const resultWithRejections = rejectedChanges.length ? appendRejectedApprovalChanges(result, rejectedChanges) : result;
      props.addResult(resultWithRejections);
      if (isDataChangedToolResult(resultWithRejections)) {
        void Promise.resolve(onProjectChanged?.()).catch((error) => {
          console.error("[agent] failed to refresh project after approved tool", error);
        });
      }
    } catch (error) {
      props.addResult({
        tool: props.toolName,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setApprovalBusy(false);
    }
  };
  const approve = () => {
    void approveToolCall(props.toolName, props.args);
  };
  const reject = () => {
    props.addResult({
      tool: props.toolName,
      ok: false,
      rejected: true,
      error: "用户拒绝执行。"
    });
  };
  if (errorText) {
    return <AgentToolErrorCard toolName={props.toolName} args={props.args} result={props.result} errorText={errorText} />;
  }

  if (!pendingApproval) {
    return (
      <div className="agent-tool-fold">
        <button className="agent-tool-inline" title={inlineTitle} onClick={() => setExpanded((value) => !value)}>
          <span>{inlineTitle}</span>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {expanded ? (
          <div className="agent-tool-card full-call">
            <span className="agent-tool-status">{props.result === undefined ? "调用中" : "已完成"}</span>
            {summary ? <p>{summary}</p> : null}
            <ToolPayloadBlock title="参数" value={props.args} />
            {props.result !== undefined ? <ToolPayloadBlock title="结果" value={props.result} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="agent-tool-card">
      <div className="agent-tool-title">
        <strong>{toolLabel(props.toolName)}</strong>
        <span>等待批准</span>
      </div>
      <div className="agent-approval-box">
        <p>{approvalDescription(props.toolName, permissionMode)}</p>
        <div className="agent-approval-summary">
          <strong>将要执行：</strong>
          <span>{approvalSummary}</span>
        </div>
        <div>
          <button disabled={disabled || approvalBusy} onClick={approve}>批准执行</button>
          <button className="secondary-button" disabled={approvalBusy} onClick={() => setDetailOpen(true)}>详细</button>
          <button className="secondary-button" disabled={approvalBusy} onClick={reject}>拒绝</button>
        </div>
      </div>
      {summary ? <p>{summary}</p> : null}
      {detailOpen ? (
        <ApprovalDetailDialog
          args={props.args}
          approvalBusy={approvalBusy || disabled}
          onApproveAll={() => { void approveToolCall(props.toolName, props.args); }}
          onApproveSelected={(request) => { void approveToolCall(request.toolName, request.args, request.rejectedChanges); }}
          resourceRowsByTable={resourceRowsByTable}
          textItemsById={textItemsById}
          toolName={props.toolName}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ApprovalDetailDialog({
  toolName,
  args,
  approvalBusy,
  resourceRowsByTable,
  textItemsById,
  onApproveAll,
  onApproveSelected,
  onClose
}: {
  toolName: string;
  args: Record<string, unknown>;
  approvalBusy: boolean;
  resourceRowsByTable: Map<string, Map<string, Record<string, unknown>>>;
  textItemsById: Map<string, TextItem>;
  onApproveAll: () => void;
  onApproveSelected: (request: FilteredApprovalRequest) => void;
  onClose: () => void;
}) {
  const diffs = buildApprovalDiffs(toolName, args, textItemsById, resourceRowsByTable);
  const selectableDiffs = diffs.filter((diff) => diff.selection);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(selectableDiffs.map((diff) => diff.key)));
  const description = toolName === "table_replace" ? `${toolLabel(toolName)} · ${replacementRulesSummary(args)}` : toolLabel(toolName);
  useEffect(() => {
    setSelectedKeys(new Set(selectableDiffs.map((diff) => diff.key)));
  }, [args, toolName, selectableDiffs.map((diff) => diff.key).join("\u0000")]);
  const selectedCount = selectableDiffs.filter((diff) => selectedKeys.has(diff.key)).length;
  const selectedRequest = buildFilteredApprovalRequest(toolName, args, diffs, selectedKeys);
  const toggleDiff = (key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };
  return (
    <AppDialog open title="审批详情" description={description} className="approval-detail-modal" onOpenChange={(open) => { if (!open) onClose(); }}>
      <div className="approval-detail-actions">
        <span>{selectableDiffs.length ? `已选择 ${selectedCount} / ${selectableDiffs.length} 项修改` : "该操作不支持逐行选择"}</span>
        <div>
          <button disabled={approvalBusy} onClick={onApproveAll}>批准全部修改</button>
          <button
            disabled={approvalBusy || !selectedRequest || selectedCount === 0}
            onClick={() => { if (selectedRequest) onApproveSelected(selectedRequest); }}
          >
            批准选中修改
          </button>
        </div>
      </div>
      <div className="approval-detail-list">
        {diffs.length ? (
          diffs.map((diff, index) => (
            <section className={diff.selection && !selectedKeys.has(diff.key) ? "approval-diff-card skipped" : "approval-diff-card"} key={diff.key || `${diff.title}-${index}`}>
              <div className="approval-diff-title">
                {diff.selection ? (
                  <ToggleSwitch
                    checked={selectedKeys.has(diff.key)}
                    title={selectedKeys.has(diff.key) ? "应用这一行修改" : "不应用这一行修改"}
                    onChange={(checked) => toggleDiff(diff.key, checked)}
                  />
                ) : null}
                {diff.titleTooltip ? (
                  <AppTooltip content={diff.titleTooltip}>
                    <strong>{diff.title}</strong>
                  </AppTooltip>
                ) : (
                  <strong>{diff.title}</strong>
                )}
                {diff.description ? <span>{diff.description}</span> : null}
              </div>
              <div className="approval-diff-viewer">
                <DiffViewer
                  compareMethod="diffWords"
                  hideLineNumbers
                  leftTitle="当前"
                  newValue={diff.next}
                  oldValue={diff.previous}
                  rightTitle="将变更为"
                  showDiffOnly={false}
                  splitView={diff.splitView ?? false}
                  styles={approvalDiffStyles}
                  useDarkTheme={false}
                />
              </div>
            </section>
          ))
        ) : (
          <section className="approval-diff-card">
            <div className="approval-diff-title">
              <strong>参数</strong>
              <span>该操作没有可计算的字段 diff。</span>
            </div>
            <pre className="approval-raw-payload">{formatToolPayload(args)}</pre>
          </section>
        )}
      </div>
    </AppDialog>
  );
}

function AgentToolErrorCard({
  toolName,
  args,
  result,
  errorText
}: {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  errorText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = `${toolLabel(toolName)}失败 · ${previewInlineText(firstNonEmptyLine(errorText), 80)}`;
  return (
    <div className="agent-tool-fold error">
      <button className="agent-tool-inline error" title={errorText} onClick={() => setExpanded((value) => !value)}>
        <span>{title}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {expanded ? (
        <div className="agent-tool-error-card">
          <strong>{toolLabel(toolName)}失败</strong>
          <pre>{errorText}</pre>
          <ToolPayloadBlock title="参数" value={args} />
          {result !== undefined ? <ToolPayloadBlock title="返回" value={result} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolPayloadBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="agent-tool-payload">
      <span>{title}</span>
      <pre>{formatToolPayload(value)}</pre>
    </div>
  );
}

type ApprovalDiffItem = {
  key: string;
  title: string;
  titleTooltip?: string;
  description?: string;
  previous: string;
  next: string;
  splitView?: boolean;
  selection?: ApprovalDiffSelection;
};

type ApprovalDiffSelection = {
  action: "update" | "delete";
  table: string;
  id: string;
  field?: string;
  patch?: Record<string, unknown>;
  summary: string;
};

type ApprovalRejectedChange = {
  table: string;
  id: string;
  field?: string;
  summary: string;
};

type FilteredApprovalRequest = {
  toolName: string;
  args: Record<string, unknown>;
  rejectedChanges: ApprovalRejectedChange[];
};

const approvalDiffStyles = {
  variables: {
    light: {
      diffViewerBackground: "#ffffff",
      diffViewerColor: "#20323c",
      addedBackground: "#e8f4ec",
      addedColor: "#20323c",
      removedBackground: "#fff0ed",
      removedColor: "#20323c",
      wordAddedBackground: "#bfe7ca",
      wordRemovedBackground: "#f6c4bb",
      gutterBackground: "#f4f8f9",
      gutterBackgroundDark: "#edf3f5",
      highlightBackground: "#fff7d6",
      highlightGutterBackground: "#f0ddb0"
    }
  },
  contentText: {
    fontFamily: "var(--ui-chat-font-family)",
    fontSize: "13px",
    lineHeight: 1.55,
    wordBreak: "break-word"
  },
  titleBlock: {
    fontFamily: "var(--ui-chat-font-family)",
    fontSize: "12px",
    fontWeight: 700
  }
} as const;

function buildApprovalDiffs(
  toolName: string,
  args: Record<string, unknown>,
  textItemsById: Map<string, TextItem>,
  resourceRowsByTable: Map<string, Map<string, Record<string, unknown>>>
): ApprovalDiffItem[] {
  if (toolName === "table_update") {
    const table = tableName(args);
    const entries = bulkUpdateEntries(args);
    if (table === "text") {
      if (entries.length > 1 || "updates" in args || "items" in args || "rows" in args) {
        return entries.flatMap((entry) => {
          const item = lookupTextItem(textItemsById, entry.id);
          return item
            ? textItemDiffs(item, entry.patch, entry.id, "text")
            : genericPatchDiffs(textFallbackTitle(entry.id, entry.patch), {}, entry.patch, { action: "update", table: "text", id: entry.id });
        });
      }
      const id = stringValue(args.id);
      const patch = recordValue(args.patch);
      const item = lookupTextItem(textItemsById, id);
      return item ? textItemDiffs(item, patch, id, "text") : genericPatchDiffs(textFallbackTitle(id, patch), {}, patch, { action: "update", table: "text", id });
    }
    const tableRows = resourceRowsByTable.get(table) ?? new Map<string, Record<string, unknown>>();
    if (entries.length > 1 || "updates" in args || "items" in args || "rows" in args) {
      return entries.flatMap((entry) => {
        const row = lookupMapRow(tableRows, entry.id);
        return genericPatchDiffs(
          resourceDiffTitle(table, entry.id, row),
          row ?? {},
          entry.patch,
          { action: "update", table, id: entry.id }
        );
      });
    }
    const id = stringValue(args.id);
    const row = lookupMapRow(tableRows, id);
    return genericPatchDiffs(resourceDiffTitle(table, id, row), row ?? {}, recordValue(args.patch), { action: "update", table, id });
  }
  if (toolName === "table_replace") {
    const table = tableName(args);
    const ids = deleteIdEntries(args);
    const fields = replaceFieldEntries(args, table);
    const replacements = replacementEntries(args);
    if (table === "text") {
      return ids.flatMap((id) => {
        const item = lookupTextItem(textItemsById, id);
        return fields.map((field) => {
          const current = item ? stringValue((item as unknown as Record<string, unknown>)[field]) : "";
          const next = item ? applyPreviewReplacementRules(current, replacements) : "[将在执行时按替换规则处理]";
          return {
            key: approvalDiffKey("replace", table, id, field),
            title: item ? textApprovalRowTitle(item.id || id, item.original) : textApprovalRowTitle(id, ""),
            titleTooltip: item?.original || undefined,
            description: `字段：${fieldLabel(field)}`,
            previous: item ? current : "[未读取到当前值]",
            next,
            splitView: true,
            selection: item ? {
              action: "update",
              table,
              id,
              field,
              patch: { [field]: next },
              summary: `${textApprovalRowTitle(id, item.original)} · ${fieldLabel(field)}`
            } : undefined
          };
        });
      });
    }
    const tableRows = resourceRowsByTable.get(table) ?? new Map<string, Record<string, unknown>>();
    return ids.flatMap((id) => {
      const row = lookupMapRow(tableRows, id);
      return fields.map((field) => {
        const current = row ? stringValue(row[field]) : "";
        const next = row ? applyPreviewReplacementRules(current, replacements) : "[将在执行时按替换规则处理]";
        return {
          key: approvalDiffKey("replace", table, id, field),
          title: `${resourceDiffTitle(table, id, row)} · ${fieldLabel(field)}`,
          previous: row ? current : "[未读取到当前值]",
          next,
          splitView: true,
          selection: row ? {
            action: "update",
            table,
            id,
            field,
            patch: { [field]: next },
            summary: `${resourceDiffTitle(table, id, row)} · ${fieldLabel(field)}`
          } : undefined
        };
      });
    });
  }
  if (toolName === "table_delete") {
    const table = tableName(args);
    const ids = deleteIdEntries(args);
    if (table === "text") {
      return ids.map((id) => {
        const item = lookupTextItem(textItemsById, id);
        return {
          key: approvalDiffKey("delete", table, id),
          title: "删除文本行",
          description: item ? previewInlineText(item.original || item.translation || id, 120) : id,
          previous: item ? stringifyDiffValue(item) : id,
          next: "[删除]",
          splitView: false,
          selection: {
            action: "delete",
            table,
            id,
            summary: item ? textApprovalRowTitle(id, item.original) : id
          }
        };
      });
    }
    const tableRows = resourceRowsByTable.get(table) ?? new Map<string, Record<string, unknown>>();
    return ids.map((id) => ({
      key: approvalDiffKey("delete", table, id),
      title: `删除${tableLabel(table)}`,
      description: resourceRowLabel(lookupMapRow(tableRows, id), id),
      previous: stringifyDiffValue(lookupMapRow(tableRows, id) ?? id),
      next: "[删除]",
      splitView: false,
      selection: {
        action: "delete",
        table,
        id,
        summary: `${tableLabel(table)}「${resourceRowLabel(lookupMapRow(tableRows, id), id)}」`
      }
    }));
  }
  if (toolName === "file_write") {
    return [{
      key: "file_write",
      title: `写入文件 ${pathSummary(args.path)}`,
      description: `约 ${stringValue(args.content).length} 字符`,
      previous: "[当前文件内容将在执行时由后端写入；审批阶段未读取源文件]",
      next: stringValue(args.content),
      splitView: true
    }];
  }
  if (toolName === "file_patch") {
    return [{
      key: "file_patch",
      title: `应用补丁 ${pathSummary(args.path)}`,
      description: "Unified diff",
      previous: "[当前文件内容将在执行时由后端读取并校验补丁上下文]",
      next: stringValue(args.diff) || "[未指定补丁]",
      splitView: true
    }];
  }
  if (toolName === "file_delete") {
    return [{ key: "file_delete", title: `删除 ${pathSummary(args.path)}`, previous: "保留文件", next: "删除文件或目录", splitView: false }];
  }
  if (toolName === "shell_run") {
    return [{
      key: "shell_run",
      title: "执行 Shell",
      description: stringValue(args.cwd) ? `工作目录：${stringValue(args.cwd)}` : undefined,
      previous: "不执行命令",
      next: stringValue(args.command) || "[未指定命令]",
      splitView: false
    }];
  }
  return [];
}

function textItemDiffs(item: TextItem, patch: Record<string, unknown>, fallbackId: string, table: string): ApprovalDiffItem[] {
  const fields: Array<[keyof TextItem, string]> = [
    ["translation", "译文"],
    ["status", "状态"],
    ["original", "原文"],
    ["sourceFile", "文件"],
    ["locator", "定位"]
  ];
  const diffs = fields
    .filter(([field]) => field in patch)
    .map(([field, label]) => {
      const id = item.id || fallbackId;
      return {
        key: approvalDiffKey("update", table, id, String(field)),
        title: textApprovalRowTitle(id, item.original),
        titleTooltip: item.original || undefined,
        description: `字段：${label}`,
        previous: stringifyDiffValue(item[field]),
        next: stringifyDiffValue(patch[field]),
        splitView: field === "translation" || field === "original",
        selection: {
          action: "update",
          table,
          id,
          field: String(field),
          patch: { [field]: patch[field] },
          summary: `${textApprovalRowTitle(id, item.original)} · ${label}`
        }
      } satisfies ApprovalDiffItem;
    });
  return diffs.length
    ? diffs
    : genericPatchDiffs(textApprovalRowTitle(item.id || fallbackId, item.original), item as unknown as Record<string, unknown>, patch, {
      action: "update",
      table,
      id: item.id || fallbackId
    });
}

function genericPatchDiffs(
  title: string,
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
  selectionBase?: Pick<ApprovalDiffSelection, "action" | "table" | "id">
): ApprovalDiffItem[] {
  const entries = Object.entries(patch);
  if (!entries.length) return [];
  return entries.map(([key, nextValue]) => ({
    key: selectionBase ? approvalDiffKey(selectionBase.action, selectionBase.table, selectionBase.id, key) : approvalDiffKey("update", "unknown", title, key),
    title: `${title} · ${fieldLabel(key)}`,
    previous: key in previous ? stringifyDiffValue(previous[key]) : "[未读取到当前值]",
    next: stringifyDiffValue(nextValue),
    splitView: typeof nextValue === "string" && nextValue.length > 80,
    selection: selectionBase ? {
      ...selectionBase,
      field: key,
      patch: { [key]: nextValue },
      summary: `${title} · ${fieldLabel(key)}`
    } : undefined
  }));
}

function approvalDiffKey(action: string, table: string, id: string, field = ""): string {
  return [action, table, id, field].join("::");
}

function buildFilteredApprovalRequest(
  toolName: string,
  args: Record<string, unknown>,
  diffs: ApprovalDiffItem[],
  selectedKeys: Set<string>
): FilteredApprovalRequest | null {
  const selectable = diffs.filter((diff) => diff.selection);
  if (!selectable.length) return null;
  const selected = selectable.filter((diff) => selectedKeys.has(diff.key));
  if (!selected.length) return null;
  const rejectedChanges = selectable
    .filter((diff) => !selectedKeys.has(diff.key))
    .map((diff) => selectionToRejectedChange(diff.selection));
  const table = tableName(args);
  if (toolName === "table_delete") {
    const ids = selected.map((diff) => diff.selection?.id).filter((id): id is string => Boolean(id));
    if (!ids.length) return null;
    return {
      toolName,
      args: { ...args, table: projectTableName(table), id: undefined, ids },
      rejectedChanges
    };
  }
  if (toolName === "table_update" || toolName === "table_replace") {
    const updates = selectedDiffsToUpdates(selected);
    if (!updates.length) return null;
    return {
      toolName: "table_update",
      args: { table: projectTableName(table), updates },
      rejectedChanges
    };
  }
  return null;
}

function selectedDiffsToUpdates(diffs: ApprovalDiffItem[]): Array<{ id: string; patch: Record<string, unknown> }> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const diff of diffs) {
    const selection = diff.selection;
    if (!selection?.id || selection.action !== "update" || !selection.patch) continue;
    const patch = byId.get(selection.id) ?? {};
    Object.assign(patch, selection.patch);
    byId.set(selection.id, patch);
  }
  return [...byId.entries()]
    .map(([id, patch]) => ({ id, patch }))
    .filter((entry) => Object.keys(entry.patch).length > 0);
}

function selectionToRejectedChange(selection?: ApprovalDiffSelection): ApprovalRejectedChange {
  return {
    table: projectTableName(selection?.table || "text"),
    id: selection?.id || "",
    field: selection?.field,
    summary: selection?.summary || "未批准的表格修改"
  };
}

function appendRejectedApprovalChanges(result: unknown, rejectedChanges: ApprovalRejectedChange[]): Record<string, unknown> {
  const parsed = parseToolResult(result);
  const base = parsed ?? { ok: true, result };
  const rejectedSummary = rejectedChanges
    .slice(0, 12)
    .map((entry) => compactParts([entry.summary, entry.field ? `字段：${fieldLabel(entry.field)}` : ""]))
    .join("；");
  const suffix = `用户在审批窗口只批准了部分修改；以下 ${rejectedChanges.length} 项是用户手动驳回的修改，不应视为已执行，也不要再次假定用户同意：${rejectedSummary}${rejectedChanges.length > 12 ? " 等" : ""}`;
  return {
    ...base,
    partialApproval: true,
    approvalDecision: "partial_user_approval",
    rejectionSource: "user",
    rejectedBy: "user",
    rejectedChanges,
    userRejectedChanges: rejectedChanges,
    summary: compactParts([typeof base.summary === "string" ? base.summary : "", suffix])
  };
}

function projectTableName(table: string): string {
  if (table === "text" || table === "project.text") return "project.text";
  if (table === "characters" || table === "project.characters") return "project.characters";
  if (table === "glossary" || table === "project.glossary") return "project.glossary";
  if (table === "noTranslate" || table === "project.noTranslate") return "project.noTranslate";
  return table || "project.text";
}

function buildResourceRowsByTable(analysis: AnalysisResult): Map<string, Map<string, Record<string, unknown>>> {
  return new Map([
    ["characters", new Map(analysis.characters.map((entry) => [entry.id, entry as unknown as Record<string, unknown>]))],
    ["glossary", new Map(analysis.glossary.map((entry) => [entry.id, entry as unknown as Record<string, unknown>]))],
    ["noTranslate", new Map(analysis.noTranslate.map((entry) => [entry.id, entry as unknown as Record<string, unknown>]))]
  ]);
}

function lookupMapRow<T>(rows: Map<string, T>, id: string): T | undefined {
  const candidates = rowIdCandidates(id);
  for (const candidate of candidates) {
    const row = rows.get(candidate);
    if (row) return row;
  }
  return undefined;
}

function lookupTextItem(textItemsById: Map<string, TextItem>, id: string): TextItem | undefined {
  return lookupMapRow(textItemsById, id);
}

function rowIdCandidates(id: string): string[] {
  const trimmed = id.trim();
  const candidates = new Set<string>();
  if (trimmed) candidates.add(trimmed);
  const knownId = trimmed.match(/\b(txt_\d+|char_\d+|term_\d+|nt_\d+|issue_\d+)\b/i)?.[1];
  if (knownId) candidates.add(knownId);
  const lastSegment = trimmed.split(/[./:#]/).filter(Boolean).at(-1);
  if (lastSegment) candidates.add(lastSegment);
  return [...candidates];
}

function textFallbackTitle(id: string, patch: Record<string, unknown>): string {
  return textApprovalRowTitle(rowIdCandidates(id)[0] || id || "[未指定ID]", textOriginalFromPatchOrId(id, patch));
}

function textApprovalRowTitle(id: string, original: string): string {
  const displayId = rowIdCandidates(id)[0] || id || "[未指定ID]";
  const displayOriginal = original.trim() ? original.trim() : "[未读取原文]";
  return `[${displayId}] - ${previewInlineText(displayOriginal, 100)}`;
}

function textOriginalFromPatchOrId(_id: string, patch: Record<string, unknown>): string {
  const original = stringValue(patch.original ?? patch.source ?? patch.originalText ?? patch.text);
  if (original) return original;
  return "";
}

function resourceDiffTitle(table: string, id: string, row?: Record<string, unknown>): string {
  const label = resourceRowLabel(row, id || "[未指定]");
  return `${tableLabel(table)}「${label}」`;
}

function resourceRowLabel(row: Record<string, unknown> | undefined, fallback: string): string {
  if (!row) return fallback;
  const candidates = [row.source, row.target, row.marker, row.familyName, row.givenName, row.note]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  return previewInlineText(candidates[0] || fallback, 80);
}

function resourcePatchLabel(patch: Record<string, unknown>, fallback: string): string {
  const candidates = [patch.source, patch.target, patch.marker, patch.familyName, patch.familyNameTranslation, patch.givenName, patch.givenNameTranslation, patch.note]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  return previewInlineText(candidates[0] || fallback || "未指定", 80);
}

function bulkUpdateEntries(args: Record<string, unknown>): Array<{ id: string; patch: Record<string, unknown> }> {
  for (const value of [args.updates, args.items, args.rows, args.changes, args.update, args]) {
    const normalized = normalizeBulkUpdateValue(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function replaceFieldEntries(args: Record<string, unknown>, table: string): string[] {
  const fields = stringArrayValue(args.fields);
  const field = stringValue(args.field);
  const output = fields.length ? fields : field ? [field] : defaultReplaceFields(table);
  return [...new Set(output)];
}

function defaultReplaceFields(table: string): string[] {
  if (table === "text") return ["translation"];
  if (table === "noTranslate") return ["marker"];
  return ["target"];
}

function replacementEntries(args: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(args.replacements) ? args.replacements.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function replacementRulesSummary(args: Record<string, unknown>): string {
  const rules = replacementEntries(args);
  if (!rules.length) return "替换规则未指定";
  return rules
    .slice(0, 4)
    .map((rule) => {
      const from = stringValue(rule.from) || "[空]";
      const to = stringValue(rule.to);
      const prefix = rule.regex === true ? "正则" : "替换";
      return `${prefix}「${previewInlineText(from, 28)}」→「${previewInlineText(to, 28)}」`;
    })
    .join("，") + (rules.length > 4 ? " 等" : "");
}

function applyPreviewReplacementRules(value: string, rules: Array<Record<string, unknown>>): string {
  return rules.reduce((output, rule) => applyPreviewReplacement(output, rule), value);
}

function applyPreviewReplacement(value: string, rule: Record<string, unknown>): string {
  const from = decodeReplacementEscapes(stringValue(rule.from));
  if (!from) return value;
  const to = decodeReplacementEscapes(stringValue(rule.to));
  const caseSensitive = rule.caseSensitive !== false;
  const wholeWord = rule.wholeWord === true;
  if (rule.regex === true) {
    try {
      return value.replace(new RegExp(from, caseSensitive ? "gu" : "giu"), to);
    } catch {
      return value;
    }
  }
  if (caseSensitive && !wholeWord) return value.split(from).join(to);
  const source = wholeWord ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(from)}(?![\\p{L}\\p{N}_])` : escapeRegExp(from);
  return value.replace(new RegExp(source, caseSensitive ? "gu" : "giu"), to);
}

function decodeReplacementEscapes(value: string): string {
  return value
    .replace(/\\r\\n/g, "\r\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function deleteIdEntries(args: Record<string, unknown>): string[] {
  const values = [args.ids, args.id, args.items, args.rows].flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
}

function stringArrayValue(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

function normalizeBulkUpdateValue(value: unknown): Array<{ id: string; patch: Record<string, unknown> }> {
  if (Array.isArray(value)) return value.map(normalizeBulkUpdateEntry).filter((entry): entry is { id: string; patch: Record<string, unknown> } => Boolean(entry));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["updates", "items", "rows", "changes", "update"]) {
    if (Array.isArray(record[key])) return normalizeBulkUpdateValue(record[key]);
  }
  if (typeof record.id === "string") {
    const entry = normalizeBulkUpdateEntry(record);
    return entry ? [entry] : [];
  }
  return Object.entries(record)
    .filter(([, patch]) => patch && typeof patch === "object" && !Array.isArray(patch))
    .map(([id, patch]) => ({ id, patch: patch as Record<string, unknown> }));
}

function normalizeBulkUpdateEntry(value: unknown): { id: string; patch: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  const patch = recordValue(record.patch);
  if (Object.keys(patch).length) return { id: record.id, patch };
  const directPatch = { ...record };
  delete directPatch.id;
  delete directPatch.table;
  return { id: record.id, patch: directPatch };
}

function stringifyDiffValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function BackendTrace({ events }: { events: ProgramAiIoEvent[] }) {
  return (
    <div className="messages backend-trace">
      {!events.length ? (
        <div className="chat-empty">
          <strong>暂无后台调用</strong>
          <p>这里显示分析、翻译、校对、提取方案等程序任务发给 AI 的提示词，以及 AI 对程序的原始回复。</p>
        </div>
      ) : (
        events.map((event) => <ProgramAiIoCard event={event} key={event.id} />)
      )}
    </div>
  );
}

function ClearThreadButton({ disabled }: { disabled: boolean }) {
  const thread = useThreadRuntime();
  return (
    <AppTooltip content="清空聊天">
      <button
        className="icon-button"
        aria-label="清空聊天"
        disabled={disabled}
        onClick={() => {
          void window.bgt.clearAgentChatHistory();
          thread.reset();
        }}
      >
        <Trash2 size={16} />
      </button>
    </AppTooltip>
  );
}

function createClientRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAgentCancelledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AGENT_RUN_CANCELLED") || message.includes("AbortError") || message.includes("aborted") || message.includes("cancelled");
}

function createWorkspaceThreadHistoryAdapter(): ThreadHistoryAdapter {
  return {
    async load() {
      return loadThreadHistory();
    },
    async append(item) {
      await window.bgt.appendAgentChatHistory(serializeHistoryItem(item));
    }
  };
}

async function loadThreadHistory(): Promise<ExportedMessageRepository> {
  try {
    const parsed = await window.bgt.loadAgentChatHistory();
    return {
      headId: parsed.headId ?? historyMessageId(parsed.messages.at(-1)?.message),
      messages: (parsed.messages ?? []).map((item) => reviveHistoryItem(item as ExportedMessageRepositoryItem))
    };
  } catch {
    return { headId: null, messages: [] };
  }
}

function historyMessageId(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function serializeHistoryItem(item: ExportedMessageRepositoryItem): ExportedMessageRepositoryItem {
  return item;
}

function reviveHistoryItem(item: ExportedMessageRepositoryItem): ExportedMessageRepositoryItem {
  return {
    ...item,
    message: reviveThreadMessage(item.message)
  };
}

function reviveThreadMessage(message: ThreadMessage): ThreadMessage {
  const revived = {
    ...message,
    createdAt: message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt)
  } as ThreadMessage;
  if (revived.role === "assistant" && revived.status?.type === "running") {
    return {
      ...revived,
      status: { type: "complete", reason: "unknown" }
    } as ThreadMessage;
  }
  return revived;
}

function dispatchAgentEvent(subscriber: AgentSubscriber, event: AgentEvent) {
  switch (event.type) {
    case "RUN_FINISHED":
      subscriber.onRunFinalized?.();
      break;
    case "RUN_ERROR":
      subscriber.onRunFailed?.({ error: new Error(typeof event.message === "string" ? event.message : "AI 运行失败。") });
      break;
    case "RUN_CANCELLED":
      subscriber.onCustomEvent?.({ event });
      break;
    case "TEXT_MESSAGE_START":
      subscriber.onTextMessageStartEvent?.({ event });
      break;
    case "TEXT_MESSAGE_CONTENT":
      subscriber.onTextMessageContentEvent?.({ event });
      break;
    case "TEXT_MESSAGE_END":
      subscriber.onTextMessageEndEvent?.({ event });
      break;
    case "TOOL_CALL_START":
      subscriber.onToolCallStartEvent?.({ event });
      break;
    case "TOOL_CALL_ARGS":
      subscriber.onToolCallArgsEvent?.({ event });
      break;
    case "TOOL_CALL_END":
      subscriber.onToolCallEndEvent?.({ event });
      break;
    case "TOOL_CALL_RESULT":
      subscriber.onToolCallResultEvent?.({ event });
      break;
    case "STATE_SNAPSHOT":
      subscriber.onStateSnapshotEvent?.({ event });
      break;
    case "STATE_DELTA":
      subscriber.onStateDeltaEvent?.({ event });
      break;
    case "MESSAGES_SNAPSHOT":
      subscriber.onMessagesSnapshotEvent?.({ event });
      break;
    default:
      subscriber.onCustomEvent?.({ event: { ...event, type: "CUSTOM", name: event.type ?? "CUSTOM", value: event } });
      break;
  }
}

function dispatchAgentEventOnce(subscriber: AgentSubscriber, event: AgentEvent, dispatchedSequences: Set<number>) {
  const sequence = eventSequence(event);
  if (sequence !== null) {
    if (dispatchedSequences.has(sequence)) return;
    dispatchedSequences.add(sequence);
  }
  dispatchAgentEvent(subscriber, event);
}

function dispatchReturnedEvents(subscriber: AgentSubscriber, events: unknown[], dispatchedSequences: Set<number>) {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const agentEvent = event as AgentEvent;
    if (eventSequence(agentEvent) === null && !isTerminalAgentEvent(agentEvent)) continue;
    dispatchAgentEventOnce(subscriber, agentEvent, dispatchedSequences);
  }
}

function eventSequence(event: AgentEvent): number | null {
  return typeof event.sequence === "number" ? event.sequence : null;
}

function isTerminalAgentEvent(event: AgentEvent): boolean {
  return event.type === "RUN_FINISHED" || event.type === "RUN_ERROR" || event.type === "RUN_CANCELLED";
}

function ProgramAiIoCard({ event }: { event: ProgramAiIoEvent }) {
  return (
    <div className={event.ok ? "program-io-card" : "program-io-card failed"}>
      <div className="program-io-title">
        <strong>{event.title}</strong>
        <span>{formatTime(event.createdAt)}</span>
      </div>
      {event.error ? <div className="program-io-error">{event.error}</div> : null}
      <ProgramIoBlock title="程序提示词" content={formatRequestMessages(event.requestMessages)} />
      <ProgramIoBlock title="AI 回复程序" content={event.responseContent || "[空回复]"} />
    </div>
  );
}

function ProgramIoBlock({ title, content }: { title: string; content: string }) {
  const collapsible = shouldCollapseProgramMessage(content);
  const [expanded, setExpanded] = useState(!collapsible);
  const display = expanded ? content : previewProgramMessage(content);
  return (
    <div className="program-io-block">
      <div className="program-io-block-title">
        <span>{title}</span>
      </div>
      <div className="program-io-content">
        <pre>{display}</pre>
        {collapsible ? (
          <button className="program-io-toggle" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "折叠" : "展开"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatRequestMessages(messages: ProgramAiIoEvent["requestMessages"]): string {
  return messages.map((message) => `${message.role.toUpperCase()}\n${message.content}`).join("\n\n---\n\n");
}

function summarizeToolResult(result: unknown): string {
  const data = parseToolResult(result);
  if (!data) return "";
  if (typeof data.summary === "string") return data.summary;
  const total = typeof data.total === "number" ? data.total : undefined;
  const returned = typeof data.returned === "number" ? data.returned : Array.isArray(data.rows) ? data.rows.length : undefined;
  if (total !== undefined && returned !== undefined) return `找到 ${total} 条，当前返回 ${returned} 条。`;
  if (typeof data.ok === "boolean") return data.ok ? "操作已完成。" : String(data.error ?? "操作失败。");
  return "";
}

function toolInlineSummary(toolName: string, args: Record<string, unknown>, result: unknown, textItemsById: Map<string, TextItem>): string {
  const operation = describeToolOperation(toolName, args, textItemsById);
  const resultSummary = toolResultMetricSummary(toolName, result);
  return previewInlineText([operation, resultSummary].filter(Boolean).join("，"), 120);
}

function parseToolResult(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return { summary: result };
    }
  }
  return null;
}

function hasCompleteToolArgs(args: unknown, argsText: string): boolean {
  if (args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0) return true;
  if (!argsText.trim()) return false;
  try {
    const parsed = JSON.parse(argsText);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function formatErrorDetail(value: unknown): string {
  if (value instanceof Error) return [value.message, value.stack].filter(Boolean).join("\n\n");
  if (typeof value === "string") return value;
  return formatToolPayload(value);
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function toolErrorText(result: unknown, isError?: boolean): string {
  const parsed = parseToolResult(result);
  if (parsed && parsed.ok === false) {
    return [
      typeof parsed.error === "string" ? parsed.error : "工具执行失败。",
      parsed.denied ? "权限模式拒绝了这次调用。" : "",
      parsed.rejected ? "用户拒绝了这次调用。" : ""
    ].filter(Boolean).join("\n");
  }
  if (isError) {
    return typeof result === "string" ? result : JSON.stringify(result ?? "工具执行失败。", null, 2);
  }
  return "";
}

function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    project_refresh: "刷新项目",
    table_search: "搜索表格",
    table_get: "读取表格行",
    table_add: "新增表格行",
    table_update: "修改表格行",
    table_replace: "替换表格文本",
    table_delete: "删除表格行",
    file_list: "列出文件",
    file_read: "读取文件",
    file_stat: "查看文件信息",
    file_write: "写入文件",
    file_patch: "应用文件补丁",
    file_delete: "删除文件",
    file_grep: "检索文件",
    source_lookup: "查看源文件位置",
    web_search: "网页搜索",
    web_extract: "读取网页",
    shell_run: "执行 Shell"
  };
  return labels[toolName] ?? toolName;
}

function approvalDescription(toolName: string, permissionMode: AiPermissionMode): string {
  if (toolName === "shell_run") return `AI 请求执行 Shell 命令。当前权限：${permissionLabel(permissionMode)}。`;
  if (toolName === "file_write") return `AI 请求写入文件。当前权限：${permissionLabel(permissionMode)}。`;
  if (toolName === "file_patch") return `AI 请求修改文件。当前权限：${permissionLabel(permissionMode)}。`;
  if (toolName === "file_delete") return `AI 请求删除文件。当前权限：${permissionLabel(permissionMode)}。`;
  if (toolName.startsWith("table_")) return "AI 请求修改项目表格。";
  return `AI 请求执行 ${toolLabel(toolName)}。`;
}

function describeToolOperation(toolName: string, args: Record<string, unknown>, textItemsById: Map<string, TextItem>): string {
  if (toolName === "project_refresh") return "刷新项目数据";
  if (toolName === "table_search") {
    return compactParts([
      tableLabel(tableName(args)),
      stringValue(args.query) ? `关键词「${previewInlineText(stringValue(args.query), 36)}」` : "",
      stringValue(args.status) ? `状态 ${textStatusLabel(stringValue(args.status))}` : "",
      stringValue(args.sourceFile ?? args.file) ? `文件 ${pathSummary(args.sourceFile ?? args.file)}` : "",
      args.emptyTranslation === true ? "空译文" : "",
      args.nonEmptyTranslation === true || args.hasTranslation === true ? "有译文" : "",
      numberSummary(args.offset, "从第"),
      numberSummary(args.limit, "最多")
    ]);
  }
  if (toolName === "table_get") {
    const table = tableName(args);
    return table === "text" ? `读取「${textOriginalLabel(textItemsById, stringValue(args.id))}」` : `读取${tableLabel(table)} ${stringValue(args.id) || "[未指定]"}`;
  }
  if (toolName === "table_update") {
    const table = tableName(args);
    const updates = bulkUpdateEntries(args);
    if (updates.length > 1 || "updates" in args || "items" in args || "rows" in args) {
      const previews = updates
        .slice(0, 5)
        .map((entry) => table === "text" ? `「${textOriginalLabel(textItemsById, entry.id, entry.patch)}」` : resourcePatchLabel(entry.patch, entry.id))
        .filter(Boolean)
        .join("、");
      return `批量修改 ${updates.length} 条${tableLabel(table)}：${previews}${updates.length > 5 ? " 等" : ""}`;
    }
    return table === "text"
      ? `修改文本行「${textOriginalLabel(textItemsById, stringValue(args.id), recordValue(args.patch))}」：${formatPatchSummary(args.patch)}`
      : `修改${tableLabel(table)}「${resourcePatchLabel(recordValue(args.patch), stringValue(args.id))}」：${formatPatchSummary(args.patch)}`;
  }
  if (toolName === "table_replace") {
    const table = tableName(args);
    const ids = deleteIdEntries(args);
    return `替换 ${ids.length} 条${tableLabel(table)}的${replaceFieldEntries(args, table).map(fieldLabel).join("、")}：${replacementRulesSummary(args)}`;
  }
  if (toolName === "table_delete") {
    const table = tableName(args);
    const ids = deleteIdEntries(args);
    if (ids.length > 1) {
      const previews = ids
        .slice(0, 5)
        .map((id) => table === "text" ? `「${textOriginalLabel(textItemsById, id)}」` : id)
        .join("、");
      return `批量删除 ${ids.length} 条${tableLabel(table)}：${previews}${ids.length > 5 ? " 等" : ""}`;
    }
    return table === "text"
      ? `删除文本行「${textOriginalLabel(textItemsById, ids[0] || stringValue(args.id))}」。`
      : `删除${tableLabel(table)} ${ids[0] || stringValue(args.id) || "[未指定]"}。`;
  }
  if (toolName === "table_add") return `新增 1 条${tableLabel(tableName(args))}。`;
  if (toolName === "file_list") {
    return compactParts([
      `路径 ${pathSummary(args.path)}`,
      args.recursive === true ? "递归" : "",
      numberSummary(args.limit, "最多")
    ]);
  }
  if (toolName === "file_read") {
    return compactParts([
      `路径 ${pathSummary(args.path)}`,
      numberSummary(args.maxBytes, "最多")
    ]);
  }
  if (toolName === "file_stat") {
    return compactParts([
      `路径 ${pathSummary(args.path)}`,
      args.hash === true ? "含哈希" : ""
    ]);
  }
  if (toolName === "file_grep") {
    return compactParts([
      `路径 ${pathSummary(args.path)}`,
      stringValue(args.pattern ?? args.query) ? `模式「${previewInlineText(stringValue(args.pattern ?? args.query), 36)}」` : "",
      args.regex === true ? "正则" : "",
      numberSummary(args.maxResults ?? args.limit, "最多")
    ]);
  }
  if (toolName === "file_write") return `写入文件 ${stringValue(args.path) || "[未指定]"}，约 ${stringValue(args.content).length} 字符。`;
  if (toolName === "file_patch") return `给文件 ${stringValue(args.path) || "[未指定]"} 应用补丁。`;
  if (toolName === "file_delete") return `删除文件或目录 ${stringValue(args.path) || "[未指定]"}。`;
  if (toolName === "source_lookup") return `查看文本行「${textOriginalLabel(textItemsById, stringValue(args.id))}」的源文件位置。`;
  if (toolName === "web_search") {
    return compactParts([
      `搜索「${previewInlineText(stringValue(args.query), 48)}」`,
      stringValue(args.engine) ? `引擎 ${stringValue(args.engine)}` : "",
      Array.isArray(args.engines) && args.engines.length ? `引擎 ${args.engines.map(String).join("、")}` : "",
      stringValue(args.searchMode) ? `模式 ${stringValue(args.searchMode)}` : "",
      numberSummary(args.limit, "最多")
    ]);
  }
  if (toolName === "web_extract") {
    return compactParts([
      `读取 ${previewInlineText(stringValue(args.url), 72)}`,
      stringValue(args.mode) ? `模式 ${stringValue(args.mode)}` : "",
      numberSummary(args.maxChars, "最多")
    ]);
  }
  if (toolName === "shell_run") return `执行 Shell：${stringValue(args.command) || "[未指定命令]"}`;
  return "";
}

function toolResultMetricSummary(toolName: string, result: unknown): string {
  const data = parseToolResult(result);
  if (!data) return "";
  const total = typeof data.total === "number" ? data.total : undefined;
  const returned = typeof data.returned === "number" ? data.returned : Array.isArray(data.rows) ? data.rows.length : undefined;
  const count = typeof data.count === "number" ? data.count : undefined;
  if (toolName === "table_search" && total !== undefined) {
    return returned !== undefined ? `${total} 条，返回 ${returned} 条` : `${total} 条`;
  }
  if (toolName === "table_search" && count !== undefined) return `${count} 条`;
  if (toolName === "table_replace" && count !== undefined) return `修改 ${count} 条`;
  if (toolName === "table_replace" && typeof data.changedCount === "number") return `修改 ${data.changedCount} 条`;
  if (toolName === "file_list" && count !== undefined) return `${count} 项`;
  if (toolName === "file_grep" && (total !== undefined || returned !== undefined)) return `${total ?? returned ?? 0} 处匹配`;
  if (toolName === "file_stat") {
    const type = typeof data.type === "string" ? data.type : data.exists === false ? "不存在" : "";
    const size = typeof data.size === "number" ? `${formatCompactNumber(data.size)} 字节` : "";
    return compactParts([type, size]);
  }
  if (toolName === "source_lookup") {
    const match = recordValue(data.match);
    return match.found === true ? "已定位原始片段" : "未精确匹配，返回源文件片段";
  }
  if (toolName === "web_search") {
    return returned !== undefined ? `返回 ${returned} 条` : "";
  }
  if (toolName === "web_extract") {
    const length = typeof data.contentLength === "number" ? `${formatCompactNumber(data.contentLength)} 字符` : "";
    const mode = typeof data.mode === "string" ? data.mode : "";
    return compactParts([mode === "browser" ? "浏览器提取" : mode === "request" ? "请求提取" : "", data.truncated === true && length ? `${length}，已截断` : length]);
  }
  if (toolName === "project_refresh") return "已刷新";
  if (toolName === "file_read") {
    const size = typeof data.size === "number" ? `${formatCompactNumber(data.size)} 字节` : "";
    return data.truncated === true && size ? `${size}，已截断` : size;
  }
  return "";
}

function formatPatchSummary(value: unknown): string {
  const patch = recordValue(value);
  const entries = Object.entries(patch);
  if (!entries.length) return "无字段";
  return entries
    .slice(0, 4)
    .map(([key, fieldValue]) => `${fieldLabel(key)}=${previewValue(fieldValue)}`)
    .join("，") + (entries.length > 4 ? " 等" : "");
}

function textOriginalLabel(textItemsById: Map<string, TextItem>, id: string, fallbackPatch?: Record<string, unknown>): string {
  if (!id) return "未指定文本";
  const item = lookupTextItem(textItemsById, id);
  if (!item) return previewInlineText(textOriginalFromPatchOrId(id, fallbackPatch ?? {}) || rowIdCandidates(id)[0] || id, 90);
  return previewInlineText(item.original || item.translation || "空文本", 90);
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    original: "原文",
    translation: "译文",
    status: "状态",
    target: "译名",
    source: "原名",
    familyName: "姓",
    familyNameTranslation: "姓氏译名",
    givenName: "名",
    givenNameTranslation: "名字译名",
    nicknameOf: "本名角色",
    marker: "禁翻标记",
    isRegex: "正则",
    category: "分类",
    sourceFile: "文件",
    locator: "定位",
    note: "备注",
    description: "说明",
    enabled: "启用"
  };
  return labels[key] ?? key;
}

function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return previewInlineText(text, 60);
}

function previewInlineText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactParts(parts: string[]): string {
  return parts.filter(Boolean).join("，");
}

function numberSummary(value: unknown, prefix: string): string {
  return typeof value === "number" && Number.isFinite(value) ? `${prefix} ${value}` : "";
}

function pathSummary(value: unknown): string {
  const pathValue = stringValue(value) || ".";
  return previewInlineText(pathValue, 44);
}

function textStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    extracted: "未翻译",
    translated: "已翻译",
    failed: "失败",
    needs_review: "需复核",
    excluded: "已排除"
  };
  return labels[value] ?? value;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function isDataChangedToolResult(result: unknown): boolean {
  const parsed = parseToolResult(result);
  return parsed?.dataChanged === true;
}

function analysisTableLabel(value: string): string {
  if (value === "characters" || value === "project.characters") return "人物表";
  if (value === "glossary" || value === "project.glossary") return "术语表";
  if (value === "noTranslate" || value === "project.noTranslate") return "禁翻表";
  return "资源表";
}

function tableLabel(value: string): string {
  if (value === "text" || value === "project.text") return "文本表";
  return analysisTableLabel(value);
}

function tableName(args: Record<string, unknown>): string {
  const table = stringValue(args.table);
  if (table === "project.text") return "text";
  if (table === "project.characters") return "characters";
  if (table === "project.glossary") return "glossary";
  if (table === "project.noTranslate") return "noTranslate";
  return table || "text";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function permissionLabel(mode: AiPermissionMode): string {
  if (mode === "workspace") return "工作区访问";
  if (mode === "unrestricted") return "无限制";
  return "受限";
}

function lineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

function shouldCollapseProgramMessage(value: string): boolean {
  return lineCount(value) > 12 || value.length > 1400;
}

function previewProgramMessage(value: string): string {
  const lines = value.split(/\r?\n/);
  if (lines.length > 12) return lines.slice(0, 12).join("\n");
  return value.slice(0, 1400);
}

function formatDeepSeekBalance(balance: AiBalanceSnapshot): string {
  return `DeepSeek 余额：${balance.balances.map((entry) => `${currencyPrefix(entry.currency)}${entry.totalBalance}`).join(" / ")}`;
}

function currencyPrefix(currency: "CNY" | "USD"): string {
  return currency === "USD" ? "$" : "¥";
}

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
