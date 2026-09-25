/**
 * The two races the layout store has to lose on purpose.
 *
 * A swap between the pre-check and the read, and two processes each holding
 * their own in-memory lock. Neither can be hit reliably against a real
 * directory, so the first is staged with a hook on `lstat` -- the one seam
 * between "checked the name" and "opened the name" -- and the second with two
 * separate instances of the module, which is exactly what two processes are
 * from the lock's point of view. Everything else is the real filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hooks = vi.hoisted(() => ({ afterLstat: null as null | ((p: string) => void) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: async (p: Parameters<typeof real.lstat>[0], ...rest: unknown[]) => {
      const st = await (real.lstat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
      hooks.afterLstat?.(String(p));
      return st;
    },
  };
});

import { casWriteLayoutFile, readLayoutFile } from "../shared/dashboard-layout-store.js";
import { DASHBOARD_MAX_BYTES } from "../shared/dashboard-contract.js";

let dir: string;
let file: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-store-race-"));
  file = path.join(dir, ".loom-dashboard.json");
  outside = path.join(dir, "victim.txt");
  fs.writeFileSync(outside, "DO NOT TOUCH\n");
  hooks.afterLstat = null;
});

afterEach(() => {
  hooks.afterLstat = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await sleep(5);
  }
}

describe("a swap between the check and the read", () => {
  it("does not serve the target of a symlink swapped in after the lstat", async () => {
    fs.writeFileSync(file, '{"looks":"fine"}\n');
    let swapped = false;
    hooks.afterLstat = (p) => {
      if (p !== file || swapped) return;
      swapped = true;
      fs.rmSync(file);
      fs.symlinkSync(outside, file);
    };
    const res = await readLayoutFile(file, DASHBOARD_MAX_BYTES);
    expect(swapped).toBe(true);
    expect(res.ok).toBe(false);
    if (res.ok) expect(res.raw).not.toContain("DO NOT TOUCH");
  });

  it("refuses a file that grows past the cap after the lstat", async () => {
    fs.writeFileSync(file, "small\n");
    let grown = false;
    hooks.afterLstat = (p) => {
      if (p !== file || grown) return;
      grown = true;
      fs.appendFileSync(file, "x".repeat(64));
    };
    const res = await readLayoutFile(file, 16);
    expect(grown).toBe(true);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("larger than") });
  });

  it("refuses the swap on the re-check inside a save, and leaves the target alone", async () => {
    fs.writeFileSync(file, "R0\n");
    let swapped = false;
    hooks.afterLstat = (p) => {
      if (p !== file || swapped) return;
      swapped = true;
      fs.rmSync(file);
      fs.symlinkSync(outside, file);
    };
    const res = await casWriteLayoutFile(file, "MINE\n", undefined, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("DO NOT TOUCH\n");
  });
});

describe("two processes on one layout file", () => {
  async function twoInstances() {
    vi.resetModules();
    const a = await import("../shared/dashboard-layout-store.js");
    vi.resetModules();
    const b = await import("../shared/dashboard-layout-store.js");
    // Separate module instances, so separate in-memory chains: what two
    // processes look like to the lock.
    expect(a.withLayoutLock).not.toBe(b.withLayoutLock);
    return { a, b };
  }

  it("makes the second wait for the first, across the in-memory chain", async () => {
    const { a, b } = await twoInstances();
    let release!: () => void;
    const aDone = a.withLayoutLock(file, () => new Promise<void>((r) => (release = r)));
    await until(() => fs.existsSync(`${file}.lock`));

    let bStarted = false;
    const bDone = b.withLayoutLock(file, async () => {
      bStarted = true;
    });
    await sleep(150);
    expect(bStarted).toBe(false);

    release();
    await aDone;
    await bDone;
    expect(bStarted).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("lets exactly one of two saves from different processes win", async () => {
    const { a, b } = await twoInstances();
    fs.writeFileSync(file, "R0\n");
    const base = (await a.readLayoutFile(file, DASHBOARD_MAX_BYTES)).revision;
    const [ra, rb] = await Promise.all([
      a.casWriteLayoutFile(file, "FROM-A\n", base, DASHBOARD_MAX_BYTES),
      b.casWriteLayoutFile(file, "FROM-B\n", base, DASHBOARD_MAX_BYTES),
    ]);
    expect([ra, rb].filter((r) => r.ok)).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe(ra.ok ? "FROM-A\n" : "FROM-B\n");
  });

  it("takes over a lock file left behind by a process that died", async () => {
    fs.writeFileSync(`${file}.lock`, "");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(`${file}.lock`, old, old);
    const res = await casWriteLayoutFile(file, "A\n", null, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("does not treat a symlink planted at the lock name as the lock", async () => {
    fs.symlinkSync(outside, `${file}.lock`);
    const old = (Date.now() - 60_000) / 1000;
    fs.lutimesSync(`${file}.lock`, old, old);
    const res = await casWriteLayoutFile(file, "A\n", null, DASHBOARD_MAX_BYTES);
    expect(res.ok).toBe(true);
    // The link was removed, not written through.
    expect(fs.readFileSync(outside, "utf8")).toBe("DO NOT TOUCH\n");
  });
});
