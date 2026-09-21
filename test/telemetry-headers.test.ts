import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHonchoClient, getHostVersion, telemetryIdentity } from "../honcho-client.js";

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
