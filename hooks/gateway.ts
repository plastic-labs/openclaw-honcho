// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
    api.logger.info("Initializing Honcho memory...");
    try {
      await state.ensureInitialized();
      api.logger.info("Honcho memory ready");
    } catch (error) {
      api.logger.error(`Failed to initialize Honcho: ${error}`);
    }
  });
}
