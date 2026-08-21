import { describe, expect, it, vi } from "vitest";
import { registerHonchoTools } from "../index.js";
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
