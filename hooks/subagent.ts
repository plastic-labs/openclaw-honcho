// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
// @ts-ignore - resolved by openclaw runtime
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

/**
 * Module-level singleton: childSessionKey → parent agent ID.
 * Populated by subagent_spawned; read by agent_end in capture.ts.
 */
export const subagentParentMap = new Map<string, string>();

export function registerSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawned", (_event, ctx) => {
    const { childSessionKey, requesterSessionKey } = ctx;
    if (childSessionKey && requesterSessionKey) {
      const parentAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
      if (parentAgentId) {
        subagentParentMap.set(childSessionKey, parentAgentId);
      }
    }
  });
}
