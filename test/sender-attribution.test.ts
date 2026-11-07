import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

describe("sender attribution privacy boundary", () => {
  it("does not resolve senders or write messages while automatic capture is disabled", async () => {
    const state = {
      cfg: { noisePatterns: [], peerName: "owner", ownerObserveOthers: false },
      honcho: { session: vi.fn() },
      getParticipantPeer: vi.fn(),
      getAgentPeer: vi.fn(),
      ensureInitialized: vi.fn(),
    } as unknown as PluginState;
    const api = { logger: { warn: vi.fn(), error: vi.fn() } } as never;

    const saved = await flushMessages(
      api,
      state,
      [{ role: "user", content: "private message" }],
      { sessionKey: "agent:main:telegram:group:private", senderId: "private-sender" },
    );

    expect(saved).toBe(0);
    expect(state.getParticipantPeer).not.toHaveBeenCalled();
    expect(state.getAgentPeer).not.toHaveBeenCalled();
    expect(state.honcho.session).not.toHaveBeenCalled();
  });
});
