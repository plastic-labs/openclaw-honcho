import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repairContextEngineSlotFile, stripContextEngineSlot } from "../slot-repair.js";

describe("stripContextEngineSlot", () => {
  it("removes a contextEngine pin that points at this plugin and keeps the memory slot", () => {
    const { config, changed } = stripContextEngineSlot({
      plugins: { slots: { memory: "openclaw-honcho", contextEngine: "openclaw-honcho" }, entries: {} },
    });
    expect(changed).toBe(true);
    expect(config.plugins.slots).toEqual({ memory: "openclaw-honcho" });
    expect(config.plugins.entries).toEqual({});
  });

  it("drops the slots object entirely when the pin was its only key", () => {
    const { config, changed } = stripContextEngineSlot({
      plugins: { slots: { contextEngine: "openclaw-honcho" } },
    });
    expect(changed).toBe(true);
    expect(config.plugins).not.toHaveProperty("slots");
  });

  it("leaves a contextEngine pin for another plugin alone", () => {
    const input = { plugins: { slots: { contextEngine: "lossless-claw", memory: "memory-core" } } };
    const { config, changed } = stripContextEngineSlot(input);
    expect(changed).toBe(false);
    expect(config).toBe(input);
  });

  it("is a no-op when there are no slots", () => {
    expect(stripContextEngineSlot({}).changed).toBe(false);
    expect(stripContextEngineSlot({ plugins: {} }).changed).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = { plugins: { slots: { memory: "memory-core", contextEngine: "openclaw-honcho" } } };
    stripContextEngineSlot(input);
    expect(input.plugins.slots.contextEngine).toBe("openclaw-honcho");
  });
});

describe("repairContextEngineSlotFile", () => {
  it("rewrites the file and logs once when a pin is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "honcho-slot-"));
    const file = join(dir, "openclaw.json");
    writeFileSync(
      file,
      JSON.stringify({ plugins: { slots: { memory: "memory-core", contextEngine: "openclaw-honcho" } } }),
    );
    const warnings: string[] = [];
    expect(repairContextEngineSlotFile(file, { warn: (m) => warnings.push(m) })).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).plugins.slots).toEqual({ memory: "memory-core" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("plugins.slots.contextEngine");
  });

  it("returns false and stays quiet when nothing needs repair or the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "honcho-slot-"));
    const file = join(dir, "openclaw.json");
    writeFileSync(file, JSON.stringify({ plugins: { slots: { memory: "openclaw-honcho" } } }));
    const warnings: string[] = [];
    expect(repairContextEngineSlotFile(file, { warn: (m) => warnings.push(m) })).toBe(false);
    expect(repairContextEngineSlotFile(join(dir, "missing.json"), { warn: (m) => warnings.push(m) })).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});
