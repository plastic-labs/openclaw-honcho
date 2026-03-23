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

/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 */
async function flushMessages(
  api: OpenClawPluginApi,
  state: PluginState,
  messages: unknown[],
  ctx: { sessionKey?: string; agentId?: string; messageProvider?: string },
): Promise<number> {
  if (!messages?.length) return 0;

  const sessionKey = buildSessionKey(ctx);
  const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
  const isSubagent = isSubagentSession(ctx);
  const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;

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
    messages.length,
  );
  const rawLastSavedIndex =
    typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
  const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), messages.length);
  const startIndex = Math.max(turnStartIndex, lastSavedIndex);

  const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = [
    [OWNER_ID, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers }],
    [agentPeer.id, { observeMe: true, observeOthers: true }],
  ];
  if (parentPeer) {
    peerConfigs.push([parentPeer.id, { observeMe: false, observeOthers: true }]);
  }

  await session.addPeers(peerConfigs);

  if (messages.length <= startIndex) {
    return 0;
  }

  const newRawMessages = messages.slice(startIndex);
  const extracted = extractMessages(newRawMessages, state.ownerPeer!, agentPeer, state.cfg.noisePatterns);

  if (extracted.length === 0) {
    await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: messages.length });
    return 0;
  }

  await session.addMessages(extracted);
  await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: messages.length });
  return extracted.length;
}

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  /**
   * agent_end — primary capture hook. Saves conversation messages after each turn.
   */
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
      const sessionKey = buildSessionKey(ctx);
      state.turnStartIndex.delete(sessionKey);
      if (isSubagentSession(ctx)) subagentParentMap.delete(ctx.sessionKey ?? "");
    }
  });

  /**
   * before_compaction — flush unsaved messages before compaction truncates them.
   * OpenClaw fires this before compacting the session transcript. Messages on
   * disk are preserved (via sessionFile), but the in-memory array will be
   * truncated. We save everything we haven't saved yet.
   */
  api.on("before_compaction", async (event, ctx) => {
    if (!event.messages?.length) return;

    try {
      const saved = await flushMessages(api, state, event.messages, ctx);
      if (saved > 0) {
        api.logger.debug?.(`[honcho] Flushed ${saved} messages before compaction`);
      }
    } catch (error) {
      api.logger.warn?.(`[honcho] Failed to flush messages before compaction: ${error}`);
    }
  });

  /**
   * before_reset — flush unsaved messages before /new or /reset clears the session.
   * This ensures no conversation data is lost when the user resets.
   */
  api.on("before_reset", async (event, ctx) => {
    if (!event.messages?.length) return;

    try {
      const saved = await flushMessages(api, state, event.messages, ctx);
      if (saved > 0) {
        api.logger.debug?.(`[honcho] Flushed ${saved} messages before session reset`);
      }
    } catch (error) {
      api.logger.warn?.(`[honcho] Failed to flush messages before reset: ${error}`);
    }
  });
}
