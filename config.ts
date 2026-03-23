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
  noisePatterns: string[];
  disableDefaultNoisePatterns: boolean;
  ownerObserveOthers: boolean;
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
      noisePatterns,
      disableDefaultNoisePatterns,
      ownerObserveOthers: typeof cfg.ownerObserveOthers === "boolean" ? cfg.ownerObserveOthers : false,
    };
  },
};
