import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

// #649: on Windows, a module imported as both `./x` and `./x.js` was evaluated
// twice under pi's loader, so session_start set the notebook path on one copy
// of state.ts and loom_propose read the other. See the fixture for the why.
const FIXTURE = path.join(__dirname, "fixtures", "jiti-module-loads.mjs");
const REPO_ROOT = path.join(__dirname, "..");
// Every extensions/<name>/index.ts (bin/orbit.js loads them all), plus the
// gate web/server.ts adds in remote mode, so a new extension can't slip past.
const ENTRIES = [
  ...fs
    .readdirSync(path.join(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && fs.existsSync(path.join(REPO_ROOT, "extensions", d.name, "index.ts")),
    )
    .map((d) => `extensions/${d.name}/index.ts`),
  "web/extensions/web-mode-gate.ts",
];
// On Windows the real resolver already splits spellings, so run it unpatched
// there; CI's windows-latest leg is then the one check against the real thing.
const SIMULATE_WIN32 = process.platform !== "win32";

function moduleLoads(entry: string, simulateWin32: boolean): Record<string, number> {
  const args = [FIXTURE, entry, ...(simulateWin32 ? ["--simulate-win32"] : [])];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf-8" }));
}

describe("extension module identity under pi's loader", () => {
  it.each(ENTRIES)(
    "evaluates each module of %s once with Windows-style resolution",
    (entry) => {
      const loads = moduleLoads(entry, SIMULATE_WIN32);
      expect(Object.keys(loads).length).toBeGreaterThan(0);
      const duplicated = Object.entries(loads).filter(([, n]) => n > 1);
      expect(
        duplicated,
        "a module was imported as both ./x and ./x.js; import relative .ts files without .js (#649)",
      ).toEqual([]);
    },
    60_000,
  );

  // If a jiti or pi bump moves the .js -> .ts fallback off Module._resolveFilename,
  // the simulation goes inert and every case above passes whatever the spelling.
  it("still splits a module imported as both ./b and ./b.js (simulation has teeth)", () => {
    const control = "tests/fixtures/mixed-specifiers/index.ts";
    const b = "tests/fixtures/mixed-specifiers/b.ts";
    if (SIMULATE_WIN32) expect(moduleLoads(control, false)[b]).toBe(1);
    expect(
      moduleLoads(control, SIMULATE_WIN32)[b],
      SIMULATE_WIN32
        ? "the win32 simulation no longer splits ./b from ./b.js; jiti or pi moved the .js -> .ts fallback"
        : "the real Windows resolver no longer splits ./b from ./b.js; jiti may now normalize paths",
    ).toBe(2);
  }, 60_000);

  it("loads state.ts exactly once for the orbit extension", () => {
    expect(
      moduleLoads("extensions/orbit/index.ts", SIMULATE_WIN32)["extensions/orbit/state.ts"],
    ).toBe(1);
  }, 60_000);

  // The load test only sees a split once both spellings meet in one graph, so
  // a lone new `./x.js` would pass until someone else imports `./x`. Catch it here.
  it("never spells a relative .ts import with .js", () => {
    const specifier = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)\.js["']/g;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name !== "node_modules" && d.name !== "vendor") walk(full);
        } else if (d.name.endsWith(".ts")) {
          for (const [, base] of fs.readFileSync(full, "utf-8").matchAll(specifier)) {
            const target = path.resolve(dir, base);
            if (!fs.existsSync(`${target}.js`) && fs.existsSync(`${target}.ts`)) {
              offenders.push(`${path.relative(REPO_ROOT, full)}: ${base}.js`);
            }
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, "extensions"));
    walk(path.join(REPO_ROOT, "web", "extensions"));
    expect(offenders, "import relative .ts files without .js (#649)").toEqual([]);
  });
});
