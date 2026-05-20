import crypto from "node:crypto";
import { app } from "electron";
import { JSDOM } from "jsdom";
import { networkFetch } from "./networkProxyService";
import { readJson, writeJson } from "./storage";

export interface GitHubDiscussionSource {
  id: string;
  displayName: string;
  url: string;
  owner: string;
  repo: string;
  discussionCategory: string;
  enabled: boolean;
  readonly?: boolean;
}

export interface GitHubDiscussionSettings<TSource extends GitHubDiscussionSource> {
  schemaVersion: 1;
  sources: TSource[];
  useToken: boolean;
}

export interface GitHubDiscussionTokenStatus {
  configured: boolean;
  enabled: boolean;
  login?: string;
}

export interface GitHubDiscussionConnectionTest {
  ok: boolean;
  message: string;
}

export interface GitHubDiscussionNode {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  bodyHTML?: string;
  updatedAt: string;
  author?: { login?: string | null } | null;
  comments?: { nodes: Array<{ id: string; body: string } | null> } | null;
  publicComments?: string[];
  introductionHtml?: string;
  attachmentUrls?: string[];
}

export interface GitHubDiscussionSearchResult {
  nodes: GitHubDiscussionNode[];
  page: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface GitHubDiscussionStoreConfig<TSource extends GitHubDiscussionSource> {
  settingsFileName: string;
  tokenFileName: string;
  defaultSource: TSource;
  defaultCategory: string;
  tokenRequiredMessage: string;
  publicConnectionMessage?: (source: TSource) => string;
  tokenConnectionMessage?: (source: TSource, categoryId: string) => string;
}

export function createGitHubDiscussionStore<TSource extends GitHubDiscussionSource>(
  config: GitHubDiscussionStoreConfig<TSource>
) {
  const settingsPath = () => app ? `${app.getPath("userData")}/${config.settingsFileName}` : config.settingsFileName;
  const tokenPath = () => app ? `${app.getPath("userData")}/${config.tokenFileName}` : config.tokenFileName;

  const normalizeSource = (source: TSource): TSource => {
    if (source.id === config.defaultSource.id) return config.defaultSource;
    const parsed = parseGitHubRepositoryUrl(source.url);
    const owner = parsed.owner || source.owner;
    const repo = parsed.repo || source.repo;
    return {
      ...source,
      id: source.id.trim() || `source_${Date.now()}`,
      displayName: source.displayName.trim() || `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
      owner,
      repo,
      discussionCategory: source.discussionCategory.trim() || config.defaultCategory,
      enabled: source.enabled !== false,
      readonly: false
    };
  };

  const normalizeSources = (sources: TSource[]): TSource[] => {
    const normalized = sources.filter((source) => source.id !== config.defaultSource.id).map(normalizeSource);
    return [config.defaultSource, ...normalized];
  };

  const listSources = async (): Promise<GitHubDiscussionSettings<TSource>> => {
    const saved = await readJson<Partial<GitHubDiscussionSettings<TSource>>>(settingsPath(), {
      schemaVersion: 1,
      sources: [config.defaultSource],
      useToken: true
    });
    const savedSources = saved.sources?.length ? saved.sources : [config.defaultSource];
    return { schemaVersion: 1, sources: normalizeSources(savedSources), useToken: saved.useToken !== false };
  };

  const saveSources = async (settings: GitHubDiscussionSettings<TSource>): Promise<GitHubDiscussionSettings<TSource>> => {
    const next = { schemaVersion: 1 as const, sources: normalizeSources(settings.sources), useToken: settings.useToken !== false };
    await writeJson(settingsPath(), next);
    return next;
  };

  const loadStoredToken = async (): Promise<string> => {
    const secrets = await readJson<{ token: string }>(tokenPath(), { token: "" });
    return secrets.token ?? "";
  };

  const shouldUseToken = async (): Promise<boolean> => {
    const settings = await readJson<Partial<GitHubDiscussionSettings<TSource>>>(settingsPath(), {
      schemaVersion: 1,
      sources: [config.defaultSource],
      useToken: true
    });
    return settings.useToken !== false;
  };

  const loadToken = async (): Promise<string> => {
    if (!(await shouldUseToken())) return "";
    return loadStoredToken();
  };

  const githubGraphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const token = (await loadToken()).trim();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "BrowserGameTranslator"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchGitHub("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });
    const text = await response.text();
    const payload = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
    if (!response.ok) throw new Error(`GitHub API 请求失败：HTTP ${response.status}`);
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("\n"));
    if (!payload.data) throw new Error("GitHub API 没有返回数据。");
    return payload.data;
  };

  const githubGraphqlWithToken = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const token = (await loadToken()).trim();
    if (!token) throw new Error(config.tokenRequiredMessage);
    return githubGraphql<T>(query, variables);
  };

  const getViewerLogin = async (): Promise<string> => {
    const data = await githubGraphqlWithToken<{ viewer: { login: string } }>(
      `query ViewerLogin {
        viewer { login }
      }`,
      {}
    );
    return data.viewer.login;
  };

  const getTokenStatus = async (): Promise<GitHubDiscussionTokenStatus> => {
    const token = (await loadStoredToken()).trim();
    const enabled = await shouldUseToken();
    if (!token) return { configured: false, enabled };
    if (!enabled) return { configured: true, enabled: false };
    try {
      return { configured: true, enabled: true, login: await getViewerLogin() };
    } catch {
      return { configured: true, enabled: true };
    }
  };

  const saveToken = async (token: string): Promise<GitHubDiscussionTokenStatus> => {
    await writeJson(tokenPath(), { token: token.trim() });
    return getTokenStatus();
  };

  const requireSource = async (sourceId: string): Promise<TSource> => {
    const settings = await listSources();
    const source = settings.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("找不到 GitHub Discussions 源。");
    return source;
  };

  const findCategoryId = async (source: TSource): Promise<string> => {
    const data = await githubGraphql<{
      repository: { discussionCategories: { nodes: Array<{ id: string; name: string; slug: string }> } } | null;
    }>(
      `query DiscussionCategories($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussionCategories(first: 100) {
            nodes { id name slug }
          }
        }
      }`,
      { owner: source.owner, repo: source.repo }
    );
    if (!data.repository) throw new Error("GitHub 仓库不存在或无权访问。");
    const category = data.repository.discussionCategories.nodes.find((item) => item.name === source.discussionCategory || item.slug === source.discussionCategory);
    if (!category) throw new Error(`找不到 Discussions 分类：${source.discussionCategory}`);
    return category.id;
  };

  const testSource = async (sourceId: string): Promise<GitHubDiscussionConnectionTest> => {
    try {
      const source = await requireSource(sourceId);
      if (!(await loadToken()).trim()) {
        const categoryUrl = `https://github.com/${source.owner}/${source.repo}/discussions/categories/${encodeURIComponent(source.discussionCategory)}`;
        await fetchText(categoryUrl);
        return { ok: true, message: config.publicConnectionMessage?.(source) ?? `已连接公开分类 ${source.owner}/${source.repo}/${source.discussionCategory}。未使用 GitHub API Token。` };
      }
      const categoryId = await findCategoryId(source);
      return { ok: true, message: config.tokenConnectionMessage?.(source, categoryId) ?? `已连接 ${source.owner}/${source.repo}，找到分类 ${source.discussionCategory}。${categoryId}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  const searchDiscussionNodes = async (source: TSource, webSearchQuery = "", page = 1, mineOnly = false): Promise<GitHubDiscussionSearchResult> => {
    const safePage = Math.max(1, Math.floor(page));
    const first = 20;
    let after: string | null = null;
    for (let currentPage = 1; currentPage <= safePage; currentPage += 1) {
      type SearchResponse = {
        search: {
          discussionCount: number;
          nodes: Array<GitHubDiscussionNode | Record<string, never> | null>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      const author = mineOnly ? await getViewerLogin() : "";
      const data: SearchResponse = await githubGraphqlWithToken<SearchResponse>(
        `query SearchDiscussions($query: String!, $first: Int!, $after: String) {
          search(query: $query, type: DISCUSSION, first: $first, after: $after) {
            discussionCount
            nodes {
              ... on Discussion {
                id
                number
                title
                url
                body
                updatedAt
                author { login }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { query: buildGraphqlDiscussionSearchQuery(source, webSearchQuery, author), first, after }
      );
      if (currentPage === safePage) {
        return {
          nodes: data.search.nodes.filter(isDiscussionNode),
          page: safePage,
          hasNextPage: data.search.pageInfo.hasNextPage,
          hasPreviousPage: safePage > 1
        };
      }
      if (!data.search.pageInfo.hasNextPage) return { nodes: [], page: safePage, hasNextPage: false, hasPreviousPage: safePage > 1 };
      after = data.search.pageInfo.endCursor;
    }
    return { nodes: [], page: safePage, hasNextPage: false, hasPreviousPage: safePage > 1 };
  };

  const loadDiscussionNode = async (discussionId: string): Promise<GitHubDiscussionNode> => {
    const data = await githubGraphql<{ node: GitHubDiscussionNode | null }>(
      `query DiscussionById($id: ID!) {
        node(id: $id) {
          ... on Discussion {
            id
            number
            title
            url
            body
            bodyHTML
            updatedAt
            author { login }
            comments(first: 100) {
              nodes {
                id
                body
              }
            }
          }
        }
      }`,
      { id: discussionId }
    );
    if (!data.node) throw new Error("找不到 GitHub discussion。");
    return hydrateDiscussionNode(data.node);
  };

  const loadDiscussionNodeByRepositoryNumber = async (source: TSource, number: number): Promise<GitHubDiscussionNode> => {
    const data = await githubGraphqlWithToken<{ repository: { discussion: GitHubDiscussionNode | null } | null }>(
      `query DiscussionByNumber($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
            number
            title
            url
            body
            bodyHTML
            updatedAt
            author { login }
            comments(first: 100) {
              nodes {
                id
                body
              }
            }
          }
        }
      }`,
      { owner: source.owner, repo: source.repo, number }
    );
    if (!data.repository?.discussion) throw new Error("找不到 GitHub discussion。");
    return hydrateDiscussionNode(data.repository.discussion);
  };

  const loadDiscussionComments = async (ids: string[]): Promise<Map<string, string>> => {
    const output = new Map<string, string>();
    for (let index = 0; index < ids.length; index += 50) {
      const batch = ids.slice(index, index + 50);
      const data = await githubGraphql<{ nodes: Array<{ id: string; body: string } | null> }>(
        `query DiscussionCommentsById($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on DiscussionComment {
              id
              body
            }
          }
        }`,
        { ids: batch }
      );
      for (const node of data.nodes) {
        if (node?.id) output.set(node.id, node.body);
      }
    }
    return output;
  };

  const loadRepositoryPublishInfo = async (source: TSource): Promise<{ repositoryId: string; categoryId: string }> => {
    const data = await githubGraphqlWithToken<{
      repository: { id: string; discussionCategories: { nodes: Array<{ id: string; name: string; slug: string }> } } | null;
    }>(
      `query RepositoryPublishInfo($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          id
          discussionCategories(first: 100) {
            nodes { id name slug }
          }
        }
      }`,
      { owner: source.owner, repo: source.repo }
    );
    if (!data.repository) throw new Error("GitHub 仓库不存在或无权访问。");
    const category = data.repository.discussionCategories.nodes.find((item) => item.name === source.discussionCategory || item.slug === source.discussionCategory);
    if (!category) throw new Error(`找不到 Discussions 分类：${source.discussionCategory}`);
    return { repositoryId: data.repository.id, categoryId: category.id };
  };

  const createDiscussion = async (repositoryId: string, categoryId: string, title: string, body: string): Promise<{ id: string; number: number; url: string }> => {
    const data = await githubGraphqlWithToken<{
      createDiscussion: { discussion: { id: string; number: number; url: string } | null } | null;
    }>(
      `mutation CreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
          discussion { id number url }
        }
      }`,
      { repositoryId, categoryId, title, body }
    );
    const discussion = data.createDiscussion?.discussion;
    if (!discussion) throw new Error("GitHub 没有返回新建 discussion。");
    return discussion;
  };

  const addDiscussionComment = async (discussionId: string, body: string): Promise<{ id: string }> => {
    const data = await githubGraphqlWithToken<{
      addDiscussionComment: { comment: { id: string } | null } | null;
    }>(
      `mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
          comment { id }
        }
      }`,
      { discussionId, body }
    );
    const comment = data.addDiscussionComment?.comment;
    if (!comment) throw new Error("GitHub 没有返回新建 comment。");
    return comment;
  };

  const updateDiscussion = async (discussionId: string, title: string, body: string): Promise<void> => {
    await githubGraphqlWithToken(
      `mutation UpdateDiscussion($discussionId: ID!, $title: String!, $body: String!) {
        updateDiscussion(input: {discussionId: $discussionId, title: $title, body: $body}) {
          discussion { id }
        }
      }`,
      { discussionId, title, body }
    );
  };

  const deleteDiscussion = async (discussionId: string): Promise<void> => {
    await githubGraphqlWithToken(
      `mutation DeleteDiscussion($discussionId: ID!) {
        deleteDiscussion(input: {id: $discussionId}) {
          discussion { id }
        }
      }`,
      { discussionId }
    );
  };

  return {
    listSources,
    saveSources,
    normalizeSource,
    normalizeSources,
    loadToken,
    loadStoredToken,
    shouldUseToken,
    getTokenStatus,
    saveToken,
    requireSource,
    testSource,
    githubGraphql,
    githubGraphqlWithToken,
    getViewerLogin,
    findCategoryId,
    searchDiscussionNodes,
    loadDiscussionNode,
    loadDiscussionNodeByRepositoryNumber,
    loadDiscussionComments,
    loadRepositoryPublishInfo,
    createDiscussion,
    addDiscussionComment,
    updateDiscussion,
    deleteDiscussion
  };
}

export function hydrateDiscussionNode(node: GitHubDiscussionNode): GitHubDiscussionNode {
  return {
    ...node,
    publicComments: node.publicComments ?? node.comments?.nodes.map((comment) => comment?.body ?? "").filter(Boolean),
    attachmentUrls: node.attachmentUrls?.length ? node.attachmentUrls : extractAttachmentUrlsFromHtml(node.bodyHTML)
  };
}

export function extractAttachmentUrlsFromHtml(html: string | undefined): string[] {
  if (!html) return [];
  const dom = new JSDOM(`<main>${html}</main>`);
  return extractAttachmentUrls(dom.window.document.querySelector("main")!);
}

export function extractAttachmentUrls(element: Element): string[] {
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

export function isAllowedAttachmentUrl(parsed: URL): boolean {
  return parsed.protocol === "https:" && (
    (parsed.hostname === "github.com" && parsed.pathname.startsWith("/user-attachments/")) ||
    parsed.hostname === "user-attachments.githubusercontent.com"
  );
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetchGitHub(url);
  if (!response.ok) throw new Error(`读取 GitHub 页面失败：HTTP ${response.status}`);
  return response.text();
}

export async function fetchGitHub(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await networkFetch(url, {
      ...init,
      headers: {
        "User-Agent": "BrowserGameTranslator",
        ...(init?.headers as Record<string, string> | undefined)
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`连接 GitHub 失败：${reason}。请检查网络、代理设置，或在设置里配置 GitHub API Token 后重试。`, { cause: error });
  }
}

export function buildGraphqlDiscussionSearchQuery(source: GitHubDiscussionSource, webSearchQuery: string, author: string): string {
  return [
    `repo:${source.owner}/${source.repo}`,
    `category:${quoteSearchToken(source.discussionCategory)}`,
    author ? `author:${author}` : "",
    webSearchQuery.trim()
  ].filter(Boolean).join(" ");
}

export function quoteSearchToken(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function isDiscussionNode(node: unknown): node is GitHubDiscussionNode {
  return Boolean(node && typeof node === "object" && "body" in node && "title" in node && "number" in node);
}

export function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
}

export function splitText(value: string, maxLength: number): string[] {
  if (!value) return [""];
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += maxLength) {
    parts.push(value.slice(index, index + maxLength));
  }
  return parts;
}

export function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\n").trimEnd();
}

export function parseJsonMarkedBlock<T>(body: string, marker: string): T | null {
  const value = extractMarkedBlock(body, marker);
  if (!value) return null;
  return JSON.parse(value) as T;
}

export function extractMarkedBlock(body: string, marker: string): string | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`${escaped}-BEGIN\\s*\\r?\\n([\\s\\S]*?)\\r?\\n${escaped}-END`, "i"));
  return match?.[1] ?? null;
}

export function commentsByPartIndex(comments: string[], markerPrefix: string): Map<string, string> {
  const output = new Map<string, string>();
  for (const comment of comments) {
    const match = comment.match(new RegExp(`${escapeRegExp(markerPrefix)}-(?:compressed-)?part\\s+index=(\\d+)`, "i")) || comment.match(/BGT-PART-INDEX:\s*(\d+)/i);
    if (match) output.set(match[1], comment);
  }
  return output;
}

export function parseDiscussionNumber(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  try {
    const parsed = new URL(trimmed);
    const match = parsed.pathname.match(/\/discussions\/(\d+)/);
    if (!match) throw new Error("请输入已有 discussion 的编号或 URL。");
    return Number(match[1]);
  } catch {
    throw new Error("请输入已有 discussion 的编号或 URL。");
  }
}

export function parseGitHubDiscussionUrl(value: string): { owner: string; repo: string; number: number } {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("请输入 GitHub discussion 链接。");
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/discussions\/(\d+)\/?$/);
  if (!match) throw new Error("请输入 GitHub discussion 链接，例如 https://github.com/owner/repo/discussions/1。");
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export function parseGitHubRepositoryUrl(url: string): { owner: string; repo: string } {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("请输入 GitHub 仓库 URL。");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error("请输入 GitHub 仓库 URL。");
  if (segments[2] === "discussions" && segments[3]) throw new Error("源配置不能填写具体 discussion URL。");
  return { owner: segments[0], repo: segments[1] };
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
