// Fail the release if root and app/ package.json versions disagree -- the CLI's
// --version must never report a different number than the Orbit build shipped
// alongside it.
//
// Also fail if the two trees resolve a pi runtime package to different versions.
// app/ installs separately from the root project (it is not a workspace), so each
// keeps its own copy: when the ranges disagree, both versions land on disk and a
// bare import resolves to a *different module instance* depending on who imports
// it. Anything pi keeps in module-level state then splits in two, silently. That
// is not hypothetical -- Orbit pinned pi-ai ^0.83.0 while pi-coding-agent pulled
// ^0.84.1, so registering pi's bundled OAuth flows set the flag on one instance
// while ModelRuntime read the other, and every OAuth sign-in failed with an
// unresolvable module path. Nothing caught it until it broke at runtime.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootV = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
const appV = JSON.parse(readFileSync(join(root, "app", "package.json"), "utf-8")).version;

if (rootV !== appV) {
  console.error(`Version mismatch: root package.json is ${rootV} but app/package.json is ${appV}.`);
  process.exit(1);
}
console.log(`Versions in lockstep: ${rootV}`);

// Scoped to the pi packages on purpose. A duplicated prettier or typescript is
// harmless; a duplicated pi package means two module instances in one process.
const SCOPE = "@earendil-works/";
const NM = "node_modules/";

/** name -> version -> Set of "<lockfile>:<path in tree>" */
const resolved = new Map();

for (const lockfile of ["package-lock.json", join("app", "package-lock.json")]) {
  const lock = JSON.parse(readFileSync(join(root, lockfile), "utf-8"));
  for (const [treePath, meta] of Object.entries(lock.packages ?? {})) {
    const at = treePath.lastIndexOf(NM);
    if (at === -1 || !meta?.version) continue;
    const name = treePath.slice(at + NM.length);
    if (!name.startsWith(SCOPE)) continue;
    const byVersion = resolved.get(name) ?? new Map();
    const sites = byVersion.get(meta.version) ?? new Set();
    sites.add(`${lockfile} -> ${treePath}`);
    byVersion.set(meta.version, sites);
    resolved.set(name, byVersion);
  }
}

const split = [...resolved].filter(([, byVersion]) => byVersion.size > 1);

if (split.length > 0) {
  console.error(
    "Split pi dependency: the root and app/ trees resolve the same package to different versions.\n" +
      "Two copies on disk means two module instances, and any module-level state splits in two.\n",
  );
  for (const [name, byVersion] of split) {
    console.error(`  ${name}`);
    for (const [version, sites] of byVersion) {
      for (const site of sites) console.error(`    ${version.padEnd(12)} ${site}`);
    }
  }
  console.error(
    "\nAlign the ranges in package.json / app/package.json, reinstall so both lockfiles\n" +
      "agree, and consider resolve.dedupe in app/vite.main.config.ts for anything bundled.",
  );
  process.exit(1);
}

const checked = [...resolved.keys()].sort();
console.log(
  checked.length > 0
    ? `pi dependencies single-instance across root and app/: ${checked.join(", ")}`
    : "No pi dependencies found to cross-check.",
);
