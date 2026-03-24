import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerSearchTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    {
      name: "honcho_search_conclusions",
      label: "Search Honcho conclusions",
      description:
        "Semantic vector search over stored conclusions about the user. Returns raw memories ranked by relevance. Use for finding specific past context, decisions, or preferences.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Semantic search query (keywords, phrases, or natural language)",
          }),
          topK: Type.Optional(
            Type.Number({
              description: "Number of results: 3-5 for focused, 10-20 for exploratory (default: 10)",
              minimum: 1,
              maximum: 100,
            })
          ),
          maxDistance: Type.Optional(
            Type.Number({
              description: "Semantic distance threshold: 0.3 strict, 0.5 balanced (default), 0.7 loose",
              minimum: 0,
              maximum: 1,
            })
          ),
        },
        { additionalProperties: false }
      ),
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
            details: { query, resultCount: 0 },
          };
        }

        return {
          content: [{ type: "text", text: `## Search Results: "${query}"\n\n${representation}` }],
          details: { query, resultCount: representation.split("\n").filter(Boolean).length },
        };
      },
    },
    { name: "honcho_search_conclusions" }
  );
}
