import net from "node:net";

export const minUserPort = 1;
export const maxPreviewPort = 65535;
export const minRandomPreviewPort = 10001;

export function normalizePreviewPort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < minUserPort || port > maxPreviewPort) return undefined;
  return port;
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePreviewPort(): Promise<number> {
  const tried = new Set<number>();
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const port = randomPreviewPort();
    tried.add(port);
    if (await isPortAvailable(port)) return port;
  }
  for (let port = minRandomPreviewPort; port <= maxPreviewPort; port += 1) {
    if (tried.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("没有找到可用的预览端口。");
}

function randomPreviewPort(): number {
  return minRandomPreviewPort + Math.floor(Math.random() * (maxPreviewPort - minRandomPreviewPort + 1));
}
