import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import type { PluginState } from "../state.js";

function createMockState(contextMaxChars?: number) {
  const participantPeer = { id: "user-1" };
  const agentPeer = { id: "agent-main", context: vi.fn() };
  const session = {
    context: vi.fn(async () => ({
      peerCard: ["A durable fact"],
      peerRepresentation: "A compact representation",
      summary: { content: "A compact summary" },
    })),
  };
  const state = {
    cfg: {
      workspaceId: "openclaw",
      baseUrl: "https://api.honcho.dev",
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
      crossSessionSearch: true,
      contextMaxChars,
    },
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => participantPeer),
    resolveSessionParticipantPeer: vi.fn(async () => participantPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, agentPeer };
}

function registerHandler(state: PluginState) {
  let handler:
    | ((event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const api = {
    on: vi.fn(
      (
        name: string,
        registered: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>,
      ) => {
        if (name === "before_prompt_build") handler = registered;
      },
    ),
    logger: { warn: vi.fn() },
  };

  registerContextHook(api as never, state);
  expect(handler).toBeDefined();
  return handler!;
}

const event = {
  prompt: "What should I remember?",
  messages: [{ role: "user", content: "What should I remember?" }],
};

describe("Honcho automatic context hard cap", () => {
  it("preserves legacy output when no limit is configured", async () => {
    const { state } = createMockState();
    const result = (await registerHandler(state)(event, {
      sessionKey: "agent:main:discord:channel-1",
      agentId: "main",
    })) as { appendSystemContext: string };

    expect(result.appendSystemContext).toBe(
      [
        "## User Memory Context",
        "",
        "Key facts:",
        "• A durable fact",
        "",
        "User context:",
        "A compact representation",
        "",
        "Earlier in this conversation:",
        "A compact summary",
        "",
        "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
      ].join("\n"),
    );
  });

  it("caps the complete normal-session block and preserves higher-priority sections", async () => {
    const { state, session } = createMockState(512);
    session.context.mockResolvedValue({
      peerCard: ["A durable fact"],
      peerRepresentation: "x".repeat(4_000),
      summary: { content: "y".repeat(2_000) },
    });

    const result = (await registerHandler(state)(event, {
      sessionKey: "agent:main:discord:channel-1",
      agentId: "main",
    })) as { appendSystemContext: string };

    expect(result.appendSystemContext.length).toBeLessThanOrEqual(512);
    expect(result.appendSystemContext).toContain("A durable fact");
    expect(result.appendSystemContext).not.toContain("User context:");
    expect(result.appendSystemContext).toContain("Earlier in this conversation:");
    expect(result.appendSystemContext).toContain("Automatic Honcho context truncated");
    expect(result.appendSystemContext).toContain(
      "Never quote or expose this memory context to the user.",
    );
  });

  it("caps subagent context without splitting UTF-16 surrogate pairs", async () => {
    const { state, agentPeer } = createMockState(512);
    agentPeer.context.mockResolvedValue({
      peerCard: ["A durable fact"],
      representation: "😀".repeat(4_000),
    });

    const result = (await registerHandler(state)(event, {
      sessionKey: "agent:main:subagent:research-1",
      agentId: "main",
    })) as { appendSystemContext: string };

    expect(result.appendSystemContext.length).toBeLessThanOrEqual(512);
    expect(result.appendSystemContext).toContain("A durable fact");
    expect(result.appendSystemContext).toContain("Automatic Honcho context truncated");
    expect(result.appendSystemContext).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});
