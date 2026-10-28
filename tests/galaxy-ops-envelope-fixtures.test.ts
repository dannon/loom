import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareFamily } from "../shared/galaxy-tool-family.js";
import { createGalaxyOpsToolSource } from "../extensions/loom/galaxy-ops-tools";
import { parseSubmission, resolveResultPayload } from "../extensions/loom/galaxy-submission";
import { submissionToolName } from "../extensions/loom/galaxy-submission-capture";
import { renderGalaxyResult, GALAXY_SPILL_BYTES } from "../extensions/loom/galaxy-tool-wrap";
import {
  createMemoryOutputStore,
  galaxyOutputStore,
  setGalaxyOutputStore,
} from "../extensions/loom/galaxy-output-store";

/**
 * Real tool results from the in-process galaxy-ops source, captured against
 * test.galaxyproject.org in slice 2d (one history: a local upload, a URL upload,
 * then cat1 over the first). Each fixture is `{op, args, result}`, where `result`
 * is exactly what the tool's execute returned -- the shape pi hands
 * tool_execution_end. User email, username and id are replaced with placeholders.
 */
type Fixture = { op: string; args: Record<string, unknown>; result: Record<string, unknown> };

const DIR = join(__dirname, "fixtures", "galaxy-ops-envelopes");
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;

const HISTORY = "f1c07d6d09a43dbd";
const CAT1_JOB = "6cdd6edf01c98f71";

const family = bareFamily(
  createGalaxyOpsToolSource()
    .tools()
    .map((t) => t.name),
);

function parseBare(name: string) {
  const fx = load(name);
  const table = submissionToolName(fx.op, family);
  expect(table, `${fx.op} should map to a submission tool`).toBeDefined();
  return parseSubmission(table!, fx.args, resolveResultPayload(fx.result));
}

describe("real galaxy-ops envelopes through the submission parsers", () => {
  it("every fixture is a flat envelope behind details.galaxy, text identical to structuredContent", () => {
    for (const name of ["run_tool", "upload_file", "upload_file_from_url"]) {
      const { op, result } = load(name);
      const details = result.details as { galaxy: { tool: string; outputId?: string } };
      expect(details.galaxy.tool).toBe(op);
      expect(details.galaxy.outputId).toBeUndefined();
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
      expect(resolveResultPayload(result).value).toEqual(result.structuredContent);
    }
  });

  it("run_tool parses to the cat1 job in the capture history", () => {
    const out = parseBare("run_tool");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.kind).toBe("jobs");
    expect(out.submission.historyId).toBe(HISTORY);
    expect(out.submission.partial).toBeUndefined();
    expect(out.submission.jobs).toEqual([
      { jobId: CAT1_JOB, toolId: "cat1", toolVersion: "1.0.0", historyId: HISTORY },
    ]);
    expect(out.submission.label).toBe("cat1");
  });

  it("run_tool still parses from the text alone (pi dropped structuredContent)", () => {
    const { args, result } = load("run_tool");
    const { structuredContent: _dropped, ...rest } = result;
    const out = parseSubmission("run_tool", args, resolveResultPayload(rest));
    expect(out.ok && out.submission.jobs?.[0].jobId).toBe(CAT1_JOB);
  });

  it("upload_file parses to its __DATA_FETCH__ job", () => {
    const out = parseBare("upload_file");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs).toEqual([
      {
        jobId: "5517124ff5f55d4f",
        toolId: "__DATA_FETCH__",
        toolVersion: "0.1.0",
        historyId: HISTORY,
      },
    ]);
    expect(out.submission.label).toBe("Upload input.txt");
  });

  it("upload_file_from_url parses to its upload1 job", () => {
    const out = parseBare("upload_file_from_url");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs).toEqual([
      { jobId: "73d7527921714ccc", toolId: "upload1", toolVersion: "1.1.7", historyId: HISTORY },
    ]);
  });

  it("read ops are not submissions", () => {
    for (const op of ["get_job_details", "get_history_contents", "get_invocations", "list_jobs"]) {
      expect(submissionToolName(op, family)).toBeUndefined();
    }
  });
});

describe("a spilled real submission", () => {
  afterEach(() => setGalaxyOutputStore(null));

  it("parses from the saved copy when only the preview and outputId survive", () => {
    setGalaxyOutputStore(createMemoryOutputStore());
    const { args, result } = load("run_tool");
    const env = structuredClone(result.structuredContent) as { data: { outputs: unknown[] } };
    // Pad past the spill threshold the way a large map-over response would be.
    const out0 = env.data.outputs[0];
    while (JSON.stringify(env).length <= GALAXY_SPILL_BYTES) env.data.outputs.push(out0);
    const rendered = renderGalaxyResult("run_tool", env as never, 1);
    const outputId = rendered.details.galaxy.outputId;
    expect(outputId).toBeDefined();
    // pi drops structuredContent when a handler rewrites content: only text + details remain.
    const resolved = resolveResultPayload({ content: rendered.content, details: rendered.details });
    expect(resolved.outputId).toBe(outputId);
    expect(parseSubmission("run_tool", args, resolved).ok).toBe(false);
    const reread = { ...resolved, text: galaxyOutputStore().get(outputId!), value: undefined };
    const out = parseSubmission("run_tool", args, reread);
    expect(out.ok && out.submission.jobs?.map((j) => j.jobId)).toEqual([CAT1_JOB]);
  });
});
