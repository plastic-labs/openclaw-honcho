/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

// @ts-ignore - resolved by openclaw runtime
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const DEFAULT_AUTH_BROKER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_AUTH_BROKER_RESPONSE_MODELS = ["gpt-5.4-mini", "gpt-5.4"];

export type HonchoAuthBrokerConfig = {
  enabled: boolean;
  bearerToken?: SecretInput;
  authAgentId?: string;
  authProfileId?: string;
  responseModels: string[];
  maxRequestBytes: number;
  timeoutMs: number;
};

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
  authBroker: HonchoAuthBrokerConfig;
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

function positiveIntegerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function isSecretRefLike(value: unknown): value is Exclude<SecretInput, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.source === "string" &&
    ["env", "file", "exec"].includes(ref.source) &&
    typeof ref.provider === "string" &&
    typeof ref.id === "string" &&
    ref.source.trim().length > 0 &&
    ref.provider.trim().length > 0 &&
    ref.id.trim().length > 0
  );
}

function isResolvedBrokerBearerToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 32;
}

function parseResponseModels(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_AUTH_BROKER_RESPONSE_MODELS];
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("authBroker.responseModels must contain between 1 and 16 model IDs");
  }
  const models = value.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (
    models.some(
      (model) =>
        model.length === 0 || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model),
    )
  ) {
    throw new Error("authBroker.responseModels contains an invalid model ID");
  }
  if (new Set(models).size !== models.length) {
    throw new Error("authBroker.responseModels must not contain duplicate model IDs");
  }
  return models;
}

function parseAuthBrokerConfig(value: unknown): HonchoAuthBrokerConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const enabled = raw.enabled === true;
  const configuredToken = raw.bearerToken;
  const bearerToken = isSecretRefLike(configuredToken)
    ? configuredToken
    : isResolvedBrokerBearerToken(configuredToken)
      ? configuredToken.trim()
      : undefined;
  const authAgentId =
    typeof raw.authAgentId === "string" && raw.authAgentId.trim().length > 0
      ? raw.authAgentId.trim()
      : undefined;
  const authProfileId =
    typeof raw.authProfileId === "string" && raw.authProfileId.trim().length > 0
      ? raw.authProfileId.trim()
      : undefined;

  if (
    configuredToken !== undefined &&
    !isSecretRefLike(configuredToken) &&
    !isResolvedBrokerBearerToken(configuredToken)
  ) {
    throw new Error(
      "authBroker.bearerToken must be an env, file, or exec OpenClaw SecretRef or a host-resolved string of at least 32 characters",
    );
  }
  if (enabled && bearerToken === undefined) {
    throw new Error(
      "authBroker.enabled requires an explicit authBroker.bearerToken SecretRef or host-resolved token",
    );
  }
  if (enabled && authAgentId === undefined) {
    throw new Error("authBroker.enabled requires an explicit authBroker.authAgentId");
  }
  if (enabled && authProfileId === undefined) {
    throw new Error("authBroker.enabled requires an explicit authBroker.authProfileId");
  }
  if (
    authProfileId !== undefined &&
    (authProfileId.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(authProfileId))
  ) {
    throw new Error("authBroker.authProfileId contains an invalid profile ID");
  }

  return {
    enabled,
    bearerToken,
    authAgentId,
    authProfileId,
    responseModels: parseResponseModels(raw.responseModels),
    maxRequestBytes: positiveIntegerInRange(
      raw.maxRequestBytes,
      DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES,
      1024,
      16 * 1024 * 1024,
    ),
    timeoutMs: positiveIntegerInRange(
      raw.timeoutMs,
      DEFAULT_AUTH_BROKER_TIMEOUT_MS,
      1000,
      15 * 60 * 1000,
    ),
  };
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
      authBroker: parseAuthBrokerConfig(cfg.authBroker),
    };
  },
};
