// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { refreshTelemetryHeaders } from "../honcho-client.js";

/**
 * Prefers `resolvedRef`: under an aggregating provider `model` already contains a
 * slash (`anthropic/claude-sonnet-5` under openrouter), so `provider + "/" + model`
 * is not the runtime's own ref and the bare id loses who served the turn.
 */
export function formatAgentModel(event: {
  provider?: unknown;
  model?: unknown;
  resolvedRef?: unknown;
}): string | undefined {
  const ref = typeof event.resolvedRef === "string" ? event.resolvedRef.trim() : "";
  if (ref) return ref;

  const model = typeof event.model === "string" ? event.model.trim() : "";
  if (!model) return undefined;
  const provider = typeof event.provider === "string" ? event.provider.trim() : "";
  return provider ? `${provider}/${model}` : model;
}

/**
 * `llm_output` is the only hook carrying `resolvedRef`, and it fires once per turn
 * where `model_call_ended` fires per model call. Conversation-gated like capture:
 * without `allowConversationAccess` the model header is absent.
 */
export function registerTelemetryHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("llm_output", async (event) => {
    try {
      const model = formatAgentModel(event ?? {});
      if (!model || model === state.lastAgentModel) return;
      state.lastAgentModel = model;
      refreshTelemetryHeaders(state.honcho, model);
    } catch (error) {
      api.logger.debug?.(`[honcho] telemetry model capture skipped: ${error}`);
    }
  });
}
