import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { gfm } from "turndown-plugin-gfm";
import { getWebSearchCdpEndpoint, scheduleWebSearchCdpIdleShutdown } from "./webSearchCdpProcess";

type BrowserExtractOptions = {
  url: string;
  maxChars: number;
  includeLinks: boolean;
  extractContent: boolean;
  returnHtml: boolean;
  waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
  waitForNavigation: boolean;
  navigationTimeout: number;
  disableMedia: boolean;
};

type BrowserExtractResult = {
  title: string;
  finalUrl: string;
  content: string;
  contentLength: number;
  truncated: boolean;
  links?: Array<{ text: string; href: string }>;
};

let pageLock: Promise<void> = Promise.resolve();

export async function browserExtractWebContent(options: BrowserExtractOptions): Promise<BrowserExtractResult> {
  return withBrowserExtractPageLock(() => browserExtractWebContentLocked(options));
}

async function browserExtractWebContentLocked(options: BrowserExtractOptions): Promise<BrowserExtractResult> {
  const initialUrl = new URL(options.url);
  await assertPublicHttpUrlResolved(initialUrl, "url");
  const endpoint = await getWebSearchCdpEndpoint();
  if (!endpoint) throw new Error("浏览器提取不可用：无法启动隐藏 Electron CDP。");

  let browser: Browser | null = null;
  let page: Page | null = null;
  let routeHandler: ((route: Route) => Promise<void>) | null = null;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
    const context = resolveBrowserContext(browser);
    page = resolveExistingPage(context);

    if (options.disableMedia) {
      routeHandler = async (route: Route) => {
        const resourceType = route.request().resourceType();
        if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
          await route.abort().catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      };
      await page.route("**/*", routeHandler);
    }

    await gotoAndKeepPartialContent(page, initialUrl.toString(), options);
    if (options.waitForNavigation) {
      await waitForPossibleNavigation(page, options);
    }
    await waitForReadablePage(page, options);

    const finalUrl = page.url();
    await assertPublicHttpUrlResolved(new URL(finalUrl), "finalUrl");
    const pageInfo = await safelyGetPageInfo(page);
    const extractedContent = processHtmlContent(pageInfo.html, finalUrl, options);
    if (!extractedContent) throw new Error("浏览器已打开网页，但没有提取到可读文本。");

    const links = options.includeLinks ? await extractLinks(page) : undefined;
    const truncated = extractedContent.length > options.maxChars;
    const content = truncated
      ? `${extractedContent.slice(0, options.maxChars)}\n\n[...truncated ${extractedContent.length - options.maxChars} characters]`
      : extractedContent;
    return {
      title: pageInfo.title,
      finalUrl,
      content,
      contentLength: content.length,
      truncated,
      links
    };
  } finally {
    if (page && routeHandler) {
      await page.unroute("**/*", routeHandler).catch(() => undefined);
    }
    await page?.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    scheduleWebSearchCdpIdleShutdown();
  }
}

async function withBrowserExtractPageLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = pageLock;
  let release!: () => void;
  pageLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function resolveBrowserContext(browser: Browser): BrowserContext {
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) throw new Error("隐藏浏览器没有可用上下文。");
  return context;
}

function resolveExistingPage(context: BrowserContext): Page {
  const page = context.pages().find((candidate) => !candidate.isClosed());
  if (!page) {
    throw new Error("隐藏浏览器没有可复用页面。");
  }
  return page;
}

async function gotoAndKeepPartialContent(page: Page, url: string, options: BrowserExtractOptions): Promise<void> {
  try {
    await page.goto(url, { waitUntil: options.waitUntil, timeout: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) throw error;
    const html = await page.content().catch(() => "");
    if (!html.trim()) throw error;
  }
}

async function waitForPossibleNavigation(page: Page, options: BrowserExtractOptions): Promise<void> {
  await page.waitForNavigation({
    timeout: options.navigationTimeout,
    waitUntil: options.waitUntil
  }).catch(() => undefined);
}

async function waitForReadablePage(page: Page, options: BrowserExtractOptions): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, options.navigationTimeout) }).catch(() => undefined);
  await page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
  const startedAt = Date.now();
  const timeoutMs = Math.min(8_000, Math.max(2_000, options.navigationTimeout));
  while (Date.now() - startedAt < timeoutMs) {
    const textLength = await page.evaluate(() => (document.body?.innerText || document.body?.textContent || "").trim().length).catch(() => 0);
    if (textLength >= 300) return;
    await page.waitForTimeout(500);
  }
}

async function safelyGetPageInfo(page: Page, retries = 3): Promise<{ title: string; html: string }> {
  let title = "";
  let html = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      title = await page.title();
      html = await page.content();
      return { title, html };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Execution context was destroyed") || attempt === retries) throw error;
      await page.waitForTimeout(1_000).catch(() => undefined);
    }
  }
  return { title, html };
}

function processHtmlContent(html: string, url: string, options: BrowserExtractOptions): string {
  let contentToProcess = html;
  if (options.extractContent) {
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.content) {
      contentToProcess = article.content;
    }
  }

  if (options.returnHtml) {
    return normalizeExtractedContent(contentToProcess);
  }

  const dom = new JSDOM(contentToProcess, { url, virtualConsole: new VirtualConsole() });
  removeGenericNoise(dom.window.document);
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  turndownService.use(gfm);
  return normalizeExtractedContent(turndownService.turndown(dom.window.document.body?.innerHTML || contentToProcess));
}

function removeGenericNoise(document: Document): void {
  document.querySelectorAll("script, style, noscript, template, svg, canvas").forEach((node) => node.remove());
}

async function extractLinks(page: Page): Promise<Array<{ text: string; href: string }>> {
  return page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("a[href]")).slice(0, 200)
      .map((anchor) => ({
        text: normalize(anchor.textContent || ""),
        href: (anchor as HTMLAnchorElement).href
      }))
      .filter((link) => link.href && /^https?:\/\//i.test(link.href));
  }).catch(() => []);
}

function normalizeExtractedContent(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

async function assertPublicHttpUrlResolved(url: URL, label: string): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
  if (isPrivateOrLocalHostname(url.hostname)) throw new Error(`${label} points to a private or local network target.`);
  const host = stripIpv6Brackets(url.hostname);
  if (isIP(host) !== 0) return;
  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  if (resolved.some((entry) => isPrivateOrLocalHostname(entry.address))) {
    throw new Error(`${label} resolves to a private or local network target.`);
  }
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 0) return false;
  if (host === "0.0.0.0" || host === "::") return true;
  if (host.startsWith("10.") || host.startsWith("127.") || host.startsWith("169.254.") || host.startsWith("192.168.")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] >= 224) return true;
  }
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
