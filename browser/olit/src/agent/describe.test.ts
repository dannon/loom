import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { agentSources, describe as describeOlit } from "@galaxyproject/orbit-browser/node";
import { olitFlavor } from "./flavor";
import { olitLayout } from "./layout";
import { PROVIDERS } from "@galaxyproject/orbit-browser/testing";
import { GUARDS } from "@galaxyproject/orbit-browser/testing";

// The workspace root, whichever directory vitest runs from.
const ROOT = join(__dirname, "..", "..", "..");
type Description = Awaited<ReturnType<typeof describeOlit>>;
let doc: Description;

// Each description boots Orbit's brain twice (a full grant and a read-only one).
beforeAll(async () => {
  doc = await describeOlit(olitLayout(ROOT), olitFlavor);
}, 120_000);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "skills" ? [] : sources(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the description Olit publishes about itself", { timeout: 120_000 }, () => {
  it("is JSON and names its schema", () => {
    expect(doc.schema).toBe(1);
    expect(doc.agent).toBe("olit");
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("describes every tool the model is shown, as a plain launch's first request has them", () => {
    const request = JSON.parse(
      readFileSync(join(__dirname, "__surface__", "request-plain.json"), "utf8"),
    ) as { tools: Array<{ function: { name: string } }> };
    expect(Object.keys(doc.tools).sort()).toEqual(request.tools.map((t) => t.function.name).sort());
  });

  it("gives each tool its contract", () => {
    const tool = doc.tools.get_job_details as Record<string, unknown>;
    expect(tool.capability).toBe("read");
    expect(Object.keys(tool).sort()).toEqual(
      ["capability", "runner", "signature", "params", "prose", "result"].sort(),
    );
  });

  it("says which tools galaxy-ops runs, which Olit adds and which are Orbit's own", () => {
    const tools = doc.tools as Record<string, { runner: string }>;
    expect(tools.get_histories.runner).toBe("galaxy-ops");
    expect(tools.get_history_contents.runner).toBe("galaxy-ops");
    expect(tools.download_dataset.runner).toBe("olit");
    expect(tools.run_python.runner).toBe("olit");
    expect(tools.skills_fetch.runner).toBe("orbit");
  });

  it("names the sections of the prompt the brain sends", () => {
    expect(doc.prompt_blocks).toEqual(expect.arrayContaining(["Current date", "Olit terms"]));
  });

  it("covers the agent's modules and skips the vendored skills", () => {
    expect(doc.symbols).toHaveProperty(["src/agent/runtime.ts"]);
    expect(Object.keys(doc.symbols).filter((m) => m.includes("/skills/"))).toEqual([]);
  });

  it("reports the loop bounds, and no guard inventory", () => {
    expect(doc.policy.loop.max_steps).toBeGreaterThan(0);
    expect(doc.policy.guards).toEqual([]);
    expect(doc.policy.llm_request.sampling).toHaveProperty("max_tokens");
  });

  it("names the skills Orbit vendors and the commit they came from", () => {
    expect(doc.skills.vendored).toBe(true);
    expect(doc.skills.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("has no record to open: the record is the page made on its first write", () => {
    expect(doc.record).toEqual({ starter: "", resume_tool: null });
  });

  it("reads the request off the real request, so leaving tool_choice to the provider shows", () => {
    expect(doc.policy.llm_request.body_keys).toContain("model");
    expect(doc.policy.llm_request.body_keys).not.toContain("messages");
    expect(doc.policy.llm_request.with_tools).toEqual({ tool_choice: null });
  });

  it("reads the identity prompt from the plugin manifest", () => {
    expect(doc.identity_prompt.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.identity_prompt.text).toContain("You both talk and act.");
  });

  it("publishes every provider's endpoint and key variable", () => {
    expect(Object.keys(doc.providers)).toEqual(PROVIDERS.map((p) => p.id));
    expect(doc.providers.jetstream2).toEqual({
      base_url: "https://llm.jetstream-cloud.org/api",
      auth_env: "JETSTREAM2_KEY",
    });
  });

  it("publishes the follow-up contract every driver shares", () => {
    expect(doc.follow_ups).toEqual({ max_auto_follow_ups: 3, settled_by: "watch" });
  });

  it("gives the same answer twice", async () => {
    expect(await describeOlit(olitLayout(ROOT), olitFlavor)).toEqual(doc);
  });
});

describe("the guard inventory", () => {
  // The Guard type is derived from GUARDS, so the compiler already refuses a guard the policy
  // does not publish. The reverse needs a look at the source.
  it("publishes no guard the code never sets", () => {
    const code = agentSources(olitLayout(ROOT))
      .flatMap((source) => sources(join(source, "src/agent")))
      .filter((path) => !path.endsWith("/tool.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(GUARDS.filter((g) => !code.includes(`"${g}"`))).toEqual([]);
  });

  it("includes the guard observed refusing live", () => {
    expect(GUARDS).toContain("malformed-object-id");
  });
});
