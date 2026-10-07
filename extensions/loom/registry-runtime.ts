/**
 * The registry as the running brain holds it: one `RegistryStore` per
 * session, opened at session start under `<analysis>/.loom/state/` and closed
 * at shutdown.
 *
 * The store's signing key lives only in that object, so "this session's own
 * state" means "written by this process since session start". Anything on
 * disk from before -- an earlier session, a clone, a hand edit -- comes in
 * through the import rule: approvals restored, never live.
 *
 * A registry that cannot be opened never blocks the session. It degrades to
 * read-only with one notice, and the commands that would write say why they
 * can't.
 */

import * as fs from "fs";
import { appendActivityEvent } from "./activity";
import { RegistryStore, type LoadOutcome, type RegistryFs } from "./registry";

/** Well inside the lock's two-minute staleness limit. */
const HEARTBEAT_MS = 30_000;

export interface SessionRegistry {
  store: RegistryStore;
  analysisDir: string;
  /** Set when the store could not be opened at all; it stays read-only. */
  unavailable?: string;
}

let current: SessionRegistry | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

export function getSessionRegistry(): SessionRegistry | null {
  return current;
}

export interface OpenOptions {
  analysisDir: string;
  sessionId: string;
  serverUrl: string;
  fs?: RegistryFs;
  clock?: () => number;
  /** Tests turn the timer off. */
  heartbeatMs?: number | null;
}

/**
 * Open this session's registry, replacing any previous one. Returns the
 * notice the user should see, or null when there is nothing to say.
 */
export function openSessionRegistry(opts: OpenOptions): {
  session: SessionRegistry;
  outcome: LoadOutcome | null;
  notice: string | null;
} {
  closeSessionRegistry();
  const store = new RegistryStore({
    analysisDir: opts.analysisDir,
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
    fs: opts.fs ?? fs,
    clock: opts.clock ?? Date.now,
  });
  const session: SessionRegistry = { store, analysisDir: opts.analysisDir };
  let outcome: LoadOutcome | null = null;
  try {
    outcome = store.open();
  } catch (err) {
    session.unavailable = (err as Error).message;
    try {
      store.close();
    } catch {
      // nothing held
    }
  }
  current = session;

  const interval = opts.heartbeatMs === undefined ? HEARTBEAT_MS : opts.heartbeatMs;
  if (store.mode === "writer" && interval !== null) {
    heartbeat = setInterval(() => {
      try {
        // False means the lock was taken over and the store is read-only now.
        if (!store.heartbeat()) stopHeartbeat();
      } catch {
        // A failed beat (a busy rename, say) is retried on the next tick.
      }
    }, interval);
    heartbeat.unref?.();
  }

  const restored = Object.values(store.snapshot().attempts).filter(
    (a) => a.approval?.status === "restored",
  ).length;
  appendActivityEvent(opts.analysisDir, {
    timestamp: new Date().toISOString(),
    kind: "registry.opened",
    source: "harness",
    payload: {
      mode: store.mode,
      outcome: outcome?.kind ?? "unavailable",
      ...(session.unavailable ? { error: session.unavailable } : {}),
      restored_approvals: restored,
      notices: [...store.notices],
    },
  });
  return { session, outcome, notice: openNotice(session, outcome, restored) };
}

function openNotice(
  session: SessionRegistry,
  outcome: LoadOutcome | null,
  restored: number,
): string | null {
  const { store } = session;
  if (session.unavailable) {
    return (
      `The approval registry couldn't be opened (${session.unavailable}), so it is read-only ` +
      `this session: /approve and /revoke will refuse. Everything else works as usual.`
    );
  }
  if (store.mode === "read-only") {
    return (
      `${store.notices[store.notices.length - 1] ?? "The approval registry opened read-only."} ` +
      `/approve and /revoke will refuse in this session.`
    );
  }
  if (outcome?.kind === "rejected") {
    return `The approval registry on disk was unreadable (${outcome.reason}); it was set aside and this session starts a fresh one.`;
  }
  if (restored > 0) {
    return (
      `${restored} approval(s) from an earlier session were restored, not live -- an approval ` +
      `only counts in the session that recorded it. /pending lists them; /approve re-approves.`
    );
  }
  return null;
}

function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

export function closeSessionRegistry(): void {
  stopHeartbeat();
  if (current) {
    try {
      current.store.close();
    } catch {
      // best effort: a stale lock is taken over after two minutes anyway
    }
  }
  current = null;
}
