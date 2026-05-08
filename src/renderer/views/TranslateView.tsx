import React, { useState } from "react";
import { Play } from "lucide-react";
import type { AiBalanceSnapshot, AiPermissionMode, AppStateSnapshot, ChatMessage, ProviderConfig } from "../../shared/types";
import { TextTable, type TableSettings } from "../components/table/DataTable";
import { ProgressBar } from "../components/ui/Primitives";
import { buildProgramTranslationPromptPreview, buildProgramTranslationSystemPromptPreview, chunk, formatDeepSeekBalance, replaceItem } from "../appUtils";
import { defaultParallelBatchLimit } from "../settingsModel";
export default function TranslateView({
  busy,
  snapshot,
  provider,
  aiBalance,
  chatProvider,
  run,
  setSnapshot,
  setTranslationBusy,
  saveChat,
  snapshotRef,
  setChatBusy,
  aiPermissionMode,
  tableSettings
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  provider?: ProviderConfig;
  aiBalance: AiBalanceSnapshot | null;
  chatProvider?: ProviderConfig;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  setTranslationBusy: React.Dispatch<React.SetStateAction<boolean>>;
  saveChat: (chat: ChatMessage[]) => Promise<void>;
  snapshotRef: React.MutableRefObject<AppStateSnapshot>;
  setChatBusy: React.Dispatch<React.SetStateAction<boolean>>;
  aiPermissionMode: AiPermissionMode;
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

  const processUserMessagesSince = async (provider: ProviderConfig, sinceIndex: number) => {
    const current = snapshotRef.current.chat;
    const pending = current.slice(sinceIndex).filter((message) => message.role === "user");
    if (!pending.length) return;
    if (!provider.apiKey) return;
    setChatBusy(true);
    try {
      const reply = await window.bgt.replyChat(provider, current, aiPermissionMode);
      await saveChat([...snapshotRef.current.chat, { ...reply, origin: "user", kind: "chat" }]);
      const refreshed = await window.bgt.refreshProject();
      snapshotRef.current = refreshed;
      setSnapshot(refreshed);
    } finally {
      setChatBusy(false);
    }
  };

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
      let pendingUserStart = snapshotRef.current.chat.length;
      let nextBatchIndex = 0;
      let firstError: unknown = null;
      const translationSettings = provider.modelSettings?.[provider.model] ?? {};
      const configuredConcurrency = translationSettings.parallelBatchLimit ?? provider.parallelBatchLimit ?? defaultParallelBatchLimit;
      const concurrency = Math.min(batches.length, Math.max(1, Math.floor(Number(configuredConcurrency) || defaultParallelBatchLimit)));
      const inFlight = new Set<Promise<void>>();
      let chatWrite = Promise.resolve();

      const appendProgramIoPair = async (promptMessage: ChatMessage, responseMessage: ChatMessage) => {
        chatWrite = chatWrite.then(() => saveChat([...snapshotRef.current.chat, promptMessage, responseMessage])).then(() => undefined);
        await chatWrite;
      };

      const processPendingUserInput = async () => {
        const currentChat = snapshotRef.current.chat;
        const hasPendingUser = currentChat.slice(pendingUserStart).some((message) => message.role === "user");
        if (!hasPendingUser) return;
        await processUserMessagesSince(chatProvider ?? provider, pendingUserStart);
        pendingUserStart = snapshotRef.current.chat.length;
        workingItems = snapshotRef.current.textItems;
      };

      const runBatch = async (index: number) => {
        const batch = batches[index];
        const prompts = await window.bgt.loadEffectivePrompts();
        const promptMessage: ChatMessage = {
          id: `msg_${Date.now()}_${index}_prompt`,
          role: "system",
          origin: "program",
          kind: "program_prompt",
          createdAt: new Date().toISOString(),
          content: [
            `翻译批次 ${index + 1}/${batches.length}`,
            `System:\n${buildProgramTranslationSystemPromptPreview(batch, prompts, project.sourceLanguage, project.targetLanguage, snapshotRef.current.analysis)}`,
            `User:\n${buildProgramTranslationPromptPreview(batch)}`
          ].join("\n\n")
        };
        const translatedBatch = await window.bgt.translateBatch(provider, project.targetLanguage, snapshotRef.current.chat, batch);
        const byId = new Map(translatedBatch.map((item) => [item.id, item]));
        workingItems = workingItems.map((item) => byId.get(item.id) ?? item);
        await window.bgt.saveTextItems(workingItems);
        setSnapshot((state) => ({ ...state, textItems: workingItems }));
        setTranslationProgress((current) => ({
          ...current,
          processed: Math.min(current.total, current.processed + batch.length),
          translated: Math.min(current.total, current.translated + translatedBatch.filter((item) => item.translation.trim() && item.status !== "excluded").length)
        }));
        const responseMessage: ChatMessage = {
          id: `msg_${Date.now()}_${index}_response`,
          role: "assistant",
          origin: "program",
          kind: "program_response",
          createdAt: new Date().toISOString(),
          content: JSON.stringify(
            translatedBatch.map((item) => ({ id: item.id, translation: item.translation, status: item.status })),
            null,
            2
          )
        };
        await appendProgramIoPair(promptMessage, responseMessage);
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
        await chatWrite;
        await processPendingUserInput();
        while (!firstError && nextBatchIndex < batches.length && inFlight.size < concurrency) launchNextBatch();
      }
      await chatWrite;
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
                const translated = await window.bgt.translateBatch(provider, snapshot.project?.targetLanguage ?? "zh-CN", snapshotRef.current.chat, selectedItems);
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



