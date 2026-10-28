import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// context.ts reads identity facts from loadConfig(); control it so the blocks
// are deterministic regardless of the dev machine's real ~/.loom/config.json.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { setupContextInjection } from "../extensions/loom/context";
import {
  registerGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/loom/galaxy-tool-source";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const stub = (name: string): GalaxyTool => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
});

let agentDir: string;

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({ executionMode: "hybrid", testerId: "orbit-007" });
  vi.stubEnv("GALAXY_URL", "https://galaxy.test");
  vi.stubEnv("GALAXY_API_KEY", "k");
  setCapabilityProfile(profileFromEnv({}));
  setGalaxyToolSource({
    tools: () => [stub("recommend_iwc_workflows"), stub("get_user"), stub("upload_file_from_url")],
  });
  registerGalaxyTools({ registerTool: () => {} } as unknown as ExtensionAPI);
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-context-bare-"));
});

afterEach(() => {
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
  vi.unstubAllEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("the Galaxy prompt over a resumed MCP-era transcript", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
  const mcpEra = [
    {
      type: "message",
      message: {
        role: "user",
        content:
          "Galaxy credentials are configured -- call mcp__galaxy__connect() to establish the connection.",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "mcp__galaxy__run_tool", arguments: {} }],
      },
    },
  ];
  const bareEra = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "run_tool", arguments: {} }],
      },
    },
  ];

  async function promptAfter(entries: unknown[], handlers: Map<string, Handler>) {
    const result = (await handlers.get("before_agent_start")!(
      {},
      {
        cwd: agentDir,
        model: { id: "m" },
        ui: { notify: () => {} },
        sessionManager: { getBranch: () => entries },
      },
    )) as { systemPrompt: string };
    return result.systemPrompt;
  }

  function register() {
    const handlers = new Map<string, Handler>();
    setupContextInjection({ on: (e: string, h: Handler) => handlers.set(e, h) } as never);
    return handlers;
  }

  it("tells the model the old names are gone, there is no connect step and the tools are ready", async () => {
    const prompt = await promptAfter(mcpEra, register());
    expect(prompt).toContain("### Galaxy tool names in earlier turns");
    expect(prompt).toContain("`mcp__galaxy__connect()`");
    expect(prompt).toContain("`run_tool`");
    expect(prompt).toMatch(/no connect step/);
    expect(prompt).toMatch(/ready to use/);
  });

  it("says nothing about it for a transcript that never used the MCP names", async () => {
    const prompt = await promptAfter(bareEra, register());
    expect(prompt).not.toContain("### Galaxy tool names in earlier turns");
    expect(prompt).not.toContain("mcp__galaxy__");
  });

  it("forgets the note when the branch it reads is a clean one", async () => {
    const handlers = register();
    await promptAfter(mcpEra, handlers);
    const prompt = await promptAfter(bareEra, handlers);
    expect(prompt).not.toContain("### Galaxy tool names in earlier turns");
  });

  it("stays quiet when Galaxy is not connected", async () => {
    vi.stubEnv("GALAXY_API_KEY", "");
    const prompt = await promptAfter(mcpEra, register());
    expect(prompt).not.toContain("### Galaxy tool names in earlier turns");
  });
});

describe("shared prompt prose under in-process Galaxy tools", () => {
  // The connected system-prompt snapshot pins the other shared blocks; this one is not in it.
  it("the no-local-shell block does not mention a Galaxy MCP server or its MCP tools", async () => {
    const { noLocalShellBlock } = await import("../shared/prompt-blocks.js");
    expect(noLocalShellBlock()).not.toMatch(/Galaxy MCP|MCP tools/);
  });

  it("the local execution-mode block does not say Galaxy MCP", async () => {
    loadConfigMock.mockReturnValue({ executionMode: "local" });
    const { buildExecutionModeBlock } = await import("../extensions/loom/context");
    const block = buildExecutionModeBlock();
    expect(block).toContain("## Execution mode: LOCAL");
    expect(block).not.toMatch(/Galaxy MCP/);
  });
});
