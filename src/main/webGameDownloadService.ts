import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { WebGameDownloadEvent, WebGameDownloadInput, WebGameDownloadProgress, WebGameDownloadResult } from "../shared/types";
import { networkFetch } from "./networkProxyService";

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const assetExtensions = /\.(png|jpg|jpeg|gif|svg|webp|avif|ico|mp3|ogg|wav|m4a|flac|mp4|webm|json|xml|atlas|fnt|wasm|css|js|mjs|glsl|vert|frag|bin|dat|tmx|tsx|woff|woff2|ttf|otf|eot)$/i;
const parseableExtensions = /\.(html?|css|js|mjs|json|webmanifest|atlas|fnt|xml|txt)$/i;
const defaultRuntimeCaptureSeconds = 9;

interface WebAssetRef {
  url: string;
  required: boolean;
  source: WebAssetSource;
}

type WebAssetSource = "entry" | "html" | "css" | "js" | "manifest" | "runtime";
type WebAssetStatus = "pending" | "downloaded" | "failed" | "skipped";

interface WebAssetRecord {
  url: string;
  path: string;
  required: boolean;
  sources: WebAssetSource[];
  status: WebAssetStatus;
  bytes?: number;
  contentType?: string;
  error?: string;
}

interface ItchRecord {
  title?: string;
  coverImage?: string;
  authors?: Array<{ url: string; name: string }>;
  tags?: string[];
  id?: number;
  commentsLink?: string;
  selfLink?: string;
  author?: string;
  name?: string;
  domain?: string;
  gameUrl?: string;
  metaDataUrl?: string;
}

interface ResolvedEntry {
  originalUrl: string;
  entryUrl: string;
  rootUrl: string;
  pageHtml?: string;
  itchHtmlId?: string;
}

interface DownloadContext {
  originalUrl: string;
  entryUrl: string;
  rootUrl: string;
  rootHost: string;
  gameDir: string;
  assets: Map<string, WebAssetRecord>;
  preloadedText: Map<string, { text: string; contentType?: string }>;
  emit: (event: WebGameDownloadEvent) => void;
  onProgress?: (progress: WebGameDownloadProgress) => void;
}

export async function downloadWebGame(
  input: WebGameDownloadInput,
  handlers: {
    onEvent: (event: WebGameDownloadEvent) => void;
    onProgress?: (progress: WebGameDownloadProgress) => void;
  }
): Promise<WebGameDownloadResult> {
  const url = input.url.trim();
  const outputDirectory = input.outputDirectory.trim();
  if (!/^https?:\/\/[^/]+/i.test(url)) throw new Error("请输入有效的网页游戏地址。");
  if (!outputDirectory) throw new Error("请选择保存目录。");

  const emit = handlers.onEvent;
  emit({ stream: "system", text: `下载网页游戏：${url}` });
  emit({ stream: "system", text: "使用通用网页下载器：递归解析静态资源，并捕获启动阶段的运行时请求。" });

  try {
    const gameDir = path.resolve(outputDirectory);
    const outputErrors = await validateWebGameOutputDirectory(gameDir);
    if (outputErrors.length) throw new Error(outputErrors.join("\n"));
    const resolved = await resolveEntryPage(url, emit);

    const context: DownloadContext = {
      originalUrl: resolved.originalUrl,
      entryUrl: resolved.entryUrl,
      rootUrl: resolved.rootUrl,
      rootHost: new URL(resolved.rootUrl).hostname,
      gameDir,
      assets: new Map(),
      preloadedText: new Map(),
      emit,
      onProgress: handlers.onProgress
    };
    if (resolved.pageHtml !== undefined) {
      context.preloadedText.set(stripUrlHash(resolved.entryUrl), { text: resolved.pageHtml, contentType: "text/html" });
    }

    addAsset(context, { url: resolved.entryUrl, required: true, source: "entry" }, "index.html");
    await processAssetQueue(context);

    const runtimeAssets = await captureRuntimeAssetRefs(resolved.entryUrl, context, emit, handlers.onProgress, normalizeRuntimeCaptureSeconds(input.runtimeCaptureSeconds));
    for (const assetUrl of runtimeAssets) {
      addAsset(context, { url: assetUrl, required: false, source: "runtime" });
    }
    if (runtimeAssets.length > 0) await processAssetQueue(context);

    const downloaded = Array.from(context.assets.values()).filter((asset) => asset.status === "downloaded");
    const failures = Array.from(context.assets.values()).filter((asset) => asset.status === "failed");
    const requiredFailure = failures.some((asset) => asset.required);
    const totalBytes = downloaded.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0);

    const metadataPath = await writeOptionalMetadata(resolved.originalUrl, gameDir).catch(() => undefined);
    const indexPath = path.join(gameDir, "web-game-download-index.json");
    await fs.writeFile(
      indexPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          originalUrl: resolved.originalUrl,
          entryUrl: resolved.entryUrl,
          rootUrl: resolved.rootUrl,
          assets: Array.from(context.assets.values()).sort((a, b) => a.path.localeCompare(b.path))
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const failureNote = failures.length
      ? ` (${failures.length} 个资源失败：${failures.slice(0, 3).map((asset) => `${asset.path} ${asset.error ?? ""}`.trim()).join("；")}${failures.length > 3 ? "..." : ""})`
      : "";
    return {
      status: !requiredFailure,
      message: `网页游戏下载完成：${downloaded.length} 个资源${failureNote}。`,
      filePath: path.join(gameDir, "index.html"),
      metadataPath,
      indexPath,
      assets: downloaded.map((asset) => asset.path),
      bytesDownloaded: totalBytes,
      failures: failures.map((asset) => `${asset.path}: ${asset.error ?? "下载失败"}`)
    };
  } catch (error) {
    const message = describeError(error);
    emit({ stream: "stderr", text: message });
    throw error;
  }
}

async function resolveEntryPage(url: string, emit: (event: WebGameDownloadEvent) => void): Promise<ResolvedEntry> {
  const response = await electronFetch(url, { headers: { "User-Agent": userAgent } });
  emit({ stream: "stdout", text: `预检页面：HTTP ${response.status} ${response.statusText}` });
  if (!response.ok) throw new Error(`页面返回 HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const html = contentType.includes("text/html") ? await response.text() : undefined;
  const itchHtmlId = html ? findItchHtml5IframeId(html) : undefined;
  if (itchHtmlId) {
    const entryUrl = `https://html-classic.itch.zone/html/${itchHtmlId}/index.html`;
    const indexResponse = await electronFetch(entryUrl, { headers: { "User-Agent": userAgent } });
    if (!indexResponse.ok) throw new Error(`HTML5 页面返回 HTTP ${indexResponse.status}`);
    emit({ stream: "stdout", text: `发现内嵌 HTML5 游戏页面：${entryUrl}` });
    return {
      originalUrl: url,
      entryUrl,
      rootUrl: new URL(".", entryUrl).toString(),
      pageHtml: await indexResponse.text(),
      itchHtmlId
    };
  }
  return {
    originalUrl: url,
    entryUrl: url,
    rootUrl: new URL(".", url).toString(),
    pageHtml: html
  };
}

async function processAssetQueue(context: DownloadContext): Promise<void> {
  while (true) {
    const next = Array.from(context.assets.values()).find((asset) => asset.status === "pending");
    if (!next) return;
    await downloadAndDiscoverAsset(context, next);
  }
}

async function downloadAndDiscoverAsset(context: DownloadContext, asset: WebAssetRecord): Promise<void> {
  const completedBefore = Array.from(context.assets.values()).filter((item) => item.status !== "pending").length;
  context.onProgress?.({
    phase: "download",
    completed: completedBefore,
    total: context.assets.size,
    fileName: asset.path,
    message: `下载 ${asset.path}`
  });

  try {
    const preloaded = context.preloadedText.get(stripUrlHash(asset.url));
    const response = preloaded ? undefined : await electronFetch(asset.url, { headers: { "User-Agent": userAgent } });
    if (response && !response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = preloaded?.contentType ?? response?.headers.get("content-type") ?? undefined;
    const buffer = preloaded ? Buffer.from(preloaded.text, "utf8") : Buffer.from(await response!.arrayBuffer());
    const destination = path.resolve(context.gameDir, asset.path);
    if (!isPathInsideOrSame(destination, context.gameDir)) throw new Error("path traversal blocked");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);

    asset.status = "downloaded";
    asset.bytes = buffer.length;
    asset.contentType = contentType;
    context.emit({ stream: "stdout", text: `${asset.path} ${formatBytes(buffer.length)} downloaded` });

    if (shouldParseAsset(asset.path, contentType)) {
      const text = preloaded?.text ?? buffer.toString("utf8");
      discoverNestedAssets(context, asset, text, contentType);
    }
  } catch (error) {
    asset.status = "failed";
    asset.error = error instanceof Error ? error.message : String(error);
    context.emit({ stream: asset.required ? "stderr" : "stdout", text: `${asset.path} failed: ${asset.error}` });
  } finally {
    const completed = Array.from(context.assets.values()).filter((item) => item.status !== "pending").length;
    context.onProgress?.({
      phase: "download",
      completed,
      total: context.assets.size,
      fileName: asset.path,
      message: `已处理 ${completed}/${context.assets.size}`
    });
  }
}

function discoverNestedAssets(context: DownloadContext, asset: WebAssetRecord, text: string, contentType?: string): void {
  if (isHtmlAsset(asset.path, contentType)) {
    for (const ref of parseHtmlAssetRefs(text, asset.url)) addAsset(context, ref);
    return;
  }
  if (isCssAsset(asset.path, contentType)) {
    for (const ref of parseCssAssetRefs(text, asset.url)) addAsset(context, ref);
    return;
  }
  if (isJsAsset(asset.path, contentType)) {
    for (const ref of scanTextForAssetRefs(text, context.entryUrl, "js")) addAsset(context, ref);
    return;
  }
  for (const ref of scanTextForAssetRefs(text, asset.url, "manifest")) addAsset(context, ref);
}

function addAsset(context: DownloadContext, ref: WebAssetRef, forcedPath?: string): void {
  const normalizedUrl = stripUrlHash(ref.url);
  const assetUrl = new URL(normalizedUrl);
  if (assetUrl.protocol !== "http:" && assetUrl.protocol !== "https:") return;
  if (assetUrl.hostname !== context.rootHost) return;
  const localPath = forcedPath ?? localPathForUrl(assetUrl, context.rootUrl);
  if (!localPath) return;
  const existing = context.assets.get(normalizedUrl);
  if (existing) {
    existing.required = existing.required || ref.required;
    if (!existing.sources.includes(ref.source)) existing.sources.push(ref.source);
    return;
  }
  context.assets.set(normalizedUrl, {
    url: normalizedUrl,
    path: localPath,
    required: ref.required,
    sources: [ref.source],
    status: "pending"
  });
}

function parseHtmlAssetRefs(html: string, pageUrl: string): WebAssetRef[] {
  const refs: WebAssetRef[] = [];
  const baseUrl = getHtmlBaseUrl(html, pageUrl);
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const tagName = match[1].toLowerCase();
    const attrs = parseHtmlAttrs(match[2] ?? "");
    const rel = attrs.rel?.toLowerCase() ?? "";
    const required = tagName === "script" || (tagName === "link" && ["stylesheet", "modulepreload", "preload", "manifest"].some((item) => rel.split(/\s+/).includes(item)));
    for (const key of ["src", "href", "poster", "data"]) {
      const rawRef = attrs[key];
      if (!rawRef) continue;
      const assetUrl = normalizeResourceUrl(rawRef, baseUrl);
      if (assetUrl) refs.push({ url: assetUrl, required, source: "html" });
    }
    if (attrs.srcset) {
      for (const srcsetUrl of parseSrcSet(attrs.srcset, baseUrl)) refs.push({ url: srcsetUrl, required, source: "html" });
    }
    if (attrs.style) refs.push(...parseCssAssetRefs(attrs.style, baseUrl));
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    refs.push(...parseCssAssetRefs(match[1], baseUrl));
  }
  return refs;
}

function parseCssAssetRefs(css: string, baseUrl: string): WebAssetRef[] {
  const refs: WebAssetRef[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")]+))\s*\)/gi)) {
    const rawRef = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const assetUrl = normalizeResourceUrl(rawRef, baseUrl);
    if (assetUrl) refs.push({ url: assetUrl, required: false, source: "css" });
  }
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'"\s)]+))/gi)) {
    const rawRef = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const assetUrl = normalizeResourceUrl(rawRef, baseUrl);
    if (assetUrl) refs.push({ url: assetUrl, required: false, source: "css" });
  }
  return refs;
}

function scanTextForAssetRefs(text: string, baseUrl: string, source: WebAssetSource): WebAssetRef[] {
  const refs: WebAssetRef[] = [];
  for (const match of text.matchAll(/["'`]([^"'`<>]+?\.[a-zA-Z0-9]{1,12}(?:[?#][^"'`]*)?)["'`]/g)) {
    const candidate = match[1].trim();
    if (hasTemplatePlaceholder(candidate)) continue;
    if (!assetExtensions.test(candidate.split(/[?#]/, 1)[0])) continue;
    const assetUrl = normalizeResourceUrl(candidate, baseUrl);
    if (assetUrl) refs.push({ url: assetUrl, required: false, source });
  }
  return refs;
}

function hasTemplatePlaceholder(value: string): boolean {
  return /\$\{[^}]*\}/.test(value);
}

async function captureRuntimeAssetRefs(
  entryUrl: string,
  context: DownloadContext,
  emit: (event: WebGameDownloadEvent) => void,
  onProgress?: (progress: WebGameDownloadProgress) => void,
  captureSeconds = defaultRuntimeCaptureSeconds
): Promise<string[]> {
  const urls = new Set<string>();
  const partition = `web-game-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const session = window.webContents.session;
  const collect = (url: string) => {
    const normalized = normalizeResourceUrl(url, entryUrl);
    if (!normalized) return;
    const parsed = new URL(normalized);
    if (parsed.hostname !== context.rootHost) return;
    urls.add(stripUrlHash(normalized));
  };
  session.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
    if (details.statusCode >= 200 && details.statusCode < 400) collect(details.url);
  });

  try {
    emit({ stream: "system", text: "开始运行时资源捕获。" });
    onProgress?.({ phase: "runtime", completed: 0, total: 1, message: "打开页面并监听网络请求" });
    await window.loadURL(entryUrl, { userAgent });
    await wait(captureSeconds * 1000);
    onProgress?.({ phase: "runtime", completed: 1, total: 1, message: `捕获到 ${urls.size} 个请求` });
    emit({ stream: "stdout", text: `运行时捕获到 ${urls.size} 个同源请求。` });
  } catch (error) {
    emit({ stream: "stderr", text: `运行时捕获失败：${error instanceof Error ? error.message : String(error)}` });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
  return Array.from(urls).filter((url) => !context.assets.has(url));
}

function normalizeRuntimeCaptureSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultRuntimeCaptureSeconds;
  return Math.max(0, Math.min(60, Math.floor(value)));
}

async function writeOptionalMetadata(url: string, gameDir: string): Promise<string | undefined> {
  if (!/^https?:\/\/[^/]+\.itch\.io\/[^/?#]+/i.test(url)) return undefined;
  const response = await electronFetch(`${url.replace(/\/+$/, "")}/data.json`, { headers: { "User-Agent": userAgent } });
  if (!response.ok) return undefined;
  const metadata = await response.json() as Partial<ItchRecord>;
  const parsed = parseGameUrl(url);
  const record: ItchRecord = {
    title: metadata.title,
    coverImage: metadata.coverImage,
    authors: metadata.authors,
    tags: metadata.tags ?? [],
    id: metadata.id,
    commentsLink: metadata.commentsLink,
    selfLink: metadata.selfLink,
    author: parsed.author,
    name: parsed.name,
    domain: parsed.domain,
    gameUrl: url,
    metaDataUrl: `${url.replace(/\/+$/, "")}/data.json`
  };
  const metadataPath = path.join(gameDir, `${record.name || deriveDirectoryName(url, url)}-metadata.json`);
  await fs.writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return metadataPath;
}

function normalizeResourceUrl(ref: string, baseUrl: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#") || /^data:|^javascript:|^blob:|^mailto:/i.test(trimmed)) return undefined;
  try {
    return stripUrlHash(new URL(trimmed, baseUrl).toString());
  } catch {
    return undefined;
  }
}

function localPathForUrl(url: URL, rootUrl: string): string | undefined {
  const root = new URL(rootUrl);
  const relative = url.pathname.startsWith(root.pathname)
    ? url.pathname.slice(root.pathname.length)
    : url.pathname.replace(/^\/+/, "");
  return sanitizeAssetPath(decodeURIComponent(relative));
}

function sanitizeAssetPath(value: string): string | undefined {
  const trimmed = value.split(/[?#]/, 1)[0].replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return undefined;
  return normalized;
}

function getHtmlBaseUrl(html: string, pageUrl: string): string {
  const baseMatch = html.match(/<base\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
  const baseHref = baseMatch?.[1] ?? baseMatch?.[2] ?? baseMatch?.[3];
  return normalizeResourceUrl(baseHref ?? "", pageUrl) ?? pageUrl;
}

function parseHtmlAttrs(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function parseSrcSet(value: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const part of value.split(",")) {
    const rawRef = part.trim().split(/\s+/, 1)[0];
    const assetUrl = normalizeResourceUrl(rawRef, baseUrl);
    if (assetUrl) urls.push(assetUrl);
  }
  return urls;
}

function shouldParseAsset(assetPath: string, contentType?: string): boolean {
  const type = contentType?.toLowerCase() ?? "";
  return parseableExtensions.test(assetPath) || type.includes("text/") || type.includes("javascript") || type.includes("json") || type.includes("xml");
}

function isHtmlAsset(assetPath: string, contentType?: string): boolean {
  return /\.html?$/i.test(assetPath) || (contentType?.toLowerCase().includes("text/html") ?? false);
}

function isCssAsset(assetPath: string, contentType?: string): boolean {
  return /\.css$/i.test(assetPath) || (contentType?.toLowerCase().includes("text/css") ?? false);
}

function isJsAsset(assetPath: string, contentType?: string): boolean {
  const type = contentType?.toLowerCase() ?? "";
  return /\.(?:js|mjs)$/i.test(assetPath) || type.includes("javascript");
}

function findItchHtml5IframeId(html: string): string | undefined {
  return html.match(/(?:https?:\/\/)?(?:html-classic\.)?itch\.zone\/html\/(\d+)\/index\.html/)?.[1];
}

function deriveDirectoryName(originalUrl: string, entryUrl: string): string {
  const original = new URL(originalUrl);
  const lastPath = original.pathname.split("/").filter(Boolean).at(-1);
  const fallbackPath = new URL(entryUrl).pathname.split("/").filter(Boolean).at(-2);
  return sanitizeFileName(lastPath || fallbackPath || original.hostname);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\.+$/g, "").trim() || "web-game";
}

function stripUrlHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function parseGameUrl(gameUrl: string): { author?: string; name?: string; domain?: string } {
  const url = new URL(gameUrl);
  const hostParts = url.hostname.split(".");
  return {
    author: hostParts[0],
    domain: hostParts.slice(1).join("."),
    name: url.pathname.split("/").filter(Boolean)[0]
  };
}

export async function validateWebGameOutputDirectory(outputPath: string): Promise<string[]> {
  const outputDirectory = outputPath.trim();
  if (!outputDirectory) return ["请选择保存目录。"];
  let entries: string[];
  try {
    const stat = await fs.stat(outputDirectory);
    if (!stat.isDirectory()) return ["保存路径必须是文件夹。"];
    entries = await fs.readdir(outputDirectory);
  } catch {
    return ["保存目录不存在。"];
  }
  return entries.length > 0 ? ["保存目录必须为空。"] : [];
}

function electronFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = input instanceof URL ? input.toString() : (input as string | Request);
  return networkFetch(target, init);
}

function isPathInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines = [`${error.name}: ${error.message}`];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause) lines.push(`cause: ${describeCause(cause)}`);
  return lines.join("\n");
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const parts = [`${cause.name}: ${cause.message}`];
    const code = (cause as NodeJS.ErrnoException).code;
    if (code) parts.push(`code=${code}`);
    return parts.join(" ");
  }
  return String(cause);
}
