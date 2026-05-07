// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  extractMessages,
  extractSenderId,
  getRawContent,
} from "../helpers.js";
import { subagentParentMap } from "./subagent.js";

const STRUCTURED_SENDER_TTL_MS = 10 * 60 * 1000;

type SenderEntry = {
  senderId?: string;
  seenAt: number;
  ambiguous: boolean;
};

const senderByMessageKey = new Map<string, SenderEntry>();
const senderByTimestampKey = new Map<string, SenderEntry>();

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getMessageId(value: unknown): string | undefined {
  const record = asRecord(value);
  const openclaw = asRecord(record.__openclaw);
  const metadata = asRecord(record.metadata);
  return normalizeString(record.messageId) ??
    normalizeString(record.message_id) ??
    normalizeString(record.id) ??
    normalizeString(openclaw.id) ??
    normalizeString(metadata.messageId);
}

function getTimestamp(value: unknown): number | undefined {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  return normalizeTimestamp(record.timestamp) ??
    normalizeTimestamp(record.createdAt) ??
    normalizeTimestamp(record.ts) ??
    normalizeTimestamp(metadata.timestamp);
}

function getMessageProviderCandidates(event: Record<string, unknown>): string[] {
  const metadata = asRecord(event.metadata);
  return [metadata.provider, metadata.surface, metadata.originatingChannel]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function getSenderSessionKeys(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string[] {
  const sessionKey = normalizeString(event.sessionKey) ?? normalizeString(ctx.sessionKey);
  if (!sessionKey) return [];

  const keys = new Set([sessionKey]);
  for (const messageProvider of getMessageProviderCandidates(event)) {
    keys.add(buildSessionKey({ sessionKey, messageProvider }));
  }
  return [...keys];
}

function rememberSender(map: Map<string, SenderEntry>, key: string, senderId: string): void {
  const now = Date.now();
  for (const [storedKey, entry] of map) {
    if (now - entry.seenAt > STRUCTURED_SENDER_TTL_MS) {
      map.delete(storedKey);
    }
  }

  const existing = map.get(key);
  if (existing && existing.senderId !== senderId) {
    map.set(key, { seenAt: now, ambiguous: true });
    return;
  }

  map.set(key, { senderId, seenAt: now, ambiguous: false });
}

function takeSender(map: Map<string, SenderEntry>, key: string): string | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  map.delete(key);
  if (Date.now() - entry.seenAt > STRUCTURED_SENDER_TTL_MS || entry.ambiguous) {
    return undefined;
  }
  return entry.senderId;
}

function rememberStructuredSender(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  senderId: string,
): void {
  const messageId = getMessageId(event) ?? getMessageId(ctx);
  if (messageId) {
    rememberSender(senderByMessageKey, `${sessionKey}\n${messageId}`, senderId);
  }

  const timestamp = getTimestamp(event);
  if (timestamp !== undefined) {
    rememberSender(senderByTimestampKey, `${sessionKey}\n${timestamp}`, senderId);
  }
}

function takeStructuredSender(sessionKey: string, msg: unknown): string | undefined {
  const messageId = getMessageId(msg);
  if (messageId) {
    const senderId = takeSender(senderByMessageKey, `${sessionKey}\n${messageId}`);
    if (senderId) return senderId;
  }

  const timestamp = getTimestamp(msg);
  if (timestamp !== undefined) {
    return takeSender(senderByTimestampKey, `${sessionKey}\n${timestamp}`);
  }

  return undefined;
}

function prependSenderMetadata(msg: unknown, senderId: string): unknown {
  const rawContent = getRawContent(msg);
  const metadata = [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ sender_id: senderId }),
    "```",
    "",
  ].join("\n");
  return {
    ...(msg as Record<string, unknown>),
    content: `${metadata}${rawContent}`,
  };
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

  if (messages.length <= startIndex) {
    return 0;
  }

  const newRawMessages = messages.slice(startIndex);
  const adjustedRawMessages: unknown[] = [];

  // Pre-resolve participant peers for all unique sender IDs in this batch
  const senderIds = new Set<string>();
  let lastSenderId: string | undefined;
  let userMsgCount = 0;
  for (const msg of newRawMessages) {
    if (!msg || typeof msg !== "object") {
      adjustedRawMessages.push(msg);
      continue;
    }
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") {
      adjustedRawMessages.push(msg);
      continue;
    }
    userMsgCount++;
    const rawContent = getRawContent(msg);
    let senderId = extractSenderId(rawContent);
    if (senderId) {
      takeStructuredSender(sessionKey, msg);
      senderIds.add(senderId);
      lastSenderId = senderId;
    } else {
      senderId = takeStructuredSender(sessionKey, msg);
      if (senderId) {
        senderIds.add(senderId);
        lastSenderId = senderId;
        adjustedRawMessages.push(prependSenderMetadata(msg, senderId));
        continue;
      }
      const hasConvInfo = rawContent.includes("Conversation info (untrusted metadata):");
      api.logger.debug?.(`[honcho] User message without sender_id (hasConvInfo=${hasConvInfo}, contentLen=${rawContent.length})`);
    }
    adjustedRawMessages.push(msg);
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
    adjustedRawMessages,
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
  api.on("message_received", async (event, ctx) => {
    const eventRecord = event as Record<string, unknown>;
    const ctxRecord = ctx as Record<string, unknown>;
    const senderId = normalizeString(eventRecord.senderId) ?? normalizeString(ctxRecord.senderId);
    if (!senderId) return;

    for (const sessionKey of getSenderSessionKeys(eventRecord, ctxRecord)) {
      rememberStructuredSender(sessionKey, eventRecord, ctxRecord, senderId);
    }
  });

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
