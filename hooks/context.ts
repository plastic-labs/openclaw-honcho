// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, extractSenderId, isSubagentSession } from "../helpers.js";

type SenderResolution =
  | { status: "valid"; senderId?: string }
  | { status: "conflict" };

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function nestedChannelSenderId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const channelContext = (value as Record<string, unknown>).channelContext;
  if (!channelContext || typeof channelContext !== "object") return undefined;
  const sender = (channelContext as Record<string, unknown>).sender;
  if (!sender || typeof sender !== "object") return undefined;
  return nonEmptyString((sender as Record<string, unknown>).id);
}

function resolveCurrentSender(ctx: unknown, prompt: string): SenderResolution {
  const context = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  const typedSenders = [nonEmptyString(context.senderId), nestedChannelSenderId(context)].filter(
    (senderId): senderId is string => Boolean(senderId),
  );
  const uniqueTypedSenders = [...new Set(typedSenders)];

  if (uniqueTypedSenders.length > 1) return { status: "conflict" };
  if (uniqueTypedSenders.length === 1) {
    return { status: "valid", senderId: uniqueTypedSenders[0] };
  }

  // Compatibility for older OpenClaw hosts that did not expose typed sender
  // identity to before_prompt_build. Current hosts must use the typed path so
  // model-facing prompt text cannot override the participant selection.
  return { status: "valid", senderId: extractSenderId(prompt) };
}

export function registerContextHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) return;

    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
    const isSubagent = isSubagentSession(ctx);

    state.turnStartIndex.set(sessionKey, event.messages.length);

    const sender = resolveCurrentSender(ctx, event.prompt);
    if (sender.status === "conflict") {
      api.logger.warn?.(
        "[honcho] Conflicting typed sender identities; skipping automatic context injection",
      );
      return;
    }

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      // Prefer the sender of the current inbound message — capture has not
      // run yet for this turn, so session metadata still reflects the previous
      // speaker. In group chats this would otherwise build context against the
      // prior participant's representation whenever the speaker changes.
      const participantPeer = sender.senderId
        ? await state.getParticipantPeer(sender.senderId)
        : await state.resolveSessionParticipantPeer(sessionKey);

      const sections: string[] = [];

      if (isSubagent) {
        try {
          const peerCtx = await agentPeer.context({ target: participantPeer });
          if (peerCtx.peerCard?.length) {
            sections.push(`Key facts:\n${peerCtx.peerCard.map((f: string) => `• ${f}`).join("\n")}`);
          }
          if (peerCtx.representation) {
            sections.push(`User context:\n${peerCtx.representation}`);
          }
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) return;
          throw e;
        }
      } else {
        const session = await state.honcho.session(sessionKey, { metadata: { agentId } });

        let context;
        try {
          context = await session.context({
            summary: true,
            tokens: 2000,
            peerTarget: participantPeer,
            peerPerspective: agentPeer,
          });
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) return;
          throw e;
        }

        if (context.peerCard?.length) {
          sections.push(`Key facts:\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`);
        }
        if (context.peerRepresentation) {
          sections.push(`User context:\n${context.peerRepresentation}`);
        }
        if (context.summary?.content) {
          sections.push(`Earlier in this conversation:\n${context.summary.content}`);
        }
      }

      if (sections.length === 0) return;

      const formatted = sections.join("\n\n");

      // Use appendSystemContext instead of systemPrompt to avoid overriding
      // other plugins' prompt contributions. appendSystemContext is appended
      // to the system prompt and benefits from provider prompt caching.
      return {
        appendSystemContext: `## User Memory Context\n\n${formatted}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
      };
    } catch (error) {
      api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
      return;
    }
  });
}
