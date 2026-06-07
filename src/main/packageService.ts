import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "7zip-min";
import { PackageFormat, PackageProjectInput, PackageProjectResult, ProjectConfig } from "../shared/types";
import { projectDirs } from "./storage";

const formats = new Set<PackageFormat>(["zip", "7z", "tar.xz"]);
const archiveExcludeArgs = ["-xr!.bgt", "-xr!.git", "-xr!node_modules", "-xr!web-game-download-index.json"];
const packageExcludedNames = new Set([".bgt", ".git", "node_modules", "web-game-download-index.json"]);

export async function packageProject(project: ProjectConfig, input: PackageProjectInput): Promise<PackageProjectResult> {
  const format = formats.has(input.format) ? input.format : "zip";
  const fileName = sanitizeFileName(input.fileName || project.projectName);
  if (!fileName) throw new Error("打包文件名不能为空。");
  const dirs = projectDirs(project);

  const packageRoot = path.resolve(input.outputDirectory?.trim() || dirs.projectRoot);
  await fs.mkdir(packageRoot, { recursive: true });
  const archivePath = path.join(packageRoot, `${fileName}.${format}`);
  await fs.rm(archivePath, { force: true });
  const tempRoot = path.join(dirs.bgtRoot, "package-temp");
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const tempArchivePath = path.join(tempRoot, `${fileName}.${format}`);
  const archiveSourceRoot = input.addLauncher ? await createLauncherStaging(project, fileName) : dirs.projectRoot;

  const binaryPath = getConfig().binaryPath;
  if (!binaryPath) throw new Error("没有找到 7-Zip 可执行文件。");
  try {
    if (format === "tar.xz") {
      const tempTarPath = path.join(tempRoot, `${fileName}.tar`);
      await fs.rm(tempTarPath, { force: true });
      await run7zip(binaryPath, ["a", "-ttar", tempTarPath, "*", ...archiveExcludeArgs], archiveSourceRoot);
      await run7zip(binaryPath, ["a", "-txz", tempArchivePath, tempTarPath], tempRoot);
      await fs.rm(tempTarPath, { force: true });
    } else {
      await run7zip(binaryPath, ["a", `-t${format}`, tempArchivePath, "*", ...archiveExcludeArgs], archiveSourceRoot);
    }
    await moveFile(tempArchivePath, archivePath);
  } finally {
    if (input.addLauncher) await fs.rm(archiveSourceRoot, { recursive: true, force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const stat = await fs.stat(archivePath);
  return { archivePath, format, bytes: stat.size };
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") throw error;
    await fs.copyFile(source, destination);
    await fs.rm(source, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function openProjectDirectory(project: ProjectConfig, shellOpenPath: (path: string) => Promise<string>): Promise<void> {
  const error = await shellOpenPath(projectDirs(project).projectRoot);
  if (error) throw new Error(error);
}

function run7zip(binaryPath: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      reject(new Error(output || `7-zip exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function createLauncherStaging(project: ProjectConfig, fileName: string): Promise<string> {
  const dirs = projectDirs(project);
  const stagingRoot = path.join(dirs.bgtRoot, "package-staging", fileName);
  const webRoot = path.join(stagingRoot, "www");
  const launcherPath = await resolveLauncherExecutable();
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await copyDirectory(dirs.projectRoot, webRoot);
  const launcherFileName = await chooseLauncherFileName(stagingRoot, project.projectName);
  await fs.copyFile(launcherPath, path.join(stagingRoot, launcherFileName));
  await fs.writeFile(
    path.join(stagingRoot, "BGT-Launcher.json"),
    `${JSON.stringify({ rootDirectory: "www", homePage: project.homePage || "index.html" }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(stagingRoot, "README-启动说明.txt"),
    [
      `双击 ${launcherFileName} 启动游戏。`,
      "www 文件夹内是游戏项目文件，请保持它和启动器在同一目录。",
      "启动器会开启本地网页服务器，并用默认浏览器打开游戏首页。",
      "游玩时保持启动器窗口开启。",
      "按 Enter 或关闭窗口停止网页服务。"
    ].join("\r\n"),
    "utf8"
  );
  return stagingRoot;
}

async function chooseLauncherFileName(root: string, projectName: string): Promise<string> {
  const preferred = `${sanitizeFileName(projectName) || "BGT-Launcher"}.exe`;
  if (!(await pathExists(path.join(root, preferred)))) return preferred;
  const fallback = "BGT-Launcher.exe";
  if (!(await pathExists(path.join(root, fallback)))) return fallback;
  for (let index = 0; index < 10; index += 1) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `BGT-Launcher-${suffix}.exe`;
    if (!(await pathExists(path.join(root, candidate)))) return candidate;
  }
  return `BGT-Launcher-${Date.now().toString(36)}.exe`;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (packageExcludedNames.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function resolveLauncherExecutable(): Promise<string> {
  const relativePath = path.join("resources", "launcher", "win-x64", "BGTLauncher.exe");
  const candidates = [
    path.join(process.cwd(), relativePath),
    path.join(__dirname, "..", "..", relativePath),
    path.join(process.resourcesPath, relativePath),
    path.join(process.resourcesPath, "launcher", "win-x64", "BGTLauncher.exe")
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next dev/packaged location.
    }
  }
  throw new Error(`没有找到内置启动器：${relativePath}`);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
}
