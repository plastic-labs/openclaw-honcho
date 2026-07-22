// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi, PluginHookSubagentContext } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerSubagentHooks(api: OpenClawPluginApi, state: PluginState): void {
  const sessionKeyToAgentId = new Map<string, string>();

  api.on("before_agent_start", (_event, ctx) => {
    if (ctx.sessionKey && ctx.agentId) {
      sessionKeyToAgentId.set(ctx.sessionKey, ctx.agentId);
    }
  });

  api.on("subagent_spawned", async (event, ctx: PluginHookSubagentContext) => {
    const childSessionKey = ctx.childSessionKey ?? event.childSessionKey;
    const requesterSessionKey = ctx.requesterSessionKey;
    if (!childSessionKey) {
      api.logger.warn?.("[honcho] Subagent route denied: missing-child-session-key");
      return;
    }
    if (!requesterSessionKey) {
      state.sessionWorkspaceBindings.deny(childSessionKey);
      api.logger.warn?.("[honcho] Subagent route denied: missing-requester-session-key");
      return;
    }

    const inherited = state.sessionWorkspaceBindings.bindChild(requesterSessionKey, childSessionKey);
    if (inherited.status === "unknown-parent") {
      state.sessionWorkspaceBindings.deny(childSessionKey);
      api.logger.warn?.("[honcho] Subagent route denied: unknown-parent-route");
      return;
    }
    if (inherited.status === "binding-conflict") {
      state.sessionWorkspaceBindings.deny(childSessionKey);
      api.logger.warn?.("[honcho] Subagent route denied: binding-conflict");
      return;
    }

    state.subagentRelations.set(childSessionKey, {
      parentSessionKey: requesterSessionKey,
      parentAgentId: sessionKeyToAgentId.get(requesterSessionKey),
    });
  });

  api.on("subagent_ended", (event, ctx: PluginHookSubagentContext) => {
    const childSessionKey = ctx.childSessionKey ?? event.targetSessionKey;
    if (childSessionKey) state.subagentRelations.delete(childSessionKey);
    // The immutable workspace binding is intentionally retained. Removing it
    // would allow a reused session key to be rebound to another workspace.
  });

  api.on("agent_end", (_event, ctx) => {
    if (ctx.sessionKey) {
      sessionKeyToAgentId.delete(ctx.sessionKey);
    }
  });
}
