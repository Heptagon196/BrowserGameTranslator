import React, { Suspense, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Archive,
  BookOpen,
  Bot,
  Download,
  FileSearch,
  FolderOpen,
  Import,
  Languages,
  MessageSquare,
  Play,
  Save,
  Settings,
  ShieldCheck,
  Wrench
} from "lucide-react";
import type {
  AnalysisResult,
  AiBalanceSnapshot,
  AppStateSnapshot,
  CreateProjectInput,
  DictionaryTableSummary,
  PackageFormat,
  PreviewStatus,
  ProofreadOptions,
  ProviderConfig,
  TextItem
} from "../shared/types";
import { FieldRow, PathInput } from "./components/ui/Form";
import { AppDialog, AppTooltip, CheckboxControl, StyledSelect } from "./components/ui/Primitives";
import type { ResourceTableId, TableSettings } from "./components/table/DataTable";
import {
  defaultUiSettings,
  languageLabel,
  languageSelectOptions,
  modelSelectionOptions,
  modelSelectionValue,
  normalizeFontSize,
  normalizeTablePageSize,
  parseModelSelection,
  type UiSettings
} from "./settingsModel";
import "./styles.css";

type ViewId = "project" | "dictionary" | "import" | "analysis" | "translate" | "proofread" | "prompts" | "tools" | "settings";

type LazyWithPreload<T extends React.ComponentType<any>> = React.LazyExoticComponent<T> & {
  preload: () => Promise<{ default: T }>;
};

function lazyWithPreload<T extends React.ComponentType<any>>(loader: () => Promise<{ default: T }>): LazyWithPreload<T> {
  const component = React.lazy(loader) as LazyWithPreload<T>;
  component.preload = loader;
  return component;
}

const ImportExportView = lazyWithPreload(() => import("./views/ImportExportView"));
const AnalysisView = lazyWithPreload(() => import("./views/AnalysisView"));
const TranslateView = lazyWithPreload(() => import("./views/TranslateView"));
const ProofreadView = lazyWithPreload(() => import("./views/ProofreadView"));
const DictionaryView = lazyWithPreload(() => import("./views/DictionaryView"));
const PromptsView = lazyWithPreload(() => import("./views/PromptsView"));
const ToolsView = lazyWithPreload(() => import("./views/ToolsView"));
const SettingsView = lazyWithPreload(() => import("./views/SettingsView"));
const AIChatPanel = lazyWithPreload(() => import("./components/ai-chat/AIChatPanel"));

const tableViewIds = new Set<ViewId>(["import", "analysis", "translate", "proofread"]);
const emptyAnalysis: AnalysisResult = { characters: [], glossary: [], noTranslate: [] };
const defaultProofOptions: ProofreadOptions = {
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
};

const viewPreloaders: Partial<Record<ViewId, () => Promise<unknown>>> = {
  import: ImportExportView.preload,
  analysis: AnalysisView.preload,
  translate: TranslateView.preload,
  proofread: ProofreadView.preload,
  dictionary: DictionaryView.preload,
  prompts: PromptsView.preload,
  tools: ToolsView.preload,
  settings: SettingsView.preload
};
function tableSettingsForProject(pageSize: number, searchPaginationEnabled: boolean): TableSettings {
  return {
    paginationEnabled: false,
    pageSize: normalizeTablePageSize(pageSize),
    searchPaginationEnabled
  };
}

function loadUiSettings(): UiSettings {
  try {
    const stored = JSON.parse(localStorage.getItem("bgt.uiSettings") || "{}") as Partial<UiSettings>;
    return {
      uiFontFamily: stored.uiFontFamily?.trim() || defaultUiSettings.uiFontFamily,
      tableFontFamily: stored.tableFontFamily?.trim() || defaultUiSettings.tableFontFamily,
      chatFontFamily: stored.chatFontFamily?.trim() || defaultUiSettings.chatFontFamily,
      baseFontSize: normalizeFontSize(stored.baseFontSize, defaultUiSettings.baseFontSize),
      sidebarFontSize: normalizeFontSize(stored.sidebarFontSize, defaultUiSettings.sidebarFontSize),
      titleFontSize: normalizeFontSize(stored.titleFontSize, defaultUiSettings.titleFontSize, 14, 40),
      tableFontSize: normalizeFontSize(stored.tableFontSize, defaultUiSettings.tableFontSize),
      chatFontSize: normalizeFontSize(stored.chatFontSize, defaultUiSettings.chatFontSize)
    };
  } catch {
    return defaultUiSettings;
  }
}

function loadProofreadOptions(): ProofreadOptions {
  try {
    const stored = JSON.parse(localStorage.getItem("bgt.proofreadOptions") || "{}") as Partial<ProofreadOptions>;
    const targetLanguageRatio = Number(stored.targetLanguageRatio);
    return {
      languageCheck: stored.languageCheck ?? defaultProofOptions.languageCheck,
      targetLanguageRatio: Number.isFinite(targetLanguageRatio) ? Math.min(1, Math.max(0, targetLanguageRatio)) : defaultProofOptions.targetLanguageRatio,
      characterCheck: stored.characterCheck ?? defaultProofOptions.characterCheck,
      glossaryCheck: stored.glossaryCheck ?? defaultProofOptions.glossaryCheck,
      untranslatedStatusCheck: stored.untranslatedStatusCheck ?? defaultProofOptions.untranslatedStatusCheck,
      noTranslateCheck: stored.noTranslateCheck ?? defaultProofOptions.noTranslateCheck,
      numericResidueCheck: stored.numericResidueCheck ?? defaultProofOptions.numericResidueCheck,
      lineBreakCheck: stored.lineBreakCheck ?? defaultProofOptions.lineBreakCheck,
      placeholderCheck: stored.placeholderCheck ?? defaultProofOptions.placeholderCheck,
      htmlTagCheck: stored.htmlTagCheck ?? defaultProofOptions.htmlTagCheck,
      emptyTranslationCheck: stored.emptyTranslationCheck ?? defaultProofOptions.emptyTranslationCheck
    };
  } catch {
    return defaultProofOptions;
  }
}

function App() {
  const [view, setView] = useState<ViewId>("project");
  const [activeAnalysisTable, setActiveAnalysisTable] = useState<ResourceTableId>("characters");
  const [, startViewTransition] = useTransition();
  const [snapshot, setSnapshot] = useState<AppStateSnapshot>({
    project: null,
    providers: [],
    activeProviderId: "deepseek-main",
    activeChatProviderId: "deepseek-main",
    recentProjects: [],
    textItems: [],
    scanReport: null,
    aiLocalizationPlan: null,
    analysis: emptyAnalysis,
    issues: []
  });
  const [busy, setBusy] = useState(false);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [chatFullscreen, setChatFullscreen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(true);
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [packageFormat, setPackageFormat] = useState<PackageFormat>("zip");
  const [packageFileName, setPackageFileName] = useState("");
  const [packageOutputDirectory, setPackageOutputDirectory] = useState("");
  const [packageAddLauncher, setPackageAddLauncher] = useState(false);
  const [lastPackagePath, setLastPackagePath] = useState("");
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>({ running: false });
  const [aiBalance, setAiBalance] = useState<AiBalanceSnapshot | null>(null);
  const [status, setStatus] = useState("未打开项目");
  const [proofOptions, setProofOptions] = useState(loadProofreadOptions);
  const [searchPaginationEnabled, setSearchPaginationEnabled] = useState(() => localStorage.getItem("bgt.searchPaginationEnabled") === "true");
  const [tablePageSize, setTablePageSize] = useState(() => normalizeTablePageSize(localStorage.getItem("bgt.tablePageSize")));
  const [uiSettings, setUiSettings] = useState(loadUiSettings);

  const activeProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeProviderId) ?? snapshot.providers[0];
  const activeChatProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeChatProviderId) ?? activeProvider;
  const chatProvider = activeChatProvider ? { ...activeChatProvider, model: activeChatProvider.chatModel || activeChatProvider.model } : undefined;
  const deepSeekBalanceProvider = [chatProvider, activeProvider].find((provider) => provider?.type === "deepseek" && provider.apiKey);
  const deepSeekBalanceProviderRef = useRef(deepSeekBalanceProvider);
  const lastBalanceFetchAtRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  const tableSettings = tableSettingsForProject(tablePageSize, searchPaginationEnabled);

  const showToast = (message: string, tone: "success" | "error" = "success") => {
    if (tone === "error") toast.error(message);
    else toast.success(message);
  };

  const run = async <T,>(message: string, task: () => Promise<T>, onDone?: (value: T) => void): Promise<T | undefined> => {
    setBusy(true);
    setStatus(message);
    try {
      const value = await task();
      onDone?.(value);
      setStatus("完成");
      return value;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStatus(text);
      showToast(text, "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const mergeSnapshot = (next?: AppStateSnapshot | null) => {
    if (next) setSnapshot(next);
  };

  const preloadView = useCallback((nextView: ViewId) => {
    void viewPreloaders[nextView]?.();
    if (nextView !== "project" && chatCollapsed) void AIChatPanel.preload();
  }, [chatCollapsed]);

  const navigateTo = (nextView: ViewId) => {
    preloadView(nextView);
    startViewTransition(() => setView(nextView));
  };

  const refreshAiBalance = useCallback(async (provider?: ProviderConfig, force = false) => {
    if (!provider || provider.type !== "deepseek" || !provider.apiKey) return;
    if (!force && Date.now() - lastBalanceFetchAtRef.current < 60_000) return;
    lastBalanceFetchAtRef.current = Date.now();
    const balance = await window.bgt.loadAiBalance(provider);
    setAiBalance(balance);
  }, []);

  const saveItems = async (items: TextItem[]) =>
    run("保存文本项", () => window.bgt.saveTextItems(items), (textItems) => setSnapshot((state) => ({ ...state, textItems })));

  const openPackageModal = () => {
    if (!snapshot.project) return;
    setPackageFileName(snapshot.project.projectName);
    setPackageOutputDirectory(snapshot.project.projectRoot);
    setPackageFormat("zip");
    setPackageAddLauncher(true);
    setLastPackagePath("");
    setPackageModalOpen(true);
  };

  const choosePackageOutputDirectory = async () => {
    const selected = await window.bgt.selectDirectory();
    if (selected) setPackageOutputDirectory(selected);
  };

  const startPackage = () => {
    if (!snapshot.project) return;
    void run(
      "打包最终成果",
      () =>
        window.bgt.packageProject({
          fileName: packageFileName,
          format: packageFormat,
          addLauncher: packageAddLauncher,
          outputDirectory: packageOutputDirectory
        }),
      (result) => {
        setLastPackagePath(result.archivePath);
        showToast(`打包完成：${formatBytes(result.bytes)}`);
      }
    );
  };

  const previewGame = () => {
    void run("预览游戏", () => window.bgt.previewGame(), (url) => {
      setPreviewStatus({ running: true, url });
      showToast("网页服务已启动");
    });
  };

  const stopPreview = () => {
    void run("停止网页服务", () => window.bgt.stopPreview(), () => {
      setPreviewStatus({ running: false });
      showToast("网页服务已停止");
    });
  };

  const switchAiModel = (value: string) => {
    const parsed = parseModelSelection(value);
    if (!parsed) return;
    const selectedProvider = snapshot.providers.find((provider) => provider.id === parsed.providerId);
    if (!selectedProvider) return;
    const nextProviders = snapshot.providers.map((provider) => (provider.id === selectedProvider.id ? { ...provider, chatModel: parsed.model } : provider));
    setSnapshot((state) => ({ ...state, providers: nextProviders, activeChatProviderId: selectedProvider.id }));
    void run(
      "切换 AI 介入模型",
      async () => {
        await window.bgt.saveProviders(nextProviders);
        return window.bgt.setActiveChatProvider(selectedProvider.id);
      },
      (activeChatProviderId) => {
        setSnapshot((state) => ({ ...state, activeChatProviderId }));
        showToast(`AI 介入模型已切换：${selectedProvider.displayName || selectedProvider.model} / ${parsed.model}`);
      }
    );
  };

  useEffect(() => {
    const loadInitial = async () => {
      const [providerState, recentProjects] = await Promise.all([window.bgt.loadProviders(), window.bgt.loadRecentProjects()]);
      setSnapshot((state) => ({ ...state, ...providerState, recentProjects }));
      void Promise.all([PromptsView.preload(), ToolsView.preload(), SettingsView.preload()]);
    };
    void loadInitial();
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    return window.bgt.onAiCostUpdate(() => {
      void refreshAiBalance(deepSeekBalanceProviderRef.current);
    });
  }, [refreshAiBalance]);

  useEffect(() => {
    deepSeekBalanceProviderRef.current = deepSeekBalanceProvider;
  }, [deepSeekBalanceProvider]);

  useEffect(() => {
    if (!deepSeekBalanceProvider) {
      setAiBalance(null);
      lastBalanceFetchAtRef.current = 0;
      return;
    }
    let cancelled = false;
    lastBalanceFetchAtRef.current = Date.now();
    window.bgt.loadAiBalance(deepSeekBalanceProvider).then((balance) => {
      if (!cancelled) setAiBalance(balance);
    });
    return () => {
      cancelled = true;
    };
  }, [deepSeekBalanceProvider?.id, deepSeekBalanceProvider?.apiKey, deepSeekBalanceProvider?.baseUrl]);

  useEffect(() => {
    if (!translationBusy || !activeProvider || activeProvider.type !== "deepseek" || !activeProvider.apiKey) return;
    void refreshAiBalance(activeProvider, true);
    const timer = window.setInterval(() => {
      void refreshAiBalance(activeProvider, true);
    }, 60_000);
    return () => {
      window.clearInterval(timer);
      void refreshAiBalance(activeProvider, true);
    };
  }, [translationBusy, activeProvider?.id, activeProvider?.apiKey, activeProvider?.baseUrl, activeProvider?.type, refreshAiBalance]);

  useEffect(() => {
    localStorage.setItem("bgt.searchPaginationEnabled", String(searchPaginationEnabled));
  }, [searchPaginationEnabled]);

  useEffect(() => {
    localStorage.setItem("bgt.tablePageSize", String(tablePageSize));
  }, [tablePageSize]);

  useEffect(() => {
    localStorage.setItem("bgt.proofreadOptions", JSON.stringify(proofOptions));
  }, [proofOptions]);

  useEffect(() => {
    localStorage.setItem("bgt.uiSettings", JSON.stringify(uiSettings));
    const root = document.documentElement;
    root.style.setProperty("--ui-font-family", uiSettings.uiFontFamily);
    root.style.setProperty("--ui-table-font-family", uiSettings.tableFontFamily);
    root.style.setProperty("--ui-chat-font-family", uiSettings.chatFontFamily);
    root.style.setProperty("--ui-base-font-size", `${uiSettings.baseFontSize}px`);
    root.style.setProperty("--ui-sidebar-font-size", `${uiSettings.sidebarFontSize}px`);
    root.style.setProperty("--ui-title-font-size", `${uiSettings.titleFontSize}px`);
    root.style.setProperty("--ui-table-font-size", `${uiSettings.tableFontSize}px`);
    root.style.setProperty("--ui-chat-font-size", `${uiSettings.chatFontSize}px`);
  }, [uiSettings]);

  useEffect(() => {
    if (!snapshot.project) {
      setPreviewStatus({ running: false });
      return;
    }
    let cancelled = false;
    window.bgt.previewStatus().then((value) => {
      if (!cancelled) setPreviewStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot.project?.projectRoot, snapshot.project?.homePage]);

  const workspacePane = (
    <main className="workspace">
      <header className="topbar">
        <div>
          <h1>{viewTitle(view)}</h1>
          <p>{snapshot.project ? `${snapshot.project.projectName} · ${languageLabel(snapshot.project.sourceLanguage)} -> ${languageLabel(snapshot.project.targetLanguage)}` : "创建或打开项目后开始"}</p>
        </div>
        <div className="topbar-actions">
          {chatCollapsed && (
            <AppTooltip content="展开 AI 窗口">
              <button
                className="icon-button"
                aria-label="展开 AI 窗口"
                onMouseEnter={() => void AIChatPanel.preload()}
                onFocus={() => void AIChatPanel.preload()}
                onClick={() => {
                  void AIChatPanel.preload();
                  setChatCollapsed(false);
                }}
              >
                <Bot size={17} />
              </button>
            </AppTooltip>
          )}
        </div>
      </header>
      <section className={tableViewIds.has(view) ? "content table-content" : "content"}>
        {view === "project" && <ProjectView busy={busy} snapshot={snapshot} run={run} mergeSnapshot={mergeSnapshot} showToast={showToast} onOpenTools={() => navigateTo("tools")} />}
        {view === "import" && (
          <Suspense fallback={null}>
            <ImportExportView busy={busy} items={snapshot.textItems} snapshot={snapshot} provider={activeProvider} tableSettings={tableSettings} run={run} setSnapshot={setSnapshot} saveItems={saveItems} />
          </Suspense>
        )}
        {view === "analysis" && (
          <Suspense fallback={null}>
            <AnalysisView
              busy={busy}
              snapshot={snapshot}
              provider={activeProvider}
              tableSettings={tableSettings}
              activeTable={activeAnalysisTable}
              onActiveTableChange={setActiveAnalysisTable}
              run={run}
              setSnapshot={setSnapshot}
            />
          </Suspense>
        )}
        {view === "translate" && (
          <Suspense fallback={null}>
            <TranslateView
              busy={busy || translationBusy}
              snapshot={snapshot}
              provider={activeProvider}
              aiBalance={aiBalance}
              run={run}
              setSnapshot={setSnapshot}
              setTranslationBusy={setTranslationBusy}
              snapshotRef={snapshotRef}
              tableSettings={tableSettings}
            />
          </Suspense>
        )}
        {view === "proofread" && (
          <Suspense fallback={null}>
            <ProofreadView busy={busy} snapshot={snapshot} provider={activeProvider} options={proofOptions} tableSettings={tableSettings} setOptions={setProofOptions} run={run} setSnapshot={setSnapshot} />
          </Suspense>
        )}
        {view === "dictionary" && (
          <Suspense fallback={null}>
            <DictionaryView busy={busy} snapshot={snapshot} tableSettings={tableSettings} run={run} showToast={showToast} />
          </Suspense>
        )}
        {view === "prompts" && (
          <Suspense fallback={null}>
            <PromptsView snapshot={snapshot} run={run} />
          </Suspense>
        )}
        {view === "tools" && (
          <Suspense fallback={null}>
            <ToolsView run={run} />
          </Suspense>
        )}
        {view === "settings" && (
          <Suspense fallback={null}>
            <SettingsView
              snapshot={snapshot}
              setSnapshot={setSnapshot}
              run={run}
              showToast={showToast}
              tablePageSize={tablePageSize}
              setTablePageSize={setTablePageSize}
              searchPaginationEnabled={searchPaginationEnabled}
              setSearchPaginationEnabled={setSearchPaginationEnabled}
              uiSettings={uiSettings}
              setUiSettings={setUiSettings}
            />
          </Suspense>
        )}
      </section>
      <footer className="statusbar">
        <span>{busy ? "任务执行中" : "空闲"}</span>
        <span>{status}</span>
        <span>文本 {snapshot.textItems.length}</span>
        <span>问题 {snapshot.issues.length}</span>
      </footer>
    </main>
  );

  const chatPane = !chatCollapsed ? (
    <Suspense fallback={null}>
      <AIChatPanel
        key={snapshot.project?.projectRoot ?? "no-project"}
        disabled={!snapshot.project}
        selectedModelId={activeChatProvider ? modelSelectionValue(activeChatProvider.id, activeChatProvider.chatModel || activeChatProvider.model) : undefined}
        modelOptions={modelSelectionOptions(snapshot.providers)}
        onModelChange={switchAiModel}
        aiBalance={aiBalance}
        fullscreen={chatFullscreen}
        onToggleFullscreen={() => setChatFullscreen((value) => !value)}
        onCollapse={() => {
          setChatFullscreen(false);
          setChatCollapsed(true);
        }}
        provider={chatProvider}
        onProjectChanged={async () => {
          const refreshed = await window.bgt.refreshProject();
          setSnapshot(refreshed);
        }}
        context={{
          currentView: viewTitle(view),
          ...currentTableContext(view, activeAnalysisTable),
          projectName: snapshot.project?.projectName
        }}
        analysis={snapshot.analysis}
        textItems={snapshot.textItems}
      />
    </Suspense>
  ) : null;

  return (
    <RadixTooltip.Provider delayDuration={220} skipDelayDuration={120}>
      <div className={`app-shell ${chatFullscreen && !chatCollapsed ? "chat-expanded" : ""}`}>
        <aside className="sidebar">
          <div className="brand">
            <Languages size={24} />
            <div>
              <strong>BrowserGameTranslator</strong>
              <span>Offline game AI translation</span>
            </div>
          </div>
          <NavButton active={["project", "import", "analysis", "translate", "proofread"].includes(view)} icon={<FolderOpen size={18} />} label="项目" onClick={() => navigateTo("project")} onPreload={() => preloadView("project")} />
          {snapshot.project ? (
            <div className="sidebar-subnav" aria-label="项目流程">
              <NavButton active={view === "import"} className="nav-subitem" icon={<Import size={16} />} label="提取/回填" onClick={() => navigateTo("import")} onPreload={() => preloadView("import")} />
              <NavButton active={view === "analysis"} className="nav-subitem" icon={<FileSearch size={16} />} label="术语分析" onClick={() => navigateTo("analysis")} onPreload={() => preloadView("analysis")} />
              <NavButton active={view === "translate"} className="nav-subitem" icon={<Bot size={16} />} label="翻译" onClick={() => navigateTo("translate")} onPreload={() => preloadView("translate")} />
              <NavButton active={view === "proofread"} className="nav-subitem" icon={<ShieldCheck size={16} />} label="校对" onClick={() => navigateTo("proofread")} onPreload={() => preloadView("proofread")} />
            </div>
          ) : null}
          <NavButton active={view === "dictionary"} icon={<BookOpen size={18} />} label="词典" onClick={() => navigateTo("dictionary")} onPreload={() => preloadView("dictionary")} />
          <NavButton active={view === "prompts"} icon={<MessageSquare size={18} />} label="提示词" onClick={() => navigateTo("prompts")} onPreload={() => preloadView("prompts")} />
          <NavButton active={view === "tools"} icon={<Wrench size={18} />} label="工具" onClick={() => navigateTo("tools")} onPreload={() => preloadView("tools")} />
          <NavButton active={view === "settings"} icon={<Settings size={18} />} label="设置" onClick={() => navigateTo("settings")} onPreload={() => preloadView("settings")} />
          <div className="sidebar-spacer" />
          <div className="sidebar-actions">
            <button className="sidebar-action-button" disabled={busy || !snapshot.project} onClick={() => run("打开项目目录", () => window.bgt.openProjectDirectoryInShell())}>
              <FolderOpen size={18} />
              打开项目目录
            </button>
            <button className="sidebar-action-button" disabled={busy || !snapshot.project} onClick={openPackageModal}>
              <Archive size={18} />
              打包
            </button>
            {previewStatus.running ? (
              <div className="preview-running-box">
                <div className="preview-running-title">
                  <span>运行中</span>
                  {previewStatus.url && <small>{previewStatus.url}</small>}
                </div>
                <div className="preview-running-actions">
                  <button disabled={busy || !snapshot.project} onClick={previewGame}>
                    <Play size={15} />
                    再次打开
                  </button>
                  <button className="secondary-button" disabled={busy || !snapshot.project} onClick={stopPreview}>
                    停止服务
                  </button>
                </div>
              </div>
            ) : (
              <button className="sidebar-action-button" disabled={busy || !snapshot.project} onClick={previewGame}>
                <Play size={18} />
                预览游戏
              </button>
            )}
          </div>
        </aside>

        {chatCollapsed ? (
          <section className="workspace-region">{workspacePane}</section>
        ) : (
          <Group className={`workspace-region main-chat-panel-group${chatFullscreen ? " chat-fullscreen-group" : ""}`} orientation="horizontal">
            <Panel id="workspace-panel" minSize="320px">
              {workspacePane}
            </Panel>
            <Separator className="main-chat-resize-handle" />
            <Panel id="ai-chat-panel" minSize="300px" maxSize="68%" defaultSize="350px">
              {chatPane}
            </Panel>
          </Group>
        )}

        {snapshot.project && (
          <PackageDialog
            open={packageModalOpen}
            busy={busy}
            projectRoot={snapshot.project.projectRoot}
            projectName={snapshot.project.projectName}
            fileName={packageFileName}
            format={packageFormat}
            outputDirectory={packageOutputDirectory}
            addLauncher={packageAddLauncher}
            lastPackagePath={lastPackagePath}
            onOpenChange={setPackageModalOpen}
            onFileNameChange={setPackageFileName}
            onFormatChange={setPackageFormat}
            onOutputDirectoryChange={setPackageOutputDirectory}
            onPickOutputDirectory={choosePackageOutputDirectory}
            onAddLauncherChange={setPackageAddLauncher}
            onStart={startPackage}
          />
        )}
        <Toaster position="top-center" richColors duration={2600} />
      </div>
    </RadixTooltip.Provider>
  );
}

function ProjectView({
  busy,
  snapshot,
  run,
  mergeSnapshot,
  showToast,
  onOpenTools
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  mergeSnapshot: (snapshot?: AppStateSnapshot | null) => void;
  showToast: (message: string, tone?: "success" | "error") => void;
  onOpenTools: () => void;
}) {
  const [createInput, setCreateInput] = useState<CreateProjectInput | null>(null);
  const [createErrors, setCreateErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!createInput) return;
    let cancelled = false;
    setCreateErrors(["正在检查项目设置..."]);
    window.bgt.validateCreateProject(createInput).then((errors) => {
      if (!cancelled) setCreateErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, [createInput]);

  const openOrCreateProject = async () => {
    const directory = await window.bgt.selectDirectory();
    if (!directory) return;
    const opened = await window.bgt.openProjectDirectory(directory);
    if (opened) {
      mergeSnapshot(opened);
      showToast("项目打开成功");
      return;
    }
    const projectName = basename(directory);
    setCreateInput({
      projectName,
      projectRoot: directory,
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    });
  };

  const chooseProjectRoot = async () => {
    const selected = await window.bgt.selectDirectory();
    if (!selected || !createInput) return;
    setCreateInput({ ...createInput, projectName: basename(selected), projectRoot: selected });
  };

  return (
    <div className="stack">
      <div className="project-actions">
        <button className="project-action" disabled={busy} onClick={openOrCreateProject}>
          <FolderOpen size={28} />
          <span>打开或创建项目</span>
          <small>选择一个游戏目录；已包含 `.bgt` 时直接打开，否则创建新项目</small>
        </button>
        <button className="project-action" disabled={busy} onClick={onOpenTools}>
          <Download size={28} />
          <span>下载游戏</span>
          <small>跳转到工具页，下载 itch.io HTML5 游戏或 AAOnline 游戏</small>
        </button>
      </div>
      {snapshot.project && <MetricGrid snapshot={snapshot} />}
      <div className="panel">
        <h2>最近打开</h2>
        {snapshot.recentProjects.length ? (
          <div className="recent-list">
            {snapshot.recentProjects.map((recent) => (
              <div className="recent-row" key={recent.projectPath}>
                <div>
                  <strong>{recent.projectName}</strong>
                  <span>{recent.projectRoot}</span>
                </div>
                {recent.exists ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run("打开最近项目", () => window.bgt.openRecentProject(recent.projectPath), (opened) => {
                        mergeSnapshot(opened);
                        showToast("项目打开成功");
                      })
                    }
                  >
                    <FolderOpen size={16} />
                    打开
                  </button>
                ) : (
                  <span className="missing-project">找不到项目</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">暂无最近打开项目</p>
        )}
      </div>
      {createInput && (
        <AppDialog open title="创建项目" onOpenChange={(open) => !open && setCreateInput(null)}>
          <div className="single-column-form">
            <FieldRow label="项目名" description="默认使用源目录名称。项目名也会作为目录名的一部分，不能包含特殊字符。">
              <input value={createInput.projectName} onChange={(event) => setCreateInput({ ...createInput, projectName: event.target.value })} />
            </FieldRow>
            <FieldRow label="源语言" description="原游戏文本的主要语言。默认英语。">
              <StyledSelect value={createInput.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => setCreateInput({ ...createInput, sourceLanguage })} />
            </FieldRow>
            <FieldRow label="目标语言" description="要翻译成的语言。默认中文。">
              <StyledSelect value={createInput.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => setCreateInput({ ...createInput, targetLanguage })} />
            </FieldRow>
            <FieldRow label="源游戏目录" description="选择已经下载好的离线网页游戏目录。程序会复制它，不直接改原目录。">
              <PathInput value={createInput.projectRoot} onPick={chooseProjectRoot} />
            </FieldRow>
            <FieldRow label="原始副本" description="程序会把当前游戏文件保存到 .bgt/original；项目根目录作为 AI 工作区和预览目录。">
              <input value={joinPath(createInput.projectRoot, ".bgt/original")} readOnly />
            </FieldRow>
          </div>
          {createErrors.length > 0 && (
            <div className="error-list">
              {createErrors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          )}
          <div className="button-row modal-actions">
            <button className="secondary-button" onClick={() => setCreateInput(null)}>
              取消
            </button>
            <button
              disabled={busy || createErrors.length > 0}
              onClick={() =>
                run("创建项目并复制游戏目录", () => window.bgt.createProject(createInput), (created) => {
                  setCreateInput(null);
                  mergeSnapshot(created);
                  showToast("项目创建成功");
                })
              }
            >
              <Save size={16} />
              创建
            </button>
          </div>
        </AppDialog>
      )}
    </div>
  );
}

function MetricGrid({ snapshot }: { snapshot: AppStateSnapshot }) {
  const translatedCount = snapshot.textItems.filter((item) => item.status === "translated").length;
  const fallbackResourceTotal = countDefaultResourceRows(snapshot.analysis);
  const [resourceTableTotal, setResourceTableTotal] = useState(fallbackResourceTotal);

  useEffect(() => {
    let cancelled = false;
    setResourceTableTotal(fallbackResourceTotal);
    window.bgt
      .listDictionaryTables()
      .then((summaries) => {
        if (!cancelled) setResourceTableTotal(countAllResourceRows(summaries, fallbackResourceTotal));
      })
      .catch(() => {
        if (!cancelled) setResourceTableTotal(fallbackResourceTotal);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.project?.projectRoot, fallbackResourceTotal]);

  return (
    <div className="metric-grid">
      <Metric label="项目目录" value={snapshot.project?.projectRoot ?? "-"} />
      <Metric label="扫描文件" value={String(snapshot.scanReport?.fileCount ?? 0)} />
      <Metric label="文本项" value={String(snapshot.textItems.length)} />
      <Metric label="已翻译" value={String(translatedCount)} />
      <Metric label="术语项" value={String(resourceTableTotal)} />
      <Metric label="校对问题" value={String(snapshot.issues.length)} />
    </div>
  );
}

function countDefaultResourceRows(analysis: AnalysisResult): number {
  return analysis.characters.length + analysis.glossary.length + analysis.noTranslate.length;
}

function countAllResourceRows(summaries: DictionaryTableSummary[], fallback: number): number {
  const total = summaries
    .filter((item) => item.scope === "projectDefault" || item.scope === "project")
    .filter((item) => item.tableType === "characters" || item.tableType === "glossary" || item.tableType === "noTranslate")
    .reduce((sum, item) => sum + item.rowCount, 0);
  return total || fallback;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PackageDialog({
  open,
  busy,
  projectRoot,
  projectName,
  fileName,
  format,
  outputDirectory,
  addLauncher,
  lastPackagePath,
  onOpenChange,
  onFileNameChange,
  onFormatChange,
  onOutputDirectoryChange,
  onPickOutputDirectory,
  onAddLauncherChange,
  onStart
}: {
  open: boolean;
  busy: boolean;
  projectRoot: string;
  projectName: string;
  fileName: string;
  format: PackageFormat;
  outputDirectory: string;
  addLauncher: boolean;
  lastPackagePath: string;
  onOpenChange: (open: boolean) => void;
  onFileNameChange: (value: string) => void;
  onFormatChange: (value: PackageFormat) => void;
  onOutputDirectoryChange: (value: string) => void;
  onPickOutputDirectory: () => void;
  onAddLauncherChange: (value: boolean) => void;
  onStart: () => void;
}) {
  return (
    <AppDialog open={open} title="打包最终成果" description="将项目根目录中除 `.bgt` 外的当前游戏文件打包。默认输出到游戏根目录。" compact onOpenChange={onOpenChange}>
      <div className="settings-form">
        <FieldRow label="文件名" description="只填写名称，不需要扩展名。非法字符会在打包时自动替换。">
          <input value={fileName} onChange={(event) => onFileNameChange(event.target.value)} />
        </FieldRow>
        <FieldRow label="格式" description="默认使用 zip，方便分享和解压；也可以选择 7z 或 tar.xz。">
          <StyledSelect
            value={format}
            options={[
              { value: "zip", label: "zip" },
              { value: "7z", label: "7z" },
              { value: "tar.xz", label: "tar.xz" }
            ]}
            onChange={(value) => onFormatChange(value as PackageFormat)}
          />
        </FieldRow>
        <FieldRow label="输出目录" description="默认保存到游戏根目录，也可以选择其它目录。">
          <PathInput value={outputDirectory} onPick={onPickOutputDirectory} onChange={onOutputDirectoryChange} />
        </FieldRow>
        <FieldRow label="输出文件" description="实际生成的压缩包路径。">
          <input value={joinPath(outputDirectory || projectRoot, `${fileName || projectName}.${format}`)} readOnly />
        </FieldRow>
        <label className="checkbox-row">
          <CheckboxControl checked={addLauncher} onChange={onAddLauncherChange} />
          添加启动器
        </label>
        {addLauncher && (
          <div className="info-box">
            <strong>启动器会加入压缩包根目录</strong>
            <p>用户解压后双击包内启动器，会启动 127.0.0.1 本地服务器并用默认浏览器打开项目首页。</p>
            <p>启动器是 Windows 自包含 exe，不要求用户安装 Node、Python 或 7-Zip。</p>
          </div>
        )}
      </div>
      {lastPackagePath && (
        <div className="success-box">
          <strong>打包完成</strong>
          <p>{lastPackagePath}</p>
        </div>
      )}
      <div className="button-row modal-actions">
        <button disabled={busy || !fileName.trim() || !outputDirectory.trim()} onClick={onStart}>
          <Archive size={16} />
          开始打包
        </button>
      </div>
    </AppDialog>
  );
}

function NavButton({ active, icon, label, className = "", onClick, onPreload }: { active: boolean; icon: React.ReactNode; label: string; className?: string; onClick: () => void; onPreload?: () => void }) {
  return (
    <button className={["nav", className, active ? "active" : ""].filter(Boolean).join(" ")} onClick={onClick} onMouseEnter={onPreload} onFocus={onPreload}>
      {icon}
      {label}
    </button>
  );
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function basename(value: string): string {
  const normalized = normalizePathSeparators(value).replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

function joinPath(root: string, child: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function viewTitle(view: ViewId): string {
  return {
    project: "项目",
    import: "提取/回填",
    analysis: "术语分析",
    translate: "翻译",
    proofread: "校对",
    dictionary: "词典",
    prompts: "提示词",
    tools: "工具",
    settings: "设置"
  }[view];
}

function currentTableContext(view: ViewId, activeAnalysisTable: ResourceTableId): { currentTable?: string; currentTableId?: string; currentTableDescription?: string } {
  const analysisContext = analysisTableContext(activeAnalysisTable);
  const contexts: Partial<Record<ViewId, { currentTable: string; currentTableId: string; currentTableDescription: string }>> = {
    import: {
      currentTable: "文本表",
      currentTableId: "project.text",
      currentTableDescription: "当前页面正在查看或编辑提取/回填用的翻译文本行。使用 table_* 工具时，文本行对应 project.text。"
    },
    translate: {
      currentTable: "文本表",
      currentTableId: "project.text",
      currentTableDescription: "当前页面正在查看或编辑批量翻译用的翻译文本行。使用 table_* 工具时，文本行对应 project.text。"
    },
    analysis: {
      currentTable: analysisContext.currentTable,
      currentTableId: analysisContext.currentTableId,
      currentTableDescription: `${analysisContext.currentTableDescription} 分析页面还可以切换到其它资源表：人物名用 project.characters，普通术语用 project.glossary，禁翻和保留标记用 project.noTranslate。`
    },
    proofread: {
      currentTable: "校对问题表",
      currentTableId: "proofread.issues",
      currentTableDescription: "当前页面显示校对问题。校对问题本身不是 table_* 可编辑项目表；需要读取或修改对应翻译文本时使用 project.text，并用问题行的 textItemId 找到文本行。"
    }
  };
  return contexts[view] ?? {};
}

function analysisTableContext(table: ResourceTableId): { currentTable: string; currentTableId: string; currentTableDescription: string } {
  if (table === "glossary") {
    return {
      currentTable: "术语表",
      currentTableId: "project.glossary",
      currentTableDescription: "当前分析页正在显示术语表，记录普通术语、专有名词、道具、组织等固定译法。"
    };
  }
  if (table === "noTranslate") {
    return {
      currentTable: "禁翻表",
      currentTableId: "project.noTranslate",
      currentTableDescription: "当前分析页正在显示禁翻表，记录不应翻译或必须原样保留的标记、代码、占位符和特殊文本。"
    };
  }
  return {
    currentTable: "人物表",
    currentTableId: "project.characters",
    currentTableDescription: "当前分析页正在显示人物表，记录完整人名、姓、名、译名、备注和启用状态。"
  };
}

createRoot(document.getElementById("root")!).render(<App />);
