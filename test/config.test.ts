import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES,
  DEFAULT_AUTH_BROKER_RESPONSE_MODELS,
  DEFAULT_AUTH_BROKER_TIMEOUT_MS,
  honchoConfigSchema,
} from "../config.js";

const previousEnvToken = process.env.HONCHO_AUTH_BROKER_TOKEN;

afterEach(() => {
  if (previousEnvToken === undefined) {
    delete process.env.HONCHO_AUTH_BROKER_TOKEN;
  } else {
    process.env.HONCHO_AUTH_BROKER_TOKEN = previousEnvToken;
  }
});

describe("Honcho auth broker config", () => {
  it("is disabled by default with bounded defaults", () => {
    delete process.env.HONCHO_AUTH_BROKER_TOKEN;
    const parsed = honchoConfigSchema.parse({});
    expect(parsed.authBroker).toEqual({
      enabled: false,
      bearerToken: undefined,
      authAgentId: undefined,
      responseModels: DEFAULT_AUTH_BROKER_RESPONSE_MODELS,
      maxRequestBytes: DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES,
      timeoutMs: DEFAULT_AUTH_BROKER_TIMEOUT_MS,
    });
  });

  it("requires a strong literal bearer token when enabled", () => {
    delete process.env.HONCHO_AUTH_BROKER_TOKEN;
    expect(() => honchoConfigSchema.parse({ authBroker: { enabled: true } })).toThrow(
      /requires authBroker\.bearerToken/,
    );
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: { enabled: true, bearerToken: "too-short" },
      }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: { enabled: true, bearerToken: "${BROKER_TOKEN}" },
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("accepts an OpenClaw SecretRef without resolving it in plugin code", () => {
    const bearerToken = {
      source: "env" as const,
      provider: "default",
      id: "HONCHO_AUTH_BROKER_TOKEN",
    };
    const parsed = honchoConfigSchema.parse({
      authBroker: {
        enabled: true,
        bearerToken,
        authAgentId: "atlas",
        responseModels: ["gpt-5.4-mini"],
        maxRequestBytes: 8192,
        timeoutMs: 12_000,
      },
    });
    expect(parsed.authBroker).toEqual({
      enabled: true,
      bearerToken,
      authAgentId: "atlas",
      responseModels: ["gpt-5.4-mini"],
      maxRequestBytes: 8192,
      timeoutMs: 12_000,
    });
  });

  it("rejects unsupported SecretRef sources at the declared SDK minimum", () => {
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken: {
            source: "store",
            provider: "default",
            id: "HONCHO_AUTH_BROKER_TOKEN",
          },
        },
      }),
    ).toThrow(/source must be env, file, or exec for OpenClaw 2026\.7\.1 compatibility/);
  });

  it("rejects invalid or duplicate Responses model allowlists", () => {
    process.env.HONCHO_AUTH_BROKER_TOKEN = "broker-test-token-that-is-at-least-32-characters";
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: { enabled: true, responseModels: ["gpt-5.4", "../unexpected"] },
      }),
    ).toThrow(/invalid model ID/);
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: { enabled: true, responseModels: ["gpt-5.4", "gpt-5.4"] },
      }),
    ).toThrow(/duplicate model IDs/);
  });
});
