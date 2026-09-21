/** Honcho client construction. Every client is built here so the telemetry headers cannot be missed. */

import { createRequire } from "node:module";
import { Honcho } from "@honcho-ai/sdk";
import {
  telemetryHeaders,
  setTelemetryHeaders,
  type TelemetryIdentity,
} from "@honcho-ai/harness-plugin-core";
// @ts-ignore - resolved by openclaw runtime
import { VERSION as OPENCLAW_VERSION } from "openclaw/plugin-sdk/cli-runtime";
// @ts-ignore - resolved by openclaw runtime
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";

/** The `hosts.<name>` config key for this harness. */
export const HOST_ID = "openclaw";
/** npm package name without the scope. */
export const PLUGIN_ID = "openclaw-honcho";

let pluginVersion: string | undefined;

/** OpenClaw's helper handles the source, bundled and test layouts, which differ here. */
export function getPluginVersion(): string {
  if (pluginVersion) return pluginVersion;
  try {
    const version = readPluginPackageVersion({
      require: createRequire(import.meta.url),
      fallback: "unknown",
    });
    if (typeof version === "string" && version) return (pluginVersion = version);
  } catch {
    // Retry on the next call.
  }
  return "unknown";
}

/** The running OpenClaw version, from the runtime's own constant. */
export function getHostVersion(): string | undefined {
  const version: unknown = OPENCLAW_VERSION;
  return typeof version === "string" && version ? version : undefined;
}

export function telemetryIdentity(model?: string): TelemetryIdentity {
  const hostVersion = getHostVersion();
  return {
    host: HOST_ID,
    plugin: PLUGIN_ID,
    pluginVersion: getPluginVersion(),
    ...(hostVersion ? { hostVersion } : {}),
    ...(model ? { model } : {}),
  };
}

export type HonchoClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  workspaceId: string;
  timeoutMs?: number;
};

export function createHonchoClient(options: HonchoClientOptions): Honcho {
  return new Honcho({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    workspaceId: options.workspaceId,
    timeout: options.timeoutMs,
    defaultHeaders: telemetryHeaders(telemetryIdentity()),
  });
}

/** The SDK reads `defaultHeaders` per request, so the next request carries the change. */
export function refreshTelemetryHeaders(honcho: Honcho, model: string): void {
  const headers = (honcho as unknown as { http?: { defaultHeaders?: Record<string, string> } })
    .http?.defaultHeaders;
  if (headers) setTelemetryHeaders(headers, telemetryIdentity(model));
}
