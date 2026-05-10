import { AnalysisResult, NoTranslateEntry, TextItem } from "../shared/types";
import { extractHtmlTags, extractPlaceholders } from "./textAnalysisUtils";

export function analyzeLocally(items: TextItem[]): AnalysisResult {
  const noTranslate = collectNoTranslate(items);
  const glossary = collectGlossary(items);
  return {
    characters: [],
    glossary,
    noTranslate
  };
}

function collectNoTranslate(items: TextItem[]): NoTranslateEntry[] {
  const byMarker = new Map<string, NoTranslateEntry>();
  const add = (marker: string, note: string, isRegex: boolean) => {
    if (!marker) return;
    if (byMarker.has(marker)) return;
    byMarker.set(marker, {
      id: `nt_${String(byMarker.size + 1).padStart(4, "0")}`,
      marker,
      note,
      isRegex,
      enabled: true
    });
  };

  for (const item of items) {
    for (const placeholder of extractPlaceholders(item.original)) add(placeholder, "自动识别的占位符", false);
    for (const tag of extractHtmlTags(item.original)) add(tag, "自动识别的 HTML 标签", false);
    for (const token of item.original.match(/\\[A-Za-z]+\[\d+\]/g) ?? []) add(token, "疑似游戏控制符", false);
    for (const token of item.original.match(/\{(?:\/?[a-z]+|[a-z]+=[^}]+)\}/gi) ?? []) add(token, "疑似文本控制标签", false);
    for (const token of item.original.match(/<[A-Za-z]+:\d+>|\\SE\[[^\]]*]|\$[^$]+\$|@\d+/g) ?? []) add(token, "疑似自动处理标记", false);
    for (const token of item.original.match(/%[sdif]|\$\d+|%\d+/g) ?? []) add(token, "疑似格式化占位符", false);
  }

  return Array.from(byMarker.values());
}

function collectGlossary(items: TextItem[]): AnalysisResult["glossary"] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const match of item.original.matchAll(/\b[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,3}\b/g)) {
      const source = match[0].trim();
      if (source.length < 4 || /^(The|This|That|You|Your|When|What|Where|Please|Error|System)$/i.test(source)) continue;
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .slice(0, 120)
    .map(([source, count], index) => ({
      id: `term_${String(index + 1).padStart(4, "0")}`,
      source,
      target: "",
      note: `本地初筛候选，出现 ${count} 次`,
      category: "候选术语",
      isRegex: false,
      enabled: true
    }));
}
