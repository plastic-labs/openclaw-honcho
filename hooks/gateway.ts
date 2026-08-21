// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
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
