import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow } from "electron";
import type { UpdateInfo, VelopackAsset } from "velopack";
import { UpdateManager, VelopackApp } from "velopack";
import type { AppVersionInfo, UpdateCheckResult, UpdateDescriptor, UpdateDownloadProgress } from "../shared/types";

const githubRepoUrl = "https://github.com/Heptagon196/BrowserGameTranslator";
const latestReleaseApiUrl = "https://api.github.com/repos/Heptagon196/BrowserGameTranslator/releases/latest";
const releaseFeedAssetName = "releases.win.json";

interface GitHubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

interface LatestGitHubRelease {
  body: string;
  htmlUrl: string;
  tagName: string;
  assets: GitHubReleaseAsset[];
}

interface VelopackAssetFeed {
  Assets?: VelopackAsset[];
}

interface GitHubUpdatePayload {
  source: "github-release";
  updateInfo: UpdateInfo;
  packageUrls: Record<string, string>;
}

export function runVelopackStartup(): void {
  try {
    VelopackApp.build()
      .setLogger((level, message) => {
        if (level === "error" || level === "warn") console.warn(`[velopack:${level}] ${message}`);
        else console.debug(`[velopack:${level}] ${message}`);
      })
      .run();
  } catch (error) {
    console.warn(`Velopack startup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getAppVersionInfo(): AppVersionInfo {
  try {
    const manager = createUpdateManager();
    const pending = manager.getUpdatePendingRestart();
    return {
      currentVersion: manager.getCurrentVersion(),
      installedByUpdater: true,
      isPortable: manager.isPortable(),
      appId: manager.getAppId(),
      updatePendingRestart: pending ? descriptorFromAsset(pending) : undefined
    };
  } catch (error) {
    return {
      currentVersion: app.getVersion(),
      installedByUpdater: false,
      error: userFacingUpdateError(error)
    };
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const versionInfo = getAppVersionInfo();
  if (!versionInfo.installedByUpdater) {
    return {
      currentVersion: versionInfo.currentVersion,
      installedByUpdater: false,
      hasUpdate: false,
      error: versionInfo.error ?? "当前运行环境不支持应用内更新。"
    };
  }

  try {
    const release = await fetchLatestGitHubRelease();
    const feedAsset = release.assets.find((asset) => asset.name === releaseFeedAssetName);
    if (!feedAsset) {
      return {
        currentVersion: versionInfo.currentVersion,
        installedByUpdater: true,
        hasUpdate: false,
        error: missingReleaseFeedMessage(release)
      };
    }

    const update = await checkGitHubReleaseForUpdate(versionInfo, release, feedAsset);
    return {
      currentVersion: versionInfo.currentVersion,
      installedByUpdater: true,
      hasUpdate: Boolean(update),
      update: update ? descriptorFromUpdate(update, release) : undefined
    };
  } catch (error) {
    return {
      currentVersion: versionInfo.currentVersion,
      installedByUpdater: true,
      hasUpdate: false,
      error: userFacingUpdateError(error)
    };
  }
}

export async function downloadUpdate(update: unknown): Promise<void> {
  const githubUpdate = asGitHubUpdatePayload(update);
  if (githubUpdate) {
    const target = githubUpdate.updateInfo.TargetFullRelease;
    const downloadUrl = githubUpdate.packageUrls[target.FileName];
    if (!downloadUrl) throw new Error(`GitHub Release 缺少更新包 ${target.FileName}。`);
    const packagePath = join(getVelopackPackagesDir(), target.FileName);
    await mkdir(dirname(packagePath), { recursive: true });
    await downloadFile(downloadUrl, packagePath, target.Size);
    await verifyPackage(packagePath, target);
    publishDownloadProgress({ percent: 100 });
    return;
  }

  await createUpdateManager().downloadUpdateAsync(update as UpdateInfo, (percent) => {
    publishDownloadProgress({ percent });
  });
  publishDownloadProgress({ percent: 100 });
}

export function applyUpdate(update: unknown): void {
  const githubUpdate = asGitHubUpdatePayload(update);
  createUpdateManager().waitExitThenApplyUpdate(githubUpdate ? githubUpdate.updateInfo : update as UpdateInfo, false, true);
  app.quit();
}

function createUpdateManager(): UpdateManager {
  return new UpdateManager(githubRepoUrl);
}

function descriptorFromUpdate(payload: GitHubUpdatePayload, release: LatestGitHubRelease): UpdateDescriptor {
  const update = payload.updateInfo;
  const target = update.TargetFullRelease;
  return {
    targetVersion: target.Version,
    releaseNotes: release.body.trim() || target.NotesMarkdown || undefined,
    releaseNotesHtml: target.NotesHtml || undefined,
    releaseUrl: release.htmlUrl,
    packageFileName: target.FileName,
    packageSize: target.Size,
    raw: payload
  };
}

function descriptorFromAsset(asset: VelopackAsset): UpdateDescriptor {
  return {
    targetVersion: asset.Version,
    releaseNotes: asset.NotesMarkdown || undefined,
    releaseNotesHtml: asset.NotesHtml || undefined,
    packageFileName: asset.FileName,
    packageSize: asset.Size,
    raw: asset
  };
}

function publishDownloadProgress(progress: UpdateDownloadProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send("updates:download-progress", progress);
  }
}

async function fetchLatestGitHubRelease(): Promise<LatestGitHubRelease> {
  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "BrowserGameTranslator"
    }
  });
  if (!response.ok) throw new Error(`GitHub Release 读取失败：HTTP ${response.status}`);
  const payload = await response.json() as {
    assets?: Array<{ browser_download_url?: unknown; name?: unknown; size?: unknown }>;
    body?: unknown;
    html_url?: unknown;
    tag_name?: unknown;
  };
  const assets = Array.isArray(payload.assets)
    ? payload.assets
      .map((asset) => ({
        browserDownloadUrl: typeof asset.browser_download_url === "string" ? asset.browser_download_url : "",
        name: typeof asset.name === "string" ? asset.name : "",
        size: typeof asset.size === "number" ? asset.size : 0
      }))
      .filter((asset) => asset.name.length > 0 && asset.browserDownloadUrl.length > 0)
    : [];
  return {
    body: typeof payload.body === "string" ? payload.body : "",
    htmlUrl: typeof payload.html_url === "string" ? payload.html_url : "",
    tagName: typeof payload.tag_name === "string" ? payload.tag_name : "",
    assets
  };
}

function missingReleaseFeedMessage(release: LatestGitHubRelease): string {
  const assetNames = release.assets.map((asset) => asset.name);
  const assetList = assetNames.length > 0 ? `当前资产：${assetNames.join("、")}。` : "当前 Release 没有上传资产。";
  const releaseName = release.tagName || release.htmlUrl || "最新 Release";
  return `GitHub ${releaseName} 缺少 Velopack 更新索引 ${releaseFeedAssetName}，无法应用内检查更新。请把 release/velopack/${releaseFeedAssetName} 和对应的 .nupkg 一起上传到最新 Release。${assetList}`;
}

async function checkGitHubReleaseForUpdate(versionInfo: AppVersionInfo, release: LatestGitHubRelease, feedAsset: GitHubReleaseAsset): Promise<GitHubUpdatePayload | null> {
  const feed = await fetchVelopackAssetFeed(feedAsset);
  const packageUrls = Object.fromEntries(release.assets.map((asset) => [asset.name, asset.browserDownloadUrl]));
  const appId = versionInfo.appId;
  const fullReleases = (feed.Assets ?? [])
    .filter((asset) => asset.Type.toLowerCase() === "full")
    .filter((asset) => !appId || asset.PackageId === appId)
    .filter((asset) => compareVersions(asset.Version, versionInfo.currentVersion) > 0)
    .sort((left, right) => compareVersions(right.Version, left.Version));
  const target = fullReleases[0];
  if (!target) return null;
  if (!packageUrls[target.FileName]) {
    throw new Error(`GitHub Release 中的 ${releaseFeedAssetName} 指向 ${target.FileName}，但最新 Release 没有上传这个资产。`);
  }
  return {
    source: "github-release",
    updateInfo: {
      TargetFullRelease: target,
      DeltasToTarget: [],
      IsDowngrade: false
    },
    packageUrls
  };
}

async function fetchVelopackAssetFeed(asset: GitHubReleaseAsset): Promise<VelopackAssetFeed> {
  const response = await fetch(asset.browserDownloadUrl, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "BrowserGameTranslator"
    }
  });
  if (!response.ok) throw new Error(`Velopack 更新索引读取失败：HTTP ${response.status}`);
  const feed = await response.json() as VelopackAssetFeed;
  if (!Array.isArray(feed.Assets)) throw new Error(`${releaseFeedAssetName} 格式不正确：缺少 Assets 数组。`);
  return feed;
}

function asGitHubUpdatePayload(update: unknown): GitHubUpdatePayload | null {
  if (!update || typeof update !== "object") return null;
  const payload = update as Partial<GitHubUpdatePayload>;
  if (payload.source !== "github-release") return null;
  if (!payload.updateInfo || typeof payload.updateInfo !== "object") return null;
  if (!payload.packageUrls || typeof payload.packageUrls !== "object") return null;
  return payload as GitHubUpdatePayload;
}

function getVelopackPackagesDir(): string {
  const exeDir = dirname(app.getPath("exe"));
  const manifestPath = join(exeDir, "sq.version");
  if (existsSync(manifestPath)) return join(dirname(exeDir), "packages");
  return join(exeDir, "packages");
}

async function downloadFile(url: string, destination: string, expectedSize?: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = (currentUrl: string, redirectCount: number) => {
      const parsed = new URL(currentUrl);
      const transport = parsed.protocol === "http:" ? http : https;
      const req = transport.get(parsed, { headers: { "User-Agent": "BrowserGameTranslator" } }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount <= 0) {
            reject(new Error("GitHub Release 下载重定向次数过多。"));
            return;
          }
          request(new URL(response.headers.location, currentUrl).toString(), redirectCount - 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GitHub Release 下载失败：HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        const total = expectedSize || Number(response.headers["content-length"]) || 0;
        let downloaded = 0;
        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (total > 0) publishDownloadProgress({ percent: Math.min(99, Math.round((downloaded / total) * 100)) });
        });
        pipeline(response, createWriteStream(destination)).then(resolve, reject);
      });
      req.on("error", reject);
    };
    request(url, 5);
  });
}

async function verifyPackage(filePath: string, asset: VelopackAsset): Promise<void> {
  const fileStat = await stat(filePath);
  if (asset.Size > 0 && fileStat.size !== asset.Size) {
    throw new Error(`更新包大小校验失败：期望 ${asset.Size} 字节，实际 ${fileStat.size} 字节。`);
  }
  if (asset.SHA256) {
    const sha256 = await hashFile(filePath, "sha256");
    if (sha256 !== asset.SHA256.toUpperCase()) throw new Error("更新包 SHA256 校验失败。");
  } else if (asset.SHA1) {
    const sha1 = await hashFile(filePath, "sha1");
    if (sha1 !== asset.SHA1.toUpperCase()) throw new Error("更新包 SHA1 校验失败。");
  }
}

async function hashFile(filePath: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex").toUpperCase();
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < Math.max(leftParts.numbers.length, rightParts.numbers.length); index += 1) {
    const diff = (leftParts.numbers[index] ?? 0) - (rightParts.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return leftParts.prerelease.localeCompare(rightParts.prerelease);
}

function parseVersion(version: string): { numbers: number[]; prerelease: string } {
  const [core, prerelease = ""] = version.split("-", 2);
  return {
    numbers: core.split(".").map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0),
    prerelease
  };
}

function userFacingUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not properly installed|auto-locate app manifest|app manifest/i.test(message)) {
    return "当前运行环境没有 Velopack 应用清单，应用内更新仅在发布版中可用。";
  }
  if (/http status:\s*404|status:\s*404|HTTP\s*404|404/i.test(message)) {
    return `GitHub Releases 上没有找到 Velopack 更新索引 ${releaseFeedAssetName}。请确认最新 Release 已上传 release/velopack/${releaseFeedAssetName} 和对应的 .nupkg。`;
  }
  return message || "更新组件返回了未知错误。";
}
