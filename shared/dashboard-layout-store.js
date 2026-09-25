/**
 * The layout file, read and written the same way by everything that touches it.
 *
 * Three processes write `.loom-dashboard.json`: the Electron main process on the
 * renderer's behalf, the web server on the browser's behalf, and the brain. Each
 * had its own copy of "lstat, read, compare the revision, stage a temp file,
 * rename", and hand-mirrored copies drift -- one of them followed a dangling
 * symlink the others refused, and none of them was a compare-and-swap.
 *
 * It was not a compare-and-swap because the check and the rename were separated
 * by an `await`. Two saves based on the same revision both passed the check and
 * both reported success, and the second silently replaced the first: reproduced
 * three times out of three against a real directory. Serializing per path inside
 * the process and re-checking immediately before the rename closes that.
 *
 * **The promise chain serializes one process.** The shell and the brain are two,
 * and two processes that both pass the revision check on the same base both
 * rename, both report success, and the later rename silently discards the
 * earlier write -- reproduced with two instances of this module. So the lock is
 * also a lock FILE beside the layout, created with O_EXCL and held for the
 * critical section; every writer in every process goes through `withLayoutLock`,
 * so the file is the one thing they all agree on. A lock left behind by a
 * process that died is taken over once it is stale.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { dashboardRevision } from "./dashboard-contract.js";

/**
 * One promise chain per absolute path. Every save on a path queues behind the
 * previous one, so the read-check-rename below is a critical section rather
 * than three syscalls that happen to be near each other.
 */
const chains = new Map();

/**
 * How long a lock file may sit before another process takes it over. The
 * critical section is a few small reads and one rename, so anything holding it
 * this long is gone; the risk of taking over a live one is a lost write, which
 * is what the lock exists to prevent, so this errs long.
 */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

function lockPathFor(absPath) {
  return `${absPath}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take the lock file, or throw once the wait runs out.
 *
 * `wx` is O_CREAT | O_EXCL: the create either makes the file or fails, and it
 * fails on a symlink at that name too, so a planted link cannot stand in for
 * the lock. A stale file -- by its own mtime -- is removed and the create
 * retried; `rm` on a symlink removes the link, never what it points at.
 */
async function acquireLockFile(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = await fsp.open(lockPath, "wx");
      await fd.close();
      return;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    try {
      const st = await fsp.lstat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lockPath, { force: true });
        continue;
      }
    } catch {
      // Gone between the failed create and the lstat: the holder released it.
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another process is writing the dashboard layout; try again");
    }
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Run `fn` with nothing else on this path running at the same time -- in this
 * process, by the promise chain, and in any other, by the lock file.
 */
export function withLayoutLock(absPath, fn) {
  const key = path.resolve(absPath);
  const previous = chains.get(key) ?? Promise.resolve();
  const lockPath = lockPathFor(key);
  const locked = async () => {
    await acquireLockFile(lockPath);
    try {
      return await fn();
    } finally {
      await fsp.rm(lockPath, { force: true }).catch(() => {});
    }
  };
  // Settle either way: one caller's failure must not wedge the queue behind it.
  const run = previous.then(locked, locked);
  const settled = run.then(
    () => {},
    () => {},
  );
  chains.set(key, settled);
  // Drop the entry once nothing is waiting, so a long session switching
  // analysis directories does not accumulate one chain per directory.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/** For tests: is anything queued? */
export function layoutLockIdle() {
  return chains.size === 0;
}

/**
 * Read the layout file, through a descriptor.
 *
 * `lstat` first, and on the link itself rather than its target: a dangling
 * symlink has to read as "there is a symlink here", not as "there is no file
 * here". The web shell used `existsSync`, which follows the link and therefore
 * called a dangling one absent -- so it then replaced it while the desktop
 * refused, which is the drift this module exists to end.
 *
 * Then the open, with O_NOFOLLOW, and everything after it on the descriptor:
 * the agent can write in this directory, and a symlink swapped in between the
 * `lstat` and a read by name is followed by the read. Reviewers won that race
 * against the plain `readFile` this used to be, and the bytes of whatever the
 * link pointed at came back down the layout channel. The kernel refuses the
 * link at open time; the `fstat` after it has to agree with the `lstat` before
 * it on identity, regular-file-ness and size; and the read itself stops at the
 * cap plus one byte, so a file that grows after the `fstat` is refused rather
 * than served. On Windows there is no O_NOFOLLOW and the identity check is what
 * remains.
 */
export async function readLayoutFile(absPath, maxBytes) {
  let stat;
  try {
    stat = await fsp.lstat(absPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, raw: null, revision: null };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const name = path.basename(absPath);
  if (stat.isSymbolicLink()) {
    return { ok: false, error: `${name} is a symlink; refusing to read` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `${name} is not a regular file` };
  }
  // Checked before the open, so an oversized file is never pulled into memory --
  // it used to come back whole inside a conflict response.
  if (stat.size > maxBytes) {
    return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
  }

  let fd;
  try {
    fd = await fsp.open(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    // Removed between the two: that is "no file", the same as before the lstat.
    if (err?.code === "ENOENT") return { ok: true, raw: null, revision: null };
    // ELOOP is a symlink swapped in after the lstat: the race, refused.
    if (err?.code === "ELOOP")
      return { ok: false, error: `${name} is a symlink; refusing to read` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const st = await fd.stat();
    if (!st.isFile()) return { ok: false, error: `${name} is not a regular file` };
    if (!sameIdentity(stat, st)) {
      return { ok: false, error: `${name} changed while it was being read` };
    }
    if (st.size > maxBytes) {
      return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
    }
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fd.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
    }
    const raw = buf.subarray(0, total).toString("utf8");
    return { ok: true, raw, revision: dashboardRevision(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * Is the descriptor the file the lstat saw? Inode and device settle it where
 * the platform reports them; a filesystem that reports zero for either gets no
 * check, which is the Windows fallback rather than a refusal of every read.
 */
function sameIdentity(a, b) {
  if (!a.ino || !b.ino) return true;
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Replace the layout file if it still has the revision the caller based its
 * change on.
 *
 * `baseRevision === undefined` means an unconditional write -- the escape hatch
 * for a reset over a file nothing can parse. `null` means "there should be no
 * file yet" and is checked like any other revision.
 */
export async function casWriteLayoutFile(absPath, raw, baseRevision, maxBytes) {
  if (typeof raw !== "string") return { ok: false, error: "expected dashboard JSON text" };
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, error: `dashboard layout is larger than ${maxBytes} bytes` };
  }

  try {
    return await withLayoutLock(absPath, async () => {
      const current = await readLayoutFile(absPath, maxBytes);
      if (!current.ok) return current;
      if (baseRevision !== undefined && baseRevision !== current.revision) {
        return {
          ok: false,
          conflict: true,
          error: "the dashboard changed on disk since it was loaded",
          raw: current.raw,
          revision: current.revision,
        };
      }

      // Stage first, then re-check, then rename with nothing awaited in between.
      // The scratch name is random and the write is `wx` (O_CREAT | O_EXCL) for
      // the same reason the real name is lstat'd: the agent can write in this
      // directory, and a guessable scratch name is a second place to plant a
      // symlink that the following write would go through.
      const tmp = `${absPath}.tmp.${randomBytes(8).toString("hex")}`;
      try {
        await fsp.writeFile(tmp, raw, { encoding: "utf8", flag: "wx" });
        const before = await readLayoutFile(absPath, maxBytes);
        if (!before.ok) {
          await fsp.rm(tmp, { force: true });
          return before;
        }
        if (baseRevision !== undefined && baseRevision !== before.revision) {
          await fsp.rm(tmp, { force: true });
          return {
            ok: false,
            conflict: true,
            error: "the dashboard changed on disk since it was loaded",
            raw: before.raw,
            revision: before.revision,
          };
        }
        await fsp.rename(tmp, absPath);
        return { ok: true, revision: dashboardRevision(raw) };
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
