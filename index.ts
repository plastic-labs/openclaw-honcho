/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */

// @ts-ignore - resolved by openclaw runtime
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore - resolved by openclaw runtime
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core";
import { honchoConfigSchema } from "./config.js";
import { createPluginState } from "./state.js";
import { registerGatewayHook } from "./hooks/gateway.js";
import { registerContextHook } from "./hooks/context.js";
import { registerCaptureHook } from "./hooks/capture.js";
import { registerSubagentHooks } from "./hooks/subagent.js";
import { registerSessionTool } from "./tools/session.js";
import { registerSearchTool } from "./tools/search.js";
import { registerContextTool } from "./tools/context.js";
import { registerAskTool } from "./tools/ask.js";
import { registerMemoryPassthrough } from "./tools/memory-passthrough.js";
import { registerMessageSearchTool } from "./tools/message-search.js";
import { registerCli } from "./commands/cli.js";

/**
 * Memory prompt section builder for Honcho tools.
 * This is the single place for tool-selection guidance — tool descriptions
 * themselves stay short to minimize per-turn token overhead.
 */
export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
}) => {
  const hasSession = availableTools.has("honcho_session");
  const hasContext = availableTools.has("honcho_context");
  const hasSearch = availableTools.has("honcho_search_conclusions");
  const hasAsk = availableTools.has("honcho_ask");
  const hasMessageSearch = availableTools.has("honcho_search_messages");

  const anyTool = hasSession || hasContext || hasSearch || hasAsk || hasMessageSearch;
  if (!anyTool) return [];

  const lines: string[] = ["## Honcho Memory"];

  lines.push("Choose the right Honcho tool based on what you need:");

  if (hasContext) {
    lines.push(
      "- honcho_context: Quick user facts (detail='card') or full representation (detail='full'). Cheap, no LLM."
    );
  }
  if (hasSearch) {
    lines.push(
      "- honcho_search_conclusions: Find specific past context by semantic query. Raw results, no LLM."
    );
  }
  if (hasAsk) {
    lines.push(
      "- honcho_ask: Ask a question and get a direct answer. depth='quick' for facts, 'thorough' for synthesis."
    );
  }
  if (hasMessageSearch) {
    lines.push(
      "- honcho_search_messages: Find specific messages across all sessions. Filter by sender (user/agent/all), date, metadata."
    );
  }
  if (hasSession) {
    lines.push(
      "- honcho_session: Current session history and summary only. Not cross-session."
    );
  }

  lines.push(
    "",
    "Prefer data tools (context, search) when you can reason over the results yourself. Use honcho_ask when you need Honcho to synthesize an answer.",
    ""
  );

  return lines;
};

let _loggedLoaded = false;

export default definePluginEntry({
  id: "openclaw-honcho",
  name: "Memory (Honcho)",
  description: "AI-native memory with dialectic reasoning",
  kind: "memory",
  configSchema: honchoConfigSchema,

  register(api) {
    const state = createPluginState(api);

    // Register memory prompt section — tool selection guidance lives here,
    // not in individual tool descriptions.
    api.registerMemoryPromptSection(buildPromptSection);

    // Hooks
    registerGatewayHook(api, state);
    registerSubagentHooks(api);
    registerContextHook(api, state);
    registerCaptureHook(api, state);

    // Tools (5 core + 2 passthrough)
    registerSessionTool(api, state);
    registerContextTool(api, state);
    registerSearchTool(api, state);
    registerAskTool(api, state);
    registerMessageSearchTool(api, state);
    registerMemoryPassthrough(api, state);

    // CLI
    registerCli(api, state);

    if (!_loggedLoaded) {
      api.logger.info("Honcho memory plugin loaded");
      _loggedLoaded = true;
    } else {
      api.logger.debug("Honcho memory plugin registered for workspace");
    }
  },
});
