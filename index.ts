/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */

// @ts-ignore - resolved by openclaw runtime
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore - resolved by openclaw runtime
import type {
  MemoryPluginCapability,
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/core";
import { honchoConfigSchema } from "./config.js";
import { createPluginState, type PluginState } from "./state.js";
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
import { createHonchoMemoryRuntime } from "./runtime.js";

/**
 * Memory prompt section builder for Honcho tools.
 * This is the single place for tool-selection guidance — tool descriptions
 * themselves stay short to minimize per-turn token overhead.
 */
export const buildPromptSection: NonNullable<MemoryPluginCapability["promptBuilder"]> = ({
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

/**
 * Register Honcho's named tools and, only when explicitly requested, the
 * legacy memory_search/memory_get compatibility aliases.
 *
 * Modern OpenClaw provides the canonical memory tools itself. Registering the
 * aliases there creates name-conflict warnings and the host rejects them, so
 * they are opt-in for older hosts that still need the compatibility surface.
 */
export function registerHonchoTools(api: OpenClawPluginApi, state: PluginState): void {
  registerSessionTool(api, state);
  registerContextTool(api, state);
  registerSearchTool(api, state);
  registerAskTool(api, state);
  registerMessageSearchTool(api, state);

  if (state.cfg.enableMemoryCompatibilityTools) {
    registerMemoryPassthrough(api, state);
  }
}

const honchoPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "openclaw-honcho",
  name: "Memory (Honcho)",
  description: "AI-native memory with dialectic reasoning",
  kind: "memory",
  configSchema: honchoConfigSchema,

  register(api) {
    const state = createPluginState(api);

    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      runtime: createHonchoMemoryRuntime(state),
    });

    // Hooks
    registerGatewayHook(api, state);
    registerSubagentHooks(api);
    registerContextHook(api, state);
    registerCaptureHook(api, state);

    // Five Honcho tools; legacy memory aliases are explicit opt-in.
    registerHonchoTools(api, state);

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

export default honchoPlugin;
