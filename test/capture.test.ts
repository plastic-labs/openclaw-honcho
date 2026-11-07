import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

describe("flushMessages privacy default", () => {
  it("never writes raw conversation messages to Honcho", async () => {
    const session = {
      addMessages: vi.fn(),
      addPeers: vi.fn(),
      getMetadata: vi.fn(),
      setMetadata: vi.fn(),
    };
    const state = {
      cfg: { noisePatterns: [], peerName: "owner", ownerObserveOthers: false },
      honcho: { session: vi.fn(async () => session) },
      ensureInitialized: vi.fn(),
    } as unknown as PluginState;
    const api = { logger: { warn: vi.fn(), error: vi.fn() } } as never;

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "raw user content" },
        { role: "assistant", content: "raw assistant content" },
      ],
      { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" },
    );

    expect(saved).toBe(0);
    expect(state.honcho.session).not.toHaveBeenCalled();
    expect(session.addMessages).not.toHaveBeenCalled();
    expect(session.addPeers).not.toHaveBeenCalled();
    expect(session.setMetadata).not.toHaveBeenCalled();
  });
});
