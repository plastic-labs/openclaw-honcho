import { describe, expect, it } from "vitest";
import { isLocalHonchoBaseUrl } from "../state.js";

describe("isLocalHonchoBaseUrl", () => {
  it("treats localhost, private LAN, and tailnet addresses as self-hosted", () => {
    expect(isLocalHonchoBaseUrl("http://localhost:8000")).toBe(true);
    expect(isLocalHonchoBaseUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalHonchoBaseUrl("http://10.0.0.2:8000")).toBe(true);
    expect(isLocalHonchoBaseUrl("http://172.16.0.2:8000")).toBe(true);
    expect(isLocalHonchoBaseUrl("http://192.168.1.2:8000")).toBe(true);
    expect(isLocalHonchoBaseUrl("http://100.64.0.2:8000")).toBe(true);
  });

  it("does not classify public Honcho URLs as self-hosted", () => {
    expect(isLocalHonchoBaseUrl("https://api.honcho.dev")).toBe(false);
    expect(isLocalHonchoBaseUrl("https://8.8.8.8")).toBe(false);
  });
});
