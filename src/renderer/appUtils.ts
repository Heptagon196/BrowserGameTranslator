import type { AnalysisResult, AppStateSnapshot, PatchPreview, PromptConfig, TextItem } from "../shared/types";
import { languageLabel } from "./settingsModel";

export function replaceItem(items: TextItem[], changed: TextItem): TextItem[] {
  return items.map((item) => (item.id === changed.id ? changed : item));
}

export function isPatchPreview(value: PatchPreview | AppStateSnapshot): value is PatchPreview {
  return "files" in value && "blocked" in value;
}

export function formatDeepSeekBalance(balance: { balances: Array<{ currency: "CNY" | "USD"; totalBalance: string }> }): string {
  return `DeepSeek 余额：${balance.balances.map((entry) => `${currencyPrefix(entry.currency)}${entry.totalBalance}`).join(" / ")}`;
}

function currencyPrefix(currency: "CNY" | "USD"): string {
  return currency === "USD" ? "$" : "¥";
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

export function buildProgramTranslationSystemPromptPreview(batch: TextItem[], prompts: PromptConfig, sourceLanguage: string, targetLanguage: string, analysis: AnalysisResult): string {
  return [
    prompts.translationSystem.replaceAll("{source_language}", languageLabel(sourceLanguage)).replaceAll("{target_language}", languageLabel(targetLanguage)),
    buildProgramResourceSections(batch, analysis),
    prompts.translationRules.filter(Boolean).length ? ["###用户规则", ...prompts.translationRules.filter(Boolean).map((rule, index) => `${index + 1}.${rule}`)].join("\n") : ""
  ].filter(Boolean).join("\n\n");
}

export function buildProgramTranslationPromptPreview(batch: TextItem[]): string {
  return [
    "###这是你接下来的翻译任务，原文文本如下",
    "###原文",
    "<textarea>",
    ...batch.map((item, index) => {
      const lineNumber = index + 1;
      if (!item.original.includes("\n")) return `${lineNumber}.${item.original}`;
      const lines = item.original.split("\n");
      const body = lines.map((line, lineIndex) => `"${lineNumber}.${lines.length - lineIndex}.,${line.replaceAll('"', '\\"')}",`).join("\n").replace(/,$/, "");
      return `${lineNumber}.[\n${body}\n]`;
    }),
    "</textarea>"
  ].filter(Boolean).join("\n");
}

function buildProgramResourceSections(batch: TextItem[], analysis: AnalysisResult): string {
  const sourceText = batch.map((item) => item.original).join("\n");
  const sections: string[] = [];
  const characters = analysis.characters.filter((entry) => entry.enabled && entry.source && sourceText.includes(entry.source));
  if (characters.length) {
    sections.push(["###角色表", "原文|译文|备注", ...characters.slice(0, 80).map((entry) => `${entry.source}|${entry.target || "待定"}|${entry.note}`)].join("\n"));
  }
  const terms = analysis.glossary.filter((entry) => entry.enabled && entry.source && sourceText.includes(entry.source));
  if (terms.length) {
    sections.push(["###术语表", "原文|译文|备注", ...terms.slice(0, 120).map((entry) => `${entry.source}|${entry.target || "待定"}|${entry.note || entry.category}`)].join("\n"));
  }
  const noTranslate = analysis.noTranslate.filter((entry) => entry.enabled && entry.marker && sourceText.includes(entry.marker));
  if (noTranslate.length) {
    sections.push(["###禁翻表，以下特殊标记符无须翻译", "特殊标记符|备注", ...noTranslate.slice(0, 160).map((entry) => `${entry.marker}|${entry.note}`)].join("\n"));
  }
  return sections.join("\n\n");
}

export function ruleLabel(key: string): string {
  return {
    languageCheck: "语言比例检查",
    characterCheck: "人物检查",
    glossaryCheck: "术语检查",
    untranslatedStatusCheck: "未翻译状态",
    noTranslateCheck: "禁翻表",
    numericResidueCheck: "数字序号残留",
    lineBreakCheck: "换行符数量",
    placeholderCheck: "占位符",
    htmlTagCheck: "HTML 标签",
    emptyTranslationCheck: "空译文",
    character_missing: "人物缺失",
    glossary_missing: "术语缺失",
    untranslated_status: "未翻译状态",
    empty_translation: "空译文",
    language_ratio: "语言比例",
    line_break_count: "换行符数量",
    placeholder_residue: "占位符残留",
    placeholder_missing: "占位符缺失",
    html_tag_missing: "HTML 标签缺失",
    numeric_residue: "数字序号残留",
    no_translate_missing: "禁翻表缺失",
    auto_process_missing: "自动处理缺失"
  }[key] ?? key;
}
