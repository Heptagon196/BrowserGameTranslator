import path from "node:path";
import type { App } from "electron";
import { configureElectronCdp, createHiddenSearchCdpTarget, resolveElectronCdpEndpoint } from "./electronCdp";

const readyMessageType = "bgt-web-search-cdp-ready";

export function isWebSearchCdpHostProcess(): boolean {
  return process.env.BGT_WEB_SEARCH_CDP_HOST === "1";
}

export async function runWebSearchCdpHost(app: App): Promise<void> {
  const userData = path.join(app.getPath("userData"), "web-search-cdp-host");
  app.setPath("userData", userData);
  configureElectronCdp(app);
  await app.whenReady();
  await createHiddenSearchCdpTarget();
  const endpoint = await resolveElectronCdpEndpoint(app);
  if (!endpoint) throw new Error("Failed to resolve Electron CDP endpoint.");
  process.stdout.write(`${JSON.stringify({ type: readyMessageType, endpoint })}\n`);
}
