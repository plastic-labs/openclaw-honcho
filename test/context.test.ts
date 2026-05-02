import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";

const SENTINEL = "Conversation info (untrusted metadata):";

function metadataBlock(payload: Record<string, unknown>): string {
  return [
    SENTINEL,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

function runtimeContext(payload: Record<string, unknown>, content = metadataBlock(payload)) {
  return {
    type: "custom_message",
    customType: "openclaw.runtime-context",
    content,
  };
}

function createApi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    }),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function createState() {
  return {
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => {}),
    resolveDefaultAgentId: vi.fn(() => "main"),
    getAgentPeer: vi.fn(async () => ({ id: "agent-main" })),
    getParticipantPeer: vi.fn(async (senderId?: string) => ({ id: senderId ?? "owner" })),
    resolveSessionParticipantPeer: vi.fn(async () => ({ id: "previous-or-owner" })),
    honcho: {
      session: vi.fn(async () => ({
        context: vi.fn(async () => ({
          peerCard: ["remembered fact"],
          peerRepresentation: "user representation",
          summary: { content: "summary" },
        })),
      })),
    },
  };
}

describe("before_prompt_build runtime-context attribution", () => {
  it("does not fall back to previous or owner peer when runtime-context has no sender id", async () => {
    const api = createApi();
    const state = createState();
    registerContextHook(api as any, state as any);

    const handler = api.handlers.get("before_prompt_build");
    expect(handler).toBeDefined();

    const result = await handler?.(
      {
        prompt: "Current prompt text.",
        messages: [
          { role: "user", content: "Current prompt text." },
          runtimeContext({}, "OpenClaw runtime context with no sender metadata."),
        ],
      },
      { sessionKey: "family", messageProvider: "discord", agentId: "main" },
    );

    expect(result).toBeUndefined();
    expect(state.resolveSessionParticipantPeer).not.toHaveBeenCalled();
    expect(state.getParticipantPeer).not.toHaveBeenCalled();
    expect(state.honcho.session).not.toHaveBeenCalled();
    expect(api.logger.debug).toHaveBeenCalledWith(
      "[honcho] Skipping context injection: runtime-context exists without sender_id",
    );
  });
});
