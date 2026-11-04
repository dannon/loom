// Loads one extension entry the way pi does (its own jiti, moduleCache: false)
// and prints how many times each of this repo's .ts modules was evaluated, as
// JSON keyed by repo-relative path. node_modules is out of scope.
//
// With moduleCache off, jiti's only dedupe is a per-load cache keyed by the
// resolved filename string. A `./x` specifier resolves through mlly, which
// spells the path with forward slashes; a `./x.js` specifier pointing at
// x.ts misses mlly and falls back to Node's require.resolve, which on Windows
// spells it with backslashes. Same file, two keys, two module instances (#649).
// `--simulate-win32` reproduces that on POSIX by making Node's resolver spell
// repo paths differently (a harmless `./` segment) from mlly.
//
// Run as a child process so vitest's own module hooks stay out of the way.

import fs from "fs";
import Module from "module";
import path from "path";
import { fileURLToPath } from "url";

const [entry, flag] = process.argv.slice(2);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootPrefix = repoRoot + path.sep;
const nodeModules = path.sep + "node_modules" + path.sep;
const inScope = (file) => file.startsWith(rootPrefix) && !file.includes(nodeModules);

if (flag === "--simulate-win32") {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (...args) {
    const resolved = resolve.apply(this, args);
    return inScope(resolved)
      ? rootPrefix + "." + path.sep + resolved.slice(rootPrefix.length)
      : resolved;
  };
}

// jiti reads each module's source with fs.readFileSync right before it
// evaluates it, so one read per canonical path is one module instance.
const loads = {};
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  if (typeof file === "string" && file.endsWith(".ts")) {
    const canonical = path.resolve(file);
    if (inScope(canonical)) {
      const key = path.relative(repoRoot, canonical).split(path.sep).join("/");
      loads[key] = (loads[key] ?? 0) + 1;
    }
  }
  return readFileSync.call(this, file, ...rest);
};

// Use the jiti pi itself resolves, so a pi bump that changes loaders is covered.
const piRequire = Module.createRequire(
  path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

jiti
  .import(path.join(repoRoot, entry), { default: true })
  .then(() => process.stdout.write(JSON.stringify(loads)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
