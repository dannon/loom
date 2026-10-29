#!/usr/bin/env node

// The last @galaxyproject/loom release. Loom became Orbit in 0.9, and this
// package exists so an ordinary `npm update -g` keeps a `loom` command working
// while people move over: it runs the Orbit CLI it depends on with the same
// argv, after one line saying where to go. Nothing else lives here.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import os from "node:os";

const NOTICE = "Loom is now Orbit -- run `orbit` instead (npm install -g @galaxyproject/orbit).";

const require = createRequire(import.meta.url);

let orbitBin;
try {
  orbitBin = require.resolve("@galaxyproject/orbit/bin/orbit.js");
} catch {
  process.stderr.write(
    `loom: ${NOTICE}\nloom: @galaxyproject/orbit is not installed next to this shim.\n`,
  );
  process.exit(1);
}

process.stderr.write(`${NOTICE}\n`);

const child = spawn(process.execPath, [orbitBin, ...process.argv.slice(2)], { stdio: "inherit" });

// Ctrl-C reaches the child through the terminal's process group already, and
// forwarding it too would hand pi a second SIGINT, so the shim just stays
// alive until the child is done. (A SIGINT aimed at the shim's pid alone is
// therefore not passed on; that is the trade.) Signals sent to the shim itself
// by a `kill` or a closing terminal are forwarded.
const FORWARDED = ["SIGTERM", "SIGHUP"];
process.on("SIGINT", () => {});
for (const signal of FORWARDED) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (err) => {
  process.stderr.write(`loom: could not start Orbit: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Die the same way. The forwarder for this signal has to go first or it
    // would catch the re-raise and the shim would exit 0 instead.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 1);
});
