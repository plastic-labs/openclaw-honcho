import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES,
  DEFAULT_AUTH_BROKER_RESPONSE_MODELS,
  DEFAULT_AUTH_BROKER_TIMEOUT_MS,
  honchoConfigSchema,
} from "../config.js";

const previousEnvToken = process.env.HONCHO_AUTH_BROKER_TOKEN;
const bearerToken = {
  source: "env" as const,
  provider: "default",
  id: "HONCHO_AUTH_BROKER_TOKEN",
};
const requiredAuthScope = {
  authAgentId: "main",
  authProfileId: "openai:owner@example.com",
};

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
      authProfileId: undefined,
      responseModels: DEFAULT_AUTH_BROKER_RESPONSE_MODELS,
      maxRequestBytes: DEFAULT_AUTH_BROKER_MAX_REQUEST_BYTES,
      timeoutMs: DEFAULT_AUTH_BROKER_TIMEOUT_MS,
    });
  });

  it("requires an explicit SecretRef, agent, and profile without ambient fallback", () => {
    process.env.HONCHO_AUTH_BROKER_TOKEN =
      "ambient-broker-token-that-must-never-be-used";
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: { enabled: true, ...requiredAuthScope },
      }),
    ).toThrow(/requires an explicit authBroker\.bearerToken SecretRef/);
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken,
          authProfileId: requiredAuthScope.authProfileId,
        },
      }),
    ).toThrow(/requires an explicit authBroker\.authAgentId/);
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken,
          authAgentId: requiredAuthScope.authAgentId,
        },
      }),
    ).toThrow(/requires an explicit authBroker\.authProfileId/);
  });

  it("accepts the strong bearer string produced by host SecretRef resolution", () => {
    const resolvedToken = "broker-test-token-that-is-at-least-32-characters";
    const parsed = honchoConfigSchema.parse({
      authBroker: {
        enabled: true,
        bearerToken: resolvedToken,
        ...requiredAuthScope,
      },
    });

    expect(parsed.authBroker.bearerToken).toBe(resolvedToken);
  });

  it("rejects strings that cannot be strong host-resolved bearer values", () => {
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken: "${BROKER_TOKEN}",
          ...requiredAuthScope,
        },
      }),
    ).toThrow(/host-resolved string of at least 32 characters/);
  });

  it("rejects malformed explicit OAuth profile IDs", () => {
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken,
          authAgentId: "main",
          authProfileId: "openai:owner profile",
        },
      }),
    ).toThrow(/invalid profile ID/);
  });

  it("accepts an OpenClaw SecretRef without resolving it in plugin code", () => {
    const parsed = honchoConfigSchema.parse({
      authBroker: {
        enabled: true,
        bearerToken,
        authAgentId: "atlas",
        authProfileId: "openai:owner@example.com",
        responseModels: ["gpt-5.4-mini"],
        maxRequestBytes: 8192,
        timeoutMs: 12_000,
      },
    });
    expect(parsed.authBroker).toEqual({
      enabled: true,
      bearerToken,
      authAgentId: "atlas",
      authProfileId: "openai:owner@example.com",
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
          ...requiredAuthScope,
        },
      }),
    ).toThrow(/must be an env, file, or exec OpenClaw SecretRef/);
  });

  it("rejects invalid or duplicate Responses model allowlists", () => {
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken,
          ...requiredAuthScope,
          responseModels: ["gpt-5.4", "../unexpected"],
        },
      }),
    ).toThrow(/invalid model ID/);
    expect(() =>
      honchoConfigSchema.parse({
        authBroker: {
          enabled: true,
          bearerToken,
          ...requiredAuthScope,
          responseModels: ["gpt-5.4", "gpt-5.4"],
        },
      }),
    ).toThrow(/duplicate model IDs/);
  });
});
