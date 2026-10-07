import * as fs from "fs";
import * as path from "path";
import { createGalaxyContext } from "@galaxyproject/galaxy-ops";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchTemplateWith,
  primeTemplateReplay,
  replayTemplateFetcher,
  TemplateUnavailableError,
} from "../extensions/loom/registry-templates";
import { tmpAnalysisDir } from "./registry-fixtures";
import { TOOL_BODY, TOOL_ID, UDT_SNAPSHOT, UDT_UUID } from "./registry-proposal-fixtures";

type Route = (url: URL) => unknown;

function ctx(routes: Record<string, Route>, seen: string[] = []) {
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    seen.push(`${url.pathname}${url.search}`);
    for (const [prefix, route] of Object.entries(routes)) {
      if (decodeURIComponent(url.pathname) === prefix) {
        return new Response(JSON.stringify(route(url)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ err_msg: "not found" }), { status: 404 });
  };
  return createGalaxyContext({ baseUrl: "https://galaxy.test", apiKey: "k", fetchImpl });
}

describe("fetching templates through galaxy-ops", () => {
  it("a tool: Galaxy's io_details description, at the version Galaxy reports", async () => {
    const seen: string[] = [];
    const snap = await fetchTemplateWith(
      ctx({ [`/api/tools/${TOOL_ID}`]: () => TOOL_BODY }, seen),
      { kind: "tool", tool_id: TOOL_ID, version: "unpinned" },
      "h1",
    );
    expect(snap).toEqual({ body: TOOL_BODY, version: "0.23.4+galaxy0" });
    expect(seen[0]).toMatch(/io_details=true/);
  });

  it("a workflow: details plus the run form's slots, latest version only", async () => {
    const routes = {
      "/api/workflows/wf1": () => ({ id: "wf1", name: "QC", version: 3, inputs: {}, steps: {} }),
      "/api/workflows/wf1/download": () => ({
        steps: [{ step_type: "data_input", step_index: 0, step_label: "forward", inputs: [{}] }],
      }),
    };
    const snap = await fetchTemplateWith(
      ctx(routes),
      { kind: "workflow", workflow_id: "wf1", version: "unpinned" },
      "h1",
    );
    expect(snap.version).toBe("3");
    expect((snap.body as { slots: Array<{ label: string }> }).slots[0].label).toBe("forward");

    await expect(
      fetchTemplateWith(ctx(routes), { kind: "workflow", workflow_id: "wf1", version: "2" }, "h1"),
    ).rejects.toThrow(/only read the run form of the latest version/);
  });

  it("a user-defined tool: found by uuid in the user's tools", async () => {
    const snap = await fetchTemplateWith(
      ctx({ "/api/unprivileged_tools": () => [{ uuid: "other" }, UDT_SNAPSHOT.body] }),
      { kind: "udt", tool_uuid: UDT_UUID, version: "unpinned" },
      "h1",
    );
    expect(snap).toEqual(UDT_SNAPSHOT);
    await expect(
      fetchTemplateWith(
        ctx({ "/api/unprivileged_tools": () => [] }),
        { kind: "udt", tool_uuid: UDT_UUID, version: "unpinned" },
        "h1",
      ),
    ).rejects.toThrow(/no active user-defined tool/);
  });

  it("turns a Galaxy failure into a sentence", async () => {
    const err = await fetchTemplateWith(
      ctx({}),
      { kind: "tool", tool_id: "nope", version: "unpinned" },
      "h",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TemplateUnavailableError);
    expect(err.message).toMatch(/Galaxy couldn't describe tool nope/);
  });
});

describe("template replay (eval seam)", () => {
  let dir: string;
  const saved = process.env.LOOM_TEMPLATE_REPLAY;
  beforeEach(() => {
    dir = tmpAnalysisDir();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOM_TEMPLATE_REPLAY;
    else process.env.LOOM_TEMPLATE_REPLAY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is off unless the variable is set", () => {
    delete process.env.LOOM_TEMPLATE_REPLAY;
    expect(replayTemplateFetcher(dir)).toBeNull();
  });

  it("answers from the file and writes a template.replay row every time", async () => {
    fs.writeFileSync(
      path.join(dir, "templates.json"),
      JSON.stringify({ [`tool:${TOOL_ID}`]: { body: TOOL_BODY, version: "0.23.4+galaxy0" } }),
    );
    process.env.LOOM_TEMPLATE_REPLAY = "templates.json";
    const fetcher = replayTemplateFetcher(dir)!;
    const snap = await fetcher({ kind: "tool", tool_id: TOOL_ID, version: "unpinned" }, "h");
    expect(snap.version).toBe("0.23.4+galaxy0");
    const rows = fs.readFileSync(path.join(dir, "activity.jsonl"), "utf-8").trim().split("\n");
    expect(JSON.parse(rows[0])).toMatchObject({
      kind: "template.replay",
      source: "template-replay",
    });
  });

  it("refuses a file outside the session directory", async () => {
    process.env.LOOM_TEMPLATE_REPLAY = "../elsewhere.json";
    const fetcher = replayTemplateFetcher(dir)!;
    await expect(fetcher({ kind: "tool", tool_id: "x", version: "unpinned" }, "h")).rejects.toThrow(
      /outside the session directory/,
    );
  });
});

describe("review follow-ups", () => {
  it("refuses a tool description for a different tool than the one asked for", async () => {
    await expect(
      fetchTemplateWith(
        ctx({ [`/api/tools/${TOOL_ID}`]: () => ({ ...TOOL_BODY, id: "toolshed/other/9.9" }) }),
        { kind: "tool", tool_id: TOOL_ID, version: "unpinned" },
        "h",
      ),
    ).rejects.toThrow(/answered with tool toolshed\/other\/9.9/);
  });

  it("reads the replay file once, so a later edit to it changes nothing", async () => {
    const dir = tmpAnalysisDir();
    const saved = process.env.LOOM_TEMPLATE_REPLAY;
    try {
      const file = path.join(dir, "templates.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ [`tool:${TOOL_ID}`]: { body: TOOL_BODY, version: "0.23.4+galaxy0" } }),
      );
      process.env.LOOM_TEMPLATE_REPLAY = "templates.json";
      primeTemplateReplay(dir);
      fs.writeFileSync(
        file,
        JSON.stringify({ [`tool:${TOOL_ID}`]: { body: { inputs: [] }, version: "6.6.6" } }),
      );
      const snap = await replayTemplateFetcher(dir)!(
        { kind: "tool", tool_id: TOOL_ID, version: "unpinned" },
        "h",
      );
      expect(snap.version).toBe("0.23.4+galaxy0");
    } finally {
      if (saved === undefined) delete process.env.LOOM_TEMPLATE_REPLAY;
      else process.env.LOOM_TEMPLATE_REPLAY = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
