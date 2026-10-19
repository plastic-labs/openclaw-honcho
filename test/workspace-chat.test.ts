import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceChatTool } from "../tools/workspace-chat.js";
import type { PluginState } from "../state.js";

function setup(answer: string | null) {
  const chat = vi.fn(async () => answer);
  const state = { ensureInitialized: vi.fn(async () => undefined), honcho: { chat } } as unknown as PluginState;
  let tool: any;
  registerWorkspaceChatTool({ registerTool: (factory: () => unknown) => { tool = factory(); } } as never, state);
  return { tool: tool as { execute: (id: string, params: Record<string, unknown>) => Promise<any> }, chat };
}

describe("honcho_workspace_chat", () => {
  it("asks the workspace, not a peer, and maps depth to reasoning level", async () => {
    const { tool, chat } = setup("Alice has a dog named Pepper.");

    const quick = await tool.execute("id", { query: "Who has a dog?" });
    await tool.execute("id", { query: "Who has a dog?", depth: "thorough" });

    expect(chat.mock.calls[0]).toEqual(["Who has a dog?", { reasoningLevel: "low" }]);
    expect(chat.mock.calls[1]).toEqual(["Who has a dog?", { reasoningLevel: "high" }]);
    expect(quick.content[0].text).toBe("Alice has a dog named Pepper.");
  });

  it("says so when Honcho has nothing relevant", async () => {
    const { tool } = setup(null);
    const result = await tool.execute("id", { query: "anything" });
    expect(result.content[0].text).toMatch(/no relevant information/i);
  });
});
