import React, { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import type { AppStateSnapshot, AppVersionInfo, NetworkProxySettings, OnlineDictionarySource, ProviderConfig, UpdateCheckResult, UpdateDescriptor } from "../../shared/types";
import { CommandSelect, FontSelect, FontSizeControl } from "../components/ui/Selectors";
import { FieldRow } from "../components/ui/Form";
import { StyledSelect, ToggleSwitch } from "../components/ui/Primitives";
import {
  apiKeyLinkFor,
  defaultMaxOutputTokens,
  defaultParallelBatchLimit,
  defaultProviderModelSettings,
  defaultRpmLimit,
  defaultTemperature,
  defaultTpmLimit,
  defaultUiSettings,
  effectiveProviderForModel,
  languageSelectOptions,
  modelPresets,
  modelSelectionOptions,
  modelSelectionValue,
  normalizeProviderModelSettings,
  normalizeTablePageSize,
  parseModelSelection,
  providerModelNamesFor,
  type UiSettings
} from "../settingsModel";
const configuredGithubTokenPlaceholder = "configured-token";
const defaultNetworkProxySettings: NetworkProxySettings = {
  schemaVersion: 1,
  enabled: false,
  protocol: "http",
  host: "",
  port: 7890,
  bypassList: "localhost;127.0.0.1;<local>"
};

export default function SettingsView({
  snapshot,
  setSnapshot,
  run,
  showToast,
  tablePageSize,
  setTablePageSize,
  searchPaginationEnabled,
  setSearchPaginationEnabled,
  autoPatchBeforeOutput,
  setAutoPatchBeforeOutput,
  autoCheckUpdates,
  setAutoCheckUpdates,
  uiSettings,
  setUiSettings,
  focusUpdatesRequest,
  initialUpdateCheck
}: {
  snapshot: AppStateSnapshot;
  setSnapshot: React.Dispatch<React.SetStateAction<AppStateSnapshot>>;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  showToast: (message: string, tone?: "success" | "error") => void;
  tablePageSize: number;
  setTablePageSize: React.Dispatch<React.SetStateAction<number>>;
  searchPaginationEnabled: boolean;
  setSearchPaginationEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoPatchBeforeOutput: boolean;
  setAutoPatchBeforeOutput: React.Dispatch<React.SetStateAction<boolean>>;
  autoCheckUpdates: boolean;
  setAutoCheckUpdates: React.Dispatch<React.SetStateAction<boolean>>;
  uiSettings: UiSettings;
  setUiSettings: React.Dispatch<React.SetStateAction<UiSettings>>;
  focusUpdatesRequest?: number;
  initialUpdateCheck?: UpdateCheckResult | null;
}) {
  const [selectedProviderId, setSelectedProviderId] = useState(snapshot.providers[0]?.id ?? "");
  const [advancedModelKeys, setAdvancedModelKeys] = useState<Set<string>>(new Set());
  const [providerModelOrder, setProviderModelOrder] = useState<Record<string, string[]>>({});
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontLoadError, setFontLoadError] = useState("");
  const [onlineSources, setOnlineSources] = useState<OnlineDictionarySource[]>([]);
  const [onlineUseGithubToken, setOnlineUseGithubToken] = useState(true);
  const [selectedOnlineSourceId, setSelectedOnlineSourceId] = useState("");
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [appVersion, setAppVersion] = useState<AppVersionInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [downloadedUpdate, setDownloadedUpdate] = useState<UpdateDescriptor | null>(null);
  const [updateDownloadInProgress, setUpdateDownloadInProgress] = useState(false);
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number | null>(null);
  const [networkProxySettings, setNetworkProxySettings] = useState<NetworkProxySettings | null>(null);
  const projectSettingsRef = useRef<HTMLElement | null>(null);
  const tableSettingsRef = useRef<HTMLElement | null>(null);
  const aboutUpdateRef = useRef<HTMLElement | null>(null);
  const networkProxyRef = useRef<HTMLElement | null>(null);
  const uiSettingsRef = useRef<HTMLElement | null>(null);
  const onlineDictionaryRef = useRef<HTMLElement | null>(null);
  const providersSettingsRef = useRef<HTMLElement | null>(null);
  const modelsSettingsRef = useRef<HTMLElement | null>(null);
  const scrollToSettingsSection = (ref: React.RefObject<HTMLElement | null>) => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const updateProvider = (provider: ProviderConfig) => {
    setSnapshot((state) => ({ ...state, providers: state.providers.map((entry) => (entry.id === provider.id ? provider : entry)) }));
  };
  const updateProject = (patch: Partial<NonNullable<AppStateSnapshot["project"]>>) => {
    if (!snapshot.project) return;
    const nextProject = { ...snapshot.project, ...patch };
    setSnapshot((state) => ({ ...state, project: nextProject }));
    void run("保存项目配置", () => window.bgt.updateProject(nextProject), (next) => setSnapshot(next));
  };
  const updateProjectPort = (value: string) => {
    const trimmed = value.trim();
    updateProject({ previewPort: trimmed ? Number(trimmed) : undefined });
  };
  const updateUiSettings = (patch: Partial<UiSettings>) => {
    setUiSettings((current) => ({ ...current, ...patch }));
  };
  const activeProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeProviderId) ?? snapshot.providers[0];
  const activeChatProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeChatProviderId) ?? activeProvider;
  const selectedProvider = snapshot.providers.find((provider) => provider.id === selectedProviderId) ?? snapshot.providers[0];
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([window.bgt.loadSystemFonts(), window.bgt.getAppVersion()])
      .then(([fontsResult, versionResult]) => {
        if (cancelled) return;
        if (fontsResult.status === "fulfilled") setSystemFonts(fontsResult.value);
        else setFontLoadError(fontsResult.reason instanceof Error ? fontsResult.reason.message : String(fontsResult.reason));
        if (versionResult.status === "fulfilled") {
          setAppVersion(versionResult.value);
          if (versionResult.value.updatePendingRestart) setDownloadedUpdate(versionResult.value.updatePendingRestart);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    window.bgt.loadNetworkProxySettings()
      .then((settings) => {
        if (!cancelled) setNetworkProxySettings(settings);
      })
      .catch((error: unknown) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : String(error), "error");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => window.bgt.onUpdateDownloadProgress((progress) => setUpdateDownloadPercent(progress.percent)), []);
  useEffect(() => {
    if (focusUpdatesRequest) {
      window.setTimeout(() => scrollToSettingsSection(aboutUpdateRef), 0);
    }
  }, [focusUpdatesRequest]);
  useEffect(() => {
    if (initialUpdateCheck?.hasUpdate) setUpdateCheck(initialUpdateCheck);
  }, [initialUpdateCheck?.update?.targetVersion]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([window.bgt.listOnlineDictionarySources(), window.bgt.getOnlineDictionaryTokenStatus()])
      .then(([settings, tokenStatus]) => {
        if (cancelled) return;
        setOnlineSources(settings.sources);
        setOnlineUseGithubToken(settings.useToken !== false);
        setSelectedOnlineSourceId(settings.sources[0]?.id ?? "");
        if (tokenStatus.configured) setGithubTokenDraft(configuredGithubTokenPlaceholder);
      })
      .catch((error: unknown) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : String(error), "error");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const providerIds = new Set(snapshot.providers.map((provider) => provider.id));
    setProviderModelOrder((current) => {
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const provider of snapshot.providers) {
        next[provider.id] = current[provider.id] ?? providerModelNamesFor(provider);
        if (!current[provider.id]) changed = true;
      }
      for (const providerId of Object.keys(current)) {
        if (!providerIds.has(providerId)) changed = true;
      }
      return changed ? next : current;
    });
  }, [snapshot.providers.map((provider) => provider.id).join("|")]);
  useEffect(() => {
    if (!snapshot.providers.length) {
      setSelectedProviderId("");
      return;
    }
    if (!snapshot.providers.some((provider) => provider.id === selectedProviderId)) setSelectedProviderId(snapshot.providers[0].id);
  }, [snapshot.providers, selectedProviderId]);
  const addProvider = () => {
    const id = `model_${Date.now().toString(36)}`;
    const provider: ProviderConfig = {
      id,
      type: "deepseek",
      displayName: "新模型",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      chatModel: "deepseek-v4-pro",
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      disabledModels: [],
      modelSettings: {
        "deepseek-v4-flash": defaultProviderModelSettings(undefined, "deepseek-v4-flash"),
        "deepseek-v4-pro": defaultProviderModelSettings(undefined, "deepseek-v4-pro")
      },
      apiKey: "",
      rpmLimit: defaultRpmLimit,
      tpmLimit: defaultTpmLimit,
      temperature: defaultTemperature,
      maxOutputTokens: defaultMaxOutputTokens,
      parallelBatchLimit: defaultParallelBatchLimit,
      thinkingEnabled: true,
      reasoningEffort: "high"
    };
    setSnapshot((state) => ({ ...state, providers: [...state.providers, provider] }));
    setProviderModelOrder((current) => ({ ...current, [id]: providerModelNamesFor(provider) }));
    setSelectedProviderId(id);
  };
  const deleteSelectedProvider = () => {
    if (!selectedProvider || snapshot.providers.length <= 1) return;
    const nextProviders = snapshot.providers.filter((provider) => provider.id !== selectedProvider.id);
    const fallbackId = nextProviders[0]?.id ?? "";
    setSnapshot((state) => ({
      ...state,
      providers: nextProviders,
      activeProviderId: state.activeProviderId === selectedProvider.id ? fallbackId : state.activeProviderId,
      activeChatProviderId: state.activeChatProviderId === selectedProvider.id ? fallbackId : state.activeChatProviderId
    }));
    setSelectedProviderId(fallbackId);
  };
  const changeProviderType = (provider: ProviderConfig, type: ProviderConfig["type"]) => {
    const model = type === "deepseek" ? "deepseek-v4-flash" : "gpt-5.5";
    const chatModel = type === "deepseek" ? "deepseek-v4-pro" : model;
    const models = modelPresets[type] ?? [model];
    const nextProvider = {
      ...provider,
      type,
      baseUrl: type === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com",
      model,
      chatModel,
      models,
      modelSettings: Object.fromEntries(models.map((modelName) => [modelName, defaultProviderModelSettings({ ...provider, type }, modelName)])),
      thinkingEnabled: type === "deepseek" ? provider.thinkingEnabled ?? true : provider.thinkingEnabled,
      reasoningEffort: type === "deepseek" ? provider.reasoningEffort ?? "high" : provider.reasoningEffort
    };
    updateProvider(nextProvider);
    setProviderModelOrder((current) => ({ ...current, [provider.id]: providerModelNamesFor(nextProvider) }));
  };
  const providerModelNames = (provider: ProviderConfig): string[] => {
    const actual = providerModelNamesFor(provider);
    const order = providerModelOrder[provider.id];
    if (!order) return actual;
    return [...order.filter((model) => actual.includes(model)), ...actual.filter((model) => !order.includes(model))];
  };
  const updateProviderModels = (provider: ProviderConfig, models: string[]) => {
    const cleaned = Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
    const nextModel = cleaned.includes(provider.model) ? provider.model : cleaned[0] ?? provider.model;
    const disabledModels = (provider.disabledModels ?? []).filter((model) => cleaned.includes(model));
    const modelSettings = normalizeProviderModelSettings(provider, cleaned);
    updateProvider({ ...provider, models: cleaned, disabledModels, modelSettings, model: nextModel, chatModel: nextModel });
    setProviderModelOrder((current) => ({ ...current, [provider.id]: cleaned }));
  };
  const addProviderModel = (provider: ProviderConfig) => {
    const current = providerModelNames(provider);
    const preset = (modelPresets[provider.type] ?? []).find((model) => !current.includes(model));
    updateProviderModels(provider, [...current, preset ?? "custom-model"]);
  };
  const updateProviderModelName = (provider: ProviderConfig, index: number, value: string) => {
    const current = providerModelNames(provider);
    const previous = current[index];
    const next = current.map((model, modelIndex) => (modelIndex === index ? value : model));
    const cleaned = Array.from(new Set(next.map((model) => model.trim()).filter(Boolean)));
    const nextName = value.trim() || previous;
    const modelSettings = { ...(provider.modelSettings ?? {}) };
    if (nextName !== previous) {
      modelSettings[nextName] = modelSettings[previous] ?? defaultProviderModelSettings(provider, nextName);
      delete modelSettings[previous];
    }
    updateProvider({
      ...provider,
      models: cleaned,
      modelSettings: normalizeProviderModelSettings({ ...provider, modelSettings }, cleaned),
      disabledModels: (provider.disabledModels ?? []).map((model) => (model === previous ? nextName : model)).filter((model) => cleaned.includes(model)),
      model: provider.model === previous ? nextName : provider.model,
      chatModel: provider.chatModel === previous ? nextName : provider.chatModel
    });
    setProviderModelOrder((current) => ({ ...current, [provider.id]: cleaned }));
  };
  const deleteProviderModel = (provider: ProviderConfig, index: number) => {
    const current = providerModelNames(provider);
    if (current.length <= 1) return;
    const deleted = current[index];
    const next = current.filter((_, modelIndex) => modelIndex !== index);
    const nextModel = provider.model === deleted ? next[0] : provider.model;
    updateProvider({
      ...provider,
      models: next,
      disabledModels: (provider.disabledModels ?? []).filter((model) => model !== deleted),
      modelSettings: Object.fromEntries(Object.entries(provider.modelSettings ?? {}).filter(([model]) => model !== deleted)),
      model: nextModel,
      chatModel: provider.chatModel === deleted ? nextModel : provider.chatModel
    });
    setProviderModelOrder((current) => ({ ...current, [provider.id]: next }));
  };
  const toggleProviderModelEnabled = (provider: ProviderConfig, model: string) => {
    const disabled = new Set(provider.disabledModels ?? []);
    if (disabled.has(model)) disabled.delete(model);
    else disabled.add(model);
    const enabledModels = providerModelNames(provider).filter((entry) => !disabled.has(entry));
    if (!enabledModels.length) return;
    const nextModel = disabled.has(provider.model) ? enabledModels[0] : provider.model;
    const nextChatModel = disabled.has(provider.chatModel) ? nextModel : provider.chatModel;
    updateProvider({ ...provider, disabledModels: Array.from(disabled), model: nextModel, chatModel: nextChatModel });
  };
  const updateProviderModelSettings = (provider: ProviderConfig, model: string, patch: Partial<NonNullable<ProviderConfig["modelSettings"]>[string]>) => {
    updateProvider({
      ...provider,
      modelSettings: {
        ...(provider.modelSettings ?? {}),
        [model]: {
          ...defaultProviderModelSettings(provider, model),
          ...(provider.modelSettings?.[model] ?? {}),
          ...patch
        }
      }
    });
  };
  const toggleModelAdvanced = (providerId: string, model: string) => {
    const key = `${providerId}::${model}`;
    setAdvancedModelKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const saveProvidersAndActive = async () => {
    const providers = await window.bgt.saveProviders(snapshot.providers);
    const validProviderId = providers.some((provider) => provider.id === snapshot.activeProviderId) ? snapshot.activeProviderId : providers[0]?.id ?? "";
    const validChatProviderId = providers.some((provider) => provider.id === snapshot.activeChatProviderId) ? snapshot.activeChatProviderId : validProviderId;
    if (validProviderId) await window.bgt.setActiveProvider(validProviderId);
    if (validChatProviderId) await window.bgt.setActiveChatProvider(validChatProviderId);
    setSnapshot((state) => ({ ...state, providers, activeProviderId: validProviderId, activeChatProviderId: validChatProviderId }));
    return providers;
  };
  const selectedOnlineSource = onlineSources.find((source) => source.id === selectedOnlineSourceId) ?? onlineSources[0];
  const selectedOnlineSourceReadonly = Boolean(selectedOnlineSource && isReadonlyOnlineSource(selectedOnlineSource));
  const updateOnlineSource = (source: OnlineDictionarySource) => {
    if (isReadonlyOnlineSource(source)) return;
    setOnlineSources((sources) => sources.map((entry) => (entry.id === source.id ? source : entry)));
  };
  const addOnlineSource = () => {
    const id = `source_${Date.now().toString(36)}`;
    const source: OnlineDictionarySource = {
      id,
      displayName: "新在线仓库",
      url: "https://github.com/Heptagon196/BrowserGameTranslator",
      owner: "Heptagon196",
      repo: "BrowserGameTranslator",
      dictionaryCategory: "词典",
      extractionRuleCategory: "提取规则",
      enabled: true
    };
    setOnlineSources((sources) => [...sources, source]);
    setSelectedOnlineSourceId(id);
  };
  const deleteOnlineSource = () => {
    if (!selectedOnlineSource || isReadonlyOnlineSource(selectedOnlineSource) || onlineSources.length <= 1) return;
    const next = onlineSources.filter((source) => source.id !== selectedOnlineSource.id);
    setOnlineSources(next);
    setSelectedOnlineSourceId(next[0]?.id ?? "");
  };
  const saveOnlineSources = async () => {
    const settings = await window.bgt.saveOnlineDictionarySources({ schemaVersion: 1, sources: onlineSources, useToken: onlineUseGithubToken });
    if (githubTokenDraft.trim() && githubTokenDraft !== configuredGithubTokenPlaceholder) {
      await window.bgt.saveOnlineDictionaryToken(githubTokenDraft);
      setGithubTokenDraft(configuredGithubTokenPlaceholder);
    }
    setOnlineSources(settings.sources);
    setOnlineUseGithubToken(settings.useToken !== false);
    if (!settings.sources.some((source) => source.id === selectedOnlineSourceId)) setSelectedOnlineSourceId(settings.sources[0]?.id ?? "");
    return settings;
  };
  const testOnlineSource = async () => {
    if (!selectedOnlineSource) return;
    const settings = await window.bgt.saveOnlineDictionarySources({ schemaVersion: 1, sources: onlineSources, useToken: onlineUseGithubToken });
    setOnlineSources(settings.sources);
    setOnlineUseGithubToken(settings.useToken !== false);
    const sourceId = settings.sources.find((source) => source.id === selectedOnlineSource.id)?.id ?? settings.sources[0]?.id ?? "";
    const result = await window.bgt.testOnlineDictionarySource(sourceId);
    if (!result.ok) throw new Error(result.message);
    return result;
  };
  const checkSoftwareUpdate = async () => {
    const result = await window.bgt.checkForUpdates();
    setUpdateCheck(result);
    setDownloadedUpdate(null);
    if (result.error) showToast(result.error, "error");
    else showToast(result.hasUpdate ? "发现新版本" : "当前已是最新版本");
    return result;
  };
  const downloadSoftwareUpdate = async () => {
    const update = updateCheck?.update;
    if (!update || updateDownloadInProgress) return;
    setUpdateDownloadInProgress(true);
    try {
      setUpdateDownloadPercent(0);
      await window.bgt.downloadUpdate(update.raw);
      setDownloadedUpdate(update);
      return update;
    } finally {
      setUpdateDownloadInProgress(false);
    }
  };
  const applySoftwareUpdate = async () => {
    const update = downloadedUpdate ?? updateCheck?.update;
    if (!update) return;
    await window.bgt.applyUpdate(update.raw);
  };
  const updateNetworkProxySettings = (patch: Partial<NetworkProxySettings>) => {
    setNetworkProxySettings((current) => ({ ...(current ?? defaultNetworkProxySettings), ...patch }));
  };
  const saveNetworkProxySettings = async () => {
    const settings = networkProxySettings ?? defaultNetworkProxySettings;
    const host = settings.host.trim();
    if (settings.enabled && !host) throw new Error("启用代理时需要填写代理主机。");
    if (settings.enabled && (!Number.isFinite(settings.port) || settings.port < 1 || settings.port > 65535)) {
      throw new Error("代理端口需要在 1 到 65535 之间。");
    }
    const saved = await window.bgt.saveNetworkProxySettings({ ...settings, host });
    setNetworkProxySettings(saved);
    return saved;
  };
  const displayedNetworkProxySettings = networkProxySettings ?? defaultNetworkProxySettings;
  const networkProxyLoaded = Boolean(networkProxySettings);
  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="设置分类">
        <button className="settings-nav-primary" disabled={!snapshot.project} onClick={() => scrollToSettingsSection(projectSettingsRef)}>
          当前项目
        </button>
        <div className="settings-subnav">
          <button disabled={!snapshot.project} onClick={() => scrollToSettingsSection(projectSettingsRef)}>翻译设置</button>
        </div>
        <button className="settings-nav-primary" onClick={() => scrollToSettingsSection(tableSettingsRef)}>
          系统设置
        </button>
        <div className="settings-subnav">
          <button onClick={() => scrollToSettingsSection(aboutUpdateRef)}>关于与更新</button>
          <button onClick={() => scrollToSettingsSection(networkProxyRef)}>网络代理</button>
          <button onClick={() => scrollToSettingsSection(tableSettingsRef)}>全局设置</button>
          <button onClick={() => scrollToSettingsSection(uiSettingsRef)}>界面</button>
          <button onClick={() => scrollToSettingsSection(onlineDictionaryRef)}>在线仓库</button>
        </div>
        <button className="settings-nav-primary" onClick={() => scrollToSettingsSection(providersSettingsRef)}>
          AI 后端
        </button>
        <div className="settings-subnav">
          <button onClick={() => scrollToSettingsSection(providersSettingsRef)}>供应商</button>
          <button onClick={() => scrollToSettingsSection(modelsSettingsRef)}>模型使用</button>
        </div>
      </nav>
      <div className="settings-content">
        <section ref={projectSettingsRef} className="settings-section">
          {snapshot.project ? (
            <div className="panel">
              <h2>项目翻译设置</h2>
              <div className="form-grid">
                <label>
                  源语言
                  <StyledSelect value={snapshot.project.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => updateProject({ sourceLanguage })} />
                </label>
                <label>
                  目标语言
                  <StyledSelect value={snapshot.project.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => updateProject({ targetLanguage })} />
                </label>
                <label className="wide">
                  首页
                  <input value={snapshot.project.homePage || "index.html"} onChange={(event) => updateProject({ homePage: event.target.value || "index.html" })} />
                </label>
                <label>
                  端口
                  <input
                    type="number"
                    step="1"
                    placeholder="自动分配"
                    value={snapshot.project.previewPort ?? ""}
                    onChange={(event) => updateProjectPort(event.target.value)}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="panel empty-state">
              <h2>未打开项目</h2>
              <p>打开项目后可以编辑源语言、目标语言和首页。</p>
            </div>
          )}
        </section>
        <section ref={aboutUpdateRef} className="settings-section">
          <div className="panel">
            <h2>关于与更新</h2>
            <div className="settings-form">
              <FieldRow label="当前版本" description={appVersion?.installedByUpdater ? `Velopack ${appVersion.isPortable ? "便携版" : "安装版"}${appVersion.appId ? ` · ${appVersion.appId}` : ""}` : "当前运行环境不支持应用内更新。"}>
                <input value={appVersion?.currentVersion ?? "读取中..."} disabled />
              </FieldRow>
              <FieldRow label="启动时自动检查更新" description="开启后，每次打开软件时会检查 GitHub Releases；发现新版本时弹出提示。">
                <ToggleSwitch checked={autoCheckUpdates} onChange={setAutoCheckUpdates} />
              </FieldRow>
              <FieldRow label="更新状态" description={updateCheck?.error || appVersion?.error || (downloadedUpdate ? `已准备好 ${downloadedUpdate.targetVersion}` : updateDownloadInProgress ? "正在下载更新包，请等待完成。" : updateCheck?.hasUpdate ? `发现 ${updateCheck.update?.targetVersion}` : "手动检查 GitHub Releases 上的 Velopack 更新包。")}>
                <input
                  value={
                    downloadedUpdate
                      ? "更新已下载，等待重启应用"
                      : updateDownloadInProgress
                        ? "正在下载更新"
                      : updateCheck
                        ? updateCheck.hasUpdate
                          ? "有可用更新"
                          : updateCheck.error
                            ? "检查失败"
                            : "当前已是最新版本"
                        : "尚未检查"
                  }
                  disabled
                />
              </FieldRow>
              {updateCheck?.update ? (
                <FieldRow label="可用版本" description={updateCheck.update.packageFileName ? `${updateCheck.update.packageFileName}${updateCheck.update.packageSize ? ` · ${formatBytes(updateCheck.update.packageSize)}` : ""}` : "Velopack 更新包"}>
                  <input value={updateCheck.update.targetVersion} disabled />
                </FieldRow>
              ) : null}
              {updateDownloadPercent !== null && !downloadedUpdate ? (
                <FieldRow label="下载进度" description="下载完成后可以重启并应用更新。">
                  <input value={`${Math.round(updateDownloadPercent)}%`} disabled />
                </FieldRow>
              ) : null}
              {updateCheck?.update?.releaseNotes ? (
                <FieldRow label="更新说明" description="来自 Velopack release notes。">
                  <textarea value={updateCheck.update.releaseNotes} disabled rows={5} />
                </FieldRow>
              ) : null}
              <div className="button-row">
                <button className="secondary-button" onClick={() => run("检查软件更新", checkSoftwareUpdate)}>
                  <RefreshCw size={16} />
                  检查更新
                </button>
                <button className="secondary-button" disabled={!updateCheck?.update || Boolean(downloadedUpdate) || updateDownloadInProgress} onClick={() => run("下载软件更新", downloadSoftwareUpdate, () => showToast("更新已下载"))}>
                  <Download size={16} />
                  {updateDownloadInProgress ? "下载中" : "下载更新"}
                </button>
                <button disabled={!downloadedUpdate || updateDownloadInProgress} onClick={() => run("重启并应用更新", applySoftwareUpdate)}>
                  <RotateCcw size={16} />
                  重启并应用
                </button>
                <button className="secondary-button" onClick={() => void window.bgt.openExternal("https://github.com/Heptagon196/BrowserGameTranslator/releases")}>
                  <ExternalLink size={16} />
                  打开 Releases
                </button>
              </div>
            </div>
          </div>
        </section>
        <section ref={networkProxyRef} className="settings-section">
          <div className="panel">
            <h2>网络代理</h2>
            <div className="settings-form">
              <FieldRow label="启用代理" description="开启后，应用内网络请求会通过这里配置的代理访问。支持 HTTP 和 SOCKS5。">
                <ToggleSwitch checked={displayedNetworkProxySettings.enabled} disabled={!networkProxyLoaded} onChange={(enabled) => updateNetworkProxySettings({ enabled })} />
              </FieldRow>
              <FieldRow label="代理类型" description="HTTP 代理会同时用于 HTTP/HTTPS 请求；SOCKS5 会作为全局代理规则。">
                <StyledSelect
                  value={displayedNetworkProxySettings.protocol}
                  options={[
                    { value: "http", label: "HTTP" },
                    { value: "socks5", label: "SOCKS5" }
                  ]}
                  disabled={!networkProxyLoaded}
                  onChange={(protocol) => updateNetworkProxySettings({ protocol: protocol === "socks5" ? "socks5" : "http" })}
                />
              </FieldRow>
              <FieldRow label="代理主机" description="例如 127.0.0.1。不要包含 http:// 或 socks5://。">
                <input value={displayedNetworkProxySettings.host} disabled={!networkProxyLoaded} placeholder={networkProxyLoaded ? "127.0.0.1" : "读取中..."} onChange={(event) => updateNetworkProxySettings({ host: event.target.value })} />
              </FieldRow>
              <FieldRow label="代理端口" description="例如 7890、1080。">
                <input
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  value={displayedNetworkProxySettings.port}
                  disabled={!networkProxyLoaded}
                  onChange={(event) => updateNetworkProxySettings({ port: Number(event.target.value) })}
                />
              </FieldRow>
              <FieldRow label="绕过列表" description="分号分隔。默认绕过 localhost、127.0.0.1 和本地地址。">
                <input value={displayedNetworkProxySettings.bypassList} disabled={!networkProxyLoaded} onChange={(event) => updateNetworkProxySettings({ bypassList: event.target.value })} />
              </FieldRow>
              <div className="button-row">
                <button disabled={!networkProxyLoaded} onClick={() => run("保存网络代理设置", saveNetworkProxySettings, () => showToast("网络代理设置已保存"))}>
                  <Save size={16} />
                  保存代理设置
                </button>
                <button className="secondary-button" disabled={!networkProxyLoaded} onClick={() => setNetworkProxySettings(defaultNetworkProxySettings)}>
                  <RotateCcw size={16} />
                  恢复默认
                </button>
              </div>
            </div>
          </div>
        </section>
        <section ref={tableSettingsRef} className="settings-section">
          <div className="panel">
            <h2>全局设置</h2>
            <div className="settings-form">
              <FieldRow label="预览、打包前自动回填" description="开启后，点击预览游戏、再次打开预览或开始打包前，会先把当前文本表译文回填到游戏工作区。">
                <ToggleSwitch checked={autoPatchBeforeOutput} onChange={setAutoPatchBeforeOutput} />
              </FieldRow>
              <FieldRow label="每页行数" description="分页开启时每页最多显示多少行。这个选项只保存在本机，不写入项目。">
                <input
                  type="number"
                  min="20"
                  max="1000"
                  step="10"
                  value={tablePageSize}
                  onChange={(event) => setTablePageSize(normalizeTablePageSize(event.target.value))}
                />
              </FieldRow>
              <FieldRow label="搜索结果分页" description="默认关闭。关闭时，只有搜索条件生效且没有类型筛选时，会直接显示全部搜索结果；筛选始终按项目分页设置处理。">
                <StyledSelect
                  value={searchPaginationEnabled ? "on" : "off"}
                  options={[
                    { value: "off", label: "关闭" },
                    { value: "on", label: "开启" }
                  ]}
                  onChange={(value) => setSearchPaginationEnabled(value === "on")}
                />
              </FieldRow>
            </div>
          </div>
        </section>
        <section ref={uiSettingsRef} className="settings-section">
          <div className="panel">
            <h2>界面显示设置</h2>
            <div className="settings-form">
              <FieldRow label="主界面字体" description="用于导航、按钮、表单和普通文字。留空会恢复默认字体。">
                <FontSelect
                  value={uiSettings.uiFontFamily}
                  defaultValue={defaultUiSettings.uiFontFamily}
                  fonts={systemFonts}
                  fontLoadError={fontLoadError}
                  onChange={(uiFontFamily) => updateUiSettings({ uiFontFamily })}
                />
              </FieldRow>
              <FieldRow label="表格字体" description="用于文本表、资源表、校对表等表格内容。">
                <FontSelect
                  value={uiSettings.tableFontFamily}
                  defaultValue={defaultUiSettings.tableFontFamily}
                  fonts={systemFonts}
                  fontLoadError={fontLoadError}
                  onChange={(tableFontFamily) => updateUiSettings({ tableFontFamily })}
                />
              </FieldRow>
              <FieldRow label="AI 字体" description="用于右侧 AI 聊天、后台记录和 Markdown 内容。">
                <FontSelect
                  value={uiSettings.chatFontFamily}
                  defaultValue={defaultUiSettings.chatFontFamily}
                  fonts={systemFonts}
                  fontLoadError={fontLoadError}
                  onChange={(chatFontFamily) => updateUiSettings({ chatFontFamily })}
                />
              </FieldRow>
              <div className="font-size-settings">
                <FontSizeControl
                  label="基础字号"
                  description="影响普通文字、按钮和表单。"
                  fontFamily={uiSettings.uiFontFamily}
                  value={uiSettings.baseFontSize}
                  defaultValue={defaultUiSettings.baseFontSize}
                  min={10}
                  max={32}
                  onChange={(baseFontSize) => updateUiSettings({ baseFontSize })}
                />
                <FontSizeControl
                  label="侧栏字号"
                  description="影响左侧导航。"
                  fontFamily={uiSettings.uiFontFamily}
                  value={uiSettings.sidebarFontSize}
                  defaultValue={defaultUiSettings.sidebarFontSize}
                  min={10}
                  max={32}
                  onChange={(sidebarFontSize) => updateUiSettings({ sidebarFontSize })}
                />
                <FontSizeControl
                  label="标题字号"
                  description="影响页面标题。"
                  fontFamily={uiSettings.uiFontFamily}
                  value={uiSettings.titleFontSize}
                  defaultValue={defaultUiSettings.titleFontSize}
                  min={14}
                  max={40}
                  onChange={(titleFontSize) => updateUiSettings({ titleFontSize })}
                />
                <FontSizeControl
                  label="表格字号"
                  description="影响各类数据表格。"
                  fontFamily={uiSettings.tableFontFamily}
                  value={uiSettings.tableFontSize}
                  defaultValue={defaultUiSettings.tableFontSize}
                  min={10}
                  max={32}
                  onChange={(tableFontSize) => updateUiSettings({ tableFontSize })}
                />
                <FontSizeControl
                  label="AI 字号"
                  description="影响右侧 AI 聊天和后台记录。"
                  fontFamily={uiSettings.chatFontFamily}
                  value={uiSettings.chatFontSize}
                  defaultValue={defaultUiSettings.chatFontSize}
                  min={10}
                  max={32}
                  onChange={(chatFontSize) => updateUiSettings({ chatFontSize })}
                />
              </div>
              <div className="button-row">
                <button className="secondary-button" onClick={() => setUiSettings(defaultUiSettings)}>恢复默认显示设置</button>
              </div>
            </div>
          </div>
        </section>
        <section ref={onlineDictionaryRef} className="settings-section">
          <div className="panel">
            <div className="prompt-header">
              <div>
                <h2>在线仓库</h2>
                <p>配置 GitHub 仓库 URL 和 Discussions 分类，用于在线词典与规则共享。配置保存在本机，不写入项目工作区。</p>
              </div>
              <button className="secondary-button" onClick={addOnlineSource}>
                <Plus size={16} />
                添加源
              </button>
            </div>
            <div className="model-config-layout">
              <div className="model-config-list">
                {onlineSources.map((source) => (
                  <button
                    key={source.id}
                    className={source.id === selectedOnlineSource?.id ? "model-config-row active" : "model-config-row"}
                    onClick={() => setSelectedOnlineSourceId(source.id)}
                  >
                    <strong>{source.displayName || source.url}</strong>
                    <span>{source.owner}/{source.repo} · 词典: {source.dictionaryCategory} · 提取规则: {source.extractionRuleCategory}{isReadonlyOnlineSource(source) ? " · 只读" : ""}</span>
                  </button>
                ))}
              </div>
              {selectedOnlineSource ? (
                <div className="model-config-detail">
                  <FieldRow label="显示名称" description="显示在词典页在线仓库下拉框中。">
                    <input value={selectedOnlineSource.displayName} disabled={selectedOnlineSourceReadonly} onChange={(event) => updateOnlineSource({ ...selectedOnlineSource, displayName: event.target.value })} />
                  </FieldRow>
                  <FieldRow label="GitHub 仓库 URL" description="填写 GitHub 仓库地址。">
                    <input value={selectedOnlineSource.url} disabled={selectedOnlineSourceReadonly} onChange={(event) => updateOnlineSource({ ...selectedOnlineSource, url: event.target.value })} />
                  </FieldRow>
                  <FieldRow label="词典 Category" description="用于在线词典列表、导入、投稿和更新。默认使用“词典”。">
                    <input value={selectedOnlineSource.dictionaryCategory} disabled={selectedOnlineSourceReadonly} onChange={(event) => updateOnlineSource({ ...selectedOnlineSource, dictionaryCategory: event.target.value })} />
                  </FieldRow>
                  <FieldRow label="提取规则 Category" description="用于在线提取规则包列表、导入和投稿。默认使用“提取规则”。">
                    <input value={selectedOnlineSource.extractionRuleCategory} disabled={selectedOnlineSourceReadonly} onChange={(event) => updateOnlineSource({ ...selectedOnlineSource, extractionRuleCategory: event.target.value })} />
                  </FieldRow>
                  <FieldRow label="启用" description="关闭后不会出现在词典页在线仓库列表中。">
                    <ToggleSwitch checked={selectedOnlineSource.enabled} disabled={selectedOnlineSourceReadonly} onChange={() => updateOnlineSource({ ...selectedOnlineSource, enabled: !selectedOnlineSource.enabled })} />
                  </FieldRow>
                  <FieldRow label="使用 GitHub API Token" description="关闭后即使已保存 token，也按无 token 模式访问在线仓库，方便测试公开网页抓取。">
                    <ToggleSwitch checked={onlineUseGithubToken} onChange={() => setOnlineUseGithubToken((enabled) => !enabled)} />
                  </FieldRow>
                  <FieldRow
                    label="GitHub API Token"
                    description={
                      <>
                        非必填。只用于自动上传/更新词典、访问私有库，或提高 GitHub API 限额。输入新 token 后点击保存会替换。
                        <button className="link-button" type="button" onClick={() => void window.bgt.openExternal("https://github.com/settings/tokens/new?scopes=public_repo")}>
                          <ExternalLink size={14} />
                          获取 Token
                        </button>
                      </>
                    }
                  >
                    <input
                      type="password"
                      value={githubTokenDraft}
                      onFocus={() => {
                        if (githubTokenDraft === configuredGithubTokenPlaceholder) setGithubTokenDraft("");
                      }}
                      onChange={(event) => setGithubTokenDraft(event.target.value)}
                      placeholder="粘贴 GitHub token"
                    />
                  </FieldRow>
                  <div className="button-row">
                    <button onClick={() => run("保存在线仓库设置", saveOnlineSources, () => showToast("在线仓库设置已保存"))}>
                      <Save size={16} />
                      保存
                    </button>
                    <button className="secondary-button" onClick={() => run("测试在线仓库", testOnlineSource, () => showToast("连接仓库成功"))}>测试连接</button>
                    <button className="danger-button" disabled={onlineSources.length <= 1 || selectedOnlineSourceReadonly} onClick={deleteOnlineSource}>
                      <Trash2 size={16} />
                      删除
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>
        <section ref={providersSettingsRef} className="settings-section">
          {snapshot.providers.length > 0 ? (
            <div className="panel">
              <div className="prompt-header">
                <div>
                  <h2>供应商配置</h2>
                  <p>管理 API Key、供应商类型和可用模型名称。配置保存在本机应用数据目录，不写入项目工作区。</p>
                </div>
                <button className="secondary-button" onClick={addProvider}>
                  <Plus size={16} />
                  添加供应商
                </button>
              </div>
              <div className="model-config-layout">
                <div className="model-config-list">
                  {snapshot.providers.map((provider) => (
                    <button
                      key={provider.id}
                      className={provider.id === selectedProvider?.id ? "model-config-row active" : "model-config-row"}
                      onClick={() => setSelectedProviderId(provider.id)}
                    >
                      <strong>{provider.displayName || "未命名模型"}</strong>
                      <span>{provider.type === "deepseek" ? "DeepSeek" : "ChatGPT / OpenAI"} · {provider.model}</span>
                    </button>
                  ))}
                </div>
                {selectedProvider && (
                  <div className="model-config-detail">
                    <FieldRow label="模型命名" description="显示在翻译模型和 AI 介入模型下拉框中的名称。">
                      <input value={selectedProvider.displayName} onChange={(event) => updateProvider({ ...selectedProvider, displayName: event.target.value })} />
                    </FieldRow>
                    <FieldRow label="供应商" description="选择这个模型配置实际调用的平台。">
                      <StyledSelect
                        value={selectedProvider.type}
                        options={[
                          { value: "deepseek", label: "DeepSeek" },
                          { value: "openai", label: "ChatGPT / OpenAI" }
                        ]}
                        onChange={(value) => changeProviderType(selectedProvider, value as ProviderConfig["type"])}
                      />
                    </FieldRow>
                    <FieldRow
                      label="API Key"
                      description={
                        <>
                          API Key 是调用该平台接口的凭证。不要分享给别人。
                          <button className="link-button" type="button" onClick={() => void window.bgt.openExternal(apiKeyLinkFor(selectedProvider))}>
                            <ExternalLink size={14} />
                            获取 API Key
                          </button>
                        </>
                      }
                    >
                      <input type="password" value={selectedProvider.apiKey} onChange={(event) => updateProvider({ ...selectedProvider, apiKey: event.target.value })} />
                    </FieldRow>
                    <FieldRow label="Base URL" description="接口地址。使用官方平台时保持默认；只有代理或兼容服务才需要修改。">
                      <input value={selectedProvider.baseUrl} onChange={(event) => updateProvider({ ...selectedProvider, baseUrl: event.target.value })} />
                    </FieldRow>
                    <div className="provider-models-block">
                      <div className="provider-models-header">
                        <div>
                          <strong>模型名称列表</strong>
                          <p>维护这个供应商配置下可用的具体模型名。关闭后不会出现在模型选择中；高级选项按每个模型名单独保存。</p>
                        </div>
                      </div>
                      <div className="provider-model-list">
                        {providerModelNames(selectedProvider).map((model, index) => (
                          <div className="provider-model-row" key={`${model}_${index}`}>
                            <div className="provider-model-main">
                              <ToggleSwitch checked={!(selectedProvider.disabledModels ?? []).includes(model)} onChange={() => toggleProviderModelEnabled(selectedProvider, model)} title="启用模型" />
                              <input value={model} onChange={(event) => updateProviderModelName(selectedProvider, index, event.target.value)} />
                              <button className="secondary-button" onClick={() => toggleModelAdvanced(selectedProvider.id, model)}>
                                {advancedModelKeys.has(`${selectedProvider.id}::${model}`) ? "收起高级" : "高级"}
                              </button>
                              <button onClick={() => run("测试模型", () => window.bgt.testProvider(effectiveProviderForModel(selectedProvider, model)), () => showToast("模型连接测试成功"))}>测试</button>
                              <button className="danger-button" disabled={providerModelNames(selectedProvider).length <= 1} onClick={() => deleteProviderModel(selectedProvider, index)}>删除</button>
                            </div>
                            {advancedModelKeys.has(`${selectedProvider.id}::${model}`) && (
                              <div className="provider-model-advanced">
                                <FieldRow label="Temperature" description="控制译文随机性。默认 1.3，数值越高越自由。">
                                  <input type="number" min="0" max="2" step="0.1" value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).temperature ?? defaultTemperature} onChange={(event) => updateProviderModelSettings(selectedProvider, model, { temperature: Number(event.target.value) })} />
                                </FieldRow>
                                <FieldRow label="最大输出 Token" description="单次请求允许模型输出的最大长度。译文被截断时可以调高。">
                                  <input type="number" value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).maxOutputTokens ?? defaultMaxOutputTokens} onChange={(event) => updateProviderModelSettings(selectedProvider, model, { maxOutputTokens: Number(event.target.value) })} />
                                </FieldRow>
                                <FieldRow label="并发批次" description="同时发出的翻译批次数量。提高后速度更快，但更容易触发限速或造成上下文干扰。">
                                  <input type="number" min="1" max="64" step="1" value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).parallelBatchLimit ?? defaultParallelBatchLimit} onChange={(event) => updateProviderModelSettings(selectedProvider, model, { parallelBatchLimit: Number(event.target.value) })} />
                                </FieldRow>
                                {(selectedProvider.type === "deepseek" || selectedProvider.type === "openai") && (
                                  <>
                                    <FieldRow label="思考模式" description={selectedProvider.type === "deepseek" ? "DeepSeek 专用。开启后模型会先进行内部推理；翻译追求速度时可以关闭。" : "OpenAI 推理模型专用。关闭时会尝试发送 reasoning_effort=none；不支持 none 的模型可能由接口返回错误。"}>
                                      <StyledSelect
                                        value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).thinkingEnabled === false ? "disabled" : "enabled"}
                                        options={[
                                          { value: "enabled", label: "开启" },
                                          { value: "disabled", label: "关闭" }
                                        ]}
                                        onChange={(value) => updateProviderModelSettings(selectedProvider, model, { thinkingEnabled: value === "enabled" })}
                                      />
                                    </FieldRow>
                                    <FieldRow label="推理强度" description={selectedProvider.type === "deepseek" ? "DeepSeek 专用。high 适合常规任务，max 适合复杂分析或 AI 介入。" : "OpenAI 推理模型使用 reasoning_effort。翻译建议 none/low，复杂 AI 介入可用 medium/high。"}>
                                      <StyledSelect
                                        value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).reasoningEffort ?? "high"}
                                        options={
                                          selectedProvider.type === "deepseek"
                                            ? [
                                                { value: "high", label: "high" },
                                                { value: "max", label: "max" }
                                              ]
                                            : [
                                                { value: "none", label: "none" },
                                                { value: "minimal", label: "minimal" },
                                                { value: "low", label: "low" },
                                                { value: "medium", label: "medium" },
                                                { value: "high", label: "high" },
                                                { value: "xhigh", label: "xhigh" }
                                              ]
                                        }
                                        onChange={(value) => updateProviderModelSettings(selectedProvider, model, { reasoningEffort: value as ProviderConfig["reasoningEffort"] })}
                                      />
                                    </FieldRow>
                                  </>
                                )}
                                <FieldRow label="RPM" description="每分钟请求数上限。接口报限速错误时调低。">
                                  <input type="number" value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).rpmLimit ?? defaultRpmLimit} onChange={(event) => updateProviderModelSettings(selectedProvider, model, { rpmLimit: Number(event.target.value) })} />
                                </FieldRow>
                                <FieldRow label="TPM" description="每分钟 token 上限。大批量翻译时用于避免超过平台限制。">
                                  <input type="number" value={(selectedProvider.modelSettings?.[model] ?? defaultProviderModelSettings(selectedProvider, model)).tpmLimit ?? defaultTpmLimit} onChange={(event) => updateProviderModelSettings(selectedProvider, model, { tpmLimit: Number(event.target.value) })} />
                                </FieldRow>
                              </div>
                            )}
                          </div>
                        ))}
                        <div className="provider-model-add-row">
                          <button className="secondary-button" onClick={() => addProviderModel(selectedProvider)}>
                            <Plus size={16} />
                            添加模型
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="button-row">
                      <button onClick={() => run("保存模型配置", saveProvidersAndActive, () => showToast("模型配置已保存"))}>
                        <Save size={16} />
                        保存
                      </button>
                      <button className="danger-button" disabled={snapshot.providers.length <= 1} onClick={deleteSelectedProvider}>
                        <Trash2 size={16} />
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="panel empty-state">
              <h2>AI 后端配置加载失败</h2>
              <p>没有可用的供应商配置。请重启应用，或检查应用数据目录中的 provider 配置文件。</p>
            </div>
          )}
        </section>
        <section ref={modelsSettingsRef} className="settings-section">
          {activeProvider ? (
            <div className="panel">
              <h2>模型使用</h2>
              <div className="settings-form">
                <FieldRow label="翻译模型" description="用于分析和批量翻译任务。只显示已开启的模型名。">
                  <CommandSelect
                    value={activeProvider ? modelSelectionValue(activeProvider.id, activeProvider.model) : ""}
                    options={modelSelectionOptions(snapshot.providers)}
                    placeholder="选择翻译模型"
                    emptyText="没有可用模型"
                    onChange={(value) => {
                      const parsed = parseModelSelection(value);
                      if (!parsed) return;
                      const nextProviders = snapshot.providers.map((provider) => (provider.id === parsed.providerId ? { ...provider, model: parsed.model } : provider));
                      setSnapshot((state) => ({ ...state, providers: nextProviders, activeProviderId: parsed.providerId }));
                      void run("保存翻译模型", async () => {
                        await window.bgt.saveProviders(nextProviders);
                        return window.bgt.setActiveProvider(parsed.providerId);
                      }, (activeProviderId) => setSnapshot((state) => ({ ...state, activeProviderId })));
                    }}
                  />
                </FieldRow>
                <FieldRow label="AI 介入模型" description="只用于右侧 AI 聊天窗口，可以和翻译模型不同。只显示已开启的模型名。">
                  <CommandSelect
                    value={activeChatProvider ? modelSelectionValue(activeChatProvider.id, activeChatProvider.chatModel || activeChatProvider.model) : ""}
                    options={modelSelectionOptions(snapshot.providers)}
                    placeholder="选择 AI 介入模型"
                    emptyText="没有可用模型"
                    onChange={(value) => {
                      const parsed = parseModelSelection(value);
                      if (!parsed) return;
                      const nextProviders = snapshot.providers.map((provider) => (provider.id === parsed.providerId ? { ...provider, chatModel: parsed.model } : provider));
                      setSnapshot((state) => ({ ...state, providers: nextProviders, activeChatProviderId: parsed.providerId }));
                      void run("保存 AI 介入模型", async () => {
                        await window.bgt.saveProviders(nextProviders);
                        return window.bgt.setActiveChatProvider(parsed.providerId);
                      }, (activeChatProviderId) => setSnapshot((state) => ({ ...state, activeChatProviderId })));
                    }}
                  />
                </FieldRow>
              </div>
              <p className="settings-note">模型使用设置保存在本机，不写入 `.bgt` 或游戏工作区。</p>
            </div>
          ) : (
            <div className="panel empty-state">
              <h2>没有可用模型</h2>
              <p>请先在“供应商”中配置至少一个可用模型。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function isReadonlyOnlineSource(source: OnlineDictionarySource): boolean {
  return source.readonly === true || source.id === "official";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}


