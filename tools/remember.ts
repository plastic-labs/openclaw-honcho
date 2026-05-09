import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";

export function registerRememberTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_remember",
      label: "Remember in Honcho",
      description:
        "Explicitly save a durable conclusion to Honcho. Use when the user asks to remember something or when important project state must be persisted now.",
      parameters: Type.Object(
        {
          content: Type.String({
            description:
              "The durable fact, preference, decision, or project state to save. Write it as a concise standalone memory.",
            minLength: 1,
          }),
          about: Type.Optional(
            Type.String({
              description:
                "Sender ID of the participant the memory is about. Defaults to the current session participant. Ignored when observed is 'agent'.",
            })
          ),
          observed: Type.Optional(
            Type.Unsafe<"participant" | "agent">({
              type: "string",
              enum: ["participant", "agent"],
              description:
                "Who the memory is about. Default: participant. Use agent for assistant/self operating lessons; agent memories always use the agent peer and ignore about.",
            })
          ),
          attachToCurrentSession: Type.Optional(
            Type.Boolean({
              description: "Attach the conclusion to the current Honcho session. Default: true.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const {
          content: rawContent,
          about,
          observed = "participant",
          attachToCurrentSession = true,
        } = params as {
          content: string;
          about?: string;
          observed?: "participant" | "agent";
          attachToCurrentSession?: boolean;
        };
        const content = rawContent.trim();
        if (!content) throw new Error("content required");

        const sessionKey = buildSessionKey(toolCtx);
        const agentId = toolCtx.agentId ?? state.resolveDefaultAgentId();

        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(agentId);
        const observedPeer =
          observed === "agent"
            ? agentPeer
            : about
              ? await state.getParticipantPeer(about)
              : await state.resolveSessionParticipantPeer(sessionKey);
        const scope = observed === "agent" ? agentPeer.conclusions : agentPeer.conclusionsOf(observedPeer);

        const sessionId = attachToCurrentSession ? sessionKey : undefined;
        if (sessionId) {
          await state.honcho.session(sessionId, { metadata: { agentId } });
        }

        const created = await scope.create({ content, ...(sessionId ? { sessionId } : {}) });
        const first = created[0];
        if (!first) {
          throw new Error("honcho_remember: Honcho returned no created conclusions; memory was not saved");
        }

        return {
          content: [
            {
              type: "text",
              text: `Saved to Honcho (${observedPeer.id})${first?.id ? `: ${first.id}` : ""}`,
            },
          ],
          details: {
            id: first?.id,
            content,
            observer: agentPeer.id,
            observed: observedPeer.id,
            sessionId: sessionId ?? null,
            workspaceId: state.cfg.workspaceId,
          },
        };
      },
    }),
    { name: "honcho_remember" }
  );
}
