import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findStaleInstalls, formatStaleReport } from "../scripts/install-freshness.mjs";

// Shape of the two inputs: what the lockfile says a tree should resolve, and
// what is actually on disk. Both are read for real by the script; the pure
// function takes them as arguments so this needs no fixture tree.
const LOCKED = { "@earendil-works/pi-ai": "0.84.1", "@earendil-works/pi-tui": "0.84.1" };

describe("findStaleInstalls", () => {
  it("is quiet when the install matches the lockfile", () => {
    const stale = findStaleInstalls([{ tree: "root", locked: LOCKED, installed: { ...LOCKED } }]);
    expect(stale).toEqual([]);
  });

  it("flags a package installed at the wrong version", () => {
    const stale = findStaleInstalls([
      {
        tree: "root",
        locked: LOCKED,
        installed: { "@earendil-works/pi-ai": "0.78.1", "@earendil-works/pi-tui": "0.78.1" },
      },
    ]);
    expect(stale).toHaveLength(2);
    expect(stale[0]).toMatchObject({
      tree: "root",
      name: "@earendil-works/pi-ai",
      locked: "0.84.1",
      installed: "0.78.1",
    });
  });

  it("flags a package the lockfile expects but nothing installed", () => {
    const stale = findStaleInstalls([
      { tree: "root", locked: LOCKED, installed: { "@earendil-works/pi-ai": "0.84.1" } },
    ]);
    expect(stale).toEqual([
      { tree: "root", name: "@earendil-works/pi-tui", locked: "0.84.1", installed: null },
    ]);
  });

  // A worktree with no app/node_modules at all is not stale -- it is uninstalled,
  // which npm itself reports far more clearly than we could.
  it("skips a tree that has no node_modules", () => {
    expect(findStaleInstalls([{ tree: "app", locked: LOCKED, installed: null }])).toEqual([]);
  });

  it("reports every stale tree, not just the first", () => {
    const stale = findStaleInstalls([
      { tree: "root", locked: LOCKED, installed: { ...LOCKED, "@earendil-works/pi-ai": "0.78.1" } },
      { tree: "app", locked: LOCKED, installed: { ...LOCKED, "@earendil-works/pi-tui": "0.83.0" } },
    ]);
    expect(stale.map((s) => s.tree)).toEqual(["root", "app"]);
  });
});

describe("formatStaleReport", () => {
  const stale = [
    { tree: "root", name: "@earendil-works/pi-ai", locked: "0.84.1", installed: "0.78.1" },
    { tree: "app", name: "@earendil-works/pi-ai", locked: "0.84.1", installed: null },
  ];

  it("names both versions so the skew is obvious", () => {
    const out = formatStaleReport(stale);
    expect(out).toContain("@earendil-works/pi-ai");
    expect(out).toContain("0.78.1");
    expect(out).toContain("0.84.1");
    expect(out).toContain("not installed");
  });

  // The whole point: yesterday cost time because the symptom was 12 unrelated
  // test failures. The message has to hand over the fix.
  it("hands over the exact command to run", () => {
    const out = formatStaleReport(stale);
    expect(out).toContain("npm ci");
    expect(out).toMatch(/app/);
  });

  it("explains the worktree symlink, which is how this usually happens", () => {
    expect(formatStaleReport(stale).toLowerCase()).toContain("worktree");
  });

  // The symlink means a worktree cannot hold branch-specific dependencies, so
  // "reinstall in the root" is only half the advice -- a branch that bumps a
  // dependency needs saying out loud, or the message sends you in a circle.
  it("says what to do when the branch itself changed a dependency", () => {
    const out = formatStaleReport(stale).toLowerCase();
    expect(out).toContain("this branch");
    expect(out).toContain("own node_modules");
  });
});

// The direct-invocation guard compares import.meta.url against argv[1]. Node
// realpath-resolves the first and not the second, so reaching the repo through
// any symlink used to make the whole check a silent no-op -- no report, no exit
// code, and nothing on stderr saying it had been skipped. Drive the real script
// through a symlinked path and assert it still runs.
describe("direct-invocation guard", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const script = (root: string) => join(root, "scripts", "install-freshness.mjs");

  // LOOM_SKIP_INSTALL_CHECK makes the run cheap and, more usefully, gives the
  // guard an observable side effect that does not depend on whether this
  // particular checkout happens to be installed cleanly.
  function run(path: string) {
    return spawnSync(process.execPath, [path], {
      encoding: "utf8",
      env: { ...process.env, LOOM_SKIP_INSTALL_CHECK: "1" },
    });
  }

  it("runs when invoked through the real path", () => {
    expect(run(script(REPO_ROOT)).stderr).toContain("skipped");
  });

  // Windows needs elevation or developer mode to create a directory symlink.
  it.skipIf(process.platform === "win32")("still runs through a symlinked checkout", () => {
    const tmp = mkdtempSync(join(tmpdir(), "loom-freshness-"));
    try {
      const link = join(tmp, "link");
      symlinkSync(REPO_ROOT, link, "dir");
      expect(run(script(link)).stderr).toContain("skipped");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the escape hatch", () => {
  it("is advertised in the report, since one worktree case has no in-band fix", () => {
    const stale = [
      { tree: "root", name: "@earendil-works/pi-ai", locked: "0.84.1", installed: "0.78.1" },
    ];
    expect(formatStaleReport(stale)).toContain("LOOM_SKIP_INSTALL_CHECK");
  });
});
