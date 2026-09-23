// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { buildSessionKey, extractSenderId, isSystemRun, sessionRecallOptions } from "../helpers.js";

export function registerContextHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) return;
    // Opening the session here would create the cron session capture refuses to write.
    if (!state.cfg.captureSystemRuns && isSystemRun(ctx)) return;

    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });

    const provenance = (ctx as { inputProvenance?: { kind?: unknown; sourceSessionKey?: unknown } })
      .inputProvenance;
    if (provenance && typeof provenance === "object") {
      state.turnProvenance?.set(sessionKey, {
        ...(typeof provenance.kind === "string" ? { kind: provenance.kind } : {}),
        ...(typeof provenance.sourceSessionKey === "string"
          ? { sourceSessionKey: provenance.sourceSessionKey }
          : {}),
      });
    } else {
      state.turnProvenance?.delete(sessionKey);
    }

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      // Prefer the current sender: capture hasn't run yet, so session metadata
      // still names the previous speaker. ctx.senderId is per-run; the prompt
      // parse only covers OpenClaw < 2026.8.
      const currentSenderId =
        (typeof ctx.senderId === "string" && ctx.senderId.length > 0
          ? ctx.senderId
          : undefined) ?? extractSenderId(event.prompt);
      const participantPeer = currentSenderId
        ? await state.getParticipantPeer(currentSenderId)
        : await state.resolveSessionParticipantPeer(sessionKey);

      const sections: string[] = [];

      // No metadata here: session() with metadata replaces what capture persisted.
      const session = await state.honcho.session(sessionKey);

      const recall = sessionRecallOptions(
        state.cfg.recall.automatic,
        state.cfg.recall.scopeName,
      );

      let context;
      try {
        context = await session.context({
          summary: true,
          tokens: 2000,
          peerTarget: participantPeer,
          // A scope replaces the perspective peer as the observer, and the
          // SDK rejects both together.
          ...(recall.scope ? {} : { peerPerspective: agentPeer }),
          ...recall,
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
