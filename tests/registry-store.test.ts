import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  MAX_REGISTRY_BYTES,
  RegistryFencedError,
  RegistryFormatError,
  RegistryReadOnlyError,
  RegistryStore,
  sha256Hex,
  STALE_LOCK_MS,
  type Attempt,
} from "../extensions/loom/registry";
import { ulid } from "../extensions/loom/ulid";
import {
  eligibleAttempt,
  OTHER_SERVER,
  SERVER,
  T0,
  tmpAnalysisDir,
  userException,
} from "./registry-fixtures";

let dir: string;
let now: number;
const clock = () => now;

function store(sessionId = "s-a", pid = 100, serverUrl = SERVER): RegistryStore {
  return new RegistryStore({ analysisDir: dir, serverUrl, sessionId, fs, clock, pid });
}

function onDisk(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".loom", "state", "registry.json"), "utf-8"));
}

function writeRaw(text: string) {
  fs.writeFileSync(path.join(dir, ".loom", "state", "registry.json"), text);
}

function addAttempt(s: RegistryStore, a: Attempt = eligibleAttempt()): Attempt {
  s.update((r) => {
    r.attempts[a.attempt_id] = a;
  });
  return a;
}

beforeEach(() => {
  dir = tmpAnalysisDir();
  now = T0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("save and signature", () => {
  it("writes version 3, a revision that only goes up, the writer token and a signature", () => {
    const s = store();
    expect(s.open()).toEqual({ kind: "empty" });
    addAttempt(s);
    const first = onDisk();
    expect(first).toMatchObject({ version: 3, revision: 1, server_url: SERVER });
    expect(first.session_sig).toMatch(/^[0-9a-f]{64}$/);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, ".loom", "state", "lock"), "utf-8"));
    expect(first.writer_token).toBe(lock.writer_token);
    s.update(() => {});
    expect(onDisk().revision).toBe(2);
    expect(onDisk().session_sig).not.toBe(first.session_sig);
  });

  it("ignores a revision the caller tries to set", () => {
    const s = store();
    s.open();
    s.update((r) => {
      r.revision = 1_000_000;
    });
    expect(onDisk().revision).toBe(1);
  });

  it("recomputes handoff_eligible on write instead of believing the caller", () => {
    const s = store();
    s.open();
    const a = eligibleAttempt();
    a.evaluation!.execution = "failed";
    a.handoff_eligible = true;
    addAttempt(s, a);
    expect(s.snapshot().attempts[a.attempt_id].handoff_eligible).toBe(false);
    s.update((r) => {
      r.attempts[a.attempt_id].evaluation!.execution = "success";
    });
    expect(s.snapshot().attempts[a.attempt_id].handoff_eligible).toBe(true);
  });

  it("refuses to write a malformed registry and leaves the old one in place", () => {
    const s = store();
    s.open();
    addAttempt(s);
    expect(() =>
      s.update((r) => {
        (r.attempts[Object.keys(r.attempts)[0]] as any).kind = "teleport";
      }),
    ).toThrow(RegistryFormatError);
    expect(onDisk().revision).toBe(1);
  });

  it("refuses to write an attempt for another server", () => {
    const s = store();
    s.open();
    expect(() => addAttempt(s, { ...eligibleAttempt(), server_url: OTHER_SERVER })).toThrow(
      /not https:\/\/usegalaxy.example/,
    );
  });

  it("never puts the session key anywhere reachable", () => {
    const s = store();
    s.open();
    addAttempt(s);
    const text = fs.readFileSync(path.join(dir, ".loom", "state", "registry.json"), "utf-8");
    expect(JSON.stringify(s)).not.toMatch(/sessionKey|session_key/);
    expect(Object.keys(s)).not.toContain("sessionKey");
    expect(text).not.toMatch(/session_key/);
  });

  it("gives attempts ULIDs in the format capture already writes", () => {
    expect(store().newAttemptId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("session signature (v3 §13)", () => {
  it("own state survives a reload with live approvals intact", () => {
    const s = store();
    s.open();
    const a = addAttempt(s);
    expect(s.load()).toEqual({ kind: "own", revision: 1 });
    const got = s.snapshot().attempts[a.attempt_id];
    expect(got.approval).toMatchObject({ status: "live", by: "user" });
    expect(got.handoff_eligible).toBe(true);
  });

  it("own state survives re-ingesting the same text from a carrier", () => {
    const s = store();
    s.open();
    const a = addAttempt(s);
    const text = fs.readFileSync(s.registryPath, "utf-8");
    expect(s.ingestText(text).kind).toBe("own");
    expect(s.snapshot().attempts[a.attempt_id].approval?.status).toBe("live");
  });

  it("foreign state imports and downgrades approvals, exceptions, checks, provenance and evaluations", () => {
    const writer = store("s-a", 100);
    writer.open();
    const a = eligibleAttempt();
    a.evaluation!.conformity = "excepted";
    writer.update((r) => {
      r.attempts[a.attempt_id] = a;
      r.exceptions.push(userException(a));
    });
    expect(writer.snapshot().attempts[a.attempt_id].handoff_eligible).toBe(true);
    writer.close();

    const next = store("s-b", 200);
    const outcome = next.open();
    expect(outcome.kind).toBe("imported");
    const r = next.snapshot();
    const got = r.attempts[a.attempt_id];
    expect(got.approval).toMatchObject({ status: "restored", by: "restored" });
    expect(r.exceptions[0].by).toBe("restored");
    expect(got.submission?.check.outcome).toBe("unchecked");
    expect(got.submission?.server_verified).toBe(false);
    expect(got.provenance?.authority).toBe("historical");
    expect(got.evaluation?.authority).toBe("historical");
    expect(got.handoff_eligible).toBe(false);
    // and the downgrade is what's on disk now, signed by the new session
    expect(onDisk().attempts[a.attempt_id].approval.status).toBe("restored");
    expect(next.load().kind).toBe("own");
  });

  it("a hand-forged file claiming everything is still an import", () => {
    fs.mkdirSync(path.join(dir, ".loom", "state"), { recursive: true });
    const a = eligibleAttempt();
    a.handoff_eligible = true;
    const forged = {
      version: 3,
      revision: 50,
      writer_token: "x",
      session_sig: "0".repeat(64),
      analysis_id: "an",
      server_url: SERVER,
      attempts: { [a.attempt_id]: a },
      exceptions: [userException(a)],
      supervision: { active_at_shutdown: [] },
    };
    writeRaw(JSON.stringify(forged));
    const s = store();
    expect(s.open().kind).toBe("imported");
    const got = s.snapshot().attempts[a.attempt_id];
    expect(got.approval?.status).toBe("restored");
    expect(got.handoff_eligible).toBe(false);
    expect(s.snapshot().revision).toBe(51);
  });

  it("a signature copied from a real own file doesn't transfer to edited content", () => {
    const s = store();
    s.open();
    const a = eligibleAttempt();
    a.evaluation!.execution = "failed";
    addAttempt(s, a);
    const doc = onDisk();
    doc.attempts[a.attempt_id].evaluation.execution = "success";
    writeRaw(JSON.stringify(doc));
    // Foreign while we hold our own state: refused, ours kept.
    expect(s.load().kind).toBe("ignored");
    expect(s.snapshot().attempts[a.attempt_id].evaluation?.execution).toBe("failed");
  });

  it("an old own-state replay with a lower revision is treated as stale", () => {
    const s = store();
    s.open();
    const a = addAttempt(s);
    const old = fs.readFileSync(s.registryPath, "utf-8");
    s.update((r) => {
      r.attempts[a.attempt_id].approval!.status = "revoked";
    });
    const outcome = s.ingestText(old);
    expect(outcome).toEqual({ kind: "stale", revision: 1, current: 2 });
    expect(s.snapshot().attempts[a.attempt_id].approval?.status).toBe("revoked");
  });

  it("a replay stays stale after a damaged file was rejected", () => {
    const s = store();
    s.open();
    addAttempt(s);
    const old = fs.readFileSync(s.registryPath, "utf-8");
    s.update(() => {});
    writeRaw("garbage");
    expect(s.load().kind).toBe("rejected");
    expect(s.ingestText(old).kind).toBe("stale");
  });
});

describe("rejected input", () => {
  function openWith(text: string) {
    fs.mkdirSync(path.join(dir, ".loom", "state"), { recursive: true });
    writeRaw(text);
    const s = store();
    return { s, outcome: s.open() };
  }

  function foreignDoc(): Record<string, any> {
    const a = eligibleAttempt();
    return {
      version: 3,
      revision: 1,
      writer_token: "x",
      session_sig: "",
      analysis_id: "an",
      server_url: SERVER,
      attempts: { [a.attempt_id]: a },
      exceptions: [],
      supervision: { active_at_shutdown: [] },
    };
  }

  it("starts empty with a notice on malformed JSON, and keeps the file aside", () => {
    const { s, outcome } = openWith("{nope");
    expect(outcome.kind).toBe("rejected");
    expect(Object.keys(s.snapshot().attempts)).toHaveLength(0);
    expect(s.notices.join("\n")).toMatch(/starting with an empty registry/);
    const aside = fs
      .readdirSync(path.join(dir, ".loom", "state"))
      .filter((f) => /rejected/.test(f));
    expect(aside).toHaveLength(1);
  });

  it("rejects a duplicate attempt id smuggled in as a repeated JSON key", () => {
    const doc = foreignDoc();
    const id = Object.keys(doc.attempts)[0];
    const body = JSON.stringify(doc.attempts[id]);
    const text = JSON.stringify(doc).replace(
      `"attempts":{"${id}":${body}}`,
      `"attempts":{"${id}":${body},"${id}":${body}}`,
    );
    expect(text).not.toBe(JSON.stringify(doc));
    const { outcome } = openWith(text);
    expect(outcome).toMatchObject({ kind: "rejected", reason: expect.stringMatching(/duplicate/) });
  });

  it("rejects an oversized registry unread", () => {
    const doc = foreignDoc();
    doc.padding = "x".repeat(MAX_REGISTRY_BYTES);
    const { outcome } = openWith(JSON.stringify(doc));
    expect(outcome).toMatchObject({ kind: "rejected", reason: expect.stringMatching(/larger/) });
  });

  it("rejects a document from a newer Loom", () => {
    const { outcome } = openWith(JSON.stringify({ ...foreignDoc(), version: 4 }));
    expect(outcome).toMatchObject({ kind: "rejected", reason: expect.stringMatching(/newer/) });
  });
});

describe("server mismatch quarantine (v3 §13)", () => {
  it("quarantines imported attempts from another server and keeps them out of attempts", () => {
    const a = store("s-a", 100, OTHER_SERVER);
    a.open();
    const there = { ...eligibleAttempt(), server_url: OTHER_SERVER };
    there.approval!.spec_snapshot = { ...there.approval!.spec_snapshot, server_url: OTHER_SERVER };
    there.approval!.spec_revision = sha256Hex(canonicalJson(there.approval!.spec_snapshot));
    addAttempt(a, there);
    a.close();

    const b = store("s-b", 200, SERVER);
    const outcome = b.open();
    expect(outcome).toMatchObject({ kind: "imported", quarantined: [there.attempt_id] });
    const r = b.snapshot();
    expect(r.attempts).toEqual({});
    expect(r.quarantine?.[there.attempt_id].handoff_eligible).toBe(false);
    expect(b.notices.join("\n")).toMatch(/quarantined/);
    // and it stays quarantined across this session's own saves
    b.update(() => {});
    expect(Object.keys(onDisk().quarantine)).toEqual([there.attempt_id]);
  });
});

describe("lock fencing (v3 §13)", () => {
  it("a second live session opens read-only and cannot write", () => {
    store("s-a", 100).open();
    const b = store("s-b", 200);
    b.open();
    expect(b.mode).toBe("read-only");
    expect(() => addAttempt(b)).toThrow(RegistryReadOnlyError);
    expect(() => b.putTemplate({ x: 1 })).toThrow(RegistryReadOnlyError);
  });

  it("after a stale takeover the old writer's next write fails and it reloads read-only", () => {
    const a = store("s-a", 100);
    a.open();
    addAttempt(a, eligibleAttempt({ id: ulid(T0) }));

    now = T0 + STALE_LOCK_MS + 1;
    const b = store("s-b", 200);
    b.open();
    expect(b.mode).toBe("writer");
    const bs = addAttempt(b, eligibleAttempt({ id: ulid(T0 + 5) }));

    expect(() => addAttempt(a, eligibleAttempt({ id: ulid(T0 + 9) }))).toThrow(RegistryFencedError);
    expect(a.mode).toBe("read-only");
    // it now holds b's state, as an import
    expect(Object.keys(a.snapshot().attempts)).toContain(bs.attempt_id);
    expect(a.snapshot().attempts[bs.attempt_id].approval?.status).toBe("restored");
    // and b's file wasn't touched by the failed write
    expect(Object.keys(onDisk().attempts)).not.toContain(ulid(T0 + 9));
  });

  it("a writer whose lock was taken learns it at heartbeat", () => {
    const a = store("s-a", 100);
    a.open();
    now = T0 + STALE_LOCK_MS + 1;
    store("s-b", 200).open();
    expect(a.heartbeat()).toBe(false);
    expect(a.mode).toBe("read-only");
  });
});

describe("templates store", () => {
  it("is content-addressed and write-once", () => {
    const s = store();
    s.open();
    const body = { inputs: [{ name: "input1", type: "data" }], id: "cat1" };
    const digest = s.putTemplate(body);
    expect(digest).toBe(sha256Hex(canonicalJson(body)));
    const file = path.join(s.templatesDir, `${digest}.json`);
    const mtime = fs.statSync(file).mtimeMs;
    expect(s.putTemplate({ id: "cat1", inputs: [{ type: "data", name: "input1" }] })).toBe(digest);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(s.getTemplate(digest)).toEqual(body);
  });

  it("refuses an altered template and a digest that isn't one", () => {
    const s = store();
    s.open();
    const digest = s.putTemplate({ a: 1 });
    fs.writeFileSync(path.join(s.templatesDir, `${digest}.json`), '{"a":2}');
    expect(s.getTemplate(digest)).toBeUndefined();
    expect(() => s.putTemplate({ a: 1 })).toThrow(/does not match/);
    expect(s.getTemplate("../registry")).toBeUndefined();
  });
});
