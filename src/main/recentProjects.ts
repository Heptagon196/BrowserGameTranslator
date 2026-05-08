import path from "node:path";
import { app } from "electron";
import { ProjectConfig, RecentProject } from "../shared/types";
import { projectDirs, readJson, writeJson } from "./storage";

function recentProjectsPath(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

export async function loadRecentProjects(): Promise<RecentProject[]> {
  const projects = await readJson<RecentProject[]>(recentProjectsPath(), []);
  return Promise.all(
    projects.map(async (project) => ({
      ...project,
      exists: await pathExists(project.projectPath)
    }))
  );
}

export async function recordRecentProject(project: ProjectConfig): Promise<RecentProject[]> {
  const dirs = projectDirs(project);
  const projectPath = path.join(dirs.bgtRoot, "project.json");
  const current = await loadRecentProjects();
  const next: RecentProject[] = [
    {
      projectName: project.projectName,
      projectRoot: dirs.projectRoot,
      projectPath,
      lastOpenedAt: new Date().toISOString(),
      exists: true
    },
    ...current.filter((entry) => entry.projectPath !== projectPath)
  ].slice(0, 10);
  await writeJson(recentProjectsPath(), next);
  return next;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.access(value));
    return true;
  } catch {
    return false;
  }
}
