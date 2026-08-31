// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "openclaw-honcho";
const NPM_PACKAGE = "@honcho-ai/openclaw-honcho";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Compiled to dist/hooks/, so the package root is two levels up; one level up
// covers running straight from source. Never throws — an unknown version just
// skips the update check.
function readPluginVersion(): string | null {
  for (const rel of [["..", "..", "package.json"], ["..", "package.json"]]) {
    try {
      const pkg = require(join(__dirname, ...rel));
      if (pkg?.name === NPM_PACKAGE && pkg.version) return pkg.version;
    } catch {
      // Not here — try the next candidate.
    }
  }
  return null;
}

const PLUGIN_VERSION = readPluginVersion();

function getConfigPath(): string {
  return join(
    process.env.OPENCLAW_CONFIG_PATH ?? join(homedir(), ".openclaw"),
    "openclaw.json",
  );
}

function ensureConversationAccess(logger: OpenClawPluginApi["logger"]): void {
  try {
    const configPath = getConfigPath();
    let config: Record<string, any>;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return;
    }

    const entry = config?.plugins?.entries?.[PLUGIN_ID];
    if (entry?.hooks?.allowConversationAccess === true) return;

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    if (!config.plugins.entries[PLUGIN_ID]) config.plugins.entries[PLUGIN_ID] = {};
    if (!config.plugins.entries[PLUGIN_ID].hooks) config.plugins.entries[PLUGIN_ID].hooks = {};
    config.plugins.entries[PLUGIN_ID].hooks.allowConversationAccess = true;

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.warn(
      `[honcho] Set hooks.allowConversationAccess=true in config. ` +
        `Restart the gateway to enable message capture:\n` +
        `  openclaw gateway restart`,
    );
  } catch {
    // Config unwritable — fall through; next startup will retry.
  }
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

async function checkForUpdate(logger: OpenClawPluginApi["logger"]): Promise<void> {
  if (!PLUGIN_VERSION) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);
    if (!res.ok) return;

    const data = await res.json();
    const latest = data.version as string;
    if (!latest || latest === PLUGIN_VERSION) return;

    const cur = parseSemver(PLUGIN_VERSION);
    const lat = parseSemver(latest);
    if (cur && lat && (lat[0] > cur[0] || (lat[0] === cur[0] && (lat[1] > cur[1] || (lat[1] === cur[1] && lat[2] > cur[2]))))) {
      logger.info(
        `[honcho] update available | current: v${PLUGIN_VERSION} | latest: v${latest} | ` +
          `run: openclaw plugins update ${NPM_PACKAGE}`,
      );
    }
  } catch {
    // Best-effort — network down, timeout, etc.
  }
}

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
    ensureConversationAccess(api.logger);
    void checkForUpdate(api.logger);

    api.logger.info("Initializing Honcho memory...");
    try {
      await state.ensureInitialized();
      const { filePath, peers } = state.peersPersister;
      api.logger.info(
        `Honcho memory ready — peer map: ${filePath} (${Object.keys(peers).length} known sender${
          Object.keys(peers).length === 1 ? "" : "s"
        })`,
      );
    } catch (error) {
      api.logger.error(`Failed to initialize Honcho at ${state.cfg.baseUrl}: ${error}`);
    }
  });
}
