import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module namespace for "fs" can't be spied on under ESM, so count through
// a pass-through mock instead.
const calls = vi.hoisted(() => ({ realpath: 0 }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof real.realpathSync>) => {
      calls.realpath++;
      return real.realpathSync(...args);
    },
    { native: real.realpathSync.native },
  );
  return { ...real, default: { ...real, realpathSync }, realpathSync };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isCredentialStore } from "../extensions/loom/exec-guard/sensitive-read";

// One realpath per distinct parent: $HOME, ~/.loom, ~/.orbit and the agent
// dir. Fewer than the fourteen credential files, which is the bound that matters.
const DISTINCT_PARENTS = 4;

let root: string;
let home: string;
let agentDir: string;
let target: string;

// The cache won't trust a dir that changed within the last second, and every
// dir here was just made. Back-dating them with utimes would also move ctime,
// which the cache treats as a change, so move the clock instead.
function settle(): void {
  const later = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockReturnValue(later);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-read-cache-"));
  home = path.join(root, "home");
  agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(path.join(home, ".loom"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".loom", "config.json"), "{}");
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "x.json"), "{}");
  target = fs.realpathSync(path.join(ws, "x.json"));
  calls.realpath = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isCredentialStore realpath cache", () => {
  it("resolves at most once per credential file, then not at all while nothing changes", () => {
    settle();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(calls.realpath).toBeGreaterThan(0);
    expect(calls.realpath).toBeLessThanOrEqual(DISTINCT_PARENTS);

    calls.realpath = 0;
    for (let i = 0; i < 5; i++) expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(calls.realpath).toBe(0);
  });

  it("still matches the stores themselves from a cached snapshot", () => {
    const realHome = fs.realpathSync(home);
    const realAuth = fs.realpathSync(path.join(agentDir, "auth.json"));
    settle();
    isCredentialStore(target, home, agentDir);
    calls.realpath = 0;
    expect(isCredentialStore(path.join(realHome, ".loom", "config.json"), home, agentDir)).toBe(
      true,
    );
    expect(isCredentialStore(path.join(home, ".orbit", "config.json"), home, agentDir)).toBe(true);
    expect(isCredentialStore(realAuth, home, agentDir)).toBe(true);
    expect(calls.realpath).toBe(0);
  });

  it("sees a symlink planted at a credential path on the very next call, and its removal", () => {
    settle();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(isCredentialStore(target, home, agentDir)).toBe(false);

    const cfg = path.join(home, ".loom", "config.json");
    fs.rmSync(cfg);
    fs.symlinkSync(target, cfg);
    expect(isCredentialStore(target, home, agentDir)).toBe(true);

    fs.rmSync(cfg);
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
  });

  it("sees a credential dir created as a symlink into the workspace", () => {
    settle();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    // ~/.orbit did not exist; the change lands in ~, not in any dir under it.
    fs.symlinkSync(path.dirname(target), path.join(home, ".orbit"));
    const asConfig = path.join(path.dirname(target), "config.json");
    fs.writeFileSync(asConfig, "{}");
    expect(isCredentialStore(fs.realpathSync(asConfig), home, agentDir)).toBe(true);
  });

  it("sees a symlink planted at a relocated agent dir's credential file", () => {
    const outside = path.join(root, "agent-elsewhere");
    fs.mkdirSync(outside);
    settle();
    expect(isCredentialStore(target, home, outside)).toBe(false);
    expect(isCredentialStore(target, home, outside)).toBe(false);
    fs.symlinkSync(target, path.join(outside, "mcp.json"));
    expect(isCredentialStore(target, home, outside)).toBe(true);
  });

  it("does not trust a snapshot taken within a timestamp tick of a change", () => {
    // Not settled: the dirs changed moments ago, and a second change in the
    // same tick could leave every stamp where the snapshot saw it, so a
    // repeat call has to resolve again rather than answer from the cache.
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    calls.realpath = 0;
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(calls.realpath).toBeGreaterThan(0);
  });

  it("is not fooled by putting the dir's mtime back after planting a symlink", () => {
    const loomDir = path.join(home, ".loom");
    // A whole-millisecond stamp, so putting it back below is exact.
    const stamp = new Date(Date.now() - 1);
    fs.utimesSync(loomDir, stamp, stamp);
    const seen = fs.statSync(loomDir).mtimeMs;
    settle();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    const cfg = path.join(loomDir, "config.json");
    fs.rmSync(cfg);
    fs.symlinkSync(target, cfg);
    fs.utimesSync(loomDir, stamp, stamp);
    expect(fs.statSync(loomDir).mtimeMs).toBe(seen);
    expect(isCredentialStore(target, home, agentDir)).toBe(true);
  });

  it("follows a renamed ancestor of a symlinked credential dir's target", () => {
    // ~/.loom -> ws/a/b, then ws/a is renamed and relinked under its old name:
    // ~/.loom, ~ and ws/a/b all stat exactly as before.
    const ws = path.join(root, "ws");
    fs.mkdirSync(path.join(ws, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(ws, "a", "b", "config.json"), "{}");
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(ws, "a", "b"), path.join(home, ".loom"));
    settle();
    expect(
      isCredentialStore(fs.realpathSync(path.join(ws, "a", "b", "config.json")), home, agentDir),
    ).toBe(true);
    fs.renameSync(path.join(ws, "a"), path.join(ws, "c"));
    fs.symlinkSync("c", path.join(ws, "a"));
    const moved = fs.realpathSync(path.join(ws, "c", "b", "config.json"));
    expect(isCredentialStore(moved, home, agentDir)).toBe(true);
  });

  it("follows a renamed ancestor of a relocated agent dir", () => {
    const outside = path.join(root, "proj", "pi", "agent");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "auth.json"), "{}");
    settle();
    expect(isCredentialStore(fs.realpathSync(path.join(outside, "auth.json")), home, outside)).toBe(
      true,
    );
    fs.renameSync(path.join(root, "proj"), path.join(root, "proj2"));
    fs.symlinkSync("proj2", path.join(root, "proj"));
    const moved = fs.realpathSync(path.join(root, "proj2", "pi", "agent", "auth.json"));
    expect(isCredentialStore(moved, home, outside)).toBe(true);
  });

  it("never trusts a snapshot where a credential file is itself a symlink", () => {
    const cfg = path.join(home, ".loom", "config.json");
    const later = path.join(root, "ws", "later.json");
    fs.rmSync(cfg);
    // Dangling for now: it starts resolving the moment the target appears,
    // and creating that target touches nothing the cache watches.
    fs.symlinkSync(later, cfg);
    settle();
    isCredentialStore(target, home, agentDir);
    isCredentialStore(target, home, agentDir);
    fs.writeFileSync(later, "{}");
    expect(isCredentialStore(fs.realpathSync(later), home, agentDir)).toBe(true);
  });
});
