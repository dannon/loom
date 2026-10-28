/**
 * What the brain registers for Galaxy at extension load, read off a stand-in pi: the in-process
 * tools under their bare names in every Node shell, and brc-analytics as the one MCP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../extensions/loom/galaxy-version-capture", async (importOriginal) => {
  const real = await importOriginal<typeof import("../extensions/loom/galaxy-version-capture")>();
  return { ...real, registerGalaxyVersionCapture: vi.fn(real.registerGalaxyVersionCapture) };
});

import { allOperations } from "@galaxyproject/galaxy-ops";
import { installedCapabilityProfile, setCapabilityProfile } from "../shared/capability-profile.js";
import { registerGalaxyVersionCapture } from "../extensions/loom/galaxy-version-capture";
import { galaxyToolFamily, setGalaxyToolSource } from "../extensions/loom/galaxy-tool-source";

interface Loaded {
  tools: string[];
  servers: string[];
  on: Map<string, number>;
}

async function load(env: Record<string, string>): Promise<Loaded> {
  const loaded: Loaded = { tools: [], servers: [], on: new Map() };
  const noop = () => undefined;
  const pi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "registerTool") return (def: { name: string }) => loaded.tools.push(def.name);
        if (prop === "registerMcpServer") return (name: string) => loaded.servers.push(name);
        if (prop === "on")
          return (event: string) => loaded.on.set(event, (loaded.on.get(event) ?? 0) + 1);
        if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
        if (prop === "events") return { on: noop, emit: noop };
        return noop;
      },
    },
  );
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import("../extensions/loom/index");
  mod.default(pi as never);
  return loaded;
}

const CREDENTIALS = { GALAXY_URL: "https://galaxy.example.org", GALAXY_API_KEY: "fixture-key" };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(ORBIT|LOOM)_(GALAXY_TOOLS|LOCAL_EXEC|LOCAL_SHELL)$/.test(name))
      vi.stubEnv(name, undefined);
  }
  vi.mocked(registerGalaxyVersionCapture).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
});

const GALAXY_TOOLS = [
  ...allOperations.map((op) => op.name),
  "list_jobs",
  "get_job_logs",
  "galaxy_read_output",
];

describe.each([
  // The local uploader needs a file surface.
  ["the desktop", CREDENTIALS, true],
  [
    "the remote container (no local exec surface)",
    { ...CREDENTIALS, LOOM_LOCAL_EXEC: "off" },
    false,
  ],
])("%s", (_name, env, uploader) => {
  it("registers the in-process Galaxy tools and brc-analytics, and no galaxy server", async () => {
    const { servers, tools } = await load(env);
    expect(servers).toEqual(["brc-analytics"]);
    expect(installedCapabilityProfile()).toBeNull();
    for (const name of GALAXY_TOOLS) expect(tools, name).toContain(name);
    expect(tools.includes("galaxy_upload_local_file")).toBe(uploader);
    // brc-analytics is still on pi's MCP layer, so its oversized results keep their recovery.
    expect(tools).toContain("mcp_read_output");
    expect(tools.filter((t) => t.startsWith("mcp__galaxy__"))).toEqual([]);
    expect(galaxyToolFamily().tool("run_tool")).toBe("run_tool");
    expect(registerGalaxyVersionCapture).toHaveBeenCalledTimes(1);
  });
});

describe("the desktop", () => {
  it("ignores a leftover LOOM_GALAXY_TOOLS=mcp", async () => {
    const unset = await load(CREDENTIALS);
    setGalaxyToolSource(null);
    const mcp = await load({ ...CREDENTIALS, LOOM_GALAXY_TOOLS: "mcp" });
    expect(mcp.servers).toEqual(unset.servers);
    expect(mcp.tools).toEqual(unset.tools);
  });
});
