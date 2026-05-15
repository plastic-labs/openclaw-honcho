import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";
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

/** Build the generic unavailable payload shape expected by memory_search callers. */
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

/** Mirror OpenClaw's plain-text JSON tool result shape without depending on runtime helpers. */
function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

/** Read a required or optional string parameter from a plain tool input object. */
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {}
) {
  const raw = params[key];
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value) return value;
  }
  if (options.required) {
    throw new Error(`${key} required`);
  }
  return undefined;
}

/** Read a numeric tool parameter while tolerating either number or string input. */
function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { integer?: boolean } = {}
) {
  const raw = params[key];
  let value: number | undefined;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed)) {
      value = parsed;
    }
  }

  if (value === undefined) {
    return undefined;
  }
  return options.integer ? Math.trunc(value) : value;
}

/** Register host-compatible memory_search and memory_get tools for Honcho-backed memory. */
export function registerMemoryPassthrough(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (ctx) => ({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search the active memory plugin for relevant prior context and return snippets with path and line numbers.",
      parameters: MemorySearchSchema,
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const query = readStringParam(p, "query", { required: true });
        const maxResults = readNumberParam(p, "maxResults");
        readNumberParam(p, "minScore");
        const honchoSessionKey = buildSessionKey({
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });

        try {
          const { manager } = await getHonchoMemorySearchManager(state, {
            agentId: ctx.agentId,
            sessionKey: honchoSessionKey,
          });
          const results = await manager.search(query, {
            maxResults: maxResults ?? undefined,
            sessionKey: honchoSessionKey,
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
    (ctx) => ({
      name: "memory_get",
      label: "Memory Get",
      description:
        "Read a specific snippet from the active memory plugin using a path returned by memory_search.",
      parameters: MemoryGetSchema,
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const relPath = readStringParam(p, "path", { required: true });
        const from = readNumberParam(p, "from", { integer: true });
        const lines = readNumberParam(p, "lines", { integer: true });
        const honchoSessionKey = buildSessionKey({
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });

        try {
          const { manager } = await getHonchoMemorySearchManager(state, {
            agentId: ctx.agentId,
            sessionKey: honchoSessionKey,
          });
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
