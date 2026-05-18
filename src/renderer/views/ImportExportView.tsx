import React, { useState } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { Bot, Check, Download, FileSearch, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import type { AppStateSnapshot, ExtractionAiReviewProgress, ExtractionCandidate, ExtractionDecision, ExtractionRisk, ExtractionRuleGroup, ExtractionRuleMatcher, ExtractionScanProgress, ProviderConfig, TextItem } from "../../shared/types";
import { TextTable, type TableSettings } from "../components/table/DataTable";
import { BatchProgressDialog, type BatchProgressState } from "../components/ui/BatchProgressDialog";
import { AppDialog, CheckboxControl, ProgressBar, StyledSelect, ToggleSwitch } from "../components/ui/Primitives";
import { chunk, replaceItem } from "../appUtils";
export default function ImportExportView({
  busy,
  items,
  snapshot,
  provider,
  tableSettings,
  autoPatchBeforeOutput,
  onAutoPatchBeforeOutputChange,
  run,
  setSnapshot,
  saveItems
}: {
  busy: boolean;
  items: TextItem[];
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  tableSettings: TableSettings;
  autoPatchBeforeOutput: boolean;
  onAutoPatchBeforeOutputChange: (value: boolean) => void;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  saveItems: (items: TextItem[]) => Promise<TextItem[] | undefined>;
}) {
  const [mode, setMode] = useState<"extract" | "files" | "patch">("extract");
  const [exportFormat, setExportFormat] = useState<"jsonl" | "csv">("jsonl");
  const [scanProgress, setScanProgress] = useState<ExtractionScanProgress | null>(null);
  const [selectionProgress, setSelectionProgress] = useState<BatchProgressState | null>(null);
  const [rulePackageActionVersion, setRulePackageActionVersion] = useState(0);
  const scanBusy = busy || Boolean(scanProgress);

  React.useEffect(() => window.bgt.onExtractionScanProgress(setScanProgress), []);

  const ensureProjectRulePackageAvailable = async () => {
    const rulesFile = await window.bgt.listConfirmedExtractionRules();
    if (!rulesFile.rules.length) throw new Error("还没有可导出的项目提取规则。请先纳入规则组。");
  };
  const importProjectRulePackage = () => {
    void run(
      "导入规则包",
      async () => {
        const result = await window.bgt.importExtractionRulePackage("project", "overwrite");
        if (result.status !== "imported" || !result.package) return false;
        await window.bgt.applyExtractionRulePackageToProject(result.package);
        return true;
      },
      (imported) => {
        if (imported) setRulePackageActionVersion((value) => value + 1);
      }
    );
  };
  const exportProjectRulePackage = () => {
    void run("导出规则包", async () => {
      await ensureProjectRulePackageAvailable();
      const pkg = await window.bgt.createProjectExtractionRulePackage();
      return window.bgt.exportExtractionRulePackage(pkg);
    });
  };
  const saveProjectRulePackageToGlobal = () => {
    void run("保存规则包至全局", async () => {
      await ensureProjectRulePackageAvailable();
      const pkg = await window.bgt.createProjectExtractionRulePackage();
      return window.bgt.copyExtractionRulePackageToGlobal(pkg);
    });
  };

  const translateSelectedItems = async (selectedItems: TextItem[]) => {
    if (!provider || !snapshot.project) return;
    const activeItems = selectedItems.filter((item) => item.status !== "excluded");
    const batches = chunk(activeItems, 20);
    if (!batches.length) return;
    if (batches.length === 1) {
      const translated = await window.bgt.translateBatch(provider, snapshot.project.targetLanguage, activeItems);
      const byId = new Map(translated.map((item) => [item.id, item]));
      await saveItems(snapshot.textItems.map((item) => byId.get(item.id) ?? item));
      return;
    }

    let workingItems = snapshot.textItems;
    let processed = 0;
    try {
      for (const [index, batch] of batches.entries()) {
        setSelectionProgress({
          title: "翻译选中行",
          currentLabel: `正在翻译 ${batch.length} 行`,
          processed,
          total: activeItems.length,
          batchIndex: index + 1,
          batchTotal: batches.length
        });
        const translated = await window.bgt.translateBatch(provider, snapshot.project.targetLanguage, batch, {
          titlePrefix: `AI 翻译选中行（${activeItems.length} 行） `,
          batchIndexOffset: index,
          batchTotal: batches.length
        });
        const byId = new Map(translated.map((item) => [item.id, item]));
        workingItems = workingItems.map((item) => byId.get(item.id) ?? item);
        const saved = await saveItems(workingItems);
        workingItems = saved ?? workingItems;
        processed += batch.length;
        setSelectionProgress({
          title: "翻译选中行",
          currentLabel: `已完成 ${processed}/${activeItems.length} 行`,
          processed,
          total: activeItems.length,
          batchIndex: index + 1,
          batchTotal: batches.length
        });
      }
    } finally {
      setSelectionProgress(null);
    }
  };

  return (
    <div className="stack">
      <RadixTabs.Root value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
        <RadixTabs.List className="segmented workflow-tabs">
        <RadixTabs.Trigger value="extract" className={mode === "extract" ? "active" : ""}>
          提取规则
        </RadixTabs.Trigger>
        <RadixTabs.Trigger value="files" className={mode === "files" ? "active" : ""}>
          已提取文本
        </RadixTabs.Trigger>
        <RadixTabs.Trigger value="patch" className={mode === "patch" ? "active" : ""}>
          回填游戏
        </RadixTabs.Trigger>
        </RadixTabs.List>
      </RadixTabs.Root>

      {mode === "extract" && (
        <div className="panel workflow-panel workflow-panel-row">
          <div>
            <h2>提取规则</h2>
            <p>先扫描并确认规则组，再生成可翻译文本表。全局和在线规则包在“提取规则”页管理。</p>
          </div>
          <div className="workflow-actions workflow-actions-end">
            <button className="secondary-button" disabled={busy || !snapshot.project} onClick={importProjectRulePackage}><Upload size={16} />导入规则包</button>
            <button className="secondary-button" disabled={busy || !snapshot.project} onClick={exportProjectRulePackage}><Download size={16} />导出规则包</button>
            <button className="secondary-button" disabled={busy || !snapshot.project} onClick={saveProjectRulePackageToGlobal}><Save size={16} />保存规则包至全局</button>
          </div>
        </div>
      )}

      {mode === "extract" && (
        <ProjectExtractionRulesPanel busy={scanBusy} snapshot={snapshot} provider={provider} run={run} setSnapshot={setSnapshot} scanProgress={scanProgress} setScanProgress={setScanProgress} reloadToken={rulePackageActionVersion} />
      )}

      {mode === "files" && (
        <div className="panel workflow-panel">
          <div>
            <h2>已提取文本</h2>
            <p>查看、编辑、导入或导出当前项目已经生成的可翻译文本表。</p>
          </div>
          <div className="workflow-actions workflow-actions-split">
            <div className="export-inline">
              <StyledSelect
                value={exportFormat}
                options={[
                  { value: "jsonl", label: "JSONL" },
                  { value: "csv", label: "CSV" }
                ]}
                onChange={(value) => setExportFormat(value as "jsonl" | "csv")}
              />
              <button disabled={!items.length} onClick={() => run(`导出 ${exportFormat.toUpperCase()}`, () => window.bgt.exportTextItems(snapshot.textItems, exportFormat))}>
                <Download size={16} />
                导出
              </button>
            </div>
            <button disabled={!snapshot.project} onClick={() => run("导入翻译", () => window.bgt.importTextItems(), (next) => setSnapshot((state) => ({ ...state, textItems: next })))}>
              <Upload size={16} />
              导入译文
            </button>
          </div>
        </div>
      )}

      {mode === "files" && (
        <TextTable
          items={items}
          enableFileFilter
          tableSettings={tableSettings}
          onChange={(changed) => saveItems(replaceItem(snapshot.textItems, changed))}
          onBulkChange={async (nextItems) => {
            await saveItems(nextItems);
          }}
          onTranslateItems={
            provider && snapshot.project
              ? async (selectedItems) => {
                  await run("翻译选中行", () => translateSelectedItems(selectedItems));
                }
              : undefined
          }
        />
      )}
      {selectionProgress ? <BatchProgressDialog progress={selectionProgress} /> : null}

      {mode === "patch" && (
        <div className="panel workflow-panel">
          <div>
            <h2>回填游戏</h2>
            <p>把当前文本表中的译文写回游戏工作区，生成可预览、可打包的版本。</p>
          </div>
          <div className="auto-patch-toggle">
            <ToggleSwitch checked={autoPatchBeforeOutput} onChange={onAutoPatchBeforeOutputChange} title="预览、打包前自动回填" />
            <span>预览、打包前自动回填</span>
          </div>
          <div className="workflow-actions">
            <button disabled={busy || !items.length} onClick={() => void run("应用回游戏", () => window.bgt.applyPatch(snapshot.textItems))}>
              <Save size={16} />
              应用回游戏
            </button>
            <button
              className="secondary-button"
              disabled={busy || !snapshot.project}
              onClick={() => {
                if (!window.confirm("还原游戏会用 .bgt/original 覆盖项目根目录中的当前游戏文件，保留 .bgt。确定继续吗？")) return;
                void run("还原游戏", () => window.bgt.restoreGame(), (next) => setSnapshot(next));
              }}
            >
              <RotateCcw size={16} />
              还原游戏
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type GroupFilter = "all" | "pending" | "include" | "exclude" | "deleted";
type AiReviewDecision = "pending" | "include" | "exclude";

function ProjectExtractionRulesPanel({
  busy,
  snapshot,
  provider,
  run,
  setSnapshot,
  scanProgress,
  setScanProgress,
  reloadToken
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  scanProgress: ExtractionScanProgress | null;
  setScanProgress: React.Dispatch<React.SetStateAction<ExtractionScanProgress | null>>;
  reloadToken: number;
}) {
  const [groups, setGroups] = useState<ExtractionRuleGroup[]>([]);
  const [candidates, setCandidates] = useState<ExtractionCandidate[]>([]);
  const [confirmedRuleCount, setConfirmedRuleCount] = useState(0);
  const [aiReviewProgress, setAiReviewProgress] = useState<ExtractionAiReviewProgress | null>(null);
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [aiReviewDialogOpen, setAiReviewDialogOpen] = useState(false);
  const [rescanConfirmOpen, setRescanConfirmOpen] = useState(false);
  const [aiReviewScope, setAiReviewScope] = useState<Record<AiReviewDecision, boolean>>({
    pending: true,
    include: false,
    exclude: false
  });

  React.useEffect(() => {
    void reloadGroups();
  }, [snapshot.project?.projectRoot, reloadToken]);

  React.useEffect(() => window.bgt.onExtractionAiReviewProgress(setAiReviewProgress), []);

  const reloadGroups = async () => {
    if (!snapshot.project) return;
    const [nextGroups, nextCandidates, nextRules] = await Promise.all([
      window.bgt.listExtractionRuleGroups(),
      window.bgt.listExtractionCandidates(),
      window.bgt.listConfirmedExtractionRules()
    ]);
    setGroups(nextGroups);
    setCandidates(nextCandidates);
    setConfirmedRuleCount(nextRules.rules.length);
    const firstVisibleGroup = nextGroups.find((group) => group.userDecision.decision !== "deleted") ?? nextGroups[0];
    if (!selectedGroupId && firstVisibleGroup) setSelectedGroupId(firstVisibleGroup.id);
  };

  const activeGroups = groups.filter((group) => group.userDecision.decision !== "deleted");
  const filteredGroups = groups.filter((group) => {
    if (groupFilter === "pending") return group.userDecision.decision === "pending";
    if (groupFilter === "include") return group.userDecision.decision === "include";
    if (groupFilter === "exclude") return group.userDecision.decision === "exclude";
    if (groupFilter === "deleted") return group.userDecision.decision === "deleted";
    return group.userDecision.decision !== "deleted";
  });
  const selectedGroup = filteredGroups.find((group) => group.id === selectedGroupId) ?? filteredGroups[0];
  const selectedGroupSamples = selectedGroup ? selectedGroup.sampleCandidateIds.map((id) => candidates.find((candidate) => candidate.id === id)).filter(Boolean) as ExtractionCandidate[] : [];
  const includedCount = groups.filter((group) => group.userDecision.decision === "include").length;
  const hasExistingScanResult = Boolean(groups.length || candidates.length || confirmedRuleCount);

  const scan = () => {
    if (hasExistingScanResult) {
      setRescanConfirmOpen(true);
      return;
    }
    startScan();
  };

  const startScan = () => {
    const title = hasExistingScanResult ? "重新扫描" : "扫描项目";
    setScanProgress({
      phase: "enumerating",
      fileCurrent: 0,
      fileTotal: 0,
      fileProgress: 0,
      fileStep: "准备扫描",
      message: "正在准备扫描项目..."
    });
    void (async () => {
      try {
        await run(title, () => window.bgt.scanExtractionRules(), (result) => {
          setGroups(result.groups);
          setCandidates(result.candidates);
          setConfirmedRuleCount(result.groups.filter((group) => group.userDecision.decision === "include").length);
          const firstVisibleGroup = result.groups.find((group) => group.userDecision.decision !== "deleted") ?? result.groups[0];
          if (firstVisibleGroup) setSelectedGroupId(firstVisibleGroup.id);
        });
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      } finally {
        setScanProgress(null);
      }
    })();
  };

  const updateGroupDecision = (group: ExtractionRuleGroup, decision: ExtractionDecision) => {
    void run("保存规则组决策", () => window.bgt.saveExtractionRuleDecisions([{ groupId: group.id, decision }]), setGroups);
  };

  const runAiReview = () => {
    if (!provider) return;
    const decisions = (Object.entries(aiReviewScope) as Array<[AiReviewDecision, boolean]>)
      .filter(([, checked]) => checked)
      .map(([decision]) => decision);
    if (!decisions.length) return;
    setAiReviewDialogOpen(false);
    setAiReviewProgress({
      phase: "preparing",
      completedBatches: 0,
      totalBatches: 0,
      failedBatches: 0,
      targetGroupCount: 0,
      message: "正在准备 AI 智能排查..."
    });
    void (async () => {
      try {
        await run("AI 智能排查", () => window.bgt.reviewExtractionRulesWithAi(provider, { decisions }), (nextGroups) => {
          setGroups(nextGroups);
          const nextVisibleGroups = nextGroups.filter((group) => {
            if (groupFilter === "pending") return group.userDecision.decision === "pending";
            if (groupFilter === "include") return group.userDecision.decision === "include";
            if (groupFilter === "exclude") return group.userDecision.decision === "exclude";
            if (groupFilter === "deleted") return group.userDecision.decision === "deleted";
            return group.userDecision.decision !== "deleted";
          });
          if (!nextVisibleGroups.some((group) => group.id === selectedGroupId) && nextVisibleGroups[0]) {
            setSelectedGroupId(nextVisibleGroups[0].id);
          }
        });
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      } finally {
        setAiReviewProgress(null);
      }
    })();
  };

  const aiReviewProgressValue = aiReviewProgress?.totalBatches
    ? Math.min(100, (aiReviewProgress.completedBatches / aiReviewProgress.totalBatches) * 100)
    : aiReviewProgress?.phase === "done"
      ? 100
      : aiReviewProgress
        ? 2
        : 0;
  const aiReviewStatusText = aiReviewProgress
    ? aiReviewProgress.totalBatches
      ? `${aiReviewProgress.completedBatches}/${aiReviewProgress.totalBatches}`
      : `${aiReviewProgress.targetGroupCount} 组`
    : "";
  const aiReviewDetailText = aiReviewProgress
    ? aiReviewProgress.failedBatches
      ? `${aiReviewProgress.message} 失败 ${aiReviewProgress.failedBatches}`
      : aiReviewProgress.message
    : "";
  const scanProgressValue = scanProgress ? combinedScanProgressValue(scanProgress) : 0;
  const scanStatusText = scanProgress
    ? scanProgress.fileTotal
      ? `${Math.min(scanProgress.fileCurrent, scanProgress.fileTotal)}/${scanProgress.fileTotal}`
      : scanProgress.phase === "done"
        ? "完成"
        : "准备中"
    : "";
  const scanDetailText = scanProgress
    ? [scanProgress.message, scanProgress.currentFile, scanProgress.fileStep].filter(Boolean).join(" · ")
    : "";

  const materialize = () => {
    void run("使用项目规则生成文本表", () => window.bgt.materializeExtractionTextItems(), setSnapshot);
  };

  return (
    <div className="project-extraction-rules">
      <section className="panel dictionary-table-panel">
        <div className="table-toolbar dictionary-toolbar">
          <div>
            <h2>项目提取规则</h2>
            <p>{activeGroups.length} 个规则组 · 已纳入 {includedCount}</p>
          </div>
          <div className="dictionary-toolbar-actions">
            <button disabled={busy || !snapshot.project} onClick={scan}><FileSearch size={16} />{hasExistingScanResult ? "重新扫描" : "扫描项目"}</button>
            {scanProgress ? (
              <div className="translation-status-strip extraction-review-status-strip">
                <ProgressBar value={scanProgressValue} className={scanProgress.phase === "done" ? "inline-progress" : "inline-progress active"} />
                <span className="translation-count">{scanStatusText}</span>
                <span className="translation-model" title={scanDetailText}>{scanDetailText}</span>
              </div>
            ) : null}
            {groups.length ? <button className="secondary-button" disabled={busy || !provider || !activeGroups.length} onClick={() => setAiReviewDialogOpen(true)}><Bot size={16} />AI 智能排查</button> : null}
            {aiReviewProgress ? (
              <div className="translation-status-strip extraction-review-status-strip">
                <ProgressBar value={aiReviewProgressValue} className={aiReviewProgress.phase === "done" ? "inline-progress" : "inline-progress active"} />
                <span className="translation-count">{aiReviewStatusText}</span>
                <span className="translation-model" title={aiReviewDetailText}>{aiReviewDetailText}</span>
              </div>
            ) : null}
            <button disabled={busy || !includedCount} onClick={materialize}><Save size={16} />生成文本表</button>
          </div>
        </div>
        <div className="project-rules-body">
          <div className="project-rules-groups">
            <StyledSelect
              value={groupFilter}
              options={[
                { value: "all", label: "全部规则组" },
                { value: "include", label: "已纳入" },
                { value: "pending", label: "待复核" },
                { value: "exclude", label: "已排除" },
                { value: "deleted", label: "待删除" }
              ]}
              onChange={(value) => setGroupFilter(value as GroupFilter)}
            />
            <div className="dictionary-list">
              {filteredGroups.map((group) => (
                <button key={group.id} className={group.id === selectedGroup?.id ? "dictionary-list-item active" : "dictionary-list-item"} onClick={() => setSelectedGroupId(group.id)}>
                  <strong className="dictionary-list-title"><span>{group.label}</span></strong>
                  <span>{group.candidateCount} 条 · AI {group.ai.recommendation}</span>
                  <small>{decisionLabel(group.userDecision.decision)} · safe {group.backfillSummary.safe}</small>
                </button>
              ))}
              {!filteredGroups.length ? <p className="empty">暂无规则组</p> : null}
            </div>
          </div>
          <div className="project-rules-detail">
            {selectedGroup ? (
              <>
                <div className="rules-detail-heading">
                  <div>
                    <h3>{selectedGroup.label}</h3>
                    <p>{selectedGroup.ai.reason}</p>
                  </div>
                </div>
                <div className="dictionary-toolbar-actions">
                  <button disabled={busy} onClick={() => updateGroupDecision(selectedGroup, "include")}><Check size={16} />纳入</button>
                  <button className="secondary-button" disabled={busy} onClick={() => updateGroupDecision(selectedGroup, "pending")}>待复核</button>
                  <button className="danger-action-button" disabled={busy} onClick={() => updateGroupDecision(selectedGroup, "exclude")}>排除</button>
                  <button className="danger-action-button" disabled={busy} onClick={() => updateGroupDecision(selectedGroup, "deleted")}><Trash2 size={16} />删除</button>
                </div>
                <div className="rules-meta-grid">
                  <span>策略：{selectedGroup.strategy}</span>
                  <span>回填 safe {selectedGroup.backfillSummary.safe}</span>
                  <span>failed {selectedGroup.backfillSummary.failed}</span>
                  <span title={selectedGroup.risks.join(", ")}>风险：{riskListLabel(selectedGroup.risks)}</span>
                </div>
                <div className="rules-matcher-line" title={formatMatcherRule(selectedGroup.matcher)}>
                  <strong>匹配规则</strong>
                  <code>{formatMatcherRule(selectedGroup.matcher)}</code>
                </div>
                <div className="rules-sample-table">
                  {selectedGroupSamples.map((candidate) => (
                    <div key={candidate.id} className="rules-sample-row">
                      <strong>{candidate.original}</strong>
                      <span>{candidate.sourceFile}</span>
                      <small>{candidate.locator}</small>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="empty">扫描项目后选择规则组。</p>
            )}
          </div>
        </div>
      </section>
      <AiReviewScopeDialog
        open={aiReviewDialogOpen}
        busy={busy}
        groups={groups}
        scope={aiReviewScope}
        onScopeChange={setAiReviewScope}
        onOpenChange={setAiReviewDialogOpen}
        onConfirm={runAiReview}
      />
      <AppDialog
        open={rescanConfirmOpen}
        title="重新扫描项目"
        description="重新扫描会清空当前扫描结果、规则组决策、AI 排查结果和已确认提取规则，并重新生成项目提取规则。"
        compact
        onOpenChange={setRescanConfirmOpen}
      >
        <div className="button-row modal-actions">
          <button className="secondary-button" disabled={busy} onClick={() => setRescanConfirmOpen(false)}>取消</button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => {
              setRescanConfirmOpen(false);
              startScan();
            }}
          >
            重新扫描
          </button>
        </div>
      </AppDialog>
    </div>
  );
}

function AiReviewScopeDialog({
  open,
  busy,
  groups,
  scope,
  onScopeChange,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  busy: boolean;
  groups: ExtractionRuleGroup[];
  scope: Record<AiReviewDecision, boolean>;
  onScopeChange: React.Dispatch<React.SetStateAction<Record<AiReviewDecision, boolean>>>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const options: Array<{ decision: AiReviewDecision; label: string; description: string }> = [
    { decision: "pending", label: "待复核", description: "默认检查，适合让 AI 做初步判断。" },
    { decision: "include", label: "已纳入", description: "复查已经纳入的组，可能改回待复核或排除。" },
    { decision: "exclude", label: "已排除", description: "复查已经排除的组，可能找回误排的文本。" }
  ];
  const selectedCount = options.filter((option) => scope[option.decision]).length;
  return (
    <AppDialog open={open} title="AI 智能排查范围" description="待删除组不会参与排查。" compact className="ai-review-scope-dialog" onOpenChange={onOpenChange}>
      <div className="ai-review-scope-list">
        {options.map((option) => {
          const count = groups.filter((group) => group.userDecision.decision === option.decision).length;
          return (
            <label key={option.decision} className="ai-review-scope-row">
              <CheckboxControl
                compact
                checked={scope[option.decision]}
                onChange={(checked) => onScopeChange((current) => ({ ...current, [option.decision]: checked }))}
              />
              <span className="ai-review-scope-copy">
                <span className="ai-review-scope-title">
                  <strong>{option.label}</strong>
                  <small>{count} 个</small>
                </span>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>
      <div className="dialog-actions ai-review-scope-actions">
        <button disabled={busy || !selectedCount} onClick={onConfirm}><Bot size={16} />开始排查</button>
      </div>
    </AppDialog>
  );
}

function decisionLabel(decision: ExtractionDecision): string {
  return {
    pending: "待复核",
    include: "已纳入",
    exclude: "已排除",
    deleted: "待删除",
    partial: "部分纳入"
  }[decision];
}

function riskListLabel(risks: ExtractionRisk[]): string {
  return risks.length ? risks.map(riskLabel).join("、") : "无";
}

function riskLabel(risk: ExtractionRisk): string {
  return {
    short_text: "短文本",
    resource_like: "疑似资源路径",
    code_like: "疑似代码标识",
    placeholder_sensitive: "包含占位符",
    html_fragment: "包含 HTML 片段",
    technical_key: "技术字段",
    duplicate_locator: "定位重复",
    unsupported_backfill: "不支持回填",
    validation_failed: "回填校验失败",
    minified_source: "压缩源码",
    mixed_content: "混合内容"
  }[risk];
}

function formatMatcherRule(matcher: ExtractionRuleMatcher): string {
  const parts = [
    matcher.strategy ? `strategy=${matcher.strategy}` : undefined,
    matcher.groupKey ? `groupKey=${matcher.groupKey}` : undefined,
    matcher.scriptVariables?.length ? `scriptVariables=${matcher.scriptVariables.join(",")}` : undefined,
    matcher.filePatterns?.length ? `filePatterns=${matcher.filePatterns.join(",")}` : undefined,
    matcher.pathPatterns?.length ? `pathPatterns=${matcher.pathPatterns.join(",")}` : undefined,
    matcher.locatorPrefixes?.length ? `locatorPrefixes=${matcher.locatorPrefixes.join(",")}` : undefined,
    matcher.risks?.length ? `risks=${matcher.risks.join(",")}` : undefined
  ].filter(Boolean);
  return parts.join("；");
}

function combinedScanProgressValue(progress: ExtractionScanProgress): number {
  if (progress.phase === "done") return 100;
  if (progress.phase === "saving") return 98;
  if (progress.phase === "grouping") return 96;
  if (!progress.fileTotal) return progress.phase === "enumerating" ? 2 : 5;
  const currentFileBase = Math.max(0, Math.min(progress.fileCurrent, progress.fileTotal));
  const currentFileProgress = Math.max(0, Math.min(100, progress.fileProgress)) / 100;
  return Math.max(2, Math.min(95, ((currentFileBase + currentFileProgress) / progress.fileTotal) * 95));
}
