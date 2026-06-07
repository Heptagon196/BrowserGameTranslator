import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";
import { shell } from "electron";
import { PreviewStatus, ProjectConfig } from "../shared/types";
import { projectDirs } from "./storage";
import { findAvailablePreviewPort, normalizePreviewPort } from "./portUtils";

const runningServers = new Map<string, { server: http.Server; url: string }>();

export async function previewProjectGame(project: ProjectConfig): Promise<string> {
  const root = projectDirs(project).projectRoot;
  const homePage = normalizeHomePage(project.homePage);
  const homePath = path.resolve(root, homePage);
  if (!isPathInsideOrSame(homePath, root)) throw new Error("首页路径不能指向项目目录外。");
  try {
    await fs.access(homePath);
  } catch {
    throw new Error(`项目目录中没有找到首页文件：${homePage}`);
  }

  const requestedPort = normalizePreviewPort(project.previewPort) ?? await findAvailablePreviewPort();
  const existing = runningServers.get(root);
  if (existing?.server.listening) {
    const existingPort = Number(new URL(existing.url).port);
    if (existingPort !== requestedPort) {
      await stopProjectGamePreview(project);
    } else {
      const url = `${existing.url}${urlPathFor(homePage)}`;
      await shell.openExternal(url);
      return url;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const relativePath = pathname === "/" ? homePage : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);
      if (!isPathInsideOrSame(filePath, root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      let stat = await statOrUndefined(filePath);
      let resolvedFilePath = filePath;
      if (!stat) {
        const htmlFallback = await htmlFallbackPath(root, relativePath);
        if (htmlFallback) {
          resolvedFilePath = htmlFallback.filePath;
          stat = htmlFallback.stat;
        }
      }
      if (!stat) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      if (stat.isDirectory()) {
        const directoryIndexPath = path.join(filePath, "index.html");
        const directoryIndexStat = await statOrUndefined(directoryIndexPath);
        if (directoryIndexStat?.isFile()) {
          response.writeHead(302, { Location: `${requestUrl.pathname.replace(/\/?$/, "/")}index.html` });
          response.end();
          return;
        }
        const htmlFallback = await htmlFallbackPath(root, relativePath);
        if (!htmlFallback) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        resolvedFilePath = htmlFallback.filePath;
        stat = htmlFallback.stat;
      }
      if (!stat.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": contentTypeFor(resolvedFilePath) });
      response.end(await fs.readFile(resolvedFilePath));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", (error) => {
      reject(new Error(portErrorMessage(requestedPort, error)));
    });
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  runningServers.set(root, { server, url });
  server.once("close", () => {
    const current = runningServers.get(root);
    if (current?.server === server) runningServers.delete(root);
  });
  const homeUrl = `${url}${urlPathFor(homePage)}`;
  await shell.openExternal(homeUrl);
  return homeUrl;
}

function portErrorMessage(port: number, error: unknown): string {
  if (isNodeError(error) && error.code === "EADDRINUSE") {
    return `预览端口 ${port} 已被占用。请在项目翻译设置中改用其他端口，或关闭占用该端口的程序。`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function getProjectPreviewStatus(project: ProjectConfig): PreviewStatus {
  const root = projectDirs(project).projectRoot;
  const existing = runningServers.get(root);
  if (!existing?.server.listening) return { running: false };
  return {
    running: true,
    url: `${existing.url}${urlPathFor(normalizeHomePage(project.homePage))}`
  };
}

export async function stopProjectGamePreview(project: ProjectConfig): Promise<void> {
  const root = projectDirs(project).projectRoot;
  const existing = runningServers.get(root);
  if (!existing) return;
  runningServers.delete(root);
  await new Promise<void>((resolve, reject) => {
    existing.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function normalizeHomePage(value: string | undefined): string {
  return (value?.trim() || "index.html").replaceAll("\\", "/").replace(/^\/+/, "");
}

function urlPathFor(value: string): string {
  return `/${value.split("/").map(encodeURIComponent).join("/")}`;
}

async function htmlFallbackPath(root: string, relativePath: string): Promise<{ filePath: string; stat: Awaited<ReturnType<typeof fs.stat>> } | undefined> {
  if (!relativePath || relativePath.endsWith("/") || path.extname(relativePath)) return undefined;
  const filePath = path.resolve(root, `${relativePath}.html`);
  if (!isPathInsideOrSame(filePath, root)) return undefined;
  const stat = await statOrUndefined(filePath);
  return stat?.isFile() ? { filePath, stat } : undefined;
}

async function statOrUndefined(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function isPathInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  };
  return types[extension] ?? "application/octet-stream";
}
