import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Electron 41 has no fix for the Ozone display-server-lost callback, which went
// straight to LOG(FATAL) and surfaced as
// `electron_browser_main_parts.cc Failed to shutdown` whenever X11/Wayland went
// away (#431). electron/electron#52603 fixed it on main and was backported to
// 42, 43 and 44 -- never to 41-x-y, so no 41.x release can ever carry it.
//
// The backports landed mid-line, so "major >= 42" is not enough on its own:
// 43.0.0 is a higher version than 42.9.0 but predates the 43 backport. These are
// the first releases on each line whose notes carry "Fixed a crash report when
// the X server or Wayland compositor exits while an app is running".
const FIRST_PATCHED: Record<number, [number, number, number]> = {
  42: [42, 9, 0], // backport #52686, first shipped 2026-08-11
  43: [43, 4, 0], // backport #52685, first shipped 2026-08-11
};
// 44 was branched after the fix landed on main, so every 44+ *release* has it.
// 44 prereleases predating the backport do not, which is why parse() rejects
// prerelease specs outright rather than letting them through on major alone.
const PATCHED_FROM_MAJOR = 44;

// Deliberately strict: a bare version or a single-comparator range, nothing
// else. Prerelease/build suffixes, aliases (`npm:...`), compound ranges and
// wildcards all fail to parse and are treated as unpatched, so a spec we can't
// reason about can never silently satisfy the floor.
const SPEC = /^(?:\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/;

function parse(spec: string): [number, number, number] | null {
  const m = SPEC.exec(spec.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isPatched(spec: string): boolean {
  const parsed = parse(spec);
  if (!parsed) return false;
  const [major, minor, patch] = parsed;
  if (major >= PATCHED_FROM_MAJOR) return true;
  const floor = FIRST_PATCHED[major];
  if (!floor) return false; // 41 and earlier: no backport exists
  if (minor !== floor[1]) return minor > floor[1];
  return patch >= floor[2];
}

function read<T>(rel: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")) as T;
}

describe("Orbit's Electron floor (#431)", () => {
  it("locks an Electron build that contains the display-server shutdown fix", () => {
    const lock = read<{ packages: Record<string, { version?: string }> }>(
      "../app/package-lock.json",
    );
    const locked = lock.packages["node_modules/electron"]?.version;
    expect(locked, "app/package-lock.json must resolve an electron version").toBeTruthy();
    expect(
      isPatched(locked!),
      `locked electron ${locked} predates electron/electron#52603 -- Linux quits will abort (#431)`,
    ).toBe(true);
  });

  it("declares a range whose lower bound is also patched", () => {
    // npm resolves a caret range to the *highest* match, so the lower bound is
    // stricter than what a fresh install would normally pick. That is the point:
    // it's the worst case the range permits, and it's what a regenerated lockfile
    // or an offline/pinned resolve can land on.
    const pkg = read<{ devDependencies: Record<string, string> }>("../app/package.json");
    const range = pkg.devDependencies?.electron;
    expect(range, "app/package.json must declare an electron devDependency").toBeTruthy();
    expect(
      isPatched(range),
      `electron range "${range}" allows a build without electron/electron#52603 (#431)`,
    ).toBe(true);
  });

  it.each([
    ["^41.2.1", false],
    ["41.10.6", false],
    ["^42.0.0", false],
    ["42.8.9", false],
    ["42.9.0", true],
    ["^42.9.3", true],
    ["43.0.0", false],
    ["43.3.9", false],
    ["43.4.0", true],
    ["^43.4.1", true],
    ["44.0.0", true],
    ["44.0.0-beta.1", false], // prerelease predating the 44 backport
    ["~43.4.0", true],
    [">=43.4.0", true],
    ["*", false], // unparseable specs are never treated as patched
    ["npm:electron@44.0.0", false],
    ["^42.0.0 || ^43.0.0", false],
  ])("classifies %s correctly", (spec, expected) => {
    expect(isPatched(spec as string)).toBe(expected);
  });
});
