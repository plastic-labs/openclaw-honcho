// @ts-ignore - resolved by openclaw runtime
import type { MessageInput, Session } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  shouldIsolateSession,
  extractMessages,
  extractSenderId,
  getRawContent,
} from "../helpers.js";
import { subagentParentMap } from "./subagent.js";

const sessionFlushLocks = new Map<string, Promise<void>>();
export const HONCHO_MESSAGES_LIST_MAX_SIZE = 100;

function messageSignature(message: MessageInput | { peerId: string; createdAt?: string; content: string }): string | null {
  if (!message?.createdAt) return null;
  return `${message.peerId}\u0000${message.createdAt}\u0000${message.content}`;
}

async function withSessionFlushLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionFlushLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionFlushLocks.set(sessionKey, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionFlushLocks.get(sessionKey) === current) {
      sessionFlushLocks.delete(sessionKey);
    }
  }
}

function normalizeRecentTailSize(recentTailSize: number): number {
  if (!Number.isFinite(recentTailSize) || recentTailSize <= 0) return 0;
  return Math.trunc(recentTailSize);
}

async function collectRecentTailMessages(
  session: Session,
  recentTailSize: number,
): Promise<Array<{ peerId: string; createdAt?: string; content: string }>> {
  const limit = normalizeRecentTailSize(recentTailSize);
  if (limit <= 0) return [];

  let page = await session.messages({
    size: Math.min(limit, HONCHO_MESSAGES_LIST_MAX_SIZE),
    reverse: true,
  });
  const messages = [...page.items];

  while (messages.length < limit && page.hasNextPage) {
    const nextPage = await page.getNextPage();
    if (!nextPage) break;
    page = nextPage;
    messages.push(...page.items);
  }

  return messages.slice(0, limit);
}

export async function dedupeAgainstRecentTail(
  session: Session,
  extracted: MessageInput[],
  recentTailSize: number,
): Promise<MessageInput[]> {
  const batchSeen = new Set<string>();
  const batchUnique: MessageInput[] = [];

  for (const message of extracted) {
    const signature = messageSignature(message) ?? `${message.peerId}\u0000${message.content}`;
    if (batchSeen.has(signature)) continue;
    batchSeen.add(signature);
    batchUnique.push(message);
  }

  const tailSize = normalizeRecentTailSize(recentTailSize);
  if (batchUnique.length === 0 || tailSize <= 0) return batchUnique;

  const recentMessages = await collectRecentTailMessages(session, tailSize);
  const recentSignatures = new Set(
    recentMessages
      .map((message) => messageSignature(message))
      .filter((signature): signature is string => typeof signature === "string"),
  );

  return batchUnique.filter((message) => {
    const signature = messageSignature(message);
    return !signature || !recentSignatures.has(signature);
  });
}

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
  if (shouldIsolateSession(ctx, state.cfg.isolatedSessionPatterns)) return 0;

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

  return withSessionFlushLock(sessionKey, async () => {
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
      { stripRuntimeScaffolding: state.cfg.stripRuntimeScaffolding },
    );
    const deduped = await dedupeAgainstRecentTail(session, extracted, state.cfg.recentTailDedupeSize);

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

    if (deduped.length === 0) {
      await session.setMetadata(updatedMeta);
      return 0;
    }

    await session.addMessages(deduped);
    await session.setMetadata(updatedMeta);
    return deduped.length;
  });
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
