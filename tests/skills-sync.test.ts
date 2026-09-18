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
  checkVendored,
  rewriteLocalPaths,
  sha256,
  stripWikiLinks,
  transform,
} from "../scripts/sync-foundry-skills.mjs";

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

  it("fails loudly on a repo it has no rewrite for", () => {
    // Shipping the raw path would point the agent at a directory that only
    // exists on the note author's machine, and Loom's read-jail blocks it, so
    // the turn is wasted rather than merely wrong.
    expect(() => rewriteLocalPaths("see ~/projects/repositories/planemo/docs/writing.rst")).toThrow(
      /planemo/,
    );
  });

  it("fails on a reference the trailing-slash pattern would otherwise skip", () => {
    expect(() => rewriteLocalPaths("cloned into ~/projects/repositories/galaxy")).toThrow(
      /survived the rewrite/,
    );
  });
});

describe("transform", () => {
  it("only touches markdown", () => {
    const yml = "note: ~/projects/repositories/nosuchrepo/x.py and [[a-link]]\n";
    expect(transform(yml, "galaxy-collection-semantics.yml")).toBe(yml);
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
