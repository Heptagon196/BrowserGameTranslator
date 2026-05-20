import fs from "node:fs/promises";
import path from "node:path";
import { app, net, session } from "electron";
import type { NetworkProxySettings } from "../shared/types";

const settingsFileName = "network-proxy-settings.json";
const initialProxyEnv = captureProxyEnv();

export const defaultNetworkProxySettings: NetworkProxySettings = {
  schemaVersion: 1,
  enabled: false,
  protocol: "http",
  host: "",
  port: 7890,
  bypassList: "localhost;127.0.0.1;<local>"
};

export async function loadNetworkProxySettings(): Promise<NetworkProxySettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf-8");
    return normalizeNetworkProxySettings(JSON.parse(raw) as Partial<NetworkProxySettings>);
  } catch {
    return defaultNetworkProxySettings;
  }
}

export async function saveNetworkProxySettings(settings: NetworkProxySettings): Promise<NetworkProxySettings> {
  const normalized = normalizeNetworkProxySettings(settings);
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(normalized, null, 2), "utf-8");
  await applyNetworkProxySettings(normalized);
  return normalized;
}

export async function applySavedNetworkProxySettings(): Promise<NetworkProxySettings> {
  const settings = await loadNetworkProxySettings();
  await applyNetworkProxySettings(settings);
  return settings;
}

export async function applyNetworkProxySettings(settings: NetworkProxySettings): Promise<void> {
  const normalized = normalizeNetworkProxySettings(settings);
  applyProxyEnvironment(normalized);
  const proxyConfig = buildElectronProxyConfig(normalized);
  await Promise.all([
    session.defaultSession.setProxy(proxyConfig),
    session.fromPartition("persist:bgt-main").setProxy(proxyConfig)
  ]);
}

export function networkFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = input instanceof URL ? input.toString() : input;
  return net.fetch(target, init as Parameters<typeof net.fetch>[1]);
}

function normalizeNetworkProxySettings(settings: Partial<NetworkProxySettings>): NetworkProxySettings {
  const protocol = settings.protocol === "socks5" ? "socks5" : "http";
  const port = Number.isFinite(settings.port) ? Number(settings.port) : defaultNetworkProxySettings.port;
  return {
    schemaVersion: 1,
    enabled: Boolean(settings.enabled),
    protocol,
    host: typeof settings.host === "string" ? settings.host.trim() : "",
    port: Math.min(65535, Math.max(1, Math.trunc(port))),
    bypassList: typeof settings.bypassList === "string" ? settings.bypassList.trim() : defaultNetworkProxySettings.bypassList
  };
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  if (!settings.enabled || !settings.host) return { mode: "direct" };
  const endpoint = `${settings.host}:${settings.port}`;
  return {
    proxyRules: settings.protocol === "socks5" ? `socks5://${endpoint}` : `http=${endpoint};https=${endpoint}`,
    proxyBypassRules: settings.bypassList
  };
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function applyProxyEnvironment(settings: NetworkProxySettings): void {
  const value = settings.enabled && settings.host ? `${settings.protocol}://${settings.host}:${settings.port}` : "";
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  for (const key of keys) {
    if (value) process.env[key] = value;
    else restoreProxyEnv(key);
  }
}

function captureProxyEnv(): Record<string, string | undefined> {
  return {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy
  };
}

function restoreProxyEnv(key: string): void {
  const value = initialProxyEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
