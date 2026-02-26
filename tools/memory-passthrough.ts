// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerMemoryPassthrough(api: OpenClawPluginApi, _state: PluginState): void {
  api.registerTool(
    (ctx) => {
      const memorySearchTool = api.runtime.tools.createMemorySearchTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      });
      const memoryGetTool = api.runtime.tools.createMemoryGetTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      });
      if (!memorySearchTool || !memoryGetTool) {
        return null;
      }
      return [memorySearchTool, memoryGetTool];
    },
    { names: ["memory_search", "memory_get"] }
  );
}
