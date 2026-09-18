// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  classifySession,
  isSubagentSession,
  normalizeSessionKey,
  extractMessages,
  extractSenderId,
  getMessageIdentity,
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

  // Don't pass metadata: it replaces persisted metadata on existing sessions,
  // wiping lastSavedIndex.
  const session = await state.honcho.session(sessionKey);
  const meta = await session.getMetadata();
  const existingMeta: Record<string, unknown> =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

  // Resolve where this batch's unsaved region starts.
  //
  // The watermark is anchored on the identity of the last message we covered,
  // not on an array index. `before_prompt_build` and `agent_end` are not
  // guaranteed to deliver the same slice — the gateway path sends the full
  // transcript to both, but a runtime that sends only the current turn to
  // `agent_end` makes a recorded index meaningless, and comparing the two
  // silently selects an empty range (see issue #134).
  const lastSavedMessageId =
    typeof existingMeta.lastSavedMessageId === "string"
      ? existingMeta.lastSavedMessageId
      : undefined;

  let anchorIndex = -1;
  if (lastSavedMessageId) {
    // Fast path: lastSavedIndex points just past the anchor whenever the batch
    // is shaped the same way as the previous one, which is the steady state on
    // the gateway path. Checking it first keeps this O(1) per flush instead of
    // hashing every message in a long transcript.
    const hinted =
      typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex - 1 : -1;
    if (
      hinted >= 0 &&
      hinted < messages.length &&
      getMessageIdentity(messages[hinted]) === lastSavedMessageId
    ) {
      anchorIndex = hinted;
    } else {
      // Earliest occurrence. An identity can repeat — two messages with the
      // same role, timestamp and content collide under the digest fallback —
      // and once the hint is wrong there is no way to tell which occurrence
      // was the saved one. Resuming after the earliest may resend messages;
      // resuming after the latest would silently skip everything between them.
      // Prefer duplication over loss, which is the whole point of this fix.
      for (let i = 0; i < messages.length; i++) {
        if (getMessageIdentity(messages[i]) === lastSavedMessageId) {
          anchorIndex = i;
          break;
        }
      }
    }
  }

  let startIndex: number;
  if (anchorIndex >= 0) {
    // Authoritative: we know exactly which message we stopped at.
    startIndex = anchorIndex + 1;
  } else if (lastSavedMessageId) {
    // We have an anchor but this batch does not contain it. The anchor was the
    // newest message we saved, so nothing here can predate it: either this is
    // a delta batch of only-new messages, or the transcript was truncated past
    // the anchor. Both mean the whole batch is unsaved.
    startIndex = 0;
  } else {
    // No anchor yet: first flush for this session, or a session written by a
    // version that only persisted lastSavedIndex. Fall back to the index
    // watermark once so existing history is not re-saved on upgrade.
    const turnStartIndex = Math.min(
      Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0),
      messages.length,
    );
    const rawLastSavedIndex =
      typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
    const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), messages.length);
    startIndex = Math.max(turnStartIndex, lastSavedIndex);
  }

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

  // Extract one-by-one to pair each output with its raw index — needed to
  // advance the saved-watermark safely when the batch is chunked below.
  type ExtractedMessage = ReturnType<typeof extractMessages>[number];
  const extracted: Array<{ message: ExtractedMessage; rawIndex: number }> = [];
  for (let offset = 0; offset < newRawMessages.length; offset++) {
    const [message] = extractMessages(
      [newRawMessages[offset]],
      defaultParticipantPeer,
      agentPeer,
      state.cfg.noisePatterns,
      (senderId) => resolvedPeers.get(senderId),
    );
    if (message) extracted.push({ message, rawIndex: startIndex + offset });
  }

  // Anchor for the next flush: the last message this batch covered, whether or
  // not it survived filtering. Trailing noise must still advance the watermark,
  // otherwise it is rescanned on every subsequent turn.
  //
  // Scans backward for the last *identifiable* message rather than taking the
  // final element outright: an unidentifiable tail would leave the anchor unset,
  // the previous anchor would persist, and the next flush would fail to find it
  // and re-save the whole batch.
  const identityAtOrBefore = (index: number): string | undefined => {
    for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
      const identity = getMessageIdentity(messages[i]);
      if (identity) return identity;
    }
    return undefined;
  };

  const batchTailIdentity = identityAtOrBefore(messages.length - 1);

  // participantSenderId = last active sender, used by tools to resolve the
  // session's current participant peer. Named "sender" (not "peer") to
  // distinguish raw channel IDs from resolved Honcho peer IDs.
  const updatedMeta: Record<string, unknown> = {
    ...existingMeta,
    ...sessionMeta,
    // Retained so a downgrade, or a session read by an older build, still has a
    // usable index watermark. Correctness now comes from lastSavedMessageId.
    lastSavedIndex: messages.length,
    ...(batchTailIdentity ? { lastSavedMessageId: batchTailIdentity } : {}),
  };
  if (lastSenderId) {
    updatedMeta.participantSenderId = lastSenderId;
  }

  if (extracted.length === 0) {
    await session.setMetadata(updatedMeta);
    return 0;
  }

  // Honcho rejects >100 messages per request (HTTP 422). Advance the watermark
  // per chunk so a mid-batch failure doesn't re-send persisted chunks. Last
  // chunk jumps to messages.length to cover trailing filtered noise messages.
  const addMessagesLimit = 100;
  for (let i = 0; i < extracted.length; i += addMessagesLimit) {
    const chunk = extracted.slice(i, i + addMessagesLimit);
    await session.addMessages(chunk.map((e) => e.message));
    const isLastChunk = i + addMessagesLimit >= extracted.length;
    const chunkTailRawIndex = chunk[chunk.length - 1].rawIndex;
    const lastSavedIndex = isLastChunk ? messages.length : chunkTailRawIndex + 1;
    // Mid-batch chunks anchor on the raw message they reached, so a failure in
    // a later chunk resumes from there instead of re-sending persisted ones.
    const chunkIdentity = isLastChunk
      ? batchTailIdentity
      : identityAtOrBefore(chunkTailRawIndex);
    await session.setMetadata({
      ...updatedMeta,
      lastSavedIndex,
      ...(chunkIdentity ? { lastSavedMessageId: chunkIdentity } : {}),
    });
  }
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
