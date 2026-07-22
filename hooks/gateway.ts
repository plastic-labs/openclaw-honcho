// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { safeLifecycleError } from "../routing.js";

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
    const defaultState = state.getWorkspaceState(state.cfg.workspaceId);
    api.logger.info(`[honcho] Initializing default workspace "${defaultState.workspaceId}"`);
    try {
      await defaultState.ensureInitialized();
      const routedWorkspaceCount = new Set([
        ...Object.values(state.cfg.workspaceIdByAgent),
        ...state.cfg.workspaceRoutingRules.map((rule) => rule.workspaceId),
      ].filter((workspaceId) => workspaceId !== defaultState.workspaceId)).size;
      api.logger.info(`[honcho] Default workspace ready; ${routedWorkspaceCount} configured route workspace(s) remain lazy`);
    } catch (error) {
      api.logger.error(`[honcho] Default workspace initialization failed: ${safeLifecycleError(error)}`);
    }
  });
}
