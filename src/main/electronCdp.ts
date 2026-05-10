import { BrowserWindow, type App } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const devToolsActivePortFile = "DevToolsActivePort";
let searchCdpWindow: BrowserWindow | null = null;

export function configureElectronCdp(app: App): void {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", "0");
}

export async function resolveElectronCdpEndpoint(app: App): Promise<string | undefined> {
  if (process.env.BGT_ELECTRON_CDP_ENDPOINT) return process.env.BGT_ELECTRON_CDP_ENDPOINT;
  const filePath = path.join(app.getPath("userData"), devToolsActivePortFile);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const endpoint = await readDevToolsEndpoint(filePath);
    if (endpoint) {
      process.env.BGT_ELECTRON_CDP_ENDPOINT = endpoint;
      return endpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export async function createHiddenSearchCdpTarget(): Promise<void> {
  if (searchCdpWindow && !searchCdpWindow.isDestroyed()) return;
  searchCdpWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    skipTaskbar: true,
    title: "BrowserGameTranslator Web Search",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  searchCdpWindow.on("closed", () => {
    searchCdpWindow = null;
  });
  await searchCdpWindow.loadURL("about:blank");
}

async function readDevToolsEndpoint(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const [portLine] = content.split(/\r?\n/);
    const port = Number(portLine);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? `http://127.0.0.1:${port}` : undefined;
  } catch {
    return undefined;
  }
}
