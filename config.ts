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
  /**
   * Optional per-agent workspace routing.
   * Maps agent ID prefixes to Honcho workspace IDs.
   * Agents whose IDs start with a matching prefix will use the mapped workspace.
   * Agents not matching any prefix fall back to the default `workspaceId`.
   *
   * Example:
   * ```json
   * {
   *   "nr_": "neoreef",
   *   "hb_": "her-beauty",
   *   "lc_": "lifecycle"
   * }
   * ```
   */
  workspaceMapping?: Record<string, string>;
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

    // Parse optional workspace mapping (agentId prefix → workspaceId)
    let workspaceMapping: Record<string, string> | undefined;
    if (cfg.workspaceMapping && typeof cfg.workspaceMapping === "object" && !Array.isArray(cfg.workspaceMapping)) {
      const mapping: Record<string, string> = {};
      for (const [prefix, wsId] of Object.entries(cfg.workspaceMapping as Record<string, unknown>)) {
        if (typeof prefix === "string" && prefix.length > 0 && typeof wsId === "string" && wsId.length > 0) {
          mapping[prefix] = wsId;
        }
      }
      if (Object.keys(mapping).length > 0) {
        workspaceMapping = mapping;
      }
    }

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
      workspaceMapping,
    };
  },
};
