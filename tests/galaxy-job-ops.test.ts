import { afterEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  describeOperation,
  getJobDetailsOp,
  runWithEnvelope,
  spellParamNames,
} from "@galaxyproject/galaxy-ops";
import { galaxyOpsContext, setGalaxyTransport } from "../extensions/loom/galaxy-api";
import { renderOperation, snake } from "../extensions/loom/galaxy-ops-tools";
import { json, opsTool, recordGalaxy, runOp, type SeenRequest } from "./galaxy-test-helpers";

const JOB = "1cd8e2f6b131e891";
const DATASET = "f2db41e1fa331b3e";

const JOB_RECORD = {
  id: JOB,
  state: "error",
  tool_id: "wc_gnu",
  exit_code: 1,
  stdout: "",
  stderr: "wc: input: No such file",
  tool_stdout: "",
  tool_stderr: "wc: input: No such file",
  job_stdout: "",
};

afterEach(() => {
  setGalaxyTransport(null);
});

describe("get_job_details", () => {
  it("reads a job by its own id, in the dataset route's shape", async () => {
    const seen = recordGalaxy(() => json(JOB_RECORD));
    const result = await runOp("get_job_details", { job_id: JOB });
    expect(seen.map((s) => s.path)).toEqual([`/api/jobs/${JOB}`]);
    expect(seen[0].query.has("full")).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      data: { job: JOB_RECORD, dataset_id: null, job_id: JOB },
      success: true,
      message: `Retrieved job details for job '${JOB}'`,
      count: null,
      pagination: null,
    });
    expect(result.details.galaxy).toMatchObject({ tool: "get_job_details" });
  });

  it.each([".", "../histories", "not-hex!", "", "g".repeat(16)])(
    "refuses job_id %j before asking Galaxy",
    async (jobId) => {
      const seen = recordGalaxy(() => json(JOB_RECORD));
      const result = await runOp("get_job_details", { job_id: jobId });
      expect(seen).toEqual([]);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
      expect(result.structuredContent.message).toContain("is not a Galaxy job id");
    },
  );

  it("still finds the job behind a dataset exactly as galaxy-ops does", async () => {
    const reply = (req: SeenRequest) =>
      req.path === `/api/datasets/${DATASET}`
        ? json({ id: DATASET, creating_job: JOB })
        : json(JOB_RECORD);
    const seen = recordGalaxy(reply);
    const result = await runOp("get_job_details", { dataset_id: DATASET });
    expect(seen.map((s) => s.path)).toEqual([`/api/datasets/${DATASET}`, `/api/jobs/${JOB}`]);
    recordGalaxy(reply);
    const base = await runWithEnvelope(
      getJobDetailsOp,
      { datasetId: DATASET },
      galaxyOpsContext()!,
    );
    expect(result.structuredContent).toEqual(base);
    expect(base.message).toBe(`Retrieved job details for dataset '${DATASET}'`);
  });

  it("answers neither id with a validation envelope", async () => {
    const seen = recordGalaxy(() => json(JOB_RECORD));
    const result = await runOp("get_job_details", {});
    expect(seen).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      success: false,
      errorKind: "validation",
      message: "Give job_id (from run_tool) or dataset_id.",
    });
  });

  it("words a failure on the job route by the job, and on the dataset route as before", async () => {
    recordGalaxy(() => json({ err_msg: "nope" }, 404));
    const byJob = await runOp("get_job_details", { job_id: JOB });
    expect(byJob.structuredContent.errorKind).toBe("not_found");
    expect(byJob.structuredContent.message).toMatch(/^Get job details failed: /);
    expect(byJob.structuredContent.message).toContain(`job_id=${JOB}`);
    expect(byJob.structuredContent.message).not.toContain("Dataset ID");

    const byDataset = await runOp("get_job_details", { dataset_id: DATASET });
    expect(byDataset.structuredContent.message).toBe(
      `Dataset ID '${DATASET}' not found or job not accessible. Make sure the dataset exists and you have permission to view it.`,
    );
  });

  it("offers job_id beside dataset_id and requires neither", () => {
    const t = opsTool("get_job_details");
    const base = renderOperation(getJobDetailsOp).parameters;
    const { properties, required } = t.parameters as typeof base;
    expect(base.required).toEqual(["dataset_id"]);
    expect(required).toBeUndefined();
    expect(properties).toEqual({
      ...base.properties,
      job_id: {
        type: "string",
        description: "Galaxy job id, as run_tool returns it. Give job_id or dataset_id.",
      },
    });
    const said = spellParamNames(describeOperation(getJobDetailsOp), getJobDetailsOp.input, snake);
    expect(t.description).toBe(
      `${said} Pass job_id to read a job directly, or dataset_id to find the job that made a dataset.`,
    );
  });
});

describe("list_jobs", () => {
  it("asks for one page of a history's jobs, newest first", async () => {
    const rows = [{ id: JOB, state: "ok", tool_id: "wc_gnu", create_time: "2026-10-17T10:00:00" }];
    const seen = recordGalaxy(() => json(rows));
    const result = await runOp("list_jobs", {
      history_id: "abcdef0123456789",
      limit: 5,
      offset: 10,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/api/jobs");
    expect(Object.fromEntries(seen[0].query)).toEqual({
      history_id: "abcdef0123456789",
      view: "collection",
      order_by: "create_time",
      // One row past the page, so whether another page exists is known, not guessed.
      limit: "6",
      offset: "10",
    });
    expect(result.structuredContent).toMatchObject({ success: true, data: rows, count: 1 });
  });

  it("reports where the next page starts, as the namespace tells the model to read it", async () => {
    const rows = Array.from({ length: 6 }, (_, n) => ({ id: `${JOB.slice(0, 15)}${n}` }));
    const seen = recordGalaxy(() => json(rows));
    const result = await runOp("list_jobs", {
      history_id: "abcdef0123456789",
      limit: 5,
      offset: 10,
    });
    expect(seen[0].query.get("limit")).toBe("6");
    expect(result.structuredContent).toMatchObject({
      success: true,
      count: 5,
      pagination: { has_next: true, next_offset: 15, offset: 10, limit: 5, returned_items: 5 },
    });
    expect(result.structuredContent.data).toEqual(rows.slice(0, 5));
    expect(result.structuredContent.pagination?.helper_text).toContain("offset=15");
  });

  it("says the last page is the last", async () => {
    recordGalaxy(() => json([{ id: JOB }, { id: JOB }, { id: JOB }]));
    const result = await runOp("list_jobs", {
      history_id: "abcdef0123456789",
      limit: 5,
      offset: 10,
    });
    expect(result.structuredContent).toMatchObject({
      count: 3,
      pagination: { has_next: false, next_offset: null, has_previous: true, previous_offset: 5 },
    });
  });

  it("defaults to fifty jobs from the start", async () => {
    const seen = recordGalaxy(() => json([]));
    await runOp("list_jobs", { history_id: "abcdef0123456789" });
    expect(seen[0].query.get("limit")).toBe("51");
    expect(seen[0].query.get("offset")).toBe("0");
  });

  it("refuses a reply that is not a list", async () => {
    recordGalaxy(() => json({ jobs: [] }));
    const result = await runOp("list_jobs", { history_id: "abcdef0123456789" });
    expect(result.structuredContent).toMatchObject({
      success: false,
      errorKind: "connection",
      message: "Galaxy's job index did not return a list",
    });
  });

  it("takes integers spelled as strings, as every Galaxy tool does", () => {
    const t = opsTool("list_jobs");
    const prepared = t.prepareArguments!({ history_id: "abc", limit: "5", offset: "0" });
    const validated = validateToolArguments(
      { name: t.name, description: t.description, parameters: t.parameters },
      { type: "toolCall", id: "c1", name: t.name, arguments: prepared },
    );
    expect(validated).toMatchObject({ limit: 5, offset: 0 });
  });

  it("is a read-only tool named in Galaxy's namespace", () => {
    const t = opsTool("list_jobs");
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(t.exposure).toBe("direct");
    expect(t.namespace?.name).toBe("galaxy");
    expect((t.parameters as { required: string[] }).required).toEqual(["history_id"]);
  });
});

describe("get_job_logs", () => {
  it("reads the job in full and returns only the logs the server sent", async () => {
    const seen = recordGalaxy(() => json({ ...JOB_RECORD, params: { input: "x" } }));
    const result = await runOp("get_job_logs", { job_id: JOB });
    expect(seen.map((s) => s.path)).toEqual([`/api/jobs/${JOB}`]);
    expect(seen[0].query.get("full")).toBe("true");
    expect(result.structuredContent).toMatchObject({
      success: true,
      message: `Retrieved logs for job '${JOB}'`,
    });
    // job_stderr is absent from the reply, so it is absent here rather than empty.
    expect(result.structuredContent.data).toEqual({
      job_id: JOB,
      state: "error",
      exit_code: 1,
      stdout: "",
      stderr: "wc: input: No such file",
      tool_stdout: "",
      tool_stderr: "wc: input: No such file",
      job_stdout: "",
    });
  });

  it("refuses a job id that is not one before asking Galaxy", async () => {
    const seen = recordGalaxy(() => json(JOB_RECORD));
    const result = await runOp("get_job_logs", { job_id: "." });
    expect(seen).toEqual([]);
    expect(result.structuredContent.errorKind).toBe("validation");
  });
});
