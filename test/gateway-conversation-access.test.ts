import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGatewayHook } from "../hooks/gateway.js";
import type { PluginState } from "../state.js";

let dir: string;
let configPath: string;
const prevEnv = process.env.OPENCLAW_CONFIG_PATH;

function writeConfig(config: unknown): string {
  const text = JSON.stringify(config, null, 2);
  writeFileSync(configPath, text);
  return text;
}

/** Run the gateway_start handler and return the logger it was given. */
async function fireGatewayStart() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const api = { logger, on: vi.fn((_name: string, fn: never) => { handler = fn; }) };
  const state = {
    ensureInitialized: vi.fn(async () => {}),
    peersPersister: { filePath: "/dev/null", peers: {} },
    cfg: { baseUrl: "https://api.honcho.dev" },
  } as unknown as PluginState;

  registerGatewayHook(api as never, state);
  await handler!({}, {});
  return logger;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honcho-gateway-"));
  configPath = join(dir, "openclaw.json");
  process.env.OPENCLAW_CONFIG_PATH = dir;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevEnv === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("gateway_start and allowConversationAccess", () => {
  it("warns but never writes the flag into the user's config", async () => {
    const before = writeConfig({ plugins: { entries: { "openclaw-honcho": {} } } });

    const logger = await fireGatewayStart();

    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain("allowConversationAccess");
  });

  it("stays quiet when the operator has already granted access", async () => {
    writeConfig({
      plugins: { entries: { "openclaw-honcho": { hooks: { allowConversationAccess: true } } } },
    });

    const logger = await fireGatewayStart();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
