/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 *
 * Updated to use definePluginEntry() pattern and register a custom
 * MemoryPromptSection for Honcho-specific tool guidance.
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
import { registerProfileTool } from "./tools/profile.js";
import { registerSearchTool } from "./tools/search.js";
import { registerContextTool } from "./tools/context.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerAnalyzeTool } from "./tools/analyze.js";
import { registerMemoryPassthrough } from "./tools/memory-passthrough.js";
import { registerCli } from "./commands/cli.js";

/**
 * Memory prompt section builder for Honcho tools.
 * Tells OpenClaw how to guide the agent on using Honcho memory tools
 * in the system prompt's memory-recall section.
 */
export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
}) => {
  const hasSession = availableTools.has("honcho_session");
  const hasProfile = availableTools.has("honcho_profile");
  const hasSearch = availableTools.has("honcho_search");
  const hasContext = availableTools.has("honcho_context");
  const hasRecall = availableTools.has("honcho_recall");
  const hasAnalyze = availableTools.has("honcho_analyze");

  const anyTool = hasSession || hasProfile || hasSearch || hasContext || hasRecall || hasAnalyze;
  if (!anyTool) return [];

  const lines: string[] = ["## Honcho Memory"];

  if (hasProfile) {
    lines.push(
      "Use honcho_profile for a quick factual snapshot of the user (name, role, preferences). Fast, no LLM cost."
    );
  }
  if (hasSearch) {
    lines.push(
      "Use honcho_search for semantic search over stored memory. Good for finding specific past facts."
    );
  }
  if (hasContext || hasAnalyze) {
    lines.push(
      "Use honcho_context or honcho_analyze for synthesized answers about the user requiring LLM reasoning."
    );
  }
  if (hasRecall) {
    lines.push(
      "Use honcho_recall for simple factual lookups with minimal reasoning cost."
    );
  }
  if (hasSession) {
    lines.push(
      "Use honcho_session to retrieve current session history, summary, or search within the session."
    );
  }

  lines.push("");
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

    // Register memory prompt section so OpenClaw knows how to guide
    // the agent on using Honcho memory tools in system prompts.
    api.registerMemoryPromptSection(buildPromptSection);

    // Hooks
    registerGatewayHook(api, state);
    registerSubagentHooks(api);
    registerContextHook(api, state);
    registerCaptureHook(api, state);

    // Tools
    registerSessionTool(api, state);
    registerProfileTool(api, state);
    registerSearchTool(api, state);
    registerContextTool(api, state);
    registerRecallTool(api, state);
    registerAnalyzeTool(api, state);
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
