// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi, PluginHookSubagentContext } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerSubagentHooks(api: OpenClawPluginApi, state: PluginState): void {
  api.on("subagent_spawned", async (_event, ctx: PluginHookSubagentContext) => {
    const { childSessionKey, requesterSessionKey } = ctx;
    if (childSessionKey && requesterSessionKey) {
      state.subagentParentMap.set(childSessionKey, requesterSessionKey);
    }
  });
}
