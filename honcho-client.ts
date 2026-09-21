/**
 * Honcho client construction and telemetry identity.
 *
 * Every Honcho client in this plugin is built here so the telemetry headers
 * cannot be missed at a construction site.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Honcho } from "@honcho-ai/sdk";
import { telemetryHeaders, type TelemetryIdentity } from "@honcho-ai/harness-plugin-core";

/** The `hosts.<name>` config key for this harness. */
export const HOST_ID = "openclaw";
/** npm package name without the scope. */
export const PLUGIN_ID = "openclaw-honcho";

let pluginVersion: string | undefined;

/**
 * This plugin's version, from the package.json npm always ships.
 *
 * Walks up looking for this package's own manifest rather than assuming a fixed
 * relative depth: the sources sit at the repo root but the build emits to
 * `dist/`, so a single `../package.json` is right for one layout and points
 * outside the package in the other. Read lazily and guarded, so a miss degrades
 * the header instead of stopping the plugin from loading.
 */
export function getPluginVersion(): string {
  if (pluginVersion) return pluginVersion;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          pkg.name === `@honcho-ai/${PLUGIN_ID}` &&
          typeof pkg.version === "string" &&
          pkg.version
        ) {
          return (pluginVersion = pkg.version);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through; the next call retries.
  }
  return "unknown";
}

let hostVersion: string | undefined | null;

/**
 * The running OpenClaw version.
 *
 * No hook payload or plugin-API field carries it, so it is read from the
 * `openclaw` peer dependency the plugin is actually loaded against — the
 * installer links that to the running install, so this is the running version
 * rather than whatever was current at publish time.
 *
 * `openclaw/package.json` is not an exported subpath, so resolution goes
 * through an export that is (`plugin-sdk/core`) and walks up to the package
 * root. Memoized including the failure, since the answer cannot change within
 * a process.
 */
export function getHostVersion(): string | undefined {
  if (hostVersion !== undefined) return hostVersion ?? undefined;
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("openclaw/plugin-sdk/core"));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "openclaw" && typeof pkg.version === "string" && pkg.version) {
          return (hostVersion = pkg.version);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the unknown case.
  }
  hostVersion = null;
  return undefined;
}

/**
 * Host and plugin identity. `X-Honcho-Agent-Model` is deliberately not sent
 * yet: OpenClaw exposes the resolved model on `before_agent_finalize`, a
 * conversation hook, and wiring it is its own change.
 */
export function telemetryIdentity(): TelemetryIdentity {
  const host = getHostVersion();
  return {
    host: HOST_ID,
    plugin: PLUGIN_ID,
    pluginVersion: getPluginVersion(),
    ...(host ? { hostVersion: host } : {}),
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
