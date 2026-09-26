import { readFileSync } from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  galaxyCreateHistory,
  galaxyGetToolInputTemplate,
  galaxyGetUserToolDefinition,
  galaxyGetWorkflowInputTemplate,
  galaxyInvokeWorkflow,
  galaxyRunTool,
  galaxyRunUserTool,
} from "../extensions/loom/galaxy-api";

const FIXTURES = path.join(__dirname, "fixtures", "galaxy-rest");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8"));
}

interface GoldenRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function golden(name: string): GoldenRequest {
  return fixture(path.join("golden", name)) as GoldenRequest;
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let captured: Captured[] = [];

function answerWith(response: unknown) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, json: async () => response } as unknown as Response;
  });
  global.fetch = mock as unknown as typeof fetch;
}

describe("harness submission REST calls", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    captured = [];
    process.env.GALAXY_URL = "https://g.example/";
    process.env.GALAXY_API_KEY = "k";
  });

  afterEach(() => {
    global.fetch = origFetch;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    vi.restoreAllMocks();
  });

  describe("golden payloads", () => {
    it("runs an installed tool with the pinned version", async () => {
      answerWith(fixture("run-tool.response.json"));
      const res = await galaxyRunTool({
        historyId: "df8fe5ddadbf3ab1",
        toolId: "cat1",
        toolVersion: "1.0.0",
        inputs: {
          input1: { src: "hda", id: "4b6e2f1a9c3d5e70" },
          "queries_0|input2": { src: "hda", id: "8c1d3e5f7a9b0c21" },
        },
      });
      const want = golden("run-tool.request.json");
      expect(captured).toHaveLength(1);
      expect({ method: captured[0].method, url: captured[0].url, body: captured[0].body }).toEqual(
        want,
      );
      expect(captured[0].headers["x-api-key"]).toBe("k");
      expect(res.jobs[0].id).toBe("7dd125b61b35d782");
      expect(res.outputs[0].id).toBe("aeb65580396167f3");
    });

    it("runs a user-defined tool by uuid and never sends a tool_id", async () => {
      answerWith(fixture("run-user-tool.response.json"));
      const res = await galaxyRunUserTool({
        historyId: "df8fe5ddadbf3ab1",
        toolUuid: "61d15277-a911-45ef-aa66-5385146578cc",
        toolVersion: "0.1.0",
        inputs: {
          scorer_output: { src: "hda", id: "59ace41fc068d3ad" },
          top_tracks_per_variant: 5,
        },
      });
      const want = golden("run-user-tool.request.json");
      expect({ method: captured[0].method, url: captured[0].url, body: captured[0].body }).toEqual(
        want,
      );
      expect(captured[0].body).not.toHaveProperty("tool_id");
      expect(res.jobs[0].id).toBe("5a1b9c3d7e2f4a60");
    });

    it("invokes a workflow into a concrete history with exact versions", async () => {
      answerWith(fixture("invoke-workflow.response.json"));
      const res = await galaxyInvokeWorkflow({
        workflowId: "97ed37bc0e78b990",
        historyId: "df8fe5ddadbf3ab1",
        inputs: { "0": { src: "hdca", id: "a3f0c9e18b2d4c67" }, "1": 1000 },
        parameters: { "3": { outFileFormat: "bigwig" } },
        version: 1,
      });
      const want = golden("invoke-workflow.request.json");
      expect({ method: captured[0].method, url: captured[0].url, body: captured[0].body }).toEqual(
        want,
      );
      expect(res.id).toBe("c2a7f40e9b1d3856");
      expect(res.history_id).toBe("df8fe5ddadbf3ab1");
    });

    it("leaves parameters and version out of a workflow payload when there are none", async () => {
      answerWith(fixture("invoke-workflow.response.json"));
      await galaxyInvokeWorkflow({
        workflowId: "97ed37bc0e78b990",
        historyId: "df8fe5ddadbf3ab1",
        inputs: { "0": { src: "hdca", id: "a3f0c9e18b2d4c67" } },
        parameters: {},
      });
      expect(captured[0].body).not.toHaveProperty("parameters");
      expect(captured[0].body).not.toHaveProperty("version");
    });

    it("creates a history", async () => {
      answerWith(fixture("create-history.response.json"));
      const res = await galaxyCreateHistory("AlphaGenome rerun");
      const want = golden("create-history.request.json");
      expect({ method: captured[0].method, url: captured[0].url, body: captured[0].body }).toEqual(
        want,
      );
      expect(res.id).toBe("df8fe5ddadbf3ab1");
    });
  });

  describe("template fetches", () => {
    it("fetches a tool's io_details schema, pinned to a version when given", async () => {
      answerWith(fixture("tool-cat1.io-details.json"));
      const schema = await galaxyGetToolInputTemplate("cat1", "1.0.0");
      expect(captured[0].method).toBe("GET");
      expect(captured[0].url).toBe(
        "https://g.example/api/tools/cat1?io_details=true&tool_version=1.0.0",
      );
      expect(schema.id).toBe("cat1");
      expect(schema.version).toBe("1.0.0");
    });

    it("encodes a toolshed id into one path segment", async () => {
      answerWith(fixture("tool-cat1.io-details.json"));
      await galaxyGetToolInputTemplate("toolshed.g2.bx.psu.edu/repos/iuc/fastqc/fastqc/0.74");
      expect(captured[0].url).toBe(
        "https://g.example/api/tools/toolshed.g2.bx.psu.edu%2Frepos%2Fiuc%2Ffastqc%2Ffastqc%2F0.74?io_details=true",
      );
    });

    it("fetches the workflow run form as a stored workflow", async () => {
      answerWith(fixture("workflow-bigwig-average.run-form.json"));
      const form = await galaxyGetWorkflowInputTemplate("97ed37bc0e78b990", "df8fe5ddadbf3ab1");
      expect(captured[0].url).toBe(
        "https://g.example/api/workflows/97ed37bc0e78b990/download?style=run&instance=false&history_id=df8fe5ddadbf3ab1",
      );
      expect(form.id).toBe("97ed37bc0e78b990");
      expect((form.steps as unknown[]).length).toBe(4);
    });

    it("fetches a user-defined tool's definition by uuid", async () => {
      answerWith(fixture("user-tool-definition.response.json"));
      const def = await galaxyGetUserToolDefinition("61d15277-a911-45ef-aa66-5385146578cc");
      expect(captured[0].url).toBe(
        "https://g.example/api/unprivileged_tools/61d15277-a911-45ef-aa66-5385146578cc",
      );
      expect((def.representation as { version: string }).version).toBe("0.1.0");
    });
  });
});
