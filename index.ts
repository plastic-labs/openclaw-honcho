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
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

const OWNER_ID = "owner";
const MOLTBOT_ID = "moltbot";

const FILES = {
  USER: "USER.md",
  SOUL: "SOUL.md",
  MEMORY: "MEMORY.md",
} as const;

const HONCHO_SECTION_HEADER = "## From Honcho";

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
    // File Sync Utilities
    // ========================================================================

    async function syncFilesToWorkspace(workspaceDir: string): Promise<void> {
      await ensureInitialized();
      const timestamp = new Date().toISOString();

      const [ownerRep, moltbotRep, ownerCard, moltbotCard] = await Promise.all([
        ownerPeer!.representation().catch(() => null),
        moltbotPeer!.representation().catch(() => null),
        ownerPeer!.card().catch(() => null),
        moltbotPeer!.card().catch(() => null),
      ]);

      // USER.md <- owner representation
      if (ownerRep || ownerCard) {
        await updateFileWithHonchoSection(
          path.join(workspaceDir, FILES.USER),
          formatPeerContent(ownerRep, ownerCard),
          timestamp
        );
      }

      // SOUL.md <- moltbot representation
      if (moltbotRep || moltbotCard) {
        await updateFileWithHonchoSection(
          path.join(workspaceDir, FILES.SOUL),
          formatPeerContent(moltbotRep, moltbotCard),
          timestamp
        );
      }

      // MEMORY.md <- combined
      if (ownerRep || moltbotRep) {
        const combined = [
          ownerRep && `### About the User\n\n${ownerRep}`,
          moltbotRep && `### About Moltbot\n\n${moltbotRep}`,
        ]
          .filter(Boolean)
          .join("\n\n");

        await updateFileWithHonchoSection(
          path.join(workspaceDir, FILES.MEMORY),
          combined,
          timestamp
        );
      }
    }

    function formatPeerContent(
      rep: string | null,
      card: string[] | null
    ): string {
      const parts: string[] = [];

      if (card?.length) {
        parts.push("### Key Facts\n");
        parts.push(card.map((f) => `- ${f}`).join("\n"));
      }

      if (rep) {
        if (parts.length) parts.push("\n");
        parts.push("### Observations\n");
        parts.push(rep);
      }

      return parts.join("\n");
    }

    async function updateFileWithHonchoSection(
      filePath: string,
      honchoContent: string,
      timestamp: string
    ): Promise<void> {
      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist
      }

      // Remove existing Honcho section
      const regex = new RegExp(
        `${escapeRegex(HONCHO_SECTION_HEADER)}[\\s\\S]*?(?=\\n## |$)`,
        "g"
      );
      const staticContent = existing.replace(regex, "").trim();

      const newSection = [
        HONCHO_SECTION_HEADER,
        "",
        "*Auto-synced from Honcho. Do not edit this section manually.*",
        "",
        honchoContent,
        "",
        `---`,
        `*Last synced: ${timestamp}*`,
      ].join("\n");

      const final = staticContent
        ? `${staticContent}\n\n${newSection}`
        : newSection;

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, final, "utf-8");
    }

    function escapeRegex(str: string): string {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    // HOOK: before_agent_start — Inject relevant memory context
    // ========================================================================
    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;

      try {
        await ensureInitialized();

        // Use dialectic chat to get relevant context
        const context = await moltbotPeer!.chat(event.prompt, {
          target: ownerPeer!,
        });
        if (!context) return;

        return {
          prependContext: `<honcho-memory>\n${context}\n</honcho-memory>`,
        };
      } catch (error) {
        api.logger.warn(`Failed to fetch Honcho context: ${error}`);
        return;
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

          try {
            await ensureInitialized();
            const answer = await moltbotPeer!.chat(query, { target: ownerPeer! });
            return {
              content: [
                {
                  type: "text",
                  text: answer ?? "No information available about this topic yet.",
                },
              ],
            };
          } catch (error) {
            api.logger.error(`honcho_ask failed: ${error}`);
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to query memory. Service may be unavailable.",
                },
              ],
            };
          }
        },
      },
      { name: "honcho_ask" }
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
          .command("sync")
          .description("Sync Honcho representations to workspace files")
          .action(async () => {
            if (!workspaceDir) {
              console.error("No workspace directory available");
              return;
            }
            try {
              await syncFilesToWorkspace(workspaceDir);
              console.log("Synced Honcho representations to workspace files");
            } catch (error) {
              console.error(`Failed to sync: ${error}`);
            }
          });
      },
      { commands: ["honcho"] }
    );

    // ========================================================================
    // Service: Daily sync at midnight
    // ========================================================================
    if (cfg.dailySyncEnabled) {
      let timeoutId: NodeJS.Timeout | null = null;
      let intervalId: NodeJS.Timeout | null = null;

      api.registerService({
        id: "honcho-daily-sync",

        start(svcCtx) {
          const now = new Date();
          const midnight = new Date(now);
          midnight.setHours(24, 0, 0, 0);
          const msUntilMidnight = midnight.getTime() - now.getTime();

          const doSync = async () => {
            try {
              await ensureInitialized();
              if (svcCtx.workspaceDir) {
                await syncFilesToWorkspace(svcCtx.workspaceDir);
                svcCtx.logger.info("Daily sync complete");
              }
            } catch (error) {
              svcCtx.logger.error(`Daily sync failed: ${error}`);
            }
          };

          // Startup sync if configured
          if (cfg.syncOnStartup && svcCtx.workspaceDir) {
            doSync();
          }

          timeoutId = setTimeout(() => {
            doSync();

            // Then every 24 hours
            intervalId = setInterval(doSync, 24 * 60 * 60 * 1000);
          }, msUntilMidnight);

          svcCtx.logger.info(
            `Daily sync scheduled (in ${Math.round(msUntilMidnight / 1000 / 60)} min)`
          );
        },

        stop(svcCtx) {
          if (timeoutId) clearTimeout(timeoutId);
          if (intervalId) clearInterval(intervalId);
          svcCtx.logger.info("Daily sync stopped");
        },
      });
    }

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
