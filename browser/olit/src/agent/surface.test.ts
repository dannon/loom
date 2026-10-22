/**
 * What the agent sends a model and what its tools say back, pinned byte for byte. Restructuring
 * the agent must leave every one of these as it is: a changed snapshot is a changed agent.
 */
import { contentText, type Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { olitFlavor } from "./flavor";
import { annotating, noteTag } from "@galaxyproject/orbit-browser/testing";
import type { Galaxy } from "@galaxyproject/orbit-browser/agent";
import { Headless, type HeadlessConfig } from "@galaxyproject/orbit-browser/node";
import { flavoredSkills } from "@galaxyproject/orbit-browser/testing";
import type { Context, Python } from "@galaxyproject/orbit-browser/agent";
import { agentTools } from "@galaxyproject/orbit-browser/testing";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";
const SNAPSHOTS = "./__surface__";

type Reply = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

let callIds = 0;

function sse(reply: Reply): Response {
  const chunks: unknown[] = [];
  if (reply.text) chunks.push({ choices: [{ index: 0, delta: { content: reply.text } }] });
  (reply.calls ?? []).forEach((call, index) =>
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${++callIds}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
        },
      ],
    }),
  );
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: reply.calls?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function server(replies: Reply[]) {
  const requests: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.href.startsWith(LLM)) {
      requests.push(JSON.parse(await request.text()));
      return sse(replies.shift() ?? { text: "done" });
    }
    const path = url.pathname.replace(/^\//, "");
    return json(path === "api/version" ? { version_major: "26.1" } : {});
  });
  return requests;
}

const python: Python = { run: async () => "", write: async () => {}, read: async () => undefined };

const opened: Headless[] = [];

async function turn(replies: Reply[], over: Partial<HeadlessConfig> = {}) {
  const requests = server(replies);
  const session = await Headless.open(
    {
      galaxy_root: ROOT,
      ai_base_url: LLM,
      ai_model: "test-model",
      ai_api_key: "sk-x",
      poll_ms: 10,
      ...over,
    },
    { python, flavor: olitFlavor },
  );
  opened.push(session);
  const result = await session.turn("hi");
  return { requests, result };
}

const results = (entries: readonly EntryRecord[]) =>
  entries
    .flatMap((e) => (e.kind === "pi.system" ? [] : ((e.model ?? []) as Message[])))
    .filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult")
    .map((m) => contentText(m.content));

/** As written, with the session's own directory (it varies per run) named for what it is. */
const pretty = (value: unknown) =>
  `${JSON.stringify(value, null, 2)}\n`.replaceAll(opened[0]?.root ?? "\0", "<session>");

beforeAll(() => {
  // The prompt carries today's date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
  vi.unstubAllGlobals();
});

describe("the first request a launch sends", () => {
  const LAUNCHES: Record<string, Partial<HeadlessConfig>> = {
    plain: {},
    dataset: { history_id: "h1", dataset_id: "d1" },
    "read-only": { capabilities: ["llm", "read"] },
  };

  for (const [name, over] of Object.entries(LAUNCHES)) {
    it(`is unchanged for a ${name} launch: system prompt and tools, in order`, async () => {
      const { requests } = await turn([{ text: "ok" }], over);
      const { messages, tools } = requests[0];
      await expect(pretty({ messages, tools })).toMatchFileSnapshot(
        `${SNAPSHOTS}/request-${name}.json`,
      );
    });
  }
});

describe("the skills the agent is offered", () => {
  it("routes to the same corpus", async () => {
    const skills = flavoredSkills(olitFlavor);
    const fetch = agentTools(skills, olitFlavor).find((t) => t.name === "skills_fetch")!;
    await expect(
      pretty({
        router: skills.routerText(),
        repos: (fetch.parameters as { properties: { repo: { enum: string[] } } }).properties.repo
          .enum,
      }),
    ).toMatchFileSnapshot(`${SNAPSHOTS}/skills.json`);
  });
});

describe("the composed tools", () => {
  it("keep their order, capabilities and traits", async () => {
    const traits = agentTools(flavoredSkills(olitFlavor), olitFlavor).map((t) => ({
      name: t.name,
      capability: t.capability ?? null,
      requires: t.requires ?? null,
      settled: t.settled === true,
      polls: t.polls ?? null,
      destructive: t.destructive === true,
      destructiveWhen: typeof t.destructiveWhen === "function",
    }));
    await expect(pretty(traits)).toMatchFileSnapshot(`${SNAPSHOTS}/traits.json`);
  });

  it("send a Galaxy call aimed at one of the agent's own tools back to it", async () => {
    const { result } = await turn([
      {
        calls: [
          { name: "run_tool", args: { history_id: "h1", tool_id: "lineage_report", inputs: {} } },
        ],
      },
      {
        calls: [
          { name: "run_tool", args: { history_id: "h1", tool_id: "vega_dataset", inputs: {} } },
        ],
      },
      { calls: [{ name: "search_tools_by_name", args: { query: "vega_dataset" } }] },
      { calls: [{ name: "search_tools_by_name", args: { query: "lineage_report" } }] },
      { text: "ok" },
    ]);
    await expect(pretty(results(result.entries))).toMatchFileSnapshot(
      `${SNAPSHOTS}/misroutes.json`,
    );
  });
});

describe("what a galaxy-ops result is annotated with", () => {
  const galaxy = {
    root: ROOT,
    get: async (path: string) => {
      if (path === "api/plugins") {
        return [
          { name: "ngl", html: "NGL Structure Viewer", tags: ["Viewer"] },
          { name: "plotly", html: "Bar, Line and Scatter", tags: ["Plotly", "Chart"] },
          { name: "olit", html: "AI Research Assistant" },
        ];
      }
      if (path === "api/invocations/i1/jobs_summary") return { states: { error: 1, ok: 2 } };
      return {};
    },
  } as unknown as Galaxy;
  const ctx = { galaxy } as unknown as Context;
  const annotate = annotating(olitFlavor.annotators, noteTag(olitFlavor.brand!));

  const CASES: Array<[string, Record<string, unknown>, unknown]> = [
    ["search_tools_by_name", { query: "structure viewer" }, []],
    ["search_tools_by_keywords", { keywords: ["plotly"] }, []],
    ["search_tools_by_name", { query: "bowtie2" }, []],
    ["search_tools_by_name", { query: "chart" }, [{ id: "heatmap2" }]],
    ["recommend_iwc_workflows", {}, []],
    ["search_iwc_workflows", {}, []],
    ["get_invocations", {}, [{ id: "i1", state: "scheduled" }]],
    ["get_invocations", {}, { id: "i2", state: "scheduled", outcome: "failing" }],
    [
      "get_dataset_details",
      {},
      {
        id: "d1",
        state: "error",
        misc_info: "Failed to fetch url https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR390728_1.fastq.gz",
      },
    ],
    [
      "get_dataset_details",
      {},
      { id: "d2", state: "error", misc_info: "Failed to fetch url https://example.org/1.fq" },
    ],
    ["get_histories", {}, [{ id: "h1" }]],
  ];

  it("is unchanged for each kind of result", async () => {
    const out = [];
    for (const [name, args, data] of CASES) {
      out.push({ name, args, note: (await annotate(name, args, data, ctx)) ?? null });
    }
    await expect(pretty(out)).toMatchFileSnapshot(`${SNAPSHOTS}/annotations.json`);
  });
});
