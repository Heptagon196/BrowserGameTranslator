import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { browserExtractWebContent } from "./browserWebExtractService";
import { getWebSearchCdpEndpoint, scheduleWebSearchCdpIdleShutdown } from "./webSearchCdpProcess";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type McpToolContent = {
  type?: string;
  text?: string;
};

type WebSearchRow = {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
};

type SearchMode = "auto" | "request" | "playwright";
type ExtractMode = "auto" | "request" | "browser";

const requireFromHere = createRequire(__filename);
const allowedSearchEngines = ["bing", "baidu"] as const;
const defaultSearchEngine = "bing";
const preferredSearchMode: SearchMode = "playwright";

class OpenWebSearchMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private activeRequests = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    await this.ensureReady();
    this.activeRequests += 1;
    this.clearIdleTimer();
    try {
      return await this.request("tools/call", { name, arguments: args }, timeoutMs);
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.scheduleIdleShutdown();
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.startProcess().then(() => this.initialize()).catch((error) => {
      this.stopProcess();
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  private async startProcess(): Promise<void> {
    if (this.process) return;
    const packageJsonPath = requireFromHere.resolve("open-websearch/package.json");
    const entryPath = path.join(path.dirname(packageJsonPath), "build", "index.js");
    const cdpEndpoint = await getWebSearchCdpEndpoint();
    const child = spawn(process.execPath, [entryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MODE: "stdio",
        OPEN_WEBSEARCH_QUIET_STARTUP: "true",
        DEFAULT_SEARCH_ENGINE: defaultSearchEngine,
        ALLOWED_SEARCH_ENGINES: allowedSearchEngines.join(","),
        SEARCH_MODE: cdpEndpoint ? preferredSearchMode : "request",
        PLAYWRIGHT_PACKAGE: "playwright-core",
        PLAYWRIGHT_CDP_ENDPOINT: cdpEndpoint ?? ""
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8000);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`open-websearch exited with code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}. ${this.stderrTail}`.trim()));
      this.process = null;
      this.readyPromise = null;
    });
    this.process = child;
  }

  private stopProcess(): void {
    this.clearIdleTimer();
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.readyPromise = null;
    scheduleWebSearchCdpIdleShutdown();
  }

  private scheduleIdleShutdown(): void {
    if (this.activeRequests > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.stopProcess();
    }, 120_000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "BrowserGameTranslator",
        version: "0.1.0"
      }
    }, 20_000);
    this.notify("notifications/initialized", {});
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("open-websearch process is not running."));
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`open-websearch request timed out: ${method}. ${this.stderrTail}`.trim()));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleMessageLine(line);
    }
  }

  private handleMessageLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-8000);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ""}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const sharedClient = new OpenWebSearchMcpClient();

export async function executeWebSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = requiredText(args.query, "query");
  const limit = Math.min(20, Math.max(1, finiteNumber(args.limit, 8)));
  const engines = normalizeEngines(args.engines ?? args.engine);
  const searchMode = normalizeSearchMode(args.searchMode);
  const result = await sharedClient.callTool("search", compactObject({
    query,
    limit,
    engines,
    searchMode
  }));
  assertMcpToolOk(result);
  const payload = parseMcpJson(result);
  const rows = normalizeSearchRows(payload);
  const total = typeof payload.totalResults === "number" ? payload.totalResults : rows.length;
  const partialFailures = Array.isArray(payload.partialFailures) ? payload.partialFailures : [];
  return {
    tool: "web_search",
    ok: true,
    query,
    engines,
    searchMode: searchMode ?? preferredSearchMode,
    total,
    returned: rows.length,
    rows,
    partialFailures,
    summary: `网页搜索「${query}」找到 ${total} 条，返回 ${rows.length} 条。`
  };
}

export async function executeWebExtract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = requiredText(args.url, "url");
  validateHttpUrl(url);
  const maxChars = Math.min(80_000, Math.max(1_000, finiteNumber(args.maxChars, 30_000)));
  const mode = normalizeExtractMode(args.mode);
  if (mode === "browser") {
    return executeBrowserWebExtract(url, maxChars, args);
  }
  if (mode === "request") {
    return executeRequestWebExtract(url, maxChars, args);
  }
  try {
    const requestResult = await executeRequestWebExtract(url, maxChars, args);
    return typeof requestResult.content === "string" && requestResult.content.length >= 500
      ? requestResult
      : await executeBrowserWebExtract(url, maxChars, args, "请求模式提取内容过少，已改用浏览器提取。");
  } catch (error) {
    const browserResult = await executeBrowserWebExtract(url, maxChars, args, `请求模式失败：${error instanceof Error ? error.message : String(error)}`);
    return browserResult;
  }
}

async function executeRequestWebExtract(url: string, maxChars: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await sharedClient.callTool("fetchWebContent", {
    url,
    maxChars,
    readability: args.readability !== false,
    includeLinks: args.includeLinks === true
  }, 90_000);
  assertMcpToolOk(result);
  const payload = parseMcpJson(result);
  const content = typeof payload.content === "string" ? payload.content : extractMcpText(result);
  const title = typeof payload.title === "string" ? payload.title : "";
  return {
    tool: "web_extract",
    ok: true,
    url,
    title,
    mode: "request",
    finalUrl: textValue(payload.finalUrl) || url,
    retrievalMethod: textValue(payload.retrievalMethod) || "request",
    content,
    contentLength: content.length,
    truncated: payload.truncated === true || content.length >= maxChars,
    summary: `已读取网页${title ? `「${title}」` : ""}，约 ${content.length} 字符。`
  };
}

async function executeBrowserWebExtract(url: string, maxChars: number, args: Record<string, unknown>, fallbackReason?: string): Promise<Record<string, unknown>> {
  const result = await browserExtractWebContent({
    url,
    maxChars,
    includeLinks: args.includeLinks === true,
    extractContent: args.readability !== false && args.extractContent !== false,
    returnHtml: args.returnHtml === true,
    waitUntil: normalizeWaitUntil(args.waitUntil),
    waitForNavigation: args.waitForNavigation !== false,
    navigationTimeout: Math.min(60_000, Math.max(2_000, finiteNumber(args.navigationTimeout, 10_000))),
    disableMedia: args.disableMedia !== false
  });
  return {
    tool: "web_extract",
    ok: true,
    url,
    title: result.title,
    mode: "browser",
    retrievalMethod: "browser",
    finalUrl: result.finalUrl,
    content: result.content,
    contentLength: result.contentLength,
    truncated: result.truncated,
    links: result.links,
    fallbackReason,
    summary: `已用浏览器读取网页${result.title ? `「${result.title}」` : ""}，约 ${result.contentLength} 字符。`
  };
}

function assertMcpToolOk(result: unknown): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const record = result as Record<string, unknown>;
  if (record.isError === true) throw new Error(extractMcpText(result) || "open-websearch tool failed.");
}

function parseMcpJson(result: unknown): Record<string, unknown> {
  const text = extractMcpText(result);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { content: text };
  }
}

function extractMcpText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (!Array.isArray(record.content)) return JSON.stringify(result);
  return (record.content as McpToolContent[])
    .map((item) => item.type === "text" || typeof item.text === "string" ? item.text ?? "" : "")
    .filter(Boolean)
    .join("\n");
}

function normalizeSearchRows(payload: Record<string, unknown>): WebSearchRow[] {
  const rawRows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.value) ? payload.value : [];
  return rawRows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => ({
      title: textValue(row.title),
      url: textValue(row.url ?? row.link),
      snippet: textValue(row.snippet ?? row.description ?? row.content),
      engine: textValue(row.engine ?? row.source) || undefined
    }))
    .filter((row) => row.title || row.url || row.snippet);
}

function normalizeSearchMode(value: unknown): SearchMode | undefined {
  if (value === "auto" || value === "request" || value === "playwright") return value;
  return undefined;
}

function normalizeExtractMode(value: unknown): ExtractMode {
  return value === "request" || value === "browser" || value === "auto" ? value : "auto";
}

function normalizeWaitUntil(value: unknown): "load" | "domcontentloaded" | "networkidle" | "commit" {
  if (value === "load" || value === "domcontentloaded" || value === "networkidle" || value === "commit") return value;
  return "load";
}

function normalizeEngines(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const engines = raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry): entry is typeof allowedSearchEngines[number] => (allowedSearchEngines as readonly string[]).includes(entry));
  return engines.length ? [...new Set(engines)] : [defaultSearchEngine];
}

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must be an HTTP(S) URL.");
}

function requiredText(value: unknown, name: string): string {
  const output = textValue(value).trim();
  if (!output) throw new Error(`${name} is required.`);
  return output;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown, fallback: number): number {
  const output = Number(value);
  return Number.isFinite(output) ? Math.floor(output) : fallback;
}
