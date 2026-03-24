import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerMessageSearchTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    {
      name: "honcho_message_search",
      label: "Search Messages",
      description:
        "Search messages across the entire workspace with optional filters. Hybrid semantic + full-text search. Filter by session, peer, metadata, or date range.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Search query — matched semantically and via full-text.",
          }),
          session_id: Type.Optional(
            Type.String({
              description: "Filter to messages in a specific session.",
            })
          ),
          peer_id: Type.Optional(
            Type.String({
              description: "Filter to messages from a specific peer.",
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
          session_id,
          peer_id,
          metadata,
          created_after,
          created_before,
          limit,
        } = params as {
          query: string;
          session_id?: string;
          peer_id?: string;
          metadata?: Record<string, unknown>;
          created_after?: string;
          created_before?: string;
          limit?: number;
        };

        await state.ensureInitialized();

        // Build filters dict from individual parameters
        const filters: Record<string, unknown> = {};

        if (session_id) filters.session_id = session_id;
        if (peer_id) filters.peer_id = peer_id;
        if (metadata && Object.keys(metadata).length > 0) filters.metadata = metadata;

        if (created_after || created_before) {
          const createdAt: Record<string, string> = {};
          if (created_after) createdAt.gte = created_after;
          if (created_before) createdAt.lte = created_before;
          filters.created_at = createdAt;
        }

        const hasFilters = Object.keys(filters).length > 0;
        const messages = await state.honcho.search(query, {
          filters: hasFilters ? filters : undefined,
          limit: limit ?? 10,
        });

        if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found for: "${query}"${hasFilters ? " (with filters applied)" : ""}`,
              },
            ],
            details: { query, filters: hasFilters ? filters : null, count: 0 },
          };
        }

        const results = messages.map((msg) => ({
          id: msg.id,
          content: msg.content,
          peer_id: msg.peerId,
          session_id: msg.sessionId,
          created_at: msg.createdAt ?? null,
          ...(msg.metadata && Object.keys(msg.metadata).length > 0
            ? { metadata: msg.metadata }
            : {}),
        }));

        const text = results
          .map(
            (r, i) =>
              `[${i + 1}] ${r.peer_id} (${r.session_id}) ${r.created_at ?? ""}:\n${r.content}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `## Message Search: "${query}" (${results.length} result${results.length === 1 ? "" : "s"})\n\n${text}`,
            },
          ],
          details: { query, filters: hasFilters ? filters : null, count: results.length, results },
        };
      },
    },
    { name: "honcho_message_search" }
  );
}
