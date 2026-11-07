// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { buildSessionKey, isSubagentSession } from "../helpers.js";
import { subagentParentMap } from "./subagent.js";


/**
 * Save the current turn: the last user-role message and everything after it.
 *
 * `agent_end` delivers the whole in-memory transcript, so the turn boundary is
 * derived from the array itself rather than from a persisted cursor. Anything
 * before the trailing user message was either saved by its own turn or came
 * from a turn that never finished, and is not revisited.
 *
 * Returns the number of messages saved. Exported for testability.
 */
export async function flushMessages(
  api: OpenClawPluginApi,
  state: PluginState,
  messages: unknown[],
  ctx: {
    sessionKey?: string;
    agentId?: string;
    sessionId?: string;
    messageProvider?: string;
    /** Sender for this run (PluginHookAgentContext). */
    senderId?: string;
    trigger?: string;
    inputProvenance?: { kind?: string; sourceSessionKey?: string };
  },
): Promise<number> {
  // Raw turns are untrusted and may contain sensitive data. The installed
  // adapter has no trusted pre-write summary or filtering contract, so fail
  // closed until one is implemented and qualified.
  return 0;
}

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("agent_end", async (event, ctx) => {
    if (!event.success || !event.messages?.length) return;

    try {
      await flushMessages(api, state, event.messages, ctx);
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    } finally {
      const sessionKey = buildSessionKey(
        { sessionKey: ctx.sessionKey, agentId: ctx.agentId },
        state.resolveDefaultAgentId,
      );
      state.turnProvenance?.delete(sessionKey);
      if (isSubagentSession(ctx)) subagentParentMap.delete(ctx.sessionKey ?? "");
    }
  });
}
