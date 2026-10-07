import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryLock, STALE_LOCK_MS } from "../extensions/loom/registry-lock";
import { T0, tmpAnalysisDir } from "./registry-fixtures";

describe("RegistryLock", () => {
  let dir: string;
  let lockPath: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = tmpAnalysisDir();
    lockPath = path.join(dir, "lock");
    now = T0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const lock = (pid: number, session: string) =>
    new RegistryLock(lockPath, fs, clock, pid, session);

  it("gives the first session the writer role and records who holds it", () => {
    const a = lock(1, "s-a");
    const got = a.acquire();
    expect(got.mode).toBe("writer");
    const onDisk = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(onDisk).toMatchObject({ pid: 1, session_id: "s-a" });
    expect(onDisk.writer_token).toBe(a.heldToken);
    expect(onDisk.heartbeat).toBe(new Date(T0).toISOString());
  });

  it("opens a second live session read-only", () => {
    lock(1, "s-a").acquire();
    const b = lock(2, "s-b").acquire();
    expect(b).toMatchObject({ mode: "read-only", holder: { session_id: "s-a" } });
  });

  it("does not take over a lock that is exactly at the staleness limit", () => {
    lock(1, "s-a").acquire();
    now = T0 + STALE_LOCK_MS;
    expect(lock(2, "s-b").acquire().mode).toBe("read-only");
  });

  it("takes over a lock with no heartbeat for 120 s, with a new token", () => {
    const a = lock(1, "s-a");
    a.acquire();
    const oldToken = a.heldToken;
    now = T0 + STALE_LOCK_MS + 1;
    const b = lock(2, "s-b");
    const got = b.acquire();
    expect(got).toMatchObject({ mode: "writer", tookOverFrom: { session_id: "s-a" } });
    expect(b.heldToken).not.toBe(oldToken);
  });

  it("fences the old writer: its heartbeat fails and it gives up the role", () => {
    const a = lock(1, "s-a");
    a.acquire();
    now = T0 + STALE_LOCK_MS + 1;
    lock(2, "s-b").acquire();
    expect(a.stillHeld()).toBe(false);
    expect(a.heartbeat()).toBe(false);
    expect(a.heldToken).toBeNull();
    // and it didn't clobber the new holder's lock on the way out
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).session_id).toBe("s-b");
  });

  it("keeps a lock alive with heartbeats", () => {
    const a = lock(1, "s-a");
    a.acquire();
    now = T0 + STALE_LOCK_MS - 1;
    expect(a.heartbeat()).toBe(true);
    now = T0 + 2 * STALE_LOCK_MS - 2;
    expect(lock(2, "s-b").acquire().mode).toBe("read-only");
  });

  it("treats an unreadable lock as stale", () => {
    fs.writeFileSync(lockPath, "{not json");
    expect(lock(2, "s-b").acquire().mode).toBe("writer");
  });

  it("releases only its own lock", () => {
    const a = lock(1, "s-a");
    a.acquire();
    now = T0 + STALE_LOCK_MS + 1;
    lock(2, "s-b").acquire();
    a.release();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("retries a busy rename on win32 when refreshing the heartbeat, and not elsewhere", () => {
    const busyFs = (failures: number) => {
      let left = failures;
      return {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (left-- > 0) throw Object.assign(new Error("EBUSY: busy"), { code: "EBUSY" });
          fs.renameSync(from, to);
        },
      };
    };
    const win = new RegistryLock(lockPath, busyFs(2), clock, 1, "s-a", "win32");
    win.acquire();
    now += 1000;
    expect(win.heartbeat()).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).heartbeat).toBe(
      new Date(now).toISOString(),
    );
    win.release();

    const posix = new RegistryLock(lockPath, busyFs(1), clock, 1, "s-b", "linux");
    posix.acquire();
    expect(() => posix.heartbeat()).toThrow(/EBUSY/);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
