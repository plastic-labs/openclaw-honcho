import { describe, expect, it, vi } from "vitest";
import { registerRememberTool } from "../tools/remember.js";
import type { PluginState } from "../state.js";

function createHarness(createResult: Array<{ id: string }> = [{ id: "conclusion-1" }]) {
  const create = vi.fn(async () => createResult);
  const observedPeer = { id: "owner" };
  const agentPeer = {
    id: "agent-main",
    conclusions: { create },
    conclusionsOf: vi.fn(() => ({ create })),
  };
  const state = {
    cfg: { workspaceId: "workspace-1" },
    honcho: {
      session: vi.fn(async () => ({})),
    },
    ensureInitialized: vi.fn(async () => {}),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => observedPeer),
    resolveSessionParticipantPeer: vi.fn(async () => observedPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;
  const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
  const api = {
    registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
      registrations.push({ factory });
    },
  };

  registerRememberTool(api as never, state);
  const tool = registrations[0]!.factory({
    agentId: "main",
    messageProvider: "test",
    sessionKey: "session-1",
  }) as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  return { agentPeer, create, state, tool };
}

describe("honcho_remember", () => {
  it("reports the created conclusion id on success", async () => {
    const { create, tool } = createHarness([{ id: "conclusion-1" }]);

    const result = await tool.execute("call-1", { content: "Remember this" });

    expect(create).toHaveBeenCalledWith({
      content: "Remember this",
      sessionId: "session-1-test",
    });
    expect(result.content[0]?.text).toBe("Saved to Honcho (owner): conclusion-1");
  });

  it("fails instead of reporting success when Honcho returns no records", async () => {
    const { tool } = createHarness([]);

    await expect(tool.execute("call-1", { content: "Remember this" })).rejects.toThrow(
      /returned no created conclusions/
    );
  });
});
