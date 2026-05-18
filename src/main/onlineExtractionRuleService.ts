import zlib from "node:zlib";
import { promisify } from "node:util";
import {
  ExtractionRulePackage,
  OnlineExtractionRuleListResult,
  OnlineExtractionRuleEncodedCommentPart,
  OnlineExtractionRuleInlineSubmissionResult,
  OnlineExtractionRuleManifest,
  OnlineExtractionRuleMeta,
  OnlineExtractionRulePackage,
  OnlineExtractionRuleSettings,
  OnlineExtractionRuleSource,
  OnlineExtractionRuleSubmissionOptions,
  OnlineExtractionRuleSummary,
  ProjectConfig
} from "../shared/types";
import {
  createGitHubDiscussionStore,
  commentsByPartIndex,
  extractMarkedBlock,
  GitHubDiscussionNode,
  normalizeHash,
  parseJsonMarkedBlock,
  sha256,
  splitText,
  wrapBase64
} from "./githubDiscussionStore";
import { clearExtractionRulePackageUpdateUrls, validateExtractionRulePackage } from "./extractionRulePackageService";
import { listOnlineDictionarySources, saveOnlineDictionarySources } from "./onlineDictionaryService";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const inlineLimit = 50000;
const commentPartLimit = 50000;
const compressedEncoding = "base64" as const;
const compressedFormat = "gzip" as const;
const extractionRuleDefaultCategory = "提取规则";

const defaultSource: OnlineExtractionRuleSource = {
  id: "official",
  displayName: "默认源",
  url: "https://github.com/Heptagon196/BrowserGameTranslator",
  owner: "Heptagon196",
  repo: "BrowserGameTranslator",
  dictionaryCategory: "词典",
  extractionRuleCategory: extractionRuleDefaultCategory,
  enabled: true,
  readonly: true
};

type OnlineExtractionRuleDiscussionSource = OnlineExtractionRuleSource & { discussionCategory: string };

const discussions = createGitHubDiscussionStore<OnlineExtractionRuleDiscussionSource>({
  settingsFileName: "online-dictionaries.json",
  tokenFileName: "online-dictionary-secrets.json",
  defaultSource: toExtractionRuleDiscussionSource(defaultSource),
  defaultCategory: extractionRuleDefaultCategory,
  tokenRequiredMessage: "自动上传提取规则需要 GitHub API Token。",
  publicConnectionMessage: (source) => `已连接公开分类 ${source.owner}/${source.repo}/${source.discussionCategory}。未使用 GitHub API Token。`,
  tokenConnectionMessage: (source, categoryId) => `已连接 ${source.owner}/${source.repo}，找到分类 ${source.discussionCategory}。${categoryId}`
});

export const listOnlineExtractionRuleSources = async (): Promise<OnlineExtractionRuleSettings> => {
  const settings = await listOnlineDictionarySources();
  return { schemaVersion: 1, sources: settings.sources, useToken: settings.useToken };
};
export const saveOnlineExtractionRuleSources = async (settings: OnlineExtractionRuleSettings): Promise<OnlineExtractionRuleSettings> => {
  const saved = await saveOnlineDictionarySources({ schemaVersion: 1, sources: settings.sources, useToken: settings.useToken });
  return { schemaVersion: 1, sources: saved.sources, useToken: saved.useToken };
};
export const getOnlineExtractionRuleTokenStatus = () => discussions.getTokenStatus();
export const saveOnlineExtractionRuleToken = (token: string) => discussions.saveToken(token);
export const testOnlineExtractionRuleSource = async (sourceId: string) => {
  try {
    const source = await requireSource(sourceId);
    const categoryId = await discussions.findCategoryId(source);
    return { ok: true, message: `已连接 ${source.owner}/${source.repo}，找到分类 ${source.discussionCategory}。${categoryId}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

export async function listOnlineExtractionRulePackages(sourceId: string, query = "", page = 1, mineOnly = false): Promise<OnlineExtractionRuleListResult> {
  const source = await requireSource(sourceId);
  const result = await discussions.searchDiscussionNodes(source, query, page, mineOnly);
  return {
    summaries: result.nodes.map((node) => parseSummary(source.id, node)).filter((summary): summary is OnlineExtractionRuleSummary => Boolean(summary)),
    page: result.page,
    hasNextPage: result.hasNextPage,
    hasPreviousPage: result.hasPreviousPage
  };
}

export async function loadOnlineExtractionRulePackage(sourceId: string, discussionId: string): Promise<OnlineExtractionRulePackage> {
  const node = discussionId.startsWith("web:")
    ? await discussions.loadDiscussionNodeByRepositoryNumber(await requireSource(sourceId), Number(discussionId.slice("web:".length)))
    : await discussions.loadDiscussionNode(discussionId);
  const summary = parseSummary(sourceId, node);
  if (!summary?.manifest) throw new Error("目标 discussion 不是 BrowserGameTranslator 在线提取规则包。");
  const pkg = await readPackageFromNode(summary, node);
  return { summary, package: pkg };
}

export async function importOnlineExtractionRulePackage(sourceId: string, discussionId: string): Promise<ExtractionRulePackage> {
  const online = await loadOnlineExtractionRulePackage(sourceId, discussionId);
  return {
    ...online.package,
    sourceKind: "online",
    readonly: false,
    updateUrl: {
      sourceId,
      discussionId: online.summary.discussionId,
      discussionNumber: online.summary.discussionNumber,
      url: online.summary.url,
      revision: online.summary.manifest?.storage.revision ?? 1,
      sha256: online.summary.manifest?.storage.sha256 ?? "",
      updatedAt: online.summary.updatedAt
    }
  };
}

export async function deleteOnlineExtractionRulePackage(sourceId: string, discussionId: string, project?: ProjectConfig): Promise<{ clearedLocalLinks: number }> {
  const source = await requireSource(sourceId);
  const viewer = await discussions.getViewerLogin();
  const node = discussionId.startsWith("web:")
    ? await discussions.loadDiscussionNodeByRepositoryNumber(source, Number(discussionId.slice("web:".length)))
    : await discussions.loadDiscussionNode(discussionId);
  const summary = parseSummary(source.id, node);
  if (!summary) throw new Error("目标 discussion 不是 BrowserGameTranslator 在线提取规则包。");
  if ((node.author?.login ?? "").toLowerCase() !== viewer.toLowerCase()) throw new Error("只能删除自己的投稿。");
  await discussions.deleteDiscussion(node.id);
  const cleared = await clearExtractionRulePackageUpdateUrls({
    sourceId,
    discussionId: summary.discussionId,
    discussionNumber: summary.discussionNumber,
    url: summary.url
  }, project);
  return { clearedLocalLinks: cleared.updatedCount };
}

export async function publishOnlineExtractionRulePackage(pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions) {
  validateExtractionRulePackage(pkg);
  const source = await requireSource(options.sourceId);
  const { repositoryId, categoryId } = await discussions.loadRepositoryPublishInfo(source);
  const payload = await buildSubmissionPayload(pkg);
  const revision = 1;
  const title = buildRulePackageDiscussionTitle(pkg);
  if (payload.json.length <= inlineLimit) {
    const manifest = buildManifest(payload, revision, "inline");
    const created = await discussions.createDiscussion(repositoryId, categoryId, title, buildDiscussionBody(pkg, options, manifest, payload.json));
    return { ...created, revision, sha256: payload.jsonSha256, mode: "inline" };
  }
  if (payload.compressedBase64.length <= inlineLimit) {
    const manifest = buildManifest(payload, revision, "compressedInline");
    const created = await discussions.createDiscussion(repositoryId, categoryId, title, buildDiscussionBody(pkg, options, manifest, undefined, payload.compressedBase64));
    return { ...created, revision, sha256: payload.jsonSha256, mode: "compressedInline" };
  }
  const placeholderManifest = buildManifest(payload, revision, "compressedComments", []);
  const created = await discussions.createDiscussion(repositoryId, categoryId, title, buildDiscussionBody(pkg, options, placeholderManifest));
  const parts = splitText(payload.compressedBase64, commentPartLimit);
  const manifestParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const partBody = buildCompressedPartComment(index + 1, parts[index]);
    const comment = await discussions.addDiscussionComment(created.id, partBody);
    manifestParts.push({
      index: index + 1,
      commentId: comment.id,
      byteLength: Buffer.byteLength(parts[index], "utf8"),
      sha256: sha256(parts[index])
    });
  }
  const manifest = buildManifest(payload, revision, "compressedComments", manifestParts);
  await discussions.updateDiscussion(created.id, title, buildDiscussionBody(pkg, options, manifest));
  return { ...created, revision, sha256: payload.jsonSha256, mode: "compressedComments" };
}

export async function buildOnlineExtractionRuleInlineSubmission(pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions): Promise<OnlineExtractionRuleInlineSubmissionResult> {
  validateExtractionRulePackage(pkg);
  const payload = await buildSubmissionPayload(pkg);
  const revision = submissionRevision(pkg);
  const title = buildRulePackageDiscussionTitle(pkg);
  if (payload.json.length > inlineLimit && payload.compressedBase64.length > inlineLimit) {
    const parts = splitText(payload.compressedBase64, commentPartLimit);
    const comments = parts.map((part, index) => ({
      index: index + 1,
      body: buildCompressedPartComment(index + 1, part),
      byteLength: Buffer.byteLength(part, "utf8")
    }));
    const manifest = buildManifest(payload, revision, "compressedComments", parts.map((part, index) => ({
      index: index + 1,
      commentId: `manual-part-${index + 1}`,
      byteLength: Buffer.byteLength(part, "utf8"),
      sha256: sha256(part)
    })));
    return {
      canInline: false,
      title,
      body: buildDiscussionBody(pkg, options, manifest),
      comments,
      ruleCount: pkg.rules.length,
      byteLength: payload.byteLength,
      limit: inlineLimit,
      mode: "compressedComments"
    };
  }
  if (payload.json.length > inlineLimit) {
    const manifest = buildManifest(payload, revision, "compressedInline");
    return {
      canInline: true,
      title,
      body: buildDiscussionBody(pkg, options, manifest, undefined, payload.compressedBase64),
      ruleCount: pkg.rules.length,
      byteLength: payload.byteLength,
      limit: inlineLimit,
      mode: "compressedInline"
    };
  }
  const manifest = buildManifest(payload, revision, "inline");
  return {
    canInline: true,
    title,
    body: buildDiscussionBody(pkg, options, manifest, payload.json),
    ruleCount: pkg.rules.length,
    byteLength: payload.byteLength,
    limit: inlineLimit,
    mode: "inline"
  };
}

export async function updateOnlineExtractionRulePackage(pkg: ExtractionRulePackage, options: OnlineExtractionRuleSubmissionOptions & { discussionId: string; expectedRevision?: number }) {
  validateExtractionRulePackage(pkg);
  const source = await requireSource(options.sourceId);
  const current = options.discussionId.startsWith("web:")
    ? await discussions.loadDiscussionNodeByRepositoryNumber(source, Number(options.discussionId.slice("web:".length)))
    : await discussions.loadDiscussionNode(options.discussionId);
  const summary = parseSummary(options.sourceId, current);
  const revision = (summary?.manifest?.storage.revision ?? 0) + 1;
  if (options.expectedRevision && summary?.manifest?.storage.revision !== options.expectedRevision) throw new Error("远程规则包已更新，请先刷新后再提交。");
  const payload = await buildSubmissionPayload(pkg);
  const title = buildRulePackageDiscussionTitle(pkg);
  if (payload.json.length <= inlineLimit) {
    const manifest = buildManifest(payload, revision, "inline");
    await discussions.updateDiscussion(current.id, title, buildDiscussionBody(pkg, options, manifest, payload.json));
    return { url: current.url, discussionId: current.id, discussionNumber: current.number, revision, sha256: payload.jsonSha256, mode: "inline" };
  }
  if (payload.compressedBase64.length <= inlineLimit) {
    const manifest = buildManifest(payload, revision, "compressedInline");
    await discussions.updateDiscussion(current.id, title, buildDiscussionBody(pkg, options, manifest, undefined, payload.compressedBase64));
    return { url: current.url, discussionId: current.id, discussionNumber: current.number, revision, sha256: payload.jsonSha256, mode: "compressedInline" };
  }
  const parts = splitText(payload.compressedBase64, commentPartLimit);
  const manifestParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const partBody = buildCompressedPartComment(index + 1, parts[index]);
    const comment = await discussions.addDiscussionComment(current.id, partBody);
    manifestParts.push({
      index: index + 1,
      commentId: comment.id,
      byteLength: Buffer.byteLength(parts[index], "utf8"),
      sha256: sha256(parts[index])
    });
  }
  if (summary?.manifest?.storage.mode === "comments" || summary?.manifest?.storage.mode === "compressedComments") {
    await discussions.addDiscussionComment(current.id, `<!-- bgt-extraction-rule-obsolete-parts revision=${summary.manifest.storage.revision} -->\n\n旧分片已由 revision ${revision} 替代。`);
  }
  const manifest = buildManifest(payload, revision, "compressedComments", manifestParts);
  await discussions.updateDiscussion(current.id, title, buildDiscussionBody(pkg, options, manifest));
  return { url: current.url, discussionId: current.id, discussionNumber: current.number, revision, sha256: payload.jsonSha256, mode: "compressedComments" };
}

async function requireSource(sourceId: string): Promise<OnlineExtractionRuleDiscussionSource> {
  const settings = await listOnlineExtractionRuleSources();
  const source = settings.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error("找不到在线仓库。");
  return toExtractionRuleDiscussionSource(source);
}

function toExtractionRuleDiscussionSource(source: OnlineExtractionRuleSource): OnlineExtractionRuleDiscussionSource {
  return { ...source, discussionCategory: (source.extractionRuleCategory ?? "").trim() || extractionRuleDefaultCategory };
}

type RuleSubmissionPayload = {
  json: string;
  jsonSha256: string;
  compressedBase64: string;
  byteLength: number;
  compressedByteLength: number;
};

async function buildSubmissionPayload(pkg: ExtractionRulePackage): Promise<RuleSubmissionPayload> {
  const json = JSON.stringify(pkg, null, 2);
  const compressed = await gzip(Buffer.from(json, "utf8"));
  return {
    json,
    jsonSha256: sha256(json),
    compressedBase64: compressed.toString(compressedEncoding),
    byteLength: Buffer.byteLength(json, "utf8"),
    compressedByteLength: compressed.byteLength
  };
}

function buildManifest(
  payload: RuleSubmissionPayload,
  revision: number,
  mode: "inline" | "compressedInline" | "compressedComments",
  parts: OnlineExtractionRuleEncodedCommentPart[] = []
): OnlineExtractionRuleManifest {
  if (mode === "inline") {
    return {
      schemaVersion: 1,
      storage: {
        mode,
        revision,
        ruleCount: JSON.parse(payload.json).rules.length,
        sha256: payload.jsonSha256
      }
    };
  }
  if (mode === "compressedInline") {
    return {
      schemaVersion: 1,
      storage: {
        mode,
        revision,
        ruleCount: JSON.parse(payload.json).rules.length,
        sha256: payload.jsonSha256,
        compression: compressedFormat,
        encoding: compressedEncoding,
        byteLength: payload.byteLength,
        compressedByteLength: payload.compressedByteLength
      }
    };
  }
  return {
    schemaVersion: 1,
    storage: {
      mode,
      revision,
      ruleCount: JSON.parse(payload.json).rules.length,
      sha256: payload.jsonSha256,
      compression: compressedFormat,
      encoding: compressedEncoding,
      byteLength: payload.byteLength,
      compressedByteLength: payload.compressedByteLength,
      parts
    }
  };
}

function buildDiscussionBody(
  pkg: ExtractionRulePackage,
  options: OnlineExtractionRuleSubmissionOptions,
  manifest: OnlineExtractionRuleManifest,
  inlineJson?: string,
  inlineGzipBase64?: string
): string {
  const meta: OnlineExtractionRuleMeta = {
    schemaVersion: 1,
    kind: "bgt.onlineExtractionRulePackage",
    id: pkg.id,
    displayName: pkg.displayName,
    description: pkg.description,
    engine: pkg.engine,
    tags: pkg.tags,
    ruleEngineVersion: pkg.ruleEngineVersion,
    createdAt: pkg.createdAt,
    updatedAt: new Date().toISOString()
  };
  return [
    `# ${buildRulePackageDiscussionTitle(pkg)}`,
    "",
    options.introduction.trim() || pkg.description,
    "",
    "<!-- bgt-extraction-rule-package -->",
    "",
    "<details>",
    "<summary>提取规则数据</summary>",
    "",
    "BGT-META-BEGIN",
    JSON.stringify(meta, null, 2),
    "BGT-META-END",
    "",
    "BGT-MANIFEST-BEGIN",
    JSON.stringify(manifest, null, 2),
    "BGT-MANIFEST-END",
    inlineJson ? ["", "BGT-RULES-BEGIN", inlineJson.trimEnd(), "BGT-RULES-END"].join("\n") : "",
    inlineGzipBase64 ? ["", "BGT-RULES-GZIP-BASE64-BEGIN", wrapBase64(inlineGzipBase64), "BGT-RULES-GZIP-BASE64-END"].join("\n") : "",
    "",
    "</details>"
  ].filter((part) => part !== "").join("\n");
}

function buildRulePackageDiscussionTitle(pkg: ExtractionRulePackage): string {
  const engine = (pkg.engine || "通用").trim() || "通用";
  return `[${engine}]${pkg.displayName.trim() || pkg.id}`;
}

function buildCompressedPartComment(index: number, gzipBase64Part: string): string {
  return [
    `<!-- bgt-extraction-rule-compressed-part index=${index} -->`,
    "",
    "<details>",
    `<summary>提取规则压缩数据分片 ${index}</summary>`,
    "",
    `BGT-PART-INDEX: ${index}`,
    "",
    "BGT-RULES-GZIP-BASE64-BEGIN",
    wrapBase64(gzipBase64Part),
    "BGT-RULES-GZIP-BASE64-END",
    "",
    "</details>"
  ].join("\n");
}

function submissionRevision(pkg: ExtractionRulePackage): number {
  const revision = pkg.updateUrl?.revision ?? 1;
  return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 1;
}

async function readPackageFromNode(summary: OnlineExtractionRuleSummary, node: GitHubDiscussionNode): Promise<ExtractionRulePackage> {
  if (!summary.manifest) throw new Error("缺少在线规则包 manifest。");
  const storage = summary.manifest.storage;
  let json = "";
  if (storage.mode === "inline") {
    json = extractMarkedBlock(node.body, "BGT-RULES") ?? "";
  } else if (storage.mode === "compressedInline") {
    const base64 = (extractMarkedBlock(node.body, "BGT-RULES-GZIP-BASE64") ?? "").replace(/\s+/g, "");
    json = (await gunzip(Buffer.from(base64, compressedEncoding))).toString("utf8");
  } else if (storage.mode === "compressedComments") {
    const parts = [...(storage.parts ?? [])].sort((a, b) => a.index - b.index);
    if (!parts.length) throw new Error("压缩分片规则包缺少 parts。");
    const publicComments = node.publicComments ?? [];
    const bodies = publicComments.length
      ? commentsByPartIndex(publicComments, "bgt-extraction-rule")
      : await discussions.loadDiscussionComments(parts.map((part) => part.commentId));
    const encodedParts = parts.map((part) => {
      const commentBody = publicComments.length ? bodies.get(String(part.index)) : bodies.get(part.commentId);
      if (!commentBody) throw new Error(`找不到压缩分片 comment：${part.commentId}`);
      const encoded = (extractMarkedBlock(commentBody, "BGT-RULES-GZIP-BASE64") ?? "").replace(/\s+/g, "");
      if (!encoded) throw new Error(`压缩分片 ${part.index} 缺少 gzip base64 内容。`);
      if (Buffer.byteLength(encoded, "utf8") !== part.byteLength) throw new Error(`压缩分片 ${part.index} 大小校验失败。`);
      if (normalizeHash(sha256(encoded)) !== normalizeHash(part.sha256)) throw new Error(`压缩分片 ${part.index} hash 校验失败。`);
      return encoded;
    });
    json = (await gunzip(Buffer.from(encodedParts.join(""), compressedEncoding))).toString("utf8");
  } else {
    throw new Error(`当前版本暂未读取 ${storage.mode} 在线规则存储，但协议已预留。`);
  }
  if (normalizeHash(sha256(json)) !== normalizeHash(storage.sha256)) throw new Error("在线规则包 hash 校验失败。");
  const pkg = JSON.parse(json) as ExtractionRulePackage;
  validateExtractionRulePackage(pkg);
  return pkg;
}

function parseSummary(sourceId: string, node: GitHubDiscussionNode): OnlineExtractionRuleSummary | null {
  if (!node.body.includes("bgt-extraction-rule-package")) return null;
  const meta = parseJsonMarkedBlock<OnlineExtractionRuleMeta>(node.body, "BGT-META");
  const manifest = parseJsonMarkedBlock<OnlineExtractionRuleManifest>(node.body, "BGT-MANIFEST");
  if (!meta || meta.kind !== "bgt.onlineExtractionRulePackage") return null;
  return {
    sourceId,
    discussionId: node.id,
    discussionNumber: node.number,
    url: node.url,
    title: node.title,
    author: node.author?.login ?? "",
    updatedAt: node.updatedAt,
    introduction: node.body.split("<!-- bgt-extraction-rule-package -->")[0].replace(/^# .+$/m, "").trim(),
    introductionHtml: node.introductionHtml,
    meta,
    manifest: manifest ?? undefined
  };
}
