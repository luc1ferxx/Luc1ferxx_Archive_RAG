import { describe, expect, it } from "vitest";
import { resolveApiDomain } from "./config";

describe("resolveApiDomain", () => {
  it("uses the configured API origin, or the local backend when unset", () => {
    expect(resolveApiDomain("https://api.example.test")).toBe("https://api.example.test");
    expect(resolveApiDomain(undefined)).toBe("http://localhost:5001");
    expect(resolveApiDomain("")).toBe("http://localhost:5001");
  });

  it("calls relative paths on the serving origin in the single-container build", () => {
    expect(resolveApiDomain("same-origin")).toBe("");
  });
});
