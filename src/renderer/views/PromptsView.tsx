import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { AppStateSnapshot, PromptConfig, PromptScope } from "../../shared/types";

type TextPromptKey = Exclude<keyof PromptConfig, "translationRules">;
type PromptEditorKey = TextPromptKey | "translationRules";

const promptFields: Array<{ key: PromptEditorKey; title: string; description: string }> = [
  {
    key: "connectionTestSystem",
    title: "连接测试",
    description: "测试 API Key 和模型是否可用时发送给 AI 的提示词。"
  },
  {
    key: "analysisSystem",
    title: "分析",
    description: "AI 提取人名、术语和禁翻项时使用的提示词。"
  },
  {
    key: "aiLocalizationPlanSystem",
    title: "AI 提取/回填方案",
    description: "让 AI 根据本地游戏结构生成特化提取/回填方案时使用的提示词。"
  },
  {
    key: "translationSystem",
    title: "翻译",
    description: "批量翻译时使用的提示词，约束 AI 按逐行 textarea 结构输出译文。"
  },
  {
    key: "proofreadSystem",
    title: "AI 校对",
    description: "对校对问题执行 AI 自动修正时使用的提示词。"
  },
  {
    key: "translationRules",
    title: "翻译规则",
    description: "每行一条，会作为 userRules 发送给翻译任务。适合写固定术语、文风和禁翻要求。"
  }
];

export default function PromptsView({
  snapshot,
  run
}: {
  snapshot: AppStateSnapshot;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
}) {
  const defaultScope: PromptScope = snapshot.project ? "workspace" : "global";
  const [scope, setScope] = useState<PromptScope>(defaultScope);
  const [prompts, setPrompts] = useState<PromptConfig | null>(null);
  const [defaultPrompts, setDefaultPrompts] = useState<PromptConfig | null>(null);
  const [selectedPromptKey, setSelectedPromptKey] = useState<PromptEditorKey>(() => {
    const saved = localStorage.getItem("bgt.selectedPromptKey");
    return promptFields.some((field) => field.key === saved) ? (saved as PromptEditorKey) : promptFields[0].key;
  });
  const selectedPromptField = promptFields.find((field) => field.key === selectedPromptKey) ?? promptFields[0];

  useEffect(() => {
    setScope(snapshot.project ? "workspace" : "global");
  }, [snapshot.project?.projectRoot]);

  useEffect(() => {
    void run("读取提示词", () => window.bgt.loadPrompts(scope), setPrompts);
  }, [scope, snapshot.project?.projectRoot]);

  useEffect(() => {
    void window.bgt.loadDefaultPrompts().then(setDefaultPrompts);
  }, []);

  useEffect(() => {
    localStorage.setItem("bgt.selectedPromptKey", selectedPromptKey);
  }, [selectedPromptKey]);

  const commitPrompts = (next: PromptConfig) => {
    setPrompts(next);
    void window.bgt
      .savePrompts(scope, next)
      .then(setPrompts)
      .catch((error) => {
        console.error("Failed to save prompts.", error);
      });
  };

  const commitPromptValue = (key: PromptEditorKey, value: string) => {
    if (!prompts) return;
    const next =
      key === "translationRules"
        ? { ...prompts, translationRules: value.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean) }
        : { ...prompts, [key]: value };
    commitPrompts(next);
  };

  const resetSelectedPrompt = () => {
    if (!prompts || !defaultPrompts) return;
    const next =
      selectedPromptKey === "translationRules"
        ? { ...prompts, translationRules: [...defaultPrompts.translationRules] }
        : { ...prompts, [selectedPromptKey]: defaultPrompts[selectedPromptKey] };
    commitPrompts(next);
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="prompt-header">
          <div className="prompt-title-row">
            <div className="prompt-scope-switch" aria-label="提示词作用域">
              <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>
                全局提示词
              </button>
              <button disabled={!snapshot.project} className={scope === "workspace" ? "active" : ""} onClick={() => setScope("workspace")}>
                当前工作区提示词
              </button>
            </div>
          </div>
          <p>{scope === "workspace" ? "当前编辑工作区提示词。工作区提示词会优先用于当前项目。" : "当前编辑全局提示词。没有工作区提示词时会使用这里的配置。"}</p>
        </div>
        {!snapshot.project && <p className="settings-note">当前没有打开项目，因此只能编辑全局提示词。</p>}
      </div>
      {prompts ? (
        <div className="panel prompt-config-layout">
          <div className="prompt-list" aria-label="提示词列表">
            {promptFields.map((field) => (
              <button
                key={field.key}
                className={field.key === selectedPromptKey ? "prompt-list-row active" : "prompt-list-row"}
                onClick={() => setSelectedPromptKey(field.key)}
              >
                <strong>{field.title}</strong>
                <span>{field.description}</span>
              </button>
            ))}
          </div>
          <div className="prompt-editor">
            <div className="prompt-editor-heading">
              <div>
                <div className="prompt-editor-title-line">
                  <h2>{selectedPromptField.title}</h2>
                  <span className="prompt-scope-badge">{scope === "workspace" ? "工作区" : "全局"}</span>
                </div>
                <p>{selectedPromptField.description}</p>
              </div>
              <button className="secondary" disabled={!defaultPrompts} onClick={resetSelectedPrompt}>
                <RotateCcw size={16} />
                重置为默认
              </button>
            </div>
            <PromptTextEditor
              key={`${scope}:${selectedPromptKey}`}
              value={selectedPromptKey === "translationRules" ? prompts.translationRules.join("\n") : prompts[selectedPromptKey]}
              onCommit={(value) => commitPromptValue(selectedPromptKey, value)}
            />
            {selectedPromptKey === "translationRules" && <p className="settings-note">每行保存为一条独立规则，空行会被忽略。</p>}
          </div>
        </div>
      ) : (
        <div className="panel empty-state">
          <h2>正在读取提示词</h2>
          <p>如果没有全局或工作区配置，会显示软件内置默认提示词。</p>
        </div>
      )}
    </div>
  );
}

function PromptTextEditor({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <textarea
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
