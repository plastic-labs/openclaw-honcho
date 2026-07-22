import type { HonchoConfig, WorkspaceRoutingRule } from "./config.js";

export type WorkspaceRouteContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  messageProvider?: string;
  channelId?: string;
  chatId?: string;
  conversationTarget?: string;
  accountId?: string;
  threadId?: string;
  destination?: string;
  parentSessionKey?: string;
};

/**
 * OpenClaw exposes the same conversation as hook `chatId` and tool
 * `deliveryContext.to`. The latter may carry a redundant `<channel>:` prefix.
 */
export function canonicalConversationTarget(value: string | undefined, channel?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const prefix = channel?.trim().toLowerCase();
  if (prefix && normalized.toLowerCase().startsWith(`${prefix}:`)) {
    const unprefixed = normalized.slice(prefix.length + 1).trim();
    return unprefixed || undefined;
  }
  return normalized;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function routingScalarField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Select only host-owned routing fields from an agent lifecycle context. */
export function workspaceRouteContextFromAgentHook(input: unknown): WorkspaceRouteContext {
  const ctx = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const channelContext = ctx.channelContext && typeof ctx.channelContext === "object"
    ? ctx.channelContext as Record<string, unknown>
    : {};
  const chat = channelContext.chat && typeof channelContext.chat === "object"
    ? channelContext.chat as Record<string, unknown>
    : {};
  const rawThreadId = ctx.threadId;
  const channel = stringField(ctx, "channel") ?? stringField(ctx, "messageProvider");
  const chatId = routingScalarField(ctx, "chatId") ?? routingScalarField(chat, "id");
  const channelId = routingScalarField(ctx, "channelId");
  const destination = routingScalarField(ctx, "destination") ?? routingScalarField(ctx, "to");
  return normalizeWorkspaceRouteContext({
    agentId: stringField(ctx, "agentId"),
    sessionKey: stringField(ctx, "sessionKey"),
    sessionId: stringField(ctx, "sessionId"),
    channel,
    messageProvider: stringField(ctx, "messageProvider"),
    channelId,
    chatId,
    conversationTarget: canonicalConversationTarget(chatId ?? destination ?? channelId, channel),
    accountId: routingScalarField(ctx, "accountId"),
    threadId: typeof rawThreadId === "string" || typeof rawThreadId === "number"
      ? String(rawThreadId)
      : undefined,
    destination,
  });
}

/** Select only host-owned routing fields from a plugin tool factory context. */
export function workspaceRouteContextFromToolFactory(input: unknown): WorkspaceRouteContext {
  const ctx = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const deliveryContext = ctx.deliveryContext && typeof ctx.deliveryContext === "object"
    ? ctx.deliveryContext as Record<string, unknown>
    : {};
  const rawThreadId = deliveryContext.threadId;
  const channel = stringField(deliveryContext, "channel") ?? stringField(ctx, "messageChannel");
  const destination = routingScalarField(deliveryContext, "to");
  return normalizeWorkspaceRouteContext({
    agentId: stringField(ctx, "agentId"),
    sessionKey: stringField(ctx, "sessionKey"),
    sessionId: stringField(ctx, "sessionId"),
    channel,
    accountId: routingScalarField(deliveryContext, "accountId")
      ?? routingScalarField(ctx, "agentAccountId"),
    threadId: typeof rawThreadId === "string" || typeof rawThreadId === "number"
      ? String(rawThreadId)
      : undefined,
    destination,
    conversationTarget: canonicalConversationTarget(destination, channel),
  });
}

export class WorkspaceRoutingError extends Error {
  constructor(readonly routeReason: string) {
    super(`workspace routing denied: ${routeReason}`);
    this.name = "WorkspaceRoutingError";
  }
}

export function safeLifecycleError(error: unknown): string {
  if (error instanceof WorkspaceRoutingError) return error.message;
  return error instanceof Error ? error.name : "UnknownError";
}

const CONTEXT_KEYS: Array<keyof WorkspaceRouteContext> = [
  "agentId", "sessionKey", "sessionId", "channel", "messageProvider",
  "channelId", "chatId", "conversationTarget", "accountId", "threadId", "destination", "parentSessionKey",
];

/** Copy only trusted routing fields; callers must construct this from host context. */
export function normalizeWorkspaceRouteContext(input: WorkspaceRouteContext = {}): WorkspaceRouteContext {
  const output: WorkspaceRouteContext = {};
  for (const key of CONTEXT_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    output[key] = value.trim();
  }
  if (output.agentId) output.agentId = output.agentId.toLowerCase();
  if (output.channel) output.channel = output.channel.toLowerCase();
  if (output.messageProvider) output.messageProvider = output.messageProvider.toLowerCase();
  return output;
}

export type RouteResult =
  | { status: "resolved"; workspaceId: string; source: "binding" | "rule" | "inheritance" | "agent" | "legacy" }
  | { status: "unknown-route"; reason: "unknown-route" | "ambiguous-route" | "missing-session-key" }
  | { status: "binding-conflict"; workspaceId: string; requestedWorkspaceId: string };

export type BindingResult =
  | { status: "bound"; workspaceId: string }
  | { status: "existing"; workspaceId: string }
  | { status: "binding-conflict"; workspaceId: string; requestedWorkspaceId: string };

type BindingSource = "rule" | "inheritance" | "agent" | "legacy" | "unknown";
type BindingRecord = { workspaceId: string; source: BindingSource };

/** In-memory, write-once session routing relation. */
export class SessionWorkspaceBindingStore {
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly deniedSessions = new Set<string>();
  private readonly inheritedSessions = new Set<string>();

  get(sessionKey: string | undefined): string | undefined {
    return sessionKey ? this.bindings.get(sessionKey)?.workspaceId : undefined;
  }

  getSource(sessionKey: string | undefined): BindingSource | undefined {
    return sessionKey ? this.bindings.get(sessionKey)?.source : undefined;
  }

  isDenied(sessionKey: string | undefined): boolean {
    return sessionKey ? this.deniedSessions.has(sessionKey) : false;
  }

  isInherited(sessionKey: string | undefined): boolean {
    return sessionKey ? this.inheritedSessions.has(sessionKey) : false;
  }

  /** Permanently fail closed for a session whose inherited route was invalid. */
  deny(sessionKey: string): void {
    if (sessionKey) this.deniedSessions.add(sessionKey);
  }

  bind(sessionKey: string, workspaceId: string, source: BindingSource = "unknown"): BindingResult {
    const existing = this.bindings.get(sessionKey);
    if (existing) {
      if (existing.workspaceId === workspaceId) {
        // Retain explicit provenance when another surface later omits the
        // route-only field and exposes only the lower-precedence agent default.
        if (source === "rule" && existing.source !== "rule") existing.source = "rule";
        return { status: "existing", workspaceId: existing.workspaceId };
      }
      return { status: "binding-conflict", workspaceId: existing.workspaceId, requestedWorkspaceId: workspaceId };
    }
    this.bindings.set(sessionKey, { workspaceId, source });
    return { status: "bound", workspaceId };
  }

  bindChild(parentSessionKey: string, childSessionKey: string): BindingResult | { status: "unknown-parent" } {
    const workspaceId = this.bindings.get(parentSessionKey)?.workspaceId;
    if (!workspaceId) return { status: "unknown-parent" };
    const result = this.bind(childSessionKey, workspaceId, "inheritance");
    if (result.status !== "binding-conflict") this.inheritedSessions.add(childSessionKey);
    return result;
  }

}

function valueFor(context: WorkspaceRouteContext, key: keyof WorkspaceRoutingRule): string | undefined {
  if (key === "conversationTarget" || key === "chatId" || key === "channelId" || key === "destination") {
    return context.conversationTarget ?? canonicalConversationTarget(
      context.chatId ?? context.destination ?? context.channelId,
      context.channel ?? context.messageProvider,
    );
  }
  const value = (context as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matches(rule: WorkspaceRoutingRule, context: WorkspaceRouteContext): boolean {
  for (const key of Object.keys(rule) as Array<keyof WorkspaceRoutingRule>) {
    if (key === "workspaceId") continue;
    const actual = valueFor(context, key);
    const expected = rule[key];
    if (!actual || actual !== expected) return false;
  }
  return true;
}

function explicitWorkspace(config: HonchoConfig, context: WorkspaceRouteContext): string | undefined {
  const matched = config.workspaceRoutingRules.filter((rule) => matches(rule, context));
  const workspaces = [...new Set(matched.map((rule) => rule.workspaceId))];
  return workspaces.length === 1 ? workspaces[0] : undefined;
}

function matchingWorkspaces(config: HonchoConfig, context: WorkspaceRouteContext): string[] {
  return [...new Set(config.workspaceRoutingRules.filter((rule) => matches(rule, context)).map((rule) => rule.workspaceId))];
}

export function resolveWorkspaceRoute(
  config: HonchoConfig,
  context: WorkspaceRouteContext,
  bindings = new SessionWorkspaceBindingStore(),
): RouteResult {
  context = normalizeWorkspaceRouteContext(context);
  if (bindings.isDenied(context.sessionKey)) {
    return { status: "unknown-route", reason: "unknown-route" };
  }
  const rules = config.workspaceRoutingRules ?? [];
  const agentMap = config.workspaceIdByAgent ?? {};
  const existing = bindings.get(context.sessionKey);
  const existingSource = bindings.getSource(context.sessionKey);
  if (existing) {
    const ruleWorkspaces = matchingWorkspaces({ ...config, workspaceRoutingRules: rules }, context);
    if (ruleWorkspaces.length > 0) {
      const conflictingWorkspace = ruleWorkspaces.find((workspaceId) => workspaceId !== existing);
      if (conflictingWorkspace) {
        return { status: "binding-conflict", workspaceId: existing, requestedWorkspaceId: conflictingWorkspace };
      }
      // Explicit trusted route metadata outranks the agent-wide default. A
      // matching explicit route must remain stable on every tool/hook access.
      bindings.bind(context.sessionKey!, existing, "rule");
      return { status: "resolved", workspaceId: existing, source: "binding" };
    }
    // A child agent's own agent-wide mapping must not displace the workspace
    // inherited from its requester. Explicit trusted route metadata can still
    // report a conflict, and an already-bound child is never rebound.
    const agentWorkspace = context.agentId && !bindings.isInherited(context.sessionKey) && existingSource !== "rule"
      ? agentMap[context.agentId.trim().toLowerCase()]
      : undefined;
    const conflictingWorkspace = (agentWorkspace ? [agentWorkspace] : [])
      .find((workspaceId) => workspaceId !== existing);
    if (conflictingWorkspace) {
      return { status: "binding-conflict", workspaceId: existing, requestedWorkspaceId: conflictingWorkspace };
    }
    return { status: "resolved", workspaceId: existing, source: "binding" };
  }

  const explicit = explicitWorkspace({ ...config, workspaceRoutingRules: rules }, context);
  if (rules.length > 0 && rules.some((rule) => matches(rule, context))) {
    const matching = rules.filter((rule) => matches(rule, context));
    if (new Set(matching.map((rule) => rule.workspaceId)).size > 1) return { status: "unknown-route", reason: "ambiguous-route" };
    if (context.sessionKey) {
      const result = bindings.bind(context.sessionKey, explicit!, "rule");
      if (result.status === "binding-conflict") return result;
    }
    return { status: "resolved", workspaceId: explicit!, source: "rule" };
  }

  const inherited = bindings.get(context.parentSessionKey);
  if (inherited) {
    if (context.sessionKey) bindings.bind(context.sessionKey, inherited, "inheritance");
    return { status: "resolved", workspaceId: inherited, source: "inheritance" };
  }

  const agentId = context.agentId?.trim().toLowerCase();
  const agentWorkspace = agentId ? agentMap[agentId] : undefined;
  if (agentWorkspace) {
    if (context.sessionKey) bindings.bind(context.sessionKey, agentWorkspace, "agent");
    return { status: "resolved", workspaceId: agentWorkspace, source: "agent" };
  }

  if (!config.strictWorkspaceRouting && config.legacyWorkspaceFallback) {
    if (context.sessionKey) bindings.bind(context.sessionKey, config.workspaceId, "legacy");
    return { status: "resolved", workspaceId: config.workspaceId, source: "legacy" };
  }
  return { status: "unknown-route", reason: context.sessionKey ? "unknown-route" : "missing-session-key" };
}

export function resolveOrThrow(config: HonchoConfig, context: WorkspaceRouteContext, bindings?: SessionWorkspaceBindingStore): string {
  const result = resolveWorkspaceRoute(config, context, bindings);
  if (result.status !== "resolved") throw new WorkspaceRoutingError(result.status === "binding-conflict" ? "binding-conflict" : result.reason);
  return result.workspaceId;
}

/** Lifecycle hooks must establish an immutable session binding before access. */
export function resolveAgentHookWorkspaceOrThrow(
  config: HonchoConfig,
  input: unknown,
  bindings: SessionWorkspaceBindingStore,
): string {
  const context = workspaceRouteContextFromAgentHook(input);
  if (!context.sessionKey) throw new WorkspaceRoutingError("missing-session-key");
  return resolveOrThrow(config, context, bindings);
}

/** Tool factories use only trusted host context and require a session binding. */
export function resolveToolWorkspaceOrThrow(
  config: HonchoConfig,
  input: unknown,
  bindings: SessionWorkspaceBindingStore,
): { workspaceId: string; context: WorkspaceRouteContext } {
  const context = workspaceRouteContextFromToolFactory(input);
  if (!context.sessionKey) throw new WorkspaceRoutingError("missing-session-key");
  return {
    workspaceId: resolveOrThrow(config, context, bindings),
    context,
  };
}

/** Safe user-facing/tool diagnostic: route reasons are useful; provider details are not. */
export function safeToolError(error: unknown): string {
  return error instanceof WorkspaceRoutingError ? error.message : "memory provider unavailable";
}

/** Memory callbacks lack trusted turn metadata; only agent-wide routes are safe. */
export function resolveMemoryRuntimeWorkspace(config: HonchoConfig, agentId?: string): string | undefined {
  const id = agentId?.trim().toLowerCase();
  const agentMap = config.workspaceIdByAgent ?? {};
  const rules = config.workspaceRoutingRules ?? [];
  if (id && agentMap[id]) {
    const relevantRules = rules.filter((rule) => !rule.agentId || rule.agentId === id);
    if (relevantRules.some((rule) => rule.workspaceId !== agentMap[id])) return undefined;
    return agentMap[id];
  }
  if (Object.keys(agentMap).length === 0 && rules.length === 0 && !config.strictWorkspaceRouting && config.legacyWorkspaceFallback !== false) {
    return config.workspaceId;
  }
  return undefined;
}
