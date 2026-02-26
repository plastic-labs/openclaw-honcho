import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerRecallTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_recall",
      label: "Recall from Honcho",
      description: `Ask Honcho a simple factual question and get a direct answer. Uses Honcho's LLM with minimal reasoning.

        ━━━ Q&A TOOL ━━━
          Returns: Direct answer to your question
          Cost: ~$0.001 (LLM call with minimal reasoning)
          Speed: Instant

          Best for:
          - Simple factual questions with direct answers
          - Single data points (names, dates, preferences)
          - When you need THE answer, not raw data

          Examples:
          - "What's the user's name?" → "Alex Chen"
          - "What timezone is the user in?" → "Pacific Time (PT)"
          - "What programming language do they prefer?" → "TypeScript"
          - "What's their job title?" → "Senior Engineer"

          NOT suitable for:
          - Questions requiring synthesis across multiple facts
          - Pattern recognition or analysis
          - Complex multi-part questions

          ━━━ vs Data Tools ━━━
          • honcho_profile: Returns raw key facts → you interpret (cheaper)
          • honcho_recall: Honcho answers your question → direct answer (costs more)

          Use honcho_profile if you want to see the facts and reason yourself.
          Use honcho_recall if you just need a quick answer to a simple question.`,
      parameters: Type.Object({
        query: Type.String({
          description:
            "Simple factual question (e.g., 'What's their name?', 'What timezone?', 'Preferred language?')",
        }),
      }),
      async execute(_toolCallId, params) {
        const { query } = params as { query: string };
        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(toolCtx.agentId);
        const answer = await agentPeer.chat(query, {
          target: state.ownerPeer!,
          reasoningLevel: "minimal",
        });
        return {
          content: [{ type: "text", text: answer! }],
          details: undefined,
        };
      },
    }),
    { name: "honcho_recall" }
  );
}
