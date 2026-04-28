import { describe, it, expect } from "vitest";
import { validateGalaxyUrl } from "../extensions/loom/profiles";

describe("validateGalaxyUrl", () => {
  it("accepts https://", () => {
    expect(validateGalaxyUrl("https://usegalaxy.org").ok).toBe(true);
    expect(validateGalaxyUrl("https://test.galaxyproject.org/").ok).toBe(true);
  });

  it("accepts http://localhost (local dev)", () => {
    expect(validateGalaxyUrl("http://localhost:8080").ok).toBe(true);
    expect(validateGalaxyUrl("http://127.0.0.1:8080").ok).toBe(true);
  });

  it("rejects http:// for non-loopback hosts", () => {
    const r = validateGalaxyUrl("http://usegalaxy.org");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/);
  });

  it("rejects malformed URLs", () => {
    expect(validateGalaxyUrl("not a url").ok).toBe(false);
    expect(validateGalaxyUrl("").ok).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    expect(validateGalaxyUrl("ftp://galaxy.example.com").ok).toBe(false);
    expect(validateGalaxyUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("trims whitespace before validating", () => {
    expect(validateGalaxyUrl("  https://x.galaxyproject.org  ").ok).toBe(true);
  });
});
