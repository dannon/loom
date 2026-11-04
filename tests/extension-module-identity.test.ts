import { execFileSync } from "child_process";
import * as path from "path";
import { describe, expect, it } from "vitest";

// #649: on Windows, a module imported as both `./x` and `./x.js` was evaluated
// twice under pi's loader, so session_start set the notebook path on one copy
// of state.ts and loom_propose read the other. See the fixture for the why.
const FIXTURE = path.join(__dirname, "fixtures", "jiti-module-loads.mjs");
const ENTRIES = [
  "extensions/orbit/index.ts",
  "extensions/orbit-handoff/index.ts",
  "extensions/cli-update/index.ts",
  "extensions/whats-new/index.ts",
];

function moduleLoads(entry: string, simulateWin32: boolean): Record<string, number> {
  const args = [FIXTURE, entry, ...(simulateWin32 ? ["--simulate-win32"] : [])];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf-8" }));
}

describe("extension module identity under pi's loader", () => {
  it.each(ENTRIES)(
    "evaluates each module of %s once with Windows-style resolution",
    (entry) => {
      const loads = moduleLoads(entry, true);
      expect(Object.keys(loads).length).toBeGreaterThan(0);
      const duplicated = Object.entries(loads).filter(([, n]) => n > 1);
      expect(duplicated).toEqual([]);
    },
    60_000,
  );

  it("loads state.ts exactly once for the orbit extension", () => {
    expect(moduleLoads("extensions/orbit/index.ts", true)["orbit/state.ts"]).toBe(1);
  }, 60_000);
});
