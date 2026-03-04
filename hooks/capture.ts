// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  extractMessages,
} from "../helpers.js";
import { subagentParentMap } from "./subagent.js";

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("agent_end", async (event, ctx) => {
    if (!event.success || !event.messages?.length) return;

    const sessionKey = buildSessionKey(ctx);
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const isSubagent = isSubagentSession(ctx);
    const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      const parentPeer =
        isSubagent && parentAgentId && parentAgentId !== agentId
          ? await state.getAgentPeer(parentAgentId)
          : null;

      const sessionMeta: Record<string, unknown> = {
        agentId,
        ...(isSubagent ? {
          isSubagent: true,
          ...(parentPeer ? { parentPeerId: parentPeer.id } : {}),
        } : {}),
      };

      const session = await state.honcho.session(sessionKey, { metadata: sessionMeta });
      const meta = await session.getMetadata();
      const existingMeta: Record<string, unknown> =
        meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

      const turnStartIndex = Math.min(
        Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0),
        event.messages.length,
      );
      const rawLastSavedIndex =
        typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
      const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), event.messages.length);
      const startIndex = Math.max(turnStartIndex, lastSavedIndex);

      const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = [
        [OWNER_ID, { observeMe: true, observeOthers: false }],
        [agentPeer.id, { observeMe: true, observeOthers: true }],
      ];
      if (parentPeer) {
        // Parent agent can silently observe subagent behavior without contributing messages.
        peerConfigs.push([parentPeer.id, { observeMe: false, observeOthers: true }]);
      }

      await session.addPeers(peerConfigs);

      if (event.messages.length <= startIndex) {
        api.logger.debug?.("No new messages to save");
        return;
      }

      const newRawMessages = event.messages.slice(startIndex);
      const messages = extractMessages(newRawMessages, state.ownerPeer!, agentPeer);

      if (messages.length === 0) {
        await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: event.messages.length });
        return;
      }

      await session.addMessages(messages);
      await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: event.messages.length });
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    } finally {
      state.turnStartIndex.delete(sessionKey);
      if (isSubagent) subagentParentMap.delete(ctx.sessionKey ?? "");
    }
  });
}
