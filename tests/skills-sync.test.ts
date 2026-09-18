/**
 * Unit tests for the vendoring sync script.
 *
 * The CI drift gate hashes the vendored bytes against the manifest beside them,
 * which proves nobody hand-edited the tree and proves nothing about the
 * transform that produced it. A transform that mangles content re-syncs, writes
 * a fresh hash, and passes. These cover the transform itself and the four ways
 * `--check` is supposed to fail.
 */

import { describe, it, expect } from "vitest";
import {
  REPO_BLOB_BASE,
  applyTransforms,
  checkVendored,
  matchesPattern,
  rewriteLocalPaths,
  selectFiles,
  sha256,
  stripWikiLinks,
} from "../scripts/sync-skills.mjs";

describe("sha256", () => {
  // The Windows CI leg checks out CRLF. Hashing the bytes on disk would fail
  // that leg and only that leg, which is the worst kind of red.
  it("is stable across LF and CRLF", () => {
    const lf = "one\ntwo\nthree\n";
    expect(sha256(lf.replace(/\n/g, "\r\n"))).toBe(sha256(lf));
  });

  it("still distinguishes content that actually differs", () => {
    expect(sha256("one\ntwo\n")).not.toBe(sha256("one\nTWO\n"));
  });
});

describe("stripWikiLinks", () => {
  it("strips a plain link to its note name", () => {
    expect(stripWikiLinks("See [[galaxy-collection-semantics]] for the shapes.")).toBe(
      "See galaxy-collection-semantics for the shapes.",
    );
  });

  it("keeps the alias when the link has one, and drops the anchor when it does not", () => {
    // The Foundry's planemo notes are full of `[[tests-format#has_size_model|has_size]]`.
    // Rendering that as `tests-format#has_size_model|has_size` reads as noise.
    expect(stripWikiLinks("use [[tests-format#has_size_model|has_size]] here")).toBe(
      "use has_size here",
    );
    expect(stripWikiLinks("see [[tests-format#has_text_model]]")).toBe("see tests-format");
  });

  it("leaves 2D array literals inside a code fence alone", () => {
    // galaxy-skills' apply-rules reference documents the Apply Rules DSL with
    // fenced `data: [[cell values]]` blocks. `[[` there opens an array, not a
    // link, and stripping the brackets changes what the DSL example means.
    const doc = [
      "Prose pointing at [[apply-rules]].",
      "",
      "```",
      "data: [[cell values]]",
      'data: [["a", "b", "c"]]',
      "```",
      "",
      "More prose.",
    ].join("\n");
    const out = stripWikiLinks(doc);
    expect(out).toContain("data: [[cell values]]");
    expect(out).toContain('data: [["a", "b", "c"]]');
    expect(out).toContain("Prose pointing at apply-rules.");
  });

  it("leaves an array literal alone even unfenced, because no note name has a quote or comma", () => {
    expect(stripWikiLinks('Output: [["foo", "oo"]]')).toBe('Output: [["foo", "oo"]]');
  });

  it("resumes stripping after the fence closes", () => {
    const doc = ["```yaml", "data: [[cell values]]", "```", "Back to [[prose-note]]."].join("\n");
    expect(stripWikiLinks(doc)).toBe(
      ["```yaml", "data: [[cell values]]", "```", "Back to prose-note."].join("\n"),
    );
  });
});

describe("rewriteLocalPaths", () => {
  it("rewrites a mapped repo to its GitHub blob base", () => {
    expect(
      rewriteLocalPaths("see ~/projects/repositories/galaxy/lib/galaxy/jobs/__init__.py"),
    ).toBe(`see ${REPO_BLOB_BASE.galaxy}lib/galaxy/jobs/__init__.py`);
  });

  it("rewrites planemo too, because the Foundry notes leak both", () => {
    expect(rewriteLocalPaths("see ~/projects/repositories/planemo/docs/writing_tests.rst")).toBe(
      `see ${REPO_BLOB_BASE.planemo}docs/writing_tests.rst`,
    );
  });

  it("fails loudly on a repo it has no rewrite for", () => {
    // Shipping the raw path would point the agent at a directory that only
    // exists on the note author's machine, and Loom's read-jail blocks it, so
    // the turn is wasted rather than merely wrong.
    expect(() => rewriteLocalPaths("see ~/projects/repositories/tpv/config.yml")).toThrow(/tpv/);
  });

  it("fails on a reference the trailing-slash pattern would otherwise skip", () => {
    expect(() => rewriteLocalPaths("cloned into ~/projects/repositories/galaxy")).toThrow(
      /survived the rewrite/,
    );
  });
});

describe("applyTransforms", () => {
  const both = ["rewrite-local-paths", "strip-wiki-links"];

  it("only touches markdown", () => {
    const yml = "note: ~/projects/repositories/nosuchrepo/x.py and [[a-link]]\n";
    expect(applyTransforms(yml, "galaxy-collection-semantics.yml", both)).toBe(yml);
  });

  it("applies nothing when a plugin declares no transforms", () => {
    // The wiki-link strip and the path rewrite correct how the Foundry authors
    // its notes. Running them over content that never had the problem is how a
    // sync quietly corrupts something, so they are opt-in per plugin.
    const md = "keeps [[its-links]] and ~/projects/repositories/galaxy/x.py\n";
    expect(applyTransforms(md, "a.md", [])).toBe(md);
  });

  it("refuses a transform name it does not know", () => {
    expect(() => applyTransforms("x", "a.md", ["make-it-nice"])).toThrow(/make-it-nice/);
  });
});

describe("matchesPattern", () => {
  it("keeps a single star inside one path segment", () => {
    expect(matchesPattern("notes/*.md", "notes/a.md")).toBe(true);
    expect(matchesPattern("notes/*.md", "notes/deep/a.md")).toBe(false);
  });

  it("lets a double star cross segments", () => {
    expect(matchesPattern("cast/**", "cast/references/notes/a.md")).toBe(true);
    expect(matchesPattern("cast/**", "other/a.md")).toBe(false);
  });

  it("treats dots as literal", () => {
    expect(matchesPattern("a.md", "axmd")).toBe(false);
  });
});

const AVAILABLE = [
  "cast/SKILL.md",
  "cast/_feedback.md",
  "cast/_provenance.json",
  "cast/references/notes/one.md",
  "other-cast/SKILL.md",
];

describe("selectFiles", () => {
  it("mirrors a glob under the plugin prefix", () => {
    const files = selectFiles(
      { plugin: "p", as: "bundled", include: ["cast/**"], exclude: ["cast/_feedback.md"] },
      AVAILABLE,
    );
    expect(files.map((f: { target: string }) => f.target)).toEqual([
      "bundled/cast/SKILL.md",
      "bundled/cast/_provenance.json",
      "bundled/cast/references/notes/one.md",
    ]);
  });

  it("honours an explicit target for one file", () => {
    const files = selectFiles(
      { plugin: "p", as: "", include: [{ source: "cast/SKILL.md", target: "flat.md" }] },
      AVAILABLE,
    );
    expect(files).toEqual([{ source: "cast/SKILL.md", target: "flat.md", why: undefined }]);
  });

  it("fails when an include matches nothing", () => {
    // A cast renamed upstream should stop the sync rather than quietly shrink
    // what ships, which is invisible in a diff of generated files.
    expect(() => selectFiles({ plugin: "p", as: "", include: ["gone/**"] }, AVAILABLE)).toThrow(
      /matched nothing/,
    );
    expect(() =>
      selectFiles(
        { plugin: "p", as: "", include: [{ source: "gone.md", target: "x.md" }] },
        AVAILABLE,
      ),
    ).toThrow(/does not exist upstream/);
  });

  it("fails when two sources land on the same target", () => {
    expect(() =>
      selectFiles(
        {
          plugin: "p",
          as: "",
          include: [
            { source: "cast/SKILL.md", target: "x.md" },
            { source: "other-cast/SKILL.md", target: "x.md" },
          ],
        },
        AVAILABLE,
      ),
    ).toThrow(/both vendor as x.md/);
  });
});

const PIN = { repo: "galaxyproject/foundry", commit: "74a49c1a0ba5f5be43e5c4132994ea197d26d334" };

function check(overrides: Record<string, unknown> = {}) {
  return checkVendored({
    source: PIN,
    vendored: PIN,
    declared: ["a.md"],
    recorded: [{ target: "a.md", sha256: "aaa" }],
    present: ["a.md"],
    hashOf: () => "aaa",
    ...overrides,
  }) as { kind: string; message: string }[];
}

describe("checkVendored", () => {
  it("passes when the pin, the manifest and the disk agree", () => {
    expect(check()).toEqual([]);
  });

  it("catches a manifest edited without a re-sync", () => {
    // Which files a glob selects cannot be recomputed offline, so hashing the
    // manifest is the only way the gate notices a changed selection.
    const failures = check({
      source: { ...PIN, manifestSha: "one" },
      vendored: { ...PIN, manifestSha: "two" },
    });
    expect(failures).toEqual([
      { kind: "moved-pin", message: "the manifest changed but files were not re-synced" },
    ]);
  });

  it("catches a pin that moved without a re-sync", () => {
    const failures = check({ source: { ...PIN, commit: "0".repeat(40) } });
    expect(failures.map((f) => f.kind)).toEqual(["moved-pin"]);
  });

  it("catches a target the manifest asks for but the sync never wrote", () => {
    const failures = check({ declared: ["a.md", "b.md"] });
    expect(failures).toEqual([
      { kind: "missing", message: "b.md: in the manifest but not vendored" },
    ]);
  });

  it("catches a recorded target that is gone from disk", () => {
    const failures = check({ present: [] });
    expect(failures.map((f) => f.kind)).toEqual(["missing"]);
  });

  it("catches a vendored file the manifest no longer asks for", () => {
    const failures = check({
      declared: [],
      recorded: [],
      present: ["a.md"],
      hashOf: () => null,
    });
    expect(failures).toEqual([
      { kind: "orphaned", message: "a.md: on disk but not in _manifest.json" },
    ]);
  });

  it("catches a hand-edited file", () => {
    const failures = check({ hashOf: () => "bbb" });
    expect(failures.map((f) => f.kind)).toEqual(["hash-mismatch"]);
  });

  it("skips the manifest comparison when the selection is by pattern", () => {
    // A glob cannot be re-evaluated offline, so the gate falls back to
    // comparing the recorded manifest against what is on disk.
    expect(check({ declared: null })).toEqual([]);
  });
});
