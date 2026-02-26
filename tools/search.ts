import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerSearchTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    {
      name: "honcho_search",
      label: "Search Honcho Memory",
      description: `Semantic vector search over Honcho's stored observations. Returns raw memories ranked by relevance — no LLM
interpretation.

━━━ DATA TOOL ━━━
Returns: Raw observations/conclusions matching your query
Cost: Low (vector search only, no LLM)
Speed: Fast

Best for:
- Finding specific past context (projects, decisions, discussions)
- Seeing the evidence before drawing conclusions
- Cost-efficient exploration of memory
- When you want to reason over the raw data yourself

Examples:
- "API design decisions" → raw observations about API discussions
- "testing preferences" → raw memories about testing
- "deployment concerns" → observations mentioning deployment issues

Parameters:
- topK: 3-5 for focused, 10-20 for exploratory (default: 10)
- maxDistance: 0.3 = strict, 0.5 = balanced, 0.7 = loose (default: 0.5)

━━━ vs Q&A Tools ━━━
• honcho_analyze: Asks Honcho's LLM to synthesize → get an answer (costs more)
• honcho_search: Get raw matching memories → you interpret (cheaper)

Use honcho_analyze if you need Honcho to synthesize an answer.
Use honcho_search if you want the raw evidence to reason over yourself.`,
      parameters: Type.Object({
        query: Type.String({
          description:
            "Semantic search query — keywords, phrases, or natural language (e.g., 'debugging strategies', 'opinions on microservices')",
        }),
        topK: Type.Optional(
          Type.Number({
            description:
              "Number of results. 3-5 for focused, 10-20 for exploratory (default: 10)",
            minimum: 1,
            maximum: 100,
          })
        ),
        maxDistance: Type.Optional(
          Type.Number({
            description:
              "Semantic distance. 0.3 = strict, 0.5 = balanced (default), 0.7 = loose",
            minimum: 0,
            maximum: 1,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const { query, topK, maxDistance } = params as {
          query: string;
          topK?: number;
          maxDistance?: number;
        };

        await state.ensureInitialized();

        const representation = await state.ownerPeer!.representation({
          searchQuery: query,
          searchTopK: topK ?? 10,
          searchMaxDistance: maxDistance ?? 0.5,
        });

        if (!representation) {
          return {
            content: [
              {
                type: "text",
                text: `No memories found matching: "${query}"\n\nTry broadening your search or increasing maxDistance.`,
              },
            ],
            details: undefined,
          };
        }

        return {
          content: [{ type: "text", text: `## Search Results: "${query}"\n\n${representation}` }],
          details: undefined,
        };
      },
    },
    { name: "honcho_search" }
  );
}
