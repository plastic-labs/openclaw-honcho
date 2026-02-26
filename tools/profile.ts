import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerProfileTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    {
      name: "honcho_profile",
      label: "Get User Profile",
      description: `Retrieve the user's peer card — a curated list of their most important facts. Direct data access, no LLM reasoning.

        ━━━ DATA TOOL ━━━
        Returns: Raw fact list
        Cost: Minimal (database query only)
        Speed: Instant

        Best for:
        - Quick context at conversation start
        - Checking core identity (name, role, company)
        - Cost-efficient fact lookup
        - When you want to see the facts and reason over them yourself

        Returns facts like:
        • Name, role, company
        • Primary technologies and tools
        • Communication preferences
        • Key projects or constraints

        ━━━ vs Q&A Tools ━━━
        • honcho_recall: Asks Honcho's LLM a question → get an answer (costs more)
        • honcho_profile: Get the raw facts → you interpret (cheaper)

        Use honcho_recall if you need Honcho to answer a specific question.
        Use honcho_profile if you want the key facts to reason over yourself.`,
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        await state.ensureInitialized();

        const card = await state.ownerPeer!.card().catch(() => null);

        if (!card?.length) {
          return {
            content: [
              {
                type: "text",
                text: "No profile facts available yet. The user's profile builds over time through conversations.",
              },
            ],
            details: undefined,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `## User Profile\n\n${card.map((f) => `• ${f}`).join("\n")}`,
            },
          ],
          details: undefined,
        };
      },
    },
    { name: "honcho_profile" }
  );
}
