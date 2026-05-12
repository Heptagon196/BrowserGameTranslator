import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { app, dialog, net } from "electron";
import { getConfig } from "7zip-min";
import { JSDOM } from "jsdom";
import {
  DictionaryTableRemote,
  DictionaryScope,
  DictionaryTable,
  DictionaryTableRows,
  OnlineDictionaryConnectionTest,
  OnlineDictionaryManifest,
  OnlineDictionaryMeta,
  OnlineDictionaryListResult,
  OnlineDictionarySettings,
  OnlineDictionarySource,
  OnlineDictionaryPublishResult,
  OnlineDictionaryInlineSubmissionResult,
  OnlineDictionarySubmissionOptions,
  OnlineDictionarySubmissionPackageResult,
  OnlineDictionarySummary,
  OnlineDictionaryTable,
  OnlineDictionaryTokenStatus,
  OnlineDictionaryUpdateOptions,
  ProjectConfig
} from "../shared/types";
import { clearDictionaryRemoteLinks, importDictionaryTable } from "./dictionaryService";
import {
  createGitHubDiscussionStore,
  commentsByPartIndex as discussionCommentsByPartIndex,
  escapeRegExp as escapeGitHubRegExp,
  extractMarkedBlock as extractDiscussionMarkedBlock,
  fetchGitHub as fetchGitHubRequest,
  fetchText as fetchGitHubText,
  GitHubDiscussionNode,
  isAllowedAttachmentUrl as isGitHubAttachmentUrl,
  isDiscussionNode as isGitHubDiscussionNode,
  normalizeHash as normalizeDiscussionHash,
  parseDiscussionNumber as parseGitHubDiscussionNumber,
  parseGitHubDiscussionUrl as parseGitHubDiscussionLink,
  parseGitHubRepositoryUrl as parseGitHubRepositoryLink,
  parseJsonMarkedBlock as parseDiscussionJsonMarkedBlock,
  sha256 as discussionSha256,
  splitText as splitDiscussionText,
  wrapBase64 as wrapDiscussionBase64
} from "./githubDiscussionStore";
import { readJson, writeJson } from "./storage";

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);
const inlineLimit = 50000;
const commentPartLimit = 50000;
const attachmentUrlPlaceholder = "PASTE_GITHUB_ATTACHMENT_URL_HERE";
const compressedEncoding = "base64" as const;
const compressedFormat = "gzip" as const;
const defaultSource: OnlineDictionarySource = {
  id: "official",
  displayName: "默认源",
  url: "https://github.com/Heptagon196/BrowserGameTranslator",
  owner: "Heptagon196",
  repo: "BrowserGameTranslator",
  category: "词典",
  enabled: true,
  readonly: true
};

const tableTypeLabels: Record<OnlineDictionaryMeta["tableType"], string> = {
  characters: "人物表",
  glossary: "术语表",
  noTranslate: "禁翻表"
};

const githubDiscussions = createGitHubDiscussionStore<OnlineDictionarySource>({
  settingsFileName: "online-dictionaries.json",
  tokenFileName: "online-dictionary-secrets.json",
  defaultSource,
  defaultCategory: "词典",
  tokenRequiredMessage: "自动上传词典需要 GitHub API Token。",
  publicConnectionMessage: (source) => `已连接公开分类 ${source.owner}/${source.repo}/${source.category}。未使用 GitHub API Token。`,
  tokenConnectionMessage: (source, categoryId) => `已连接 ${source.owner}/${source.repo}，找到分类 ${source.category}。${categoryId}`
});

function settingsPath(): string {
  return path.join(app.getPath("userData"), "online-dictionaries.json");
}

function tokenPath(): string {
  return path.join(app.getPath("userData"), "online-dictionary-secrets.json");
}

export async function listOnlineDictionarySources(): Promise<OnlineDictionarySettings> {
  return githubDiscussions.listSources();
}

export async function saveOnlineDictionarySources(settings: OnlineDictionarySettings): Promise<OnlineDictionarySettings> {
  return githubDiscussions.saveSources(settings);
}

export async function getOnlineDictionaryTokenStatus(): Promise<OnlineDictionaryTokenStatus> {
  return githubDiscussions.getTokenStatus();
}

export async function saveOnlineDictionaryToken(token: string): Promise<OnlineDictionaryTokenStatus> {
  return githubDiscussions.saveToken(token);
}

export async function testOnlineDictionarySource(sourceId: string): Promise<OnlineDictionaryConnectionTest> {
  return githubDiscussions.testSource(sourceId);
}

export async function listOnlineDictionaryTables(sourceId: string, webSearchQuery = "", page = 1, mineOnly = false): Promise<OnlineDictionaryListResult> {
  const source = await requireSource(sourceId);
  if ((await loadToken()).trim()) return searchOnlineDictionaryTables(source, webSearchQuery, page, mineOnly);
  if (mineOnly) throw new Error("筛选我的投稿需要先配置 GitHub API Token。");
  return listPublicOnlineDictionaryTables(source, webSearchQuery, page);
}

async function searchOnlineDictionaryTables(source: OnlineDictionarySource, webSearchQuery = "", page = 1, mineOnly = false): Promise<OnlineDictionaryListResult> {
  const result = await githubDiscussions.searchDiscussionNodes(source, webSearchQuery, page, mineOnly);
  return {
    summaries: result.nodes
      .map((node) => parseDiscussionSummary(source.id, node))
      .filter((summary): summary is OnlineDictionarySummary => Boolean(summary)),
    page: result.page,
    hasNextPage: result.hasNextPage,
    hasPreviousPage: result.hasPreviousPage
  };
}

export async function loadOnlineDictionaryTable(sourceId: string, discussionId: string): Promise<OnlineDictionaryTable> {
  const source = await requireSource(sourceId);
  if (discussionId.startsWith("web:")) {
    const node = await loadPublicDiscussionNode(source, Number(discussionId.slice("web:".length)));
    const summary = parseDiscussionSummary(source.id, node);
    if (!summary) throw new Error("这个 discussion 不是 BrowserGameTranslator 在线词典表。");
    const jsonl = await readRemoteJsonl(summary, node.body, node.publicComments ?? [], node.attachmentUrls ?? []);
    const rows = parseRows(jsonl, summary);
    return { summary, rows };
  }
  const node = await loadDiscussionNode(discussionId);
  const summary = parseDiscussionSummary(source.id, node);
  if (!summary) throw new Error("这个 discussion 不是 BrowserGameTranslator 在线词典表。");
  const jsonl = await readRemoteJsonl(summary, node.body, node.publicComments ?? [], node.attachmentUrls ?? []);
  const rows = parseRows(jsonl, summary);
  return { summary, rows };
}

export async function loadOnlineDictionaryTableByUrl(url: string): Promise<OnlineDictionaryTable> {
  const parsed = parseGitHubDiscussionUrl(url);
  const configuredSource = (await listOnlineDictionarySources()).sources.find((source) =>
    source.owner.toLowerCase() === parsed.owner.toLowerCase() && source.repo.toLowerCase() === parsed.repo.toLowerCase()
  );
  const source: OnlineDictionarySource = configuredSource ?? {
    id: `link:${parsed.owner}/${parsed.repo}`,
    displayName: `${parsed.owner}/${parsed.repo}`,
    url: `https://github.com/${parsed.owner}/${parsed.repo}`,
    owner: parsed.owner,
    repo: parsed.repo,
    category: "词典",
    enabled: true
  };
  if ((await loadToken()).trim()) {
    const node = await loadDiscussionNodeByRepositoryNumber(source, parsed.number);
    const summary = parseDiscussionSummary(source.id, node);
    if (!summary) throw new Error("这个 discussion 不是 BrowserGameTranslator 在线词典表。");
    const jsonl = await readRemoteJsonl(summary, node.body, node.publicComments ?? [], node.attachmentUrls ?? []);
    const rows = parseRows(jsonl, summary);
    return { summary, rows };
  }
  const node = await loadPublicDiscussionNode(source, parsed.number);
  const summary = parseDiscussionSummary(source.id, node);
  if (!summary) throw new Error("这个 discussion 不是 BrowserGameTranslator 在线词典表。");
  const jsonl = await readRemoteJsonl(summary, node.body, node.publicComments ?? [], node.attachmentUrls ?? []);
  const rows = parseRows(jsonl, summary);
  return { summary, rows };
}

export async function importOnlineDictionaryTable(scope: DictionaryScope, sourceId: string, discussionId: string, project: ProjectConfig | undefined, conflictMode?: "overwrite" | "newId", pendingTable?: DictionaryTable) {
  const targetScope: DictionaryScope = scope === "project" ? "project" : "global";
  if (targetScope === "project" && !project) throw new Error("请先打开项目。");
  const table = pendingTable ?? remoteToLocalTable(await loadOnlineDictionaryTable(sourceId, discussionId));
  return importDictionaryTable(targetScope, project, conflictMode, table);
}

export async function publishOnlineDictionaryTable(table: DictionaryTable, options: OnlineDictionarySubmissionOptions): Promise<OnlineDictionaryPublishResult> {
  const token = (await loadToken()).trim();
  if (!token) throw new Error("自动上传词典需要 GitHub API Token。没有 token 时请导出投稿包。");
  const source = await requireSource(options.sourceId);
  const { repositoryId, categoryId } = await loadRepositoryPublishInfo(source);
  await assertNoRemoteConflict(source, table.meta.id.replace(/^user\./, ""), options.title);
  const payload = buildSubmissionPayload(table.rows);
  const revision = submissionRevision(table);
  if (payload.jsonl.length <= inlineLimit) {
    const body = buildDiscussionBody(table, options, {
      schemaVersion: 1,
      storage: {
        mode: "inline",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256
      }
    }, payload.jsonl);
    const created = await createDiscussion(repositoryId, categoryId, options.title, body);
    return { url: created.url, discussionId: created.id, discussionNumber: created.number, mode: "inline", revision, sha256: payload.jsonlSha256 };
  }

  if (payload.compressedBase64.length <= inlineLimit) {
    const body = buildDiscussionBody(table, options, {
      schemaVersion: 1,
      storage: {
        mode: "compressedInline",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256,
        compression: compressedFormat,
        encoding: compressedEncoding,
        byteLength: payload.byteLength,
        compressedByteLength: payload.compressedByteLength
      }
    }, undefined, payload.compressedBase64);
    const created = await createDiscussion(repositoryId, categoryId, options.title, body);
    return { url: created.url, discussionId: created.id, discussionNumber: created.number, mode: "compressedInline", revision, sha256: payload.jsonlSha256 };
  }

  const placeholderManifest: OnlineDictionaryManifest = {
    schemaVersion: 1,
    storage: {
      mode: "compressedComments",
      revision,
      rowCount: payload.rowCount,
      sha256: payload.jsonlSha256,
      compression: compressedFormat,
      encoding: compressedEncoding,
      byteLength: payload.byteLength,
      compressedByteLength: payload.compressedByteLength,
      parts: []
    }
  };
  const created = await createDiscussion(repositoryId, categoryId, options.title, buildDiscussionBody(table, options, placeholderManifest));
  const parts = splitText(payload.compressedBase64, commentPartLimit);
  const manifestParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const partBody = buildCompressedPartComment(index + 1, parts[index]);
    const comment = await addDiscussionComment(created.id, partBody);
    manifestParts.push({
      index: index + 1,
      commentId: comment.id,
      byteLength: Buffer.byteLength(parts[index], "utf8"),
      sha256: sha256(parts[index])
    });
  }
  const manifest: OnlineDictionaryManifest = {
    schemaVersion: 1,
    storage: {
      mode: "compressedComments",
      revision,
      rowCount: payload.rowCount,
      sha256: payload.jsonlSha256,
      compression: compressedFormat,
      encoding: compressedEncoding,
      byteLength: payload.byteLength,
      compressedByteLength: payload.compressedByteLength,
      parts: manifestParts
    }
  };
  await updateDiscussion(created.id, options.title, buildDiscussionBody(table, options, manifest));
  return { url: created.url, discussionId: created.id, discussionNumber: created.number, mode: "compressedComments", revision, sha256: payload.jsonlSha256 };
}

export async function updateOnlineDictionaryTable(table: DictionaryTable, options: OnlineDictionaryUpdateOptions): Promise<OnlineDictionaryPublishResult> {
  const token = (await loadToken()).trim();
  if (!token) throw new Error("自动更新词典需要 GitHub API Token。没有 token 时请导出投稿包。");
  const source = await requireSource(options.sourceId);
  const number = parseDiscussionNumber(options.discussion);
  const current = await loadDiscussionNodeByRepositoryNumber(source, number);
  const currentSummary = parseDiscussionSummary(source.id, current);
  if (!currentSummary) throw new Error("目标 discussion 不是 BrowserGameTranslator 在线词典表。");
  const currentManifest = requireManifest(currentSummary);
  if (options.expectedRevision && currentManifest.storage.revision !== options.expectedRevision) {
    throw new Error("远程词典已经被更新，请刷新后再提交。");
  }
  if (options.expectedSha256 && normalizeHash(currentManifest.storage.sha256) !== normalizeHash(options.expectedSha256)) {
    throw new Error("远程词典内容已经变化，请刷新后再提交。");
  }
  const payload = buildSubmissionPayload(table.rows);
  const revision = currentManifest.storage.revision + 1;
  if (payload.jsonl.length <= inlineLimit) {
    const manifest: OnlineDictionaryManifest = {
      schemaVersion: 1,
      storage: {
        mode: "inline",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256
      }
    };
    await updateDiscussion(current.id, options.title, buildDiscussionBody(table, options, manifest, payload.jsonl));
    return { url: current.url, discussionId: current.id, discussionNumber: current.number, mode: "inline", revision, sha256: payload.jsonlSha256 };
  }

  if (payload.compressedBase64.length <= inlineLimit) {
    const manifest: OnlineDictionaryManifest = {
      schemaVersion: 1,
      storage: {
        mode: "compressedInline",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256,
        compression: compressedFormat,
        encoding: compressedEncoding,
        byteLength: payload.byteLength,
        compressedByteLength: payload.compressedByteLength
      }
    };
    await updateDiscussion(current.id, options.title, buildDiscussionBody(table, options, manifest, undefined, payload.compressedBase64));
    return { url: current.url, discussionId: current.id, discussionNumber: current.number, mode: "compressedInline", revision, sha256: payload.jsonlSha256 };
  }

  const parts = splitText(payload.compressedBase64, commentPartLimit);
  const manifestParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const partBody = buildCompressedPartComment(index + 1, parts[index]);
    const comment = await addDiscussionComment(current.id, partBody);
    manifestParts.push({
      index: index + 1,
      commentId: comment.id,
      byteLength: Buffer.byteLength(parts[index], "utf8"),
      sha256: sha256(parts[index])
    });
  }
  if (currentManifest.storage.mode === "comments" || currentManifest.storage.mode === "compressedComments") {
    await addDiscussionComment(current.id, `<!-- bgt-dictionary-obsolete-parts revision=${currentManifest.storage.revision} -->\n\n旧分片已由 revision ${revision} 替代。`);
  }
  const manifest: OnlineDictionaryManifest = {
    schemaVersion: 1,
    storage: {
      mode: "compressedComments",
      revision,
      rowCount: payload.rowCount,
      sha256: payload.jsonlSha256,
      compression: compressedFormat,
      encoding: compressedEncoding,
      byteLength: payload.byteLength,
      compressedByteLength: payload.compressedByteLength,
      parts: manifestParts
    }
  };
  await updateDiscussion(current.id, options.title, buildDiscussionBody(table, options, manifest));
  return { url: current.url, discussionId: current.id, discussionNumber: current.number, mode: "compressedComments", revision, sha256: payload.jsonlSha256 };
}

export async function deleteOnlineDictionaryTable(sourceId: string, discussionId: string, project?: ProjectConfig): Promise<{ clearedLocalLinks: number }> {
  const source = await requireSource(sourceId);
  const viewer = await getViewerLogin();
  const node = discussionId.startsWith("web:")
    ? await loadDiscussionNodeByRepositoryNumber(source, Number(discussionId.slice("web:".length)))
    : await loadDiscussionNode(discussionId);
  const summary = parseDiscussionSummary(source.id, node);
  if (!summary) throw new Error("目标 discussion 不是 BrowserGameTranslator 在线词典表。");
  if ((node.author?.login ?? "").toLowerCase() !== viewer.toLowerCase()) throw new Error("只能删除自己的投稿。");
  await deleteDiscussion(node.id);
  const cleared = await clearDictionaryRemoteLinks({
    sourceId,
    discussionId: summary.discussionId,
    discussionNumber: summary.discussionNumber,
    url: summary.url
  }, project);
  return { clearedLocalLinks: cleared.updatedCount };
}

export async function exportOnlineDictionarySubmissionPackage(table: DictionaryTable, options: OnlineDictionarySubmissionOptions): Promise<OnlineDictionarySubmissionPackageResult | null> {
  const result = await dialog.showOpenDialog({
    title: "选择附件保存目录",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const directory = result.filePaths[0];
  await fs.mkdir(directory, { recursive: true });
  const jsonl = rowsToJsonl(table.rows);
  const attachmentName = attachmentFileBase(table);
  const gzipPath = path.join(directory, `${attachmentName}.jsonl.gz`);
  await fs.writeFile(gzipPath, await gzip(Buffer.from(jsonl, "utf8")));
  return { directory, gzipPath };
}

export function buildOnlineDictionaryInlineSubmission(table: DictionaryTable, options: OnlineDictionarySubmissionOptions): OnlineDictionaryInlineSubmissionResult {
  const payload = buildSubmissionPayload(table.rows);
  const revision = submissionRevision(table);
  if (payload.jsonl.length > inlineLimit && payload.compressedBase64.length > inlineLimit) {
    const parts = splitText(payload.compressedBase64, commentPartLimit);
    const comments = parts.map((part, index) => ({
      index: index + 1,
      body: buildCompressedPartComment(index + 1, part),
      byteLength: Buffer.byteLength(part, "utf8")
    }));
    const manifest: OnlineDictionaryManifest = {
      schemaVersion: 1,
      storage: {
        mode: "compressedComments",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256,
        compression: compressedFormat,
        encoding: compressedEncoding,
        byteLength: payload.byteLength,
        compressedByteLength: payload.compressedByteLength,
        parts: parts.map((part, index) => ({
          index: index + 1,
          commentId: `manual-part-${index + 1}`,
          byteLength: Buffer.byteLength(part, "utf8"),
          sha256: sha256(part)
        }))
      }
    };
    return {
      canInline: false,
      title: options.title,
      body: buildDiscussionBody(table, options, manifest),
      comments,
      rowCount: payload.rowCount,
      byteLength: payload.byteLength,
      limit: inlineLimit
    };
  }
  if (payload.jsonl.length > inlineLimit) {
    const manifest: OnlineDictionaryManifest = {
      schemaVersion: 1,
      storage: {
        mode: "compressedInline",
        revision,
        rowCount: payload.rowCount,
        sha256: payload.jsonlSha256,
        compression: compressedFormat,
        encoding: compressedEncoding,
        byteLength: payload.byteLength,
        compressedByteLength: payload.compressedByteLength
      }
    };
    return {
      canInline: true,
      title: options.title,
      body: buildDiscussionBody(table, options, manifest, undefined, payload.compressedBase64),
      rowCount: payload.rowCount,
      byteLength: payload.byteLength,
      limit: inlineLimit
    };
  }
  const manifest: OnlineDictionaryManifest = {
    schemaVersion: 1,
    storage: {
      mode: "inline",
      revision,
      rowCount: payload.rowCount,
      sha256: payload.jsonlSha256
    }
  };
  return {
    canInline: true,
    title: options.title,
    body: buildDiscussionBody(table, options, manifest, payload.jsonl),
    rowCount: manifest.storage.rowCount,
    byteLength: payload.byteLength,
    limit: inlineLimit
  };
}

function submissionRevision(table: DictionaryTable): number {
  const revision = table.meta.remote?.revision ?? 1;
  return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 1;
}

function remoteToLocalTable(remote: OnlineDictionaryTable): DictionaryTable {
  const now = new Date().toISOString();
  const id = remote.summary.meta.id.trim();
  return {
    meta: {
      schemaVersion: 1,
      kind: "bgt.resourceTable",
      id: id.startsWith("user.") ? id : `user.${id}`,
      tableType: remote.summary.meta.tableType,
      displayName: remote.summary.meta.displayName,
      description: [
        remote.summary.meta.description,
        `Imported from GitHub Discussions: ${remote.summary.url}`
      ].filter(Boolean).join("\n"),
      gameName: remote.summary.meta.gameName,
      sourceLanguage: remote.summary.meta.sourceLanguage,
      targetLanguage: remote.summary.meta.targetLanguage,
      createdAt: now,
      updatedAt: now,
      remote: remoteMeta(remote.summary)
    },
    rows: remote.rows
  };
}

function remoteMeta(summary: OnlineDictionarySummary): DictionaryTableRemote {
  const manifest = requireManifest(summary);
  return {
    sourceId: summary.sourceId,
    discussionId: summary.discussionId,
    discussionNumber: summary.discussionNumber,
    url: summary.url,
    revision: manifest.storage.revision,
    sha256: manifest.storage.sha256,
    updatedAt: summary.updatedAt
  };
}

function buildDiscussionBody(table: DictionaryTable, options: OnlineDictionarySubmissionOptions, manifest: OnlineDictionaryManifest, inlineJsonl?: string, inlineGzipBase64?: string): string {
  const now = new Date().toISOString();
  const meta: OnlineDictionaryMeta = {
    schemaVersion: 1,
    kind: "bgt.onlineDictionaryTable",
    id: table.meta.id.replace(/^user\./, ""),
    tableType: table.meta.tableType,
    displayName: table.meta.displayName,
    description: table.meta.description,
    sourceLanguage: options.sourceLanguage.trim(),
    targetLanguage: options.targetLanguage.trim(),
    gameName: options.gameDisplayName.trim() || table.meta.gameName.trim() || "Unknown Game",
    createdAt: now,
    updatedAt: now
  };
  return [
    options.introduction.trim() || `# ${table.meta.displayName}`,
    "",
    "<!-- bgt-dictionary-table -->",
    "",
    "<details>",
    "<summary>词典数据</summary>",
    "",
    "BGT-META-BEGIN",
    JSON.stringify(meta, null, 2),
    "BGT-META-END",
    "",
    "BGT-MANIFEST-BEGIN",
    JSON.stringify(manifest, null, 2),
    "BGT-MANIFEST-END",
    inlineJsonl ? ["", "BGT-JSONL-BEGIN", inlineJsonl.trimEnd(), "BGT-JSONL-END"].join("\n") : "",
    inlineGzipBase64 ? ["", "BGT-GZIP-BASE64-BEGIN", wrapBase64(inlineGzipBase64), "BGT-GZIP-BASE64-END"].join("\n") : "",
    "",
    "</details>"
  ].filter((part) => part !== "").join("\n");
}

function buildPartComment(index: number, jsonl: string): string {
  return [
    `<!-- bgt-dictionary-part index=${index} -->`,
    "",
    "<details>",
    `<summary>词典数据分片 ${index}</summary>`,
    "",
    `BGT-PART-INDEX: ${index}`,
    "",
    "BGT-JSONL-BEGIN",
    jsonl.trimEnd(),
    "BGT-JSONL-END",
    "",
    "</details>"
  ].join("\n");
}

function buildCompressedPartComment(index: number, gzipBase64Part: string): string {
  return [
    `<!-- bgt-dictionary-compressed-part index=${index} -->`,
    "",
    "<details>",
    `<summary>词典压缩数据分片 ${index}</summary>`,
    "",
    `BGT-PART-INDEX: ${index}`,
    "",
    "BGT-GZIP-BASE64-BEGIN",
    wrapBase64(gzipBase64Part),
    "BGT-GZIP-BASE64-END",
    "",
    "</details>"
  ].join("\n");
}

function wrapBase64(value: string): string {
  return wrapDiscussionBase64(value);
}

function buildSubmissionGuide(options: OnlineDictionarySubmissionOptions, bodyPath: string, jsonlPath: string, gzipPath: string, mode: "inline" | "attachment"): string {
  const lines = [
    "# BrowserGameTranslator 在线词典投稿说明",
    "",
    `目标源：${options.sourceId}`,
    `Discussion 标题：${options.title}`,
    "",
    "1. 打开目标 GitHub 仓库的 Discussions 页面。",
    "2. 进入 `词典` 分类。",
    "3. 新建 discussion。",
    `4. 将 \`${path.basename(bodyPath)}\` 的内容粘贴到正文。`
  ];
  if (mode === "attachment") {
    lines.push(
      `5. 将 \`${path.basename(gzipPath)}\` 上传到 discussion 正文或评论中。`,
      "6. 复制 GitHub 生成的附件 URL 或 Markdown 附件链接。",
      `7. 回到正文，把 \`${attachmentUrlPlaceholder}\` 替换为附件 URL；也可以不替换，占位符保留时将附件链接放在正文最后一行。`,
      `8. \`${path.basename(jsonlPath)}\` 是未压缩 JSONL，便于人工检查。`
    );
  }
  return `${lines.join("\n")}\n`;
}

function rowsToJsonl(rows: DictionaryTableRows): string {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  return body ? `${body}\n` : "";
}

type DictionarySubmissionPayload = {
  jsonl: string;
  rowCount: number;
  jsonlSha256: string;
  byteLength: number;
  compressedBase64: string;
  compressedByteLength: number;
};

function buildSubmissionPayload(rows: DictionaryTableRows): DictionarySubmissionPayload {
  const jsonl = rowsToJsonl(rows);
  const source = Buffer.from(jsonl, "utf8");
  const compressed = zlib.gzipSync(source);
  return {
    jsonl,
    rowCount: countJsonlRows(jsonl),
    jsonlSha256: sha256(jsonl),
    byteLength: source.byteLength,
    compressedBase64: compressed.toString(compressedEncoding),
    compressedByteLength: compressed.byteLength
  };
}

function splitJsonl(jsonl: string, maxLength: number): string[] {
  const lines = jsonl.split(/\r?\n/).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}${line}\n` : `${line}\n`;
    if (current && next.length > maxLength) {
      parts.push(current);
      current = `${line}\n`;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [""];
}

function splitText(value: string, maxLength: number): string[] {
  return splitDiscussionText(value, maxLength);
}

function countJsonlRows(jsonl: string): number {
  return jsonl.split(/\r?\n/).filter(Boolean).length;
}

function normalizeJsonlBlock(jsonl: string | null): string | null {
  if (jsonl === null) return null;
  const normalized = jsonl.replace(/\r\n/g, "\n");
  return normalized.trim() ? `${normalized.trimEnd()}\n` : "";
}

function normalizeBase64Block(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, "");
  return normalized.trim() ? normalized : "";
}

async function decodeGzipBase64Jsonl(value: string): Promise<string> {
  const decoded = Buffer.from(value, compressedEncoding);
  return (await gunzip(decoded)).toString("utf8");
}

async function readRemoteJsonl(summary: OnlineDictionarySummary, body: string, publicComments: string[] = [], attachmentUrls: string[] = []): Promise<string> {
  const storage = requireManifest(summary).storage;
  if (storage.mode === "inline") {
    const jsonl = normalizeJsonlBlock(extractMarkedBlock(body, "BGT-JSONL"));
    if (jsonl === null) throw new Error("inline 词典缺少 jsonl 内容。");
    verifyJsonl(jsonl, storage.sha256, storage.rowCount);
    return jsonl;
  }
  if (storage.mode === "comments") {
    const parts = [...storage.parts].sort((a, b) => a.index - b.index);
    const bodies = publicComments.length ? commentsByPartIndex(publicComments) : await loadDiscussionComments(parts.map((part) => part.commentId));
    const jsonlParts = parts.map((part) => {
      const commentBody = publicComments.length ? bodies.get(String(part.index)) : bodies.get(part.commentId);
      if (!commentBody) throw new Error(`找不到分片 comment：${part.commentId}`);
      const jsonl = normalizeJsonlBlock(extractMarkedBlock(commentBody, "BGT-JSONL"));
      if (jsonl === null) throw new Error(`分片 ${part.index} 缺少 jsonl 内容。`);
      verifyJsonl(jsonl, part.sha256, part.rowCount);
      return jsonl.trimEnd();
    });
    const merged = `${jsonlParts.join("\n")}\n`;
    verifyJsonl(merged, storage.sha256, storage.rowCount);
    return merged;
  }
  if (storage.mode === "compressedInline") {
    const encoded = normalizeBase64Block(extractMarkedBlock(body, "BGT-GZIP-BASE64"));
    if (encoded === null) throw new Error("压缩词典缺少 gzip base64 内容。");
    const jsonl = await decodeGzipBase64Jsonl(encoded);
    verifyJsonl(jsonl, storage.sha256, storage.rowCount);
    return jsonl;
  }
  if (storage.mode === "compressedComments") {
    const parts = [...storage.parts].sort((a, b) => a.index - b.index);
    const bodies = publicComments.length ? commentsByPartIndex(publicComments) : await loadDiscussionComments(parts.map((part) => part.commentId));
    const encodedParts = parts.map((part) => {
      const commentBody = publicComments.length ? bodies.get(String(part.index)) : bodies.get(part.commentId);
      if (!commentBody) throw new Error(`找不到压缩分片 comment：${part.commentId}`);
      const encoded = normalizeBase64Block(extractMarkedBlock(commentBody, "BGT-GZIP-BASE64"));
      if (encoded === null) throw new Error(`压缩分片 ${part.index} 缺少 gzip base64 内容。`);
      if (Buffer.byteLength(encoded, "utf8") !== part.byteLength) throw new Error(`压缩分片 ${part.index} 大小校验失败。`);
      if (normalizeHash(sha256(encoded)) !== normalizeHash(part.sha256)) throw new Error(`压缩分片 ${part.index} hash 校验失败。`);
      return encoded;
    });
    const jsonl = await decodeGzipBase64Jsonl(encodedParts.join(""));
    verifyJsonl(jsonl, storage.sha256, storage.rowCount);
    return jsonl;
  }
  const text = await downloadAttachmentTextWithFallback(storage.url, storage.fileName, storage.compression, [
    ...extractAttachmentUrlsFromLastLine(body),
    ...attachmentUrls
  ]);
  verifyJsonl(text, storage.sha256, storage.rowCount);
  return text;
}

async function downloadAttachmentTextWithFallback(url: string, fileName: string, compression: "none" | "gzip" | "zip", attachmentUrls: string[]): Promise<string> {
  const matchedAttachments = attachmentUrls.filter((candidate) => isAttachmentFileName(candidate, fileName));
  const fallbackAttachments = matchedAttachments.length ? matchedAttachments : attachmentUrls;
  const primaryUrl = url.trim() === attachmentUrlPlaceholder ? "" : url;
  const candidates = [primaryUrl, ...fallbackAttachments].filter((candidate, index, values) =>
    candidate && values.indexOf(candidate) === index
  );
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await downloadAttachmentText(candidate, compression);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("下载附件失败：找不到可用的 GitHub 附件链接。");
}

async function downloadAttachmentText(url: string, compression: "none" | "gzip" | "zip"): Promise<string> {
  const parsed = new URL(url);
  if (!isAllowedAttachmentUrl(parsed)) throw new Error("附件 URL 必须来自 GitHub user-attachments。");
  const token = (await loadToken()).trim();
  const headers: Record<string, string> = {
    Accept: "application/octet-stream,*/*",
    Referer: "https://github.com/"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchGitHub(url, {
    headers
  });
  if (!response.ok) throw new Error(`下载附件失败：HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (compression === "none") return data.toString("utf8");
  if (compression === "gzip") return (await gunzip(data)).toString("utf8");
  return extractZipText(data);
}

function isAttachmentFileName(url: string, fileName: string): boolean {
  try {
    const parsed = new URL(url);
    if (!isAllowedAttachmentUrl(parsed)) return false;
    return decodeURIComponent(parsed.pathname).split("/").pop() === fileName;
  } catch {
    return false;
  }
}

function isAllowedAttachmentUrl(parsed: URL): boolean {
  return isGitHubAttachmentUrl(parsed);
}

async function extractZipText(data: Buffer): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bgt-online-dict-"));
  const zipPath = path.join(root, "dictionary.zip");
  const outputRoot = path.join(root, "out");
  await fs.mkdir(outputRoot, { recursive: true });
  try {
    await fs.writeFile(zipPath, data);
    const binaryPath = getConfig().binaryPath;
    if (!binaryPath) throw new Error("没有找到 7-Zip 可执行文件，无法解压 zip 附件。");
    await run7zip(binaryPath, ["x", zipPath, `-o${outputRoot}`, "-y"], root);
    const files = await listFiles(outputRoot);
    const textFiles = files.filter((file) => /\.(jsonl|json|txt)$/i.test(file));
    if (textFiles.length !== 1) throw new Error("zip 附件中必须且只能包含一个 JSONL/JSON 文本文件。");
    return fs.readFile(textFiles[0], "utf8");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(filePath));
    else if (entry.isFile()) output.push(filePath);
  }
  return output;
}

function run7zip(binaryPath: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      reject(new Error(output || `7-zip exited with code ${code ?? "unknown"}.`));
    });
  });
}

function parseRows(jsonl: string, summary: OnlineDictionarySummary): DictionaryTableRows {
  const rows = jsonl.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const row of rows) validateRow(row, summary.meta.tableType);
  return rows as unknown as DictionaryTableRows;
}

async function listPublicOnlineDictionaryTables(source: OnlineDictionarySource, webSearchQuery = "", page = 1): Promise<OnlineDictionaryListResult> {
  const baseUrl = `https://github.com/${source.owner}/${source.repo}/discussions/categories/${encodeURIComponent(source.category)}`;
  const query = webSearchQuery.trim();
  const safePage = Math.max(1, Math.floor(page));
  const categoryUrl = buildDiscussionCategorySearchUrl(baseUrl, source.category, query, safePage);
  const html = await fetchText(categoryUrl);
  const dom = new JSDOM(html);
  const links = Array.from(dom.window.document.querySelectorAll("a.markdown-title[href]"))
    .map((link) => publicSummaryFromTitleLink(source, link))
    .filter((summary): summary is OnlineDictionarySummary => Boolean(summary));
  const byDiscussion = new Map<string, OnlineDictionarySummary>();
  for (const summary of links) byDiscussion.set(summary.discussionId, summary);
  const summaries = Array.from(byDiscussion.values());
  return {
    summaries,
    page: safePage,
    hasNextPage: hasEnabledPaginationLink(dom.window.document, "next"),
    hasPreviousPage: hasEnabledPaginationLink(dom.window.document, "previous")
  };
}

function hasEnabledPaginationLink(document: Document, direction: "next" | "previous"): boolean {
  const selectors = direction === "next"
    ? ["a.next_page[href]", "a[rel='next'][href]", "a[aria-label='Next Page'][href]"]
    : ["a.previous_page[href]", "a[rel='prev'][href]", "a[aria-label='Previous Page'][href]"];
  return selectors.some((selector) => {
    const link = document.querySelector(selector);
    if (!link) return false;
    const className = link.getAttribute("class") ?? "";
    const ariaDisabled = link.getAttribute("aria-disabled");
    return ariaDisabled !== "true" && !/\bdisabled\b/.test(className);
  });
}

function buildDiscussionCategorySearchUrl(baseUrl: string, category: string, query: string, page: number): string {
  const url = new URL(baseUrl);
  if (query.trim()) url.searchParams.set("discussions_q", `category:${category} ${query}`);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function publicSummaryFromTitleLink(source: OnlineDictionarySource, link: Element): OnlineDictionarySummary | null {
  const href = link.getAttribute("href") ?? "";
  const match = href.match(new RegExp(`^/${escapeRegExp(source.owner)}/${escapeRegExp(source.repo)}/discussions/(\\d+)$`, "i"));
  if (!match) return null;
  const number = Number(match[1]);
  const title = (link.textContent ?? "").trim();
  const parsed = parseDiscussionTitle(title);
  if (!Number.isFinite(number) || !parsed) return null;
  const row = link.closest("li") ?? link.parentElement;
  const now = new Date().toISOString();
  const publishedAt = row?.querySelector("relative-time")?.getAttribute("datetime") ?? now;
  const author = findPublicDiscussionAuthor(row) ?? "unknown";
  return {
    sourceId: source.id,
    discussionId: `web:${number}`,
    discussionNumber: number,
    url: `https://github.com/${source.owner}/${source.repo}/discussions/${number}`,
    title,
    author,
    updatedAt: publishedAt,
    introduction: "",
    meta: {
      schemaVersion: 1,
      kind: "bgt.onlineDictionaryTable",
      id: `remote.${number}`,
      tableType: parsed.tableType,
      displayName: parsed.displayName,
      description: "",
      gameName: parsed.gameName,
      sourceLanguage: parsed.sourceLanguage,
      targetLanguage: parsed.targetLanguage,
      createdAt: now,
      updatedAt: now
    }
  };
}

function findPublicDiscussionAuthor(row: Element | null | undefined): string | null {
  if (!row) return null;
  const labelledAuthor = row.querySelector("a[aria-label$='(author)']")?.textContent?.trim();
  if (labelledAuthor) return labelledAuthor;
  const classAuthor = row.querySelector(".author")?.textContent?.trim();
  if (classAuthor) return classAuthor;
  const userLink = Array.from(row.querySelectorAll("a[href^='/']")).find((link) => {
    const href = link.getAttribute("href") ?? "";
    return /^\/[^/]+$/.test(href) && Boolean(link.textContent?.trim());
  });
  return userLink?.textContent?.trim() ?? null;
}

function parseDiscussionTitle(title: string): Pick<OnlineDictionaryMeta, "gameName" | "sourceLanguage" | "targetLanguage" | "tableType" | "displayName"> | null {
  const match = title.match(/^\[(?<game>[^\]]+)\]\[(?<source>[^\]-]+)->(?<target>[^\]]+)\]\[(?<type>[^\]]+)\]\s*(?<name>.+)$/u);
  const groups = match?.groups;
  if (!groups) return null;
  const tableType = tableTypeFromLabel(groups.type);
  if (!tableType) return null;
  return {
    gameName: groups.game.trim(),
    sourceLanguage: groups.source.trim().replace(/_/g, "-"),
    targetLanguage: groups.target.trim().replace(/_/g, "-"),
    tableType,
    displayName: groups.name.trim() || title
  };
}

function tableTypeFromLabel(label: string): OnlineDictionaryMeta["tableType"] | null {
  const trimmed = label.trim();
  return (Object.entries(tableTypeLabels).find(([, value]) => value === trimmed)?.[0] as OnlineDictionaryMeta["tableType"] | undefined) ?? null;
}

async function loadPublicDiscussionNode(source: OnlineDictionarySource, number: number): Promise<GitHubDiscussionNode> {
  const url = `https://github.com/${source.owner}/${source.repo}/discussions/${number}`;
  const html = await fetchText(url);
  const dom = new JSDOM(html);
  const title =
    dom.window.document.querySelector("bdi.js-issue-title")?.textContent?.trim() ||
    dom.window.document.querySelector("title")?.textContent?.replace("· Discussion", "").trim() ||
    `Discussion ${number}`;
  const markdownBodies = Array.from(dom.window.document.querySelectorAll(".markdown-body"));
  const body = markdownBodies[0] ? markdownBodyToPseudoMarkdown(markdownBodies[0]) : "";
  const introductionHtml = markdownBodies[0] ? extractPublicIntroductionHtml(markdownBodies[0]) : "";
  const attachmentUrls = markdownBodies[0] ? extractAttachmentUrls(markdownBodies[0]) : [];
  const publicComments = markdownBodies.slice(1).map(markdownBodyToPseudoMarkdown);
  const updatedAt = dom.window.document.querySelector("relative-time")?.getAttribute("datetime") || new Date().toISOString();
  const author = dom.window.document.querySelector(".author")?.textContent?.trim() || "unknown";
  return {
    id: `web:${number}`,
    number,
    title,
    url,
    body,
    updatedAt,
    author: { login: author },
    publicComments,
    introductionHtml,
    attachmentUrls
  };
}

function extractAttachmentUrls(element: Element): string[] {
  const urls = Array.from(element.querySelectorAll("a[href]"))
    .map((link) => link.getAttribute("href") ?? "")
    .map((href) => {
      try {
        return new URL(href, "https://github.com").toString();
      } catch {
        return "";
      }
    })
    .filter((href) => {
      try {
        return isAllowedAttachmentUrl(new URL(href));
      } catch {
        return false;
      }
    });
  return Array.from(new Set(urls));
}

function extractAttachmentUrlsFromLastLine(body: string): string[] {
  const lastLine = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (!lastLine) return [];
  const candidates = [
    ...Array.from(lastLine.matchAll(/\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)).map((match) => match[1]),
    ...Array.from(lastLine.matchAll(/https:\/\/[^\s)]+/g)).map((match) => match[0])
  ].map((url) => url.replace(/[，。；,.;]+$/u, ""));
  return Array.from(new Set(candidates.filter((url) => {
    try {
      return isAllowedAttachmentUrl(new URL(url));
    } catch {
      return false;
    }
  })));
}

function extractAttachmentUrlsFromHtml(html: string | undefined): string[] {
  if (!html) return [];
  const dom = new JSDOM(`<main>${html}</main>`);
  return extractAttachmentUrls(dom.window.document.querySelector("main")!);
}

function extractPublicIntroductionHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  const machineBlock = Array.from(clone.querySelectorAll("details, pre, p, div, table, ul, ol, blockquote")).find((entry) =>
    containsMachineMarker(entry.textContent ?? "")
  );
  const stopNode = machineBlock?.closest("details") ?? machineBlock;
  if (stopNode?.parentNode) {
    let current: ChildNode | null = stopNode;
    while (current) {
      const next: ChildNode | null = current.nextSibling;
      current.parentNode?.removeChild(current);
      current = next;
    }
  }
  sanitizePublicHtml(clone);
  return clone.innerHTML.trim();
}

function sanitizePublicHtml(root: Element): void {
  root.querySelectorAll("script, style, template, iframe, object, embed").forEach((node) => node.remove());
  root.querySelectorAll("*").forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && value.startsWith("javascript:")) element.removeAttribute(attr.name);
    }
  });
}

function markdownBodyToPseudoMarkdown(element: Element): string {
  const text = (element.textContent ?? "").trim();
  const comments = collectHtmlComments(element).join("\n");
  const partMatch = comments.match(/bgt-dictionary-part\s+index=(\d+)/i) || text.match(/BGT-PART-INDEX:\s*(\d+)/i);
  if (partMatch) return [`<!-- bgt-dictionary-part index=${partMatch[1]} -->`, "", text].join("\n");
  if (comments.includes("bgt-dictionary-table") || text.includes("BGT-META-BEGIN") || text.includes("BGT-MANIFEST-BEGIN")) {
    const markerIndex = firstMachineMarkerIndex(text);
    if (markerIndex > 0) {
      const introduction = text.slice(0, markerIndex).replace(/\s*词典数据\s*$/u, "").trim();
      const machineText = text.slice(markerIndex).trim();
      return [introduction, "", "<!-- bgt-dictionary-table -->", "", machineText].filter(Boolean).join("\n");
    }
    return ["<!-- bgt-dictionary-table -->", "", text].join("\n");
  }
  return text;
}

function firstMachineMarkerIndex(text: string): number {
  return machineMarkers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
}

const machineMarkers = ["BGT-META-BEGIN", "BGT-MANIFEST-BEGIN", "BGT-JSONL-BEGIN", "BGT-GZIP-BASE64-BEGIN"];

function containsMachineMarker(text: string): boolean {
  return machineMarkers.some((marker) => text.includes(marker));
}

function collectHtmlComments(element: Element): string[] {
  const comments: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, 128);
  let node = walker.nextNode();
  while (node) {
    comments.push(node.nodeValue ?? "");
    node = walker.nextNode();
  }
  return comments;
}

function commentsByPartIndex(comments: string[]): Map<string, string> {
  return discussionCommentsByPartIndex(comments, "bgt-dictionary");
}

function buildGraphqlDiscussionSearchQuery(source: OnlineDictionarySource, webSearchQuery: string, author: string): string {
  return [
    `repo:${source.owner}/${source.repo}`,
    `category:${quoteSearchToken(source.category)}`,
    author ? `author:${author}` : "",
    webSearchQuery.trim()
  ].filter(Boolean).join(" ");
}

function quoteSearchToken(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function isDiscussionNode(node: unknown): node is GitHubDiscussionNode {
  return isGitHubDiscussionNode(node);
}

async function fetchText(url: string): Promise<string> {
  return fetchGitHubText(url);
}

async function fetchGitHub(url: string, init?: Parameters<typeof net.fetch>[1]): Promise<Response> {
  return fetchGitHubRequest(url, init);
}

function validateRow(row: Record<string, unknown>, tableType: OnlineDictionaryMeta["tableType"]): void {
  if (typeof row.id !== "string") throw new Error("词典行缺少 id。");
  if (typeof row.enabled !== "boolean") throw new Error("词典行缺少 enabled。");
  if (tableType === "characters") {
    if (typeof row.source !== "string" || typeof row.target !== "string") throw new Error("人物表行缺少 source/target。");
    return;
  }
  if (tableType === "glossary") {
    if (typeof row.source !== "string" || typeof row.target !== "string" || typeof row.isRegex !== "boolean") throw new Error("术语表行字段不完整。");
    return;
  }
  if (typeof row.marker !== "string" || typeof row.isRegex !== "boolean") throw new Error("禁翻表行字段不完整。");
}

function verifyJsonl(jsonl: string, expectedHash: string, expectedRows: number): void {
  const rowCount = jsonl.split(/\r?\n/).filter(Boolean).length;
  if (rowCount !== expectedRows) throw new Error(`远程词典行数校验失败：期望 ${expectedRows}，实际 ${rowCount}。`);
  if (normalizeHash(sha256(jsonl)) !== normalizeHash(expectedHash)) throw new Error("远程词典 hash 校验失败。");
}

function sha256(value: string): string {
  return discussionSha256(value);
}

function normalizeHash(value: string): string {
  return normalizeDiscussionHash(value);
}

function parseDiscussionSummary(sourceId: string, node: GitHubDiscussionNode): OnlineDictionarySummary | null {
  if (!node.body.includes("bgt-dictionary-table")) return null;
  const meta = parseJsonMarkedBlock<OnlineDictionaryMeta>(node.body, "BGT-META");
  const manifest = parseJsonMarkedBlock<OnlineDictionaryManifest>(node.body, "BGT-MANIFEST");
  if (!meta || !manifest) return null;
  validateMeta(meta);
  validateManifest(manifest);
  return {
    sourceId,
    discussionId: node.id,
    discussionNumber: node.number,
    url: node.url,
    title: node.title,
    author: node.author?.login ?? "unknown",
    updatedAt: node.updatedAt,
    introduction: extractDiscussionIntroduction(node.body),
    introductionHtml: node.introductionHtml,
    meta,
    manifest
  };
}

function requireManifest(summary: OnlineDictionarySummary): OnlineDictionaryManifest {
  if (!summary.manifest) throw new Error("远程词典缺少 manifest。");
  return summary.manifest;
}

function extractDiscussionIntroduction(body: string): string {
  const markerIndex = body.indexOf("<!-- bgt-dictionary-table -->");
  if (markerIndex < 0) return "";
  return body.slice(0, markerIndex).trim();
}

function validateMeta(meta: OnlineDictionaryMeta): void {
  if (meta.schemaVersion !== 1 || meta.kind !== "bgt.onlineDictionaryTable") throw new Error("在线词典 meta 格式不支持。");
  if (!["characters", "glossary", "noTranslate"].includes(meta.tableType)) throw new Error("在线词典表类型不支持。");
  if (!meta.id.trim() || !meta.displayName.trim()) throw new Error("在线词典 meta 缺少 ID 或名称。");
  if (!meta.gameName.trim()) throw new Error("在线词典 meta 缺少游戏名称。");
}

function validateManifest(manifest: OnlineDictionaryManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("在线词典 manifest 版本不支持。");
  const storage = manifest.storage;
  if (!Number.isFinite(storage.revision) || storage.revision < 1) throw new Error("在线词典 revision 无效。");
  if (!Number.isFinite(storage.rowCount) || storage.rowCount < 0) throw new Error("在线词典 rowCount 无效。");
  if (!storage.sha256.trim()) throw new Error("在线词典缺少 sha256。");
  if (storage.mode === "comments") {
    if (!storage.parts.length) throw new Error("分片词典缺少 parts。");
    for (const part of storage.parts) {
      if (!Number.isFinite(part.index) || !part.commentId || !Number.isFinite(part.rowCount) || !part.sha256) throw new Error("分片 manifest 不完整。");
    }
  }
  if (storage.mode === "compressedInline") {
    if (storage.compression !== compressedFormat || storage.encoding !== compressedEncoding) throw new Error("压缩词典格式不支持。");
    if (!Number.isFinite(storage.byteLength) || storage.byteLength < 0 || !Number.isFinite(storage.compressedByteLength) || storage.compressedByteLength < 0) {
      throw new Error("压缩词典 manifest 不完整。");
    }
  }
  if (storage.mode === "compressedComments") {
    if (storage.compression !== compressedFormat || storage.encoding !== compressedEncoding) throw new Error("压缩分片词典格式不支持。");
    if (!Number.isFinite(storage.byteLength) || storage.byteLength < 0 || !Number.isFinite(storage.compressedByteLength) || storage.compressedByteLength < 0) {
      throw new Error("压缩分片词典 manifest 不完整。");
    }
    if (!storage.parts.length) throw new Error("压缩分片词典缺少 parts。");
    for (const part of storage.parts) {
      if (!Number.isFinite(part.index) || !part.commentId || !Number.isFinite(part.byteLength) || !part.sha256) throw new Error("压缩分片 manifest 不完整。");
    }
  }
  if (storage.mode === "attachment") {
    if (!storage.url || !storage.fileName || !["none", "gzip", "zip"].includes(storage.compression)) throw new Error("附件 manifest 不完整。");
  }
}

function parseJsonMarkedBlock<T>(body: string, marker: string): T | null {
  return parseDiscussionJsonMarkedBlock<T>(body, marker);
}

function extractMarkedBlock(body: string, marker: string): string | null {
  return extractDiscussionMarkedBlock(body, marker);
}

async function loadDiscussionNode(discussionId: string): Promise<GitHubDiscussionNode> {
  return githubDiscussions.loadDiscussionNode(discussionId);
}

async function loadDiscussionNodeByRepositoryNumber(source: OnlineDictionarySource, number: number): Promise<GitHubDiscussionNode> {
  return githubDiscussions.loadDiscussionNodeByRepositoryNumber(source, number);
}

async function loadDiscussionComments(ids: string[]): Promise<Map<string, string>> {
  return githubDiscussions.loadDiscussionComments(ids);
}

async function findCategoryId(source: OnlineDictionarySource): Promise<string> {
  return githubDiscussions.findCategoryId(source);
}

async function loadRepositoryPublishInfo(source: OnlineDictionarySource): Promise<{ repositoryId: string; categoryId: string }> {
  return githubDiscussions.loadRepositoryPublishInfo(source);
}

async function assertNoRemoteConflict(source: OnlineDictionarySource, tableId: string, title: string): Promise<void> {
  const existing = (await listOnlineDictionaryTables(source.id)).summaries;
  const idConflict = existing.find((item) => item.meta.id === tableId);
  if (idConflict) throw new Error(`远程词典已存在同 ID 表：${idConflict.meta.displayName}`);
  const titleConflict = existing.find((item) => item.title.trim() === title.trim());
  if (titleConflict) throw new Error(`远程词典已存在同标题 discussion：${titleConflict.title}`);
}

async function createDiscussion(repositoryId: string, categoryId: string, title: string, body: string): Promise<{ id: string; number: number; url: string }> {
  return githubDiscussions.createDiscussion(repositoryId, categoryId, title, body);
}

async function addDiscussionComment(discussionId: string, body: string): Promise<{ id: string }> {
  return githubDiscussions.addDiscussionComment(discussionId, body);
}

async function updateDiscussion(discussionId: string, title: string, body: string): Promise<void> {
  await githubDiscussions.updateDiscussion(discussionId, title, body);
}

async function deleteDiscussion(discussionId: string): Promise<void> {
  await githubDiscussions.deleteDiscussion(discussionId);
}

async function getViewerLogin(): Promise<string> {
  return githubDiscussions.getViewerLogin();
}

async function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return githubDiscussions.githubGraphql<T>(query, variables);
}

async function githubGraphqlWithToken<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return githubDiscussions.githubGraphqlWithToken<T>(query, variables);
}

async function loadToken(): Promise<string> {
  return githubDiscussions.loadToken();
}

async function loadStoredToken(): Promise<string> {
  return githubDiscussions.loadStoredToken();
}

async function shouldUseToken(): Promise<boolean> {
  return githubDiscussions.shouldUseToken();
}

async function requireSource(sourceId: string): Promise<OnlineDictionarySource> {
  return githubDiscussions.requireSource(sourceId);
}

function normalizeSource(source: OnlineDictionarySource): OnlineDictionarySource {
  return githubDiscussions.normalizeSource(source);
}

function normalizeSources(sources: OnlineDictionarySource[]): OnlineDictionarySource[] {
  return githubDiscussions.normalizeSources(sources);
}

function sanitizeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || `dictionary_${Date.now()}`;
}

function attachmentFileBase(table: DictionaryTable): string {
  const hash = crypto.createHash("sha1").update(`${table.meta.id}\n${table.meta.displayName}`, "utf8").digest("hex").slice(0, 10);
  const id = table.meta.id.replace(/^user\./, "").trim();
  const cleanId = cleanAttachmentName(id);
  const titleLikeId = /^\[[^\]]+\]\[[^\]]+\]\[[^\]]+\]/.test(id) || id.includes("][");
  if (cleanId && cleanId.length <= 72 && !titleLikeId) return cleanId;

  const displayName = cleanAttachmentName(table.meta.displayName);
  if (displayName) return `${displayName.slice(0, 56)}-${hash}`;
  return `dictionary-${hash}`;
}

function cleanAttachmentName(value: string): string {
  return sanitizeFileName(value)
    .replace(/^\[[^\]]+\]\[[^\]]+\]\[[^\]]+\]\s*/, "")
    .replace(/[\[\]]/g, "_")
    .replace(/[_ .-]+/g, "_")
    .replace(/^[_ .-]+/, "")
    .replace(/[_ .-]+$/g, "")
    .slice(0, 72);
}

function parseDiscussionNumber(value: string): number {
  return parseGitHubDiscussionNumber(value);
}

function parseGitHubDiscussionUrl(value: string): { owner: string; repo: string; number: number } {
  return parseGitHubDiscussionLink(value);
}

function escapeRegExp(value: string): string {
  return escapeGitHubRegExp(value);
}

export function parseGitHubRepositoryUrl(url: string): { owner: string; repo: string } {
  return parseGitHubRepositoryLink(url);
}
