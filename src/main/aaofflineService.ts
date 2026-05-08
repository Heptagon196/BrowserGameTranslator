import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { AaOfflineDownloadEvent, AaOfflineDownloadInput, AaOfflineDownloadResult } from "../shared/types";

const userScriptOptions = new Set(["none", "all", "backlog", "better-layout", "keyboard-controls", "alt-nametag"]);

export async function downloadAaOnlineGame(
  input: AaOfflineDownloadInput,
  onEvent: (event: AaOfflineDownloadEvent) => void
): Promise<AaOfflineDownloadResult> {
  const caseUrlOrId = input.caseUrlOrId.trim();
  const outputPath = input.outputPath.trim();
  const language = "en";
  const playerVersion = input.playerVersion.trim() || "master";
  const concurrentDownloads = Math.max(1, Math.min(32, Math.floor(input.concurrentDownloads || 5)));
  const withUserscripts = userScriptOptions.has(input.withUserscripts) ? input.withUserscripts : "all";

  if (!caseUrlOrId) throw new Error("请输入 AAOnline 案件 URL 或 trial ID。");
  if (!/^(\d+|https:\/\/aaonline\.fr\/player\.php\?trial_id=\d+)/i.test(caseUrlOrId)) {
    throw new Error("请输入有效的 AAOnline 案件 URL 或 trial ID。");
  }
  const outputErrors = await validateAaOfflineOutputDirectory(outputPath);
  if (outputErrors.length) throw new Error(outputErrors.join("\n"));

  const executable = await resolveAaofflineExecutable();

  const args = [
    "--output",
    outputPath,
    "--language",
    language,
    "--player-version",
    playerVersion,
    "--concurrent-downloads",
    String(concurrentDownloads),
    "--sequence",
    "single",
    "--sequence-error-handling",
    "abort"
  ];
  if (input.continueOnAssetError) args.push("--continue-on-asset-error");
  if (withUserscripts !== "none") args.push(`--with-userscripts=${withUserscripts}`);
  args.push(caseUrlOrId);

  const logs: AaOfflineDownloadEvent[] = [];
  const emit = (event: AaOfflineDownloadEvent) => {
    logs.push(event);
    onEvent(event);
  };
  emit({ stream: "system", text: `运行 ${path.basename(executable)} ${args.join(" ")}` });

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });

    child.stdout.on("data", (chunk: Buffer) => emit({ stream: "stdout", text: chunk.toString("utf8") }));
    child.stderr.on("data", (chunk: Buffer) => emit({ stream: "stderr", text: chunk.toString("utf8") }));
    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => {
      const status = exitCode === 0;
      resolve({
        status,
        message: status ? "AAOnline 案件下载完成。" : `aaoffline 退出码 ${exitCode ?? "未知"}。`,
        outputPath,
        exitCode,
        logs
      });
    });
  });
}

export async function validateAaOfflineOutputDirectory(outputPath: string): Promise<string[]> {
  const errors: string[] = [];
  const resolved = outputPath.trim();
  if (!resolved) return ["请选择输出目录。"];
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return ["输出路径必须是文件夹。"];
    const entries = await fs.readdir(resolved);
    if (entries.length > 0) errors.push("输出目录必须为空。");
  } catch {
    errors.push("输出目录不存在。");
  }
  return errors;
}

async function resolveAaofflineExecutable(): Promise<string> {
  const executableName = process.platform === "win32" ? "aaoffline.exe" : "aaoffline";
  const platformDirectory = process.platform === "win32" ? "win-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64";
  const relativePath = path.join("resources", "bin", "aaoffline", platformDirectory, executableName);
  const candidates = [
    path.join(process.cwd(), relativePath),
    path.join(app.getAppPath(), relativePath),
    path.join(process.resourcesPath, relativePath),
    path.join(process.resourcesPath, "bin", "aaoffline", platformDirectory, executableName)
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next packaged/dev location.
    }
  }
  throw new Error(`没有找到内置 aaoffline CLI：${relativePath}`);
}
