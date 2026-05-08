import type { ProviderConfig } from "../shared/types";

export type UiSettings = {
  uiFontFamily: string;
  tableFontFamily: string;
  chatFontFamily: string;
  baseFontSize: number;
  sidebarFontSize: number;
  titleFontSize: number;
  tableFontSize: number;
  chatFontSize: number;
};

export const languageOptions = [
  { value: "en", label: "英语" },
  { value: "zh-CN", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁体）" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "ru", label: "俄语" },
  { value: "auto", label: "自动识别" }
];

export const languageSelectOptions = languageOptions.map((language) => ({ value: language.value, label: language.label }));

export const modelPresets: Record<ProviderConfig["type"], string[]> = {
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5.2-chat-latest", "gpt-5.2-pro", "gpt-5-mini", "gpt-5-nano", "gpt-5", "gpt-4.1"]
};

export const defaultTemperature = 1.3;
export const defaultMaxOutputTokens = 4096;
export const defaultRpmLimit = 4096;
export const defaultTpmLimit = 9999999;
export const defaultParallelBatchLimit = 20;
export const defaultTablePageSize = 50;

export const defaultUiSettings: UiSettings = {
  uiFontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
  tableFontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
  chatFontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
  baseFontSize: 14,
  sidebarFontSize: 16,
  titleFontSize: 22,
  tableFontSize: 13,
  chatFontSize: 13
};

export function normalizeTablePageSize(value: unknown): number {
  if (value === null || value === undefined || value === "") return defaultTablePageSize;
  const size = Math.floor(Number(value));
  if (!Number.isFinite(size)) return defaultTablePageSize;
  return Math.min(1000, Math.max(20, size));
}

export function normalizeFontSize(value: unknown, fallback: number, min = 10, max = 32): number {
  if (value === null || value === undefined || value === "") return fallback;
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return fallback;
  return Math.min(max, Math.max(min, size));
}

export function languageLabel(value: string): string {
  return languageOptions.find((language) => language.value === value)?.label ?? value;
}

export function apiKeyLinkFor(provider: ProviderConfig): string {
  return provider.type === "deepseek" ? "https://platform.deepseek.com/api_keys" : "https://platform.openai.com/api-keys";
}

export function defaultProviderModelSettings(provider?: ProviderConfig, model = ""): NonNullable<ProviderConfig["modelSettings"]>[string] {
  const type = provider?.type ?? "deepseek";
  return {
    temperature: provider?.temperature ?? defaultTemperature,
    maxOutputTokens: provider?.maxOutputTokens ?? defaultMaxOutputTokens,
    rpmLimit: provider?.rpmLimit ?? defaultRpmLimit,
    tpmLimit: provider?.tpmLimit ?? defaultTpmLimit,
    parallelBatchLimit: provider?.parallelBatchLimit ?? defaultParallelBatchLimit,
    thinkingEnabled: type === "deepseek" && model === "deepseek-v4-flash" ? false : provider?.thinkingEnabled ?? true,
    reasoningEffort: type === "deepseek" && model === "deepseek-v4-pro" ? "max" : provider?.reasoningEffort ?? (type === "openai" ? "medium" : "high")
  };
}

export function normalizeProviderModelSettings(provider: ProviderConfig, models: string[]): NonNullable<ProviderConfig["modelSettings"]> {
  const output: NonNullable<ProviderConfig["modelSettings"]> = {};
  for (const model of models) {
    output[model] = {
      ...defaultProviderModelSettings(provider, model),
      ...(provider.modelSettings?.[model] ?? {})
    };
  }
  return output;
}

export function effectiveProviderForModel(provider: ProviderConfig, model: string): ProviderConfig {
  const settings = {
    ...defaultProviderModelSettings(provider, model),
    ...(provider.modelSettings?.[model] ?? {})
  };
  return {
    ...provider,
    model,
    chatModel: model,
    temperature: settings.temperature ?? provider.temperature,
    maxOutputTokens: settings.maxOutputTokens ?? provider.maxOutputTokens,
    rpmLimit: settings.rpmLimit ?? provider.rpmLimit,
    tpmLimit: settings.tpmLimit ?? provider.tpmLimit,
    parallelBatchLimit: settings.parallelBatchLimit ?? provider.parallelBatchLimit,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort
  };
}

export function providerModelNamesFor(provider: ProviderConfig): string[] {
  const rows = Array.isArray(provider.models) && provider.models.length ? provider.models : modelPresets[provider.type] ?? [provider.model];
  return Array.from(new Set([provider.model, provider.chatModel, ...rows].map((model) => model.trim()).filter(Boolean)));
}

export function enabledProviderModelNamesFor(provider: ProviderConfig): string[] {
  const disabled = new Set(provider.disabledModels ?? []);
  return providerModelNamesFor(provider).filter((model) => !disabled.has(model));
}

export function modelSelectionValue(providerId: string, model: string): string {
  return `${providerId}::${encodeURIComponent(model)}`;
}

export function parseModelSelection(value: string): { providerId: string; model: string } | null {
  const [providerId, encodedModel] = value.split("::");
  if (!providerId || !encodedModel) return null;
  return { providerId, model: decodeURIComponent(encodedModel) };
}

export function modelSelectionOptions(providers: ProviderConfig[]): Array<{ id: string; label: string }> {
  return providers.flatMap((provider) =>
    enabledProviderModelNamesFor(provider).map((model) => ({
      id: modelSelectionValue(provider.id, model),
      label: `${provider.displayName || provider.model} / ${model}`
    }))
  );
}
