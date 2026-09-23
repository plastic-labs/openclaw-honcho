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
 * - `scope`     — the sessions in `recall.scopeName`, a Honcho scope. Needs a
 *                 workspace-level API key. A scope with no member sessions
 *                 returns nothing rather than widening. Not to be confused with
 *                 a missing or blank `scopeName`, which falls back to `session`
 *                 below.
 * - `workspace` — every session the peer has written to.
 */
export const RECALL_SCOPES = ["session", "scope", "workspace"] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

/**
 * Recall boundaries, set per path.
 *
 * All three default to `workspace`, which is Honcho's design: a workspace is
 * the memory universe, and a peer's representation is synthesized across its
 * sessions. Narrowing is opt-in, for operators who want recall focused on the
 * conversation at hand rather than everything the peer has ever said.
 *
 * Narrowing is not a tenancy boundary. Keeping separate tenants apart belongs
 * at the workspace level, or in a scope — not in how far a single recall call
 * reaches inside a shared workspace.
 *
 * Only the automatic and ask paths are covered. The explicitly invoked tools
 * cannot be bounded uniformly on the current SDK surface: `peer.card()` takes
 * no scoping at all and `peer.search()` takes only `filters`, so a setting for
 * them would apply to some of their calls and silently skip others.
 */
export type RecallConfig = {
  automatic: RecallScope;
  ask: RecallScope;
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
  /** Save cron/heartbeat runs. Off by default: their prompts are machine text. */
  captureSystemRuns: boolean;
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
      captureSystemRuns: cfg.captureSystemRuns === true,
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
          automatic: resolve(raw.automatic, "workspace"),
          ask: resolve(raw.ask, "workspace"),
          scopeName,
        };
      })(),
    };
  },
};
