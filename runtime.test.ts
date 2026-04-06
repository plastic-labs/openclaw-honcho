import { describe, expect, it, vi } from "vitest";
import { getHonchoMemorySearchManager, resolveHonchoMemoryBackendConfig } from "./runtime.js";
import type { PluginState } from "./state.js";

function createState(baseUrl = "https://api.honcho.dev"): PluginState {
  const contexts = new Map<string, { summary: { content: string }; messages: Array<Record<string, unknown>> }>([
    [
      "session-1",
      {
        summary: { content: "Summary for session one" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:00Z",
            content: "Need to remember this",
          },
          {
            peerId: "agent-main",
            createdAt: "2026-04-06T00:00:01Z",
            content: "Agent reply",
          },
        ],
      },
    ],
    [
      "session-1-child",
      {
        summary: { content: "Child summary" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:02Z",
            content: "Child transcript hit",
          },
        ],
      },
    ],
    [
      "other-session",
      {
        summary: { content: "Other summary" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:03Z",
            content: "Other result",
          },
        ],
      },
    ],
    [
      "session-2",
      {
        summary: { content: "Summary for session two" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:04Z",
            content: "Alpha",
          },
          {
            peerId: "agent-main",
            createdAt: "2026-04-06T00:00:05Z",
            content: "Beta",
          },
        ],
      },
    ],
  ]);
  const searchResults = new Map<string, Array<Record<string, unknown>>>([
    [
      "session-1",
      [{ id: "msg-1", sessionId: "session-1", content: "Need to remember this" }],
    ],
    [
      "session-1-child",
      [{ id: "msg-2", sessionId: "session-1-child", content: "Child transcript hit" }],
    ],
    [
      "session-2",
      [{ id: "msg-3", sessionId: "session-2", content: "Beta\nextra" }],
    ],
  ]);

  const createSession = (sessionId: string) => ({
    id: sessionId,
    context: vi.fn(async () => contexts.get(sessionId)),
    search: vi.fn(async () => searchResults.get(sessionId) ?? []),
  });

  const childSession = createSession("session-1-child");

  return {
    cfg: {
      workspaceId: "openclaw",
      baseUrl,
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
    },
    honcho: {
      session: vi.fn(async (sessionId: string) => createSession(sessionId)),
    } as never,
    ownerPeer: {
      id: "owner",
      search: vi.fn(async () => [
        { sessionId: "session-1", content: "Need to remember this" },
        { sessionId: "session-1-child", content: "Child transcript hit" },
        { sessionId: "other-session", content: "Other result" },
      ]),
      sessions: vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield childSession;
        },
      })),
    } as never,
    agentPeers: new Map(),
    agentPeerMap: {},
    turnStartIndex: new Map(),
    initialized: true,
    api: {} as never,
    ensureInitialized: vi.fn(async () => {}),
    getAgentPeer: vi.fn(async (agentId = "main") => ({ id: `agent-${agentId}` })),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;
}

describe("Honcho memory runtime", () => {
  it("filters search results by session key and returns session transcript paths", async () => {
    const state = createState();

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });
    const results = await manager.search("remember", {
      sessionKey: "session-1",
      maxResults: 10,
    });

    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.path)).toEqual([
      "sessions/session-1.txt",
      "sessions/session-1-child.txt",
    ]);
    expect(results[0]?.snippet).toBe("Need to remember this");
    expect(results[0]?.startLine).toBeGreaterThan(0);
    expect(results[0]?.endLine).toBeGreaterThanOrEqual(results[0]?.startLine ?? 0);
    expect((state.ownerPeer.search as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const implicitScopeResults = await manager.search("remember", {
      maxResults: 10,
    });
    expect(implicitScopeResults).toHaveLength(2);
    await expect(
      manager.search("remember", {
        sessionKey: "other-session",
      }),
    ).rejects.toThrow(/outside the active session/);
  });

  it("reads scoped transcript slices and resolves backend metadata", async () => {
    const state = createState("http://localhost:8000");

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });
    const file = await manager.readFile({
      relPath: "sessions/session-1.txt",
      from: 1,
      lines: 4,
    });

    expect(file.path).toBe("sessions/session-1.txt");
    expect(file.text).toContain("# Summary");
    expect(file.text).toContain("Summary for session one");
    expect(manager.status().provider).toBe("honcho-selfhosted");
    await expect(
      manager.readFile({
        relPath: "sessions/other-session.txt",
      }),
    ).rejects.toThrow(/outside the active session/);

    expect(
      resolveHonchoMemoryBackendConfig({
        sessionKey: "agent:main:dashboard:test",
        messageProvider: "telegram",
      }),
    ).toEqual({
      backend: "qmd",
      qmd: {},
      sessionKey: "agent-main-dashboard-test-telegram",
    });
  });

  it("clamps fallback snippet ranges to the transcript length", async () => {
    const state = createState();
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-2",
    });

    const [result] = await manager.search("beta", {
      sessionKey: "session-2",
      maxResults: 5,
    });

    expect(result?.path).toBe("sessions/session-2.txt");
    expect(result?.startLine).toBe(8);
    expect(result?.endLine).toBe(9);
  });

  it("fails cleanly when ownerPeer is unavailable after initialization", async () => {
    const state = createState();
    state.ownerPeer = null;

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    await expect(
      manager.search("remember", {
        sessionKey: "session-1",
      }),
    ).rejects.toThrow(/owner peer not initialized/);
    await expect(
      manager.readFile({
        relPath: "sessions/session-1.txt",
      }),
    ).rejects.toThrow(/owner peer not initialized/);
  });
});
