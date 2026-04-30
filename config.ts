/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export const DEFAULT_NOISE_PATTERNS: string[] = [
  "HEARTBEAT_OK",
  "NO_REPLY",
  "A scheduled reminder has been triggered",
  "Execute your Session Startup sequence now",
  "Queued messages from",
];

export const DEFAULT_ISOLATED_SESSION_PATTERNS: string[] = [
  "/(^|[:-])cron([:-]|$)/i",
  "/(^|[:-])subagent([:-]|$)/i",
  "/(^|[:-])heartbeat([:-]|$)/i",
  "/temp[-:]slug[-:]generator/i",
];

export type ContextInjectionMode = "off" | "full";
export type MemoryBackendMode = "qmd" | "builtin";

export type HonchoContextInjectionConfig = {
  peerCard: boolean;
  sessionSummary: boolean;
  representation: ContextInjectionMode;
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
  contextInjection: HonchoContextInjectionConfig;
  stripRuntimeScaffolding: boolean;
  isolatedSessionPatterns: string[];
  recentTailDedupeSize: number;
  memoryBackend: MemoryBackendMode;
};

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

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];
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
    const userPatterns = parseStringArray(cfg.noisePatterns);
    const noisePatterns = [
      ...new Set([...(disableDefaultNoisePatterns ? [] : DEFAULT_NOISE_PATTERNS), ...userPatterns]),
    ];

    const contextInjectionCfg =
      typeof cfg.contextInjection === "object" && cfg.contextInjection !== null
        ? (cfg.contextInjection as Record<string, unknown>)
        : {};
    const representationRaw =
      typeof contextInjectionCfg.representation === "string"
        ? contextInjectionCfg.representation
        : process.env.HONCHO_CONTEXT_REPRESENTATION;
    const representation: ContextInjectionMode =
      representationRaw === "off" || representationRaw === "full" ? representationRaw : "full";
    const contextInjection: HonchoContextInjectionConfig = {
      peerCard: typeof contextInjectionCfg.peerCard === "boolean" ? contextInjectionCfg.peerCard : true,
      sessionSummary:
        typeof contextInjectionCfg.sessionSummary === "boolean" ? contextInjectionCfg.sessionSummary : true,
      representation,
    };

    const isolatedSessionPatterns = [
      ...new Set([...DEFAULT_ISOLATED_SESSION_PATTERNS, ...parseStringArray(cfg.isolatedSessionPatterns)]),
    ];

    const memoryBackend: MemoryBackendMode = cfg.memoryBackend === "builtin" ? "builtin" : "qmd";

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
      contextInjection,
      stripRuntimeScaffolding:
        typeof cfg.stripRuntimeScaffolding === "boolean" ? cfg.stripRuntimeScaffolding : true,
      isolatedSessionPatterns,
      recentTailDedupeSize: parsePositiveInteger(cfg.recentTailDedupeSize, 200),
      memoryBackend,
    };
  },
};
