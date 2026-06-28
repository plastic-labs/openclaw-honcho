import { describe, expect, it } from "vitest";
import { isManagedHonchoCloud } from "../state.js";

describe("isManagedHonchoCloud", () => {
  it("treats the honcho.dev cloud apex and subdomains as managed cloud", () => {
    expect(isManagedHonchoCloud("https://api.honcho.dev")).toBe(true);
    expect(isManagedHonchoCloud("https://honcho.dev")).toBe(true);
    expect(isManagedHonchoCloud("https://api.honcho.dev/")).toBe(true);
    expect(isManagedHonchoCloud("https://eu.api.honcho.dev")).toBe(true);
    expect(isManagedHonchoCloud("https://API.HONCHO.DEV")).toBe(true);
  });

  it("treats an empty/unset base URL as cloud (matches config default)", () => {
    expect(isManagedHonchoCloud(undefined)).toBe(true);
    expect(isManagedHonchoCloud("")).toBe(true);
    expect(isManagedHonchoCloud("   ")).toBe(true);
  });

  it("treats localhost and custom self-hosted domains as self-hosted", () => {
    expect(isManagedHonchoCloud("http://localhost:8000")).toBe(false);
    expect(isManagedHonchoCloud("http://127.0.0.1:8000")).toBe(false);
    expect(isManagedHonchoCloud("http://[::1]:8000")).toBe(false);
    expect(isManagedHonchoCloud("https://api.honcho.example.com")).toBe(false);
    expect(isManagedHonchoCloud("https://honcho.mycompany.internal")).toBe(false);
  });

  it("does not match look-alike domains that merely contain honcho.dev", () => {
    expect(isManagedHonchoCloud("https://honcho.dev.evil.com")).toBe(false);
    expect(isManagedHonchoCloud("https://nothoncho.dev")).toBe(false);
  });

  it("returns false for unparseable base URLs", () => {
    expect(isManagedHonchoCloud("not a url")).toBe(false);
  });
});
