import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INVOCATION_FAILURE_REFERENCE,
  JOB_FAILURE_REFERENCE,
} from "../extensions/loom/invocation-failure-hint";
import {
  VENDOR_REPO_NAME,
  readVendorManifest,
  readVendoredSkill,
  resolveVendorPath,
  vendorSkillsDir,
} from "../extensions/loom/vendor-skills";

describe("vendored skills", () => {
  it("ships every file the manifest declares", () => {
    const manifest = readVendorManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBeGreaterThan(0);
    for (const f of manifest!.files) {
      expect(fs.existsSync(path.join(vendorSkillsDir(), f.target))).toBe(true);
    }
  });

  it("pins the commit it was vendored from", () => {
    // A tag would be a moving target; the commit is what makes "which version
    // shipped" answerable after the fact.
    const manifest = readVendorManifest()!;
    expect(manifest.repo).toBe("galaxyproject/agentic-plugins");
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a vendored file at the path its cast uses upstream", () => {
    const res = readVendoredSkill(INVOCATION_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Invocation Message Reasons");
  });

  it("still resolves the two bare names a resumed session may be holding", () => {
    // The tree was flat before targets mirrored their upstream path, and both
    // of these were handed to the model by name in a failed-invocation hint.
    for (const [legacy, current] of [
      ["galaxy-workflow-invocation-failure-reference.md", INVOCATION_FAILURE_REFERENCE],
      ["galaxy-tool-job-failure-reference.md", JOB_FAILURE_REFERENCE],
    ]) {
      const viaLegacy = readVendoredSkill(legacy);
      const viaCurrent = readVendoredSkill(current);
      expect(viaLegacy.ok).toBe(true);
      if (viaLegacy.ok && viaCurrent.ok) expect(viaLegacy.text).toBe(viaCurrent.text);
    }
  });

  it("lists what is available when a path misses", () => {
    const res = readVendoredSkill("nope.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.available).toContain(JOB_FAILURE_REFERENCE);
    }
  });

  it("carries no local-checkout paths -- the sync rewrites them", () => {
    for (const f of readVendorManifest()!.files) {
      if (!f.target.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(vendorSkillsDir(), f.target), "utf-8");
      expect(text).not.toContain("~/projects/repositories");
      expect(text).not.toMatch(/\[\[/);
    }
  });

  it("rewrote Galaxy source citations to resolvable URLs", () => {
    const res = readVendoredSkill(JOB_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/");
    }
  });

  it("rewrote Planemo source citations too", () => {
    const res = readVendoredSkill(
      "debug-galaxy-workflow-output/references/notes/planemo-workflow-test-architecture.md",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("https://github.com/galaxyproject/planemo/blob/master/planemo/");
    }
  });

  it("leaves the cast's feedback ledger behind", () => {
    // `_feedback.md` belongs to a review loop the Foundry runs and Loom does
    // not, so shipping it would be guidance pointing at a process we have no
    // part in.
    const targets = readVendorManifest()!.files.map((f) => f.target);
    expect(targets.some((t) => t.endsWith("_feedback.md"))).toBe(false);
    expect(targets).toContain("debug-galaxy-workflow-output/SKILL.md");
  });

  it("reserves a repo name that cannot collide with a configured repo", () => {
    // Configured repos are allowlisted to github.com/galaxyproject/*, and a
    // user-added repo named "foundry" would otherwise shadow the bundled set.
    // skills_fetch checks the bundled name first, so assert it stays stable.
    expect(VENDOR_REPO_NAME).toBe("foundry");
  });
});

describe("resolveVendorPath", () => {
  it("resolves a flat name", () => {
    expect(resolveVendorPath("a.md")).toBe(path.join(vendorSkillsDir(), "a.md"));
  });

  it("rejects traversal, absolute escapes, and empties", () => {
    expect(resolveVendorPath("../secrets")).toBeNull();
    expect(resolveVendorPath("a/../../b")).toBeNull();
    expect(resolveVendorPath("")).toBeNull();
    expect(resolveVendorPath("/")).toBeNull();
  });

  it("rejects any `..` substring, encoded or not, without decoding first", () => {
    // The guard is a blanket `..` reject rather than a decode-then-resolve, so
    // percent-encoded traversal never gets a chance to become a separator.
    expect(resolveVendorPath("..%2fb")).toBeNull();
    expect(resolveVendorPath("%2e%2e/b")).not.toBeNull(); // no literal `..`; resolve contains it
    expect(resolveVendorPath("%2e%2e/b")).toBe(path.join(vendorSkillsDir(), "%2e%2e", "b"));
  });

  it("strips leading slashes rather than escaping to the filesystem root", () => {
    expect(resolveVendorPath("/a.md")).toBe(path.join(vendorSkillsDir(), "a.md"));
  });

  it("normalizes backslash separators", () => {
    expect(resolveVendorPath("a\\b.md")).toBe(path.join(vendorSkillsDir(), "a", "b.md"));
    expect(resolveVendorPath("..\\..\\b")).toBeNull();
  });
});
