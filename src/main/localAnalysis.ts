import { AnalysisResult, NoTranslateEntry, TextItem } from "../shared/types";

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
  const add = (marker: string, note: string, isRegex: boolean, example: string) => {
    if (!marker) return;
    const existing = byMarker.get(marker);
    if (existing) {
      if (existing.sourceExamples.length < 3 && !existing.sourceExamples.includes(example)) existing.sourceExamples.push(example);
      return;
    }
    byMarker.set(marker, {
      id: `nt_${String(byMarker.size + 1).padStart(4, "0")}`,
      marker,
      note,
      isRegex,
      enabled: true,
      sourceExamples: [example]
    });
  };

  for (const item of items) {
    for (const placeholder of item.metadata.placeholders) add(placeholder, "自动识别的占位符", false, item.original);
    for (const tag of item.metadata.tags) add(tag, "自动识别的 HTML 标签", false, item.original);
    for (const token of item.original.match(/\\[A-Za-z]+\[\d+\]/g) ?? []) add(token, "疑似游戏控制符", false, item.original);
    for (const token of item.original.match(/\{(?:\/?[a-z]+|[a-z]+=[^}]+)\}/gi) ?? []) add(token, "疑似文本控制标签", false, item.original);
    for (const token of item.original.match(/<[A-Za-z]+:\d+>|\\SE\[[^\]]*]|\$[^$]+\$|@\d+/g) ?? []) add(token, "疑似自动处理标记", false, item.original);
    for (const token of item.original.match(/%[sdif]|\$\d+|%\d+/g) ?? []) add(token, "疑似格式化占位符", false, item.original);
  }

  return Array.from(byMarker.values());
}

function collectGlossary(items: TextItem[]): AnalysisResult["glossary"] {
  const counts = new Map<string, { count: number; examples: string[] }>();
  for (const item of items) {
    for (const match of item.original.matchAll(/\b[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,3}\b/g)) {
      const source = match[0].trim();
      if (source.length < 4 || /^(The|This|That|You|Your|When|What|Where|Please|Error|System)$/i.test(source)) continue;
      const current = counts.get(source) ?? { count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(item.original);
      counts.set(source, current);
    }
  }

  return Array.from(counts.entries())
    .filter(([, value]) => value.count >= 2)
    .slice(0, 120)
    .map(([source, value], index) => ({
      id: `term_${String(index + 1).padStart(4, "0")}`,
      source,
      target: "",
      description: `本地初筛候选，出现 ${value.count} 次`,
      category: "候选术语",
      isRegex: false,
      enabled: true,
      sourceExamples: value.examples
    }));
}
