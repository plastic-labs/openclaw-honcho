// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  classifySession,
  isSubagentSession,
  normalizeSessionKey,
  extractMessages,
  extractSenderId,
  getRawContent,
} from "../helpers.js";
import { subagentParentMap } from "./subagent.js";

/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 * Exported for testability.
 */
export async function flushMessages(
  api: OpenClawPluginApi,
  state: PluginState,
  messages: unknown[],
  ctx: { sessionKey?: string; agentId?: string; sessionId?: string; messageProvider?: string },
): Promise<number> {
  if (!messages?.length) return 0;

  const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
  const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
  const isSubagent = isSubagentSession(ctx);
  const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;
  const openclawSessionKey = normalizeSessionKey(ctx.sessionKey);
  const sessionClass = classifySession(openclawSessionKey);

  await state.ensureInitialized();
  const agentPeer = await state.getAgentPeer(agentId);
  const parentPeer =
    isSubagent && parentAgentId && parentAgentId !== agentId
      ? await state.getAgentPeer(parentAgentId)
      : null;

  const sessionMeta: Record<string, unknown> = {
    agentId,
    openclawSessionKey,
    sessionClass,
    ...(typeof ctx.messageProvider === "string" && ctx.messageProvider.length > 0
      ? { messageProvider: ctx.messageProvider }
      : {}),
    ...(typeof ctx.sessionId === "string" && ctx.sessionId.length > 0
      ? { lastSessionId: ctx.sessionId }
      : {}),
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

  if (messages.length <= startIndex) {
    return 0;
  }

  const newRawMessages = messages.slice(startIndex);

  // Pre-resolve participant peers for all unique sender IDs in this batch
  const senderIds = new Set<string>();
  let lastSenderId: string | undefined;
  let userMsgCount = 0;
  for (const msg of newRawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") continue;
    userMsgCount++;
    const rawContent = getRawContent(msg);
    const senderId = extractSenderId(rawContent);
    if (senderId) {
      senderIds.add(senderId);
      lastSenderId = senderId;
    } else {
      const hasConvInfo = rawContent.includes("Conversation info (untrusted metadata):");
      api.logger.debug?.(`[honcho] User message without sender_id (hasConvInfo=${hasConvInfo}, contentLen=${rawContent.length})`);
    }
  }
  if (senderIds.size > 0) {
    api.logger.debug?.(`[honcho] Resolved ${senderIds.size} unique sender(s) from ${userMsgCount} user message(s)`);
  }

  // Parallel peer resolution — avoids sequential await bottleneck in group chats.
  const resolvedPeers = new Map<string, Awaited<ReturnType<typeof state.getParticipantPeer>>>();
  const senderIdArray = [...senderIds];
  const peers = await Promise.all(senderIdArray.map((id) => state.getParticipantPeer(id)));
  for (let i = 0; i < senderIdArray.length; i++) {
    resolvedPeers.set(senderIdArray[i], peers[i]);
  }

  const defaultParticipantPeer = await state.getParticipantPeer();

  // Build peer configs: default owner + all resolved participant peers + agent + parent
  const peerConfigMap = new Map<string, { observeMe: boolean; observeOthers: boolean }>();
  peerConfigMap.set(OWNER_ID, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers });
  for (const [, peer] of resolvedPeers) {
    if (peer.id !== OWNER_ID) {
      peerConfigMap.set(peer.id, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers });
    }
  }
  peerConfigMap.set(agentPeer.id, { observeMe: true, observeOthers: true });
  if (parentPeer) {
    peerConfigMap.set(parentPeer.id, { observeMe: false, observeOthers: true });
  }

  const peerConfigs = Array.from(peerConfigMap.entries()) as Array<
    [string, { observeMe: boolean; observeOthers: boolean }]
  >;
  await session.addPeers(peerConfigs);

  const extracted = extractMessages(
    newRawMessages,
    defaultParticipantPeer,
    agentPeer,
    state.cfg.noisePatterns,
    (senderId) => resolvedPeers.get(senderId),
  );

  // participantSenderId = last active sender, used by tools to resolve the
  // session's current participant peer. Named "sender" (not "peer") to
  // distinguish raw channel IDs from resolved Honcho peer IDs.
  const updatedMeta: Record<string, unknown> = {
    ...existingMeta,
    ...sessionMeta,
    lastSavedIndex: messages.length,
  };
  if (lastSenderId) {
    updatedMeta.participantSenderId = lastSenderId;
  }

  if (extracted.length === 0) {
    await session.setMetadata(updatedMeta);
    return 0;
  }

  await session.addMessages(extracted);
  await session.setMetadata(updatedMeta);
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
      const sessionKey = buildSessionKey(
        { sessionKey: ctx.sessionKey, agentId: ctx.agentId },
        state.resolveDefaultAgentId,
      );
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
