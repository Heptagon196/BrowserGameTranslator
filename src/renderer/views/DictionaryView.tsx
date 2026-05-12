import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Download, ExternalLink, FileDown, FilePlus, Info, Link as LinkIcon, RefreshCw, Save, Search, Trash2, Upload } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AppStateSnapshot,
  CharacterEntry,
  DictionaryTable,
  DictionaryTableMeta,
  DictionaryTableRemote,
  DictionaryTableRows,
  DictionaryTableSummary,
  GlossaryEntry,
  NoTranslateEntry,
  OnlineDictionarySource,
  OnlineDictionaryInlineSubmissionResult,
  OnlineDictionarySubmissionOptions,
  OnlineDictionarySummary,
  OnlineDictionaryTable,
  ResourceTableType
} from "../../shared/types";
import { AppDialog, CheckboxControl, StyledSelect } from "../components/ui/Primitives";
import { CharacterResourceTable, GlossaryResourceTable, NoTranslateResourceTable, type TableSettings } from "../components/table/DataTable";
import { ExternalMarkdownLink, handleExternalMarkdownLinkClick } from "../markdownLinks";
import { languageLabel, languageSelectOptions } from "../settingsModel";

const tableTypeOptions = [
  { value: "characters", label: "人物表" },
  { value: "glossary", label: "术语表" },
  { value: "noTranslate", label: "禁翻表" }
];
const onlineDictionaryInlineLimit = 50000;

type DictionaryConflict = {
  mode: "globalImport" | "projectImport";
  table: DictionaryTable;
  existing?: DictionaryTableSummary;
};

type PublishStep = "edit" | "method";
type PublishMode = "manual" | "auto";

export default function DictionaryView({
  busy,
  snapshot,
  tableSettings,
  run,
  showToast
}: {
  busy: boolean;
  snapshot: AppStateSnapshot;
  tableSettings: TableSettings;
  run: <T>(message: string, task: () => Promise<T>, onDone?: (value: T) => void) => Promise<T | undefined>;
  showToast: (message: string, tone?: "success" | "error") => void;
}) {
  const [summaries, setSummaries] = useState<DictionaryTableSummary[]>([]);
  const [activeTab, setActiveTab] = useState<"local" | "online">("local");
  const [selectedKey, setSelectedKey] = useState("");
  const [table, setTable] = useState<DictionaryTable | null>(null);
  const [onlineSources, setOnlineSources] = useState<OnlineDictionarySource[]>([]);
  const [selectedOnlineSourceId, setSelectedOnlineSourceId] = useState("");
  const [onlineSummaries, setOnlineSummaries] = useState<OnlineDictionarySummary[]>([]);
  const [onlinePage, setOnlinePage] = useState(1);
  const [onlineHasNextPage, setOnlineHasNextPage] = useState(false);
  const [onlineHasPreviousPage, setOnlineHasPreviousPage] = useState(false);
  const [selectedOnlineId, setSelectedOnlineId] = useState("");
  const [onlineTable, setOnlineTable] = useState<OnlineDictionaryTable | null>(null);
  const [onlineTableLoading, setOnlineTableLoading] = useState(false);
  const [onlineLinkPreview, setOnlineLinkPreview] = useState(false);
  const [onlineDescriptionCollapsed, setOnlineDescriptionCollapsed] = useState(false);
  const [onlineError, setOnlineError] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ResourceTableType | "all">("all");
  const [onlineSourceLanguageFilter, setOnlineSourceLanguageFilter] = useState("all");
  const [onlineTargetLanguageFilter, setOnlineTargetLanguageFilter] = useState("all");
  const [onlineMineOnly, setOnlineMineOnly] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDraft, setInfoDraft] = useState({ id: "", displayName: "", gameName: "", sourceLanguage: "", targetLanguage: "", description: "", updateUrl: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    tableType: "glossary" as ResourceTableType,
    id: "glossary",
    displayName: "术语表",
    gameName: "",
    sourceLanguage: "",
    targetLanguage: "",
    description: ""
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteOnlineOpen, setDeleteOnlineOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDraft, setExportDraft] = useState({ id: "", displayName: "", gameName: "", sourceLanguage: "", targetLanguage: "", description: "" });
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishDraft, setPublishDraft] = useState<OnlineDictionarySubmissionOptions>({
    sourceId: "",
    title: "",
    introduction: "",
    gameDisplayName: "",
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  });
  const [publishTitleName, setPublishTitleName] = useState("");
  const [publishCopyMessage, setPublishCopyMessage] = useState("");
  const [publishManualSubmission, setPublishManualSubmission] = useState<OnlineDictionaryInlineSubmissionResult | null>(null);
  const [publishUpdateTarget, setPublishUpdateTarget] = useState("");
  const [publishStep, setPublishStep] = useState<PublishStep>("edit");
  const [publishMode, setPublishMode] = useState<PublishMode>("manual");
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [githubLogin, setGithubLogin] = useState("");
  const [linkDownloadOpen, setLinkDownloadOpen] = useState(false);
  const [linkDownloadDraft, setLinkDownloadDraft] = useState("");
  const [remoteCheckOpen, setRemoteCheckOpen] = useState(false);
  const [remoteCheckTable, setRemoteCheckTable] = useState<OnlineDictionaryTable | null>(null);
  const [remoteCheckMessage, setRemoteCheckMessage] = useState("");
  const [conflict, setConflict] = useState<DictionaryConflict | null>(null);
  const [conflictDraftId, setConflictDraftId] = useState("");
  const onlineAutoRefreshKeyRef = React.useRef("");

  const reload = async () => {
    const next = await window.bgt.listDictionaryTables();
    setSummaries(next);
    const global = next.filter((item) => item.scope === "global");
    const stillExists = selectedKey && global.some((item) => summaryKey(item) === selectedKey);
    if (!stillExists) setSelectedKey(global[0] ? summaryKey(global[0]) : "");
  };

  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    let cancelled = false;
    window.bgt.listOnlineDictionarySources()
      .then((settings) => {
        if (cancelled) return;
        const enabled = settings.sources.filter((source) => source.enabled);
        setOnlineSources(enabled);
        setSelectedOnlineSourceId(enabled[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) setOnlineError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    window.bgt.getOnlineDictionaryTokenStatus()
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

  const globalTables = useMemo(() => summaries.filter((item) => item.scope === "global"), [summaries]);
  const selectedOnlineSource = onlineSources.find((source) => source.id === selectedOnlineSourceId) ?? onlineSources[0];
  const visibleTables = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return globalTables.filter((item) => {
      if (typeFilter !== "all" && item.tableType !== typeFilter) return false;
      if (!keyword) return true;
      return `${item.id} ${item.displayName} ${item.description}`.toLowerCase().includes(keyword);
    });
  }, [globalTables, query, typeFilter]);
  const visibleOnlineTables = useMemo(() => {
    return onlineSummaries;
  }, [onlineSummaries]);
  const onlineSourceLanguageOptions = useMemo(() => {
    return [{ value: "all", label: "全部源语言" }, ...languageSelectOptions.map((option) => ({ value: option.value, label: option.label }))];
  }, []);
  const onlineTargetLanguageOptions = useMemo(() => {
    return [{ value: "all", label: "全部目标语言" }, ...languageSelectOptions.map((option) => ({ value: option.value, label: option.label }))];
  }, []);

  const selectedSummary = globalTables.find((item) => summaryKey(item) === selectedKey);
  const canCopyInlineSubmission = Boolean(table && rowsToJsonl(table.rows).length <= onlineDictionaryInlineLimit);
  const publishUpdateTargetInvalid = Boolean(publishUpdateTarget.trim() && !isGitHubDiscussionUrl(publishUpdateTarget));
  const publishHasUpdateTarget = Boolean(publishUpdateTarget.trim() || table?.meta.remote?.url);
  const canDeleteOnlineSubmission = Boolean(
    onlineTable &&
    githubTokenConfigured &&
    (onlineMineOnly || onlineLinkPreview || !githubLogin || onlineTable.summary.author.toLowerCase() === githubLogin.toLowerCase())
  );
  const conflictDraftNormalizedId = normalizeUserId(conflictDraftId);
  const conflictTargetScope = conflict?.mode === "globalImport" ? "global" : "project";
  const conflictDraftExists = Boolean(conflict && summaries.some((item) => item.scope === conflictTargetScope && item.id === conflictDraftNormalizedId));

  useEffect(() => {
    if (!infoOpen || !table) return;
    setInfoDraft({
      id: table.meta.id,
      displayName: table.meta.displayName,
      gameName: table.meta.gameName,
      sourceLanguage: table.meta.sourceLanguage,
      targetLanguage: table.meta.targetLanguage,
      description: table.meta.description,
      updateUrl: table.meta.remote?.url ?? ""
    });
  }, [infoOpen, table?.meta.id, table?.meta.displayName, table?.meta.gameName, table?.meta.sourceLanguage, table?.meta.targetLanguage, table?.meta.description, table?.meta.remote?.url]);

  useEffect(() => {
    if (!selectedSummary) {
      setTable(null);
      return;
    }
    void run("读取词典表", () => window.bgt.loadDictionaryTable("global", selectedSummary.id, selectedSummary.tableType, selectedSummary.fileName), setTable);
  }, [selectedKey]);
  useEffect(() => {
    if (onlineLinkPreview) return;
    if (!selectedOnlineId || activeTab !== "online") {
      setOnlineTable(null);
      setOnlineTableLoading(false);
      return;
    }
    setOnlineTableLoading(true);
    void run("读取在线词典表", () => window.bgt.loadOnlineDictionaryTable(selectedOnlineSourceId, selectedOnlineId), setOnlineTable)
      .finally(() => {
        setOnlineDescriptionCollapsed(false);
        setOnlineTableLoading(false);
      });
  }, [selectedOnlineId, activeTab, onlineLinkPreview]);

  const reloadOnlineTables = async (overrides: {
    sourceId?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    tableType?: ResourceTableType | "all";
    text?: string;
    page?: number;
  } = {}) => {
    const sourceId = overrides.sourceId ?? selectedOnlineSourceId;
    const source = onlineSources.find((item) => item.id === sourceId) ?? selectedOnlineSource;
    if (!source) return;
    const page = Math.max(1, Math.floor(overrides.page ?? 1));
    setOnlineError("");
    setOnlineTableLoading(true);
    const next = await window.bgt.listOnlineDictionaryTables(
      source.id,
      buildOnlineDictionaryWebSearchQuery(
        overrides.sourceLanguage ?? onlineSourceLanguageFilter,
        overrides.targetLanguage ?? onlineTargetLanguageFilter,
        overrides.tableType ?? typeFilter,
        overrides.text ?? query
      ),
      page,
      onlineMineOnly
    );
    setOnlineSummaries(next.summaries);
    setOnlinePage(next.page);
    setOnlineHasNextPage(next.hasNextPage);
    setOnlineHasPreviousPage(next.hasPreviousPage);
    setOnlineLinkPreview(false);
    setSelectedOnlineId("");
    setOnlineTable(null);
    setOnlineTableLoading(false);
  };

  useEffect(() => {
    if (activeTab !== "online" || !selectedOnlineSource || onlineSummaries.length || onlineTableLoading || onlineTable) return;
    const autoRefreshKey = selectedOnlineSource.id;
    if (onlineAutoRefreshKeyRef.current === autoRefreshKey) return;
    onlineAutoRefreshKeyRef.current = autoRefreshKey;
    void run("读取在线词典", reloadOnlineTables);
  }, [activeTab, selectedOnlineSource?.id, onlineSummaries.length, onlineTableLoading, onlineTable]);

  const saveTable = (nextTable: DictionaryTable) => {
    setTable(nextTable);
    void run("保存词典表", () => window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName), (saved) => {
      setTable(saved);
      void reload();
    });
  };

  const openCreateDialog = () => {
    const tableType = typeFilter === "all" ? "glossary" : typeFilter;
    setCreateDraft({
      tableType,
      id: `${tableType}_${Date.now()}`,
      displayName: tableTypeLabel(tableType),
      gameName: snapshot.project?.projectName ?? "",
      sourceLanguage: snapshot.project?.sourceLanguage ?? "en",
      targetLanguage: snapshot.project?.targetLanguage ?? "zh-CN",
      description: ""
    });
    setCreateOpen(true);
  };

  const createEmpty = async () => {
    const id = createDraft.id.trim();
    const displayName = createDraft.displayName.trim();
    if (!id || !displayName) return;
    const meta = {
      id: normalizeUserId(id),
      displayName,
      gameName: createDraft.gameName.trim(),
      sourceLanguage: createDraft.sourceLanguage,
      targetLanguage: createDraft.targetLanguage,
      description: createDraft.description.trim()
    };
    const created = await run("创建空词典表", () => window.bgt.createEmptyDictionaryTable("global", createDraft.tableType, meta), async (createdTable) => {
      await reload();
      setSelectedKey(`global:${createdTable.meta.id}`);
      setTable(createdTable);
      setCreateOpen(false);
    });
    if (created) setSelectedKey(`global:${created.meta.id}`);
  };

  const importTable = async () => {
    const result = await run("导入词典表", () => window.bgt.importDictionaryTable("global"));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      setConflict({ mode: "globalImport", table: result.table, existing: result.existing });
      setConflictDraftId(suggestConflictId(result.table.meta.id));
    } else if (result.table) {
      setSelectedKey(`global:${result.table.meta.id}`);
    }
    await reload();
  };

  const exportTable = async () => {
    if (!table) return;
    const displayName = exportDraft.displayName.trim();
    if (!displayName) return;
    await run("导出词典表", () => window.bgt.exportDictionaryTable({
      ...table,
      meta: {
        ...table.meta,
        id: normalizeUserId(exportDraft.id || table.meta.id),
        displayName,
        gameName: exportDraft.gameName.trim(),
        sourceLanguage: exportDraft.sourceLanguage,
        targetLanguage: exportDraft.targetLanguage,
        description: exportDraft.description.trim(),
        updatedAt: new Date().toISOString()
      }
    }), (filePath) => {
      if (filePath) setExportOpen(false);
    });
  };

  const openExportDialog = () => {
    if (!table) return;
    setExportDraft({
      id: table.meta.id,
      displayName: table.meta.displayName,
      gameName: table.meta.gameName,
      sourceLanguage: table.meta.sourceLanguage,
      targetLanguage: table.meta.targetLanguage,
      description: table.meta.description
    });
    setExportOpen(true);
  };

  const openPublishDialog = () => {
    if (!table) return;
    const sourceId = selectedOnlineSource?.id ?? onlineSources[0]?.id ?? "";
    const projectName = snapshot.project?.projectName ?? "";
    const gameName = table.meta.gameName || projectName || "Game";
    const sourceLanguage = table.meta.sourceLanguage || snapshot.project?.sourceLanguage || "en";
    const targetLanguage = table.meta.targetLanguage || snapshot.project?.targetLanguage || "zh-CN";
    setPublishDraft({
      sourceId,
      title: buildDiscussionTitle(gameName, sourceLanguage, targetLanguage, table.meta.tableType, table.meta.displayName),
      introduction: table.meta.description.trim() || "请在这里说明这张表适合的游戏、覆盖范围、翻译风格和注意事项。",
      gameDisplayName: gameName,
      sourceLanguage,
      targetLanguage
    });
    setPublishTitleName(table.meta.displayName);
    setPublishCopyMessage("");
    setPublishUpdateTarget(table.meta.remote?.url ?? onlineTable?.summary.url ?? "");
    setPublishStep("edit");
    setPublishMode(githubTokenConfigured ? "auto" : "manual");
    setPublishOpen(true);
  };

  const publishOptions = (): OnlineDictionarySubmissionOptions => ({
    ...publishDraft,
    title: buildDiscussionTitle(
      publishDraft.gameDisplayName,
      publishDraft.sourceLanguage,
      publishDraft.targetLanguage,
      table?.meta.tableType ?? "glossary",
      publishTitleName
    )
  });
  const publishSource = onlineSources.find((source) => source.id === publishDraft.sourceId);
  const publishPageUrl = publishUpdateTarget.trim() || (publishSource ? `${publishSource.url.replace(/\/+$/, "")}/discussions/categories/${encodeURIComponent(publishSource.category)}` : "");

  const tableWithPublishInfo = (baseTable: DictionaryTable): DictionaryTable => {
    const updateUrl = publishUpdateTarget.trim();
    return {
      ...baseTable,
      meta: {
        ...baseTable.meta,
        displayName: publishTitleName.trim() || baseTable.meta.displayName,
        description: publishDraft.introduction.trim(),
        gameName: publishDraft.gameDisplayName.trim(),
        sourceLanguage: publishDraft.sourceLanguage,
        targetLanguage: publishDraft.targetLanguage,
        updatedAt: new Date().toISOString(),
        remote: updateUrl ? remoteInfoFromUrl(updateUrl, baseTable.meta.remote) : undefined
      }
    };
  };

  const startPublish = async () => {
    if (!table || !publishTitleName.trim() || publishUpdateTargetInvalid) return;
    const nextTable = tableWithPublishInfo(table);
    const saved = await run("保存投稿表信息", () => window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName));
    if (!saved) return;
    setTable(saved);
    await reload();
    setSelectedKey(`global:${saved.meta.id}`);
    const tokenStatus = await window.bgt.getOnlineDictionaryTokenStatus().catch(() => ({ configured: false }));
    setGithubTokenConfigured(tokenStatus.configured && tokenStatus.enabled !== false);
    setGithubLogin(tokenStatus.login ?? "");
    const nextPublishMode = tokenStatus.configured && tokenStatus.enabled !== false ? "auto" : "manual";
    setPublishMode(nextPublishMode);
    setPublishCopyMessage("");
    setPublishManualSubmission(null);
    setPublishStep("method");
    if (nextPublishMode === "manual" && rowsToJsonl(saved.rows).length > onlineDictionaryInlineLimit) {
      const submission = await run("准备回复分片", () => window.bgt.buildOnlineDictionaryInlineSubmission(saved, publishOptions()));
      if (submission) setPublishManualSubmission(submission);
    }
  };

  const bumpPublishRevision = async (): Promise<DictionaryTable | null> => {
    if (!table) return null;
    const baseTable = tableWithPublishInfo(table);
    const nextRevision = (baseTable.meta.remote?.revision ?? 0) + 1;
    const nextTable: DictionaryTable = baseTable.meta.remote
      ? {
          ...baseTable,
          meta: {
            ...baseTable.meta,
            updatedAt: new Date().toISOString(),
            remote: {
              ...baseTable.meta.remote,
              revision: nextRevision,
              updatedAt: new Date().toISOString()
            }
          }
        }
      : baseTable;
    const saved = await window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName);
    setTable(saved);
    await reload();
    setSelectedKey(`global:${saved.meta.id}`);
    return saved;
  };

  const publishOnline = async () => {
    if (!table || !publishDraft.sourceId || !publishTitleName.trim()) return;
    const publishTable = await run("更新投稿版本", bumpPublishRevision);
    if (!publishTable) return;
    const target = publishUpdateTarget.trim();
    const options = publishOptions();
    const targetMatchesLoadedRemote = onlineTable ? remoteTargetMatches(onlineTable.summary, target) : false;
    const task = target
      ? () => window.bgt.updateOnlineDictionaryTable(publishTable, {
          ...options,
          discussion: target,
          expectedRevision: targetMatchesLoadedRemote ? onlineTable!.summary.manifest.storage.revision : undefined,
          expectedSha256: targetMatchesLoadedRemote ? onlineTable!.summary.manifest.storage.sha256 : undefined
        })
      : () => window.bgt.publishOnlineDictionaryTable(publishTable, options);
    await run(target ? "更新在线词典" : "上传在线词典", task, (result) => {
      setPublishOpen(false);
      if (publishTable) {
        const nextTable: DictionaryTable = {
          ...publishTable,
          meta: {
            ...publishTable.meta,
            remote: result.discussionId && result.discussionNumber
              ? {
                  sourceId: publishDraft.sourceId,
                  discussionId: result.discussionId,
                  discussionNumber: result.discussionNumber,
                  url: result.url,
                  revision: result.revision ?? publishTable.meta.remote?.revision ?? 1,
                  sha256: result.sha256 ?? publishTable.meta.remote?.sha256 ?? "",
                  updatedAt: new Date().toISOString()
                }
              : publishTable.meta.remote
          }
        };
        setTable(nextTable);
        void window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName).then(() => reload());
      }
      showToast(target ? "在线词典已更新。" : "在线词典已上传。");
    });
  };

  const exportSubmissionPackage = async () => {
    if (!table || !publishDraft.sourceId || !publishTitleName.trim()) return;
    const publishTable = await run("更新投稿版本", bumpPublishRevision);
    if (!publishTable) return;
    await run("导出需上传附件", () => window.bgt.exportOnlineDictionarySubmissionPackage(publishTable, publishOptions()), (result) => {
      if (result) setPublishCopyMessage("附件已导出。粘贴帖文后，在 GitHub 正文编辑框上传这个 .jsonl.gz 文件。");
    });
  };

  const copySubmissionTitle = async () => {
    if (!publishTitleName.trim()) return;
    await run("复制在线词典标题", () => window.bgt.copyText(publishOptions().title), () => {
      setPublishCopyMessage("标题已复制。");
    });
  };

  const copyInlineSubmissionBody = async () => {
    if (!table || !publishTitleName.trim()) return;
    const publishTable = await run("更新投稿版本", bumpPublishRevision);
    if (!publishTable) return;
    const result = await run("生成在线词典帖文", () => window.bgt.buildOnlineDictionaryInlineSubmission(publishTable, publishOptions()));
    if (!result?.body) {
      setPublishCopyMessage("无法生成帖文。");
      return;
    }
    setPublishManualSubmission(result);
    await run("复制在线词典帖文", () => window.bgt.copyText(result.body), () => {
      setPublishCopyMessage(result.comments?.length ? "帖文已复制。请继续依次复制并发布下方回复。" : "帖文已复制。");
    });
  };

  const copySubmissionReply = async (index: number, body: string) => {
    await run(`复制在线词典回复 ${index}`, () => window.bgt.copyText(body), () => {
      setPublishCopyMessage(`回复 ${index} 已复制。`);
    });
  };

  const copyManualSubmissionBody = async (body: string) => {
    await run("复制在线词典帖文", () => window.bgt.copyText(body), () => {
      setPublishCopyMessage("帖文已复制。");
    });
  };

  const selectPublishMode = async (mode: PublishMode) => {
    setPublishMode(mode);
    if (mode !== "manual") return;
    if (!table || canCopyInlineSubmission || publishManualSubmission) return;
    const submission = await run("准备回复分片", () => window.bgt.buildOnlineDictionaryInlineSubmission(table, publishOptions()));
    if (submission) setPublishManualSubmission(submission);
  };

  const checkRemoteUpdate = async () => {
    if (!table?.meta.remote) return;
    const remoteUrl = table.meta.remote.url.trim();
    const remote = await run("检查远程更新", () => remoteUrl
      ? window.bgt.loadOnlineDictionaryTableByUrl(remoteUrl)
      : window.bgt.loadOnlineDictionaryTable(table.meta.remote!.sourceId, table.meta.remote!.discussionId));
    if (!remote) return;
    setRemoteCheckTable(remote);
    const localRemote = table.meta.remote;
    const changed = remote.summary.manifest.storage.revision !== localRemote.revision || remote.summary.manifest.storage.sha256 !== localRemote.sha256;
    if (!changed) {
      showToast("远程词典已是最新。");
      return;
    }
    setRemoteCheckMessage("远程词典有更新。");
    setRemoteCheckOpen(true);
  };

  const overwriteLocalWithRemote = async () => {
    if (!table || !remoteCheckTable) return;
    const nextTable: DictionaryTable = {
      meta: {
        ...table.meta,
        displayName: remoteCheckTable.summary.meta.displayName,
        description: remoteCheckTable.summary.meta.description,
        gameName: remoteCheckTable.summary.meta.gameName,
        sourceLanguage: remoteCheckTable.summary.meta.sourceLanguage,
        targetLanguage: remoteCheckTable.summary.meta.targetLanguage,
        updatedAt: new Date().toISOString(),
        remote: {
          sourceId: remoteCheckTable.summary.sourceId,
          discussionId: remoteCheckTable.summary.discussionId,
          discussionNumber: remoteCheckTable.summary.discussionNumber,
          url: remoteCheckTable.summary.url,
          revision: remoteCheckTable.summary.manifest.storage.revision,
          sha256: remoteCheckTable.summary.manifest.storage.sha256,
          updatedAt: remoteCheckTable.summary.updatedAt
        }
      },
      rows: remoteCheckTable.rows
    };
    await run("覆盖本地词典表", () => window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName), async (saved) => {
      setTable(saved);
      setRemoteCheckOpen(false);
      await reload();
    });
  };

  const importRemoteAsNew = async () => {
    if (!remoteCheckTable) return;
    const result = await run("导入远程词典副本", () => window.bgt.importOnlineDictionaryTable("global", remoteCheckTable.summary.sourceId, remoteCheckTable.summary.discussionId, "newId", {
      meta: {
        schemaVersion: 1,
        kind: "bgt.resourceTable",
        id: suggestConflictId(remoteCheckTable.summary.meta.id),
        tableType: remoteCheckTable.summary.meta.tableType,
        displayName: `${remoteCheckTable.summary.meta.displayName} 副本`,
        description: remoteCheckTable.summary.meta.description,
        gameName: remoteCheckTable.summary.meta.gameName,
        sourceLanguage: remoteCheckTable.summary.meta.sourceLanguage,
        targetLanguage: remoteCheckTable.summary.meta.targetLanguage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        remote: {
          sourceId: remoteCheckTable.summary.sourceId,
          discussionId: remoteCheckTable.summary.discussionId,
          discussionNumber: remoteCheckTable.summary.discussionNumber,
          url: remoteCheckTable.summary.url,
          revision: remoteCheckTable.summary.manifest.storage.revision,
          sha256: remoteCheckTable.summary.manifest.storage.sha256,
          updatedAt: remoteCheckTable.summary.updatedAt
        }
      },
      rows: remoteCheckTable.rows
    }));
    if (result?.status === "imported") {
      setRemoteCheckOpen(false);
      showToast("在线词典已导入。");
      await reload();
    }
  };

  const saveTableInfo = async () => {
    if (!table) return;
    const updateUrl = infoDraft.updateUrl.trim();
    const nextTable: DictionaryTable = {
      ...table,
      meta: {
        ...table.meta,
        id: normalizeUserId(infoDraft.id || table.meta.id),
        displayName: infoDraft.displayName.trim() || table.meta.displayName,
        gameName: infoDraft.gameName.trim(),
        sourceLanguage: infoDraft.sourceLanguage,
        targetLanguage: infoDraft.targetLanguage,
        description: infoDraft.description.trim(),
        updatedAt: new Date().toISOString(),
        remote: updateUrl ? remoteInfoFromUrl(updateUrl, table.meta.remote) : undefined
      }
    };
    await run("保存表信息", () => window.bgt.saveDictionaryTable("global", nextTable, selectedSummary?.fileName), async (saved) => {
      setTable(saved);
      await reload();
      setSelectedKey(`global:${saved.meta.id}`);
      setInfoOpen(false);
    });
  };

  const deleteTable = async () => {
    if (!selectedSummary) return;
    await run("删除词典表", () => window.bgt.deleteDictionaryTable("global", selectedSummary.id, selectedSummary.fileName), async () => {
      setDeleteOpen(false);
      setTable(null);
      await reload();
    });
  };

  const importToProject = async () => {
    if (!table || !snapshot.project) return;
    const result = await run("导入项目词典", () => window.bgt.importDictionaryTable("project", undefined, table));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      setConflict({ mode: "projectImport", table: result.table, existing: result.existing });
      setConflictDraftId(suggestConflictId(result.table.meta.id));
    } else if (result.table) {
      showToast("在线词典已导入项目。");
    }
    await reload();
  };

  const importOnlineToProject = async () => {
    if (!onlineTable || !snapshot.project) return;
    const result = await run("导入在线词典到项目", () => window.bgt.importOnlineDictionaryTable("project", onlineTable.summary.sourceId, onlineTable.summary.discussionId, undefined, onlineTableToLocalTable(onlineTable)));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      setConflict({ mode: "projectImport", table: result.table, existing: result.existing });
      setConflictDraftId(suggestConflictId(result.table.meta.id));
    }
    await reload();
  };

  const importOnlineToDictionary = async () => {
    if (!onlineTable) return;
    const result = await run("导入在线词典到全局词典", () => window.bgt.importOnlineDictionaryTable("global", onlineTable.summary.sourceId, onlineTable.summary.discussionId, undefined, onlineTableToLocalTable(onlineTable)));
    if (!result || result.status === "cancelled") return;
    if (result.status === "conflict" && result.table) {
      setConflict({ mode: "globalImport", table: result.table, existing: result.existing });
      setConflictDraftId(suggestConflictId(result.table.meta.id));
    } else if (result.table) {
      setSelectedKey(`global:${result.table.meta.id}`);
      showToast("在线词典已导入词典。");
    }
    await reload();
  };

  const loadOnlineByLink = async () => {
    const url = linkDownloadDraft.trim();
    if (!url) return;
    setOnlineTableLoading(true);
    const loaded = await run("按链接读取在线词典", () => window.bgt.loadOnlineDictionaryTableByUrl(url))
      .finally(() => setOnlineTableLoading(false));
    if (!loaded) return;
    setOnlineLinkPreview(true);
    setSelectedOnlineId("");
    setOnlineTable(loaded);
    setLinkDownloadOpen(false);
  };

  const deleteOnlineSubmission = async () => {
    if (!onlineTable) return;
    const deletedSummary = onlineTable.summary;
    const selectedTableMatched = Boolean(table?.meta.remote && localRemoteMatchesOnlineSummary(table.meta.remote, deletedSummary));
    await run("删除在线投稿", () => window.bgt.deleteOnlineDictionaryTable(onlineTable.summary.sourceId, onlineTable.summary.discussionId), (result) => {
      showToast(result.clearedLocalLinks ? `在线投稿已删除，已清理 ${result.clearedLocalLinks} 张本地表的远程地址。` : "在线投稿已删除。");
      setTable((current) => current?.meta.remote && localRemoteMatchesOnlineSummary(current.meta.remote, deletedSummary)
        ? { ...current, meta: { ...current.meta, remote: undefined } }
        : current);
      if (selectedTableMatched) {
        setInfoDraft((draft) => ({ ...draft, updateUrl: "" }));
        setPublishUpdateTarget("");
        setRemoteCheckTable(null);
        setRemoteCheckMessage("");
        setRemoteCheckOpen(false);
      }
      setDeleteOnlineOpen(false);
      setOnlineTable(null);
      setSelectedOnlineId("");
      setOnlineLinkPreview(false);
      void reload();
      void reloadOnlineTables({ page: onlinePage });
    });
  };

  const resolveConflict = async (conflictMode: "overwrite" | "newId") => {
    if (!conflict) return;
    const scope = conflict.mode === "globalImport" ? "global" : "project";
    const tableToImport = conflictMode === "newId"
      ? { ...conflict.table, meta: { ...conflict.table.meta, id: normalizeUserId(conflictDraftId) } }
      : conflict.table;
    const resolved = await run(
      conflict.mode === "globalImport" ? "处理词典表冲突" : "处理项目词典表冲突",
      () => window.bgt.importDictionaryTable(scope, conflictMode, tableToImport)
    );
    if (resolved?.status === "imported" && conflict.mode === "globalImport" && resolved.table) setSelectedKey(`global:${resolved.table.meta.id}`);
    if (resolved?.status === "imported") {
      setConflict(null);
      setConflictDraftId("");
    } else if (resolved?.status === "conflict" && resolved.table) {
      setConflict({ mode: conflict.mode, table: resolved.table, existing: resolved.existing });
    }
    await reload();
  };

  return (
    <div className="dictionary-view">
      <aside className="dictionary-list-panel">
        <div className="dictionary-tabs">
          <button className={activeTab === "local" ? "active" : ""} onClick={() => setActiveTab("local")}>本地词典</button>
          <button className={activeTab === "online" ? "active" : ""} onClick={() => setActiveTab("online")}>在线词典</button>
        </div>
        <div className="dictionary-list-header">
          <h2>{activeTab === "local" ? "词典" : "在线词典"}</h2>
          {activeTab === "local" ? (
            <>
              <button className="icon-button" disabled={busy} onClick={openCreateDialog} title="增加空表"><FilePlus size={17} /></button>
              <button className="icon-button" disabled={busy} onClick={importTable} title="导入新表"><Upload size={17} /></button>
            </>
          ) : (
            <>
              <button className="icon-button" disabled={busy || !selectedOnlineSource} onClick={() => run("刷新在线词典", reloadOnlineTables)} title="刷新在线词典"><RefreshCw size={17} /></button>
              <button
                className="icon-button"
                disabled={busy}
                onClick={() => setLinkDownloadOpen(true)}
                title="打开表格链接"
              >
                <LinkIcon size={17} />
              </button>
            </>
          )}
        </div>
        <div className="dictionary-search-row">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (activeTab === "online" && event.key === "Enter") void run("搜索在线词典", () => reloadOnlineTables({ text: event.currentTarget.value }));
            }}
            placeholder={activeTab === "online" ? "搜索 GitHub 词典" : "搜索词典表"}
          />
        </div>
        {activeTab === "online" && (
          <StyledSelect
            value={selectedOnlineSourceId}
            options={onlineSources.map((source) => ({ value: source.id, label: source.displayName }))}
            onChange={(value) => {
              setSelectedOnlineSourceId(value);
              setOnlineSummaries([]);
              setOnlinePage(1);
              setOnlineHasNextPage(false);
              setOnlineHasPreviousPage(false);
              setSelectedOnlineId("");
              setOnlineTable(null);
              setOnlineLinkPreview(false);
            }}
          />
        )}
        <StyledSelect
          value={typeFilter}
          options={[{ value: "all", label: "全部类型" }, ...tableTypeOptions]}
          onChange={(value) => setTypeFilter(value as ResourceTableType | "all")}
        />
        {activeTab === "online" && (
          <>
            <StyledSelect
              value={onlineSourceLanguageFilter}
              options={onlineSourceLanguageOptions}
              onChange={setOnlineSourceLanguageFilter}
            />
            <StyledSelect
              value={onlineTargetLanguageFilter}
              options={onlineTargetLanguageOptions}
              onChange={setOnlineTargetLanguageFilter}
            />
            {githubTokenConfigured ? (
              <label className="online-mine-toggle">
                <CheckboxControl checked={onlineMineOnly} onChange={setOnlineMineOnly} />
                <span>我的投稿</span>
              </label>
            ) : null}
          </>
        )}
        <div className="dictionary-list">
          {activeTab === "local" ? (
            <>
              {visibleTables.map((item) => (
                <button key={summaryKey(item)} className={summaryKey(item) === selectedKey ? "dictionary-list-item active" : "dictionary-list-item"} onClick={() => setSelectedKey(summaryKey(item))}>
                  <strong className="dictionary-list-title">
                    <span>{item.displayName}</span>
                  </strong>
                  {item.updateUrl ? <LinkIcon className="dictionary-list-update-icon" size={14} aria-label="有关联更新网址" /> : null}
                  <span>{tableTypeLabel(item.tableType)} · {item.rowCount} 行</span>
                  {item.description ? <small>{item.description}</small> : null}
                </button>
              ))}
              {!visibleTables.length ? <p className="empty">没有词典表</p> : null}
            </>
          ) : (
            <>
              {onlineError ? <p className="settings-note">{onlineError}</p> : null}
              <p className="empty dictionary-list-hint">修改筛选参数后需要搜索或刷新来应用。</p>
            </>
          )}
        </div>
        {activeTab === "online" && onlineTable ? (
          <div className="online-side-info">
            <div>
              <strong>游戏</strong>
              <span>{onlineTable.summary.meta.gameName}</span>
            </div>
            <div>
              <strong>语言</strong>
              <span>{languageOptionLabel(onlineTable.summary.meta.sourceLanguage)} → {languageOptionLabel(onlineTable.summary.meta.targetLanguage)}</span>
            </div>
            <div>
              <strong>版本</strong>
              <span>{onlineTable.summary.manifest.storage.revision}</span>
            </div>
            <div>
              <strong>作者</strong>
              <span>{onlineTable.summary.author}</span>
            </div>
          </div>
        ) : null}
      </aside>
      <section className="dictionary-table-panel">
        {activeTab === "local" ? (
          table ? (
          <>
            <div className="table-toolbar dictionary-toolbar">
              <div>
                <h2>{table.meta.displayName}</h2>
                <p>{tableTypeLabel(table.meta.tableType)} · {table.rows.length} 行 · {table.meta.id}</p>
              </div>
              <div className="dictionary-toolbar-actions">
                <button disabled={!snapshot.project} onClick={importToProject}><Save size={16} />导入项目</button>
                <button className="secondary-button" onClick={openPublishDialog}><Upload size={16} />{table.meta.remote?.url ? "发布更新" : "投稿在线"}</button>
                <button className="secondary-button" disabled={!table.meta.remote} onClick={checkRemoteUpdate}><RefreshCw size={16} />检查更新</button>
                <button className="secondary-button" onClick={() => setInfoOpen(true)}><Info size={16} />表信息</button>
                <button className="secondary-button" onClick={openExportDialog}><FileDown size={16} />导出表</button>
                <button className="secondary-button danger-button" onClick={() => setDeleteOpen(true)}><Trash2 size={16} />删除表</button>
              </div>
            </div>
            <DictionaryRowsEditor table={table} snapshot={snapshot} tableSettings={tableSettings} onChange={(rows) => saveTable({ ...table, rows })} />
          </>
        ) : (
          <div className="empty dictionary-empty">
            <Download size={26} />
            <p>选择左侧词典表，或导入一个 JSONL 表。</p>
          </div>
          )
        ) : onlineTableLoading ? (
          <div className="empty dictionary-empty dictionary-loading">
            <span className="dictionary-spinner" aria-hidden="true" />
            <p>正在读取在线词典...</p>
          </div>
        ) : onlineTable ? (
          <>
            <div className="table-toolbar dictionary-toolbar">
              <div>
                <button className="secondary-button dictionary-back-button" onClick={() => {
                  setOnlineTable(null);
                  setSelectedOnlineId("");
                  setOnlineLinkPreview(false);
                }}>
                  <ArrowLeft size={16} />
                  返回搜索结果
                </button>
                <h2>{onlineTable.summary.meta.displayName}</h2>
                <p>
                  {tableTypeLabel(onlineTable.summary.meta.tableType)} · {onlineTable.rows.length} 行 · {onlineTable.summary.meta.id}
                </p>
              </div>
              <div className="dictionary-toolbar-actions online-detail-actions">
                <div>
                  <button disabled={!snapshot.project} onClick={importOnlineToProject}><Save size={16} />导入项目</button>
                  <button className="secondary-button" onClick={importOnlineToDictionary}><Download size={16} />导入词典</button>
                  <button className="secondary-button" onClick={() => void window.bgt.openExternal(onlineTable.summary.url)}><ExternalLink size={16} />打开 GitHub</button>
                  {canDeleteOnlineSubmission ? (
                    <button className="secondary-button danger-button" onClick={() => setDeleteOnlineOpen(true)}><Trash2 size={16} />删除投稿</button>
                  ) : null}
                </div>
                {onlineTable.summary.introductionHtml || onlineTable.summary.introduction ? (
                  <div>
                    <button className="secondary-button" onClick={() => setOnlineDescriptionCollapsed((value) => !value)}>
                      {onlineDescriptionCollapsed ? "展开描述" : "收起描述"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {onlineTable.summary.introductionHtml || onlineTable.summary.introduction ? (
              <div className={onlineDescriptionCollapsed ? "online-description-section collapsed" : "online-description-section"}>
                {!onlineDescriptionCollapsed && (onlineTable.summary.introductionHtml ? (
                  <div
                    className="online-dictionary-description markdown-content"
                    onClick={handleExternalMarkdownLinkClick}
                    dangerouslySetInnerHTML={{ __html: onlineTable.summary.introductionHtml }}
                  />
                ) : (
                  <div className="online-dictionary-description markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalMarkdownLink }}>
                      {onlineTable.summary.introduction}
                    </ReactMarkdown>
                  </div>
                ))}
              </div>
            ) : null}
            <DictionaryRowsEditor
              table={{
                meta: {
                  schemaVersion: 1,
                  kind: "bgt.resourceTable",
                  id: normalizeUserId(onlineTable.summary.meta.id),
                  tableType: onlineTable.summary.meta.tableType,
                  displayName: onlineTable.summary.meta.displayName,
                  description: onlineTable.summary.meta.description,
                  gameName: onlineTable.summary.meta.gameName,
                  sourceLanguage: onlineTable.summary.meta.sourceLanguage,
                  targetLanguage: onlineTable.summary.meta.targetLanguage,
                  createdAt: onlineTable.summary.meta.createdAt,
                  updatedAt: onlineTable.summary.meta.updatedAt
                },
                rows: onlineTable.rows
              }}
              snapshot={snapshot}
              tableSettings={tableSettings}
              onChange={() => undefined}
              readOnly
            />
          </>
        ) : visibleOnlineTables.length ? (
          <div className="online-results-view">
            <div className="online-results-header">
              <div>
                <h2>搜索结果</h2>
                <p>第 {onlinePage} 页 · {visibleOnlineTables.length} 个在线词典表</p>
              </div>
              <div className="online-results-actions">
                <button className="secondary-button" disabled={busy || !onlineHasPreviousPage} onClick={() => run("上一页在线词典", () => reloadOnlineTables({ page: onlinePage - 1 }))}>
                  上一页
                </button>
                <button className="secondary-button" disabled={busy || !onlineHasNextPage} onClick={() => run("下一页在线词典", () => reloadOnlineTables({ page: onlinePage + 1 }))}>
                  下一页
                </button>
              </div>
            </div>
            <div className="online-results-list">
              {visibleOnlineTables.map((item) => (
                <button key={item.discussionId} className="online-result-row" onClick={() => {
                  setOnlineLinkPreview(false);
                  setSelectedOnlineId(item.discussionId);
                }}>
                  <div className="online-result-main">
                    <strong>{item.meta.displayName}</strong>
                    <span>{item.meta.gameName}</span>
                    <small>{tableTypeLabel(item.meta.tableType)} · {languageOptionLabel(item.meta.sourceLanguage)} → {languageOptionLabel(item.meta.targetLanguage)}</small>
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
            <Download size={26} />
            <p>刷新在线词典后选择一张表预览。</p>
          </div>
        )}
      </section>
      {table && (
        <AppDialog open={infoOpen} title="表信息" compact onOpenChange={setInfoOpen}>
          <div className="dictionary-create-form">
            <label>
              <span>识别符</span>
              <UserIdInput value={infoDraft.id} onChange={(id) => setInfoDraft((draft) => ({ ...draft, id }))} />
            </label>
            <label>
              <span>显示名称</span>
              <input value={infoDraft.displayName} onChange={(event) => setInfoDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
            </label>
            <label>
              <span>类型</span>
              <input value={tableTypeLabel(table.meta.tableType)} disabled />
            </label>
            <label>
              <span>游戏名称</span>
              <input value={infoDraft.gameName} onChange={(event) => setInfoDraft((draft) => ({ ...draft, gameName: event.target.value }))} />
            </label>
            <label>
              <span>适用源语言</span>
              <StyledSelect value={infoDraft.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => setInfoDraft((draft) => ({ ...draft, sourceLanguage }))} />
            </label>
            <label>
              <span>适用目标语言</span>
              <StyledSelect value={infoDraft.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => setInfoDraft((draft) => ({ ...draft, targetLanguage }))} />
            </label>
            <label>
              <span>功能描述</span>
              <textarea value={infoDraft.description} onChange={(event) => setInfoDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <label>
              <span>更新网址</span>
              <input
                value={infoDraft.updateUrl}
                onChange={(event) => setInfoDraft((draft) => ({ ...draft, updateUrl: event.target.value }))}
              />
            </label>
            <label>
              <span>远程版本号</span>
              <input value={table.meta.remote ? String(table.meta.remote.revision) : "未关联远程词典"} disabled />
            </label>
            <div className="dialog-actions">
              <button disabled={!infoDraft.id.trim() || !infoDraft.displayName.trim() || Boolean(infoDraft.updateUrl.trim() && !isGitHubDiscussionUrl(infoDraft.updateUrl))} onClick={saveTableInfo}>
                <Save size={16} />
                保存
              </button>
            </div>
          </div>
        </AppDialog>
      )}
      <AppDialog open={createOpen} title="新建词典表" description="创建一个空的全局词典表。" compact onOpenChange={setCreateOpen}>
        <div className="dictionary-create-form">
          <label>
            <span>表类型</span>
            <StyledSelect
              value={createDraft.tableType}
              options={tableTypeOptions}
              onChange={(value) => {
                const tableType = value as ResourceTableType;
                setCreateDraft((draft) => ({
                  ...draft,
                  tableType,
                  id: draft.id ? userIdSuffix(draft.id) : `${tableType}_${Date.now()}`,
                  displayName: draft.displayName || tableTypeLabel(tableType)
                }));
              }}
            />
          </label>
          <label>
            <span>识别符</span>
            <UserIdInput value={createDraft.id} onChange={(id) => setCreateDraft((draft) => ({ ...draft, id }))} />
          </label>
          <label>
            <span>显示名称</span>
            <input value={createDraft.displayName} onChange={(event) => setCreateDraft((draft) => ({ ...draft, displayName: event.target.value }))} placeholder="表名称" />
          </label>
          <label>
            <span>游戏名称</span>
            <input value={createDraft.gameName} onChange={(event) => setCreateDraft((draft) => ({ ...draft, gameName: event.target.value }))} placeholder="适用游戏，可留空" />
          </label>
          <label>
            <span>适用源语言</span>
            <StyledSelect value={createDraft.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => setCreateDraft((draft) => ({ ...draft, sourceLanguage }))} />
          </label>
          <label>
            <span>适用目标语言</span>
            <StyledSelect value={createDraft.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => setCreateDraft((draft) => ({ ...draft, targetLanguage }))} />
          </label>
          <label>
            <span>功能描述</span>
            <textarea value={createDraft.description} onChange={(event) => setCreateDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="说明这张表适合什么项目或用途" />
          </label>
          <div className="dialog-actions conflict-dialog-actions">
            <button disabled={busy || !createDraft.id.trim() || !createDraft.displayName.trim()} onClick={createEmpty}>
              <FilePlus size={16} />
              创建
            </button>
          </div>
        </div>
      </AppDialog>
      {table && (
        <AppDialog open={exportOpen} title="导出词典表" description="导出文件首行会写入这里的表信息。" compact onOpenChange={setExportOpen}>
          <div className="dictionary-create-form">
            <label>
              <span>识别符</span>
              <UserIdInput value={exportDraft.id} onChange={(id) => setExportDraft((draft) => ({ ...draft, id }))} />
            </label>
            <label>
              <span>显示名称</span>
              <input value={exportDraft.displayName} onChange={(event) => setExportDraft((draft) => ({ ...draft, displayName: event.target.value }))} />
            </label>
            <label>
              <span>类型</span>
              <input value={tableTypeLabel(table.meta.tableType)} disabled />
            </label>
            <label>
              <span>游戏名称</span>
              <input value={exportDraft.gameName} onChange={(event) => setExportDraft((draft) => ({ ...draft, gameName: event.target.value }))} />
            </label>
            <label>
              <span>适用源语言</span>
              <StyledSelect value={exportDraft.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => setExportDraft((draft) => ({ ...draft, sourceLanguage }))} />
            </label>
            <label>
              <span>适用目标语言</span>
              <StyledSelect value={exportDraft.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => setExportDraft((draft) => ({ ...draft, targetLanguage }))} />
            </label>
            <label>
              <span>功能描述</span>
              <textarea value={exportDraft.description} onChange={(event) => setExportDraft((draft) => ({ ...draft, description: event.target.value }))} />
            </label>
            <div className="dialog-actions">
              <button disabled={busy || !exportDraft.id.trim() || !exportDraft.displayName.trim()} onClick={exportTable}>
                <FileDown size={16} />
                导出
              </button>
            </div>
          </div>
        </AppDialog>
      )}
      <AppDialog
        open={linkDownloadOpen}
        title="按链接下载"
        description="输入 GitHub discussion 链接，读取后会在右侧预览。"
        compact
        onOpenChange={setLinkDownloadOpen}
      >
        <div className="dictionary-create-form">
          <label>
            <span>帖子链接</span>
            <input
              value={linkDownloadDraft}
              onChange={(event) => setLinkDownloadDraft(event.target.value)}
              placeholder="https://github.com/Heptagon196/BrowserGameTranslator/discussions/1"
            />
          </label>
          <div className="dialog-actions conflict-dialog-actions">
            <button disabled={busy || !linkDownloadDraft.trim()} onClick={loadOnlineByLink}>
              <Download size={16} />
              读取预览
            </button>
          </div>
        </div>
      </AppDialog>
      {table && (
        <AppDialog
          open={publishOpen}
          title={publishHasUpdateTarget ? "更新到在线词典库" : "投稿到在线词典库"}
          description={publishStep === "edit" ? "先确认会写入表信息的内容。" : "选择投稿方式并按指引完成发布。"}
          compact
          onOpenChange={(open) => {
            setPublishOpen(open);
            if (!open) {
              setPublishStep("edit");
              setPublishCopyMessage("");
              setPublishManualSubmission(null);
            }
          }}
        >
          {publishStep === "edit" ? (
            <div className="dictionary-create-form">
              <label>
                <span>表名</span>
                <div className="discussion-title-input">
                  <span>{discussionTitlePrefix(publishDraft.gameDisplayName, publishDraft.sourceLanguage, publishDraft.targetLanguage, table.meta.tableType)}</span>
                  <input value={publishTitleName} onChange={(event) => setPublishTitleName(event.target.value)} />
                </div>
              </label>
              <label>
                <span>游戏名称</span>
                <input value={publishDraft.gameDisplayName} onChange={(event) => setPublishDraft((draft) => ({ ...draft, gameDisplayName: event.target.value }))} />
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
                  <label>
                    <span>适用源语言</span>
                    <StyledSelect value={publishDraft.sourceLanguage} options={languageSelectOptions} onChange={(sourceLanguage) => setPublishDraft((draft) => ({ ...draft, sourceLanguage }))} />
                  </label>
                  <label>
                    <span>适用目标语言</span>
                    <StyledSelect value={publishDraft.targetLanguage} options={languageSelectOptions} onChange={(targetLanguage) => setPublishDraft((draft) => ({ ...draft, targetLanguage }))} />
                  </label>
                </div>
              </details>
              <p className="settings-note">这些内容会同步写入当前表信息，并用于生成 discussion 标题和正文。</p>
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
                setPublishManualSubmission(null);
              }}>
                返回投稿页
              </button>
              <label>
                <span>在线词典源</span>
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
                  publishManualSubmission?.comments?.length ? (
                    <p>当前表压缩后仍较大，会使用回复分片。先复制标题和帖文创建帖子，再按下方列表顺序复制每条回复并发布到同一个 discussion。</p>
                  ) : (
                    <p>当前表可以作为正文发布。大表会先压缩，压缩后仍过大时再使用回复分片。</p>
                  )
                ) : (
                  <p>自动投稿会调用 GitHub API 创建或更新 discussion。大表会先压缩，压缩后仍过大时再使用回复分片。</p>
                )}
                <small>标题：{publishOptions().title}</small>
              </div>
              {publishCopyMessage ? <p className="settings-note">{publishCopyMessage}</p> : null}
              <div className="dialog-actions publish-dialog-actions">
                <button className="secondary-button" disabled={!publishPageUrl} onClick={() => publishPageUrl && void window.bgt.openExternal(publishPageUrl)}>
                  <ExternalLink size={16} />
                  打开发布网页
                </button>
                {publishMode === "manual" ? (
                  !publishManualSubmission ? (
                  <>
                    <button className="secondary-button" disabled={!publishTitleName.trim()} onClick={copySubmissionTitle}>
                      <Copy size={16} />
                      复制标题
                    </button>
                    <button className="secondary-button" disabled={!publishTitleName.trim()} onClick={copyInlineSubmissionBody}>
                      <Copy size={16} />
                      复制帖文
                    </button>
                  </>
                  ) : !publishManualSubmission.comments?.length ? (
                  <>
                    <button className="secondary-button" disabled={!publishTitleName.trim()} onClick={copySubmissionTitle}>
                      <Copy size={16} />
                      复制标题
                    </button>
                    <button className="secondary-button" disabled={!publishManualSubmission.body} onClick={() => publishManualSubmission.body && copyManualSubmissionBody(publishManualSubmission.body)}>
                      <Copy size={16} />
                      复制帖文
                    </button>
                  </>
                  ) : null
                ) : (
                  <button disabled={!publishDraft.sourceId || !publishTitleName.trim()} onClick={publishOnline}>
                    <Upload size={16} />
                    {publishUpdateTarget.trim() ? "自动更新" : "自动上传"}
                  </button>
                )}
              </div>
              {publishMode === "manual" && publishManualSubmission?.comments?.length ? (
                <div className="publish-reply-list">
                  <strong>发布步骤</strong>
                  <div className="publish-reply-row">
                    <span>标题</span>
                    <button className="secondary-button" disabled={!publishTitleName.trim()} onClick={copySubmissionTitle}>
                      <Copy size={16} />
                      复制标题
                    </button>
                  </div>
                  <div className="publish-reply-row">
                    <span>主贴文</span>
                    <button className="secondary-button" disabled={!publishManualSubmission.body} onClick={() => publishManualSubmission.body && copyManualSubmissionBody(publishManualSubmission.body)}>
                      <Copy size={16} />
                      复制贴文
                    </button>
                  </div>
                  {publishManualSubmission.comments.map((comment) => (
                    <div key={comment.index} className="publish-reply-row">
                      <span>{comment.index}. 回复 {comment.index} · {comment.rowCount !== undefined ? `${comment.rowCount} 行` : `${comment.byteLength ?? 0} 字节`}</span>
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
      )}
      <AppDialog open={remoteCheckOpen} title="远程更新检查" description={remoteCheckMessage} compact onOpenChange={setRemoteCheckOpen}>
        <div className="dictionary-create-form">
          {remoteCheckTable && table?.meta.remote ? (
            <>
              <p className="settings-note">
                本地记录 rev {table.meta.remote.revision} · 远程 rev {remoteCheckTable.summary.manifest.storage.revision}
              </p>
              <p className="settings-note">
                本地行数 {table.rows.length} · 远程行数 {remoteCheckTable.rows.length}
              </p>
              {buildRemoteDiffs(table, remoteCheckTable).map((line) => (
                <p key={line} className="settings-note">{line}</p>
              ))}
              <p className="settings-note">{remoteCheckTable.summary.url}</p>
            </>
          ) : null}
          <div className="dialog-actions">
            <button className="secondary-button" disabled={!remoteCheckTable} onClick={importRemoteAsNew}>
              导入为新表
            </button>
            <button disabled={!remoteCheckTable} onClick={overwriteLocalWithRemote}>
              覆盖本地表
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog open={deleteOpen} title="删除词典表" description="此操作会删除全局词典中的这张表，无法撤销。" compact onOpenChange={setDeleteOpen}>
        <div className="delete-confirm-body">
          <p>
            确定删除 <strong>{selectedSummary?.displayName ?? "当前表"}</strong> 吗？
          </p>
          {selectedSummary ? (
            <p className="settings-note">
              {tableTypeLabel(selectedSummary.tableType)} · {selectedSummary.rowCount} 行 · {selectedSummary.id}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="danger-action-button" disabled={!selectedSummary || busy} onClick={deleteTable}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog open={deleteOnlineOpen} title="删除投稿" description="此操作会从 GitHub Discussions 删除这篇投稿，无法撤销。" compact onOpenChange={setDeleteOnlineOpen}>
        <div className="delete-confirm-body">
          <p>
            确定删除 <strong>{onlineTable?.summary.meta.displayName ?? "当前投稿"}</strong> 吗？
          </p>
          {onlineTable ? <p className="settings-note">{onlineTable.summary.url}</p> : null}
          <div className="dialog-actions conflict-dialog-actions">
            <button className="danger-action-button" disabled={busy || !onlineTable} onClick={deleteOnlineSubmission}>
              <Trash2 size={16} />
              删除投稿
            </button>
          </div>
        </div>
      </AppDialog>
      <AppDialog
        open={Boolean(conflict)}
        title="词典表冲突"
        description={conflict?.mode === "projectImport" ? "项目中已存在同 ID 的表。请选择覆盖现有项目表，或填写新 ID 后创建项目副本。" : "全局词典中已存在同 ID 的表。请选择覆盖现有表，或填写新 ID 后创建副本。"}
        compact
        onOpenChange={(open) => {
          if (open) return;
          setConflict(null);
          setConflictDraftId("");
        }}
      >
        <div className="dictionary-create-form">
          <p>
            已存在 <strong>{conflict?.existing?.displayName ?? conflict?.table.meta.id ?? "同 ID 表"}</strong>
          </p>
          {conflict ? (
            <p className="settings-note">
              {tableTypeLabel(conflict.table.meta.tableType)} · {conflict.table.rows.length} 行 · {conflict.table.meta.id}
            </p>
          ) : null}
          <label>
            <span>新识别符</span>
            <UserIdInput value={conflictDraftId} onChange={setConflictDraftId} />
          </label>
          {conflictDraftExists ? <p className="settings-note">这个识别符已经存在，请换一个。</p> : null}
          <div className="dialog-actions conflict-dialog-actions">
            <button className="secondary-button" disabled={busy || !conflict || !conflictDraftId.trim() || conflictDraftExists} onClick={() => resolveConflict("newId")}>
              创建新 ID
            </button>
            <button className="danger-action-button" disabled={busy || !conflict} onClick={() => resolveConflict("overwrite")}>
              覆盖
            </button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

export function DictionaryRowsEditor({ table, snapshot, tableSettings, onChange, readOnly = false }: { table: DictionaryTable; snapshot: AppStateSnapshot; tableSettings: TableSettings; onChange: (rows: DictionaryTableRows) => void; readOnly?: boolean }) {
  if (table.meta.tableType === "characters") {
    return <CharacterResourceTable rows={table.rows as CharacterEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} readOnly={readOnly} />;
  }
  if (table.meta.tableType === "glossary") {
    return <GlossaryResourceTable rows={table.rows as GlossaryEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} readOnly={readOnly} />;
  }
  return <NoTranslateResourceTable rows={table.rows as NoTranslateEntry[]} textItems={snapshot.textItems} sourceLanguage={snapshot.project?.sourceLanguage} tableSettings={tableSettings} onChange={(rows) => onChange(rows)} readOnly={readOnly} />;
}

function summaryKey(item: DictionaryTableSummary): string {
  return `${item.scope}:${item.id}`;
}

export function tableTypeLabel(tableType: ResourceTableType): string {
  if (tableType === "characters") return "人物表";
  if (tableType === "glossary") return "术语表";
  return "禁翻表";
}

function rowsToJsonl(rows: DictionaryTableRows): string {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  return body ? `${body}\n` : "";
}

function onlineTableToLocalTable(remote: OnlineDictionaryTable): DictionaryTable {
  const now = new Date().toISOString();
  return {
    meta: {
      schemaVersion: 1,
      kind: "bgt.resourceTable",
      id: normalizeUserId(remote.summary.meta.id),
      tableType: remote.summary.meta.tableType,
      displayName: remote.summary.meta.displayName,
      description: remote.summary.meta.description,
      gameName: remote.summary.meta.gameName,
      sourceLanguage: remote.summary.meta.sourceLanguage,
      targetLanguage: remote.summary.meta.targetLanguage,
      createdAt: now,
      updatedAt: now,
      remote: {
        sourceId: remote.summary.sourceId,
        discussionId: remote.summary.discussionId,
        discussionNumber: remote.summary.discussionNumber,
        url: remote.summary.url,
        revision: remote.summary.manifest.storage.revision,
        sha256: remote.summary.manifest.storage.sha256,
        updatedAt: remote.summary.updatedAt
      }
    },
    rows: remote.rows
  };
}

function remoteInfoFromUrl(url: string, existing?: DictionaryTable["meta"]["remote"]): NonNullable<DictionaryTable["meta"]["remote"]> {
  const number = parseGitHubDiscussionNumber(url);
  const sameRemote = existing?.url === url;
  return {
    sourceId: sameRemote ? existing.sourceId : "link",
    discussionId: sameRemote ? existing.discussionId : (number ? `web:${number}` : ""),
    discussionNumber: sameRemote ? existing.discussionNumber : number ?? 0,
    url,
    revision: sameRemote ? existing.revision : 0,
    sha256: sameRemote ? existing.sha256 : "",
    updatedAt: sameRemote ? existing.updatedAt : ""
  };
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

function languageOptionLabel(language: string): string {
  return languageLabel(language || "unknown");
}

function buildDiscussionTitle(gameName: string, sourceLanguage: string, targetLanguage: string, tableType: ResourceTableType, tableName: string): string {
  return `${discussionTitlePrefix(gameName, sourceLanguage, targetLanguage, tableType)} ${tableName.trim()}`;
}

function buildOnlineDictionaryWebSearchQuery(sourceLanguage: string, targetLanguage: string, tableType: ResourceTableType | "all", text: string): string {
  return [
    onlineLanguageSearchToken(sourceLanguage, targetLanguage),
    tableType === "all" ? "" : `[${tableTypeLabel(tableType)}]`,
    text.trim()
  ].filter(Boolean).join(" ");
}

function onlineLanguageSearchToken(sourceLanguage: string, targetLanguage: string): string {
  const source = sourceLanguage === "all" ? "" : formatLanguageTag(sourceLanguage);
  const target = targetLanguage === "all" ? "" : formatLanguageTag(targetLanguage);
  if (source && target) return `[${source}->${target}]`;
  if (source) return `[${source}->`;
  if (target) return `->${target}]`;
  return "";
}

function discussionTitlePrefix(gameName: string, sourceLanguage: string, targetLanguage: string, tableType: ResourceTableType): string {
  return `[${gameName.trim() || "Game"}][${formatLanguageTag(sourceLanguage)}->${formatLanguageTag(targetLanguage)}][${tableTypeLabel(tableType)}]`;
}

function formatLanguageTag(language: string): string {
  return language.trim().replace(/-/g, "_") || "unknown";
}

function remoteTargetMatches(summary: OnlineDictionarySummary, target: string): boolean {
  const trimmed = target.trim();
  return trimmed === summary.url || trimmed === String(summary.discussionNumber) || trimmed === summary.discussionId;
}

function localRemoteMatchesOnlineSummary(remote: DictionaryTableRemote, summary: OnlineDictionarySummary): boolean {
  return normalizeRemoteUrl(remote.url) === normalizeRemoteUrl(summary.url) ||
    (remote.sourceId === summary.sourceId && remote.discussionId === summary.discussionId) ||
    (remote.sourceId === summary.sourceId && remote.discussionNumber === summary.discussionNumber);
}

function normalizeRemoteUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function buildRemoteDiffs(local: DictionaryTable, remote: OnlineDictionaryTable): string[] {
  const lines: string[] = [];
  const remoteMeta = remote.summary.meta;
  const localRemote = local.meta.remote;
  if (local.meta.tableType !== remoteMeta.tableType) {
    lines.push(`类型：本地 ${tableTypeLabel(local.meta.tableType)} · 远程 ${tableTypeLabel(remoteMeta.tableType)}`);
  }
  if (local.meta.displayName !== remoteMeta.displayName) {
    lines.push(`名称：本地 ${local.meta.displayName || "未命名"} · 远程 ${remoteMeta.displayName || "未命名"}`);
  }
  if (local.rows.length !== remote.rows.length) {
    lines.push(`行数：本地 ${local.rows.length} · 远程 ${remote.rows.length}`);
  }
  if (localRemote?.sha256 && localRemote.sha256 !== remote.summary.manifest.storage.sha256) {
    lines.push("内容 hash：远程内容与本地记录不同。");
  }
  if (localRemote?.updatedAt && localRemote.updatedAt !== remote.summary.updatedAt) {
    lines.push(`更新时间：本地记录 ${formatDateTime(localRemote.updatedAt)} · 远程 ${formatDateTime(remote.summary.updatedAt)}`);
  }
  if (!lines.length) lines.push("未发现 meta、行数或更新时间差异。");
  return lines;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function UserIdInput({ value, disabled = false, onChange }: { value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="user-id-input">
      <span>user.</span>
      <input value={userIdSuffix(value)} disabled={disabled} onChange={(event) => onChange(userIdSuffix(event.target.value))} placeholder="my_table" />
    </div>
  );
}

function userIdSuffix(id: string): string {
  return id
    .trim()
    .replace(/^user\./, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

export function normalizeUserId(id: string): string {
  const body = userIdSuffix(id) || `table_${Date.now()}`;
  return `user.${body}`;
}

export function suggestConflictId(id: string): string {
  return normalizeUserId(`${id}_${Date.now()}`);
}
