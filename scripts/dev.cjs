const { spawn } = require("node:child_process");
const net = require("node:net");
const electron = require("electron");
const { createServer } = require("vite");

const host = "127.0.0.1";
const preferredPort = Number(process.env.BGT_DEV_PORT || 5173);
const maxPortAttempts = 20;

function normalizeUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function resolveDevServerUrl(server) {
  const urls = server.resolvedUrls;
  const local = urls?.local?.find((url) => url.includes(host)) ?? urls?.local?.[0];
  if (!local) {
    const address = server.httpServer?.address();
    if (address && typeof address === "object") {
      return `http://${host}:${address.port}`;
    }
    throw new Error("Vite dev server did not expose a local URL.");
  }
  return normalizeUrl(local);
}

async function main() {
  const viteServer = await startViteServer();
  viteServer.printUrls();

  const devServerUrl = resolveDevServerUrl(viteServer);
  const env = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, ["."], {
    env,
    stdio: "inherit",
    windowsHide: false
  });

  const shutdown = async (code = 0) => {
    await viteServer.close();
    process.exit(code);
  };

  child.on("exit", (code) => {
    void shutdown(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(error);
    void shutdown(1);
  });

  process.on("SIGINT", () => {
    child.kill();
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    child.kill();
    void shutdown(0);
  });
}

async function startViteServer() {
  let lastError;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    const port = preferredPort + offset;
    let server;
    try {
      server = await createServer({
        configFile: "vite.config.ts",
        server: {
          host,
          port,
          strictPort: true
        }
      });
      await server.listen();
      if (offset > 0) {
        console.warn(`[dev] Port ${preferredPort} unavailable; using ${port}.`);
      }
      return server;
    } catch (error) {
      lastError = error;
      await server?.close().catch(() => undefined);
      if (!isPortListenError(error)) throw error;
      if (error.code === "EACCES") {
        console.warn(`[dev] Cannot listen on ${host}:${port} (${error.code}); falling back to an OS-assigned port.`);
        return startViteServerOnRandomPort(error);
      }
      console.warn(`[dev] Cannot listen on ${host}:${port} (${error.code}); trying next port.`);
    }
  }
  return startViteServerOnRandomPort(lastError);
}

async function startViteServerOnRandomPort(cause) {
  const port = await allocateRandomPort();
  let server;
  try {
    server = await createServer({
      configFile: "vite.config.ts",
      server: {
        host,
        port,
        strictPort: true
      }
    });
    await server.listen();
    const url = resolveDevServerUrl(server);
    console.warn(`[dev] Falling back to OS-assigned port: ${url}.`);
    return server;
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (cause) {
      console.error("[dev] OS-assigned port fallback also failed.");
    }
    throw error;
  }
}

function isPortListenError(error) {
  return error && (error.code === "EACCES" || error.code === "EADDRINUSE");
}

function allocateRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate an OS-assigned port."));
        }
      });
    });
    server.listen(0, host);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
