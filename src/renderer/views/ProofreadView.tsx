import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AppStateSnapshot, ProofreadOptions } from "../../shared/types";
import { IssueTable, type TableSettings } from "../components/table/DataTable";
import { StyledSelect } from "../components/ui/Primitives";
import { ruleLabel } from "../appUtils";
export default function ProofreadView({
  busy,
  snapshot,
  options,
  tableSettings,
  setOptions,
  run,
  setSnapshot
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  options: ProofreadOptions;
  tableSettings: TableSettings;
  setOptions: React.Dispatch<React.SetStateAction<ProofreadOptions>>;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
}) {
  const [issueFilter, setIssueFilter] = useState("all");
  const visibleIssues = snapshot.issues.filter((issue) => issueFilter === "all" || issue.severity === issueFilter || issue.rule === issueFilter);
  const ruleOptions = Array.from(new Set(snapshot.issues.map((issue) => issue.rule)));
  return (
    <div className="split-content">
      <div className="panel rule-panel">
        <h2>校对规则</h2>
        {Object.entries(options).map(([key, value]) =>
          typeof value === "boolean" ? (
            <label className="check-row" key={key}>
              <input type="checkbox" checked={value} onChange={(event) => setOptions((state) => ({ ...state, [key]: event.target.checked }))} />
              {ruleLabel(key)}
            </label>
          ) : null
        )}
        <label>
          目标语言比例
          <input type="number" min="0" max="1" step="0.05" value={options.targetLanguageRatio} onChange={(event) => setOptions((state) => ({ ...state, targetLanguageRatio: Number(event.target.value) }))} />
        </label>
        <button disabled={busy || !snapshot.textItems.length} onClick={() => run("执行校对", () => window.bgt.proofread(snapshot.textItems, snapshot.analysis, options), (issues) => setSnapshot((state) => ({ ...state, issues })))}>
          <ShieldCheck size={16} />
          开始校对
        </button>
        <label>
          问题筛选
          <StyledSelect
            value={issueFilter}
            options={[
              { value: "all", label: "全部问题" },
              { value: "error", label: "错误" },
              { value: "warning", label: "警告" },
              ...ruleOptions.map((rule) => ({ value: rule, label: rule }))
            ]}
            onChange={setIssueFilter}
          />
        </label>
      </div>
      <IssueTable issues={visibleIssues} items={snapshot.textItems} tableSettings={tableSettings} />
    </div>
  );
}



