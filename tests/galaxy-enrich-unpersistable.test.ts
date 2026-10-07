/**
 * A block whose attempt record cannot be read and whose notebook block cannot
 * be written has nowhere durable to count its failures. It must still stop
 * after MAX_ENRICHMENT_ATTEMPTS in a session rather than retry forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const broken = { read: false, write: false, reads: 0 };

vi.mock("../extensions/loom/galaxy-provenance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/galaxy-provenance")>();
  return {
    ...actual,
    readAttemptRecord: async (...args: Parameters<typeof actual.readAttemptRecord>) => {
      if (broken.read) {
        broken.reads++;
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return actual.readAttemptRecord(...args);
    },
  };
});

vi.mock("../extensions/loom/notebook-writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/loom/notebook-writer")>();
  return {
    ...actual,
    writeNotebook: async (...args: Parameters<typeof actual.writeNotebook>) => {
      if (broken.write) throw Object.assign(new Error("EROFS: read-only"), { code: "EROFS" });
      return actual.writeNotebook(...args);
    },
  };
});

import {
  MAX_ENRICHMENT_ATTEMPTS,
  resetEnrichmentState,
  runEnrichmentPass,
} from "../extensions/loom/galaxy-enrich";
import { upsertJobBlock } from "../extensions/loom/galaxy-job-block";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { ulid } from "../extensions/loom/ulid";

describe("enrichment with nowhere durable to count", () => {
  let dir: string;
  let clock = Date.parse("2026-10-07T12:00:00Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-enrich-unpersistable-"));
    const nb = path.join(dir, "notebook.md");
    fs.writeFileSync(
      nb,
      upsertJobBlock(
        "",
        {
          jobId: "aa11",
          galaxyServerUrl: "https://usegalaxy.org",
          notebookAnchor: "plan-a-step-1",
          label: "fastp",
          submittedAt: "2026-10-07T10:00:00.000Z",
          status: "completed",
        },
        { attemptId: ulid(), enrichment: "pending", enrichmentAttempts: 0 },
      ),
    );
    resetState();
    resetEnrichmentState();
    setNotebookPath(nb);
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "k";
    Object.assign(broken, { read: true, write: true, reads: 0 });
  });

  afterEach(() => {
    Object.assign(broken, { read: false, write: false });
    resetState();
    resetEnrichmentState();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  it("gives up after the limit within the session and stops asking", async () => {
    const deps = {
      now: () => clock,
      getJob: async () => ({ id: "aa11", state: "ok", tool_id: "x" }),
    };
    for (let i = 0; i < MAX_ENRICHMENT_ATTEMPTS + 3; i++) {
      await runEnrichmentPass({ deps });
      clock += 60 * 60_000;
    }
    expect(broken.reads).toBe(MAX_ENRICHMENT_ATTEMPTS);
    const rows = fs
      .readFileSync(path.join(dir, "activity.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const unavailable = rows.filter((r) => r.kind === "enrichment.unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].payload).toMatchObject({
      reason: "attempts",
      attempts: MAX_ENRICHMENT_ATTEMPTS,
      block_written: false,
    });
  });
});
