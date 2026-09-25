import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGatewayHook } from "../hooks/gateway.js";
import type { PluginState } from "../state.js";

/** Run gateway_start against a mutable runtime config and return its observable effects. */
async function fireGatewayStart(config: Record<string, unknown>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let currentConfig = structuredClone(config);
  const mutateConfigFile = vi.fn(async (params: { mutate: (draft: Record<string, unknown>) => unknown }) => {
    const draft = structuredClone(currentConfig);
    const result = await params.mutate(draft);
    currentConfig = draft;
    return { nextConfig: currentConfig, result };
  });
  const api = {
    logger,
    on: vi.fn((_name: string, fn: never) => {
      handler = fn;
    }),
    runtime: {
      config: {
        current: () => currentConfig,
        mutateConfigFile,
      },
    },
  };
  const state = {
    ensureInitialized: vi.fn(async () => {}),
    peersPersister: { filePath: "/dev/null", peers: {} },
    cfg: { baseUrl: "https://api.honcho.dev" },
  } as unknown as PluginState;

  registerGatewayHook(api as never, state);
  await handler!({}, {});
  return { currentConfig, logger, mutateConfigFile };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gateway_start", () => {
  it("warns about missing conversation access without changing config", async () => {
    const config = { plugins: { entries: { "openclaw-honcho": {} } } };

    const { currentConfig, logger, mutateConfigFile } = await fireGatewayStart(config);

    expect(currentConfig).toEqual(config);
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain("allowConversationAccess");
  });

  it("stays quiet when the operator has already granted conversation access", async () => {
    const { logger, mutateConfigFile } = await fireGatewayStart({
      plugins: { entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } } },
    });

    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("clears only the legacy Honcho memory slot and lets memory-core resume", async () => {
    const { currentConfig, logger, mutateConfigFile } = await fireGatewayStart({
      plugins: {
        entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } },
        slots: { memory: "openclaw-honcho", contextEngine: "legacy" },
      },
    });

    expect(mutateConfigFile).toHaveBeenCalledOnce();
    expect(currentConfig).toEqual({
      plugins: {
        entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } },
        slots: { contextEngine: "legacy" },
      },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("memory-core"));
  });

  it("preserves a user-selected alternate memory plugin", async () => {
    const { currentConfig, logger, mutateConfigFile } = await fireGatewayStart({
      plugins: {
        entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } },
        slots: { memory: "memory-lancedb" },
      },
    });

    expect(currentConfig).toEqual({
      plugins: {
        entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } },
        slots: { memory: "memory-lancedb" },
      },
    });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
