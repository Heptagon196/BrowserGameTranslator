import fs from "node:fs/promises";
import path from "node:path";
import { dialog } from "electron";
import { ProjectConfig, TextItem } from "../shared/types";
import { projectDirs, projectPaths, readJsonl, sha256, writeJsonl } from "./storage";

export async function exportTextItems(project: ProjectConfig, items: TextItem[], format: "jsonl" | "csv"): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(projectDirs(project).projectRoot, `translations.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (result.canceled || !result.filePath) return null;
  if (format === "jsonl") {
    await writeJsonl(result.filePath, items);
  } else {
    await fs.writeFile(result.filePath, toCsv(items), "utf8");
  }
  return result.filePath;
}

export async function importTextItems(project: ProjectConfig): Promise<TextItem[]> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Translation files", extensions: ["jsonl", "csv"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (result.canceled) return readJsonl<TextItem>(projectPaths(project).textItems);
  const filePath = result.filePaths[0];
  const current = await readJsonl<TextItem>(projectPaths(project).textItems);
  const incoming = filePath.toLowerCase().endsWith(".csv") ? await fromCsv(filePath) : await readJsonl<Partial<TextItem>>(filePath);
  const byId = new Map(current.map((item) => [item.id, item]));
  const byHash = new Map(current.map((item) => [`${sha256(item.original)}|${item.sourceFile}|${item.locator}`, item]));
  for (const row of incoming) {
    const rowHash = row.original ? sha256(row.original) : "";
    const match = (row.id && byId.get(row.id)) || byHash.get(`${rowHash}|${row.sourceFile}|${row.locator}`);
    if (match) {
      match.translation = String(row.translation ?? match.translation ?? "");
      match.status = match.translation ? "translated" : match.status;
    }
  }
  await writeJsonl(projectPaths(project).textItems, current);
  return current;
}

function toCsv(items: TextItem[]): string {
  const rows = [["id", "sourceFile", "locator", "original", "translation", "status"], ...items.map((item) => [item.id, item.sourceFile, item.locator, item.original, item.translation, item.status])];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

async function fromCsv(filePath: string): Promise<Partial<TextItem>[]> {
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift() ?? "");
  return lines.map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, index) => (row[key] = values[index] ?? ""));
    return row as Partial<TextItem>;
  });
}

function csvCell(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
