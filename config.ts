import { canonicalConversationTarget } from "./conversation-target.js";

/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export const DEFAULT_NOISE_PATTERNS: string[] = [
  "HEARTBEAT_OK",
  "A scheduled reminder has been triggered",
  "Execute your Session Startup sequence now",
  "Queued messages from",
];

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;
  timeoutMs?: number;
  noisePatterns: string[];
  disableDefaultNoisePatterns: boolean;
  ownerObserveOthers: boolean;
  crossSessionSearch: boolean;
  workspaceIdByAgent: Record<string, string>;
  workspaceRoutingRules: WorkspaceRoutingRule[];
  strictWorkspaceRouting: boolean;
  /** Whether the legacy workspaceId may be used when no route matches. */
  legacyWorkspaceFallback: boolean;
};

export type WorkspaceRoutingRule = {
  workspaceId: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  messageProvider?: string;
  /** Canonical channel-local conversation target shared by hooks and tools. */
  conversationTarget?: string;
  /** @deprecated Use conversationTarget. Accepted as a hook-side compatibility alias. */
  channelId?: string;
  /** @deprecated Use conversationTarget. Accepted as a hook-side compatibility alias. */
  chatId?: string;
  accountId?: string;
  threadId?: string;
  /** @deprecated Use conversationTarget. Accepted as a tool-side compatibility alias. */
  destination?: string;
};

const ROUTING_RULE_KEYS = new Set([
  "workspaceId", "agentId", "sessionKey", "channel", "messageProvider",
  "conversationTarget", "channelId", "chatId", "accountId", "threadId", "destination",
]);

const ROUTE_TARGET_KEYS = ["conversationTarget", "chatId", "channelId", "destination"] as const;

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${field}: expected a non-empty string`);
  }
  return value.trim();
}

function normalizeAgentMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspaceIdByAgent: expected an object");
  }
  const result: Record<string, string> = {};
  for (const [rawAgentId, rawWorkspaceId] of Object.entries(value)) {
    const agentId = requiredId(rawAgentId, "agent ID").toLowerCase();
    if (result[agentId]) throw new Error(`Duplicate workspaceIdByAgent agent: ${agentId}`);
    result[agentId] = requiredId(rawWorkspaceId, `workspace for agent ${agentId}`);
  }
  return result;
}

function normalizeRules(value: unknown): WorkspaceRoutingRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid workspaceRoutingRules: expected an array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid workspaceRoutingRules[${index}]: expected an object`);
    }
    for (const key of Object.keys(raw)) {
      if (!ROUTING_RULE_KEYS.has(key)) throw new Error(`Unknown workspace routing rule field: ${key}`);
    }
    const rule = raw as Record<string, unknown>;
    const normalized: WorkspaceRoutingRule = {
      workspaceId: requiredId(rule.workspaceId, `workspaceRoutingRules[${index}].workspaceId`),
    };
    for (const key of ROUTING_RULE_KEYS) {
      if (key === "workspaceId" || rule[key] === undefined) continue;
      (normalized as Record<string, string>)[key] = requiredId(rule[key], `workspaceRoutingRules[${index}].${key}`);
    }
    if (Object.keys(normalized).length === 1) {
      throw new Error(`Invalid workspaceRoutingRules[${index}]: a match field is required`);
    }
    if (normalized.agentId) normalized.agentId = normalized.agentId.toLowerCase();
    if (normalized.channel) normalized.channel = normalized.channel.toLowerCase();
    if (normalized.messageProvider) normalized.messageProvider = normalized.messageProvider.toLowerCase();
    const rawTargetValues = ROUTE_TARGET_KEYS
      .map((key) => normalized[key])
      .filter((value): value is string => typeof value === "string");
    const targetValues = rawTargetValues
      .map((value) => canonicalConversationTarget(value, normalized.channel ?? normalized.messageProvider))
      .filter((value): value is string => typeof value === "string");
    if (rawTargetValues.length > 0 && targetValues.length === 0) {
      throw new Error(`Invalid workspaceRoutingRules[${index}]: conversation target is empty`);
    }
    if (new Set(targetValues).size > 1) {
      throw new Error(`Invalid workspaceRoutingRules[${index}]: conversation target aliases disagree`);
    }
    if (targetValues[0]) normalized.conversationTarget = targetValues[0];
    delete normalized.chatId;
    delete normalized.channelId;
    delete normalized.destination;
    return normalized;
  });
}

/**
 * Resolve environment variable references in config values.
 * Supports ${ENV_VAR} syntax.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export const honchoConfigSchema = {
  parse(value: unknown): HonchoConfig {
    const cfg = (value ?? {}) as Record<string, unknown>;

    // Resolve API key with env var fallback
    let apiKey: string | undefined;
    if (typeof cfg.apiKey === "string" && cfg.apiKey.length > 0) {
      apiKey = resolveEnvVars(cfg.apiKey);
    } else {
      apiKey = process.env.HONCHO_API_KEY;
    }

    const disableDefaultNoisePatterns = cfg.disableDefaultNoisePatterns === true;
    const userPatterns = Array.isArray(cfg.noisePatterns)
      ? (cfg.noisePatterns as unknown[])
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];
    const noisePatterns = [
      ...new Set([...(disableDefaultNoisePatterns ? [] : DEFAULT_NOISE_PATTERNS), ...userPatterns]),
    ];

    const hasRoutingFields = Object.prototype.hasOwnProperty.call(cfg, "workspaceIdByAgent") ||
      Object.prototype.hasOwnProperty.call(cfg, "workspaceRoutingRules");
    const strictWorkspaceRouting = cfg.strictWorkspaceRouting === true;

    return {
      apiKey,
      workspaceId:
        typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
          ? cfg.workspaceId
          : process.env.HONCHO_WORKSPACE_ID ?? "openclaw",
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
          ? cfg.baseUrl
          : process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",
      timeoutMs: (() => {
        if (typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) {
          return cfg.timeoutMs;
        }
        if (process.env.HONCHO_TIMEOUT_MS !== undefined) {
          const parsed = Number(process.env.HONCHO_TIMEOUT_MS);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return undefined;
      })(),
      noisePatterns,
      disableDefaultNoisePatterns,
      ownerObserveOthers: typeof cfg.ownerObserveOthers === "boolean" ? cfg.ownerObserveOthers : false,
      crossSessionSearch: typeof cfg.crossSessionSearch === "boolean" ? cfg.crossSessionSearch : true,
      workspaceIdByAgent: normalizeAgentMap(cfg.workspaceIdByAgent),
      workspaceRoutingRules: normalizeRules(cfg.workspaceRoutingRules),
      strictWorkspaceRouting,
      // Existing configs remain compatible. Once routing is configured, the
      // fallback must be explicitly opted into with strictWorkspaceRouting:false.
      legacyWorkspaceFallback: !hasRoutingFields || (Object.prototype.hasOwnProperty.call(cfg, "strictWorkspaceRouting") && !strictWorkspaceRouting),
    };
  },
};
