import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";
import { shell } from "electron";
import { PreviewStatus, ProjectConfig } from "../shared/types";
import { projectDirs } from "./storage";

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

  const existing = runningServers.get(root);
  if (existing?.server.listening) {
    const url = `${existing.url}${urlPathFor(homePage)}`;
    await shell.openExternal(url);
    return url;
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
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        response.writeHead(302, { Location: `${requestUrl.pathname.replace(/\/?$/, "/")}index.html` });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
      response.end(await fs.readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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
