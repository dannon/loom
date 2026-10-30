/**
 * Where the brain keeps its global state (config.json, caches, the session
 * index, the what's-new stamp). Historically ~/.loom; moving to ~/.orbit.
 *
 * Every caller that needs a path under that dir resolves it here rather than
 * joining homedir() with ".loom" itself, so the move is one switch and a
 * ~/.orbit/config.json written by a newer release is honored by this one.
 *
 * ~/.orbit also holds desktop-only shell state (window-state.json and the
 * desktop's own version-check.json); nothing here touches those.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Off for the compatibility release: ~/.orbit is used only if a newer release
// already put a config there, and nothing is copied. On since the rename
// release: the first run copies config.json (encrypted fields intact, mode
// 0600) and the user's other durable state into ~/.orbit, leaves a
// MOVED-TO-ORBIT.txt marker behind, and ~/.orbit is the default for new installs. ~/.loom/analyses stays where it is (see
// resolveDefaultAnalysesDir).
export const MIGRATE_TO_ORBIT_STATE_DIR = true;

export const MOVED_MARKER_FILE = "MOVED-TO-ORBIT.txt";
const CONFIG_FILE = "config.json";
// Carried across on migration besides config.json: what the user accumulated
// and could not get back. Caches, the session index and the version-check
// cache rebuild themselves and stay behind, as does analyses/ (see
// resolveDefaultAnalysesDir).
const MIGRATED_FILES = [
  "whats-new-seen.json",
  "upload-resume.json",
  "feedback-outbox.jsonl",
  "observations-outbox.jsonl",
  "observations-sent.jsonl",
  "observations-tokens.json",
];
const MIGRATED_DIRS = ["lessons", "lesson-drafts"];
// Holds a credential or a secret token: copied at 0600 whatever the source had.
const PRIVATE_FILES = new Set([CONFIG_FILE, "observations-tokens.json"]);

/**
 * @typedef {{ home?: string, migrate?: boolean }} StateDirOptions
 */

function homeOf(opts) {
  return opts?.home ?? os.homedir();
}

/** @param {string} [home] */
export function legacyStateDir(home = os.homedir()) {
  return path.join(home, ".loom");
}

/** @param {string} [home] */
export function orbitStateDir(home = os.homedir()) {
  return path.join(home, ".orbit");
}

/**
 * ~/.orbit once it holds a config.json, else ~/.loom -- until migration is on,
 * after which only an unmigrated ~/.loom/config.json keeps a user on the old
 * dir.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveStateDir(opts = {}) {
  const home = homeOf(opts);
  const orbit = orbitStateDir(home);
  if (fs.existsSync(path.join(orbit, CONFIG_FILE))) return orbit;
  const legacy = legacyStateDir(home);
  if (!(opts.migrate ?? MIGRATE_TO_ORBIT_STATE_DIR)) return legacy;
  return fs.existsSync(path.join(legacy, CONFIG_FILE)) ? legacy : orbit;
}

/** @param {StateDirOptions} [opts] */
export function resolveConfigPath(opts = {}) {
  return path.join(resolveStateDir(opts), CONFIG_FILE);
}

/**
 * The CLI's npm version-check cache. ~/.orbit/version-check.json already
 * belongs to the desktop's GitHub release check, so anywhere but the legacy
 * dir the CLI uses its own name.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveCliVersionCheckPath(opts = {}) {
  const dir = resolveStateDir(opts);
  const name =
    dir === legacyStateDir(homeOf(opts)) ? "version-check.json" : "cli-version-check.json";
  return path.join(dir, name);
}

/**
 * Where a new analysis goes when nothing is configured. ~/.loom/analyses is
 * real user data that is never moved, and pi keys session history by absolute
 * cwd, so an existing one keeps winning until ~/.orbit/analyses appears.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveDefaultAnalysesDir(opts = {}) {
  const home = homeOf(opts);
  const legacy = path.join(legacyStateDir(home), "analyses");
  const orbit = path.join(orbitStateDir(home), "analyses");
  if (fs.existsSync(legacy) && !fs.existsSync(orbit)) return legacy;
  return path.join(resolveStateDir(opts), "analyses");
}

function movedNotice(legacyDir, orbitDir, when) {
  return `Loom is now Orbit, and its settings live in ${orbitDir} now.

On ${when} Orbit copied config.json, saved lessons and drafts, the observation
and feedback outboxes and the what's-new stamp from this directory to
${orbitDir}. From now on it reads ${path.join(orbitDir, CONFIG_FILE)}
and ignores ${path.join(legacyDir, CONFIG_FILE)}, so changes made to the copy here
have no effect. Saved API keys were copied as-is and keep working. Caches and
the session index were not copied; they rebuild on their own.

Nothing here was deleted. Analyses under ${path.join(legacyDir, "analyses")} stay
where they are, and Orbit keeps opening them. Loom releases older than 0.9
still read the old config.json here. Once you no longer run one, the rest of
this directory apart from analyses/ is safe to remove.
`;
}

// Stage the bytes beside the destination, then hard-link into place: link()
// refuses to replace an existing file, so a second process migrating at the
// same moment can't overwrite a config the first one already copied and the
// user has since changed.
function copyNoClobber(src, dest, mode) {
  const bytes = fs.readFileSync(src);
  const tmp = `${dest}.migrating-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    // writeFileSync on a descriptor loops until every byte is down; a short
    // writeSync would otherwise be fsynced and linked into place as the config.
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.statSync(tmp).size !== bytes.length) throw new Error(`short write staging ${dest}`);
    fs.chmodSync(tmp, mode);
    try {
      fs.linkSync(tmp, dest);
      return true;
    } catch (err) {
      if (err?.code === "EEXIST") return false;
      // Filesystems without hard links: an exclusive copy keeps the no-clobber
      // guarantee (a rename after an existence check would not).
      try {
        fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
        return true;
      } catch (copyErr) {
        if (copyErr?.code === "EEXIST") return false;
        throw copyErr;
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function modeFor(name, src) {
  return PRIVATE_FILES.has(name) ? 0o600 : fs.statSync(src).mode & 0o777;
}

// Copies files that are missing on the destination side, so an interrupted
// migration picks up where it stopped. Symlinks are left alone: the lessons
// store refuses linked directories, and following one could copy anything.
function copyTreeNoClobber(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTreeNoClobber(src, dest);
    else if (entry.isFile() && !fs.existsSync(dest))
      copyNoClobber(src, dest, modeFor(entry.name, src));
  }
}

/**
 * One-time copy of ~/.loom's settings and durable state into ~/.orbit. Copies, never moves:
 * ~/.loom is left intact apart from a MOVED-TO-ORBIT.txt explaining where
 * things went. Safe to call on every startup.
 *
 * @param {StateDirOptions & { enabled?: boolean, now?: Date }} [opts]
 * @returns {{ status: "disabled" | "nothing-to-migrate" | "already-migrated" | "migrated" | "failed", error?: unknown }}
 */
export function migrateStateDir(opts = {}) {
  if (!(opts.enabled ?? MIGRATE_TO_ORBIT_STATE_DIR)) return { status: "disabled" };
  const home = homeOf(opts);
  const legacy = legacyStateDir(home);
  const orbit = orbitStateDir(home);
  const legacyConfig = path.join(legacy, CONFIG_FILE);
  const orbitConfig = path.join(orbit, CONFIG_FILE);
  const marker = path.join(legacy, MOVED_MARKER_FILE);
  const writeMarker = () => {
    try {
      fs.writeFileSync(marker, movedNotice(legacy, orbit, (opts.now ?? new Date()).toISOString()), {
        flag: "wx",
      });
    } catch {
      /* already there, or ~/.loom is read-only -- the copy still stands */
    }
  };

  if (!fs.existsSync(legacyConfig)) return { status: "nothing-to-migrate" };
  if (fs.existsSync(orbitConfig)) {
    writeMarker();
    return { status: "already-migrated" };
  }
  try {
    fs.mkdirSync(orbit, { recursive: true, mode: 0o700 });
    // Any failure here aborts before config.json is copied, so the user stays
    // on ~/.loom with everything intact and the next start tries again.
    for (const name of MIGRATED_FILES) {
      const src = path.join(legacy, name);
      if (!fs.existsSync(src) || fs.existsSync(path.join(orbit, name))) continue;
      copyNoClobber(src, path.join(orbit, name), modeFor(name, src));
    }
    for (const name of MIGRATED_DIRS) {
      const src = path.join(legacy, name);
      if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
        copyTreeNoClobber(src, path.join(orbit, name));
      }
    }
    // Last, because its presence is what switches resolveStateDir over.
    const copied = copyNoClobber(legacyConfig, orbitConfig, 0o600);
    writeMarker();
    return { status: copied ? "migrated" : "already-migrated" };
  } catch (error) {
    return { status: "failed", error };
  }
}
