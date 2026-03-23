/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */

// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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

let _loggedLoaded = false;

export default {
  id: "openclaw-honcho",
  name: "Memory (Honcho)",
  description: "AI-native memory with dialectic reasoning",
  kind: "memory" as const,
  configSchema: honchoConfigSchema,

  register(api: OpenClawPluginApi) {
    const state = createPluginState(api);

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
};
