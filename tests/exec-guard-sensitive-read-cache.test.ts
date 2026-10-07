import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module namespace for "fs" can't be spied on under ESM, so count through
// a pass-through mock instead.
// Every test home sits under the OS tmpdir, which the cache watches like any
// other ancestor and which other test files keep adding entries to. Its stats
// (and its ancestors') are pinned per test so a busy machine doesn't read as a
// change to the dirs under test.
const calls = vi.hoisted(() => ({
  realpath: 0,
  native: 0,
  lstat: 0,
  pinned: new Map<string, unknown>(),
}));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof real.realpathSync>) => {
      calls.realpath++;
      return real.realpathSync(...args);
    },
    {
      native: (...args: Parameters<typeof real.realpathSync.native>) => {
        calls.native++;
        return real.realpathSync.native(...args);
      },
    },
  );
  const lstatSync = ((...args: Parameters<typeof real.lstatSync>) => {
    calls.lstat++;
    const key = String(args[0]);
    if (calls.pinned.has(key)) {
      if (calls.pinned.get(key) === null) calls.pinned.set(key, real.lstatSync(...args));
      return calls.pinned.get(key);
    }
    return real.lstatSync(...args);
  }) as typeof real.lstatSync;
  return {
    ...real,
    default: { ...real, realpathSync, lstatSync },
    realpathSync,
    lstatSync,
  };
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
  calls.pinned.clear();
  for (const start of [path.dirname(root), path.dirname(fs.realpathSync(root))]) {
    for (let d = start; ; d = path.dirname(d)) {
      calls.pinned.set(d, null);
      if (path.dirname(d) === d) break;
    }
  }
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
  calls.native = 0;
  calls.lstat = 0;
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
    fs.symlinkSync(path.dirname(target), path.join(home, ".orbit"), "dir");
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
    fs.symlinkSync(path.join(ws, "a", "b"), path.join(home, ".loom"), "dir");
    settle();
    expect(
      isCredentialStore(fs.realpathSync(path.join(ws, "a", "b", "config.json")), home, agentDir),
    ).toBe(true);
    fs.renameSync(path.join(ws, "a"), path.join(ws, "c"));
    fs.symlinkSync("c", path.join(ws, "a"), "dir");
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
    fs.symlinkSync("proj2", path.join(root, "proj"), "dir");
    const moved = fs.realpathSync(path.join(root, "proj2", "pi", "agent", "auth.json"));
    expect(isCredentialStore(moved, home, outside)).toBe(true);
  });

  it("follows a re-pointed symlink in the middle of a credential dir's chain", () => {
    // ~/.loom -> u/link -> b. Re-pointing u/link at c rewrites only u, which
    // neither the lexical nor the resolved chain passes through.
    const u = path.join(root, "u");
    const b = path.join(root, "b");
    const c = path.join(root, "c");
    for (const d of [u, b, c]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(b, "config.json"), "{}");
    fs.writeFileSync(path.join(c, "config.json"), "{}");
    fs.symlinkSync(b, path.join(u, "link"), "dir");
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(u, "link"), path.join(home, ".loom"), "dir");
    const inB = fs.realpathSync(path.join(b, "config.json"));
    const inC = fs.realpathSync(path.join(c, "config.json"));
    settle();
    expect(isCredentialStore(inB, home, agentDir)).toBe(true);
    expect(isCredentialStore(inC, home, agentDir)).toBe(false);

    fs.rmSync(path.join(u, "link"));
    fs.symlinkSync(c, path.join(u, "link"), "dir");
    expect(isCredentialStore(inC, home, agentDir)).toBe(true);
    expect(isCredentialStore(inB, home, agentDir)).toBe(false);
  });

  it("follows a three-hop chain when its middle hop is re-pointed", () => {
    // ~/.loom -> h1/l -> h2/l -> h3/l -> b, then h2/l is re-pointed at c.
    const hops = [1, 2, 3].map((i) => path.join(root, `h${i}`));
    const b = path.join(root, "b");
    const c = path.join(root, "c");
    for (const d of [...hops, b, c]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(b, "config.json"), "{}");
    fs.writeFileSync(path.join(c, "config.json"), "{}");
    fs.symlinkSync(path.join(hops[1], "l"), path.join(hops[0], "l"), "dir");
    fs.symlinkSync(path.join(hops[2], "l"), path.join(hops[1], "l"), "dir");
    fs.symlinkSync(b, path.join(hops[2], "l"), "dir");
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(hops[0], "l"), path.join(home, ".loom"), "dir");
    const inB = fs.realpathSync(path.join(b, "config.json"));
    const inC = fs.realpathSync(path.join(c, "config.json"));
    settle();
    expect(isCredentialStore(inB, home, agentDir)).toBe(true);
    expect(isCredentialStore(inB, home, agentDir)).toBe(true);

    fs.rmSync(path.join(hops[1], "l"));
    fs.symlinkSync(c, path.join(hops[1], "l"), "dir");
    expect(isCredentialStore(inC, home, agentDir)).toBe(true);
    expect(isCredentialStore(inB, home, agentDir)).toBe(false);
  });

  it("sees the target of a dangling credential-dir link once it is created", () => {
    // ~/.loom -> u/target with u/target absent; creating it rewrites only u.
    const u = path.join(root, "u");
    fs.mkdirSync(u);
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(u, "target"), path.join(home, ".loom"), "dir");
    settle();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(isCredentialStore(target, home, agentDir)).toBe(false);

    fs.mkdirSync(path.join(u, "target"));
    fs.writeFileSync(path.join(u, "target", "config.json"), "{}");
    const planted = fs.realpathSync(path.join(u, "target", "config.json"));
    expect(isCredentialStore(planted, home, agentDir)).toBe(true);
  });

  it("settles a plain home to no realpaths and one lstat per watched dir", () => {
    // Every dir the walk signs is a component of one of the resolved parents;
    // the agent dir's chain is the longest and shares the rest, plus ~/.loom
    // beside it. Each link on the way (macOS's /var) is signed too.
    const realAgent = fs.realpathSync(agentDir);
    let linksOnTheWay = 0;
    for (let d = agentDir; path.dirname(d) !== d; d = path.dirname(d)) {
      if (fs.lstatSync(d).isSymbolicLink()) linksOnTheWay++;
    }
    const bound = realAgent.split(path.sep).length + 1 + linksOnTheWay;
    settle();
    isCredentialStore(target, home, agentDir);
    calls.realpath = 0;
    calls.native = 0;
    calls.lstat = 0;
    for (let i = 0; i < 5; i++) expect(isCredentialStore(target, home, agentDir)).toBe(false);
    expect(calls.realpath).toBe(0);
    expect(calls.native).toBe(0);
    expect(calls.lstat).toBeGreaterThan(0);
    expect(calls.lstat).toBeLessThanOrEqual(5 * bound);
  });

  it("settles a dangling credential-dir link, since the dir its target would land in is watched", () => {
    const u = path.join(root, "u");
    fs.mkdirSync(u);
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(u, "target"), path.join(home, ".loom"), "dir");
    settle();
    isCredentialStore(target, home, agentDir);
    calls.realpath = 0;
    isCredentialStore(target, home, agentDir);
    expect(calls.realpath).toBe(0);
  });

  it("never trusts a snapshot whose chain can't be followed", () => {
    // ~/.loom -> u/l -> ~/.loom: realpath gives up with ELOOP, and so does the
    // walk, so nothing about which dirs matter is known.
    const u = path.join(root, "u");
    fs.mkdirSync(u);
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(home, ".loom"), path.join(u, "l"), "dir");
    fs.symlinkSync(path.join(u, "l"), path.join(home, ".loom"), "dir");
    settle();
    isCredentialStore(target, home, agentDir);
    calls.realpath = 0;
    isCredentialStore(target, home, agentDir);
    expect(calls.realpath).toBeGreaterThan(0);

    // And once it can be followed, the next call sees where it goes.
    fs.rmSync(path.join(u, "l"));
    fs.symlinkSync(path.dirname(target), path.join(u, "l"), "dir");
    const asConfig = path.join(path.dirname(target), "config.json");
    fs.writeFileSync(asConfig, "{}");
    expect(isCredentialStore(fs.realpathSync(asConfig), home, agentDir)).toBe(true);
  });

  it("survives a chain of links with long targets, and still finds the end of it", () => {
    // Each link points at the next one plus a long tail of dirs, so one walk
    // visits thousands of components; a recursive walk ran out of stack here.
    const r = path.join(root, "r");
    fs.mkdirSync(r);
    const tail = Array(450).fill("a").join("/");
    for (let k = 0; k < 10; k++) {
      fs.symlinkSync(path.join(r, `l${k + 1}`, tail), path.join(r, `l${k}`), "dir");
    }
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync(path.join(r, "l0"), path.join(home, ".loom"), "dir");
    settle();
    expect(() => isCredentialStore(target, home, agentDir)).not.toThrow();
    expect(isCredentialStore(target, home, agentDir)).toBe(false);
  });

  it("flags where the kernel puts a `..` after a link, not where string math does", () => {
    // ~/s -> x/y and ~/.loom -> s/../real. Opening ~/.loom/config.json goes
    // to x/real, which is where fs.promises.realpath says it is too;
    // fs.realpathSync collapses the `..` first and says ~/real. Windows
    // collapses it the same way as the string math (CI's native lookup missed
    // x/real), so there both get a config.json and only "flagged wherever it
    // opens" is asserted.
    const x = path.join(root, "x");
    fs.mkdirSync(path.join(x, "y"), { recursive: true });
    fs.mkdirSync(path.join(x, "real"));
    fs.writeFileSync(path.join(x, "real", "config.json"), "{}");
    fs.mkdirSync(path.join(home, "real"));
    if (process.platform === "win32")
      fs.writeFileSync(path.join(home, "real", "config.json"), "{}");
    fs.symlinkSync(path.join(x, "y"), path.join(home, "s"), "dir");
    fs.rmSync(path.join(home, ".loom"), { recursive: true });
    fs.symlinkSync("s/../real", path.join(home, ".loom"), "dir");
    const opened = fs.realpathSync.native(path.join(home, ".loom", "config.json"));
    if (process.platform !== "win32") {
      expect(opened).toBe(fs.realpathSync(path.join(x, "real", "config.json")));
    }
    settle();
    expect(isCredentialStore(opened, home, agentDir)).toBe(true);
    // Which dirs decide each answer differ, so neither is cached.
    calls.realpath = 0;
    expect(isCredentialStore(opened, home, agentDir)).toBe(true);
    expect(calls.realpath).toBeGreaterThan(0);
  });

  it("keeps (home, agentDir) pairs apart even when joining them would collide", () => {
    // Joined with a NUL, ("/a\0/b", "/c") and ("/a", "/b\0/c") made one key,
    // so the second pair was answered from the first pair's snapshot. `a`'s
    // parent is missing, so the walk stops there and the first pair settles.
    const a = path.join(root, "missing", "a");
    settle();
    isCredentialStore(target, `${a}\0/b`, "/c");
    expect(isCredentialStore(path.join(a, ".loom", "config.json"), a, "/b\0/c")).toBe(true);
  });

  it("resolves a relative agent dir against the cwd of each call", () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    for (const d of [first, second]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "auth.json"), "{}");
    }
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(first);
    settle();
    expect(isCredentialStore(path.join(first, "auth.json"), home, ".")).toBe(true);
    expect(isCredentialStore(path.join(first, "auth.json"), home, ".")).toBe(true);
    cwd.mockReturnValue(second);
    expect(isCredentialStore(path.join(second, "auth.json"), home, ".")).toBe(true);
    expect(isCredentialStore(path.join(first, "auth.json"), home, ".")).toBe(false);
  });

  it("resolves the agent dir once, not once per file, when there is no home", () => {
    isCredentialStore(target, "", agentDir);
    expect(calls.realpath).toBe(1);
    expect(isCredentialStore(fs.realpathSync(path.join(agentDir, "auth.json")), "", agentDir)).toBe(
      true,
    );
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
