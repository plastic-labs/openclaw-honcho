/**
 * Moltbot Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for Moltbot.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */

import { Type } from "@sinclair/typebox";
import { Honcho, type Peer, type Session, type MessageInput } from "@honcho-ai/sdk";
// @ts-ignore - resolved by moltbot runtime
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";

// ============================================================================
// Constants
// ============================================================================

const OWNER_ID = "owner";
const MOLTBOT_ID = "moltbot";

// ============================================================================
// Plugin Definition
// ============================================================================

const honchoPlugin = {
  id: "moltbot-honcho",
  name: "Memory (Honcho)",
  description: "AI-native memory with dialectic reasoning",
  kind: "memory" as const,
  configSchema: honchoConfigSchema,

  register(api: MoltbotPluginApi) {
    const cfg = honchoConfigSchema.parse(api.pluginConfig);

    if (!cfg.apiKey) {
      api.logger.warn(
        "moltbot-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
      );
    }

    const honcho = new Honcho({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      workspaceId: cfg.workspaceId,
    });

    let ownerPeer: Peer | null = null;
    let moltbotPeer: Peer | null = null;
    let initialized = false;

    async function ensureInitialized(): Promise<void> {
      if (initialized) return;
      ownerPeer = await honcho.peer(OWNER_ID);
      moltbotPeer = await honcho.peer(MOLTBOT_ID);
      initialized = true;
    }

    // ========================================================================
    // HOOK: gateway_start — Initialize and optionally sync files
    // ========================================================================
    api.on("gateway_start", async (_event, _ctx) => {
      api.logger.info("Initializing Honcho memory...");
      try {
        await ensureInitialized();
        api.logger.info("Honcho memory ready");
      } catch (error) {
        api.logger.error(`Failed to initialize Honcho: ${error}`);
      }
    });

    // ========================================================================
    // HOOK: agent_end — Persist messages to Honcho
    // ========================================================================
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages?.length) return;

      // Honcho session IDs only allow letters, numbers, underscores, hyphens
      // Moltbot session keys use colons (e.g., "agent:main:main")
      const rawSessionKey = ctx.sessionKey ?? "default";
      const sessionKey = rawSessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");

      try {
        await ensureInitialized();

        // Get session reference
        let session = await honcho.session(sessionKey);

        // Try to get metadata; if session doesn't exist, create it
        let meta: Record<string, unknown>;
        try {
          meta = await session.getMetadata();
        } catch (e: unknown) {
          // Session doesn't exist - create it with initial metadata
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (!isNotFound) throw e;

          // Create session by calling honcho.session with metadata
          session = await honcho.session(sessionKey, {
            metadata: { lastSavedIndex: 0 },
          });
          meta = await session.getMetadata();
        }

        const lastSavedIndex = (meta.lastSavedIndex as number) ?? 0;

        // Add peers (session now guaranteed to exist)
        await session.addPeers([
          [OWNER_ID, { observeMe: true, observeOthers: false }],
          [MOLTBOT_ID, { observeMe: true, observeOthers: true }],
        ]);

        // Skip if nothing new
        if (event.messages.length <= lastSavedIndex) {
          api.logger.debug?.("No new messages to save");
          return;
        }

        // Extract only NEW messages (slice from lastSavedIndex)
        const newRawMessages = event.messages.slice(lastSavedIndex);
        const messages = extractMessages(newRawMessages, ownerPeer!, moltbotPeer!);

        if (messages.length === 0) {
          // Update index even if no saveable content (e.g., tool-only messages)
          await session.setMetadata({ ...meta, lastSavedIndex: event.messages.length });
          return;
        }

        // Save new messages
        await session.addMessages(messages);

        // Update watermark in Honcho
        await session.setMetadata({ ...meta, lastSavedIndex: event.messages.length });

        api.logger.info?.(`Saved ${messages.length} new messages to Honcho (index ${lastSavedIndex} → ${event.messages.length})`);
      } catch (error) {
        api.logger.error(`Failed to save messages to Honcho: ${error}`);
      }
    });

    // ========================================================================
    // TOOL: honcho_ask — Query memory mid-conversation
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_ask",
        label: "Ask Honcho",
        description:
          "Query Honcho's memory about the user. Use when you need context about user preferences, history, or past decisions not in the current conversation.",
        parameters: Type.Object({
          query: Type.String({
            description:
              "Question about the user (e.g., 'What communication style do they prefer?')",
          }),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          const answer = await moltbotPeer!.chat(query, { target: ownerPeer! });
          return {
            content: [{ type: "text", text: answer! }],
          };
        },
      },
      { name: "honcho_ask" }
    );

    // ========================================================================
    // TOOL: honcho_search — Semantic search over memory context
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_search",
        label: "Search Honcho Memory",
        description:
          "Semantic search over Honcho's stored knowledge about the user. Use when you need to find specific facts, preferences, or past context that matches a search query. Returns relevant conclusions from Honcho's memory.",
        parameters: Type.Object({
          query: Type.String({
            description:
              "Search query to find relevant memories (e.g., 'coding preferences', 'favorite tools', 'project goals')",
          }),
          topK: Type.Optional(
            Type.Number({
              description:
                "Number of relevant results to return (1-100, default: 10)",
              minimum: 1,
              maximum: 100,
            })
          ),
          maxDistance: Type.Optional(
            Type.Number({
              description:
                "Maximum semantic distance for results (0.0-1.0, lower = stricter matching, default: 0.5)",
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

          await ensureInitialized();

          // Use peer representation with semantic search
          // This searches Honcho's conclusions about the user
          const [representation, card] = await Promise.all([
            ownerPeer!.representation({
              searchQuery: query,
              searchTopK: topK ?? 10,
              searchMaxDistance: maxDistance ?? 1.0,
              includeMostFrequent: true,
            }),
            ownerPeer!.card().catch(() => null),
          ]);

          const results: string[] = [];

          if (representation) {
            results.push("## Relevant Context\n");
            results.push(representation);
          }

          if (card?.length) {
            results.push("\n## Key Facts\n");
            results.push(card.map((f) => `- ${f}`).join("\n"));
          }

          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No relevant memories found for query: "${query}"`,
                },
              ],
            };
          }

          return {
            content: [{ type: "text", text: results.join("\n") }],
          };
        },
      },
      { name: "honcho_search" }
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================
    api.registerCli(
      ({ program, workspaceDir }) => {
        const cmd = program.command("honcho").description("Honcho memory commands");

        cmd
          .command("status")
          .description("Show Honcho connection status")
          .action(async () => {
            try {
              await ensureInitialized();
              const ownerRep = await ownerPeer!.representation();
              const moltbotRep = await moltbotPeer!.representation();

              console.log("Connected to Honcho");
              console.log(`  Workspace: ${cfg.workspaceId}`);
              console.log(`  Owner representation: ${ownerRep.length} chars`);
              console.log(`  Moltbot representation: ${moltbotRep.length} chars`);
            } catch (error) {
              console.error(`Failed to connect: ${error}`);
            }
          });

        cmd
          .command("ask <question>")
          .description("Ask Honcho about the user")
          .action(async (question: string) => {
            try {
              await ensureInitialized();
              const answer = await moltbotPeer!.chat(question, { target: ownerPeer! });
              console.log(answer ?? "No information available.");
            } catch (error) {
              console.error(`Failed to query: ${error}`);
            }
          });

        cmd
          .command("search <query>")
          .description("Semantic search over Honcho memory")
          .option("-k, --top-k <number>", "Number of results to return", "10")
          .option("-d, --max-distance <number>", "Maximum semantic distance (0-1)", "0.5")
          .action(async (query: string, options: { topK: string; maxDistance: string }) => {
            try {
              await ensureInitialized();
              const representation = await ownerPeer!.representation({
                searchQuery: query,
                searchTopK: parseInt(options.topK, 10),
                searchMaxDistance: parseFloat(options.maxDistance),
              });

              if (!representation) {
                console.log(`No relevant memories found for: "${query}"`);
                return;
              }

              console.log(representation);
            } catch (error) {
              console.error(`Search failed: ${error}`);
            }
          });
      },
      { commands: ["honcho"] }
    );

    api.logger.info("Honcho memory plugin loaded");
  },
};

// ============================================================================
// Helper: Extract messages from agent_end event
// ============================================================================

// Strip <honcho-memory>...</honcho-memory> tags to prevent feedback loops
// (injected context shouldn't be saved back to Honcho)
const HONCHO_MEMORY_REGEX = /<honcho-memory>[\s\S]*?<\/honcho-memory>\s*/gi;

function extractMessages(
  rawMessages: unknown[],
  ownerPeer: Peer,
  moltbotPeer: Peer
): MessageInput[] {
  const result: MessageInput[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(
          (block: unknown) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block: unknown) => (block as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    }

    // Strip honcho-memory tags to avoid re-ingesting injected context
    content = content.replace(HONCHO_MEMORY_REGEX, "").trim();

    if (content) {
      const peer = role === "user" ? ownerPeer : moltbotPeer;
      result.push(peer.message(content));
    }
  }

  return result;
}

export default honchoPlugin;
