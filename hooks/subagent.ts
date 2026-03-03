// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

type SubagentSpawnedCtx = {
  childSessionKey?: string;
  requesterSessionKey?: string;
};

export function registerSubagentHooks(api: OpenClawPluginApi, state: PluginState): void {
  api.on("subagent_spawned", async (_event, ctx) => {
    const { childSessionKey, requesterSessionKey } = ctx as SubagentSpawnedCtx;
    if (childSessionKey && requesterSessionKey) {
      state.subagentParentMap.set(childSessionKey, requesterSessionKey);
    }
  });
}
