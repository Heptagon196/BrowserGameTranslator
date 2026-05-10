import React, { useState } from "react";
import { Play } from "lucide-react";
import type { AiBalanceSnapshot, AppStateSnapshot, ProviderConfig } from "../../shared/types";
import { TextTable, type TableSettings } from "../components/table/DataTable";
import { ProgressBar } from "../components/ui/Primitives";
import { chunk, formatDeepSeekBalance, replaceItem } from "../appUtils";
import { defaultParallelBatchLimit } from "../settingsModel";
export default function TranslateView({
  busy,
  snapshot,
  provider,
  aiBalance,
  run,
  setSnapshot,
  setTranslationBusy,
  snapshotRef,
  tableSettings
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  aiBalance: AiBalanceSnapshot | null;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  setTranslationBusy: React.Dispatch<React.SetStateAction<boolean>>;
  snapshotRef: React.MutableRefObject<AppStateSnapshot>;
  tableSettings: TableSettings;
}) {
  const [translationProgress, setTranslationProgress] = useState({ running: false, processed: 0, translated: 0, total: 0 });
  const translatedCount = snapshot.textItems.filter((item) => item.translation.trim() && item.status !== "excluded").length;
  const translationModelLabel = provider ? `${provider.displayName || provider.model} / ${provider.model}` : "未配置模型";
  const translationBalanceLabel =
    provider?.type === "deepseek"
      ? provider.apiKey
        ? aiBalance?.providerId === provider.id
          ? aiBalance.balances.length
            ? formatDeepSeekBalance(aiBalance)
            : aiBalance.error
              ? "DeepSeek 余额：查询失败"
              : "DeepSeek 余额：无余额信息"
          : "DeepSeek 余额：查询中"
        : "DeepSeek 余额：未填写 API Key"
      : "";
  const progressValue = translationProgress.running && translationProgress.total ? Math.min(100, (translationProgress.processed / translationProgress.total) * 100) : 0;

  const startBatchTranslation = async () => {
    if (!provider || !snapshot.project) return;
    const project = snapshot.project;
    setTranslationBusy(true);
    try {
      const allItems = snapshotRef.current.textItems;
      const activeItems = allItems.filter((item) => item.status !== "excluded" && !item.translation);
      setTranslationProgress({ running: activeItems.length > 0, processed: 0, translated: 0, total: activeItems.length });
      const batches = chunk(activeItems, 20);
      let workingItems = allItems;
      let nextBatchIndex = 0;
      let firstError: unknown = null;
      const translationSettings = provider.modelSettings?.[provider.model] ?? {};
      const configuredConcurrency = translationSettings.parallelBatchLimit ?? provider.parallelBatchLimit ?? defaultParallelBatchLimit;
      const concurrency = Math.min(batches.length, Math.max(1, Math.floor(Number(configuredConcurrency) || defaultParallelBatchLimit)));
      const inFlight = new Set<Promise<void>>();

      const runBatch = async (index: number) => {
        const batch = batches[index];
        const translatedBatch = await window.bgt.translateBatch(provider, project.targetLanguage, batch);
        const byId = new Map(translatedBatch.map((item) => [item.id, item]));
        workingItems = workingItems.map((item) => byId.get(item.id) ?? item);
        await window.bgt.saveTextItems(workingItems);
        setSnapshot((state) => ({ ...state, textItems: workingItems }));
        setTranslationProgress((current) => ({
          ...current,
          processed: Math.min(current.total, current.processed + batch.length),
          translated: Math.min(current.total, current.translated + translatedBatch.filter((item) => item.translation.trim() && item.status !== "excluded").length)
        }));
      };

      const launchNextBatch = () => {
        if (firstError || nextBatchIndex >= batches.length) return;
        const index = nextBatchIndex;
        nextBatchIndex += 1;
        const task = runBatch(index)
          .catch((error) => {
            firstError ??= error;
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      };

      while (nextBatchIndex < batches.length && inFlight.size < concurrency) launchNextBatch();
      while (inFlight.size) {
        await Promise.race(Array.from(inFlight));
        while (!firstError && nextBatchIndex < batches.length && inFlight.size < concurrency) launchNextBatch();
      }
      if (firstError) throw firstError;
    } finally {
      setTranslationBusy(false);
      setTranslationProgress((current) => ({ ...current, running: false }));
    }
  };

  return (
    <div className="stack">
      <div className="toolbar translation-toolbar">
        <button disabled={busy || !provider || !snapshot.textItems.length} onClick={() => run("批量翻译", startBatchTranslation)}>
          <Play size={16} />
          开始翻译
        </button>
        <div className="translation-status-strip">
          <ProgressBar value={progressValue} className={translationProgress.running ? "inline-progress active" : "inline-progress"} />
          <span className="translation-count">
            {translationProgress.running ? translationProgress.translated : translatedCount}/{translationProgress.running ? translationProgress.total : snapshot.textItems.filter((item) => item.status !== "excluded").length}
          </span>
          <span className="translation-model" title={translationModelLabel}>{translationModelLabel}</span>
          {translationBalanceLabel && <span className="translation-balance">{translationBalanceLabel}</span>}
        </div>
      </div>
      <TextTable
        items={snapshot.textItems}
        enableFileFilter
        tableSettings={tableSettings}
        onChange={(changed) => window.bgt.saveTextItems(replaceItem(snapshot.textItems, changed)).then((textItems) => setSnapshot((state) => ({ ...state, textItems })))}
        onBulkChange={(nextItems) => window.bgt.saveTextItems(nextItems).then((textItems) => setSnapshot((state) => ({ ...state, textItems })))}
        onTranslateItems={
          provider
            ? async (selectedItems) => {
                const translated = await window.bgt.translateBatch(provider, snapshot.project?.targetLanguage ?? "zh-CN", selectedItems);
                const byId = new Map(translated.map((item) => [item.id, item]));
                const nextItems = snapshotRef.current.textItems.map((item) => byId.get(item.id) ?? item);
                const saved = await window.bgt.saveTextItems(nextItems);
                setSnapshot((state) => ({ ...state, textItems: saved }));
              }
            : undefined
        }
      />
    </div>
  );
}



