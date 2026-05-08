import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { ProviderConfig } from "../shared/types";
import { readJson, writeJson } from "./storage";

type SecretStore = Record<string, string>;
interface ProviderSettings {
  activeProviderId: string;
  activeChatProviderId?: string;
}

const DEFAULT_TEMPERATURE = 1.3;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_RPM_LIMIT = 4096;
const DEFAULT_TPM_LIMIT = 9999999;
const DEFAULT_PARALLEL_BATCH_LIMIT = 20;

const defaultProviders = (): ProviderConfig[] => [
  {
    id: "deepseek-main",
    type: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    chatModel: "deepseek-v4-pro",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    disabledModels: [],
    modelSettings: {
      "deepseek-v4-flash": {
        temperature: DEFAULT_TEMPERATURE,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        rpmLimit: DEFAULT_RPM_LIMIT,
        tpmLimit: DEFAULT_TPM_LIMIT,
        parallelBatchLimit: DEFAULT_PARALLEL_BATCH_LIMIT,
        thinkingEnabled: false,
        reasoningEffort: "high"
      },
      "deepseek-v4-pro": {
        temperature: DEFAULT_TEMPERATURE,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        rpmLimit: DEFAULT_RPM_LIMIT,
        tpmLimit: DEFAULT_TPM_LIMIT,
        parallelBatchLimit: DEFAULT_PARALLEL_BATCH_LIMIT,
        thinkingEnabled: true,
        reasoningEffort: "max"
      }
    },
    apiKey: "",
    rpmLimit: DEFAULT_RPM_LIMIT,
    tpmLimit: DEFAULT_TPM_LIMIT,
    temperature: DEFAULT_TEMPERATURE,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    parallelBatchLimit: DEFAULT_PARALLEL_BATCH_LIMIT,
    thinkingEnabled: true,
    reasoningEffort: "high"
  }
];

function secretsPath(): string {
  return path.join(app.getPath("userData"), "provider-secrets.json");
}

function providersPath(): string {
  return path.join(app.getPath("userData"), "providers.json");
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "provider-settings.json");
}

export async function loadProviderSecrets(): Promise<SecretStore> {
  return readJson<SecretStore>(secretsPath(), {});
}

export async function saveProviderSecrets(providers: ProviderConfig[]): Promise<void> {
  const current: SecretStore = {};
  for (const provider of providers) {
    if (provider.apiKey.trim()) {
      current[provider.id] = provider.apiKey.trim();
    }
  }
  await fs.mkdir(path.dirname(secretsPath()), { recursive: true });
  await writeJson(secretsPath(), current);
}

export async function hydrateProviderSecrets(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const secrets = await loadProviderSecrets();
  return providers.map((provider) => ({
    ...provider,
    apiKey: secrets[provider.id] ?? provider.apiKey ?? ""
  }));
}

export function stripProviderSecrets(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.map((provider) => ({
    ...provider,
    apiKey: ""
  }));
}

export async function loadProviders(): Promise<ProviderConfig[]> {
  const saved = await readJson<ProviderConfig[]>(providersPath(), []);
  const source = saved.length ? saved : defaultProviders();
  return hydrateProviderSecrets(source.map((provider) => normalizeProviderConfig({ ...provider, apiKey: "" })));
}

export async function saveProviders(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  await saveProviderSecrets(providers);
  await fs.mkdir(path.dirname(providersPath()), { recursive: true });
  await writeJson(providersPath(), stripProviderSecrets(providers));
  return loadProviders();
}

export async function loadActiveProviderId(): Promise<string> {
  const settings = await readJson<ProviderSettings>(settingsPath(), { activeProviderId: "deepseek-main" });
  const providers = await loadProviders();
  return providers.some((provider) => provider.id === settings.activeProviderId) ? settings.activeProviderId : providers[0]?.id ?? "deepseek-main";
}

export async function saveActiveProviderId(activeProviderId: string): Promise<string> {
  const settings = await readJson<ProviderSettings>(settingsPath(), { activeProviderId: "deepseek-main" });
  await writeJson(settingsPath(), { ...settings, activeProviderId });
  return activeProviderId;
}

export async function loadActiveChatProviderId(): Promise<string> {
  const settings = await readJson<ProviderSettings>(settingsPath(), { activeProviderId: "deepseek-main", activeChatProviderId: "deepseek-main" });
  const providers = await loadProviders();
  const preferred = settings.activeChatProviderId ?? "deepseek-main";
  return providers.some((provider) => provider.id === preferred) ? preferred : providers[0]?.id ?? "deepseek-main";
}

export async function saveActiveChatProviderId(activeChatProviderId: string): Promise<string> {
  const settings = await readJson<ProviderSettings>(settingsPath(), { activeProviderId: "deepseek-main" });
  await writeJson(settingsPath(), { ...settings, activeChatProviderId });
  return activeChatProviderId;
}

function normalizeProviderConfig(provider: ProviderConfig): ProviderConfig {
  let next = { ...provider, chatModel: provider.chatModel || provider.model };
  if (provider.type === "deepseek" && ["deepseek-chat", "deepseek-reasoner"].includes(provider.model)) {
    next = { ...next, model: "deepseek-v4-flash" };
  }
  if (provider.type === "openai" && ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-5.2"].includes(provider.model)) {
    next = { ...next, model: "gpt-5.5" };
  }
  if (next.type === "deepseek" && ["deepseek-chat", "deepseek-reasoner"].includes(next.chatModel)) {
    next = { ...next, chatModel: "deepseek-v4-pro" };
  }
  if (next.id === "deepseek-main" && next.chatModel === "deepseek-v4-flash") {
    next = { ...next, chatModel: "deepseek-v4-pro" };
  }
  if (next.type === "openai" && ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-5.2"].includes(next.chatModel)) {
    next = { ...next, chatModel: "gpt-5.5" };
  }
  const models = Array.isArray(next.models) && next.models.length ? next.models.map(String).filter(Boolean) : [next.model];
  const disabledModels = Array.isArray(next.disabledModels) ? next.disabledModels.map(String).filter(Boolean) : [];
  const modelSettings = typeof next.modelSettings === "object" && next.modelSettings ? next.modelSettings : {};
  const mergedModels = Array.from(new Set([next.model, next.chatModel, ...models].filter(Boolean)));
  const providerTemperature = normalizePositiveNumber(next.temperature, DEFAULT_TEMPERATURE);
  const providerRpmLimit = normalizePositiveInteger(next.rpmLimit, DEFAULT_RPM_LIMIT);
  const providerTpmLimit = normalizePositiveInteger(next.tpmLimit, DEFAULT_TPM_LIMIT);
  const providerMaxOutputTokens = normalizePositiveInteger(next.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  const providerParallelBatchLimit = normalizePositiveInteger(next.parallelBatchLimit, DEFAULT_PARALLEL_BATCH_LIMIT);
  for (const model of mergedModels) {
    modelSettings[model] = {
      temperature: normalizePositiveNumber(modelSettings[model]?.temperature, providerTemperature),
      maxOutputTokens: normalizePositiveInteger(modelSettings[model]?.maxOutputTokens, providerMaxOutputTokens),
      rpmLimit: normalizePositiveInteger(modelSettings[model]?.rpmLimit, providerRpmLimit),
      tpmLimit: normalizePositiveInteger(modelSettings[model]?.tpmLimit, providerTpmLimit),
      parallelBatchLimit: normalizePositiveInteger(modelSettings[model]?.parallelBatchLimit, providerParallelBatchLimit),
      thinkingEnabled: modelSettings[model]?.thinkingEnabled ?? defaultThinkingEnabled(next, model),
      reasoningEffort: normalizeReasoningEffort(modelSettings[model]?.reasoningEffort ?? defaultReasoningEffort(next, model), next.type)
    };
  }
  next = {
    ...next,
    models: mergedModels,
    disabledModels,
    modelSettings,
    temperature: providerTemperature,
    maxOutputTokens: providerMaxOutputTokens,
    rpmLimit: providerRpmLimit,
    tpmLimit: providerTpmLimit,
    parallelBatchLimit: providerParallelBatchLimit,
    thinkingEnabled: next.thinkingEnabled ?? true,
    reasoningEffort: normalizeReasoningEffort(next.reasoningEffort, next.type)
  };
  return next;
}

function defaultThinkingEnabled(provider: ProviderConfig, model: string): boolean {
  if (provider.type === "deepseek" && model === "deepseek-v4-flash") return false;
  return provider.thinkingEnabled ?? true;
}

function defaultReasoningEffort(provider: ProviderConfig, model: string): ProviderConfig["reasoningEffort"] {
  if (provider.type === "deepseek" && model === "deepseek-v4-pro") return "max";
  if (provider.type === "openai") return provider.reasoningEffort ?? "medium";
  return provider.reasoningEffort ?? "high";
}

function normalizeReasoningEffort(value: ProviderConfig["reasoningEffort"], type: ProviderConfig["type"]): NonNullable<ProviderConfig["reasoningEffort"]> {
  if (type === "deepseek") return value === "max" || value === "xhigh" ? "max" : "high";
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(value)) ? (value as NonNullable<ProviderConfig["reasoningEffort"]>) : "medium";
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}
