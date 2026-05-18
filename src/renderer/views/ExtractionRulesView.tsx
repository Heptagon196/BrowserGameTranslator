import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Download, ExternalLink, FileDown, Info, Link as LinkIcon, RefreshCw, Save, Search, Trash2, Upload } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AppStateSnapshot,
  ExtractionRulePackage,
  ExtractionRulePackageUpdateUrl,
  ExtractionRulePackageSummary,
  OnlineExtractionRuleInlineSubmissionResult,
  OnlineExtractionRulePackage,
  OnlineExtractionRuleSource,
  OnlineExtractionRuleSubmissionOptions,
  OnlineExtractionRuleSummary
} from "../../shared/types";
import { AppDialog, StyledSelect } from "../components/ui/Primitives";
import { ExternalMarkdownLink, handleExternalMarkdownLinkClick } from "../markdownLinks";

type AssetTab = "local" | "online";
type PublishStep = "edit" | "method";
type PublishMode = "manual" | "auto";

export default function ExtractionRulesView({
  busy,
  snapshot,
  run,
  showToast
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  showToast: (message: string, tone?: "success" | "error") => void;
}) {
  const [activeTab, setActiveTab] = useState<AssetTab>("local");
  const [packages, setPackages] = useState<ExtractionRulePackageSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [rulePackage, setRulePackage] = useState<ExtractionRulePackage | null>(null);
  const [query, setQuery] = useState("");
  const [onlineSources, setOnlineSources] = useState<OnlineExtractionRuleSource[]>([]);
  const [selectedOnlineSourceId, setSelectedOnlineSourceId] = useState("");
  const [onlineSummaries, setOnlineSummaries] = useState<OnlineExtractionRuleSummary[]>([]);
  const [selectedOnlineId, setSelectedOnlineId] = useState("");
  const [onlinePackage, setOnlinePackage] = useState<ExtractionRulePackage | null>(null);
  const [onlinePackageLoading, setOnlinePackageLoading] = useState(false);
  const [onlinePage, setOnlinePage] = useState(1);
  const [onlineHasNextPage, setOnlineHasNextPage] = useState(false);
  const [onlineHasPreviousPage, setOnlineHasPreviousPage] = useState(false);
  const [onlineDescriptionCollapsed, setOnlineDescriptionCollapsed] = useState(false);
  const [onlineError, setOnlineError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDraft, setInfoDraft] = useState({ id: "", displayName: "", engine: "", tags: "", description: "", updateUrl: "" });
  const [remoteCheckOpen, setRemoteCheckOpen] = useState(false);
  const [remoteCheckPackage, setRemoteCheckPackage] = useState<OnlineExtractionRulePackage | null>(null);
  const [remoteCheckMessage, setRemoteCheckMessage] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishDraft, setPublishDraft] = useState<OnlineExtractionRuleSubmissionOptions>({ sourceId: "", title: "", introduction: "" });
  const [publishEngineName, setPublishEngineName] = useState("");
  const [publishTitleName, setPublishTitleName] = useState("");
  const [publishSubmission, setPublishSubmission] = useState<OnlineExtractionRuleInlineSubmissionResult | null>(null);
  const [publishCopyMessage, setPublishCopyMessage] = useState("");
  const [publishUpdateTarget, setPublishUpdateTarget] = useState("");
  const [publishStep, setPublishStep] = useState<PublishStep>("edit");
  const [publishMode, setPublishMode] = useState<PublishMode>("manual");
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [githubLogin, setGithubLogin] = useState("");
  const [deleteOnlineOpen, setDeleteOnlineOpen] = useState(false);
  const onlineAutoRefreshKeyRef = React.useRef("");

  const localPackages = useMemo(() => packages.filter((item) => item.scope === "global"), [packages]);
  const selectedSummary = localPackages.find((item) => packageKey(item) === selectedKey);
  const selectedOnlineSummary = onlineSummaries.find((item) => item.discussionId === selectedOnlineId);
  const visiblePackages = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return localPackages.filter((item) => !keyword || `${item.id} ${item.displayName} ${item.description} ${item.engine} ${item.tags.join(" ")}`.toLowerCase().includes(keyword));
  }, [localPackages, query]);
  const visibleOnlinePackages = useMemo(() => onlineSummaries, [onlineSummaries]);
  const publishTitle = rulePackage ? buildRulePackageDiscussionTitle(rulePackage, publishTitleName, publishEngineName) : "";
  const publishUpdateTargetInvalid = Boolean(publishUpdateTarget.trim() && !isGitHubDiscussionUrl(publishUpdateTarget));
  const publishHasUpdateTarget = Boolean(publishUpdateTarget.trim() || rulePackage?.updateUrl?.url);
  const publishSource = onlineSources.find((source) => source.id === publishDraft.sourceId);
  const publishPageUrl = publishUpdateTarget.trim() || (publishSource ? `${publishSource.url.replace(/\/+$/, "")}/discussions/categories/${encodeURIComponent(publishSource.extractionRuleCategory)}` : "");
  const canDeleteOnlineSubmission = Boolean(
    selectedOnlineSummary &&
    githubTokenConfigured &&
    (!githubLogin || selectedOnlineSummary.author.toLowerCase() === githubLogin.toLowerCase())
  );
  const remoteLoadTarget = useMemo(() => {
    const updateUrl = rulePackage?.updateUrl;
    if (!updateUrl?.discussionId) return null;
    const sourceId = onlineSources.some((source) => source.id === updateUrl.sourceId)
      ? updateUrl.sourceId
      : selectedOnlineSourceId || onlineSources[0]?.id || "";
    return sourceId ? { sourceId, discussionId: updateUrl.discussionId } : null;
  }, [onlineSources, rulePackage?.updateUrl, selectedOnlineSourceId]);

  useEffect(() => {
    void reloadPackages();
    void loadOnlineSources();
  }, [snapshot.project?.projectRoot]);

  useEffect(() => {
    let cancelled = false;
    window.bgt.getOnlineExtractionRuleTokenStatus()
      .then((status) => {
        if (!cancelled) {
          setGithubTokenConfigured(status.configured && status.enabled !== false);
          setGithubLogin(status.login ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGithubTokenConfigured(false);
          setGithubLogin("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedSummary) {
      setRulePackage(null);
      return;
    }
    void run("读取提取规则包", () => window.bgt.loadExtractionRulePackage("global", selectedSummary.id, selectedSummary.fileName), (loaded) => {
      setRulePackage(loaded);
    });
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedOnlineSourceId || !selectedOnlineId) {
      setOnlinePackage(null);
      setOnlinePackageLoading(false);
      return;
    }
    setOnlinePackageLoading(true);
    void run("读取在线提取规则", () => window.bgt.loadOnlineExtractionRulePackage(selectedOnlineSourceId, selectedOnlineId), (loaded) => {
      setOnlinePackage(loaded.package);
    }).finally(() => {
      setOnlineDescriptionCollapsed(false);
      setOnlinePackageLoading(false);
    });
  }, [selectedOnlineId, selectedOnlineSourceId]);

  useEffect(() => {
    if (!infoOpen || !rulePackage) return;
    setInfoDraft({
      id: rulePackage.id,
      displayName: rulePackage.displayName,
      engine: rulePackage.engine,
      tags: rulePackage.tags.join(", "),
      description: rulePackage.description,
      updateUrl: rulePackage.updateUrl?.url ?? ""
    });
  }, [infoOpen, rulePackage?.id, rulePackage?.displayName, rulePackage?.engine, rulePackage?.tags.join("|"), rulePackage?.description, rulePackage?.updateUrl?.url]);

  useEffect(() => {
    if (!publishOpen || !rulePackage) return;
    const updateSourceExists = onlineSources.some((source) => source.id === rulePackage.updateUrl?.sourceId);
    setPublishDraft({
      sourceId: updateSourceExists ? rulePackage.updateUrl?.sourceId || "" : selectedOnlineSourceId || publishDraft.sourceId || onlineSources[0]?.id || "",
      title: buildRulePackageDiscussionTitle(rulePackage),
      introduction: rulePackage.description
    });
    setPublishEngineName(rulePackage.engine || "auto");
    setPublishTitleName(rulePackage.displayName);
    setPublishSubmission(null);
    setPublishCopyMessage("");
    setPublishUpdateTarget(rulePackage.updateUrl?.url ?? "");
    setPublishStep("edit");
    setPublishMode(githubTokenConfigured ? "auto" : "manual");
  }, [publishOpen, rulePackage?.id]);

  useEffect(() => {
    if (activeTab !== "online" || !selectedOnlineSourceId || onlineSummaries.length || onlinePackageLoading || onlinePackage) return;
    const autoRefreshKey = selectedOnlineSourceId;
    if (onlineAutoRefreshKeyRef.current === autoRefreshKey) return;
    onlineAutoRefreshKeyRef.current = autoRefreshKey;
    void run("读取在线规则", () => reloadOnlinePackages());
  }, [activeTab, selectedOnlineSourceId, onlineSummaries.length, onlinePackageLoading, onlinePackage]);

  const reloadPackages = async () => {
    const next = await window.bgt.listExtractionRulePackages();
    setPackages(next);
    const locals = next.filter((item) => item.scope === "global");
    if (!selectedKey || !locals.some((item) => packageKey(item) === selectedKey)) setSelectedKey(locals[0] ? packageKey(locals[0]) : "");
  };

  const loadOnlineSources = async () => {
    try {
      const settings = await window.bgt.listOnlineExtractionRuleSources();
      const enabled = settings.sources.filter((source) => source.enabled);
      setOnlineSources(enabled);
      setSelectedOnlineSourceId((current) => current || enabled[0]?.id || "");
    } catch (error) {
      setOnlineError(error instanceof Error ? error.message : String(error));
    }
  };

  const reloadOnlinePackages = async (text = query, page = 1) => {
    if (!selectedOnlineSourceId) return;
    const safePage = Math.max(1, Math.floor(page));
    setOnlineError("");
    setOnlinePackageLoading(true);
    setOnlinePackage(null);
    const result = await window.bgt.listOnlineExtractionRulePackages(selectedOnlineSourceId, text, safePage);
    setOnlineSummaries(result.summaries);
    setOnlinePage(result.page);
    setOnlineHasNextPage(result.hasNextPage);
    setOnlineHasPreviousPage(result.hasPreviousPage);
    setSelectedOnlineId("");
    setOnlinePackageLoading(false);
  };

  const importPackage = () => {
    void run("导入提取规则包", () => window.bgt.importExtractionRulePackage("global"), (result) => {
      if (result.status === "imported") {
        void reloadPackages();
        showToast("规则包已导入全局。");
      }
    });
  };

  const importOnlineToGlobal = () => {
    if (!selectedOnlineSourceId || !selectedOnlineId) return;
    void run("导入在线提取规则", () => window.bgt.importOnlineExtractionRulePackage(selectedOnlineSourceId, selectedOnlineId), async (pkg) => {
      await window.bgt.importExtractionRulePackage("global", "overwrite", pkg);
      await reloadPackages();
      showToast("在线规则包已导入全局。");
    });
  };

  const deleteOnlineSubmission = () => {
    if (!selectedOnlineSummary) return;
    const target = selectedOnlineSummary;
    const selectedPackageMatched = Boolean(rulePackage?.updateUrl && localUpdateUrlMatchesOnlineSummary(rulePackage.updateUrl, target));
    void run("删除在线规则投稿", () => window.bgt.deleteOnlineExtractionRulePackage(target.sourceId, target.discussionId), async (result) => {
      showToast(result.clearedLocalLinks ? `在线规则投稿已删除，已清理 ${result.clearedLocalLinks} 个本地规则包的更新网址。` : "在线规则投稿已删除。");
      setRulePackage((current) => current?.updateUrl && localUpdateUrlMatchesOnlineSummary(current.updateUrl, target)
        ? { ...current, updateUrl: undefined }
        : current);
      if (selectedPackageMatched) {
        setInfoDraft((draft) => ({ ...draft, updateUrl: "" }));
        setPublishUpdateTarget("");
      }
      setDeleteOnlineOpen(false);
      setOnlinePackage(null);
      setSelectedOnlineId("");
      setOnlineSummaries((items) => items.filter((item) => item.discussionId !== target.discussionId));
      if (remoteCheckPackage?.summary.discussionId === target.discussionId) {
        setRemoteCheckPackage(null);
        setRemoteCheckMessage("");
        setRemoteCheckOpen(false);
      }
      await reloadPackages();
    });
  };

  const applySelectedToProject = () => {
    if (!rulePackage) return;
    void run("应用规则包到项目", () => window.bgt.applyExtractionRulePackageToProject(rulePackage), () => {
      showToast("规则包已复制到项目，项目内可继续确认和微调。");
    });
  };

  const checkRemoteUpdate = async () => {
    if (!rulePackage || !remoteLoadTarget) return;
    const remote = await run("检查规则包远程更新", () => window.bgt.loadOnlineExtractionRulePackage(remoteLoadTarget.sourceId, remoteLoadTarget.discussionId));
    if (!remote) return;
    setRemoteCheckPackage(remote);
    const localRevision = rulePackage.updateUrl?.revision ?? 0;
    const remoteRevision = remote.summary.manifest?.storage.revision ?? 0;
    if (remoteRevision > localRevision) {
      setRemoteCheckMessage("远程规则包有新版本，可以覆盖本地规则包。");
    } else if (remoteRevision === localRevision) {
      setRemoteCheckMessage("远程规则包版本与本地记录一致。");
    } else {
      setRemoteCheckMessage("远程规则包版本低于本地记录，请确认后再覆盖。");
    }
    setRemoteCheckOpen(true);
  };

  const overwriteLocalWithRemote = async () => {
    if (!remoteCheckPackage || !selectedSummary) return;
    const nextPackage: ExtractionRulePackage = {
      ...remoteCheckPackage.package,
      sourceKind: "online",
      readonly: false,
      updateUrl: {
        sourceId: remoteCheckPackage.summary.sourceId,
        discussionId: remoteCheckPackage.summary.discussionId,
        discussionNumber: remoteCheckPackage.summary.discussionNumber,
        url: remoteCheckPackage.summary.url,
        revision: remoteCheckPackage.summary.manifest?.storage.revision ?? 1,
        sha256: remoteCheckPackage.summary.manifest?.storage.sha256 ?? "",
        updatedAt: remoteCheckPackage.summary.updatedAt
      }
    };
    const saved = await run("用远程规则包覆盖本地", () => window.bgt.saveExtractionRulePackage("global", nextPackage, selectedSummary.fileName));
    if (!saved) return;
    setRulePackage(saved);
    setRemoteCheckOpen(false);
    await reloadPackages();
    setSelectedKey(`global:${saved.id}:${selectedSummary.fileName ?? ""}`);
    showToast("本地规则包已更新。");
  };

  const saveRulePackageInfo = () => {
    if (!rulePackage || !selectedSummary) return;
    const updateUrl = infoDraft.updateUrl.trim();
    const nextPackage: ExtractionRulePackage = {
      ...rulePackage,
      id: normalizeRulePackageId(infoDraft.id || rulePackage.id),
      displayName: infoDraft.displayName.trim() || rulePackage.displayName,
      engine: infoDraft.engine.trim() || "auto",
      tags: splitTags(infoDraft.tags),
      description: infoDraft.description.trim(),
      updatedAt: new Date().toISOString(),
      updateUrl: updateUrl ? updateInfoFromUrl(updateUrl, rulePackage.updateUrl) : undefined
    };
    void run("保存规则信息", () => window.bgt.saveExtractionRulePackage("global", nextPackage, selectedSummary.fileName), async (saved) => {
      setRulePackage(saved);
      setInfoOpen(false);
      await reloadPackages();
      setSelectedKey(`global:${saved.id}:${selectedSummary.fileName ?? ""}`);
      showToast("规则信息已保存。");
    });
  };

  const publishOptions = (): OnlineExtractionRuleSubmissionOptions => ({
    sourceId: publishDraft.sourceId,
    title: rulePackage ? buildRulePackageDiscussionTitle(rulePackage, publishTitleName, publishEngineName) : "",
    introduction: publishDraft.introduction.trim() || rulePackage?.description || ""
  });

  const openPublishDialog = () => {
    if (!rulePackage) return;
    const updateSourceExists = onlineSources.some((source) => source.id === rulePackage.updateUrl?.sourceId);
    setPublishDraft({
      sourceId: updateSourceExists ? rulePackage.updateUrl?.sourceId || "" : selectedOnlineSourceId || onlineSources[0]?.id || "",
      title: buildRulePackageDiscussionTitle(rulePackage),
      introduction: rulePackage.description.trim() || "请在这里说明这个规则包适合的引擎、覆盖范围和注意事项。"
    });
    setPublishEngineName(rulePackage.engine || "auto");
    setPublishTitleName(rulePackage.displayName);
    setPublishUpdateTarget(rulePackage.updateUrl?.url ?? "");
    setPublishSubmission(null);
    setPublishCopyMessage("");
    setPublishStep("edit");
    setPublishMode(githubTokenConfigured ? "auto" : "manual");
    setPublishOpen(true);
  };

  const startPublish = async () => {
    if (!rulePackage || !selectedSummary || publishUpdateTargetInvalid || !publishTitleName.trim()) return;
    const updateUrl = publishUpdateTarget.trim();
    const nextPackage: ExtractionRulePackage = {
      ...rulePackage,
      displayName: publishTitleName.trim(),
      engine: publishEngineName.trim() || "auto",
      description: publishDraft.introduction.trim() || rulePackage.description,
      updatedAt: new Date().toISOString(),
      updateUrl: updateUrl ? updateInfoFromUrl(updateUrl, rulePackage.updateUrl) : rulePackage.updateUrl
    };
    const saved = await run("更新规则投稿信息", () => window.bgt.saveExtractionRulePackage("global", nextPackage, selectedSummary.fileName));
    if (!saved) return;
    setRulePackage(saved);
    await reloadPackages();
    setPublishStep("method");
    setPublishSubmission(null);
    setPublishCopyMessage("");
    if (publishMode === "manual") {
      const submission = await run("准备规则包帖文", () => window.bgt.buildOnlineExtractionRuleInlineSubmission(saved, {
        ...publishOptions(),
        title: buildRulePackageDiscussionTitle(saved),
        introduction: publishDraft.introduction.trim() || saved.description
      }));
      if (submission) setPublishSubmission(submission);
    }
  };

  const selectPublishMode = async (mode: PublishMode) => {
    setPublishMode(mode);
    setPublishCopyMessage("");
    if (mode === "manual" && rulePackage && !publishSubmission) {
      const submission = await run("准备规则包帖文", () => window.bgt.buildOnlineExtractionRuleInlineSubmission(rulePackage, publishOptions()));
      if (submission) setPublishSubmission(submission);
    }
  };

  const copyPublishTitle = () => {
    if (!rulePackage) return;
    void run("复制规则包投稿标题", () => window.bgt.copyText(publishOptions().title), () => {
      setPublishCopyMessage("标题已复制。");
    });
  };

  const copyPublishBody = async () => {
    if (!rulePackage) return;
    const submission = await run("生成规则包投稿帖文", () => window.bgt.buildOnlineExtractionRuleInlineSubmission(rulePackage, publishOptions()));
    if (!submission?.body) return;
    setPublishSubmission(submission);
    await run("复制规则包投稿帖文", () => window.bgt.copyText(submission.body), () => {
      setPublishCopyMessage("帖文已复制。");
    });
  };

  const copySubmissionReply = (index: number, body: string) => {
    void run(`复制规则包回复 ${index}`, () => window.bgt.copyText(body), () => {
      setPublishCopyMessage(`回复 ${index} 已复制。`);
    });
  };

  const copyGeneratedBody = (body: string) => {
    void run("复制规则包帖文", () => window.bgt.copyText(body), () => {
      setPublishCopyMessage("帖文已复制。");
    });
  };

  const publishOnline = async () => {
    if (!rulePackage || !publishDraft.sourceId || !selectedSummary) return;
    const updateUrl = canUpdateFromUrl(rulePackage.updateUrl) ? rulePackage.updateUrl : null;
    const task = updateUrl
      ? () => window.bgt.updateOnlineExtractionRulePackage(rulePackage, { ...publishOptions(), discussionId: updateUrl.discussionId, expectedRevision: updateUrl.revision })
      : () => window.bgt.publishOnlineExtractionRulePackage(rulePackage, publishOptions());
    await run(updateUrl ? "更新在线提取规则包" : "上传提取规则包", task, async (result) => {
      const nextPackage: ExtractionRulePackage = {
        ...rulePackage,
        updateUrl: {
          sourceId: publishDraft.sourceId,
          discussionId: "id" in result ? result.id : result.discussionId,
          discussionNumber: "number" in result ? result.number : result.discussionNumber,
          url: result.url,
          revision: "revision" in result ? result.revision : 1,
          sha256: result.sha256 ?? "",
          updatedAt: new Date().toISOString()
        }
      };
      const saved = await window.bgt.saveExtractionRulePackage("global", nextPackage, selectedSummary.fileName);
      setRulePackage(saved);
      await reloadPackages();
      setPublishOpen(false);
      showToast(updateUrl ? "在线提取规则包已更新。" : "提取规则包已上传。");
    });
  };

  const deleteSelected = () => {
    if (!selectedSummary || selectedSummary.readonly || selectedSummary.scope !== "global") return;
    void run("删除提取规则包", () => window.bgt.deleteExtractionRulePackage("global", selectedSummary.id, selectedSummary.fileName), () => {
      setSelectedKey("");
      setRulePackage(null);
      void reloadPackages();
    });
  };

  return (
    <div className="dictionary-view extraction-rules-view">
      <aside className="dictionary-list-panel">
        <div className="dictionary-tabs">
          <button className={activeTab === "local" ? "active" : ""} onClick={() => setActiveTab("local")}>本地规则</button>
          <button className={activeTab === "online" ? "active" : ""} onClick={() => setActiveTab("online")}>在线规则</button>
        </div>
        <div className="dictionary-list-header">
          <h2>{activeTab === "local" ? "提取规则" : "在线规则"}</h2>
          {activeTab === "local" ? (
            <>
              <button className="icon-button" disabled={busy} onClick={importPackage} title="导入规则包"><Upload size={17} /></button>
            </>
          ) : (
            <button className="icon-button" disabled={busy || !selectedOnlineSourceId} onClick={() => run("刷新在线规则", () => reloadOnlinePackages())} title="刷新在线规则"><RefreshCw size={17} /></button>
          )}
        </div>
        <div className="dictionary-search-row">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (activeTab === "online" && event.key === "Enter") void run("搜索在线规则", () => reloadOnlinePackages(event.currentTarget.value));
            }}
            placeholder={activeTab === "online" ? "搜索 GitHub 规则包" : "搜索规则包"}
          />
        </div>
        {activeTab === "online" ? (
          <StyledSelect
            value={selectedOnlineSourceId}
            options={onlineSources.map((source) => ({ value: source.id, label: source.displayName }))}
            onChange={(value) => {
              setSelectedOnlineSourceId(value);
              setOnlineSummaries([]);
              setSelectedOnlineId("");
              setOnlinePackage(null);
            }}
          />
        ) : null}
        <div className="dictionary-list">
          {activeTab === "local" ? (
            <>
              {visiblePackages.map((item) => (
                <button key={packageKey(item)} className={packageKey(item) === selectedKey ? "dictionary-list-item active" : "dictionary-list-item"} onClick={() => setSelectedKey(packageKey(item))}>
                  <strong className="dictionary-list-title">
                    <span>{item.displayName}</span>
                  </strong>
                  {item.updateUrl ? <LinkIcon className="dictionary-list-update-icon" size={14} aria-label="有关联更新网址" /> : null}
                  <span>{item.engine || "通用"} · {item.ruleCount} 条规则</span>
                  <small>{item.description}</small>
                </button>
              ))}
              {!visiblePackages.length ? <p className="empty">没有本地规则包</p> : null}
            </>
          ) : (
            <>
              {onlineError ? <p className="settings-note">{onlineError}</p> : null}
              <p className="empty dictionary-list-hint">修改搜索词后需要搜索或刷新。</p>
            </>
          )}
        </div>
        {activeTab === "online" && selectedOnlineSummary && onlinePackage ? (
          <div className="online-side-info">
            <div>
              <strong>规则包</strong>
              <span>{selectedOnlineSummary.meta.displayName}</span>
            </div>
            <div>
              <strong>引擎</strong>
              <span>{selectedOnlineSummary.meta.engine || "通用"}</span>
            </div>
            <div>
              <strong>版本</strong>
              <span>{selectedOnlineSummary.manifest?.storage.revision ?? "-"}</span>
            </div>
            <div>
              <strong>规则</strong>
              <span>{onlinePackage.rules.length} 条</span>
            </div>
            <div>
              <strong>作者</strong>
              <span>{selectedOnlineSummary.author || "-"}</span>
            </div>
          </div>
        ) : null}
      </aside>
      <section className="dictionary-table-panel">
        {activeTab === "local" ? (
          rulePackage ? (
            <>
              <div className="table-toolbar dictionary-toolbar">
                <div>
                  <h2>{rulePackage.displayName}</h2>
                  <p>{rulePackage.engine || "通用"} · {rulePackage.rules.length} 条规则 · {rulePackage.id}</p>
                </div>
                <div className="dictionary-toolbar-actions">
                  <button disabled={!snapshot.project} onClick={applySelectedToProject}><Save size={16} />导入项目</button>
                  <button className="secondary-button" disabled={!onlineSources.length} onClick={openPublishDialog}><Upload size={16} />{rulePackage.updateUrl?.url ? "发布更新" : "投稿在线"}</button>
                  <button className="secondary-button" disabled={!remoteLoadTarget} onClick={checkRemoteUpdate}><RefreshCw size={16} />检查更新</button>
                  <button className="secondary-button" disabled={rulePackage.readonly} onClick={() => setInfoOpen(true)}><Info size={16} />表信息</button>
                  <button className="secondary-button" onClick={() => window.bgt.exportExtractionRulePackage(rulePackage)}><FileDown size={16} />导出表</button>
                  <button className="secondary-button danger-button" disabled={rulePackage.readonly} onClick={deleteSelected}><Trash2 size={16} />删除表</button>
                </div>
              </div>
              <RulePackageDetail pkg={rulePackage} />
            </>
          ) : (
            <div className="empty dictionary-empty">
              <Download size={26} />
              <p>选择左侧规则包，或导入一个 JSON 规则包。</p>
            </div>
          )
        ) : onlinePackageLoading ? (
          <div className="empty dictionary-empty dictionary-loading">
            <span className="dictionary-spinner" aria-hidden="true" />
            <p>正在读取在线规则...</p>
          </div>
        ) : selectedOnlineSummary && onlinePackage ? (
          <>
            <div className="table-toolbar dictionary-toolbar">
              <div>
                <button className="secondary-button dictionary-back-button" onClick={() => {
                  setOnlinePackage(null);
                  setSelectedOnlineId("");
                }}>
                  <ArrowLeft size={16} />
                  返回搜索结果
                </button>
                <h2>{onlineRuleDisplayTitle(selectedOnlineSummary.title, selectedOnlineSummary.meta.engine)}</h2>
              </div>
              <div className="dictionary-toolbar-actions online-detail-actions">
                <div>
                  <button onClick={importOnlineToGlobal}><Download size={16} />导入全局</button>
                  <button className="secondary-button" onClick={() => void window.bgt.openExternal(selectedOnlineSummary.url)}><ExternalLink size={16} />打开 GitHub</button>
                  {canDeleteOnlineSubmission ? (
                    <button className="secondary-button danger-button" onClick={() => setDeleteOnlineOpen(true)}><Trash2 size={16} />删除投稿</button>
                  ) : null}
                </div>
                {selectedOnlineSummary.introductionHtml || selectedOnlineSummary.introduction ? (
                  <div>
                    <button className="secondary-button" onClick={() => setOnlineDescriptionCollapsed((value) => !value)}>
                      {onlineDescriptionCollapsed ? "展开描述" : "收起描述"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {selectedOnlineSummary.introductionHtml || selectedOnlineSummary.introduction ? (
              <div className={onlineDescriptionCollapsed ? "online-description-section collapsed" : "online-description-section"}>
                {!onlineDescriptionCollapsed && (selectedOnlineSummary.introductionHtml ? (
                  <div
                    className="online-dictionary-description markdown-content"
                    onClick={handleExternalMarkdownLinkClick}
                    dangerouslySetInnerHTML={{ __html: selectedOnlineSummary.introductionHtml }}
                  />
                ) : (
                  <div className="online-dictionary-description markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalMarkdownLink }}>
                      {selectedOnlineSummary.introduction}
                    </ReactMarkdown>
                  </div>
                ))}
              </div>
            ) : null}
            <RulePackageDetail pkg={onlinePackage} hideDescription />
          </>
        ) : visibleOnlinePackages.length ? (
          <div className="online-results-view">
            <div className="online-results-header">
              <div>
                <h2>搜索结果</h2>
                <p>第 {onlinePage} 页 · {visibleOnlinePackages.length} 个在线规则包</p>
              </div>
              <div className="online-results-actions">
                <button className="secondary-button" disabled={busy || !onlineHasPreviousPage} onClick={() => run("上一页在线规则", () => reloadOnlinePackages(query, onlinePage - 1))}>
                  上一页
                </button>
                <button className="secondary-button" disabled={busy || !onlineHasNextPage} onClick={() => run("下一页在线规则", () => reloadOnlinePackages(query, onlinePage + 1))}>
                  下一页
                </button>
              </div>
            </div>
            <div className="online-results-list">
              {visibleOnlinePackages.map((item) => (
                <button key={item.discussionId} className="online-result-row" onClick={() => setSelectedOnlineId(item.discussionId)}>
                  <div className="online-result-main">
                    <strong>{onlineRuleDisplayTitle(item.title, item.meta.engine)}</strong>
                    <span>{item.meta.displayName} · {item.meta.engine || "通用"} · {item.meta.ruleEngineVersion}</span>
                    <small>{item.manifest?.storage.ruleCount ?? 0} 条规则 · rev {item.manifest?.storage.revision ?? "-"}</small>
                  </div>
                  <div className="online-result-meta">
                    <span>{item.author}</span>
                    <time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="empty dictionary-empty">
            <Search size={26} />
            <p>搜索或刷新在线提取规则包。</p>
          </div>
        )}
      </section>
      {rulePackage ? (
        <AppDialog
          open={publishOpen}
          title={publishHasUpdateTarget ? "更新到在线规则库" : "投稿到在线规则库"}
          description={publishStep === "edit" ? "先确认会写入规则包信息的内容。" : "选择投稿方式并按指引完成发布。"}
          compact
          onOpenChange={(open) => {
            setPublishOpen(open);
            if (!open) {
              setPublishStep("edit");
              setPublishCopyMessage("");
              setPublishSubmission(null);
            }
          }}
        >
          {publishStep === "edit" ? (
            <div className="dictionary-create-form">
              <label>
                <span>规则包名</span>
                <div className="discussion-title-input">
                  <span>{rulePackageDiscussionTitlePrefix(rulePackage, publishEngineName)}</span>
                  <input value={publishTitleName} onChange={(event) => setPublishTitleName(event.target.value)} />
                </div>
              </label>
              <label>
                <span>引擎名称</span>
                <input value={publishEngineName} onChange={(event) => setPublishEngineName(event.target.value)} placeholder="auto" />
              </label>
              <label className="publish-description-field">
                <span>功能描述 <small>支持 Markdown</small></span>
                <div className="publish-description-split">
                  <textarea value={publishDraft.introduction} onChange={(event) => setPublishDraft((draft) => ({ ...draft, introduction: event.target.value }))} />
                  <div className="publish-description-preview markdown-content">
                    {publishDraft.introduction.trim() ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalMarkdownLink }}>
                        {publishDraft.introduction}
                      </ReactMarkdown>
                    ) : (
                      <p className="empty">右侧会实时预览功能描述。</p>
                    )}
                  </div>
                </div>
              </label>
              <details className="publish-more-options">
                <summary>更多选项</summary>
                <div>
                  <label>
                    <span>更新网址</span>
                    <input value={publishUpdateTarget} onChange={(event) => setPublishUpdateTarget(event.target.value)} />
                  </label>
                  {publishUpdateTargetInvalid ? <p className="settings-note">更新网址需要填写 GitHub discussion 链接。</p> : null}
                </div>
              </details>
              <p className="settings-note">标题会按引擎和规则包名生成，并同步写入 discussion 标题和正文。</p>
              <div className="dialog-actions">
                <button disabled={!publishTitleName.trim() || publishUpdateTargetInvalid} onClick={startPublish}>
                  <Upload size={16} />
                  {publishHasUpdateTarget ? "发布更新" : "开始投稿"}
                </button>
              </div>
            </div>
          ) : (
            <div className="dictionary-create-form">
              <button className="secondary-button publish-back-button" onClick={() => {
                setPublishStep("edit");
                setPublishSubmission(null);
              }}>
                返回投稿页
              </button>
              <label>
                <span>在线规则源</span>
                <StyledSelect
                  value={publishDraft.sourceId}
                  options={onlineSources.map((source) => ({ value: source.id, label: source.displayName }))}
                  onChange={(sourceId) => setPublishDraft((draft) => ({ ...draft, sourceId }))}
                />
              </label>
              <div className="publish-mode-tabs">
                <button className={publishMode === "manual" ? "active" : ""} onClick={() => void selectPublishMode("manual")}>手动投稿</button>
                <button className={publishMode === "auto" ? "active" : ""} onClick={() => void selectPublishMode("auto")}>自动投稿</button>
              </div>
              <div className="publish-guide">
                <strong>{publishMode === "manual" ? "手动投稿指引" : "自动投稿指引"}</strong>
                {publishMode === "manual" ? (
                  publishSubmission?.comments?.length ? (
                    <p>当前规则包压缩后仍较大，会使用回复分片。先复制标题和主贴文创建帖子，再按下方顺序复制每条回复并发布到同一个 discussion。</p>
                  ) : (
                    <p>复制标题和帖文，在打开的 GitHub Discussions 分类中创建或更新帖子。规则数据会折叠在帖文的数据包里。</p>
                  )
                ) : (
                  <p>自动投稿会调用 GitHub API 创建或更新 discussion。大规则包会自动压缩；压缩后仍过大时会自动拆成回复分片。</p>
                )}
                <small>标题：{publishOptions().title}</small>
                {publishSubmission ? <small>帖文：{publishSubmission.ruleCount} 条规则，{publishSubmission.byteLength} 字节，{submissionModeLabel(publishSubmission.mode)}</small> : null}
              </div>
              {publishCopyMessage ? <p className="settings-note">{publishCopyMessage}</p> : null}
              <div className="dialog-actions publish-dialog-actions">
                <button className="secondary-button" disabled={!publishPageUrl} onClick={() => publishPageUrl && void window.bgt.openExternal(publishPageUrl)}>
                  <ExternalLink size={16} />
                  打开发布网页
                </button>
                {publishMode === "manual" ? (
                  <>
                    <button className="secondary-button" onClick={copyPublishTitle}>
                      <Copy size={16} />
                      复制标题
                    </button>
                    <button className="secondary-button" onClick={copyPublishBody}>
                      <Copy size={16} />
                      复制帖文
                    </button>
                  </>
                ) : (
                  <button disabled={!publishDraft.sourceId} onClick={publishOnline}>
                    <Upload size={16} />
                    {publishUpdateTarget.trim() || rulePackage.updateUrl?.url ? "自动更新" : "自动上传"}
                  </button>
                )}
              </div>
              {publishMode === "manual" && publishSubmission?.comments?.length ? (
                <div className="publish-reply-list">
                  <strong>发布步骤</strong>
                  <div className="publish-reply-row">
                    <span>标题</span>
                    <button className="secondary-button" onClick={copyPublishTitle}>
                      <Copy size={16} />
                      复制标题
                    </button>
                  </div>
                  <div className="publish-reply-row">
                    <span>主贴文</span>
                    <button className="secondary-button" disabled={!publishSubmission.body} onClick={() => publishSubmission.body && copyGeneratedBody(publishSubmission.body)}>
                      <Copy size={16} />
                      复制贴文
                    </button>
                  </div>
                  {publishSubmission.comments.map((comment) => (
                    <div key={comment.index} className="publish-reply-row">
                      <span>{comment.index}. 回复 {comment.index} · {comment.byteLength ?? 0} 字节</span>
                      <button className="secondary-button" onClick={() => copySubmissionReply(comment.index, comment.body)}>
                        <Copy size={16} />
                        复制回复
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </AppDialog>
      ) : null}
      <AppDialog open={remoteCheckOpen} title="远程更新检查" description={remoteCheckMessage} compact onOpenChange={setRemoteCheckOpen}>
        <div className="dictionary-create-form">
          {remoteCheckPackage && rulePackage?.updateUrl ? (
            <div className="publish-guide">
              <p>
                本地记录 rev {rulePackage.updateUrl.revision} · 远程 rev {remoteCheckPackage.summary.manifest?.storage.revision ?? "-"}
              </p>
              <p>
                本地规则 {rulePackage.rules.length} 条 · 远程规则 {remoteCheckPackage.package.rules.length} 条
              </p>
              <p>远程标题：{remoteCheckPackage.summary.title}</p>
              <small>{remoteCheckPackage.summary.url}</small>
            </div>
          ) : null}
          <div className="dialog-actions conflict-dialog-actions">
            <button className="secondary-button" onClick={() => setRemoteCheckOpen(false)}>
              取消
            </button>
            <button disabled={!remoteCheckPackage} onClick={overwriteLocalWithRemote}>
              <RefreshCw size={16} />
              覆盖本地
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog open={deleteOnlineOpen} title="删除投稿" description="此操作会从 GitHub Discussions 删除这篇投稿，无法撤销。" compact onOpenChange={setDeleteOnlineOpen}>
        <div className="delete-confirm-body">
          <p>
            确定删除 <strong>{selectedOnlineSummary ? onlineRuleDisplayTitle(selectedOnlineSummary.title, selectedOnlineSummary.meta.engine) : "当前投稿"}</strong> 吗？
          </p>
          {selectedOnlineSummary ? <p className="settings-note">{selectedOnlineSummary.url}</p> : null}
          <div className="dialog-actions conflict-dialog-actions">
            <button className="danger-action-button" disabled={busy || !selectedOnlineSummary} onClick={deleteOnlineSubmission}>
              <Trash2 size={16} />
              删除投稿
            </button>
          </div>
        </div>
      </AppDialog>
      {rulePackage ? (
        <AppDialog open={infoOpen} title="规则信息" compact onOpenChange={setInfoOpen}>
          <div className="dictionary-create-form">
            <label>
              <span>规则包 ID <small>用于本地文件、导入冲突和包身份</small></span>
              <input value={infoDraft.id} onChange={(event) => setInfoDraft((draft) => ({ ...draft, id: event.target.value }))} />
            </label>
            <label>
              <span>名称</span>
              <input value={infoDraft.displayName} onChange={(event) => setInfoDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
            </label>
            <label>
              <span>引擎</span>
              <input value={infoDraft.engine} onChange={(event) => setInfoDraft((draft) => ({ ...draft, engine: event.target.value }))} placeholder="auto" />
            </label>
            <label>
              <span>标签 <small>用英文逗号或换行分隔</small></span>
              <input value={infoDraft.tags} onChange={(event) => setInfoDraft((draft) => ({ ...draft, tags: event.target.value }))} />
            </label>
            <label>
              <span>说明</span>
              <textarea value={infoDraft.description} onChange={(event) => setInfoDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <label>
              <span>更新网址</span>
              <input value={infoDraft.updateUrl} onChange={(event) => setInfoDraft((draft) => ({ ...draft, updateUrl: event.target.value }))} />
            </label>
            <label>
              <span>远程版本号</span>
              <input value={rulePackage.updateUrl ? String(rulePackage.updateUrl.revision) : "未关联远程规则"} disabled />
            </label>
            <div className="dialog-actions conflict-dialog-actions">
              <button disabled={!infoDraft.id.trim() || !infoDraft.displayName.trim() || Boolean(infoDraft.updateUrl.trim() && !isGitHubDiscussionUrl(infoDraft.updateUrl))} onClick={saveRulePackageInfo}>
                <Save size={16} />
                保存信息
              </button>
            </div>
          </div>
        </AppDialog>
      ) : null}
    </div>
  );
}

function RulePackageDetail({ pkg, hideDescription = false }: { pkg: ExtractionRulePackage; hideDescription?: boolean }) {
  return (
    <div className="rules-detail-surface">
      {!hideDescription ? (
        <section className="rules-detail-block">
          <h3>说明</h3>
          <p>{pkg.description || "无说明"}</p>
          <div className="rules-meta-grid">
            <span>来源：{pkg.sourceKind}</span>
            <span>只读：{pkg.readonly ? "是" : "否"}</span>
            <span>标签：{pkg.tags.join(", ") || "-"}</span>
            <span>更新网址：{pkg.updateUrl?.url || "无"}</span>
          </div>
        </section>
      ) : null}
      <section className="rules-detail-block">
        <h3>规则</h3>
        <div className="rules-rule-list">
          {pkg.rules.map((rule) => (
            <div key={rule.id} className="rules-rule-row">
              <strong>{rule.label}</strong>
              <span>{rule.strategy} · {rule.backfill.method}</span>
              <small>{JSON.stringify(rule.matcher)}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function packageKey(pkg: ExtractionRulePackageSummary): string {
  return `${pkg.scope}:${pkg.id}:${pkg.fileName ?? ""}`;
}

function normalizeRulePackageId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || `rules.${Date.now()}`;
}

function splitTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean)));
}

function submissionModeLabel(mode: string): string {
  if (mode === "compressedComments") return "压缩回复分片";
  if (mode === "compressedInline") return "压缩内联";
  return "内联";
}

function buildRulePackageDiscussionTitle(pkg: ExtractionRulePackage, displayNameOverride?: string, engineOverride?: string): string {
  return `${rulePackageDiscussionTitlePrefix(pkg, engineOverride)}${displayNameOverride?.trim() || pkg.displayName.trim() || pkg.id}`;
}

function rulePackageDiscussionTitlePrefix(pkg: ExtractionRulePackage, engineOverride?: string): string {
  const engine = ((engineOverride ?? pkg.engine) || "通用").trim() || "通用";
  return `[${engine}]`;
}

function onlineRuleDisplayTitle(title: string, engine: string): string {
  const trimmed = title.trim();
  const engineName = (engine || "通用").trim();
  const prefix = `[${engineName}]`;
  return engineName && trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() || trimmed : trimmed;
}

function updateInfoFromUrl(url: string, existing?: ExtractionRulePackageUpdateUrl): ExtractionRulePackageUpdateUrl {
  const number = parseGitHubDiscussionNumber(url);
  const sameUpdateUrl = existing?.url === url;
  return {
    sourceId: sameUpdateUrl ? existing.sourceId : "link",
    discussionId: sameUpdateUrl ? existing.discussionId : (number ? `web:${number}` : ""),
    discussionNumber: sameUpdateUrl ? existing.discussionNumber : number ?? 0,
    url,
    revision: sameUpdateUrl ? existing.revision : 0,
    sha256: sameUpdateUrl ? existing.sha256 : "",
    updatedAt: sameUpdateUrl ? existing.updatedAt : ""
  };
}

function localUpdateUrlMatchesOnlineSummary(updateUrl: ExtractionRulePackageUpdateUrl, summary: OnlineExtractionRuleSummary): boolean {
  return normalizeRemoteUrl(updateUrl.url) === normalizeRemoteUrl(summary.url) ||
    (updateUrl.sourceId === summary.sourceId && updateUrl.discussionId === summary.discussionId) ||
    (updateUrl.sourceId === summary.sourceId && updateUrl.discussionNumber === summary.discussionNumber);
}

function normalizeRemoteUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function canUpdateFromUrl(updateUrl?: ExtractionRulePackageUpdateUrl): updateUrl is ExtractionRulePackageUpdateUrl {
  return Boolean(updateUrl?.discussionId && updateUrl.discussionNumber > 0);
}

function parseGitHubDiscussionNumber(url: string): number | undefined {
  try {
    const parsed = new URL(url.trim());
    const match = parsed.pathname.match(/^\/[^/]+\/[^/]+\/discussions\/(\d+)\/?$/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function isGitHubDiscussionUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && /^\/[^/]+\/[^/]+\/discussions\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
