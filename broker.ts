/**
 * OpenClaw-owned auth broker for self-hosted Honcho.
 *
 * Honcho authenticates to these two narrowly scoped HTTP routes with a
 * plugin-owned bearer token. The plugin then asks OpenClaw's canonical auth
 * runtime for the required upstream credential. No OpenClaw or Codex
 * credential store is exposed to the Honcho containers.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// @ts-ignore - resolved by openclaw runtime
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAgentDir,
} from "openclaw/plugin-sdk/agent-runtime";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore - resolved by openclaw runtime
import {
  listProfilesForProvider,
  resolveOpenAICodexAuthIdentity,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
// @ts-ignore - resolved by openclaw runtime
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
// @ts-ignore - resolved by openclaw runtime
import { getRuntimeConfigSourceSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
// @ts-ignore - resolved by openclaw runtime
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
// @ts-ignore - resolved by openclaw runtime
import {
  isSecretRef,
  resolveConfiguredSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
// @ts-ignore - resolved by openclaw runtime
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { HonchoAuthBrokerConfig } from "./config.js";

export const HONCHO_AUTH_BROKER_BASE_PATH = "/plugins/openclaw-honcho/auth-broker/v1";

const EMBEDDINGS_UPSTREAM_URL = "https://api.openai.com/v1/embeddings";
const CODEX_RESPONSES_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";

export const HONCHO_EMBEDDING_MODEL = "text-embedding-3-small";
// Match stock Honcho's default 2,048-item embedding batch while retaining an
// independent byte, per-item, and aggregate character bound at the broker.
export const HONCHO_MAX_EMBEDDING_INPUTS = 2_048;
export const HONCHO_MAX_EMBEDDING_INPUT_CHARS = 32_000;
export const HONCHO_MAX_EMBEDDING_TOTAL_CHARS = 1_200_000;
const HONCHO_MAX_IN_FLIGHT_PER_CLIENT = 10;
const HONCHO_MAX_RESPONSE_INPUT_ITEMS = 256;
const HONCHO_MAX_RESPONSE_INPUT_CHARS = 512_000;
const HONCHO_MAX_RESPONSE_INSTRUCTIONS_CHARS = 64_000;

type BrokerEndpoint = "embeddings" | "responses";

export type OpenAICodexBrokerCredential = {
  accessToken: string;
  accountId: string;
  profileId: string;
};

export type ResolveCodexCredentialOptions = {
  forceRefresh?: boolean;
  profileId?: string;
};

export type HonchoAuthBrokerDependencies = {
  fetch?: typeof fetch;
  resolveCredential: (
    options?: ResolveCodexCredentialOptions,
  ) => Promise<OpenAICodexBrokerCredential>;
  resolveBearerToken: (presentedToken?: string) => Promise<string | undefined>;
  logger?: Pick<OpenClawPluginApi["logger"], "warn">;
};

export type CanonicalCodexCredentialDependencies = {
  resolveAgentDir: typeof resolveAgentDir;
  loadAuthProfileStoreWithoutExternalProfiles: typeof loadAuthProfileStoreWithoutExternalProfiles;
  listProfilesForProvider: typeof listProfilesForProvider;
  resolveApiKeyForProvider: typeof resolveApiKeyForProvider;
  resolveOpenAICodexAuthIdentity: typeof resolveOpenAICodexAuthIdentity;
};

export type BrokerBearerTokenDependencies = {
  getRuntimeConfigSourceSnapshot: typeof getRuntimeConfigSourceSnapshot;
  resolveConfiguredSecretInputString: typeof resolveConfiguredSecretInputString;
};

export type BrokerBearerTokenResolverOptions = {
  cacheTtlMs?: number;
  now?: () => number;
};

const canonicalCodexCredentialDependencies: CanonicalCodexCredentialDependencies = {
  resolveAgentDir,
  loadAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  resolveApiKeyForProvider,
  resolveOpenAICodexAuthIdentity,
};

const brokerBearerTokenDependencies: BrokerBearerTokenDependencies = {
  getRuntimeConfigSourceSnapshot,
  resolveConfiguredSecretInputString,
};

const BROKER_BEARER_TOKEN_CACHE_TTL_MS = 5_000;

class BrokerCredentialUnavailableError extends Error {
  constructor() {
    super("OpenAI Codex OAuth is unavailable");
    this.name = "BrokerCredentialUnavailableError";
  }
}

function requestPath(req: IncomingMessage): string | undefined {
  if (!req.url) return undefined;
  try {
    return new URL(req.url, "http://127.0.0.1").pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function resolveEndpoint(req: IncomingMessage): BrokerEndpoint | undefined {
  const path = requestPath(req);
  if (path === `${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`) return "embeddings";
  if (path === `${HONCHO_AUTH_BROKER_BASE_PATH}/responses`) return "responses";
  return undefined;
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return undefined;
  return /^Bearer\s+([^\s]+)$/i.exec(raw)?.[1];
}

function setResponseHeaders(res: ServerResponse, contentType = "application/json; charset=utf-8") {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function respondJson(res: ServerResponse, statusCode: number, code: string, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = statusCode;
  setResponseHeaders(res);
  res.end(
    JSON.stringify({
      error: {
        type: "openclaw_honcho_auth_broker_error",
        code,
        message,
      },
    }),
  );
}

function isJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers["content-type"];
  return typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type PayloadValidation<T> = { ok: true; value: T } | { ok: false; message: string };

const EMBEDDING_REQUEST_FIELDS = new Set(["model", "input", "encoding_format", "dimensions"]);
const RESPONSE_REQUEST_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "store",
  "temperature",
  "max_output_tokens",
  "text",
  "include",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
]);
const USER_MESSAGE_FIELDS = new Set(["role", "content"]);
const INPUT_TEXT_FIELDS = new Set(["type", "text"]);
const ASSISTANT_MESSAGE_FIELDS = new Set(["type", "role", "content", "status", "id"]);
const OUTPUT_TEXT_FIELDS = new Set(["type", "text", "annotations"]);
const FUNCTION_CALL_FIELDS = new Set(["type", "id", "call_id", "name", "arguments"]);
const FUNCTION_CALL_OUTPUT_FIELDS = new Set(["type", "call_id", "output"]);
const FUNCTION_TOOL_FIELDS = new Set([
  "type",
  "name",
  "description",
  "parameters",
  "strict",
]);
const FUNCTION_TOOL_CHOICE_FIELDS = new Set(["type", "name"]);
const SIMPLE_TOOL_CHOICES = new Set(["auto", "none", "required"]);

function findUnsupportedField(
  payload: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(payload).find((field) => !allowed.has(field));
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return findUnsupportedField(value, allowed) === undefined;
}

function isInputTextPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, INPUT_TEXT_FIELDS) &&
    value.type === "input_text" &&
    typeof value.text === "string"
  );
}

function isUserMessageItem(value: Record<string, unknown>): boolean {
  return (
    hasOnlyFields(value, USER_MESSAGE_FIELDS) &&
    value.role === "user" &&
    Array.isArray(value.content) &&
    value.content.length > 0 &&
    value.content.every(isInputTextPart)
  );
}

function isOutputTextPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, OUTPUT_TEXT_FIELDS) &&
    value.type === "output_text" &&
    typeof value.text === "string" &&
    Array.isArray(value.annotations) &&
    value.annotations.length === 0
  );
}

function isAssistantMessageItem(value: Record<string, unknown>): boolean {
  return (
    hasOnlyFields(value, ASSISTANT_MESSAGE_FIELDS) &&
    value.type === "message" &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    value.content.length > 0 &&
    value.content.every(isOutputTextPart) &&
    value.status === "completed" &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function isFunctionCallItem(value: Record<string, unknown>): boolean {
  return (
    hasOnlyFields(value, FUNCTION_CALL_FIELDS) &&
    value.type === "function_call" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.call_id === "string" &&
    value.call_id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.arguments === "string"
  );
}

function isFunctionCallOutputItem(value: Record<string, unknown>): boolean {
  return (
    hasOnlyFields(value, FUNCTION_CALL_OUTPUT_FIELDS) &&
    value.type === "function_call_output" &&
    typeof value.call_id === "string" &&
    value.call_id.length > 0 &&
    typeof value.output === "string"
  );
}

function isAllowedResponseInputItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === undefined) return isUserMessageItem(value);
  if (value.type === "message") return isAssistantMessageItem(value);
  if (value.type === "function_call") return isFunctionCallItem(value);
  if (value.type === "function_call_output") return isFunctionCallOutputItem(value);
  return false;
}

function isFunctionTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, FUNCTION_TOOL_FIELDS) &&
    value.type === "function" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.description === "string" &&
    isRecord(value.parameters) &&
    value.strict === false
  );
}

function isAllowedToolChoice(value: unknown): boolean {
  if (typeof value === "string") return SIMPLE_TOOL_CHOICES.has(value);
  return (
    isRecord(value) &&
    hasOnlyFields(value, FUNCTION_TOOL_CHOICE_FIELDS) &&
    value.type === "function" &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

function validateEmbeddingPayload(
  payload: Record<string, unknown>,
): PayloadValidation<Record<string, unknown>> {
  const unsupported = findUnsupportedField(payload, EMBEDDING_REQUEST_FIELDS);
  if (unsupported) return { ok: false, message: `Unsupported embeddings field: ${unsupported}` };
  if (payload.model !== HONCHO_EMBEDDING_MODEL) {
    return { ok: false, message: `Embeddings model must be ${HONCHO_EMBEDDING_MODEL}` };
  }
  if (
    payload.encoding_format !== undefined &&
    payload.encoding_format !== "float" &&
    payload.encoding_format !== "base64"
  ) {
    return { ok: false, message: "Embeddings encoding_format must be float or base64" };
  }
  if (payload.dimensions !== undefined && payload.dimensions !== 1536) {
    return { ok: false, message: "Embeddings dimensions must be 1536" };
  }

  const inputs = typeof payload.input === "string" ? [payload.input] : payload.input;
  if (
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    inputs.length > HONCHO_MAX_EMBEDDING_INPUTS
  ) {
    return {
      ok: false,
      message: `Embeddings input must contain between 1 and ${HONCHO_MAX_EMBEDDING_INPUTS} strings`,
    };
  }
  if (inputs.some((input) => typeof input !== "string" || input.length === 0)) {
    return { ok: false, message: "Every embeddings input must be a non-empty string" };
  }
  const stringInputs = inputs as string[];
  if (stringInputs.some((input) => input.length > HONCHO_MAX_EMBEDDING_INPUT_CHARS)) {
    return {
      ok: false,
      message: `Each embeddings input is limited to ${HONCHO_MAX_EMBEDDING_INPUT_CHARS} characters`,
    };
  }
  if (
    stringInputs.reduce((total, input) => total + input.length, 0) >
    HONCHO_MAX_EMBEDDING_TOTAL_CHARS
  ) {
    return {
      ok: false,
      message: `Total embeddings input is limited to ${HONCHO_MAX_EMBEDDING_TOTAL_CHARS} characters`,
    };
  }
  // OpenAI's Python SDK sends `base64` by default when its caller omits this
  // option, but its post-parser also accepts float-array responses. Force the
  // fixed upstream request to float so the broker never decodes caller-shaped
  // binary data and Honcho consistently receives number arrays.
  return {
    ok: true,
    value: { ...payload, input: stringInputs, encoding_format: "float" },
  };
}

function validateResponsePayload(
  payload: Record<string, unknown>,
  allowedModels: readonly string[],
): PayloadValidation<Record<string, unknown>> {
  const unsupported = findUnsupportedField(payload, RESPONSE_REQUEST_FIELDS);
  if (unsupported) return { ok: false, message: `Unsupported Responses field: ${unsupported}` };
  if (typeof payload.model !== "string" || !allowedModels.includes(payload.model)) {
    return { ok: false, message: "Responses model is not allowed by authBroker.responseModels" };
  }
  if (typeof payload.input !== "string" && !Array.isArray(payload.input)) {
    return { ok: false, message: "Responses input must be a string or array" };
  }
  const normalizedInput =
    typeof payload.input === "string"
      ? [
          {
            role: "user",
            content: [{ type: "input_text", text: payload.input }],
          },
        ]
      : payload.input;
  if (
    Array.isArray(payload.input) &&
    (payload.input.length === 0 || payload.input.length > HONCHO_MAX_RESPONSE_INPUT_ITEMS)
  ) {
    return {
      ok: false,
      message: `Responses input is limited to ${HONCHO_MAX_RESPONSE_INPUT_ITEMS} items`,
    };
  }
  if (Array.isArray(payload.input) && !payload.input.every(isAllowedResponseInputItem)) {
    return { ok: false, message: "Responses input contains an unsupported item" };
  }
  const inputChars =
    typeof payload.input === "string" ? payload.input.length : JSON.stringify(payload.input).length;
  if (inputChars === 0 || inputChars > HONCHO_MAX_RESPONSE_INPUT_CHARS) {
    return {
      ok: false,
      message: `Responses input is limited to ${HONCHO_MAX_RESPONSE_INPUT_CHARS} characters`,
    };
  }
  if (
    payload.instructions !== undefined &&
    (typeof payload.instructions !== "string" ||
      payload.instructions.length > HONCHO_MAX_RESPONSE_INSTRUCTIONS_CHARS)
  ) {
    return {
      ok: false,
      message: `Responses instructions are limited to ${HONCHO_MAX_RESPONSE_INSTRUCTIONS_CHARS} characters`,
    };
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    return { ok: false, message: "Responses stream must be a boolean" };
  }
  if (payload.store !== undefined && typeof payload.store !== "boolean") {
    return { ok: false, message: "Responses store must be a boolean" };
  }
  if (
    payload.temperature !== undefined &&
    (typeof payload.temperature !== "number" ||
      !Number.isFinite(payload.temperature) ||
      payload.temperature < 0 ||
      payload.temperature > 2)
  ) {
    return { ok: false, message: "Responses temperature must be between 0 and 2" };
  }
  if (
    payload.max_output_tokens !== undefined &&
    (typeof payload.max_output_tokens !== "number" ||
      !Number.isInteger(payload.max_output_tokens) ||
      payload.max_output_tokens < 1 ||
      payload.max_output_tokens > 65_536)
  ) {
    return { ok: false, message: "Responses max_output_tokens must be between 1 and 65536" };
  }
  if (
    payload.tools !== undefined &&
    (!Array.isArray(payload.tools) ||
      payload.tools.length === 0 ||
      payload.tools.length > 64 ||
      !payload.tools.every(isFunctionTool))
  ) {
    return { ok: false, message: "Responses tools must contain only caller-defined functions" };
  }
  if (
    payload.include !== undefined &&
    (!Array.isArray(payload.include) ||
      payload.include.some((entry) => entry !== "reasoning.encrypted_content"))
  ) {
    return { ok: false, message: "Responses include contains an unsupported value" };
  }
  for (const [field, value] of [
    ["text", payload.text],
    ["reasoning", payload.reasoning],
  ] as const) {
    if (value !== undefined && !isRecord(value)) {
      return { ok: false, message: `Responses ${field} must be an object` };
    }
  }
  if (
    payload.parallel_tool_calls !== undefined &&
    typeof payload.parallel_tool_calls !== "boolean"
  ) {
    return { ok: false, message: "Responses parallel_tool_calls must be a boolean" };
  }
  if (payload.tool_choice !== undefined && !isAllowedToolChoice(payload.tool_choice)) {
    return { ok: false, message: "Responses tool_choice must select caller-defined functions" };
  }
  return { ok: true, value: { ...payload, input: normalizedInput, store: false } };
}

function upstreamHeaders(
  endpoint: BrokerEndpoint,
  credential: OpenAICodexBrokerCredential,
  stream: boolean,
): Headers {
  const headers = new Headers({
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${credential.accessToken}`,
    "content-type": "application/json",
    "user-agent": "openclaw-honcho-auth-broker",
  });
  if (endpoint === "responses") {
    const requestId = `honcho-${randomUUID()}`;
    headers.set("chatgpt-account-id", credential.accountId);
    headers.set("originator", "openclaw");
    headers.set("openai-beta", "responses=experimental");
    headers.set("session_id", requestId);
    headers.set("x-client-request-id", requestId);
  }
  return headers;
}

function copySafeUpstreamHeaders(upstream: Response, res: ServerResponse): void {
  const contentType = upstream.headers.get("content-type");
  setResponseHeaders(res, contentType || "application/octet-stream");
  for (const name of [
    "openai-processing-ms",
    "openai-version",
    "x-request-id",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

function safeRetryAfter(upstream: Response): string | undefined {
  const value = upstream.headers.get("retry-after");
  if (!value || !/^(?:0|[1-9]\d{0,4})$/.test(value) || Number(value) > 86_400) return undefined;
  return value;
}

async function streamUpstreamResponse(upstream: Response, res: ServerResponse): Promise<void> {
  res.statusCode = upstream.status;
  copySafeUpstreamHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as never), res);
}

function currentConfig(api: OpenClawPluginApi): OpenClawConfig {
  // The runtime snapshot is intentionally readonly to plugin callers, while
  // the canonical auth helpers retain a mutable config type for compatibility.
  // They only read this value, so keep the freshest snapshot and narrow that
  // type mismatch at this boundary.
  return (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
}

export async function resolveCanonicalOpenAICodexCredential(
  api: OpenClawPluginApi,
  config: HonchoAuthBrokerConfig,
  options: ResolveCodexCredentialOptions = {},
  dependencies: CanonicalCodexCredentialDependencies = canonicalCodexCredentialDependencies,
): Promise<OpenAICodexBrokerCredential> {
  try {
    if (!config.authAgentId || !config.authProfileId) {
      throw new BrokerCredentialUnavailableError();
    }
    if (options.profileId && options.profileId !== config.authProfileId) {
      throw new BrokerCredentialUnavailableError();
    }

    const cfg = currentConfig(api);
    const agentDir = dependencies.resolveAgentDir(cfg, config.authAgentId);
    const store = dependencies.loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    });
    const profileId = config.authProfileId;
    const storedProfile = store.profiles?.[profileId];
    if (
      storedProfile?.type !== "oauth" ||
      !dependencies.listProfilesForProvider(store, "openai").includes(profileId)
    ) {
      throw new BrokerCredentialUnavailableError();
    }

    const auth = await dependencies.resolveApiKeyForProvider({
      provider: "openai",
      cfg,
      agentDir,
      store,
      profileId,
      lockedProfile: true,
      forceRefresh: options.forceRefresh === true,
    });
    if (auth.mode !== "oauth" || !auth.apiKey || auth.profileId !== profileId) {
      throw new BrokerCredentialUnavailableError();
    }
    const accountId = dependencies.resolveOpenAICodexAuthIdentity({
      access: auth.apiKey,
      accountId: storedProfile.accountId,
    }).accountId;
    if (!accountId) throw new BrokerCredentialUnavailableError();
    return { accessToken: auth.apiKey, accountId, profileId };
  } catch {
    throw new BrokerCredentialUnavailableError();
  }
}

export async function resolveConfiguredBrokerBearerToken(
  pluginId: string,
  dependencies: BrokerBearerTokenDependencies = brokerBearerTokenDependencies,
): Promise<string | undefined> {
  const cfg = dependencies.getRuntimeConfigSourceSnapshot();
  if (!cfg) return undefined;
  const pluginEntry = cfg.plugins?.entries?.[pluginId];
  const pluginConfig = isRecord(pluginEntry?.config) ? pluginEntry.config : undefined;
  const authBroker = isRecord(pluginConfig?.authBroker) ? pluginConfig.authBroker : undefined;
  const configuredValue = authBroker?.bearerToken;

  // The host materializes SecretRefs before plugin manifest/runtime validation,
  // so the parsed plugin config legitimately contains a string. Authentication
  // must nevertheless be authorized from the canonical authored-source
  // snapshot on every request. A raw literal, shorthand, store ref, missing
  // snapshot, or disabled broker therefore fails closed before secret access.
  if (
    authBroker?.enabled !== true ||
    !isSecretRef(configuredValue) ||
    !["env", "file", "exec"].includes(configuredValue.source)
  ) {
    return undefined;
  }

  const resolved = await dependencies.resolveConfiguredSecretInputString({
    config: cfg,
    env: process.env,
    value: configuredValue,
    path: `plugins.entries.${pluginId}.config.authBroker.bearerToken`,
    unresolvedReasonStyle: "generic",
  });
  if (resolved.unresolvedRefReason) return undefined;
  const token = resolved.value?.trim();
  return token && token.length >= 32 ? token : undefined;
}

/** Cache SecretRef material briefly while allowing a newly rotated token through immediately. */
export function createConfiguredBrokerBearerTokenResolver(
  pluginId: string,
  dependencies: BrokerBearerTokenDependencies = brokerBearerTokenDependencies,
  options: BrokerBearerTokenResolverOptions = {},
): (presentedToken?: string) => Promise<string | undefined> {
  const cacheTtlMs = Math.max(1, options.cacheTtlMs ?? BROKER_BEARER_TOKEN_CACHE_TTL_MS);
  const now = options.now ?? Date.now;
  let cachedToken: string | undefined;
  let cacheExpiresAt = 0;
  let inFlight: Promise<string | undefined> | undefined;

  return async (presentedToken?: string): Promise<string | undefined> => {
    if (
      cachedToken &&
      now() < cacheExpiresAt &&
      (!presentedToken || safeEqualSecret(cachedToken, presentedToken))
    ) {
      return cachedToken;
    }

    if (!inFlight) {
      // A cache miss can mean expiry, configuration disablement, or rotation.
      // Invalidate before resolving so a failed refresh never revives stale
      // material for another request.
      cachedToken = undefined;
      cacheExpiresAt = 0;
      const pending = resolveConfiguredBrokerBearerToken(pluginId, dependencies);
      inFlight = pending;
      const clearInFlight = () => {
        if (inFlight === pending) inFlight = undefined;
      };
      void pending.then(clearInFlight, clearInFlight);
    }

    const resolved = await inFlight;
    if (resolved) {
      cachedToken = resolved;
      cacheExpiresAt = now() + cacheTtlMs;
    }
    return resolved;
  };
}

/** Build the prefix-route handler. Exported for focused loopback tests. */
export function createHonchoAuthBrokerHandler(
  config: HonchoAuthBrokerConfig,
  dependencies: HonchoAuthBrokerDependencies,
) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const rateLimiter = createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS);
  const inFlightLimiter = createWebhookInFlightLimiter({
    ...WEBHOOK_IN_FLIGHT_DEFAULTS,
    maxInFlightPerKey: HONCHO_MAX_IN_FLIGHT_PER_CLIENT,
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const endpoint = resolveEndpoint(req);
    if (!endpoint) return false;

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      respondJson(res, 405, "method_not_allowed", "Only POST is supported");
      return true;
    }

    const clientKey = `${endpoint}:${req.socket?.remoteAddress ?? "unknown"}`;
    if (rateLimiter.isRateLimited(clientKey)) {
      respondJson(res, 429, "rate_limited", "Too many broker requests");
      return true;
    }

    const presentedToken = readBearerToken(req);
    if (!presentedToken) {
      res.setHeader("www-authenticate", 'Bearer realm="openclaw-honcho-auth-broker"');
      respondJson(res, 401, "unauthorized", "Bearer authentication failed");
      return true;
    }

    let expectedToken: string | undefined;
    try {
      expectedToken = await dependencies.resolveBearerToken(presentedToken);
    } catch {
      dependencies.logger?.warn("Honcho auth broker could not resolve its bearer token");
      respondJson(
        res,
        503,
        "broker_auth_unavailable",
        "Honcho auth broker authentication is unavailable",
      );
      return true;
    }
    if (!expectedToken || !safeEqualSecret(expectedToken, presentedToken)) {
      res.setHeader("www-authenticate", 'Bearer realm="openclaw-honcho-auth-broker"');
      respondJson(res, 401, "unauthorized", "Bearer authentication failed");
      return true;
    }

    if (!isJsonContentType(req)) {
      respondJson(res, 415, "unsupported_media_type", "Content-Type must be application/json");
      return true;
    }

    if (!inFlightLimiter.tryAcquire(clientKey)) {
      respondJson(res, 429, "too_many_in_flight", "Too many concurrent broker requests");
      return true;
    }

    try {
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: config.maxRequestBytes,
        timeoutMs: Math.min(config.timeoutMs, 30_000),
        invalidJsonMessage: "Request body must be valid JSON",
      });
      if (!body.ok) return true;
      if (!isRecord(body.value)) {
        respondJson(res, 400, "invalid_request", "Request body must be a JSON object");
        return true;
      }

      let embeddingPayload: Record<string, unknown> | undefined;
      let responsePayload: Record<string, unknown> | undefined;
      if (endpoint === "embeddings") {
        const validation = validateEmbeddingPayload(body.value);
        if (validation.ok === false) {
          respondJson(res, 400, "invalid_request", validation.message);
          return true;
        }
        embeddingPayload = validation.value;
      } else {
        const validation = validateResponsePayload(body.value, config.responseModels);
        if (validation.ok === false) {
          respondJson(res, 400, "invalid_request", validation.message);
          return true;
        }
        responsePayload = validation.value;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);

      try {
        let credential: OpenAICodexBrokerCredential;
        try {
          credential = await dependencies.resolveCredential();
        } catch {
          dependencies.logger?.warn("Honcho auth broker could not resolve OpenAI Codex OAuth");
          respondJson(
            res,
            503,
            "oauth_unavailable",
            "OpenAI Codex OAuth is unavailable; renew the OpenClaw login and retry",
          );
          return true;
        }

        const payload =
          endpoint === "embeddings" ? (embeddingPayload ?? {}) : (responsePayload ?? {});
        const stream = endpoint === "responses" && payload.stream === true;
        const upstreamUrl =
          endpoint === "embeddings" ? EMBEDDINGS_UPSTREAM_URL : CODEX_RESPONSES_UPSTREAM_URL;
        const requestUpstream = async (selected: OpenAICodexBrokerCredential) =>
          await fetchImpl(upstreamUrl, {
            method: "POST",
            headers: upstreamHeaders(endpoint, selected, stream),
            body: JSON.stringify(payload),
            redirect: "error",
            signal: controller.signal,
          });

        let upstream = await requestUpstream(credential);
        if (upstream.status === 401) {
          await discardResponseBody(upstream);
          try {
            const replacement = await dependencies.resolveCredential({
              forceRefresh: true,
              profileId: credential.profileId,
            });
            if (
              replacement.accountId === credential.accountId &&
              !safeEqualSecret(replacement.accessToken, credential.accessToken)
            ) {
              credential = replacement;
              upstream = await requestUpstream(credential);
            }
          } catch {
            // The generic rejected-credential response below is intentionally
            // the only externally visible result of a refresh-read failure.
          }
        }
        if (upstream.status === 401 || upstream.status === 403) {
          await discardResponseBody(upstream);
          dependencies.logger?.warn(
            `Honcho auth broker upstream rejected OpenAI OAuth (${upstream.status})`,
          );
          respondJson(
            res,
            503,
            "oauth_rejected",
            "OpenAI rejected the current OAuth credential; renew the OpenClaw login and retry",
          );
          return true;
        }
        if (upstream.status === 429) {
          const retryAfter = safeRetryAfter(upstream);
          await discardResponseBody(upstream);
          if (retryAfter) res.setHeader("retry-after", retryAfter);
          respondJson(
            res,
            429,
            "upstream_rate_limited",
            "OpenAI upstream rate limit exceeded; retry later",
          );
          return true;
        }
        if (!upstream.ok) {
          await discardResponseBody(upstream);
          respondJson(res, 502, "upstream_error", "OpenAI upstream request failed");
          return true;
        }
        await streamUpstreamResponse(upstream, res);
        return true;
      } catch {
        if (!res.headersSent && !res.writableEnded) {
          respondJson(
            res,
            controller.signal.aborted ? 504 : 502,
            controller.signal.aborted ? "upstream_timeout" : "upstream_unavailable",
            controller.signal.aborted
              ? "OpenAI upstream request timed out"
              : "OpenAI upstream request failed",
          );
        }
        return true;
      } finally {
        clearTimeout(timeout);
        req.off("aborted", abort);
        res.off("close", abort);
      }
    } finally {
      inFlightLimiter.release(clientKey);
    }
  };
}

/** Register the broker only when explicitly enabled. */
export function registerHonchoAuthBroker(
  api: OpenClawPluginApi,
  config: HonchoAuthBrokerConfig,
): void {
  if (!config.enabled) return;
  const resolveBearerToken = createConfiguredBrokerBearerTokenResolver(api.id);
  api.registerHttpRoute({
    path: HONCHO_AUTH_BROKER_BASE_PATH,
    auth: "plugin",
    match: "prefix",
    handler: createHonchoAuthBrokerHandler(config, {
      resolveBearerToken,
      resolveCredential: (options) => resolveCanonicalOpenAICodexCredential(api, config, options),
      logger: api.logger,
    }),
  });
}
