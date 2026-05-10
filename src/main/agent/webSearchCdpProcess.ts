import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";

type CdpHostReadyMessage = {
  type?: string;
  endpoint?: string;
};

let hostProcess: ChildProcess | null = null;
let endpointPromise: Promise<string | undefined> | null = null;
let stderrTail = "";
let idleTimer: NodeJS.Timeout | null = null;
const idleShutdownMs = 120_000;

export async function getWebSearchCdpEndpoint(): Promise<string | undefined> {
  clearIdleTimer();
  if (endpointPromise) return endpointPromise;
  endpointPromise = startWebSearchCdpHost().catch((error) => {
    stopWebSearchCdpHost();
    endpointPromise = null;
    console.warn("Electron web search CDP host is unavailable, falling back to request mode:", error);
    return undefined;
  });
  return endpointPromise;
}

export function scheduleWebSearchCdpIdleShutdown(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    stopWebSearchCdpHost();
  }, idleShutdownMs);
  idleTimer.unref?.();
}

function startWebSearchCdpHost(): Promise<string> {
  if (hostProcess) return Promise.reject(new Error("CDP host process exists without a ready endpoint."));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BGT_WEB_SEARCH_CDP_HOST: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  hostProcess = child;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while starting Electron CDP host. ${stderrTail}`.trim()));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: string) => {
      stdoutBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) return;
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const endpoint = parseReadyEndpoint(line);
        if (!endpoint) continue;
        cleanup();
        child.once("exit", () => {
          if (hostProcess === child) {
            hostProcess = null;
            endpointPromise = null;
          }
        });
        resolve(endpoint);
      }
    };
    const onStderr = (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8000);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      hostProcess = null;
      cleanup();
      reject(new Error(`Electron CDP host exited with code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}. ${stderrTail}`.trim()));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function stopWebSearchCdpHost(): void {
  clearIdleTimer();
  hostProcess?.kill();
  hostProcess = null;
  endpointPromise = null;
  stderrTail = "";
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function parseReadyEndpoint(line: string): string | undefined {
  try {
    const message = JSON.parse(line) as CdpHostReadyMessage;
    return message.type === "bgt-web-search-cdp-ready" && typeof message.endpoint === "string" ? message.endpoint : undefined;
  } catch {
    stderrTail = `${stderrTail}\n${line}`.slice(-8000);
    return undefined;
  }
}
