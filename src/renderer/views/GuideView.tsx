import {
  Archive,
  Bot,
  BookOpen,
  CheckCircle2,
  FileSearch,
  FolderOpen,
  Languages,
  MessageSquare,
  Play,
  ScanText,
  Settings,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { ReactNode } from "react";

type GuideTarget = "project" | "settings" | "import" | "analysis" | "dictionary" | "translate" | "proofread" | "prompts";

interface GuideViewProps {
  hasProject: boolean;
  onNavigate: (view: GuideTarget) => void;
}

const workflow = [
  {
    title: "打开项目",
    body: "选择已下载的网页游戏目录。首次打开会创建 .bgt 工作区，并保存 original 原始快照。",
    icon: FolderOpen,
    target: "project" as const
  },
  {
    title: "配置 AI",
    body: "在设置里填 API Key、供应商、模型和请求地址。翻译模型与右侧 AI 介入模型可以分开。",
    icon: Settings,
    target: "settings" as const
  },
  {
    title: "提取文本",
    body: "先扫描候选文本和规则组，再确认哪些规则进入正式文本表，避免把代码误当对白。",
    icon: ScanText,
    target: "import" as const
  },
  {
    title: "整理词典",
    body: "维护人物、术语和禁翻表。项目词典、全局词典和在线词典可以互相导入导出。",
    icon: BookOpen,
    target: "dictionary" as const
  },
  {
    title: "翻译校对",
    body: "批量翻译后用语言、术语和规则检查定位问题；必要时让 AI 自动校对选中行。",
    icon: Languages,
    target: "translate" as const
  },
  {
    title: "预览打包",
    body: "把译文安全写回项目，预览网页游戏，最后打成 zip/7z/tar.xz，可附带 Windows 启动器。",
    icon: Archive,
    target: "project" as const
  }
];

export default function GuideView({ hasProject, onNavigate }: GuideViewProps) {
  return (
    <div className="guide-page">
      <section className="guide-hero">
        <div className="guide-hero-copy">
          <div className="guide-eyebrow"><Sparkles size={16} />快速上手</div>
          <h2>把离线网页游戏翻译成可交付版本</h2>
          <p>
            BrowserGameTranslator 的核心流程是：创建项目、提取文本、整理词典、批量翻译、校对写回、预览打包。每一步都会保留项目文件，方便回滚、协作和继续处理。
          </p>
          <div className="guide-hero-actions">
            <button onClick={() => onNavigate("project")}><FolderOpen size={17} />{hasProject ? "查看当前项目" : "打开或创建项目"}</button>
            <button className="secondary-button" onClick={() => onNavigate("settings")}><Settings size={17} />配置 AI 后端</button>
          </div>
        </div>
        <div className="guide-hero-visual" aria-hidden="true">
          <div className="guide-window">
            <div className="guide-window-bar">
              <span />
              <span />
              <span />
            </div>
            <div className="guide-window-body">
              <div className="guide-mini-sidebar">
                <span className="active" />
                <span />
                <span />
                <span />
              </div>
              <div className="guide-mini-main">
                <div className="guide-mini-toolbar" />
                <div className="guide-mini-table">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="guide-mini-chat">
                <MessageSquare size={16} />
                <span />
                <span />
              </div>
            </div>
          </div>
          <div className="guide-hero-caption"><CheckCircle2 size={16} />结构化项目文件 + 可审批 AI 操作</div>
        </div>
      </section>

      <section className="guide-section">
        <div className="guide-section-title">
          <h3>推荐流程</h3>
          <p>按这个顺序走，最不容易把提取、词典、译文和回填状态弄乱。</p>
        </div>
        <div className="guide-workflow">
          {workflow.map((step, index) => {
            const Icon = step.icon;
            return (
              <button key={step.title} className="guide-step-card" onClick={() => onNavigate(step.target)}>
                <div className="guide-step-number">{index + 1}</div>
                <div className="guide-step-icon"><Icon size={22} /></div>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="guide-panel">
        <div className="guide-section-title">
          <h3>几个关键概念</h3>
          <p>理解这些文件和页面，后面排错会轻松很多。</p>
        </div>
        <div className="guide-concept-grid">
          <GuideConcept icon={<FolderOpen size={18} />} title=".bgt/original" text="原始快照。写回时以它为基线重建，避免在已翻译文件上重复替换。" />
          <GuideConcept icon={<FileSearch size={18} />} title="文本表" text="所有待翻译行的主表，包含原文、译文、来源文件和状态。" />
          <GuideConcept icon={<BookOpen size={18} />} title="词典表" text="人物、术语、禁翻三类资源会进入翻译和校对提示词。" />
          <GuideConcept icon={<ShieldCheck size={18} />} title="校对问题" text="规则检查生成的问题队列，可以逐项修复、忽略或交给 AI 校对。" />
          <GuideConcept icon={<Bot size={18} />} title="AI Agent" text="聊天式助手可以查表、搜索网页和修改资源；写操作需要审批。" />
          <GuideConcept icon={<Play size={18} />} title="预览与打包" text="预览用于本地测试，打包用于交付给玩家或测试人员。" />
        </div>
      </section>
    </div>
  );
}

function GuideConcept({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="guide-concept">
      <div className="guide-concept-icon">{icon}</div>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}
