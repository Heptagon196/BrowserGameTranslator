import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as RadixTabs from "@radix-ui/react-tabs";
import { Maximize2, MessageSquare, Minimize2, PanelRightClose, Upload } from "lucide-react";
import type { AiBalanceSnapshot, AiPermissionMode, AiShellAuthorizationRequest, ChatMessage } from "../../../shared/types";
import { CommandSelect } from "../ui/Selectors";
import { AppTooltip, StyledSelect } from "../ui/Primitives";
export default function AIChatPanel({
  messages,
  disabled,
  busy,
  programBusy,
  selectedModelId,
  modelOptions,
  onModelChange,
  aiBalance,
  permissionMode,
  onPermissionModeChange,
  fullscreen,
  onToggleFullscreen,
  onCollapse,
  shellAuthorizationRequest,
  onShellAuthorizationResponse,
  onResizeStart,
  onSend,
  onClear
}: {
  messages: ChatMessage[];
  disabled: boolean;
  busy: boolean;
  programBusy: boolean;
  selectedModelId?: string;
  modelOptions: Array<{ id: string; label: string }>;
  onModelChange: (modelId: string) => void;
  aiBalance: AiBalanceSnapshot | null;
  permissionMode: AiPermissionMode;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onCollapse: () => void;
  shellAuthorizationRequest: AiShellAuthorizationRequest | null;
  onShellAuthorizationResponse: (id: string, allowed: boolean) => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSend: (content: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"chat" | "io">("chat");
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
  const chatMessages = messages.filter((message) => message.kind !== "program_prompt" && message.kind !== "program_response");
  const ioMessages = messages.filter((message) => message.kind === "program_prompt" || message.kind === "program_response");
  const visibleMessages = activeTab === "chat" ? chatMessages : ioMessages;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeTab, visibleMessages.length, busy, programBusy, shellAuthorizationRequest?.id]);

  const submit = () => {
    if (!draft.trim() || disabled || busy) return;
    onSend(draft);
    setDraft("");
  };
  return (
    <aside className="chat-panel">
      <div className="chat-resize-handle" onPointerDown={onResizeStart} />
      <div className="chat-title">
        <div>
          <MessageSquare size={18} />
          <span>AI</span>
          {aiBalance?.balances.length ? <span className="chat-cost">{formatDeepSeekBalance(aiBalance)}</span> : null}
        </div>
        <div className="chat-title-actions">
          <button className="icon-text-button" disabled={!messages.length || busy || programBusy} onClick={onClear}>
            清空
          </button>
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
        <RadixTabs.Trigger value="io" className={activeTab === "io" ? "active" : ""}>
          后台
          {ioMessages.length ? <span>{ioMessages.length}</span> : null}
        </RadixTabs.Trigger>
      </RadixTabs.List>
      </RadixTabs.Root>
      <div className="messages">
        {visibleMessages.map((message) => (
          <ChatBubble message={message} key={message.id} />
        ))}
        {!visibleMessages.length && activeTab === "chat" && (
          <div className="chat-empty">
            <strong>和 AI 讨论翻译</strong>
            <p>你可以像网页 AI 一样提问。需要固定影响翻译流程的规则，请到提示词页配置。</p>
          </div>
        )}
        {!visibleMessages.length && activeTab === "io" && (
          <div className="chat-empty">
            <strong>暂无后台记录</strong>
            <p>程序向 AI 发出的翻译请求和收到的回复会在完成后成对显示。</p>
          </div>
        )}
        {activeTab === "chat" && (busy || programBusy) && (
          <div className="chat-inline-status">{programBusy ? "程序翻译进行中，新的用户消息会排队优先处理..." : "正在回复..."}</div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input">
        <textarea
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "打开项目后可介入翻译任务" : programBusy ? "翻译进行中也可以发送，当前输出结束后会优先处理" : "输入消息，Enter 发送，Shift+Enter 换行"}
        />
        <div className="chat-input-actions">
          <CommandSelect
            disabled={!selectedModelId || !modelOptions.length || busy || programBusy}
            value={selectedModelId || ""}
            options={modelOptions}
            placeholder="选择 AI 模型"
            emptyText="没有可用模型"
            onChange={onModelChange}
          />
          <div className="chat-send-row">
            <StyledSelect
              className="permission-select"
              value={permissionMode}
              options={[
                { value: "restricted", label: "受限模式" },
                { value: "workspace", label: "工作区访问" },
                { value: "full", label: "完全访问" }
              ]}
              onChange={(value) => onPermissionModeChange(value as AiPermissionMode)}
            />
            <button disabled={disabled || busy || !draft.trim()} onClick={submit}>
              <Upload size={16} />
              发送
            </button>
          </div>
        </div>
      </div>
      {shellAuthorizationRequest && (
        <div className="shell-auth-panel">
          <div>
            <strong>AI 请求执行 Shell</strong>
            <p>{permissionModeLabel(shellAuthorizationRequest.permissionMode)}</p>
          </div>
          <label>
            命令
            <pre>{shellAuthorizationRequest.command}</pre>
          </label>
          <div className="shell-auth-actions">
            <button className="danger-button" onClick={() => onShellAuthorizationResponse(shellAuthorizationRequest.id, true)}>
              允许执行
            </button>
            <button className="secondary-button" onClick={() => onShellAuthorizationResponse(shellAuthorizationRequest.id, false)}>
              拒绝
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const defaultCollapsed =
    message.origin === "program" &&
    (message.kind === "program_prompt" || message.kind === "program_response") &&
    shouldCollapseProgramMessage(message.content);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const content = collapsed ? previewProgramMessage(message.content) : message.content;
  return (
    <div className={`message ${message.role} ${message.origin === "program" ? "program-message" : ""}`}>
      <span>{chatRoleLabel(message)} · {formatTime(message.createdAt)}</span>
      <MarkdownContent content={content} />
      {defaultCollapsed && (
        <button className="link-button collapse-toggle" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? `展开全部（${lineCount(message.content)} 行）` : "收起"}
        </button>
      )}
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} rel="noreferrer" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function chatRoleLabel(message: ChatMessage): string {
  if (message.kind === "program_prompt") return "程序提示词";
  if (message.kind === "program_response") return "AI 响应程序";
  if (message.kind === "program_summary") return "系统";
  return message.role === "assistant" ? "AI" : message.role === "system" ? "系统" : "你";
}

function permissionModeLabel(mode: AiPermissionMode): string {
  if (mode === "workspace") return "可操作当前项目工作区文件";
  if (mode === "full") return "可操作任意路径文件";
  return "只可操作项目结构化数据";
}

function formatDeepSeekBalance(balance: AiBalanceSnapshot): string {
  return `DeepSeek 余额：${balance.balances.map((entry) => `${currencyPrefix(entry.currency)}${entry.totalBalance}`).join(" / ")}`;
}

function currencyPrefix(currency: "CNY" | "USD"): string {
  return currency === "USD" ? "$" : "¥";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  return `${value.slice(0, 1400)}\n...`;
}




