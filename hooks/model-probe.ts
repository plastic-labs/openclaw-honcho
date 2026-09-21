// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/model-probe.jsonl";
const rec = (o: unknown) => { try { appendFileSync(LOG, JSON.stringify(o) + "\n"); } catch {} };

/** Logs every candidate model source so the real one can be picked from evidence. */
export function registerModelProbe(api: OpenClawPluginApi): void {
  const grab = (hook: string) => async (event: any, ctx: any) => {
    rec({
      hook,
      provider: event?.provider,
      model: event?.model,
      resolvedRef: event?.resolvedRef,
      usageModel: event?.usageState?.model,
      usageRef: event?.usageState?.resolvedRef,
      sessionKey: ctx?.sessionKey ?? event?.sessionKey,
      agentId: ctx?.agentId,
      runId: event?.runId,
      ts: Date.now(),
    });
  };
  for (const h of ["before_agent_finalize", "llm_output", "model_call_ended", "reply_payload_sending", "before_compaction", "after_compaction"]) {
    try { api.on(h as never, grab(h) as never); } catch (e) { rec({ hook: h, registerError: String(e) }); }
  }
}
