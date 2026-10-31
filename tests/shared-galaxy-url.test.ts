import { describe, expect, it } from "vitest";
import { normalizeGalaxyUrl } from "../shared/galaxy-url.js";
import { normalizeGalaxyUrl as appNormalize } from "../app/src/main/galaxy-url.js";
import { normalizeGalaxyUrl as brainNormalize } from "../extensions/orbit/profiles";

describe("normalizeGalaxyUrl", () => {
  it.each([
    ["https://usegalaxy.org", "https://usegalaxy.org"],
    ["https://usegalaxy.org/", "https://usegalaxy.org"],
    ["https://usegalaxy.org///", "https://usegalaxy.org"],
    ["  usegalaxy.org  ", "https://usegalaxy.org"],
    ["http://localhost:8080/", "http://localhost:8080"],
  ])("tidies %j to %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it.each([
    ["https://usegalaxy.org/api", "https://usegalaxy.org"],
    ["https://usegalaxy.org/api/", "https://usegalaxy.org"],
    ["https://usegalaxy.org//api//", "https://usegalaxy.org"],
    ["usegalaxy.org/api", "https://usegalaxy.org"],
    ["http://127.0.0.1:8080/api", "http://127.0.0.1:8080"],
    ["https://example.org/galaxy/api/", "https://example.org/galaxy"],
  ])("takes the API root %j back to the server root %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it("strips only a whole trailing /api path segment", () => {
    // A host called "api" is not an API root.
    expect(normalizeGalaxyUrl("https://api")).toBe("https://api");
    expect(normalizeGalaxyUrl("api")).toBe("https://api");
    expect(normalizeGalaxyUrl("https://example.org/apis")).toBe("https://example.org/apis");
    expect(normalizeGalaxyUrl("https://example.org/myapi")).toBe("https://example.org/myapi");
    expect(normalizeGalaxyUrl("https://example.org/api/v2")).toBe("https://example.org/api/v2");
  });

  it("strips one /api, not every one", () => {
    expect(normalizeGalaxyUrl("https://example.org/api/api")).toBe("https://example.org/api");
  });

  it("leaves blank input blank", () => {
    expect(normalizeGalaxyUrl("")).toBe("");
    expect(normalizeGalaxyUrl("   ")).toBe("");
  });

  it("is idempotent", () => {
    for (const u of [
      "usegalaxy.org/api/",
      "https://example.org/galaxy/api",
      "http://localhost:8080",
    ]) {
      const once = normalizeGalaxyUrl(u);
      expect(normalizeGalaxyUrl(once)).toBe(once);
    }
  });

  it("is the same function the desktop and the brain use", () => {
    expect(appNormalize).toBe(normalizeGalaxyUrl);
    expect(brainNormalize).toBe(normalizeGalaxyUrl);
  });
});
