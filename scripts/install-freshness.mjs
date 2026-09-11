// Fail fast when node_modules is older than the lockfile that describes it.
//
// This is the developer-machine half of the drift problem that
// check-version-lockstep.mjs guards in CI. That script asks "do the two
// lockfiles agree?"; this one asks "does what is actually on disk match the
// lockfile at all?" CI never sees this failure -- it runs `npm ci` into a clean
// runner every time -- but a local checkout can sit for months on a stale
// install, and worktrees make it worse: `.worktrees/*/node_modules` is a symlink
// to the root checkout, so ONE stale install silently poisons every branch.
//
// Scoped to the pi packages, same reasoning as the lockstep check: a stale
// prettier is harmless, a stale pi is a wall of failures in unrelated tests.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCOPE = "@earendil-works/";
const NM = "node_modules/";

/**
 * Versions the lockfile says this tree should have, top level only -- a nested
 * copy under another package is a different question (that is lockstep's job).
 */
export function lockedVersions(lockfileText) {
  const lock = JSON.parse(lockfileText);
  const out = {};
  for (const [treePath, meta] of Object.entries(lock.packages ?? {})) {
    if (!treePath.startsWith(NM) || !meta?.version) continue;
    const name = treePath.slice(NM.length);
    if (!name.startsWith(SCOPE) || name.includes(NM)) continue;
    out[name] = meta.version;
  }
  return out;
}

/**
 * Compare lockfile-expected against on-disk for each tree. `installed: null`
 * means the tree has no node_modules at all -- not stale, just uninstalled,
 * which npm reports better than we can.
 */
export function findStaleInstalls(trees) {
  const stale = [];
  for (const { tree, locked, installed } of trees) {
    if (installed === null) continue;
    for (const [name, want] of Object.entries(locked)) {
      const have = installed[name] ?? null;
      if (have !== want) stale.push({ tree, name, locked: want, installed: have });
    }
  }
  return stale;
}

export function formatStaleReport(stale) {
  const lines = ["", "Your node_modules is out of date with package-lock.json.", ""];
  for (const { tree, name, locked, installed } of stale) {
    const have = installed === null ? "not installed" : installed;
    lines.push(`  ${tree}: ${name}  lockfile ${locked}, on disk ${have}`);
  }
  lines.push(
    "",
    "Left alone this surfaces as a wall of failures in tests that have nothing",
    "to do with your change. Fix it with:",
    "",
    "  npm ci && (cd app && npm ci)",
    "",
    "In a worktree, node_modules is a symlink to the root checkout, so run that",
    "there -- one stale install affects every branch you have open at once.",
    "",
    "That cuts both ways: if it is THIS branch that changed a dependency, the",
    "root's lockfile cannot satisfy it. Install against this branch in the root",
    "checkout, or give the worktree its own node_modules.",
    "",
    "To run the tests anyway, set LOOM_SKIP_INSTALL_CHECK=1.",
    "",
  );
  return lines.join("\n");
}

function readTree(root, tree, subdir) {
  const base = subdir ? join(root, subdir) : root;
  const lockfile = join(base, "package-lock.json");
  if (!existsSync(lockfile)) return null;
  const locked = lockedVersions(readFileSync(lockfile, "utf-8"));
  const modules = join(base, "node_modules");
  if (!existsSync(modules)) return { tree, locked, installed: null };
  const installed = {};
  for (const name of Object.keys(locked)) {
    const pkg = join(modules, ...name.split("/"), "package.json");
    if (existsSync(pkg)) installed[name] = JSON.parse(readFileSync(pkg, "utf-8")).version;
  }
  return { tree, locked, installed };
}

// Only run the filesystem check when invoked directly, so the pure helpers
// above stay importable from tests.
//
// Both sides get realpath'd first. Node resolves symlinks for the ESM entry
// behind import.meta.url but only path-resolves argv[1], so comparing them raw
// makes this whole block a silent no-op whenever the checkout is reached
// through a symlink -- a symlinked home or work directory, or /tmp on macOS.
// Failing open there is the worst outcome available: no check, and no line of
// output saying the check did not happen.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  // An escape hatch, because one worktree case has no in-band fix: a branch
  // that changes the lockfile cannot be satisfied by the root checkout's
  // shared node_modules, and reinstalling there only moves the breakage onto
  // whatever branch the root has checked out. Loud rather than silent, so a
  // skip left set in a shell never gets mistaken for a pass.
  if (process.env.LOOM_SKIP_INSTALL_CHECK) {
    console.error("install freshness check skipped (LOOM_SKIP_INSTALL_CHECK is set)");
  } else {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const trees = [readTree(root, "root", null), readTree(root, "app", "app")].filter(Boolean);
    const stale = findStaleInstalls(trees);
    if (stale.length > 0) {
      console.error(formatStaleReport(stale));
      process.exit(1);
    }
  }
}
