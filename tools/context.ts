import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";

export function registerContextTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    {
      name: "honcho_context",
      label: "Get User Context",
      description:
        "Retrieve stored knowledge about the user across all sessions. Use 'card' for a quick key-facts list, 'full' for the complete representation.",
      parameters: Type.Object(
        {
          detail: Type.Optional(
            Type.Unsafe<"card" | "full">({
              type: "string",
              enum: ["card", "full"],
              description: "Detail level: 'card' for key facts (default, fast), 'full' for broad representation.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { detail = "card" } = params as { detail?: "card" | "full" };

        await state.ensureInitialized();

        if (detail === "card") {
          const card = await state.ownerPeer!.card().catch((err) => {
            // Only treat NotFoundError as empty; re-throw others or log
            if (err?.name === "NotFoundError") return null;
            // Optionally log unexpected errors for debugging
            console.warn("honcho_context card() error:", err);
            return null;
          });

          if (!card?.length) {
            return {
              content: [
                {
                  type: "text",
                  text: "No profile facts available yet. The user's profile builds over time through conversations.",
                },
              ],
              details: { detail, factCount: 0 },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `## User Profile\n\n${card.map((f) => `• ${f}`).join("\n")}`,
              },
            ],
            details: { detail, factCount: card.length },
          };
        }

        // detail === "full"
        const representation = await state.ownerPeer!.representation({
          includeMostFrequent: true,
        });

        if (!representation) {
          return {
            content: [
              {
                type: "text",
                text: "No context available yet. Context builds over time through conversations.",
              },
            ],
            details: { detail, representationLength: 0 },
          };
        }

        return {
          content: [{ type: "text", text: `## User Context\n\n${representation}` }],
          details: { detail, representationLength: representation.length },
        };
      },
    },
    { name: "honcho_context" }
  );
}
