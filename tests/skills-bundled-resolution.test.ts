/**
 * Which configured repos read from the package and which still go to GitHub.
 *
 * The rule has to hold in both directions. A default config must never make a
 * network call for content that shipped inside the package, and a repo pointed
 * at a branch must never be answered from the package -- that is the whole
 * skill-author workflow of evaluating a change before it is merged.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_SKILLS } from "../shared/loom-config.js";
import {
  isBundledRepo,
  readBundledCatalog,
  readBundledRepoFile,
} from "../extensions/loom/vendor-skills";

const DEFAULT = DEFAULT_SKILLS[0];

afterEach(() => vi.restoreAllMocks());

describe("isBundledRepo", () => {
  it("is true for a seeded repo left at its shipped URL and branch", () => {
    expect(isBundledRepo({ ...DEFAULT })).toBe(true);
    expect(isBundledRepo({ name: DEFAULT.name, url: DEFAULT.url })).toBe(true);
  });

  it("tolerates the cosmetic URL differences a hand-edited config picks up", () => {
    expect(isBundledRepo({ ...DEFAULT, url: `${DEFAULT.url}/` })).toBe(true);
    expect(isBundledRepo({ ...DEFAULT, url: `${DEFAULT.url}.git` })).toBe(true);
  });

  it("is false once the repo points anywhere else", () => {
    expect(isBundledRepo({ ...DEFAULT, branch: "some-feature" })).toBe(false);
    expect(isBundledRepo({ ...DEFAULT, url: "https://github.com/galaxyproject/other" })).toBe(
      false,
    );
    expect(isBundledRepo({ name: "not-seeded", url: DEFAULT.url, branch: "main" })).toBe(false);
  });

  it("is false for the bundled-reference name, which is resolved before repo lookup", () => {
    // A user who configures a real repo called "foundry" has to be able to
    // reach it; the vendored set must not shadow the whole thing.
    expect(
      isBundledRepo({ name: "foundry", url: "https://github.com/galaxyproject/foundry" }),
    ).toBe(false);
  });
});

describe("readBundledRepoFile", () => {
  it("serves a real skill without touching the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = readBundledRepoFile(DEFAULT, "skills/udt-authoring/SKILL.md");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("GalaxyUserTool");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists that repo's own skills on a miss, not every bundled file", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = readBundledRepoFile(DEFAULT, "skills/no-such-skill/SKILL.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.available).toContain("skills/udt-authoring/SKILL.md");
      expect(res.available.every((p) => p.startsWith("skills/"))).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the generated catalog", () => {
  it("carries every skill the mirror ships, with the five tagged for this surface", () => {
    const catalog = readBundledCatalog();
    expect(catalog).not.toBeNull();
    const entries = catalog![DEFAULT.name];
    expect(entries.length).toBeGreaterThan(0);
    const tagged = entries.filter((e) => e.surfaces.includes("loom")).map((e) => e.name);
    // reproduciblify is the one the hand-written catalog had lost track of.
    expect(tagged).toContain("reproduciblify");
    expect(tagged.length).toBe(5);
  });

  it("names paths that actually resolve, at the same string a live fetch would use", () => {
    for (const entry of readBundledCatalog()![DEFAULT.name]) {
      expect(entry.path).toMatch(/^skills\/.+\/SKILL\.md$/);
      expect(readBundledRepoFile(DEFAULT, entry.path).ok).toBe(true);
    }
  });

  it("holds nothing from a repo that is kept out of the router", () => {
    expect(Object.keys(readBundledCatalog()!)).toEqual([DEFAULT.name]);
  });
});
