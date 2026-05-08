import type { DownloadGameResponse, DownloadProgress } from "itchio-downloader";
import { downloadGame } from "itchio-downloader";
import { net } from "electron";
import { ItchDownloadEvent, ItchDownloadInput, ItchDownloadResult } from "../shared/types";

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export async function downloadItchHtml5Game(
  input: ItchDownloadInput,
  onEvent: (event: ItchDownloadEvent) => void
): Promise<ItchDownloadResult> {
  const url = input.url.trim();
  const outputDirectory = input.outputDirectory.trim();
  if (!/^https:\/\/[^/]+\.itch\.io\/[^/?#]+/i.test(url)) throw new Error("请输入有效的 itch.io 游戏页面地址。");
  if (!outputDirectory) throw new Error("请选择保存目录。");

  const emit = (event: ItchDownloadEvent) => onEvent(event);
  emit({ stream: "system", text: `运行 itchio-downloader --url "${url}" --html5 --downloadDirectory "${outputDirectory}"` });
  emit({ stream: "system", text: "使用 itchio-downloader 库接口执行，并接入 Electron 网络层。" });

  try {
    await preflight(url, emit);
    const result = (await withElectronFetch(() =>
      downloadGame({
        itchGameUrl: url,
        downloadDirectory: outputDirectory,
        html5: true,
        writeMetaData: true,
        onProgress: (progress: DownloadProgress) => {
          const label = progress.fileName || "download";
          emit({ stream: "stdout", text: `${label} ${formatDownloadProgress(progress)}` });
        }
      })
    )) as DownloadGameResponse;

    emit({ stream: result.status ? "stdout" : "stderr", text: result.message });
    if (result.filePath) emit({ stream: "stdout", text: `File: ${result.filePath}` });
    if (result.metadataPath) emit({ stream: "stdout", text: `Metadata: ${result.metadataPath}` });
    if (result.html5Assets?.length) emit({ stream: "stdout", text: `Assets: ${result.html5Assets.length} files` });
    if (result.bytesDownloaded) emit({ stream: "stdout", text: `Size: ${formatBytes(result.bytesDownloaded)}` });

    return {
      status: result.status,
      message: result.message,
      filePath: result.filePath,
      metadataPath: result.metadataPath,
      html5Assets: result.html5Assets,
      bytesDownloaded: result.bytesDownloaded
    };
  } catch (error) {
    const message = describeError(error);
    emit({ stream: "stderr", text: message });
    throw error;
  }
}

async function preflight(url: string, emit: (event: ItchDownloadEvent) => void): Promise<void> {
  try {
    const response = await electronFetch(url, { headers: { "User-Agent": userAgent } });
    emit({ stream: "stdout", text: `预检游戏页面：HTTP ${response.status} ${response.statusText}` });
    if (!response.ok) throw new Error(`游戏页面返回 HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`预检游戏页面失败：${describeError(error)}`, { cause: error });
  }
}

async function withElectronFetch<T>(task: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = electronFetch as typeof fetch;
  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function electronFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = input instanceof URL ? input.toString() : (input as string | Request);
  return net.fetch(target, init as Parameters<typeof net.fetch>[1]);
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
  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}

function formatDownloadProgress(progress: DownloadProgress): string {
  const received = formatBytes(progress.bytesReceived);
  return progress.totalBytes ? `${received} / ${formatBytes(progress.totalBytes)}` : `${received} downloaded`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
