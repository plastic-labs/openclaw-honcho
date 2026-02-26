import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { cleanMessageContent } from "../helpers.js";

export function registerSessionTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_session",
      label: "Get Session History",
      description: `Retrieve conversation history from THIS SESSION ONLY. Does NOT access cross-session memory.

━━━ SCOPE: CURRENT SESSION ━━━
This tool retrieves messages and summaries from the current conversation session.
It does NOT know about previous sessions or long-term user knowledge.

━━━ DATA TOOL ━━━
Returns: Recent messages + optional summary of earlier conversation in this session
Cost: Low (database query only, no LLM)
Speed: Fast

Best for:
- "What did we talk about earlier?" (in this conversation)
- "What was that thing you just mentioned?"
- "Can you remind me what we decided?" (this session)
- Recalling recent conversation context

NOT for:
- "What do you know about me?" → Use honcho_context instead
- "What have we discussed in past sessions?" → Use honcho_search instead
- Long-term user preferences → Use honcho_profile or honcho_context

Parameters:
- includeMessages: Get recent message history (default: true)
- includeSummary: Get summary of earlier conversation (default: true)
- searchQuery: Optional semantic search within this session
- messageLimit: Approximate token budget for messages (default: 4000)

━━━ vs honcho_context ━━━
• honcho_session: THIS session only — "what did we just discuss?"
• honcho_context: ALL sessions — "what do I know about this user?"`,
      parameters: Type.Object({
        includeMessages: Type.Optional(
          Type.Boolean({
            description: "Include recent message history (default: true)",
          })
        ),
        includeSummary: Type.Optional(
          Type.Boolean({
            description:
              "Include summary of earlier conversation (default: true)",
          })
        ),
        searchQuery: Type.Optional(
          Type.String({
            description:
              "Optional semantic search query to find specific topics in the conversation",
          })
        ),
        messageLimit: Type.Optional(
          Type.Number({
            description:
              "Approximate token budget for messages (default: 4000). Lower values return fewer but more recent messages.",
            minimum: 100,
            maximum: 32000,
          })
        ),
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session identifier to retrieve history for (default: current session)",
          })
        ),
      }),
      async execute(_toolCallId, params, _signal) {
        const {
          includeMessages = true,
          includeSummary = true,
          searchQuery,
          messageLimit = 4000,
          sessionKey: sessionKeyParam,
        } = params as {
          includeMessages?: boolean;
          includeSummary?: boolean;
          searchQuery?: string;
          messageLimit?: number;
          sessionKey?: string;
        };

        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(toolCtx.agentId);

        const sessionKey = sessionKeyParam ?? "default";

        try {
          const session = await state.honcho.session(sessionKey);

          const context = await session.context({
            summary: includeSummary,
            tokens: messageLimit,
            peerTarget: state.ownerPeer!,
            peerPerspective: agentPeer,
            searchQuery: searchQuery,
          });

          const sections: string[] = [];

          if (context.summary?.content) {
            sections.push(
              `## Earlier Conversation Summary\n\n${context.summary.content}`
            );
          }

          if (context.peerCard?.length) {
            sections.push(
              `## User Profile\n\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`
            );
          }

          if (context.peerRepresentation) {
            sections.push(
              `## User Context\n\n${context.peerRepresentation}`
            );
          }

          if (includeMessages && context.messages.length > 0) {
            const messageLines = context.messages.map((msg) => {
              const speaker = msg.peerId === state.ownerPeer!.id ? "User" : "OpenClaw";
              const timestamp = msg.createdAt
                ? new Date(msg.createdAt).toLocaleString()
                : "";
              return `**${speaker}**${timestamp ? ` (${timestamp})` : ""}:\n${cleanMessageContent(msg.content as string)}`;
            });
            sections.push(
              `## Recent Messages (${context.messages.length})\n\n${messageLines.join("\n\n---\n\n")}`
            );
          }

          if (sections.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No conversation history available for this session yet.",
                },
              ],
              details: undefined,
            };
          }

          const searchNote = searchQuery
            ? `\n\n*Results filtered by search: "${searchQuery}"*`
            : "";

          return {
            content: [
              {
                type: "text",
                text: sections.join("\n\n---\n\n") + searchNote,
              },
            ],
            details: undefined,
          };
        } catch (error) {
          const isNotFound =
            error instanceof Error &&
            (error.name === "NotFoundError" ||
              error.message.toLowerCase().includes("not found"));

          if (isNotFound) {
            return {
              content: [
                {
                  type: "text",
                  text: "No conversation history found. This appears to be a new session.",
                },
              ],
              details: undefined,
            };
          }

          throw error;
        }
      },
    }),
    { name: "honcho_session" }
  );
}
