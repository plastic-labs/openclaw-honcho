import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHonchoClient, getHostVersion, telemetryIdentity } from "../honcho-client.js";
import { formatAgentModel, registerTelemetryHook } from "../hooks/telemetry.js";
import type { PluginState } from "../state.js";

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }
).version;

it("sends host and plugin headers on every request", async () => {
  const seen: Headers[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers as HeadersInit));
    return new Response(
      JSON.stringify({ id: "x", metadata: {}, configuration: {}, created_at: new Date().toISOString(), is_active: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  try {
    const honcho = createHonchoClient({
      apiKey: "k",
      baseUrl: "https://api.honcho.dev",
      workspaceId: "telemetry-test",
    });
    await honcho.peer("owner");
    await honcho.session("s");

    expect(seen.length).toBeGreaterThan(1);
    for (const headers of seen) {
      // The version is present because the plugin resolves the openclaw peer
      // dependency it is actually loaded against.
      expect(headers.get("X-Honcho-Host")).toBe(`openclaw/${getHostVersion()} (${process.platform})`);
      expect(headers.get("X-Honcho-Plugin")).toBe(`openclaw-honcho/${pkgVersion}`);
      // Not wired yet, and the legacy designs must never appear.
      expect(headers.get("X-Honcho-Agent-Model")).toBeNull();
      expect(headers.get("X-Honcho-Runtime")).toBeNull();
      expect(headers.get("X-Honcho-Client")).toBeNull();
    }

    // Drive the real hook: a turn on model A, then a switch to B.
    const state = { honcho } as unknown as PluginState;
    let llmOutput: ((e: unknown) => Promise<void>) | undefined;
    registerTelemetryHook(
      { on: (n: string, fn: never) => { if (n === "llm_output") llmOutput = fn; },
        logger: { debug: () => {} } } as never,
      state,
    );

    await llmOutput?.({ provider: "openrouter", model: "anthropic/claude-sonnet-5", resolvedRef: "openrouter/anthropic/claude-sonnet-5" });
    await honcho.peer("owner");
    expect(seen.at(-1)?.get("X-Honcho-Agent-Model")).toBe("openrouter/anthropic/claude-sonnet-5");

    await llmOutput?.({ provider: "openrouter", model: "openai/gpt-5.6-sol", resolvedRef: "openrouter/openai/gpt-5.6-sol" });
    await honcho.peer("owner");
    expect(seen.at(-1)?.get("X-Honcho-Agent-Model")).toBe("openrouter/openai/gpt-5.6-sol");

    // Host and plugin survive the refresh.
    expect(seen.at(-1)?.get("X-Honcho-Host")).toBe(`openclaw/${getHostVersion()} (${process.platform})`);
    expect(seen.at(-1)?.get("X-Honcho-Plugin")).toBe(`openclaw-honcho/${pkgVersion}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("reads both versions at runtime rather than from a constant", () => {
  const id = telemetryIdentity();
  expect(id.pluginVersion).toBe(pkgVersion);
  expect(id.pluginVersion).not.toBe("unknown");
  // Resolved from the running openclaw install, not pinned in source.
  expect(id.hostVersion).toBe(getHostVersion());
  expect(id.hostVersion).toMatch(/^\d{4}\./);
});

it("prefers resolvedRef, which keeps the provider an aggregated model id drops", () => {
  // Under openrouter, `model` is itself `anthropic/claude-sonnet-5`, so joining
  // provider+model by hand is not the runtime's own ref.
  expect(formatAgentModel({ provider: "openrouter", model: "anthropic/claude-sonnet-5", resolvedRef: "openrouter/anthropic/claude-sonnet-5" }))
    .toBe("openrouter/anthropic/claude-sonnet-5");
  expect(formatAgentModel({ provider: "openai", model: "gpt-5.6-sol" })).toBe("openai/gpt-5.6-sol");
  expect(formatAgentModel({ model: "bare" })).toBe("bare");
  expect(formatAgentModel({})).toBeUndefined();
});
