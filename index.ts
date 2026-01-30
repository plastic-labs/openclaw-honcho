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

    /**
     * Build a Honcho session key from Moltbot context.
     * Combines sessionKey + messageProvider to create unique sessions per platform.
     * Uses hyphens as separators (Honcho requires hyphens, not underscores).
     */
    function buildSessionKey(ctx?: { sessionKey?: string; messageProvider?: string }): string {
      const baseKey = ctx?.sessionKey ?? "default";
      const provider = ctx?.messageProvider ?? "unknown";
      const combined = `${baseKey}-${provider}`;
      // Replace any non-alphanumeric characters with hyphens
      return combined.replace(/[^a-zA-Z0-9-]/g, "-");
    }

    async function ensureInitialized(): Promise<void> {
      // Always ensure workspace exists (idempotent)
      await honcho.setMetadata({});

      if (initialized) return;
      api.logger.info?.(`[honcho] Initializing peers...`);

      // Create peers with metadata to ensure they exist
      ownerPeer = await honcho.peer(OWNER_ID, { metadata: {} });
      moltbotPeer = await honcho.peer(MOLTBOT_ID, { metadata: {} });
      api.logger.info?.(`[honcho] Peers ready: ${ownerPeer.id}, ${moltbotPeer.id}`);
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
    // HOOK: before_agent_start — Inject Honcho context into system prompt
    // ========================================================================
    api.on("before_agent_start", async (event, ctx) => {
      // Skip if no meaningful prompt
      if (!event.prompt || event.prompt.length < 5) return;

      const sessionKey = buildSessionKey(ctx);
      api.logger.info?.(`[honcho] before_agent_start - sessionKey: "${sessionKey}", provider: "${ctx?.messageProvider}"`);

      try {
        await ensureInitialized();

        // Get or create session
        api.logger.info?.(`[honcho] Creating/getting session: "${sessionKey}"`);
        const session = await honcho.session(sessionKey, { metadata: {} });
        api.logger.info?.(`[honcho] Session acquired: ${session.id}`);

        // Try to get context; if session is new/empty, return gracefully
        let context;
        try {
          context = await session.context({
            summary: true,
            tokens: 2000,
            peerTarget: ownerPeer!,
            peerPerspective: moltbotPeer!,
          });
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) {
            // New session, no context yet
            return;
          }
          throw e;
        }

        // Build context sections
        const sections: string[] = [];

        // Add peer card (key facts about the user)
        if (context.peerCard?.length) {
          sections.push(`Key facts:\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`);
        }

        // Add peer representation (broader understanding)
        if (context.peerRepresentation) {
          sections.push(`User context:\n${context.peerRepresentation}`);
        }

        // Add conversation summary if available
        if (context.summary?.content) {
          sections.push(`Earlier in this conversation:\n${context.summary.content}`);
        }

        if (sections.length === 0) return;

        const formatted = sections.join("\n\n");

        return {
          prependContext: `<honcho-memory hidden="true">\n${formatted}\n</honcho-memory>\n<!-- Use this context silently. Never quote or expose the honcho-memory block to the user. -->`,
        };
      } catch (error) {
        api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
        return;
      }
    });

    // ========================================================================
    // HOOK: agent_end — Persist messages to Honcho
    // ========================================================================
    api.on("agent_end", async (event, ctx) => {
      api.logger.info?.(`[honcho] agent_end called - success: ${event.success}, messages: ${event.messages?.length ?? 0}`);
      if (!event.success || !event.messages?.length) return;

      // Build Honcho session key from moltbot context (includes provider for platform separation)
      const sessionKey = buildSessionKey(ctx);
      api.logger.info?.(`[honcho] agent_end - sessionKey: "${sessionKey}", provider: "${ctx.messageProvider}"`);

      try {
        await ensureInitialized();

        // Get or create session (passing empty metadata ensures creation)
        api.logger.info?.(`[honcho] agent_end: Creating/getting session "${sessionKey}"`);
        const session = await honcho.session(sessionKey, { metadata: {} });
        api.logger.info?.(`[honcho] agent_end: Session acquired, getting metadata...`);
        let meta = await session.getMetadata();
        api.logger.info?.(`[honcho] agent_end: Got metadata: ${JSON.stringify(meta)}`);

        // Initialize lastSavedIndex if not set (new session - skip backlog)
        if (meta.lastSavedIndex === undefined) {
          const startIndex = Math.max(0, event.messages.length - 2);
          await session.setMetadata({ lastSavedIndex: startIndex });
          meta = { lastSavedIndex: startIndex };
          api.logger.info?.(`[honcho] New session "${sessionKey}", starting from index ${startIndex}`);
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
        api.logger.info?.(`[honcho] Extracting from ${newRawMessages.length} raw messages (lastSavedIndex: ${lastSavedIndex})`);
        const messages = extractMessages(newRawMessages, ownerPeer!, moltbotPeer!);
        api.logger.info?.(`[honcho] Extracted ${messages.length} valid messages`);

        if (messages.length === 0) {
          // Update index even if no saveable content (e.g., tool-only messages)
          await session.setMetadata({ ...meta, lastSavedIndex: event.messages.length });
          return;
        }

        // Save new messages
        api.logger.info?.(`[honcho] Attempting to save ${messages.length} messages`);
        api.logger.debug?.(`[honcho] Messages: ${JSON.stringify(messages.slice(0, 2))}`);
        await session.addMessages(messages);

        // Update watermark in Honcho
        await session.setMetadata({ ...meta, lastSavedIndex: event.messages.length });

        api.logger.info?.(`Saved ${messages.length} new messages to Honcho (index ${lastSavedIndex} → ${event.messages.length})`);
      } catch (error) {
        api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
        if (error instanceof Error) {
          api.logger.error(`[honcho] Stack: ${error.stack}`);
          // Log additional error details if available
          const anyError = error as Record<string, unknown>;
          if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
          if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
        }
      }
    });

    // ========================================================================
    // DATA RETRIEVAL TOOLS (cheap, raw observations — agent interprets)
    // ========================================================================

        // ========================================================================
    // TOOL: honcho_session — Session conversation history
    // ========================================================================
    api.registerTool(
      {
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
        }),
        async execute(_toolCallId, params, ctx) {
          const {
            includeMessages = true,
            includeSummary = true,
            searchQuery,
            messageLimit = 4000,
          } = params as {
            includeMessages?: boolean;
            includeSummary?: boolean;
            searchQuery?: string;
            messageLimit?: number;
          };

          await ensureInitialized();

          const sessionKey = buildSessionKey(ctx);

          try {
            const session = await honcho.session(sessionKey);

            // Get session context with the specified options
            const context = await session.context({
              summary: includeSummary,
              tokens: messageLimit,
              peerTarget: ownerPeer!,
              peerPerspective: moltbotPeer!,
              searchQuery: searchQuery,
            });

            const sections: string[] = [];

            // Add summary if available
            if (context.summary?.content) {
              sections.push(
                `## Earlier Conversation Summary\n\n${context.summary.content}`
              );
            }

            // Add peer card if available
            if (context.peerCard?.length) {
              sections.push(
                `## User Profile\n\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`
              );
            }

            // Add peer representation if available
            if (context.peerRepresentation) {
              sections.push(
                `## User Context\n\n${context.peerRepresentation}`
              );
            }

            // Add messages if requested
            if (includeMessages && context.messages.length > 0) {
              const messageLines = context.messages.map((msg) => {
                const speaker = msg.peerId === ownerPeer!.id ? "User" : "Moltbot";
                const timestamp = msg.createdAt
                  ? new Date(msg.createdAt).toLocaleString()
                  : "";
                return `**${speaker}**${timestamp ? ` (${timestamp})` : ""}:\n${msg.content}`;
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
            };
          } catch (error) {
            // Session might not exist yet
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
              };
            }

            throw error;
          }
        },
      },
      { name: "honcho_session" }
    );


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
        description: `Retrieve Honcho's full representation — everything known about this user ACROSS ALL SESSIONS.

━━━ SCOPE: ALL SESSIONS (USER-LEVEL) ━━━
This tool retrieves synthesized knowledge about the user from ALL their past conversations.
It provides a holistic view built over time, not limited to the current session.

━━━ DATA TOOL ━━━
Returns: Broad synthesized representation with frequent observations
Cost: Low (database query only, no LLM)
Speed: Fast

Best for:
- "What do you know about me?"
- Understanding the user holistically before a complex task
- Getting broad context when you're unsure what to search for
- Long-term preferences, patterns, and history

NOT for:
- "What did we just discuss?" → Use honcho_session instead
- Current conversation context → Use honcho_session instead

Parameters:
- includeMostFrequent: Include most frequently referenced observations (default: true)

━━━ vs honcho_session ━━━
• honcho_context: ALL sessions — "what do I know about this user overall?"
• honcho_session: THIS session only — "what did we just discuss?"

━━━ vs Other Tools ━━━
• honcho_profile: Just key facts (fastest, minimal)
• honcho_search: Targeted by query (specific topics across all sessions)
• honcho_context: Broad representation (comprehensive, still cheap)
• honcho_analyze: LLM-synthesized answer (costs more, but interpreted for you)`,
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

/**
 * Strip Moltbot's metadata tags and injected context from message content.
 * Removes:
 * - Platform headers: [Telegram Name id:123456 timestamp]
 * - Message IDs: [message_id: xxx]
 * - Honcho memory blocks: <honcho-memory>...</honcho-memory>
 */
function cleanMessageContent(content: string): string {
  let cleaned = content;
  // Remove honcho-memory blocks (including hidden attribute and HTML comments)
  cleaned = cleaned.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "");
  cleaned = cleaned.replace(/<!--[^>]*honcho[^>]*-->\s*/gi, "");
  // Remove header: [Platform Name id:123456 timestamp]
  cleaned = cleaned.replace(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/, "");
  // Remove trailing message_id: [message_id: xxx]
  cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/, "");
  return cleaned.trim();
}

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

    // Clean metadata tags from user messages
    if (role === "user") {
      content = cleanMessageContent(content);
    }
    content = content.trim();

    if (content) {
      const peer = role === "user" ? ownerPeer : moltbotPeer;
      result.push(peer.message(content));
    }
  }

  return result;
}

export default honchoPlugin;
