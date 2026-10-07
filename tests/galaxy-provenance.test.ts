import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ProvenanceRefusal,
  attemptOwns,
  ensureAttemptRecord,
  provenancePath,
  readAttemptRecord,
  readAttemptRecordSync,
  writeEnrichment,
  UNKNOWN,
  type ProvenanceJob,
} from "../extensions/loom/galaxy-provenance";
import { ulid } from "../extensions/loom/ulid";

function job(jobId: string, over: Partial<ProvenanceJob> = {}): ProvenanceJob {
  return {
    job_id: jobId,
    tool_id: "fastp",
    tool_version: "0.24.0",
    tool_version_source: "submission",
    state: "ok",
    exit_code: 0,
    create_time: UNKNOWN,
    update_time: UNKNOWN,
    command_version: UNKNOWN,
    params: {},
    inputs: [],
    outputs: [],
    output_collections: [],
    ...over,
  };
}

describe("provenance records", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prov-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses anything but a ULID as the filename", () => {
    for (const bad of ["../escape", "01K5CJ6XWQ8QK4S2M7E9V0TZ3B/../../x", "", "abc"]) {
      expect(() => provenancePath(dir, bad)).toThrow(ProvenanceRefusal);
    }
  });

  it("creates once; the first writer decides which ids the attempt owns", async () => {
    const id = ulid();
    const first = await ensureAttemptRecord(dir, {
      attemptId: id,
      kind: "jobs",
      galaxyServerUrl: "https://usegalaxy.org",
      historyId: "0a248a1f62a0cc04",
      submittedBy: "harness",
      ids: { job_ids: ["aa", "bb"] },
    });
    const second = await ensureAttemptRecord(dir, {
      attemptId: id,
      kind: "jobs",
      galaxyServerUrl: "https://usegalaxy.org",
      submittedBy: "unknown",
      ids: { job_ids: ["cc"] },
    });
    expect(second.ids.job_ids).toEqual(["aa", "bb"]);
    expect(second.submitted_by).toBe("harness");
    expect(first.created_at).toBe(second.created_at);
    expect(attemptOwns(second, "job", "aa")).toBe(true);
    expect(attemptOwns(second, "job", "cc")).toBe(false);
    expect(attemptOwns(second, "invocation", "aa")).toBe(false);
  });

  it("refuses to fold a job the attempt does not own", async () => {
    const id = ulid();
    await ensureAttemptRecord(dir, {
      attemptId: id,
      kind: "jobs",
      galaxyServerUrl: "",
      submittedBy: "harness",
      ids: { job_ids: ["aa"] },
    });
    await expect(
      writeEnrichment(dir, id, {
        blockKind: "job",
        blockId: "bb",
        state: "complete",
        attempts: 1,
        jobs: [job("bb")],
      }),
    ).rejects.toThrow(ProvenanceRefusal);
    // The owning block may not smuggle a sibling's record in either.
    await expect(
      writeEnrichment(dir, id, {
        blockKind: "job",
        blockId: "aa",
        state: "complete",
        attempts: 1,
        jobs: [job("aa"), job("zz")],
      }),
    ).rejects.toThrow(ProvenanceRefusal);
    expect((await readAttemptRecord(dir, id))!.jobs).toEqual({});
  });

  it("merges each job block of a mapped attempt into one file", async () => {
    const id = ulid();
    await ensureAttemptRecord(dir, {
      attemptId: id,
      kind: "jobs",
      galaxyServerUrl: "",
      submittedBy: "harness",
      ids: { job_ids: ["aa", "bb"] },
    });
    for (const j of ["aa", "bb"]) {
      await writeEnrichment(dir, id, {
        blockKind: "job",
        blockId: j,
        state: "complete",
        attempts: 1,
        jobs: [job(j)],
      });
    }
    const record = await readAttemptRecord(dir, id);
    expect(Object.keys(record!.jobs).sort()).toEqual(["aa", "bb"]);
    expect(record!.enrichment.state).toBe("complete");
    // No temp files left behind.
    const files = fs.readdirSync(path.join(dir, ".loom", "provenance"));
    expect(files).toEqual([`${id}.json`]);
  });

  it("will not write through a symlinked provenance directory", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prov-elsewhere-"));
    try {
      fs.mkdirSync(path.join(dir, ".loom"));
      fs.symlinkSync(elsewhere, path.join(dir, ".loom", "provenance"));
      await expect(
        ensureAttemptRecord(dir, {
          attemptId: ulid(),
          kind: "jobs",
          galaxyServerUrl: "",
          submittedBy: "harness",
          ids: { job_ids: ["aa"] },
        }),
      ).rejects.toThrow(ProvenanceRefusal);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("treats a planted file that names another attempt as a refusal, not a blank slate", async () => {
    const id = ulid();
    const other = ulid();
    fs.mkdirSync(path.join(dir, ".loom", "provenance"), { recursive: true });
    fs.writeFileSync(
      provenancePath(dir, id),
      JSON.stringify({
        attempt_id: other,
        kind: "jobs",
        ids: { job_ids: ["aa"] },
        jobs: {},
        enrichment: { state: "pending", attempts: 0 },
      }),
    );
    await expect(readAttemptRecord(dir, id)).rejects.toThrow(ProvenanceRefusal);
    await expect(
      ensureAttemptRecord(dir, {
        attemptId: id,
        kind: "jobs",
        galaxyServerUrl: "",
        submittedBy: "harness",
        ids: { job_ids: ["aa"] },
      }),
    ).rejects.toThrow(ProvenanceRefusal);
    expect(readAttemptRecordSync(dir, id)).toBeNull();
  });
});
