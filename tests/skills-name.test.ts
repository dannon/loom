import { describe, it, expect } from "vitest";
import { isSafeSkillName } from "../extensions/loom/skills";

describe("isSafeSkillName", () => {
  it("accepts plain ASCII slugs", () => {
    expect(isSafeSkillName("galaxy-skills")).toBe(true);
    expect(isSafeSkillName("loom_skills")).toBe(true);
    expect(isSafeSkillName("skills.v2")).toBe(true);
    expect(isSafeSkillName("Galaxy123")).toBe(true);
  });

  it("rejects path-traversal forms", () => {
    expect(isSafeSkillName("..")).toBe(false);
    expect(isSafeSkillName(".")).toBe(false);
    expect(isSafeSkillName("../etc")).toBe(false);
    expect(isSafeSkillName("a/../b")).toBe(false);
    expect(isSafeSkillName("a/b")).toBe(false);
    expect(isSafeSkillName("a\\b")).toBe(false);
  });

  it("rejects shell/path metachars", () => {
    expect(isSafeSkillName("a b")).toBe(false);
    expect(isSafeSkillName("a$b")).toBe(false);
    expect(isSafeSkillName("a;b")).toBe(false);
    expect(isSafeSkillName("a*")).toBe(false);
    expect(isSafeSkillName("a\nb")).toBe(false);
  });

  it("rejects empty and overlong", () => {
    expect(isSafeSkillName("")).toBe(false);
    expect(isSafeSkillName("a".repeat(65))).toBe(false);
    expect(isSafeSkillName("a".repeat(64))).toBe(true);
  });

  it("rejects non-strings", () => {
    // @ts-expect-error – exercising runtime guard
    expect(isSafeSkillName(undefined)).toBe(false);
    // @ts-expect-error – exercising runtime guard
    expect(isSafeSkillName(42)).toBe(false);
  });
});
