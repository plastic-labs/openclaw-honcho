import { describe, expect, it } from "vitest";
import { isManagedHonchoCloud } from "../state.js";

describe("isManagedHonchoCloud", () => {
  it("recognizes the managed cloud host", () => {
    expect(isManagedHonchoCloud("https://api.honcho.dev")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isManagedHonchoCloud("https://API.HONCHO.DEV")).toBe(true);
  });

  it("treats custom self-hosted domains as not cloud", () => {
    expect(isManagedHonchoCloud("https://honcho.example.com")).toBe(false);
  });

  it("does not match look-alike domains", () => {
    expect(isManagedHonchoCloud("https://honcho.dev.evil.com")).toBe(false);
  });
});
