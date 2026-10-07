import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_ENRICHMENT_ATTEMPTS,
  buildJobRecord,
  computeDrift,
  parseDatasetRefs,
  resetEnrichmentState,
  resolveToolVersion,
  runEnrichmentPass,
  summarizeJobs,
  toolLineage,
  versionFromToolId,
  walkInvocationJobs,
  type EnrichDeps,
} from "../extensions/loom/galaxy-enrich";
import { GalaxyApiError, type InvocationDetail } from "../extensions/loom/galaxy-api";
import { findJobBlocks, upsertJobBlock, type JobYaml } from "../extensions/loom/galaxy-job-block";
import {
  findInvocationBlocks,
  upsertInvocationBlock,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import {
  ensureAttemptRecord,
  readAttemptRecord,
  UNKNOWN,
} from "../extensions/loom/galaxy-provenance";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { ulid } from "../extensions/loom/ulid";

const SERVER = "https://usegalaxy.org";
const FASTP = "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp";

describe("enrichment parsers", () => {
  it("reads a toolshed guid's lineage and version, and leaves built-ins alone", () => {
    expect(toolLineage(`${FASTP}/0.24.0+galaxy0`)).toBe(FASTP);
    expect(versionFromToolId(`${FASTP}/0.24.0+galaxy0`)).toBe("0.24.0+galaxy0");
    expect(toolLineage("cat1")).toBe("cat1");
    expect(versionFromToolId("cat1")).toBeUndefined();
  });

  it("prefers a version Galaxy handed us, then the guid's, else unknown", () => {
    expect(resolveToolVersion("cat1", "1.0.0", "submission")).toEqual({
      tool_version: "1.0.0",
      tool_version_source: "submission",
    });
    expect(resolveToolVersion(`${FASTP}/0.24.0`, undefined, "submission")).toEqual({
      tool_version: "0.24.0",
      tool_version_source: "tool_id",
    });
    expect(resolveToolVersion("cat1", undefined, "submission")).toEqual({
      tool_version: UNKNOWN,
      tool_version_source: UNKNOWN,
    });
  });

  it("reads inputs keyed by slot name, and drops ids that are not Galaxy ids", () => {
    expect(
      parseDatasetRefs({
        input1: { id: "aa11", src: "hda", uuid: "x" },
        evil: { id: "../histories", src: "hda" },
        bare: "nope",
      }),
    ).toEqual([{ name: "input1", id: "aa11", src: "hda" }]);
    expect(parseDatasetRefs([{ name: "out", id: "bb22", src: "hda" }])).toEqual([
      { name: "out", id: "bb22", src: "hda" },
    ]);
    expect(parseDatasetRefs(undefined)).toBeNull();
  });

  it("builds a job record from full details, unknown where Galaxy was silent", () => {
    const record = buildJobRecord(
      {
        id: "aa11",
        state: "ok",
        tool_id: `${FASTP}/0.24.0`,
        exit_code: 0,
        params: { quality: "20" },
        inputs: { in1: { id: "d1", src: "hda" } },
        outputs: { out1: { id: "d2", src: "hda" } },
      },
      { tool_version: "0.24.0", tool_version_source: "submission" },
      new Map([
        ["d1", { name: "reads.fq", extension: "fastqsanger", genome_build: "hg38" }],
        ["d2", null],
      ]),
    );
    expect(record).toMatchObject({
      job_id: "aa11",
      tool_version: "0.24.0",
      exit_code: 0,
      params: { quality: "20" },
      create_time: UNKNOWN,
      command_version: UNKNOWN,
      inputs: [
        { name: "in1", id: "d1", dataset_name: "reads.fq", ext: "fastqsanger", dbkey: "hg38" },
      ],
      outputs: [{ name: "out1", id: "d2", dataset_name: UNKNOWN, ext: UNKNOWN }],
      output_collections: UNKNOWN,
    });
    expect(summarizeJobs([record])).toEqual([
      {
        jobId: "aa11",
        toolId: `${FASTP}/0.24.0`,
        toolVersion: "0.24.0",
        state: "ok",
        outputs: [{ id: "d2" }],
      },
    ]);
  });

  it("walks every job of a mapped step and follows subworkflows once", async () => {
    const parent = {
      id: "inv1",
      steps: [
        { order_index: 0, jobs: [] },
        {
          order_index: 1,
          workflow_step_label: "trim",
          jobs: [
            { id: "a1", tool_id: "fastp", state: "ok" },
            { id: "a2", tool_id: "fastp", state: "ok" },
            { id: "a3", tool_id: "fastp", state: "ok" },
          ],
        },
        { order_index: 2, jobs: [], subworkflow_invocation_id: "b1" },
      ],
    } as unknown as InvocationDetail;
    const child = {
      id: "b1",
      steps: [
        { order_index: 0, jobs: [{ id: "c1", tool_id: "cat1", state: "ok" }] },
        // A cycle back to the parent must not loop.
        { order_index: 1, jobs: [], subworkflow_invocation_id: "inv1" },
      ],
    } as unknown as InvocationDetail;
    const jobs = await walkInvocationJobs(parent, async (id) => {
      if (id === "b1") return child;
      throw new Error(`unexpected fetch ${id}`);
    });
    expect(jobs.map((j) => j.jobId)).toEqual(["a1", "a2", "a3", "c1"]);
    expect(jobs[0]).toMatchObject({ orderIndex: 1, stepLabel: "trim" });
    expect(jobs[3].subworkflowInvocationId).toBe("b1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function jobBlock(over: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "aa11",
    galaxyServerUrl: SERVER,
    notebookAnchor: "plan-a-step-1",
    label: "fastp",
    toolId: "fastp",
    submittedAt: "2026-10-07T10:00:00.000Z",
    status: "completed",
    serverVerified: true,
    ...over,
  };
}

describe("computeDrift", () => {
  const a1 = ulid();
  const a2 = ulid();
  let content = upsertJobBlock("", jobBlock({ jobId: "aa11" }), {
    attemptId: a1,
    jobs: [{ jobId: "aa11", toolId: `${FASTP}/0.23.4`, toolVersion: "0.23.4" }],
  });
  content = upsertJobBlock(
    content,
    jobBlock({ jobId: "bb22", submittedAt: "2026-10-07T11:00:00.000Z" }),
    { attemptId: a2 },
  );
  const newJobs = [{ jobId: "bb22", toolId: `${FASTP}/0.24.0`, toolVersion: "0.24.0" }];

  it("names the version that moved against the earlier completed attempt", () => {
    expect(computeDrift(content, "plan-a-step-1", a2, newJobs)).toEqual({
      against: a1,
      drift: [{ toolId: FASTP, from: "0.23.4", to: "0.24.0" }],
    });
  });

  it("says nothing for unattributed work, unknown versions, or a step with no earlier run", () => {
    expect(computeDrift(content, "unattributed", a2, newJobs)).toBeNull();
    expect(
      computeDrift(content, "plan-a-step-1", a2, [{ jobId: "bb22", toolId: FASTP }])!.drift,
    ).toEqual([]);
    expect(computeDrift(content, "plan-b-step-9", a2, newJobs)).toBeNull();
  });

  it("does not count an attempt that never completed", () => {
    const failed = content.replace(/status: completed/, "status: failed");
    expect(computeDrift(failed, "plan-a-step-1", a2, newJobs)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("runEnrichmentPass", () => {
  let dir: string;
  let nbPath: string;
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-enrich-"));
    nbPath = path.join(dir, "notebook.md");
    resetState();
    resetEnrichmentState();
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = SERVER;
    process.env.GALAXY_API_KEY = "k";
    clock = Date.parse("2026-10-07T12:00:00Z");
  });

  afterEach(() => {
    resetState();
    resetEnrichmentState();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  function details(id: string, toolId = "fastp") {
    return {
      id,
      state: "ok",
      tool_id: toolId,
      exit_code: 0,
      params: { q: "20" },
      inputs: { in1: { id: "d1", src: "hda" } },
      outputs: { out1: { id: "d2", src: "hda" } },
    };
  }

  function deps(over: Partial<EnrichDeps> = {}): Partial<EnrichDeps> {
    return {
      getJob: async (id) => details(id),
      getInvocation: async () => {
        throw new Error("no invocation");
      },
      getDataset: async (id) => ({ name: `ds-${id}`, extension: "fastqsanger", genome_build: "?" }),
      now: () => clock,
      ...over,
    };
  }

  async function seedJob(over: Partial<JobYaml> = {}, harness: Record<string, unknown> = {}) {
    const attemptId = ulid();
    const block = jobBlock(over);
    fs.writeFileSync(
      nbPath,
      upsertJobBlock("# Analysis\n", block, {
        attemptId,
        submittedBy: "harness",
        enrichment: "pending",
        enrichmentAttempts: 0,
        jobs: [{ jobId: block.jobId, toolId: "fastp", toolVersion: "0.24.0" }],
        ...harness,
      }),
    );
    await ensureAttemptRecord(dir, {
      origin: "submission",
      attemptId,
      kind: "jobs",
      galaxyServerUrl: SERVER,
      submittedBy: "harness",
      ids: { job_ids: [block.jobId] },
    });
    return attemptId;
  }

  function rows(kind: string) {
    const file = path.join(dir, "activity.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === kind);
  }

  const theJob = () => findJobBlocks(fs.readFileSync(nbPath, "utf-8"))[0];

  it("completes a finished tool run: block summary, provenance file, activity row", async () => {
    const attemptId = await seedJob();
    await runEnrichmentPass({ deps: deps() });
    const block = theJob();
    expect(block.enrichment).toBe("complete");
    expect(block.enrichmentAttempts).toBe(1);
    expect(block.jobs).toEqual([
      {
        jobId: "aa11",
        toolId: "fastp",
        toolVersion: "0.24.0",
        state: "ok",
        outputs: [{ id: "d2", ext: "fastqsanger" }],
      },
    ]);
    const record = await readAttemptRecord(dir, attemptId);
    expect(record!.enrichment.state).toBe("complete");
    expect(record!.jobs.aa11).toMatchObject({
      tool_version: "0.24.0",
      tool_version_source: "submission",
      params: { q: "20" },
      inputs: [{ id: "d1", dataset_name: "ds-d1" }],
    });
    expect(rows("enrichment.complete")[0].payload).toMatchObject({
      id: "aa11",
      attempt_id: attemptId,
      job_count: 1,
      provenance: `.loom/provenance/${attemptId}.json`,
    });
  });

  it("a record created late from a block says its ownership came from the notebook", async () => {
    const attemptId = ulid();
    fs.writeFileSync(
      nbPath,
      upsertJobBlock("", jobBlock(), { attemptId, submittedBy: "harness", enrichment: "pending" }),
    );
    await runEnrichmentPass({ deps: deps() });
    const record = await readAttemptRecord(dir, attemptId);
    expect(record).toMatchObject({ origin: "notebook", ids: { job_ids: ["aa11"] } });
    expect(theJob().enrichment).toBe("complete");
  });

  it("leaves running work alone", async () => {
    await seedJob({ status: "in_progress" });
    const result = await runEnrichmentPass({ deps: deps() });
    expect(result.completed).toEqual([]);
    expect(theJob().enrichment).toBe("pending");
  });

  it("retries a transient failure after a backoff, then completes", async () => {
    let calls = 0;
    const flaky = deps({
      getJob: async (id) => {
        calls++;
        if (calls === 1) throw new GalaxyApiError(502, "bad gateway", "");
        return details(id);
      },
    });
    await seedJob();
    await runEnrichmentPass({ deps: flaky });
    expect(theJob()).toMatchObject({ enrichment: "pending", enrichmentAttempts: 1 });
    expect(theJob().enrichmentError).toContain("502");
    expect(rows("enrichment.retry")[0].payload).toMatchObject({ attempt: 1 });

    // Still inside the backoff: not asked again.
    const skipped = await runEnrichmentPass({ deps: flaky });
    expect(skipped.skipped).toBe(1);
    expect(calls).toBe(1);

    clock += 31_000;
    await runEnrichmentPass({ deps: flaky });
    expect(theJob()).toMatchObject({ enrichment: "complete", enrichmentAttempts: 2 });
    expect(theJob().enrichmentError).toBeUndefined();
  });

  it("goes unavailable on a 404 without retrying", async () => {
    await seedJob();
    await runEnrichmentPass({
      deps: deps({
        getJob: async () => {
          throw new GalaxyApiError(404, "no such job", "");
        },
      }),
    });
    expect(theJob().enrichment).toBe("unavailable");
    expect(rows("enrichment.unavailable")[0].payload).toMatchObject({ reason: "not_found" });
  });

  it("goes unavailable after the last allowed attempt", async () => {
    await seedJob({}, { enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS - 1 });
    await runEnrichmentPass({
      deps: deps({
        getJob: async () => {
          throw new GalaxyApiError(500, "boom", "");
        },
      }),
    });
    expect(theJob()).toMatchObject({
      enrichment: "unavailable",
      enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS,
    });
    expect(rows("enrichment.unavailable")[0].payload).toMatchObject({ reason: "attempts" });
  });

  it("refuses a block re-pointed at another attempt's record", async () => {
    const victim = ulid();
    await ensureAttemptRecord(dir, {
      origin: "submission",
      attemptId: victim,
      kind: "jobs",
      galaxyServerUrl: SERVER,
      submittedBy: "harness",
      ids: { job_ids: ["ff99"] },
    });
    // The block names the victim's attempt id, as a hand edit could.
    fs.writeFileSync(
      nbPath,
      upsertJobBlock("", jobBlock(), { attemptId: victim, enrichment: "pending" }),
    );
    await runEnrichmentPass({ deps: deps() });
    expect(theJob().enrichment).toBe("unavailable");
    expect(rows("enrichment.unavailable")[0].payload).toMatchObject({ reason: "attribution" });
    expect((await readAttemptRecord(dir, victim))!.jobs).toEqual({});
  });

  it("enriches every job of a mapped-over workflow step", async () => {
    const attemptId = ulid();
    const inv: InvocationYaml = {
      invocationId: "abc0000000000001",
      galaxyServerUrl: SERVER,
      notebookAnchor: "plan-a-step-2",
      label: "trim all",
      submittedAt: "2026-10-07T10:00:00.000Z",
      status: "completed",
    };
    fs.writeFileSync(
      nbPath,
      upsertInvocationBlock("", inv, { attemptId, submittedBy: "harness", enrichment: "pending" }),
    );
    await ensureAttemptRecord(dir, {
      origin: "submission",
      attemptId,
      kind: "invocation",
      galaxyServerUrl: SERVER,
      submittedBy: "harness",
      ids: { invocation_id: inv.invocationId },
    });
    await runEnrichmentPass({
      deps: deps({
        getInvocation: async (id) =>
          ({
            id,
            steps: [
              {
                order_index: 1,
                jobs: ["a1", "a2", "a3"].map((j) => ({
                  id: j,
                  tool_id: `${FASTP}/0.24.0`,
                  state: "ok",
                })),
              },
            ],
          }) as unknown as InvocationDetail,
        getJob: async (id) => details(id, `${FASTP}/0.24.0`),
      }),
    });
    const [block] = findInvocationBlocks(fs.readFileSync(nbPath, "utf-8"));
    expect(block.enrichment).toBe("complete");
    expect(block.jobs!.map((j) => j.jobId)).toEqual(["a1", "a2", "a3"]);
    expect(block.jobs![0].toolVersion).toBe("0.24.0");
    const record = await readAttemptRecord(dir, attemptId);
    expect(Object.keys(record!.jobs)).toEqual(["a1", "a2", "a3"]);
    expect(record!.jobs.a1.tool_version_source).toBe("tool_id");
    expect(rows("enrichment.complete")[0].payload.job_count).toBe(3);
  });

  it("writes drift when a completed attempt is already bound to the step", async () => {
    const earlier = ulid(Date.parse("2026-10-06T00:00:00Z"));
    const prior = upsertJobBlock(
      "",
      jobBlock({ jobId: "0ld0", submittedAt: "2026-10-06T00:00:00.000Z" }),
      {
        attemptId: earlier,
        enrichment: "complete",
        jobs: [{ jobId: "0ld0", toolId: `${FASTP}/0.23.4`, toolVersion: "0.23.4" }],
      },
    );
    const attemptId = ulid();
    fs.writeFileSync(
      nbPath,
      upsertJobBlock(prior, jobBlock({ jobId: "aa11" }), {
        attemptId,
        submittedBy: "harness",
        enrichment: "pending",
        jobs: [{ jobId: "aa11", toolId: `${FASTP}/0.24.0`, toolVersion: "0.24.0" }],
      }),
    );
    await ensureAttemptRecord(dir, {
      origin: "submission",
      attemptId,
      kind: "jobs",
      galaxyServerUrl: SERVER,
      submittedBy: "harness",
      ids: { job_ids: ["aa11"] },
    });
    await runEnrichmentPass({
      deps: deps({ getJob: async (id) => details(id, `${FASTP}/0.24.0`) }),
    });
    const block = findJobBlocks(fs.readFileSync(nbPath, "utf-8")).find((b) => b.jobId === "aa11")!;
    expect(block.drift).toEqual([{ toolId: FASTP, from: "0.23.4", to: "0.24.0" }]);
    expect(rows("drift.detected")[0].payload).toMatchObject({
      against_attempt_id: earlier,
      drift: [{ tool_id: FASTP, from: "0.23.4", to: "0.24.0" }],
    });
  });
});
