import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerAnalyzeTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_analyze",
      label: "Analyze with Honcho",
      description: `Ask Honcho a complex question requiring synthesis and get an analyzed answer. Uses Honcho's LLM with medium reasoning.

━━━ Q&A TOOL ━━━
Returns: Synthesized analysis answering your question
Cost: ~$0.05 (LLM call with medium reasoning — multiple searches, directed synthesis)
Speed: Fast

Best for:
- Questions requiring context from multiple interactions
- Synthesizing patterns or preferences
- Understanding communication style or working patterns
- Briefings or summaries on specific topics
- Questions about history or evolution

Examples:
- "What topics interest the user?" → Briefing with ranked interests
- "Describe the user's communication style." → Style profile
- "What key decisions came from our last sessions?" → Decision summary
- "How does the user prefer to receive feedback?" → Preference analysis
- "What concerns has the user raised about this project?" → Concern synthesis

NOT suitable for:
- Simple factual lookups (use honcho_recall — cheaper)
- When you want to see raw evidence (use honcho_search — cheaper)

━━━ vs Data Tools ━━━
• honcho_search: Returns raw matching memories → you interpret (cheaper)
• honcho_context: Returns broad representation → you interpret (cheaper)
• honcho_analyze: Honcho synthesizes an answer → direct analysis (costs more)

Use data tools if you want to see the evidence and reason yourself.
Use honcho_analyze if you need Honcho to synthesize a complex answer.`,
      parameters: Type.Object({
        query: Type.String({
          description:
            "Complex question requiring synthesis (e.g., 'Describe their communication style', 'What patterns in their concerns?')",
        }),
      }),
      async execute(_toolCallId, params) {
        const { query } = params as { query: string };
        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(toolCtx.agentId);
        const answer = await agentPeer.chat(query, {
          target: state.ownerPeer!,
          reasoningLevel: "medium",
        });
        return {
          content: [{ type: "text", text: answer! }],
          details: undefined,
        };
      },
    }),
    { name: "honcho_analyze" }
  );
}
