/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;
  syncOnStartup: boolean;
  dailySyncEnabled: boolean;
  syncFrequency: number; // Sync interval in minutes (1-1440)
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

    // Parse and clamp syncFrequency (default 60 minutes, range 1-1440)
    let syncFrequency = 60;
    if (typeof cfg.syncFrequency === "number" && !isNaN(cfg.syncFrequency)) {
      syncFrequency = Math.max(1, Math.min(1440, Math.floor(cfg.syncFrequency)));
    }

    return {
      apiKey,
      workspaceId:
        typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
          ? cfg.workspaceId
          : process.env.HONCHO_WORKSPACE_ID ?? "moltbot",
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
          ? cfg.baseUrl
          : process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",
      syncOnStartup: cfg.syncOnStartup !== false,
      dailySyncEnabled: cfg.dailySyncEnabled !== false,
      syncFrequency,
    };
  },
};
