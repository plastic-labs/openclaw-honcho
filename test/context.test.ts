import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import type { PluginState } from "../state.js";

describe("Honcho context session filtering", () => {
  it("does not initialize or inject context for ignored OpenClaw sessions", async () => {
    let beforePromptBuild:
      | ((
          event: { prompt: string; messages: unknown[] },
          ctx: { sessionKey?: string; agentId?: string },
        ) => Promise<unknown>)
      | undefined;

    const api = {
      on: vi.fn((name: string, handler: typeof beforePromptBuild) => {
        if (name === "before_prompt_build") beforePromptBuild = handler;
      }),
      logger: { warn: vi.fn() },
    };
    const state = {
      cfg: {
        ignoreSessionPatterns: ["agent:*:explicit:model-run-*"],
      },
      turnStartIndex: new Map<string, number>(),
      resolveDefaultAgentId: vi.fn(() => "main"),
      ensureInitialized: vi.fn(async () => undefined),
    } as unknown as PluginState;

    registerContextHook(api as never, state);
    expect(beforePromptBuild).toBeDefined();

    const result = await beforePromptBuild!(
      { prompt: "internal model evaluation prompt", messages: [] },
      { sessionKey: "agent:main:explicit:model-run-123", agentId: "main" },
    );

    expect(result).toBeUndefined();
    expect(state.ensureInitialized).not.toHaveBeenCalled();
    expect(state.turnStartIndex.size).toBe(0);
  });
});
