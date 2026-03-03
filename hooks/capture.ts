// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  extractParentAgentKey,
  extractAgentIdFromAgentKey,
  extractMessages,
} from "../helpers.js";

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("agent_end", async (event, ctx) => {
    if (!event.success || !event.messages?.length) return;

    const sessionKey = buildSessionKey(ctx);
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const isSubagent = isSubagentSession(ctx);
    const parentAgentKey = isSubagent ? extractParentAgentKey(ctx.sessionKey) : undefined;
    const parentAgentId = extractAgentIdFromAgentKey(parentAgentKey);

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
          parentAgentKey,
          ...(parentPeer ? { parentPeerId: parentPeer.id } : {}),
        } : {}),
      };

      const session = await state.honcho.session(sessionKey, { metadata: sessionMeta });
      let meta = await session.getMetadata();

      if (meta.lastSavedIndex === undefined) {
        await session.setMetadata({ ...sessionMeta, lastSavedIndex: 0 });
        meta = { ...sessionMeta, lastSavedIndex: 0 };
      }

      const turnStartIndex = Math.min(
        Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0),
        event.messages.length,
      );
      const turnMessages = event.messages.slice(turnStartIndex, event.messages.length);
      const rawLastSavedOffset = (meta.lastSavedIndex as number) ?? 0;
      const lastSavedOffset =
        rawLastSavedOffset >= 0 && rawLastSavedOffset <= turnMessages.length ? rawLastSavedOffset : 0;

      const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = [
        [OWNER_ID, { observeMe: true, observeOthers: false }],
        [agentPeer.id, { observeMe: true, observeOthers: true }],
      ];
      if (parentPeer) {
        // Parent agent can silently observe subagent behavior without contributing messages.
        peerConfigs.push([parentPeer.id, { observeMe: false, observeOthers: true }]);
      }

      await session.addPeers(peerConfigs);

      if (turnMessages.length <= lastSavedOffset) {
        api.logger.debug?.("No new messages to save");
        return;
      }

      const newRawMessages = turnMessages.slice(lastSavedOffset);
      const messages = extractMessages(newRawMessages, state.ownerPeer!, agentPeer);

      if (messages.length === 0) {
        await session.setMetadata({ ...meta, ...sessionMeta, lastSavedIndex: turnMessages.length });
        return;
      }

      await session.addMessages(messages);
      await session.setMetadata({ ...meta, ...sessionMeta, lastSavedIndex: turnMessages.length });
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    }
  });
}
