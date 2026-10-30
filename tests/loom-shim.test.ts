import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The shim resolves @galaxyproject/orbit from where it is installed, so the
// test lays out a real-looking node_modules with the shim beside a fake Orbit
// whose only job is to report its argv and die the way the test asks.
const SHIM_SRC = path.resolve(import.meta.dirname, "..", "packages", "loom-shim");
const NOTICE = "Loom is now Orbit";
const posixOnly = process.platform === "win32" ? it.skip : it;

const FAKE_ORBIT = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify(args));
if (args[0] === "exit") process.exit(Number(args[1]));
if (args[0] === "signal") {
  process.kill(process.pid, args[1]);
  setTimeout(() => {}, 5000);
}
`;

let root: string;
let shim: string;

function install(withOrbit: boolean) {
  const scope = path.join(root, "node_modules", "@galaxyproject");
  fs.cpSync(SHIM_SRC, path.join(scope, "loom"), { recursive: true });
  shim = path.join(scope, "loom", "bin", "loom.js");
  if (!withOrbit) return;
  const orbit = path.join(scope, "orbit");
  fs.mkdirSync(path.join(orbit, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(orbit, "package.json"),
    '{"name":"@galaxyproject/orbit","version":"9.9.9"}',
  );
  fs.writeFileSync(path.join(orbit, "bin", "orbit.js"), FAKE_ORBIT, { mode: 0o755 });
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [shim, ...args], { encoding: "utf-8", timeout: 10_000 });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shim-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the @galaxyproject/loom shim", () => {
  it("prints the notice once, forwards argv verbatim and passes the exit code through", () => {
    install(true);
    const r = run("exit", "3", "--flag", "some value", "--", "x");
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual(["exit", "3", "--flag", "some value", "--", "x"]);
    expect(r.stderr.split(NOTICE)).toHaveLength(2);
    expect(r.stderr).toContain("npm install -g @galaxyproject/orbit");
  });

  it("exits 0 with no arguments when Orbit does", () => {
    install(true);
    const r = run();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("explains itself and exits 1 when Orbit is not installed beside it", () => {
    install(false);
    const r = run("--version");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(NOTICE);
    expect(r.stderr).toContain("not installed");
    expect(r.stdout).toBe("");
  });

  posixOnly("dies by the same signal Orbit died by, rather than exiting 0", () => {
    install(true);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      const r = run("signal", signal);
      expect(r.status, signal).not.toBe(0);
      expect(r.signal ?? `exit ${r.status}`, signal).toBe(signal);
    }
  });

  it("depends on an open-ended Orbit range, since it is published once and never again", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SHIM_SRC, "package.json"), "utf-8"));
    expect(pkg.name).toBe("@galaxyproject/loom");
    expect(pkg.bin).toEqual({ loom: "./bin/loom.js" });
    expect(pkg.dependencies["@galaxyproject/orbit"]).toMatch(/^>=\d/);
  });
});
