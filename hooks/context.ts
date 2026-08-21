// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, extractSenderId, isSubagentSession } from "../helpers.js";

const CONTEXT_PREFIX = "## User Memory Context\n\n";
const CONTEXT_SUFFIX =
  "\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.";
const TRUNCATION_NOTICE =
  "\n\n[Automatic Honcho context truncated; use honcho_context for user memory or honcho_session for session history.]";

type InjectedContextSections = {
  peerCard?: string;
  representation?: string;
  summary?: string;
};

function truncateAtBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";

  let candidate = value.slice(0, maxChars);
  const lastCodeUnit = candidate.charCodeAt(candidate.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    candidate = candidate.slice(0, -1);
  }

  const minimumUsefulBoundary = Math.floor(maxChars * 0.6);
  const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
  return (boundary >= minimumUsefulBoundary ? candidate.slice(0, boundary) : candidate).trimEnd();
}

function renderSections(sections: InjectedContextSections): string {
  return [
    sections.peerCard ? `Key facts:\n${sections.peerCard}` : undefined,
    sections.representation ? `User context:\n${sections.representation}` : undefined,
    sections.summary ? `Earlier in this conversation:\n${sections.summary}` : undefined,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

function formatInjectedContext(sections: InjectedContextSections, maxChars?: number): string {
  const full = `${CONTEXT_PREFIX}${renderSections(sections)}${CONTEXT_SUFFIX}`;
  if (maxChars === undefined || full.length <= maxChars) return full;

  const bounded = { ...sections };
  const reductionOrder: Array<keyof InjectedContextSections> = [
    "representation",
    "summary",
    "peerCard",
  ];
  const renderBounded = () =>
    `${CONTEXT_PREFIX}${renderSections(bounded)}${TRUNCATION_NOTICE}${CONTEXT_SUFFIX}`;

  let result = renderBounded();
  for (const key of reductionOrder) {
    if (result.length <= maxChars) break;
    const value = bounded[key];
    if (!value) continue;

    const targetLength = value.length - (result.length - maxChars);
    const truncated = truncateAtBoundary(value, targetLength);
    if (truncated) {
      bounded[key] = truncated;
    } else {
      delete bounded[key];
    }
    result = renderBounded();
  }

  if (result.length <= maxChars) return result;

  // The configured minimum leaves room for the wrapper, but keep this final
  // guard so future wording changes cannot violate the advertised hard cap.
  const bodyBudget = Math.max(
    0,
    maxChars - CONTEXT_PREFIX.length - TRUNCATION_NOTICE.length - CONTEXT_SUFFIX.length,
  );
  const boundedBody = truncateAtBoundary(renderSections(bounded), bodyBudget);
  return `${CONTEXT_PREFIX}${boundedBody}${TRUNCATION_NOTICE}${CONTEXT_SUFFIX}`;
}

export function registerContextHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) return;

    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
    const isSubagent = isSubagentSession(ctx);

    state.turnStartIndex.set(sessionKey, event.messages.length);

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      // Prefer the sender of the current inbound message — capture has not
      // run yet for this turn, so session metadata still reflects the previous
      // speaker. In group chats this would otherwise build context against the
      // prior participant's representation whenever the speaker changes.
      const currentSenderId = extractSenderId(event.prompt);
      const participantPeer = currentSenderId
        ? await state.getParticipantPeer(currentSenderId)
        : await state.resolveSessionParticipantPeer(sessionKey);

      const sections: InjectedContextSections = {};

      if (isSubagent) {
        try {
          const peerCtx = await agentPeer.context({ target: participantPeer });
          if (peerCtx.peerCard?.length) {
            sections.peerCard = peerCtx.peerCard.map((fact: string) => `• ${fact}`).join("\n");
          }
          if (peerCtx.representation) {
            sections.representation = peerCtx.representation;
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
          sections.peerCard = context.peerCard.map((fact) => `• ${fact}`).join("\n");
        }
        if (context.peerRepresentation) {
          sections.representation = context.peerRepresentation;
        }
        if (context.summary?.content) {
          sections.summary = context.summary.content;
        }
      }

      if (!sections.peerCard && !sections.representation && !sections.summary) return;

      // Use appendSystemContext instead of systemPrompt to avoid overriding
      // other plugins' prompt contributions. appendSystemContext is appended
      // to the system prompt and benefits from provider prompt caching.
      return {
        appendSystemContext: formatInjectedContext(sections, state.cfg.contextMaxChars),
      };
    } catch (error) {
      api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
      return;
    }
  });
}
