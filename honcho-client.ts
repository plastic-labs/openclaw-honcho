/**
 * Honcho client construction and telemetry identity.
 *
 * Every Honcho client in this plugin is built here so the telemetry headers
 * cannot be missed at a construction site.
 */

import { createRequire } from "node:module";
import { Honcho } from "@honcho-ai/sdk";
import { telemetryHeaders, type TelemetryIdentity } from "@honcho-ai/harness-plugin-core";
// @ts-ignore - resolved by openclaw runtime
import { VERSION as OPENCLAW_VERSION } from "openclaw/plugin-sdk/cli-runtime";
// @ts-ignore - resolved by openclaw runtime
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";

/** The `hosts.<name>` config key for this harness. */
export const HOST_ID = "openclaw";
/** npm package name without the scope. */
export const PLUGIN_ID = "openclaw-honcho";

let pluginVersion: string | undefined;

/**
 * This plugin's version.
 *
 * `readPluginPackageVersion` is OpenClaw's own helper for this and handles the
 * source, bundled and test layouts, which differ here: the sources sit at the
 * package root but the build emits to `dist/`, so no single relative path is
 * correct for both. Read lazily and memoized.
 */
export function getPluginVersion(): string {
  if (pluginVersion) return pluginVersion;
  try {
    const version = readPluginPackageVersion({
      require: createRequire(import.meta.url),
      fallback: "unknown",
    });
    if (typeof version === "string" && version) return (pluginVersion = version);
  } catch {
    // Fall through; the next call retries.
  }
  return "unknown";
}

/**
 * The running OpenClaw version, from the runtime's own `VERSION` constant.
 *
 * Exported from `plugin-sdk/cli-runtime`, which also happens to be the cheapest
 * subpath that carries it. No hook payload or field on the plugin API object
 * exposes the version, but this export is first-class and is what the runtime
 * reports as its own version.
 */
export function getHostVersion(): string | undefined {
  const version: unknown = OPENCLAW_VERSION;
  return typeof version === "string" && version ? version : undefined;
}

/**
 * Host and plugin identity. `X-Honcho-Agent-Model` is deliberately not sent
 * yet: OpenClaw exposes the resolved model on `before_agent_finalize`, a
 * conversation hook, and wiring it is its own change.
 */
export function telemetryIdentity(): TelemetryIdentity {
  const hostVersion = getHostVersion();
  return {
    host: HOST_ID,
    plugin: PLUGIN_ID,
    pluginVersion: getPluginVersion(),
    ...(hostVersion ? { hostVersion } : {}),
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
