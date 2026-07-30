import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSubagentHooks, subagentParentMap } from "../hooks/subagent.js";

describe("subagent hooks", () => {
  beforeEach(() => {
    subagentParentMap.clear();
  });

  it("derives the parent agent from the requester session key", () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => void>();
    const api = {
      on: vi.fn((name: string, handler: (event: unknown, ctx: any) => void) => {
        handlers.set(name, handler);
      }),
    };

    registerSubagentHooks(api as never);

    expect(api.on).toHaveBeenCalledTimes(1);
    expect(api.on).toHaveBeenCalledWith("subagent_spawned", expect.any(Function));

    handlers.get("subagent_spawned")?.({}, {
      childSessionKey: "agent:research:subagent:child",
      requesterSessionKey: "agent:planner:main",
    });

    expect(subagentParentMap.get("agent:research:subagent:child")).toBe("planner");
  });

  it("ignores requester keys that do not identify an agent", () => {
    let handler: ((event: unknown, ctx: any) => void) | undefined;
    const api = {
      on: vi.fn((_name: string, registered: (event: unknown, ctx: any) => void) => {
        handler = registered;
      }),
    };

    registerSubagentHooks(api as never);
    handler?.({}, {
      childSessionKey: "agent:research:subagent:child",
      requesterSessionKey: "opaque-session",
    });

    expect(subagentParentMap).toEqual(new Map());
  });
});
