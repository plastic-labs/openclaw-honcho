import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// @ts-ignore - resolved by openclaw runtime
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/memory-core";
import type { PluginState } from "../state.js";
import { getHonchoMemorySearchManager } from "../runtime.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
}, { additionalProperties: false });

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning: "Memory search is unavailable due to a memory provider error.",
    action: "Check memory provider configuration and retry memory_search.",
  };
}

export function registerMemoryPassthrough(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (ctx) => ({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search the active memory plugin for relevant prior context and return snippets with path and line numbers.",
      parameters: MemorySearchSchema,
      async execute(_toolCallId, params) {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        // Keep parity with the generic schema even though Honcho does not use minScore.
        readNumberParam(params, "minScore");

        const { manager } = await getHonchoMemorySearchManager(state, {
          agentId: ctx.agentId,
        });

        try {
          const results = await manager.search(query, {
            maxResults: maxResults ?? undefined,
            sessionKey: ctx.sessionKey,
          });
          const status = manager.status();
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            mode: (status.custom as { searchMode?: string } | undefined)?.searchMode,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
    }),
    { name: "memory_search" }
  );

  api.registerTool(
    (_ctx) => ({
      name: "memory_get",
      label: "Memory Get",
      description:
        "Read a specific snippet from the active memory plugin using a path returned by memory_search.",
      parameters: MemoryGetSchema,
      async execute(_toolCallId, params) {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });

        const { manager } = await getHonchoMemorySearchManager(state);

        try {
          const result = await manager.readFile({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
          });
          return jsonResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ path: relPath, text: "", disabled: true, error: message });
        }
      },
    }),
    { name: "memory_get" }
  );
}
