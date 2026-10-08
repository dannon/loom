import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state");
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => ({}) }));

import * as state from "../extensions/loom/state";
import {
  findEnrichmentWarnings,
  parsePlanSteps,
  registerEvidenceGate,
  resetEvidenceOverrides,
} from "../extensions/loom/evidence-gate";
import { upsertJobBlock, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { ensureAttemptRecord, writeEnrichment } from "../extensions/loom/galaxy-provenance";
import { buildJobRecord } from "../extensions/loom/galaxy-enrich";
import type { HarnessBlockFields } from "../extensions/loom/harness-block-fields";
import { ulid } from "../extensions/loom/ulid";

const PLAN = `# Notebook

## Plan A: QC [galaxy]

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim
`;
const STEP = "1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim";

function job(over: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "aa11",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "fastp",
    submittedAt: "2026-10-07T10:00:00Z",
    status: "completed",
    ...over,
  };
}

let dir: string;
let nbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-evidence-enrich-"));
  nbPath = path.join(dir, "notebook.md");
  vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
  resetEvidenceOverrides();
  delete process.env.LOOM_EVIDENCE_GATE;
});

afterEach(() => {
  delete process.env.LOOM_EVIDENCE_GATE;
  fs.rmSync(dir, { recursive: true, force: true });
});

const flips = () => [parsePlanSteps(PLAN.replace("- [ ]", "- [x]")).get("#plan-a-step-1")!];

async function enrichedNotebook(over: HarnessBlockFields = {}): Promise<string> {
  const attemptId = ulid();
  await ensureAttemptRecord(dir, {
    origin: "submission",
    attemptId,
    kind: "jobs",
    galaxyServerUrl: "https://usegalaxy.org",
    submittedBy: "harness",
    ids: { job_ids: ["aa11"] },
  });
  await writeEnrichment(dir, attemptId, {
    blockKind: "job",
    blockId: "aa11",
    state: "complete",
    attempts: 1,
    serverUrl: "https://usegalaxy.org",
    jobs: [
      buildJobRecord(
        { id: "aa11", state: "ok", tool_id: "fastp" },
        { tool_version: "0.24.0", tool_version_source: "submission" },
        new Map(),
      ),
    ],
  });
  return (
    PLAN +
    "\n" +
    upsertJobBlock("", job(), {
      attemptId,
      enrichment: "complete",
      jobs: [{ jobId: "aa11", toolId: "fastp", toolVersion: "0.24.0" }],
      ...over,
    })
  );
}

describe("findEnrichmentWarnings", () => {
  it("is quiet when the run is enriched, versioned and backed by its file", async () => {
    expect(findEnrichmentWarnings(await enrichedNotebook(), flips(), dir)).toEqual([]);
  });

  it("names enrichment that has not completed, and a missing version", () => {
    const content = PLAN + "\n" + upsertJobBlock("", job(), { enrichment: "pending" });
    expect(findEnrichmentWarnings(content, flips(), dir)).toEqual([
      expect.objectContaining({
        id: "aa11",
        reasons: ["enrichment_pending", "tool_version_missing"],
      }),
    ]);
  });

  it("does not take the block's word for complete when the provenance file is not there", () => {
    const content =
      PLAN +
      "\n" +
      upsertJobBlock("", job(), {
        attemptId: ulid(),
        enrichment: "complete",
        jobs: [{ jobId: "aa11", toolVersion: "0.24.0" }],
      });
    expect(findEnrichmentWarnings(content, flips(), dir)[0].reasons).toEqual([
      "provenance_missing",
    ]);
  });

  it("does not accept an owned but empty record, or one made from notebook text", async () => {
    const shell = ulid();
    await ensureAttemptRecord(dir, {
      origin: "submission",
      attemptId: shell,
      kind: "jobs",
      galaxyServerUrl: "https://usegalaxy.org",
      submittedBy: "harness",
      ids: { job_ids: ["aa11"] },
    });
    const forged =
      PLAN +
      "\n" +
      upsertJobBlock("", job(), {
        attemptId: shell,
        enrichment: "complete",
        jobs: [{ jobId: "aa11", toolVersion: "0.24.0" }],
      });
    expect(findEnrichmentWarnings(forged, flips(), dir)[0].reasons).toEqual([
      "provenance_incomplete",
      "tool_version_missing",
    ]);

    const late = ulid();
    await ensureAttemptRecord(dir, {
      origin: "notebook",
      attemptId: late,
      kind: "jobs",
      galaxyServerUrl: "https://usegalaxy.org",
      submittedBy: "harness",
      ids: { job_ids: ["aa11"] },
    });
    const content =
      PLAN + "\n" + upsertJobBlock("", job(), { attemptId: late, enrichment: "complete" });
    expect(findEnrichmentWarnings(content, flips(), dir)[0].reasons).toContain(
      "provenance_untrusted",
    );
  });

  it("does not count a record built from fixture answers as evidence", async () => {
    const content = await enrichedNotebook();
    const attemptId = /attempt_id: (\S+)/.exec(content)![1];
    const file = path.join(dir, ".loom", "provenance", `${attemptId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), fixture: true }),
    );
    expect(findEnrichmentWarnings(content, flips(), dir)[0].reasons).toEqual([
      "provenance_untrusted",
    ]);
  });

  it("judges the completed run, not an earlier failed attempt", async () => {
    const content =
      (await enrichedNotebook()) +
      "\n" +
      upsertJobBlock("", job({ jobId: "bb22", status: "failed" }), { enrichment: "unavailable" });
    expect(findEnrichmentWarnings(content, flips(), dir)).toEqual([]);
  });

  it("has no opinion on a step with no bound run", () => {
    expect(findEnrichmentWarnings(PLAN, flips(), dir)).toEqual([]);
  });
});

describe("the hook warns and never blocks on enrichment", () => {
  function fakePi() {
    type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
    const listeners = new Map<string, Handler[]>();
    const api = {
      on(name: string, handler: Handler) {
        listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    return {
      api,
      async flip() {
        let result: unknown;
        for (const h of listeners.get("tool_call") ?? []) {
          result = await h(
            {
              toolName: "edit",
              input: {
                path: "notebook.md",
                edits: [{ oldText: `- [ ] ${STEP}`, newText: `- [x] ${STEP}` }],
              },
            },
            { cwd: dir },
          );
        }
        return result as { block?: boolean } | undefined;
      },
    };
  }

  it("records a warn decision even in deny mode, and lets the write through", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    fs.writeFileSync(nbPath, PLAN + "\n" + upsertJobBlock("", job(), { enrichment: "pending" }));
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    const result = await pi.flip();
    expect(result?.block).toBeFalsy();
    const rows = fs
      .readFileSync(path.join(dir, "activity.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "evidence.enrichment_warning");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      mode: "deny",
      decision: "warn",
      warnings: [{ step: "#plan-a-step-1", block_kind: "job", id: "aa11" }],
    });
  });
});
