import fs from "node:fs/promises";
import path from "node:path";
import { app, dialog } from "electron";
import { AnalysisResult, CreateProjectInput, ProjectConfig, PromptConfig, PromptScope, ProviderConfig, TextItem } from "../shared/types";
import {
  emptyAnalysis,
  ensureProjectDirs,
  loadSnapshot,
  projectPaths,
  readJson,
  readJsonl,
  saveAnalysis,
  writeJson,
  writeJsonl
} from "./storage";
import { loadActiveChatProviderId, loadActiveProviderId, loadProviders, saveActiveChatProviderId, saveActiveProviderId, saveProviders } from "./credentialService";
import { loadEffectivePrompts, loadPrompts, savePrompts } from "./promptService";
import { loadRecentProjects, recordRecentProject } from "./recentProjects";

export class ProjectService {
  private currentProject: ProjectConfig | null = null;

  get project(): ProjectConfig {
    if (!this.currentProject) throw new Error("No project is open.");
    return this.currentProject;
  }

  async selectDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  }

  async createProject(input: CreateProjectInput) {
    const errors = await this.validateCreateProject(input);
    if (errors.length) throw new Error(errors.join("\n"));
    const projectRoot = path.resolve(input.projectRoot);
    const bgtRoot = path.join(projectRoot, ".bgt");
    const originalRoot = path.join(bgtRoot, "original");
    await copyDirectory(projectRoot, originalRoot);

    const project: ProjectConfig = {
      schemaVersion: 1,
      projectName: input.projectName.trim(),
      projectRoot,
      homePage: "index.html",
      sourceLanguage: input.sourceLanguage || "auto",
      targetLanguage: input.targetLanguage || "zh-CN",
      scanProfile: "web-game-default",
      createdAt: new Date().toISOString()
    };

    await ensureProjectDirs(project);
    await this.writeProjectConfig(project);
    await saveAnalysis(project, emptyAnalysis());
    this.currentProject = project;
    await recordRecentProject(project);
    return this.loadSnapshot(project);
  }

  async openProject(): Promise<ReturnType<typeof loadSnapshot> | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath: app.getPath("documents")
    });
    if (result.canceled) return null;
    return this.openProjectDirectory(result.filePaths[0]);
  }

  async openProjectDirectory(directory: string) {
    const projectFile = path.join(path.resolve(directory), ".bgt", "project.json");
    const storedProject = await readJson<ProjectConfig | null>(projectFile, null);
    if (!storedProject?.projectRoot) throw new Error("Selected folder is not a BrowserGameTranslator project.");
    const sanitizedProject = this.sanitizeProject(this.resolveStoredProject(storedProject, projectFile));
    this.currentProject = sanitizedProject;
    await this.writeProjectConfig(sanitizedProject);
    await recordRecentProject(sanitizedProject);
    return this.loadSnapshot(sanitizedProject);
  }

  async openProjectAt(projectPath: string) {
    const storedProject = await readJson<ProjectConfig | null>(projectPath, null);
    if (!storedProject?.projectRoot) throw new Error("Selected recent project is not valid.");
    const sanitizedProject = this.sanitizeProject(this.resolveStoredProject(storedProject, projectPath));
    this.currentProject = sanitizedProject;
    await this.writeProjectConfig(sanitizedProject);
    await recordRecentProject(sanitizedProject);
    return this.loadSnapshot(sanitizedProject);
  }

  async validateCreateProject(input: CreateProjectInput): Promise<string[]> {
    const errors: string[] = [];
    const projectName = input.projectName.trim();
    const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : "";

    if (!projectName) {
      errors.push("项目名不能为空。");
    } else if (!isLegalDirectoryName(projectName)) {
      errors.push("项目名不是合法目录名。");
    }

    if (!projectRoot) {
      errors.push("源游戏目录不能为空。");
    } else if (!(await isExistingDirectory(projectRoot))) {
      errors.push("源游戏目录不存在。");
    }

    if (projectRoot) {
      const bgtRoot = path.join(projectRoot, ".bgt");
      if (await pathExists(bgtRoot)) errors.push("选中目录已经包含 .bgt 工作区。");
    }

    return errors;
  }

  async refresh() {
    return this.loadSnapshot(this.project);
  }

  async updateProject(project: ProjectConfig) {
    const sanitizedProject = this.sanitizeProject(project);
    this.currentProject = sanitizedProject;
    await this.writeProjectConfig(sanitizedProject);
    return this.loadSnapshot(sanitizedProject);
  }

  async saveProviders(providers: ProviderConfig[]) {
    return saveProviders(providers);
  }

  async saveActiveProviderId(activeProviderId: string) {
    return saveActiveProviderId(activeProviderId);
  }

  async saveActiveChatProviderId(activeChatProviderId: string) {
    return saveActiveChatProviderId(activeChatProviderId);
  }

  async loadPrompts(scope: PromptScope) {
    return loadPrompts(scope, scope === "workspace" ? this.project : undefined);
  }

  async savePrompts(scope: PromptScope, prompts: PromptConfig) {
    return savePrompts(scope, prompts, scope === "workspace" ? this.project : undefined);
  }

  async loadEffectivePrompts() {
    return loadEffectivePrompts(this.currentProject ?? undefined);
  }

  async loadProviderSettings() {
    return {
      providers: await loadProviders(),
      activeProviderId: await loadActiveProviderId(),
      activeChatProviderId: await loadActiveChatProviderId()
    };
  }

  async loadRecentProjects() {
    return loadRecentProjects();
  }

  async saveTextItems(items: TextItem[]) {
    await writeJsonl(projectPaths(this.project).textItems, items);
    return items;
  }

  async saveAnalysis(analysis: AnalysisResult) {
    await saveAnalysis(this.project, analysis);
    return analysis;
  }

  async readAnalysis() {
    return (await loadSnapshot(this.project)).analysis;
  }

  async readTextItems() {
    return readJsonl<TextItem>(projectPaths(this.project).textItems);
  }

  private async loadSnapshot(project: ProjectConfig) {
    const snapshot = await loadSnapshot(project);
    return {
      ...snapshot,
      providers: await loadProviders(),
      activeProviderId: await loadActiveProviderId(),
      activeChatProviderId: await loadActiveChatProviderId(),
      recentProjects: await loadRecentProjects()
    };
  }

  private sanitizeProject(project: ProjectConfig): ProjectConfig {
    const projectRoot = path.resolve(project.projectRoot);
    const expectedBgtRoot = path.join(projectRoot, ".bgt");
    if (path.resolve(projectPaths({ ...project, projectRoot }).project) !== path.resolve(path.join(expectedBgtRoot, "project.json"))) {
      throw new Error("项目结构不符合当前版本：.bgt 必须位于项目根目录内。");
    }
    const sanitizedProject: ProjectConfig = {
      schemaVersion: 1,
      projectName: project.projectName,
      projectRoot,
      homePage: project.homePage || "index.html",
      sourceLanguage: project.sourceLanguage,
      targetLanguage: project.targetLanguage,
      scanProfile: project.scanProfile,
      createdAt: project.createdAt
    };
    return sanitizedProject;
  }

  private resolveStoredProject(project: ProjectConfig, projectFile: string): ProjectConfig {
    const bgtRootFromFile = path.dirname(path.resolve(projectFile));
    const projectRoot = path.dirname(bgtRootFromFile);
    return {
      ...project,
      projectRoot
    };
  }

  private async writeProjectConfig(project: ProjectConfig): Promise<void> {
    await writeJson(projectPaths(project).project, this.toStoredProject(project));
  }

  private toStoredProject(project: ProjectConfig): ProjectConfig {
    return {
      ...project,
      projectRoot: "."
    };
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".bgt" || entry.name === ".git" || entry.name === "node_modules") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

function isLegalDirectoryName(value: string): boolean {
  if (!value || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function isExistingDirectory(value: string): Promise<boolean> {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}
