import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { app, BrowserWindow } from "electron";
import type { UpdateInfo, VelopackAsset } from "velopack";
import { UpdateManager, VelopackApp } from "velopack";
import type { AppVersionInfo, UpdateCheckResult, UpdateDescriptor, UpdateDownloadProgress } from "../shared/types";
import { networkFetch } from "./networkProxyService";

const githubRepoUrl = "https://github.com/Heptagon196/BrowserGameTranslator";
const releasesApiUrl = "https://api.github.com/repos/Heptagon196/BrowserGameTranslator/releases?per_page=20";
const releaseFeedAssetName = "releases.win.json";
let updateDownloadPromise: Promise<void> | null = null;

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
    const releases = await fetchGitHubReleases();
    const release = releases[0];
    if (!release) throw new Error("GitHub Releases 中没有可用的稳定版本。");
    const feedAsset = release.assets.find((asset) => asset.name === releaseFeedAssetName);
    if (!feedAsset) {
      return {
        currentVersion: versionInfo.currentVersion,
        installedByUpdater: true,
        hasUpdate: false,
        error: missingReleaseFeedMessage(release)
      };
    }

    const update = await checkGitHubReleaseForUpdate(versionInfo, release, releases, feedAsset);
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
  if (updateDownloadPromise) return updateDownloadPromise;
  updateDownloadPromise = runUpdateDownload(update).finally(() => {
    updateDownloadPromise = null;
  });
  return updateDownloadPromise;
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

async function runUpdateDownload(update: unknown): Promise<void> {
  const githubUpdate = asGitHubUpdatePayload(update);
  if (githubUpdate) {
    if (githubUpdate.updateInfo.DeltasToTarget.length > 0) {
      try {
        await downloadDeltaUpdateWithVelopack(githubUpdate);
        publishDownloadProgress({ percent: 100 });
        return;
      } catch (error) {
        console.warn(`Velopack delta update failed, falling back to full package: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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

function publishDownloadProgress(progress: UpdateDownloadProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send("updates:download-progress", progress);
  }
}

async function fetchGitHubReleases(): Promise<LatestGitHubRelease[]> {
  const response = await networkFetch(releasesApiUrl, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "BrowserGameTranslator"
    }
  });
  if (!response.ok) throw new Error(`GitHub Releases 读取失败：HTTP ${response.status}`);
  const payload = await response.json() as Array<{
    assets?: Array<{ browser_download_url?: unknown; name?: unknown; size?: unknown }>;
    body?: unknown;
    draft?: unknown;
    html_url?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
  }>;
  if (!Array.isArray(payload)) throw new Error("GitHub Releases 返回格式不正确。");
  return payload
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      body: typeof release.body === "string" ? release.body : "",
      htmlUrl: typeof release.html_url === "string" ? release.html_url : "",
      tagName: typeof release.tag_name === "string" ? release.tag_name : "",
      assets: normalizeGitHubReleaseAssets(release.assets)
    }));
}

function normalizeGitHubReleaseAssets(assets: unknown): GitHubReleaseAsset[] {
  return Array.isArray(assets)
    ? assets
      .map((asset) => {
        const value = asset as { browser_download_url?: unknown; name?: unknown; size?: unknown };
        return {
          browserDownloadUrl: typeof value.browser_download_url === "string" ? value.browser_download_url : "",
          name: typeof value.name === "string" ? value.name : "",
          size: typeof value.size === "number" ? value.size : 0
        };
      })
      .filter((asset) => asset.name.length > 0 && asset.browserDownloadUrl.length > 0)
    : [];
}

function missingReleaseFeedMessage(release: LatestGitHubRelease): string {
  const assetNames = release.assets.map((asset) => asset.name);
  const assetList = assetNames.length > 0 ? `当前资产：${assetNames.join("、")}。` : "当前 Release 没有上传资产。";
  const releaseName = release.tagName || release.htmlUrl || "最新 Release";
  return `GitHub ${releaseName} 缺少 Velopack 更新索引 ${releaseFeedAssetName}，无法应用内检查更新。请把 release/velopack/${releaseFeedAssetName} 和对应的 .nupkg 一起上传到最新 Release。${assetList}`;
}

async function checkGitHubReleaseForUpdate(versionInfo: AppVersionInfo, release: LatestGitHubRelease, releases: LatestGitHubRelease[], feedAsset: GitHubReleaseAsset): Promise<GitHubUpdatePayload | null> {
  const feed = await fetchVelopackAssetFeed(feedAsset);
  const packageUrls = Object.fromEntries(releases.flatMap((entry) => entry.assets).map((asset) => [asset.name, asset.browserDownloadUrl]));
  const appId = versionInfo.appId;
  const releaseAssets = (feed.Assets ?? [])
    .filter((asset) => !appId || asset.PackageId === appId);
  const updateInfo = await resolveUpdateInfoWithVelopack(releaseAssets);
  if (!updateInfo) return null;
  if (!packageUrls[updateInfo.TargetFullRelease.FileName]) {
    throw new Error(`GitHub Release 中的 ${releaseFeedAssetName} 指向 ${updateInfo.TargetFullRelease.FileName}，但 Release 资产里没有上传这个文件。`);
  }
  return {
    source: "github-release",
    updateInfo,
    packageUrls
  };
}

async function resolveUpdateInfoWithVelopack(assets: VelopackAsset[]): Promise<UpdateInfo | null> {
  const sourceDir = await mkdtemp(join(tmpdir(), "bgt-velopack-feed-"));
  try {
    await writeReleaseFeed(sourceDir, assets);
    return await new UpdateManager(sourceDir).checkForUpdatesAsync();
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

async function fetchVelopackAssetFeed(asset: GitHubReleaseAsset): Promise<VelopackAssetFeed> {
  const response = await networkFetch(asset.browserDownloadUrl, {
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

async function downloadDeltaUpdateWithVelopack(update: GitHubUpdatePayload): Promise<void> {
  const sourceDir = await mkdtemp(join(tmpdir(), "bgt-velopack-delta-"));
  try {
    await writeReleaseFeed(sourceDir, [
      update.updateInfo.BaseRelease,
      ...update.updateInfo.DeltasToTarget,
      update.updateInfo.TargetFullRelease
    ].filter(Boolean) as VelopackAsset[]);
    const assets = update.updateInfo.DeltasToTarget;
    const totalBytes = assets.reduce((sum, asset) => sum + Math.max(asset.Size, 0), 0);
    let completedBytes = 0;
    for (const asset of assets) {
      const url = update.packageUrls[asset.FileName];
      if (!url) throw new Error(`GitHub Release 缺少增量更新包 ${asset.FileName}。`);
      const destination = join(sourceDir, asset.FileName);
      await downloadFile(url, destination, asset.Size, (bytes) => {
        if (totalBytes > 0) publishDownloadProgress({ percent: Math.min(70, Math.round(((completedBytes + bytes) / totalBytes) * 70)) });
      });
      await verifyPackage(destination, asset);
      completedBytes += Math.max(asset.Size, 0);
    }
    await new UpdateManager(sourceDir).downloadUpdateAsync(update.updateInfo, (percent) => {
      publishDownloadProgress({ percent: Math.min(99, 70 + Math.round(percent * 0.29)) });
    });
    await verifyPackage(join(getVelopackPackagesDir(), update.updateInfo.TargetFullRelease.FileName), update.updateInfo.TargetFullRelease);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

async function writeReleaseFeed(sourceDir: string, assets: VelopackAsset[]): Promise<void> {
  await writeFile(join(sourceDir, releaseFeedAssetName), JSON.stringify({ Assets: assets }), "utf-8");
}

async function downloadFile(url: string, destination: string, expectedSize?: number, onProgress?: (bytes: number) => void): Promise<void> {
  const response = await networkFetch(url, {
    headers: {
      "User-Agent": "BrowserGameTranslator"
    }
  });
  if (!response.ok) throw new Error(`GitHub Release 下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("GitHub Release 下载失败：响应体为空。");
  const total = expectedSize || Number(response.headers.get("content-length")) || 0;
  let downloaded = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded);
      else if (total > 0) publishDownloadProgress({ percent: Math.min(99, Math.round((downloaded / total) * 100)) });
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), progress, createWriteStream(destination));
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
