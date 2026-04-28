import { describe, it, expect } from "vitest";
import { isAllowedSkillUrl, ALLOWED_SKILLS_PREFIX } from "../shared/loom-config.js";

describe("isAllowedSkillUrl", () => {
  it("accepts the seeded galaxy-skills URL", () => {
    expect(isAllowedSkillUrl("https://github.com/galaxyproject/galaxy-skills")).toBe(true);
  });

  it("accepts trailing slash", () => {
    expect(isAllowedSkillUrl("https://github.com/galaxyproject/galaxy-skills/")).toBe(true);
  });

  it("accepts .git suffix", () => {
    expect(isAllowedSkillUrl("https://github.com/galaxyproject/galaxy-skills.git")).toBe(true);
  });

  it("accepts .git suffix + trailing slash", () => {
    expect(isAllowedSkillUrl("https://github.com/galaxyproject/galaxy-skills.git/")).toBe(true);
  });

  it("accepts uppercase Owner segment (case-insensitive)", () => {
    expect(isAllowedSkillUrl("https://github.com/GalaxyProject/loom-skills")).toBe(true);
  });

  it("rejects non-galaxyproject owners", () => {
    expect(isAllowedSkillUrl("https://github.com/notgalaxy/skills")).toBe(false);
    expect(isAllowedSkillUrl("https://github.com/example/foo")).toBe(false);
  });

  it("rejects subdomain attacks", () => {
    expect(isAllowedSkillUrl("https://github.com.evil.com/galaxyproject/skills")).toBe(false);
    expect(isAllowedSkillUrl("https://evil.github.com/galaxyproject/skills")).toBe(false);
  });

  it("rejects path-confusion attacks", () => {
    expect(isAllowedSkillUrl("https://github.com/evil/galaxyproject/skills")).toBe(false);
  });

  it("rejects http (no TLS)", () => {
    expect(isAllowedSkillUrl("http://github.com/galaxyproject/skills")).toBe(false);
  });

  it("rejects SSH form", () => {
    expect(isAllowedSkillUrl("git@github.com:galaxyproject/galaxy-skills.git")).toBe(false);
  });

  it("rejects bare /galaxyproject without repo segment", () => {
    expect(isAllowedSkillUrl("https://github.com/galaxyproject")).toBe(false);
    expect(isAllowedSkillUrl("https://github.com/galaxyproject/")).toBe(false);
  });

  it("rejects non-strings", () => {
    // @ts-expect-error – exercising runtime guard
    expect(isAllowedSkillUrl(undefined)).toBe(false);
    // @ts-expect-error – exercising runtime guard
    expect(isAllowedSkillUrl(null)).toBe(false);
    // @ts-expect-error – exercising runtime guard
    expect(isAllowedSkillUrl(42)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowedSkillUrl("not a url")).toBe(false);
    expect(isAllowedSkillUrl("")).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isAllowedSkillUrl("  https://github.com/galaxyproject/skills  ")).toBe(true);
  });

  it("exposes the prefix constant for UI hints", () => {
    expect(ALLOWED_SKILLS_PREFIX).toBe("https://github.com/galaxyproject/");
  });
});
