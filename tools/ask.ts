import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";

export function registerAskTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_ask",
      label: "Ask Honcho",
      description:
        "Ask Honcho a question about the user and get a direct answer. Use 'quick' depth for simple factual lookups, 'thorough' for questions requiring synthesis across multiple interactions.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Question about the user (e.g., 'What's their name?', 'Describe their communication style')",
          }),
          depth: Type.Optional(
            Type.Unsafe<"quick" | "thorough">({
              type: "string",
              enum: ["quick", "thorough"],
              description: "Reasoning depth: 'quick' for simple facts (default), 'thorough' for synthesis and analysis.",
            })
          ),
          about: Type.Optional(
            Type.String({
              description:
                "Sender ID of the user to ask about. Defaults to the last active sender. Pass a specific sender_id to ask about a different participant.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { query, depth = "quick", about } = params as {
          query: string;
          depth?: "quick" | "thorough";
          about?: string;
        };

        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(toolCtx.agentId);
        const participantPeer = about
          ? await state.getParticipantPeer(about)
          : await state.resolveSessionParticipantPeer(
              buildSessionKey({ sessionKey: toolCtx.sessionKey, agentId: toolCtx.agentId }),
            );

        const reasoningLevel = depth === "thorough" ? "high" : "low";
        const answer = await agentPeer.chat(query, {
          target: participantPeer,
          reasoningLevel,
        });

        return {
          content: [{ type: "text", text: answer! }],
          details: { query, depth },
        };
      },
    }),
    { name: "honcho_ask" }
  );
}
