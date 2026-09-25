// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { getPluginVersion } from "../honcho-client.js";

const PLUGIN_ID = "openclaw-honcho";
const NPM_PACKAGE = "@honcho-ai/openclaw-honcho";

// Shared with the telemetry headers so the two cannot disagree.
const rawPluginVersion = getPluginVersion();
const PLUGIN_VERSION = rawPluginVersion === "unknown" ? null : rawPluginVersion;

function warnIfConversationAccessMissing(api: OpenClawPluginApi): void {
  const config = api.runtime.config.current();
  const entry = config.plugins?.entries?.[PLUGIN_ID];
  if (entry?.hooks?.allowConversationAccess === true) return;

  api.logger.warn(
    `[honcho] hooks.allowConversationAccess is not set — message capture is off. ` +
      `Enable it yourself, then restart the gateway:\n` +
      `  openclaw config set plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess true\n` +
      `  openclaw gateway restart`,
  );
}

/** Clear the slot value written by releases that still owned the memory capability. */
async function clearLegacyMemorySlot(api: OpenClawPluginApi): Promise<void> {
  if (api.runtime.config.current().plugins?.slots?.memory !== PLUGIN_ID) return;

  try {
    const committed = await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const slots = draft.plugins?.slots;
        if (slots?.memory !== PLUGIN_ID) return false;
        delete slots.memory;
        return true;
      },
    });
    if (committed.result) {
      api.logger.info(
        `[honcho] cleared the legacy ${PLUGIN_ID} memory slot; memory-core resumes after config reload.`,
      );
    }
  } catch (error) {
    api.logger.warn(
      `[honcho] could not clear the legacy ${PLUGIN_ID} memory slot; memory-core remains disabled. ` +
        `Clear it yourself, then restart the gateway:\n` +
        `  openclaw config unset plugins.slots.memory\n` +
        `  openclaw gateway restart\n` +
        `Reason: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    warnIfConversationAccessMissing(api);
    await clearLegacyMemorySlot(api);
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
