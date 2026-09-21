// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { refreshTelemetryHeaders } from "../honcho-client.js";

/**
 * `X-Honcho-Agent-Model` value.
 *
 * `resolvedRef` is OpenClaw's fully-qualified ref and is preferred: `model`
 * already contains a slash on aggregating providers (`anthropic/claude-sonnet-5`
 * under openrouter), so joining it to `provider` by hand is not equivalent and
 * dropping the provider loses who served the turn.
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
 * Records the model that answered onto the held client's headers.
 *
 * `llm_output` is the source: it is the only hook carrying `resolvedRef`, and it
 * fires once per turn where `model_call_ended` fires per model call (twice on a
 * turn that used tools). `reply_payload_sending` carries a usage snapshot but
 * never fires on the gateway/CLI path.
 *
 * Conversation-gated, like capture. Without `hooks.allowConversationAccess` the
 * model header is simply absent; host and plugin are unaffected.
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
