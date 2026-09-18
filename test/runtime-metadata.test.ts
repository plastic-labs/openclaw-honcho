import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Passing metadata to session() replaces what is persisted, wiping the capture
 * watermark (#137). capture.ts and context.ts already avoid it; this guards the
 * remaining call sites so the trap cannot be reintroduced anywhere.
 */
describe("no session() call clobbers persisted metadata", () => {
  it("passes metadata in no plugin source file", () => {
    const files = [
      "runtime.ts",
      "hooks/context.ts",
      "hooks/capture.ts",
      "tools/session.ts",
      "state.ts",
    ];
    const offenders = files.filter((f) =>
      /honcho\.session\([^)]*metadata/s.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
