import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "../config.js";
import {
  resolveMemoryRuntimeWorkspace,
  normalizeWorkspaceRouteContext,
  resolveWorkspaceRoute,
  SessionWorkspaceBindingStore,
  workspaceRouteContextFromAgentHook,
  workspaceRouteContextFromToolFactory,
} from "../routing.js";

describe("workspace routing configuration", () => {
  it("preserves legacy single-workspace behavior", () => {
    const cfg = honchoConfigSchema.parse({ workspaceId: "legacy" });
    expect(cfg.workspaceIdByAgent).toEqual({});
    expect(resolveWorkspaceRoute(cfg, { agentId: "main", sessionKey: "s" }).workspaceId).toBe("legacy");
  });

  it("normalizes agent IDs and rejects malformed mappings/rules", () => {
    const cfg = honchoConfigSchema.parse({ workspaceIdByAgent: { " Main ": "work" } });
    expect(cfg.workspaceIdByAgent).toEqual({ main: "work" });
    expect(() => honchoConfigSchema.parse({ workspaceIdByAgent: [] })).toThrow();
    expect(() => honchoConfigSchema.parse({ workspaceRoutingRules: [{ workspaceId: "w", nope: "x" }] })).toThrow();
  });

  it("uses explicit rules before agent mappings and denies unknown strict routes", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceId: "legacy",
      workspaceIdByAgent: { main: "agent-work" },
      workspaceRoutingRules: [{ workspaceId: "chat-work", agentId: "main", channel: "telegram", chatId: "42" }],
      strictWorkspaceRouting: true,
    });
    expect(resolveWorkspaceRoute(cfg, { agentId: "main", channel: "telegram", chatId: "42", sessionKey: "s" })).toMatchObject({ workspaceId: "chat-work", source: "rule" });
    expect(resolveWorkspaceRoute(cfg, { agentId: "other", sessionKey: "unknown" })).toEqual({ status: "unknown-route", reason: "unknown-route" });
  });

  it("normalizes trusted context without accepting arbitrary fields", () => {
    expect(normalizeWorkspaceRouteContext({ agentId: " Main ", channel: "Telegram", chatId: " 42 ", sessionKey: "s", destination: "x" })).toEqual({
      agentId: "main", channel: "telegram", chatId: "42", sessionKey: "s", destination: "x",
    });
  });

  it("normalizes only host-owned tool factory routing fields", () => {
    expect(workspaceRouteContextFromToolFactory({
      agentId: " Main ",
      sessionKey: " session ",
      sessionId: "turn-id",
      messageChannel: "fallback-channel",
      agentAccountId: "fallback-account",
      deliveryContext: {
        channel: "Telegram",
        to: 42,
        accountId: "bot-account",
        threadId: 7,
      },
      workspaceId: "attacker-chosen",
    })).toEqual({
      agentId: "main",
      sessionKey: "session",
      sessionId: "turn-id",
      channel: "telegram",
      destination: "42",
      conversationTarget: "42",
      accountId: "bot-account",
      threadId: "7",
    });
  });

  it("canonicalizes hook chatId and tool destination to one conversation target", () => {
    expect(workspaceRouteContextFromAgentHook({
      agentId: "main",
      sessionKey: "s",
      channel: "telegram",
      chatId: "group-42",
    }).conversationTarget).toBe("group-42");
    expect(workspaceRouteContextFromToolFactory({
      agentId: "main",
      sessionKey: "s",
      deliveryContext: { channel: "telegram", to: "telegram:group-42" },
    }).conversationTarget).toBe("group-42");

    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "personal" },
      workspaceRoutingRules: [
        { workspaceId: "work", channel: "telegram", destination: "telegram:group-42" },
      ],
      strictWorkspaceRouting: true,
    });
    expect(cfg.workspaceRoutingRules[0]).toMatchObject({
      workspaceId: "work",
      channel: "telegram",
      conversationTarget: "group-42",
    });
    expect(cfg.workspaceRoutingRules[0]).not.toHaveProperty("destination");
  });

  it("rejects conflicting conversation target aliases", () => {
    expect(() => honchoConfigSchema.parse({
      workspaceRoutingRules: [{
        workspaceId: "work",
        channel: "telegram",
        conversationTarget: "one",
        destination: "two",
      }],
    })).toThrow(/conversation target aliases disagree/);
  });

  it("requires explicit opt-in to legacy fallback after adding routing fields", () => {
    const cfg = honchoConfigSchema.parse({ workspaceId: "legacy", workspaceIdByAgent: { main: "work" } });
    expect(resolveWorkspaceRoute(cfg, { agentId: "other", sessionKey: "s" }).status).toBe("unknown-route");
    const optedIn = honchoConfigSchema.parse({ workspaceId: "legacy", workspaceIdByAgent: { main: "work" }, strictWorkspaceRouting: false });
    expect(resolveWorkspaceRoute(optedIn, { agentId: "other", sessionKey: "s" })).toMatchObject({ workspaceId: "legacy", source: "legacy" });
  });
});

describe("immutable session workspace bindings", () => {
  it("keeps the first binding and reports later conflicts", () => {
    const store = new SessionWorkspaceBindingStore();
    expect(store.bind("s", "one")).toEqual({ status: "bound", workspaceId: "one" });
    expect(store.bind("s", "one")).toEqual({ status: "existing", workspaceId: "one" });
    expect(store.bind("s", "two")).toEqual({ status: "binding-conflict", workspaceId: "one", requestedWorkspaceId: "two" });
  });

  it("keeps a denied inherited session fail-closed even when legacy fallback is enabled", () => {
    const store = new SessionWorkspaceBindingStore();
    store.deny("child");
    const cfg = honchoConfigSchema.parse({ workspaceId: "legacy" });

    expect(resolveWorkspaceRoute(cfg, { sessionKey: "child", agentId: "main" }, store)).toEqual({
      status: "unknown-route",
      reason: "unknown-route",
    });
  });

  it("inherits a parent binding at the binding-store level", () => {
    const store = new SessionWorkspaceBindingStore();
    store.bind("parent", "work");
    expect(store.bindChild("parent", "child")).toEqual({ status: "bound", workspaceId: "work" });
    expect(store.get("child")).toBe("work");
    expect(store.bindChild("missing", "orphan")).toEqual({ status: "unknown-parent" });
  });

  it("keeps parent inheritance when the child agent has a different agent-wide mapping", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { research: "research-default" },
      strictWorkspaceRouting: true,
    });
    const store = new SessionWorkspaceBindingStore();
    store.bind("parent", "parent-workspace");
    store.bindChild("parent", "child");

    expect(resolveWorkspaceRoute(cfg, { sessionKey: "child", agentId: "research" }, store)).toEqual({
      status: "resolved",
      workspaceId: "parent-workspace",
      source: "binding",
    });
  });

  it("reports conflicting later metadata without rebinding", () => {
    const cfg = honchoConfigSchema.parse({ workspaceIdByAgent: { main: "two" }, strictWorkspaceRouting: true });
    const store = new SessionWorkspaceBindingStore();
    store.bind("s", "one");
    expect(resolveWorkspaceRoute(cfg, { sessionKey: "s", agentId: "main" }, store)).toMatchObject({ status: "binding-conflict", workspaceId: "one", requestedWorkspaceId: "two" });
    expect(store.get("s")).toBe("one");
  });

  it("reports a binding conflict when later metadata matches multiple workspaces", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceRoutingRules: [
        { workspaceId: "one", channel: "telegram" },
        { workspaceId: "two", channel: "telegram", chatId: "42" },
      ],
      strictWorkspaceRouting: true,
    });
    const store = new SessionWorkspaceBindingStore();
    store.bind("s", "one");
    expect(resolveWorkspaceRoute(cfg, { sessionKey: "s", channel: "telegram", chatId: "42" }, store)).toEqual({
      status: "binding-conflict", workspaceId: "one", requestedWorkspaceId: "two",
    });
    expect(store.get("s")).toBe("one");
  });

  it("keeps an existing binding when all later routing signals agree", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "one" },
      workspaceRoutingRules: [
        { workspaceId: "one", channel: "telegram" },
        { workspaceId: "one", channel: "telegram", chatId: "42" },
      ],
      strictWorkspaceRouting: true,
    });
    const store = new SessionWorkspaceBindingStore();
    store.bind("s", "one");
    expect(resolveWorkspaceRoute(cfg, { sessionKey: "s", agentId: "main", channel: "telegram", chatId: "42" }, store)).toEqual({
      status: "resolved", workspaceId: "one", source: "binding",
    });
    expect(store.get("s")).toBe("one");
  });

  it("keeps an explicit rule binding ahead of a different agent-wide default", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "personal" },
      workspaceRoutingRules: [{ workspaceId: "work", channel: "telegram", destination: "group" }],
      strictWorkspaceRouting: true,
    });
    const store = new SessionWorkspaceBindingStore();
    expect(resolveWorkspaceRoute(cfg, {
      sessionKey: "s",
      agentId: "main",
      channel: "telegram",
      chatId: "group",
    }, store)).toMatchObject({ workspaceId: "work", source: "rule" });
    expect(resolveWorkspaceRoute(cfg, {
      sessionKey: "s",
      agentId: "main",
      channel: "telegram",
      // Tool factory may omit the target on a later internal surface. The
      // explicit binding provenance prevents the lower agent default from
      // becoming a false conflict.
    }, store)).toEqual({ status: "resolved", workspaceId: "work", source: "binding" });
  });

  it("denies later genuinely conflicting explicit metadata without rebinding", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "personal" },
      workspaceRoutingRules: [
        { workspaceId: "work", channel: "telegram", conversationTarget: "group" },
        { workspaceId: "other", channel: "telegram", conversationTarget: "other-group" },
      ],
      strictWorkspaceRouting: true,
    });
    const store = new SessionWorkspaceBindingStore();
    expect(resolveWorkspaceRoute(cfg, {
      sessionKey: "s",
      agentId: "main",
      channel: "telegram",
      chatId: "group",
    }, store)).toMatchObject({ workspaceId: "work", source: "rule" });
    expect(resolveWorkspaceRoute(cfg, {
      sessionKey: "s",
      agentId: "main",
      channel: "telegram",
      destination: "other-group",
    }, store)).toEqual({
      status: "binding-conflict",
      workspaceId: "work",
      requestedWorkspaceId: "other",
    });
    expect(store.get("s")).toBe("work");
  });
});

describe("memory runtime routing boundary", () => {
  it("allows only an unambiguous agent-wide workspace", () => {
    const mapped = honchoConfigSchema.parse({ workspaceIdByAgent: { main: "work" }, strictWorkspaceRouting: true });
    expect(resolveMemoryRuntimeWorkspace(mapped, "main")).toBe("work");
    expect(resolveMemoryRuntimeWorkspace(mapped, "other")).toBeUndefined();
    const genericConflict = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "work" },
      workspaceRoutingRules: [{ workspaceId: "chat-work", channel: "telegram" }],
      strictWorkspaceRouting: true,
    });
    expect(resolveMemoryRuntimeWorkspace(genericConflict, "main")).toBeUndefined();
    const agentConflict = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "work" },
      workspaceRoutingRules: [{ workspaceId: "other-work", agentId: "main", chatId: "42" }],
      strictWorkspaceRouting: true,
    });
    expect(resolveMemoryRuntimeWorkspace(agentConflict, "main")).toBeUndefined();
    const rulesOnly = honchoConfigSchema.parse({ workspaceRoutingRules: [{ workspaceId: "work", channel: "telegram" }], strictWorkspaceRouting: true });
    expect(resolveMemoryRuntimeWorkspace(rulesOnly, "main")).toBeUndefined();
  });
});
