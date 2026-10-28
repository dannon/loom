import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import { fixtureFetch } from "../extensions/loom/galaxy-fixture";
import { registerGalaxyHistoryGuard } from "../extensions/loom/galaxy-history-guard";
import { GALAXY } from "./galaxy-family-fixture";
import { guardHooks } from "./galaxy-test-helpers";

const check = (toolName: string, input: Record<string, unknown>) =>
  guardHooks(
    registerGalaxyHistoryGuard,
    GALAXY,
    {},
  )("tool_call", {
    toolName,
    toolCallId: "c1",
    input,
  });

type FixtureRoute = Parameters<typeof fixtureFetch>[0][number];

const RUN = "run_tool";
const dataset = (id: string, history_id: string): FixtureRoute => ({
  path: `/api/datasets/${id}`,
  responses: [{ status: 200, body: { id, name: `${id}.txt`, history_id } }],
});

beforeEach(() => {
  vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
  vi.stubEnv("GALAXY_API_KEY", "fixture-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setGalaxyFetchOverride(null);
});

describe("registerGalaxyHistoryGuard", () => {
  it("lets inputs from the job's own history through", async () => {
    setGalaxyFetchOverride(fixtureFetch([dataset("d1", "here")]));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("finds a foreign collection and a foreign dataset nested in a repeat", async () => {
    setGalaxyFetchOverride(
      fixtureFetch([
        dataset("d1", "here"),
        dataset("d2", "elsewhere"),
        {
          path: "/api/dataset_collections/c1",
          responses: [{ status: 200, body: { id: "c1", name: "pairs", history_id: "other" } }],
        },
      ]),
    );
    const input = {
      history_id: "here",
      inputs: {
        queries_0: { input2: { src: "hda", id: "d1" } },
        queries_1: { input2: { values: [{ src: "hda", id: "d2" }] } },
        reads: { src: "hdca", id: "c1" },
      },
    };
    const foreign = [
      {
        input: "queries_1.input2.values[0]",
        supplied_id: "d2",
        history_id: "elsewhere",
        name: "d2.txt",
      },
      { input: "reads", supplied_id: "c1", history_id: "other", name: "pairs" },
    ];
    // Orbit's text is the base; the browser's guards.test.ts follows it when slice 4 lands.
    expect(await check(RUN, input)).toEqual({
      block: true,
      reason:
        "Refused: these inputs are in another history, not in history here " +
        `where this job runs: ${JSON.stringify(foreign)}. An id from another history is ` +
        "usually the wrong one: take the input's `id` from get_history_contents for this " +
        "history. If the user does mean that data, say which history it is in and ask them " +
        "to copy it into this one in Galaxy, then use the copy's id.",
    });
  });

  it("leaves an id Galaxy can't resolve for the run to report", async () => {
    setGalaxyFetchOverride(fixtureFetch([]));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "missing" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("fails open when Galaxy can't be reached", async () => {
    setGalaxyFetchOverride(() => Promise.reject(new TypeError("fetch failed")));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check(RUN, input)).toBeUndefined();
  });

  it("only checks run_tool", async () => {
    const fetch = vi.fn(fixtureFetch([dataset("d1", "elsewhere")]));
    setGalaxyFetchOverride(fetch);
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    expect(await check("get_dataset_details", input)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
