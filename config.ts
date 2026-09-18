/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export const DEFAULT_NOISE_PATTERNS: string[] = [
  "HEARTBEAT_OK",
  "A scheduled reminder has been triggered",
  "Execute your Session Startup sequence now",
  "Queued messages from",
];

/**
 * How far a recall call may reach.
 *
 * - `session`   — this Honcho session only.
 * - `scope`     — the sessions in `recall.scopeName`, a Honcho scope. Fails
 *                 closed when the scope is empty and needs a workspace-level
 *                 API key.
 * - `workspace` — every session the peer has written to.
 */
export const RECALL_SCOPES = ["session", "scope", "workspace"] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

/**
 * Recall boundaries, set per path because the paths carry different risk.
 *
 * `automatic` and `ask` run without anyone choosing them — the context hook
 * fires every turn, and the model decides when to call honcho_ask — so they
 * default to the active session. `tools` covers the explicitly human-invoked
 * tools, where broad recall is the point, so it stays workspace-wide.
 */
export type RecallConfig = {
  automatic: RecallScope;
  ask: RecallScope;
  tools: RecallScope;
  scopeName?: string;
};

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;
  timeoutMs?: number;
  noisePatterns: string[];
  disableDefaultNoisePatterns: boolean;
  ownerObserveOthers: boolean;
  crossSessionSearch: boolean;
  enableMemoryCompatibilityTools: boolean;
  recall: RecallConfig;
};

function parseRecallScope(value: unknown, fallback: RecallScope): RecallScope {
  return typeof value === "string" && (RECALL_SCOPES as readonly string[]).includes(value)
    ? (value as RecallScope)
    : fallback;
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
      enableMemoryCompatibilityTools: cfg.enableMemoryCompatibilityTools === true,
      recall: (() => {
        const raw = (cfg.recall ?? {}) as Record<string, unknown>;
        const scopeName =
          typeof raw.scopeName === "string" && raw.scopeName.trim().length > 0
            ? raw.scopeName.trim()
            : undefined;
        const resolve = (value: unknown, fallback: RecallScope): RecallScope => {
          const parsed = parseRecallScope(value, fallback);
          // "scope" without a name has no boundary to apply. Fall back to the
          // session rather than silently widening to the whole workspace.
          return parsed === "scope" && !scopeName ? "session" : parsed;
        };
        return {
          automatic: resolve(raw.automatic, "session"),
          ask: resolve(raw.ask, "session"),
          tools: resolve(raw.tools, "workspace"),
          scopeName,
        };
      })(),
    };
  },
};
