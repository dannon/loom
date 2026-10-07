import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSessionRegistry,
  getSessionRegistry,
  openSessionRegistry,
} from "../extensions/loom/registry-runtime";
import { approveProposal } from "../extensions/loom/registry-proposal";
import { RegistryStore } from "../extensions/loom/registry";
import { SERVER, tmpAnalysisDir } from "./registry-fixtures";
import { TOOL_SNAPSHOT, toolProposal } from "./registry-proposal-fixtures";

let dir: string;

function activityKinds(): Array<Record<string, any>> {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function open(sessionId = "s-a") {
  return openSessionRegistry({
    analysisDir: dir,
    sessionId,
    serverUrl: SERVER,
    heartbeatMs: null,
  });
}

beforeEach(() => {
  dir = tmpAnalysisDir();
});
afterEach(() => {
  closeSessionRegistry();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("session registry", () => {
  it("opens as the writer under .loom/state and says nothing when all is well", () => {
    const { session, outcome, notice } = open();
    expect(session.store.mode).toBe("writer");
    expect(outcome).toEqual({ kind: "empty" });
    expect(notice).toBeNull();
    expect(fs.existsSync(path.join(dir, ".loom", "state", "lock"))).toBe(true);
    expect(getSessionRegistry()).toBe(session);
    expect(activityKinds()).toEqual([
      expect.objectContaining({
        kind: "registry.opened",
        payload: expect.objectContaining({ mode: "writer", outcome: "empty" }),
      }),
    ]);
  });

  it("releases the lock on close", () => {
    open();
    closeSessionRegistry();
    expect(fs.existsSync(path.join(dir, ".loom", "state", "lock"))).toBe(false);
    expect(getSessionRegistry()).toBeNull();
  });

  it("degrades to read-only with one notice when another live session holds it", () => {
    const other = new RegistryStore({
      analysisDir: dir,
      serverUrl: SERVER,
      sessionId: "s-other",
      fs,
      clock: Date.now,
      pid: 4242,
    });
    other.open();
    const { session, notice } = open("s-a");
    expect(session.store.mode).toBe("read-only");
    expect(notice).toMatch(/s-other.*read-only.*\/approve and \/revoke will refuse/s);
    other.close();
  });

  it("degrades to read-only, without throwing, when the state dir can't be created", () => {
    // A file where the .loom directory should be.
    fs.writeFileSync(path.join(dir, ".loom"), "not a directory");
    const { session, outcome, notice } = open();
    expect(session.store.mode).toBe("read-only");
    expect(session.unavailable).toBeTruthy();
    expect(outcome).toBeNull();
    expect(notice).toMatch(/couldn't be opened.*read-only/);
    expect(activityKinds()[0].payload).toMatchObject({ outcome: "unavailable" });
  });

  it("says when approvals from an earlier session came back restored", () => {
    const { session } = open("s-a");
    const r = approveProposal(session.store, {
      proposal: toolProposal(),
      snapshot: TOOL_SNAPSHOT,
      assertionDefinitions: new Map(),
      now: "2026-10-07T12:00:00Z",
    });
    expect(r.ok).toBe(true);
    closeSessionRegistry();
    const next = open("s-b");
    expect(next.outcome?.kind).toBe("imported");
    expect(next.notice).toMatch(/1 approval\(s\) from an earlier session were restored, not live/);
  });

  it("says when the file on disk was unreadable and set aside", () => {
    fs.mkdirSync(path.join(dir, ".loom", "state"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".loom", "state", "registry.json"), "{nope");
    const { session, notice } = open();
    expect(session.store.mode).toBe("writer");
    expect(notice).toMatch(/unreadable.*set aside/);
  });
});
