import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";

export function registerWorkspaceChatTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    () => ({
      name: "honcho_workspace_chat",
      label: "Ask Honcho Workspace",
      description:
        "Ask Honcho a question about everyone in the workspace: every participant, session and agent, not just the current user. Use it for cross-person questions ('who mentioned X?', 'what do people here have in common?'). For questions about the current user alone, use honcho_ask.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Question about the workspace (e.g., 'Who has a dog?', 'What topics come up across conversations?')",
          }),
          depth: Type.Optional(
            Type.Unsafe<"quick" | "thorough">({
              type: "string",
              enum: ["quick", "thorough"],
              description: "Reasoning depth: 'quick' for simple facts (default), 'thorough' for synthesis and analysis.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { query, depth = "quick" } = params as {
          query: string;
          depth?: "quick" | "thorough";
        };

        await state.ensureInitialized();
        const answer = await state.honcho.chat(query, {
          reasoningLevel: depth === "thorough" ? "high" : "low",
        });

        return {
          content: [{ type: "text", text: answer ?? "Honcho has no relevant information in this workspace." }],
          details: { query, depth },
        };
      },
    }),
    { name: "honcho_workspace_chat" }
  );
}
