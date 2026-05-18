import React, { useState } from "react";
import { AlertTriangle, Languages, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import type { AppStateSnapshot, ProofreadIssue, ProofreadOptions, ProviderConfig } from "../../shared/types";
import { IssueTable, type TableSettings } from "../components/table/DataTable";
import { BatchProgressDialog, type BatchProgressState } from "../components/ui/BatchProgressDialog";
import { AppDialog, CheckboxControl } from "../components/ui/Primitives";
import { chunk, ruleLabel } from "../appUtils";

type ProofreadCategory = "language" | "glossary" | "characterAmbiguity" | "rules";

const ruleOptionKeys: Array<keyof ProofreadOptions> = [
  "untranslatedStatusCheck",
  "noTranslateCheck",
  "numericResidueCheck",
  "lineBreakCheck",
  "placeholderCheck",
  "htmlTagCheck",
  "emptyTranslationCheck"
];

export default function ProofreadView({
  busy,
  snapshot,
  provider,
  options,
  tableSettings,
  setOptions,
  run,
  setSnapshot
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  options: ProofreadOptions;
  tableSettings: TableSettings;
  setOptions: React.Dispatch<React.SetStateAction<ProofreadOptions>>;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
}) {
  const [dialogCategory, setDialogCategory] = useState<ProofreadCategory | null>(null);
  const [draftOptions, setDraftOptions] = useState(options);
  const [aiProgress, setAiProgress] = useState<BatchProgressState | null>(null);

  const openDialog = (category: ProofreadCategory) => {
    setDraftOptions(category === "characterAmbiguity" ? { ...options, characterAmbiguityCheck: true } : options);
    setDialogCategory(category);
  };

  const runCategory = (category: ProofreadCategory) => {
    const nextOptions = buildCategoryOptions(category, draftOptions);
    setOptions(draftOptions);
    setDialogCategory(null);
    return run("执行校对", () => window.bgt.proofread(snapshot.textItems, snapshot.analysis, nextOptions), (issues) => setSnapshot((state) => ({ ...state, issues })));
  };

  const aiProofreadIssues = (targetIssues: ProofreadIssue[]) => {
    if (!provider || !targetIssues.length) return;
    return run("AI 自动校对", async () => {
      const issueBatches = buildAiProofreadIssueBatches(targetIssues, snapshot.textItems);
      if (!issueBatches.length) return window.bgt.refreshProject();
      if (issueBatches.length === 1) {
        const textItems = await window.bgt.aiProofread(provider, targetIssues);
        await window.bgt.proofread(textItems, snapshot.analysis, options);
        return window.bgt.refreshProject();
      }

      const totalItemCount = issueBatches.reduce((sum, entry) => sum + uniqueTextItemCount(entry), 0);
      let processed = 0;
      let latestTextItems = snapshot.textItems;
      try {
        for (const [index, batch] of issueBatches.entries()) {
          const batchItemCount = uniqueTextItemCount(batch);
          setAiProgress({
            title: "AI 自动校对",
            currentLabel: `正在校对 ${batchItemCount} 行`,
            processed,
            total: totalItemCount,
            batchIndex: index + 1,
            batchTotal: issueBatches.length
          });
          latestTextItems = await window.bgt.aiProofread(provider, batch, {
            titlePrefix: "AI 自动校对",
            batchIndexOffset: index,
            batchTotal: issueBatches.length
          });
          processed += batchItemCount;
          setAiProgress({
            title: "AI 自动校对",
            currentLabel: `已完成 ${processed} 行`,
            processed,
            total: totalItemCount,
            batchIndex: index + 1,
            batchTotal: issueBatches.length
          });
        }
      } finally {
        setAiProgress(null);
      }
      await window.bgt.proofread(latestTextItems, snapshot.analysis, options);
      return window.bgt.refreshProject();
    }, setSnapshot);
  };

  return (
    <div className="stack proofread-layout">
      <div className="proofread-action-bar">
        <button disabled={busy || !snapshot.textItems.length} onClick={() => openDialog("language")}>
          <Languages size={16} />
          语言检查
        </button>
        <button disabled={busy || !snapshot.textItems.length} onClick={() => openDialog("glossary")}>
          <ShieldCheck size={16} />
          术语检查
        </button>
        <button disabled={busy || !snapshot.textItems.length} onClick={() => openDialog("characterAmbiguity")}>
          <AlertTriangle size={16} />
          易混淆角色名检查
        </button>
        <button disabled={busy || !snapshot.textItems.length} onClick={() => openDialog("rules")}>
          <ListChecks size={16} />
          规则检查
        </button>
        <button className="proofread-ai-button" disabled={busy || !provider || !snapshot.issues.length} onClick={() => { void aiProofreadIssues(snapshot.issues); }}>
          <Sparkles size={16} />
          AI 自动校对
        </button>
      </div>
      <IssueTable issues={snapshot.issues} items={snapshot.textItems} tableSettings={tableSettings} onProofreadIssues={(rows) => { void aiProofreadIssues(rows); }} />
      {aiProgress ? <BatchProgressDialog progress={aiProgress} /> : null}
      {dialogCategory ? (
        <ProofreadOptionsDialog
          category={dialogCategory}
          options={draftOptions}
          busy={busy}
          onChange={setDraftOptions}
          onClose={() => setDialogCategory(null)}
          onRun={() => { void runCategory(dialogCategory); }}
        />
      ) : null}
    </div>
  );
}

function buildAiProofreadIssueBatches(issues: ProofreadIssue[], items: AppStateSnapshot["textItems"]): ProofreadIssue[][] {
  const eligibleItemIds = new Set(items.filter((item) => item.status !== "excluded").map((item) => item.id));
  const issuesByItemId = new Map<string, ProofreadIssue[]>();
  for (const issue of issues) {
    if (!eligibleItemIds.has(issue.textItemId)) continue;
    const grouped = issuesByItemId.get(issue.textItemId) ?? [];
    grouped.push(issue);
    issuesByItemId.set(issue.textItemId, grouped);
  }
  return chunk(Array.from(issuesByItemId.keys()), 20).map((ids) => ids.flatMap((id) => issuesByItemId.get(id) ?? []));
}

function uniqueTextItemCount(issues: ProofreadIssue[]): number {
  return new Set(issues.map((issue) => issue.textItemId)).size;
}

function ProofreadOptionsDialog({
  category,
  options,
  busy,
  onChange,
  onClose,
  onRun
}: {
  category: ProofreadCategory;
  options: ProofreadOptions;
  busy: boolean;
  onChange: React.Dispatch<React.SetStateAction<ProofreadOptions>>;
  onClose: () => void;
  onRun: () => void;
}) {
  const title = category === "language" ? "语言检查" : category === "glossary" ? "术语检查" : category === "characterAmbiguity" ? "易混淆角色名检查" : "规则检查";
  return (
    <AppDialog open title={title} compact className="proofread-options-modal" onOpenChange={(open) => { if (!open) onClose(); }}>
      <div className="proofread-dialog-body">
        {category === "language" ? (
          <>
            <label className="check-row">
              <CheckboxControl checked={options.languageCheck} onChange={(checked) => onChange((state) => ({ ...state, languageCheck: checked }))} />
              <span>{ruleLabel("languageCheck")}</span>
            </label>
            <label className="proofread-ratio-row">
              <span>目标语言比例</span>
              <input type="number" min="0" max="1" step="0.05" value={options.targetLanguageRatio} onChange={(event) => onChange((state) => ({ ...state, targetLanguageRatio: Number(event.target.value) }))} />
            </label>
          </>
        ) : null}
        {category === "glossary" ? (
          <div className="proofread-rule-grid">
            <label className="check-row">
              <CheckboxControl checked={options.characterCheck} onChange={(checked) => onChange((state) => ({ ...state, characterCheck: checked }))} />
              <span>{ruleLabel("characterCheck")}</span>
            </label>
            <label className="check-row">
              <CheckboxControl checked={options.glossaryCheck} onChange={(checked) => onChange((state) => ({ ...state, glossaryCheck: checked }))} />
              <span>{ruleLabel("glossaryCheck")}</span>
            </label>
          </div>
        ) : null}
        {category === "characterAmbiguity" ? (
          <div className="proofread-rule-grid">
            <label className="check-row">
              <CheckboxControl checked={options.characterAmbiguityCheck} onChange={(checked) => onChange((state) => ({ ...state, characterAmbiguityCheck: checked }))} />
              <span>{ruleLabel("characterAmbiguityCheck")}</span>
            </label>
          </div>
        ) : null}
        {category === "rules" ? (
          <div className="proofread-rule-grid">
            {ruleOptionKeys.map((key) => (
              <label className="check-row" key={key}>
                <CheckboxControl checked={Boolean(options[key])} onChange={(checked) => onChange((state) => ({ ...state, [key]: checked }))} />
                <span>{ruleLabel(key)}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={onRun}>
          <ShieldCheck size={16} />
          开始检查
        </button>
      </div>
    </AppDialog>
  );
}

function buildCategoryOptions(category: ProofreadCategory, options: ProofreadOptions): ProofreadOptions {
  const disabled: ProofreadOptions = {
    ...options,
    languageCheck: false,
    characterCheck: false,
    characterAmbiguityCheck: false,
    glossaryCheck: false,
    untranslatedStatusCheck: false,
    noTranslateCheck: false,
    numericResidueCheck: false,
    lineBreakCheck: false,
    placeholderCheck: false,
    htmlTagCheck: false,
    emptyTranslationCheck: false
  };
  if (category === "language") return { ...disabled, languageCheck: options.languageCheck };
  if (category === "glossary") return { ...disabled, characterCheck: options.characterCheck, glossaryCheck: options.glossaryCheck };
  if (category === "characterAmbiguity") return { ...disabled, characterAmbiguityCheck: options.characterAmbiguityCheck };
  return {
    ...disabled,
    untranslatedStatusCheck: options.untranslatedStatusCheck,
    noTranslateCheck: options.noTranslateCheck,
    numericResidueCheck: options.numericResidueCheck,
    lineBreakCheck: options.lineBreakCheck,
    placeholderCheck: options.placeholderCheck,
    htmlTagCheck: options.htmlTagCheck,
    emptyTranslationCheck: options.emptyTranslationCheck
  };
}
