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
  getRawContent,
} from "../helpers.js";
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
  if (!messages?.length) return 0;

  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (m && typeof m === "object" && m.role === "user") {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return 0;
  const turn = messages.slice(turnStart);

  const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
  const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
  const openclawSessionKey = normalizeSessionKey(ctx.sessionKey);
  const sessionClass = classifySession(openclawSessionKey);
  const isSubagent = isSubagentSession(ctx);
  const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;

  // Cron/heartbeat runs are machine text; drop them unless configured.
  const provenance = state.turnProvenance?.get(sessionKey) ?? ctx.inputProvenance;
  const isSystemRun =
    sessionClass === "cron" ||
    ctx.trigger === "cron" ||
    ctx.trigger === "heartbeat" ||
    provenance?.kind === "internal_system";
  if (isSystemRun && !state.cfg.captureSystemRuns) return 0;

  await state.ensureInitialized();
  const agentPeer = await state.getAgentPeer(agentId);
  const parentPeer =
    isSubagent && parentAgentId && parentAgentId !== agentId
      ? await state.getAgentPeer(parentAgentId)
      : null;

  // Sender of the turn's user message: the run's ctx.senderId, the inline
  // block on pre-2026.8 hosts, or — for sessions_send — the sending agent (#35).
  const sourceAgentId =
    provenance?.kind === "inter_session"
      ? /^agent:([^:]+)/.exec(provenance.sourceSessionKey ?? "")?.[1]?.toLowerCase()
      : undefined;
  const sourceAgentPeer = sourceAgentId ? await state.getAgentPeer(sourceAgentId) : null;
  const senderId =
    (typeof ctx.senderId === "string" && ctx.senderId.length > 0 ? ctx.senderId : undefined) ??
    extractSenderId(getRawContent(turn[0]));

  const participantPeer = sourceAgentPeer ?? (await state.getParticipantPeer(senderId));

  const extracted = extractMessages(
    turn,
    participantPeer,
    agentPeer,
    state.cfg.noisePatterns,
    undefined,
    () => senderId,
  );
  if (extracted.length === 0) return 0;

  const session = await state.honcho.session(sessionKey);
  const meta = await session.getMetadata();
  const existingMeta: Record<string, unknown> =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

  const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = [
    [OWNER_ID, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers }],
    [agentPeer.id, { observeMe: true, observeOthers: true }],
  ];
  if (participantPeer.id !== OWNER_ID && participantPeer.id !== agentPeer.id) {
    peerConfigs.push([
      participantPeer.id,
      sourceAgentPeer
        ? { observeMe: true, observeOthers: true }
        : { observeMe: true, observeOthers: state.cfg.ownerObserveOthers },
    ]);
  }
  if (parentPeer) peerConfigs.push([parentPeer.id, { observeMe: false, observeOthers: true }]);
  await session.addPeers(peerConfigs);

  // Honcho rejects >100 messages per request.
  for (let i = 0; i < extracted.length; i += 100) {
    await session.addMessages(extracted.slice(i, i + 100));
  }

  await session.setMetadata({
    ...existingMeta,
    agentId,
    openclawSessionKey,
    sessionClass,
    ...(ctx.messageProvider ? { messageProvider: ctx.messageProvider } : {}),
    ...(ctx.sessionId ? { lastSessionId: ctx.sessionId } : {}),
    ...(isSubagent ? { isSubagent: true, ...(parentPeer ? { parentPeerId: parentPeer.id } : {}) } : {}),
    // Last human sender; tools use it to resolve the session's participant peer.
    ...(senderId && !sourceAgentPeer ? { participantSenderId: senderId } : {}),
  });

  return extracted.length;
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
