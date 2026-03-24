import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Message } from "@honcho-ai/sdk";
import type { PluginState } from "../state.js";

export function registerMessageSearchTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_search_messages",
      label: "Search Messages",
      description:
        "Search conversation messages across all sessions. Hybrid semantic + full-text search. Filter by sender (user/agent/all), date range, or metadata.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Search query — matched semantically and via full-text.",
          }),
          from: Type.Optional(
            Type.Unsafe<"user" | "agent" | "all">({
              type: "string",
              enum: ["user", "agent", "all"],
              description:
                "Filter by sender: 'user' for user messages, 'agent' for this agent's messages, 'all' for everything (default: 'all').",
            })
          ),
          metadata: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                'Filter by message metadata. Equality: {"key":"value"}. Comparison: {"key":{"gte":5}}. Operators: gte, lte, gt, lt, ne, in, contains, icontains.',
            })
          ),
          created_after: Type.Optional(
            Type.String({
              description: "ISO datetime — only messages after this time (e.g. '2025-01-15T00:00:00').",
            })
          ),
          created_before: Type.Optional(
            Type.String({
              description: "ISO datetime — only messages before this time.",
            })
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Max results (1-100, default 10).",
              minimum: 1,
              maximum: 100,
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const {
          query,
          from = "all",
          metadata,
          created_after,
          created_before,
          limit,
        } = params as {
          query: string;
          from?: "user" | "agent" | "all";
          metadata?: Record<string, unknown>;
          created_after?: string;
          created_before?: string;
          limit?: number;
        };

        await state.ensureInitialized();

        // Build filters from remaining parameters (metadata, date range)
        const filters: Record<string, unknown> = {};

        if (metadata && Object.keys(metadata).length > 0) filters.metadata = metadata;

        if (created_after || created_before) {
          const createdAt: Record<string, string> = {};
          if (created_after) createdAt.gte = created_after;
          if (created_before) createdAt.lte = created_before;
          filters.created_at = createdAt;
        }

        const hasFilters = Object.keys(filters).length > 0;
        const searchOpts = {
          filters: hasFilters ? filters : undefined,
          limit: limit ?? 10,
        };

        // Route to the appropriate search method based on `from`
        let messages: Message[];
        if (from === "user") {
          messages = await state.ownerPeer!.search(query, searchOpts);
        } else if (from === "agent") {
          const agentPeer = await state.getAgentPeer(toolCtx.agentId);
          messages = await agentPeer.search(query, searchOpts);
        } else {
          messages = await state.honcho.search(query, searchOpts);
        }

        if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found for: "${query}"${from !== "all" ? ` (from: ${from})` : ""}${hasFilters ? " (with filters applied)" : ""}`,
              },
            ],
            details: { query, from, filters: hasFilters ? filters : null, count: 0 },
          };
        }

        const results = messages.map((msg) => {
          const speaker = msg.peerId === state.ownerPeer!.id ? "User" : "Agent";
          return {
            id: msg.id,
            content: msg.content,
            speaker,
            session_id: msg.sessionId,
            created_at: msg.createdAt ?? null,
            ...(msg.metadata && Object.keys(msg.metadata).length > 0
              ? { metadata: msg.metadata }
              : {}),
          };
        });

        const MAX_PREVIEW = 800;
        const text = results
          .map((r, i) => {
            const preview =
              r.content.length > MAX_PREVIEW
                ? `${r.content.slice(0, MAX_PREVIEW)}… (truncated)`
                : r.content;
            return `[${i + 1}] ${r.speaker} (${r.session_id}) ${r.created_at ?? ""}:\n${preview}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `## Message Search: "${query}" (${results.length} result${results.length === 1 ? "" : "s"})\n\n${text}`,
            },
          ],
          details: { query, from, filters: hasFilters ? filters : null, count: results.length, results },
        };
      },
    }),
    { name: "honcho_search_messages" }
  );
}
