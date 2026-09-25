import { describe, expect, it, vi } from "vitest";
import honchoPlugin, { buildPromptSection, registerHonchoTools } from "../index.js";
import type { PluginState } from "../state.js";

function registeredNames(enableMemoryCompatibilityTools: boolean): string[] {
  const registrations: string[] = [];
  const api = {
    registerTool: vi.fn((_factory: unknown, options?: { name?: string }) => {
      if (options?.name) registrations.push(options.name);
    }),
  };
  const state = {
    cfg: { enableMemoryCompatibilityTools },
  } as unknown as PluginState;

  registerHonchoTools(api as never, state);
  return registrations;
}

describe("Honcho tool registration", () => {
  it("registers only the five named Honcho tools by default", () => {
    expect(registeredNames(false)).toEqual([
      "honcho_session",
      "honcho_context",
      "honcho_search_conclusions",
      "honcho_ask",
      "honcho_search_messages",
    ]);
  });

  it("registers legacy memory aliases only when explicitly enabled", () => {
    expect(registeredNames(true)).toEqual([
      "honcho_session",
      "honcho_context",
      "honcho_search_conclusions",
      "honcho_ask",
      "honcho_search_messages",
      "memory_search",
      "memory_get",
    ]);
  });
});

describe("plugin entry", () => {
  it("attaches beside the memory slot owner instead of taking the slot", () => {
    const api = {
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      registerMemoryCapability: vi.fn(),
      registerMemoryPromptSupplement: vi.fn(),
    };

    expect(honchoPlugin.kind).toBeUndefined();
    honchoPlugin.register(api as never);
    expect(api.registerMemoryPromptSupplement).toHaveBeenCalledWith(buildPromptSection);
    expect(api.registerMemoryCapability).not.toHaveBeenCalled();
  });
});
