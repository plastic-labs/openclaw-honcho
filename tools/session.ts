import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, cleanMessageContent } from "../helpers.js";

export function registerSessionTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_session",
      label: "Get Session History",
      description:
        "Retrieve conversation history and summary from the current session. Supports semantic search within the session. Does not access cross-session memory.",
      parameters: Type.Object(
        {
          includeMessages: Type.Optional(
            Type.Boolean({
              description: "Include recent message history (default: true)",
            })
          ),
          includeSummary: Type.Optional(
            Type.Boolean({
              description: "Include summary of earlier conversation (default: true)",
            })
          ),
          searchQuery: Type.Optional(
            Type.String({
              description: "Semantic search query to find specific topics in the conversation",
            })
          ),
          messageLimit: Type.Optional(
            Type.Number({
              description: "Approximate token budget for messages (default: 4000)",
              minimum: 100,
              maximum: 32000,
            })
          ),
          about: Type.Optional(
            Type.String({
              description:
                "Sender ID of the user to get session context for. Defaults to the last active sender. Pass a specific sender_id to get session context about a different participant.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const {
          includeMessages = true,
          includeSummary = true,
          searchQuery,
          messageLimit = 4000,
          about,
        } = params as {
          includeMessages?: boolean;
          includeSummary?: boolean;
          searchQuery?: string;
          messageLimit?: number;
          about?: string;
        };

        await state.ensureInitialized();
        const agentPeer = await state.getAgentPeer(toolCtx.agentId);
        const sessionKey = buildSessionKey({
          sessionKey: toolCtx.sessionKey,
          agentId: toolCtx.agentId,
        });
        const participantPeer = about
          ? await state.getParticipantPeer(about)
          : await state.resolveSessionParticipantPeer(sessionKey);

        try {
          const session = await state.honcho.session(sessionKey);

          const context = await session.context({
            summary: includeSummary,
            tokens: messageLimit,
            peerTarget: participantPeer,
            peerPerspective: agentPeer,
            representationOptions: searchQuery ? { searchQuery } : undefined,
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
              const speaker = state.isParticipantPeerId(msg.peerId) ? "User" : "OpenClaw";
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
              details: { messageCount: 0, hasSummary: false, sessionKey },
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
            details: {
              messageCount: context.messages.length,
              hasSummary: !!context.summary?.content,
              sessionKey,
            },
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
              details: { messageCount: 0, hasSummary: false, sessionKey },
            };
          }

          throw error;
        }
      },
    }),
    { name: "honcho_session" }
  );
}
