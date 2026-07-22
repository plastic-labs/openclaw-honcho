import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureHonchoCapturePermission } from "../commands/cli.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("isolated OpenClaw loader permission", () => {
  it("registers agent_end when the documented entry-level permission is present", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-honcho-loader-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const configPath = join(root, "openclaw.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const port = 20000 + (process.pid % 10000);
    const generatedConfig = ensureHonchoCapturePermission({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: "isolated-loader-only-token" },
      },
      agents: { defaults: { workspace } },
      plugins: {
        enabled: true,
        allow: ["openclaw-honcho"],
        slots: { memory: "openclaw-honcho" },
        load: { paths: [resolve(process.cwd())] },
        entries: {
          "openclaw-honcho": {
            enabled: true,
            config: {
              baseUrl: "http://127.0.0.1:9",
              workspaceId: "isolated-loader",
            },
          },
        },
      },
    }).config;
    writeFileSync(configPath, JSON.stringify(generatedConfig, null, 2));

    const openclawBin = process.env.OPENCLAW_BIN ?? process.env.PATH
      ?.split(":")
      .map((dir) => join(dir, "openclaw"))
      .find((candidate) => !candidate.includes("/node_modules/.bin/") && existsSync(candidate));
    expect(openclawBin, "OPENCLAW_BIN or a non-project OpenClaw CLI is required").toBeTruthy();
    const isolatedEnv = { ...process.env };
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith("VITEST")) delete isolatedEnv[key];
    }
    delete isolatedEnv.NODE_OPTIONS;
    isolatedEnv.NODE_ENV = "production";
    const version = spawnSync(openclawBin!, ["--version"], {
      encoding: "utf8",
      env: isolatedEnv,
      timeout: 10_000,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain("2026.7.1-2");
    const result = spawnSync(openclawBin!, [
      "plugins", "inspect", "openclaw-honcho", "--runtime", "--json",
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...isolatedEnv,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_SKIP_CHANNELS: "1",
        HONCHO_API_KEY: "",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout.trim(), `bin: ${openclawBin}\nstderr: ${result.stderr}`).not.toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.plugin).toMatchObject({ id: "openclaw-honcho", status: "loaded" });
    expect(output.workspaceDir).toBe(workspace);
    expect(output.plugin.rootDir).toBe(resolve(process.cwd()));
    expect(output.plugin.source).not.toContain("/.openclaw/npm/");
    expect(output.typedHooks.map((hook: { name: string }) => hook.name)).toContain("agent_end");
    expect(output.policy).toMatchObject({ allowConversationAccess: true });
    expect(JSON.stringify(output.diagnostics ?? [])).not.toContain("agent_end\" blocked");
    expect(JSON.stringify(output.diagnostics ?? [])).not.toContain("allowConversationAccess=true");
  }, 40_000);
});
