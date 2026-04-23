import { describe, expect, it, vi, beforeEach } from "vitest";

const { getHonchoMemorySearchManagerMock } = vi.hoisted(() => ({
  getHonchoMemorySearchManagerMock: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getHonchoMemorySearchManager: getHonchoMemorySearchManagerMock,
}));

import { registerMemoryPassthrough } from "./memory-passthrough.js";

describe("memory passthrough tools", () => {
  beforeEach(() => {
    getHonchoMemorySearchManagerMock.mockReset();
    getHonchoMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: vi.fn(async () => [
          {
            path: "sessions/test-session.txt",
            startLine: 3,
            endLine: 3,
            score: 1,
            snippet: "remembered fact",
            source: "sessions",
          },
        ]),
        readFile: vi.fn(async () => ({
          path: "sessions/test-session.txt",
          text: "remembered fact",
        })),
        status: vi.fn(() => ({
          backend: "qmd",
          provider: "honcho",
          model: "n/a",
          custom: { searchMode: "semantic" },
        })),
      },
    });
  });

  it("registers direct memory_search and memory_get tools", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown>; opts?: Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>, opts?: Record<string, unknown>) => {
        registrations.push({ factory, opts });
      },
    };

    registerMemoryPassthrough(api as never, {} as never);

    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.opts).toEqual({ name: "memory_search" });
    expect(registrations[1]?.opts).toEqual({ name: "memory_get" });

    const ctx = {
      agentId: "main",
      config: {},
      sessionKey: "agent:main:dashboard:test",
      messageProvider: "discord",
    };

    const searchTool = registrations[0]!.factory(ctx) as {
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };
    const getTool = registrations[1]!.factory(ctx) as {
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };

    expect(searchTool.name).toBe("memory_search");
    expect(getTool.name).toBe("memory_get");

    const searchResult = await searchTool.execute("call-search", {
      query: "Chief",
      maxResults: 3,
    });
    const getResult = await getTool.execute("call-get", {
      path: "sessions/test-session.txt",
      from: 1,
      lines: 2,
    });

    expect(searchResult.content[0]?.text).toContain("\"provider\": \"honcho\"");
    expect(searchResult.content[0]?.text).toContain("\"path\": \"sessions/test-session.txt\"");
    expect(getResult.content[0]?.text).toContain("\"text\": \"remembered fact\"");
    expect(getHonchoMemorySearchManagerMock).toHaveBeenNthCalledWith(1, {}, {
      agentId: "main",
      sessionKey: "agent-main-dashboard-test-discord",
    });
    expect(getHonchoMemorySearchManagerMock).toHaveBeenNthCalledWith(2, {}, {
      agentId: "main",
      sessionKey: "agent-main-dashboard-test-discord",
    });
  });

  it("forwards messageProvider into the built Honcho session key for memory_search", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
        registrations.push({ factory });
      },
    };

    registerMemoryPassthrough(api as never, {} as never);

    const ctx = {
      agentId: "developer",
      config: {},
      sessionKey: "agent-developer-discord-channel-1234567890123456789",
      messageProvider: "discord",
    };
    const searchTool = registrations[0]!.factory(ctx) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };

    await searchTool.execute("call-search", { query: "Chief" });

    const expectedSessionKey = "agent-developer-discord-channel-1234567890123456789-discord";
    expect(getHonchoMemorySearchManagerMock).toHaveBeenCalledWith({}, {
      agentId: "developer",
      sessionKey: expectedSessionKey,
    });
    expect(expectedSessionKey).not.toContain("-unknown");

    const managerResult = await getHonchoMemorySearchManagerMock.mock.results[0]!.value;
    const searchCalls = (managerResult.manager.search as ReturnType<typeof vi.fn>).mock.calls;
    const lastSearchArgs = searchCalls[searchCalls.length - 1];
    expect(lastSearchArgs?.[1]).toMatchObject({ sessionKey: expectedSessionKey });
  });

  it("forwards messageProvider into the built Honcho session key for memory_get", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
        registrations.push({ factory });
      },
    };

    registerMemoryPassthrough(api as never, {} as never);

    const ctx = {
      agentId: "developer",
      config: {},
      sessionKey: "agent-developer-discord-channel-1234567890123456789",
      messageProvider: "discord",
    };
    const getTool = registrations[1]!.factory(ctx) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };

    await getTool.execute("call-get", { path: "sessions/x.txt" });

    const expectedSessionKey = "agent-developer-discord-channel-1234567890123456789-discord";
    expect(getHonchoMemorySearchManagerMock).toHaveBeenCalledWith({}, {
      agentId: "developer",
      sessionKey: expectedSessionKey,
    });
    expect(expectedSessionKey).not.toContain("-unknown");
  });

  it("resolves session key from messageChannel for memory_search when tool ctx omits messageProvider", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
        registrations.push({ factory });
      },
    };

    registerMemoryPassthrough(api as never, {} as never);

    const ctx = {
      agentId: "developer",
      config: {},
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageChannel: "discord",
    };
    const searchTool = registrations[0]!.factory(ctx) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };

    await searchTool.execute("call-search", { query: "Chief" });

    const expectedSessionKey = "agent-developer-discord-channel-1234567890123456789-discord";
    expect(getHonchoMemorySearchManagerMock).toHaveBeenCalledWith({}, {
      agentId: "developer",
      sessionKey: expectedSessionKey,
    });
    expect(expectedSessionKey).not.toContain("-unknown");

    const managerResult = await getHonchoMemorySearchManagerMock.mock.results[0]!.value;
    const searchCalls = (managerResult.manager.search as ReturnType<typeof vi.fn>).mock.calls;
    const lastSearchArgs = searchCalls[searchCalls.length - 1];
    expect(lastSearchArgs?.[1]).toMatchObject({ sessionKey: expectedSessionKey });
  });

  it("resolves session key from messageChannel for memory_get when tool ctx omits messageProvider", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
        registrations.push({ factory });
      },
    };

    registerMemoryPassthrough(api as never, {} as never);

    const ctx = {
      agentId: "developer",
      config: {},
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageChannel: "discord",
    };
    const getTool = registrations[1]!.factory(ctx) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };

    await getTool.execute("call-get", { path: "sessions/x.txt" });

    const expectedSessionKey = "agent-developer-discord-channel-1234567890123456789-discord";
    expect(getHonchoMemorySearchManagerMock).toHaveBeenCalledWith({}, {
      agentId: "developer",
      sessionKey: expectedSessionKey,
    });
    expect(expectedSessionKey).not.toContain("-unknown");
  });

  it("returns structured unavailable payloads when manager acquisition fails", async () => {
    const registrations: Array<{ factory: (ctx: Record<string, unknown>) => Record<string, unknown> }> = [];
    const api = {
      registerTool: (factory: (ctx: Record<string, unknown>) => Record<string, unknown>) => {
        registrations.push({ factory });
      },
    };
    getHonchoMemorySearchManagerMock.mockRejectedValueOnce(new Error("auth failed"));

    registerMemoryPassthrough(api as never, {} as never);

    const ctx = {
      agentId: "main",
      config: {},
      sessionKey: "agent:main:dashboard:test",
      messageProvider: "discord",
    };
    const searchTool = registrations[0]!.factory(ctx) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };
    const result = await searchTool.execute("call-search", { query: "Chief" });

    expect(result.content[0]?.text).toContain("\"disabled\": true");
    expect(result.content[0]?.text).toContain("\"error\": \"auth failed\"");
    expect(getHonchoMemorySearchManagerMock).toHaveBeenCalledWith({}, {
      agentId: "main",
      sessionKey: "agent-main-dashboard-test-discord",
    });
  });
});
