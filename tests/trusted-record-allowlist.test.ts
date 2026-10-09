/**
 * The trusted-record profile (registry design v3 §11) is an exact allowlist.
 * Its point is that a tool nobody reviewed can't write the record, so the
 * test that matters most is the last one: every tool the brain registers and
 * every galaxy-mcp tool has to be either allowed or excluded with a reason, and
 * a new one fails here until somebody decides which.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  TRUSTED_RECORD_ALLOWED,
  TRUSTED_RECORD_EXCLUDED,
  shouldBlockTool,
} from "../web/extensions/web-mode-gate";
import { GALAXY_MCP_TOOLS } from "../extensions/loom/observation-allowlists";

const NB = "/tmp/loom-session/notebook.md";
const block = (tool: string, input: Record<string, unknown> = {}) =>
  shouldBlockTool(tool, input, [NB], "/tmp/loom-session", "trustedRecord");

/** Every tool the brain registers, read off a stand-in pi with the experiments on. */
async function registeredBrainTools(): Promise<string[]> {
  const names: string[] = [];
  const noop = () => undefined;
  const pi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "registerTool") return (def: { name: string }) => names.push(def.name);
        if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
        if (prop === "events") return { on: noop, emit: noop };
        return noop;
      },
    },
  );
  const saved = { ...process.env };
  process.env.LOOM_LOCAL_EXEC = "off";
  process.env.LOOM_TEAM_DISPATCH = "1";
  process.env.LOOM_SESSION_INDEX = "1";
  try {
    const mod = await import("../extensions/loom/index");
    mod.default(pi as never);
  } finally {
    process.env = saved;
  }
  return [...new Set(names)].sort();
}

afterEach(() => {
  delete process.env.LOOM_TRUSTED_RECORD;
});

describe("trusted-record profile", () => {
  it("lets the reviewed tools through", () => {
    for (const tool of [
      "loom_propose",
      "galaxy_job_record",
      "notebook_pull_from_galaxy",
      "mcp__galaxy__get_tool_details",
      "mcp__galaxy__get_page",
    ])
      expect(block(tool), tool).toBeUndefined();
  });

  it("denies the raw submission tools and code mode, saying why", () => {
    for (const tool of [
      "mcp__galaxy__run_tool",
      "mcp__galaxy__invoke_workflow",
      "mcp__galaxy__run_user_tool",
      "mcp__galaxy__run_galaxy_tool",
      // Page content carries the registry; only the harness push writes it.
      "mcp__galaxy__update_page",
      "mcp__galaxy__create_page",
      "mcp__galaxy__revert_page_revision",
    ]) {
      const d = block(tool);
      expect(d?.block, tool).toBe(true);
      expect(d?.reason, tool).toMatch(/trusted-record/);
    }
  });

  it("denies anything unlisted, a lookalike prefix, another server, and a proxy", () => {
    for (const tool of [
      "galaxy_brand_new_tool",
      "mcp__galaxy___run_tool",
      "mcp__galaxy__x__run_tool",
      "mcp__brc_analytics__search",
      "mcp",
      "bash",
      "grep",
    ])
      expect(block(tool)?.block, tool).toBe(true);
  });

  it("allows download_dataset only without a file_path", () => {
    expect(block("mcp__galaxy__download_dataset", { dataset_id: "a1" })).toBeUndefined();
    expect(
      block("mcp__galaxy__download_dataset", { dataset_id: "a1", file_path: "/tmp/x" })?.block,
    ).toBe(true);
  });

  it("keeps the file tools on the notebook and nothing else", () => {
    expect(block("edit", { path: NB })).toBeUndefined();
    expect(block("write", { path: "/tmp/loom-session/.loom/state/registry.json" })?.block).toBe(
      true,
    );
  });

  it("keeps blocking destructive Galaxy operations", () => {
    expect(
      block("mcp__galaxy__update_history", { history_id: "h", deleted: true, purged: true })?.block,
    ).toBe(true);
  });

  it("the default profile is unchanged, apart from loom_propose now being reachable", () => {
    const dflt = (tool: string) => shouldBlockTool(tool, {}, [NB], "/tmp/loom-session");
    expect(dflt("mcp__galaxy__run_tool")).toBeUndefined();
    expect(dflt("loom_propose")).toBeUndefined();
    expect(dflt("galaxy_upload_local_file")?.block).toBe(true);
  });

  it("no tool is both allowed and excluded", () => {
    for (const tool of Object.keys(TRUSTED_RECORD_EXCLUDED))
      expect(TRUSTED_RECORD_ALLOWED.has(tool), tool).toBe(false);
  });

  it("every registered tool is either allowed or excluded with a reason", async () => {
    const brain = await registeredBrainTools();
    // The walk has to have reached the extension's tools, or this proves nothing.
    expect(brain).toEqual(expect.arrayContaining(["loom_propose", "galaxy_job_record"]));
    const galaxy = [...GALAXY_MCP_TOOLS].map((t) => `mcp__galaxy__${t.replace(/^galaxy_/, "")}`);
    const undecided = [...brain, ...galaxy].filter(
      (t) => !TRUSTED_RECORD_ALLOWED.has(t) && !(t in TRUSTED_RECORD_EXCLUDED),
    );
    expect(undecided, "add each to TRUSTED_RECORD_ALLOWED or TRUSTED_RECORD_EXCLUDED").toEqual([]);
  });
});
