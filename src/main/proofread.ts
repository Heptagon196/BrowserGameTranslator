import { AnalysisResult, ProofreadIssue, ProofreadOptions, TextItem } from "../shared/types";
import { extractHtmlTags, extractPlaceholders } from "./textAnalysisUtils";

export const defaultProofreadOptions = (): ProofreadOptions => ({
  languageCheck: true,
  targetLanguageRatio: 0.75,
  characterCheck: true,
  glossaryCheck: true,
  untranslatedStatusCheck: true,
  noTranslateCheck: true,
  numericResidueCheck: true,
  lineBreakCheck: true,
  placeholderCheck: true,
  htmlTagCheck: true,
  emptyTranslationCheck: true
});

export function proofreadItems(items: TextItem[], analysis: AnalysisResult, options: ProofreadOptions): ProofreadIssue[] {
  const issues: ProofreadIssue[] = [];
  let index = 1;
  const characterRules = options.characterCheck ? prepareCharacterRules(analysis) : [];
  const glossaryRules = options.glossaryCheck ? prepareGlossaryRules(analysis) : [];
  const exclusionRules = prepareExclusionRules(analysis);
  const add = (item: TextItem, rule: string, message: string, severity: "warning" | "error" = "error") => {
    issues.push({
      id: `issue_${String(index++).padStart(6, "0")}`,
      textItemId: item.id,
      rule,
      severity,
      message,
      status: "open"
    });
  };

  for (const item of items) {
    const translation = item.translation.trim();
    if (options.untranslatedStatusCheck && ["extracted", "failed", "needs_review"].includes(item.status)) {
      add(item, "untranslated_status", `项目仍处于 ${textStatusLabel(item.status)} 状态。`);
    }
    if (options.emptyTranslationCheck && item.status !== "excluded" && !translation) {
      add(item, "empty_translation", "译文为空。");
    }
    if (options.languageCheck && translation && targetLanguageRatio(translation) < options.targetLanguageRatio && targetLanguageRatio(item.original) < options.targetLanguageRatio) {
      add(item, "language_ratio", `语言不匹配：译文目标语言比例低于 ${Math.round(options.targetLanguageRatio * 100)}%。`, "warning");
    }
    if (options.lineBreakCheck && translation) {
      const sourceNewlines = newlineCount(item.original);
      const targetNewlines = newlineCount(translation);
      if (sourceNewlines !== targetNewlines) add(item, "line_break_count", `换行符错误：原文 ${sourceNewlines} 个，译文 ${targetNewlines} 个。`);
    }
    if (options.placeholderCheck && translation) {
      const residue = translation.match(/\[P\d+\]/);
      if (residue) add(item, "placeholder_residue", `占位符残留：${residue[0]}`);
      for (const placeholder of extractPlaceholders(item.original)) {
        if (!translation.includes(placeholder)) add(item, "placeholder_missing", `占位符缺失：${placeholder}`);
      }
    }
    if (options.htmlTagCheck && translation) {
      for (const tag of extractHtmlTags(item.original)) {
        if (!translation.includes(tag)) add(item, "html_tag_missing", `HTML 标签缺失：${tag}`);
      }
    }
    if (options.numericResidueCheck && /^\s*(\d+[.)]|[-*]\s+|txt_\d+[:：])/i.test(translation)) {
      add(item, "numeric_residue", "译文疑似包含 AI 输出编号或文本项 ID 残留。");
    }
    if (options.numericResidueCheck && /\d+\.\d+\./.test(translation)) {
      add(item, "numeric_residue", "数字序号残留：译文中包含多级数字序号。");
    }
    if (options.noTranslateCheck && translation) {
      for (const rule of exclusionRules) {
        for (const marker of findRuleMatches(item.original, rule)) {
          if (!translation.includes(marker)) add(item, "no_translate_missing", `禁翻表错误：原文存在 ${marker}，译文没有正确保留。`);
        }
      }
      for (const rule of autoProcessRules) {
        for (const marker of findRuleMatches(item.original, rule)) {
          if (!translation.includes(marker)) add(item, "auto_process_missing", `自动处理错误：原文存在 ${marker}，译文没有正确保留。`);
        }
      }
    }
    if (options.characterCheck && translation) {
      for (const rule of characterRules) {
        if (ruleMatches(item.original, rule) && !targetMatches(translation, rule)) {
          add(item, "character_missing", `人物缺失：原文 ${rule.source}，译文应包含 ${rule.target}。`, "warning");
        }
      }
    }
    if (options.glossaryCheck && translation) {
      for (const rule of glossaryRules) {
        if (ruleMatches(item.original, rule) && !targetMatches(translation, rule)) {
          add(item, "glossary_missing", `术语缺失：原文 ${rule.source}，译文应包含 ${rule.target}。`, "warning");
        }
      }
    }
  }
  return issues;
}

function targetLanguageRatio(value: string): number {
  const letters = Array.from(value).filter((char) => /\p{L}/u.test(char));
  if (!letters.length) return 0;
  const cjk = letters.filter((char) => /[\u3400-\u9fff]/u.test(char));
  return cjk.length / letters.length;
}

function newlineCount(value: string): number {
  const trimmed = value.trim();
  return (trimmed.match(/\n/g) ?? []).length + (trimmed.match(/\\n/g) ?? []).length;
}

function textStatusLabel(value: TextItem["status"]): string {
  return {
    extracted: "未翻译",
    translated: "已翻译",
    failed: "失败",
    needs_review: "需复核",
    excluded: "已排除"
  }[value] ?? value;
}

type TermRule = { source: string; target: string; regex?: RegExp };
type PreserveRule = { source: string; regex?: RegExp };

const autoProcessRules: PreserveRule[] = [
  "\\\\font\\[\\d+\\]\\\\c\\[\\d+\\]\\\\f\\[\\d+\\]A+",
  "if\\(.{0,5}[vs]\\[\\d+\\].{0,10}\\)",
  "en\\(.{0,5}[vs]\\[\\d+\\].{0,10}\\)",
  "[\\\\/][a-z]{1,5}<[a-z\\d]{0,10}>",
  "[\\\\/][a-z]{1,5}\\[[a-z\\d]{0,10}\\]",
  "\\\\SE\\[.{0,15}?\\]",
  "\\\\[A-Za-z]\\[\\d+\\]",
  "\\{image=[^}]*\\}",
  "\\{color=[^}]*\\}",
  "\\{/color\\}",
  "\\{i\\}",
  "\\{/i\\}",
  "\\{size=\\d+\\}",
  "\\{/size\\}",
  "\\{a=[^}]*\\}",
  "<[A-Za-z]+:\\d+>",
  "\\$[^$]+\\$",
  "@\\d+",
  "%[sdif]",
  "%\\d+"
].map((source) => ({ source, regex: compileRegex(source) })).filter((rule): rule is PreserveRule & { regex: RegExp } => Boolean(rule.regex));

function prepareCharacterRules(analysis: AnalysisResult): TermRule[] {
  const rules: TermRule[] = [];
  const seen = new Set<string>();
  const add = (source: string | undefined, target: string | undefined, isRegex = false) => {
    const normalizedSource = (source ?? "").trim();
    const normalizedTarget = (target ?? "").trim();
    const key = normalizedSource.toLowerCase();
    if (!normalizedSource || !normalizedTarget || seen.has(key)) return;
    seen.add(key);
    rules.push({ source: normalizedSource, target: normalizedTarget, regex: isRegex ? compileRegex(normalizedSource, "i") : undefined });
  };
  for (const entry of analysis.characters.filter((entry) => entry.enabled)) {
    add(entry.source, entry.target);
    add(entry.familyName, entry.familyNameTranslation);
    add(entry.givenName, entry.givenNameTranslation);
  }
  return rules;
}

function prepareGlossaryRules(analysis: AnalysisResult): TermRule[] {
  const rules: TermRule[] = [];
  const seen = new Set<string>();
  const add = (source: string | undefined, target: string | undefined, isRegex = false) => {
    const normalizedSource = (source ?? "").trim();
    const normalizedTarget = (target ?? "").trim();
    const key = normalizedSource.toLowerCase();
    if (!normalizedSource || !normalizedTarget || seen.has(key)) return;
    seen.add(key);
    rules.push({ source: normalizedSource, target: normalizedTarget, regex: isRegex ? compileRegex(normalizedSource, "i") : undefined });
  };
  for (const entry of analysis.glossary.filter((entry) => entry.enabled)) add(entry.source, entry.target, entry.isRegex);
  return rules;
}

function prepareExclusionRules(analysis: AnalysisResult): PreserveRule[] {
  return analysis.noTranslate
    .filter((entry) => entry.enabled && entry.marker)
    .map((entry) => ({ source: entry.marker, regex: entry.isRegex ? compileRegex(entry.marker, "g") : undefined }));
}

function ruleMatches(value: string, rule: TermRule): boolean {
  if (rule.regex) {
    rule.regex.lastIndex = 0;
    return rule.regex.test(value);
  }
  return containsLocalizedTerm(value, rule.source);
}

function targetMatches(value: string, rule: TermRule): boolean {
  return containsLocalizedTerm(value, rule.target);
}

function containsLocalizedTerm(text: string, term: string): boolean {
  const normalizedTerm = term.trim();
  if (!normalizedTerm) return false;
  if (!shouldUseAlphabeticBoundary(normalizedTerm)) {
    return text.toLocaleLowerCase().includes(normalizedTerm.toLocaleLowerCase());
  }
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escapeRegex(normalizedTerm)}(?![\\p{L}\\p{N}\\p{M}_])`, "iu").test(text);
  } catch {
    return containsDelimitedTerm(text, normalizedTerm);
  }
}

function shouldUseAlphabeticBoundary(term: string): boolean {
  return hasUnicodeLetter(term) && !hasCjkOrNoSpaceScript(term);
}

function hasUnicodeLetter(value: string): boolean {
  return /\p{L}/u.test(value);
}

function hasCjkOrNoSpaceScript(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(value);
}

function containsDelimitedTerm(text: string, term: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = text[index - 1] ?? "";
    const after = text[index + term.length] ?? "";
    if (!isWordLikeCharacter(before) && !isWordLikeCharacter(after)) return true;
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return false;
}

function isWordLikeCharacter(value: string): boolean {
  return Boolean(value) && /[\p{L}\p{N}\p{M}_]/u.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function findRuleMatches(value: string, rule: PreserveRule): string[] {
  if (!rule.source) return [];
  if (!rule.regex) return value.includes(rule.source) ? [rule.source] : [];
  try {
    rule.regex.lastIndex = 0;
    return Array.from(new Set(value.match(rule.regex) ?? []));
  } catch {
    return [];
  }
}

function compileRegex(source: string, flags = "g"): RegExp | undefined {
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}
