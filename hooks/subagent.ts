// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi, PluginHookSubagentContext } from "openclaw/plugin-sdk";

/**
 * Module-level singleton: childSessionKey → parent agent ID.
 * Populated by subagent_spawned; read by agent_end in capture.ts.
 */
export const subagentParentMap = new Map<string, string>();

/**
 * Maps OpenClaw sessionKey → agentId, built from before_agent_start.
 * Used to resolve the parent's agent ID from ctx.requesterSessionKey in
 * subagent_spawned without relying on session-key string parsing.
 */
const sessionKeyToAgentId = new Map<string, string>();

export function registerSubagentHooks(api: OpenClawPluginApi): void {
  api.on("before_agent_start", (_event, ctx) => {
    if (ctx.sessionKey && ctx.agentId) {
      sessionKeyToAgentId.set(ctx.sessionKey, ctx.agentId);
    }
  });

  api.on("subagent_spawned", async (_event, ctx: PluginHookSubagentContext) => {
    const { childSessionKey, requesterSessionKey } = ctx;
    if (childSessionKey && requesterSessionKey) {
      const parentAgentId = sessionKeyToAgentId.get(requesterSessionKey);
      if (parentAgentId) {
        subagentParentMap.set(childSessionKey, parentAgentId);
      }
    }
  });

  api.on("agent_end", (_event, ctx) => {
    if (ctx.sessionKey) {
      sessionKeyToAgentId.delete(ctx.sessionKey);
    }
  });
}
