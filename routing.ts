import type { HonchoConfig, WorkspaceRoutingRule } from "./config.js";

export type WorkspaceRouteContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  messageProvider?: string;
  channelId?: string;
  chatId?: string;
  accountId?: string;
  threadId?: string;
  destination?: string;
  parentSessionKey?: string;
};

const CONTEXT_KEYS: Array<keyof WorkspaceRouteContext> = [
  "agentId", "sessionKey", "sessionId", "channel", "messageProvider",
  "channelId", "chatId", "accountId", "threadId", "destination", "parentSessionKey",
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

/** In-memory, write-once session routing relation. */
export class SessionWorkspaceBindingStore {
  private readonly bindings = new Map<string, string>();

  get(sessionKey: string | undefined): string | undefined {
    return sessionKey ? this.bindings.get(sessionKey) : undefined;
  }

  bind(sessionKey: string, workspaceId: string): BindingResult {
    const existing = this.bindings.get(sessionKey);
    if (existing) {
      return existing === workspaceId
        ? { status: "existing", workspaceId: existing }
        : { status: "binding-conflict", workspaceId: existing, requestedWorkspaceId: workspaceId };
    }
    this.bindings.set(sessionKey, workspaceId);
    return { status: "bound", workspaceId };
  }

  bindChild(parentSessionKey: string, childSessionKey: string): BindingResult | { status: "unknown-parent" } {
    const workspaceId = this.bindings.get(parentSessionKey);
    return workspaceId ? this.bind(childSessionKey, workspaceId) : { status: "unknown-parent" };
  }

}

function valueFor(context: WorkspaceRouteContext, key: keyof WorkspaceRoutingRule): string | undefined {
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
  const rules = config.workspaceRoutingRules ?? [];
  const agentMap = config.workspaceIdByAgent ?? {};
  const existing = bindings.get(context.sessionKey);
  if (existing) {
    const ruleWorkspaces = matchingWorkspaces({ ...config, workspaceRoutingRules: rules }, context);
    const agentWorkspace = context.agentId ? agentMap[context.agentId.trim().toLowerCase()] : undefined;
    const conflictingWorkspace = [...ruleWorkspaces, ...(agentWorkspace ? [agentWorkspace] : [])]
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
      const result = bindings.bind(context.sessionKey, explicit!);
      if (result.status === "binding-conflict") return result;
    }
    return { status: "resolved", workspaceId: explicit!, source: "rule" };
  }

  const inherited = bindings.get(context.parentSessionKey);
  if (inherited) {
    if (context.sessionKey) bindings.bind(context.sessionKey, inherited);
    return { status: "resolved", workspaceId: inherited, source: "inheritance" };
  }

  const agentId = context.agentId?.trim().toLowerCase();
  const agentWorkspace = agentId ? agentMap[agentId] : undefined;
  if (agentWorkspace) {
    if (context.sessionKey) bindings.bind(context.sessionKey, agentWorkspace);
    return { status: "resolved", workspaceId: agentWorkspace, source: "agent" };
  }

  if (!config.strictWorkspaceRouting && config.legacyWorkspaceFallback) {
    if (context.sessionKey) bindings.bind(context.sessionKey, config.workspaceId);
    return { status: "resolved", workspaceId: config.workspaceId, source: "legacy" };
  }
  return { status: "unknown-route", reason: context.sessionKey ? "unknown-route" : "missing-session-key" };
}

export function resolveOrThrow(config: HonchoConfig, context: WorkspaceRouteContext, bindings?: SessionWorkspaceBindingStore): string {
  const result = resolveWorkspaceRoute(config, context, bindings);
  if (result.status !== "resolved") throw new Error(`workspace routing denied: ${result.status === "binding-conflict" ? "binding-conflict" : result.reason}`);
  return result.workspaceId;
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
