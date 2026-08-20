// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ID = "openclaw-honcho";

function checkConversationAccess(logger: OpenClawPluginApi["logger"]): void {
  try {
    const configPath = join(
      process.env.OPENCLAW_CONFIG_PATH ?? join(homedir(), ".openclaw"),
      "openclaw.json",
    );
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const entry = config?.plugins?.entries?.[PLUGIN_ID];
    if (entry?.hooks?.allowConversationAccess === true) return;

    logger.warn(
      `[honcho] ⚠ Message capture is DISABLED. OpenClaw requires explicit opt-in ` +
        `for conversation hooks on non-bundled plugins.\n` +
        `  Run: openclaw config set plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess true\n` +
        `  Then: openclaw gateway restart\n` +
        `  Without this, Honcho tools work but no new messages are saved.`,
    );
  } catch {
    // Config unreadable — skip check; the gateway will log its own errors.
  }
}

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
    checkConversationAccess(api.logger);

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
