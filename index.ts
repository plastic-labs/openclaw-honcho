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
    // DATA RETRIEVAL TOOLS (cheap, raw observations — agent interprets)
    // ========================================================================

    // ========================================================================
    // TOOL: honcho_profile — Quick access to user's key facts
    // ========================================================================
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
          await ensureInitialized();

          const card = await ownerPeer!.card().catch(() => null);

          if (!card?.length) {
            return {
              content: [
                {
                  type: "text",
                  text: "No profile facts available yet. The user's profile builds over time through conversations.",
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `## User Profile\n\n${card.map((f) => `• ${f}`).join("\n")}`,
              },
            ],
          };
        },
      },
      { name: "honcho_profile" }
    ),

    // ========================================================================
    // TOOL: honcho_search — Targeted semantic search over memory
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_search",
        label: "Search Honcho Memory",
        description: `Semantic vector search over Honcho's stored observations. Returns raw memories ranked by relevance — no LLM
interpretation.

━━━ DATA TOOL ━━━
Returns: Raw observations/conclusions matching your query
Cost: Low (vector search only, no LLM)
Speed: Fast

Best for:
- Finding specific past context (projects, decisions, discussions)
- Seeing the evidence before drawing conclusions
- Cost-efficient exploration of memory
- When you want to reason over the raw data yourself

Examples:
- "API design decisions" → raw observations about API discussions
- "testing preferences" → raw memories about testing
- "deployment concerns" → observations mentioning deployment issues

Parameters:
- topK: 3-5 for focused, 10-20 for exploratory (default: 10)
- maxDistance: 0.3 = strict, 0.5 = balanced, 0.7 = loose (default: 0.5)

━━━ vs Q&A Tools ━━━
• honcho_analyze: Asks Honcho's LLM to synthesize → get an answer (costs more)
• honcho_search: Get raw matching memories → you interpret (cheaper)

Use honcho_analyze if you need Honcho to synthesize an answer.
Use honcho_search if you want the raw evidence to reason over yourself.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Semantic search query — keywords, phrases, or natural language (e.g., 'debugging strategies', 'opinions on microservices')",
          }),
          topK: Type.Optional(
            Type.Number({
              description:
                "Number of results. 3-5 for focused, 10-20 for exploratory (default: 10)",
              minimum: 1,
              maximum: 100,
            })
          ),
          maxDistance: Type.Optional(
            Type.Number({
              description:
                "Semantic distance. 0.3 = strict, 0.5 = balanced (default), 0.7 = loose",
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

          const representation = await ownerPeer!.representation({
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
            };
          }

          return {
            content: [{ type: "text", text: `## Search Results: "${query}"\n\n${representation}` }],
          };
        },
      },
      { name: "honcho_search" }
    ),

    // ========================================================================
    // TOOL: honcho_context — Broad representation without specific search
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_context",
        label: "Get Broad Context",
        description: `Retrieve Honcho's full representation — a broad view of observations about the user. Direct data access, no LLM
        reasoning.

        ━━━ DATA TOOL ━━━
        Returns: Raw synthesized representation with frequent observations
        Cost: Low (database query only, no LLM)
        Speed: Fast

        Best for:
        - Understanding the user holistically before a complex task
        - Getting broad context when you're unsure what to search for
        - Cost-efficient situational awareness
        - When you want to see everything and reason over it yourself

        ━━━ vs Other Tools ━━━
        • honcho_profile: Just key facts (fastest, minimal)
        • honcho_search: Targeted by query (specific)
        • honcho_context: Broad representation (comprehensive, still cheap)
        • honcho_analyze: LLM-synthesized answer (costs more, but interpreted for you)

        Use honcho_analyze if you need Honcho to answer a complex question.
        Use honcho_context if you want the broad data to reason over yourself.`,
        parameters: Type.Object({
          includeMostFrequent: Type.Optional(
            Type.Boolean({
              description:
                "Include most frequently referenced observations (default: true)",
            })
          ),
        }),
        async execute(_toolCallId, params) {
          const { includeMostFrequent } = params as {
            includeMostFrequent?: boolean;
          };

          await ensureInitialized();

          const representation = await ownerPeer!.representation({
            includeMostFrequent: includeMostFrequent ?? true,
          });

          if (!representation) {
            return {
              content: [
                {
                  type: "text",
                  text: "No context available yet. Context builds over time through conversations.",
                },
              ],
            };
          }

          return {
            content: [{ type: "text", text: `## User Context\n\n${representation}` }],
          };
        },
      },
      { name: "honcho_context" }
    ),

    // ========================================================================
    // Q&A TOOLS (Honcho's LLM answers — costs more, direct answers)
    // ========================================================================

    // ========================================================================
    // TOOL: honcho_recall — Quick factual Q&A (minimal reasoning)
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_recall",
        label: "Recall from Honcho",
        description: `Ask Honcho a simple factual question and get a direct answer. Uses Honcho's LLM with minimal reasoning.

        ━━━ Q&A TOOL ━━━
          Returns: Direct answer to your question
          Cost: ~$0.001 (LLM call with minimal reasoning)
          Speed: Instant

          Best for:
          - Simple factual questions with direct answers
          - Single data points (names, dates, preferences)
          - When you need THE answer, not raw data

          Examples:
          - "What's the user's name?" → "Alex Chen"
          - "What timezone is the user in?" → "Pacific Time (PT)"
          - "What programming language do they prefer?" → "TypeScript"
          - "What's their job title?" → "Senior Engineer"

          NOT suitable for:
          - Questions requiring synthesis across multiple facts
          - Pattern recognition or analysis
          - Complex multi-part questions

          ━━━ vs Data Tools ━━━
          • honcho_profile: Returns raw key facts → you interpret (cheaper)
          • honcho_recall: Honcho answers your question → direct answer (costs more)

          Use honcho_profile if you want to see the facts and reason yourself.
          Use honcho_recall if you just need a quick answer to a simple question.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Simple factual question (e.g., 'What's their name?', 'What timezone?', 'Preferred language?')",
          }),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          const answer = await moltbotPeer!.chat(query, {
            target: ownerPeer!,
            reasoningLevel: "minimal",
          });
          return {
            content: [{ type: "text", text: answer! }],
          };
        },
      },
      { name: "honcho_recall" }
    ),

    // ========================================================================
    // TOOL: honcho_analyze — Complex Q&A with synthesis (medium reasoning)
    // ========================================================================
    api.registerTool(
      {
        name: "honcho_analyze",
        label: "Analyze with Honcho",
        description: `Ask Honcho a complex question requiring synthesis and get an analyzed answer. Uses Honcho's LLM with medium reasoning.

━━━ Q&A TOOL ━━━
Returns: Synthesized analysis answering your question
Cost: ~$0.05 (LLM call with medium reasoning — multiple searches, directed synthesis)
Speed: Fast

Best for:
- Questions requiring context from multiple interactions
- Synthesizing patterns or preferences
- Understanding communication style or working patterns
- Briefings or summaries on specific topics
- Questions about history or evolution

Examples:
- "What topics interest the user?" → Briefing with ranked interests
- "Describe the user's communication style." → Style profile
- "What key decisions came from our last sessions?" → Decision summary
- "How does the user prefer to receive feedback?" → Preference analysis
- "What concerns has the user raised about this project?" → Concern synthesis

NOT suitable for:
- Simple factual lookups (use honcho_recall — cheaper)
- When you want to see raw evidence (use honcho_search — cheaper)

━━━ vs Data Tools ━━━
• honcho_search: Returns raw matching memories → you interpret (cheaper)
• honcho_context: Returns broad representation → you interpret (cheaper)
• honcho_analyze: Honcho synthesizes an answer → direct analysis (costs more)

Use data tools if you want to see the evidence and reason yourself.
Use honcho_analyze if you need Honcho to synthesize a complex answer.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              "Complex question requiring synthesis (e.g., 'Describe their communication style', 'What patterns in their concerns?')",
          }),
        }),
        async execute(_toolCallId, params) {
          const { query } = params as { query: string };
          const answer = await moltbotPeer!.chat(query, {
            target: ownerPeer!,
            reasoningLevel: "medium",
          });
          return {
            content: [{ type: "text", text: answer! }],
          };
        },
      },
      { name: "honcho_analyze" }
    ),

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
