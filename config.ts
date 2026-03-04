/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;
  peerId: string;
  peerAllies?: string[];
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

    const parsePeerAllies = (): string[] | undefined => {
      if (Array.isArray(cfg.peerAllies)) {
        const allies = cfg.peerAllies
          .filter((id): id is string => typeof id === "string")
          .map((id) => resolveEnvVars(id).trim())
          .filter((id) => id.length > 0);
        return allies.length > 0 ? allies : undefined;
      }

      if (typeof cfg.peerAllies === "string" && cfg.peerAllies.length > 0) {
        const allies = resolveEnvVars(cfg.peerAllies)
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        return allies.length > 0 ? allies : undefined;
      }

      if (process.env.HONCHO_PEER_ALLIES) {
        const allies = process.env.HONCHO_PEER_ALLIES.split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        return allies.length > 0 ? allies : undefined;
      }

      return undefined;
    };

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
      peerId:
        typeof cfg.peerId === "string" && cfg.peerId.length > 0
          ? resolveEnvVars(cfg.peerId)
          : process.env.HONCHO_PEER_ID ?? "openclaw",
      peerAllies: parsePeerAllies(),
    };
  },
};
