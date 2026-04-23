// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerGatewayHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("gateway_start", async (_event, _ctx) => {
    api.logger.info("Initializing Honcho memory...");
    try {
      // Initialize the default workspace eagerly; per-agent workspaces are
      // lazily initialized on first use via ensureInitializedFor(agentId).
      await state.ensureInitializedFor(state.resolveDefaultAgentId());
      const configuredWorkspaces = new Set<string>([state.cfg.workspaceId]);
      if (state.cfg.agentWorkspaces) {
        for (const ws of Object.values(state.cfg.agentWorkspaces)) {
          configuredWorkspaces.add(ws);
        }
      }
      if (configuredWorkspaces.size > 1) {
        api.logger.info(
          `Honcho memory ready (default workspace: ${state.cfg.workspaceId}; ${configuredWorkspaces.size - 1} additional workspace(s) will init on first agent use)`
        );
      } else {
        api.logger.info("Honcho memory ready");
      }
    } catch (error) {
      api.logger.error(`Failed to initialize Honcho: ${error}`);
    }
  });
}
