// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPluginVersion } from "../honcho-client.js";

const PLUGIN_ID = "openclaw-honcho";
const NPM_PACKAGE = "@honcho-ai/openclaw-honcho";

// Shared with the telemetry headers so the two cannot disagree.
const rawPluginVersion = getPluginVersion();
const PLUGIN_VERSION = rawPluginVersion === "unknown" ? null : rawPluginVersion;

/** OpenClaw's own resolution: OPENCLAW_CONFIG_PATH is the file, else <state dir>/openclaw.json. */
function getConfigPath(): string {
  return (
    process.env.OPENCLAW_CONFIG_PATH ??
    join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "openclaw.json")
  );
}

function warnIfConversationAccessMissing(logger: OpenClawPluginApi["logger"]): void {
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

    logger.warn(
      `[honcho] hooks.allowConversationAccess is not set — message capture is off. ` +
        `Enable it yourself, then restart the gateway:\n` +
        `  openclaw config set plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess true\n` +
        `  openclaw gateway restart`,
    );
  } catch {
    // Config unreadable — nothing to warn about.
  }
}

/** Earlier versions owned the memory slot; a leftover slot value keeps memory-core disabled. */
function noteIfMemorySlotStale(logger: OpenClawPluginApi["logger"]): void {
  try {
    const config = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    if (config?.plugins?.slots?.memory !== PLUGIN_ID) return;
    logger.warn(
      `[honcho] plugins.slots.memory points at ${PLUGIN_ID}, which no longer owns the memory slot. ` +
        `memory-core stays disabled until you clear it:\n` +
        `  openclaw config unset plugins.slots.memory\n` +
        `  openclaw gateway restart`,
    );
  } catch {
    // Config unreadable — nothing to note.
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
    warnIfConversationAccessMissing(api.logger);
    noteIfMemorySlotStale(api.logger);
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
