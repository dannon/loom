import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ToolResultEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { inspectOutput, registerMcpOutputRecovery } from "../extensions/loom/mcp-output";
import { registerSecretRedaction } from "../extensions/loom/secret-redaction";
import { guardMcpOutput } from "../node_modules/pi-mcp-adapter/mcp-output-guard";

vi.mock("../shared/loom-config.js", () => ({ loadConfig: () => ({}) }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function artifact(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-output-"));
  dirs.push(dir);
  const path = join(dir, "output-abcd.txt");
  writeFileSync(path, text);
  return path;
}
function harness() {
  const on = vi.fn();
  const registerTool = vi.fn();
  const pi = { on, registerTool } as unknown as ExtensionAPI;
  registerMcpOutputRecovery(pi);
  registerSecretRedaction(pi);
  const execute = registerTool.mock.calls[0][0].execute;
  return {
    async result(event: Partial<ToolResultEvent>) {
      let result = event;
      for (const [name, handler] of on.mock.calls)
        if (name === "tool_result") result = { ...result, ...(await handler(result)) };
      return result;
    },
    read: async (args: unknown) => {
      try {
        return await execute("reader-call", args);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error) }] };
      }
    },
    restore: (entries: unknown[]) =>
      on.mock.calls.find(([name]) => name === "session_start")![1]({}, {
        sessionManager: { getBranch: () => entries },
      } as unknown as ExtensionContext),
  };
}
function event(path: string, overrides = {}): Partial<ToolResultEvent> {
  return {
    toolName: "galaxy_get_tool_panel",
    toolCallId: "catalog",
    input: {},
    isError: false,
    content: [{ type: "text", text: "[MCP text output truncated]" }],
    details: { outputGuard: { truncated: true, fullOutputPath: path } },
    ...overrides,
  };
}

describe("bounded MCP output recovery", () => {
  it("recovers a multi-megabyte one-line adapter result and finds a late nested tool", async () => {
    const raw = JSON.stringify({
      success: true,
      data: Array.from({ length: 87 }, (_, section) => ({
        name: `Section ${section}`,
        elems: Array.from({ length: 80 }, (_, i) => ({
          id: `tool-${section}-${i}`,
          name: section === 86 && i === 79 ? "TISSUE" : "Other tool",
          description: "x".repeat(400),
        })),
      })),
    });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2_300_000);
    const guarded = await guardMcpOutput([{ type: "text", text: raw }]);
    const path = guarded.outputGuard!.fullOutputPath!;
    dirs.push(join(path, ".."));
    expect(guarded.outputGuard?.outputLines).toBe(0);
    const h = harness();
    const recovered = await h.result(
      event(path, { content: guarded.content, details: { outputGuard: guarded.outputGuard } }),
    );
    const text = JSON.stringify(recovered.content);
    expect(text).toContain("mcp_read_output");
    expect(text).toContain("/data");
    expect(text).toContain("87");
    expect(Buffer.byteLength(text)).toBeLessThan(16_384);
    const result = await h.read({ outputId: "catalog", query: "TISSUE" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      items: [
        { pointer: "/data/86/elems/79", preview: { fields: { id: "tool-86-79", name: "TISSUE" } } },
      ],
      nextOffset: null,
    });
    const exact = await h.read({ outputId: "catalog", pointer: "/data/86/elems/79/id" });
    expect(JSON.parse(exact.content[0].text).text).toBe("tool-86-79");
  });

  it("paginates JSON and long single-line text without losing the next offset", () => {
    const text = JSON.stringify({ data: Array.from({ length: 31 }, (_, id) => ({ id })) });
    const first = inspectOutput(text, { outputId: "x", pointer: "/data", limit: 20 });
    expect(first).toMatchObject({ totalItems: 31, nextOffset: 20 });
    expect(inspectOutput(text, { outputId: "x", pointer: "/data", offset: 20 })).toMatchObject({
      nextOffset: 30,
    });
    const last = inspectOutput(text, { outputId: "x", pointer: "/data", offset: 30 });
    expect(last).toMatchObject({
      items: [{ pointer: "/data/30", preview: { fields: { id: 30 } } }],
      nextOffset: null,
    });
    expect(inspectOutput("z".repeat(100_000), { outputId: "x", offset: 90_000 })).toMatchObject({
      nextOffset: 92_000,
      text: "z".repeat(2000),
    });
  });

  it("bounds escaped Unicode previews by bytes and reports omissions", () => {
    const text = JSON.stringify(
      Array.from({ length: 50 }, () =>
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, "🧬".repeat(3000)])),
      ),
    );
    const page = inspectOutput(text, { outputId: "x", limit: 20 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(14_000);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(JSON.stringify(page)).toContain('"omitted":true');
  });

  it("handles escaped JSON Pointer keys and refuses missing fields", () => {
    const text = JSON.stringify({ "a/b~c": "exact" });
    expect(inspectOutput(text, { outputId: "x", pointer: "/a~1b~0c" }).text).toBe("exact");
    expect(() => inspectOutput(text, { outputId: "x", pointer: "/missing" })).toThrow(
      "does not exist",
    );
  });

  it("preserves images, errors, and secret redaction when recovering content", async () => {
    const key = "test-secret-never-send-12345";
    vi.stubEnv("GALAXY_API_KEY", key);
    const h = harness();
    const path = artifact(JSON.stringify({ message: key }));
    const image = { type: "image", data: "abcd", mimeType: "image/png" };
    const recovered = await h.result(
      event(path, { isError: true, content: [{ type: "text", text: "truncated" }, image] }),
    );
    expect(recovered.isError).toBe(true);
    expect(recovered.content?.[0]).toEqual(image);
    expect(JSON.stringify(recovered.content)).not.toContain(key);
    expect(JSON.stringify(recovered.content)).toContain("[redacted]");
    // Native reader results traverse the same output-redaction hook.
    const result = await h.result({
      ...(await h.read({ outputId: "catalog" })),
      toolName: "mcp_read_output",
      toolCallId: "read",
      input: {},
      isError: false,
    });
    expect(JSON.stringify(result.content)).not.toContain(key);
  });

  it("restores artifact IDs from this branch and clears them on a new session", async () => {
    const h = harness();
    const saved = event(artifact('{"data":[1,2]}'));
    h.restore([{ type: "message", message: { role: "toolResult", ...saved } }]);
    expect((await h.read({ outputId: "catalog" })).isError).not.toBe(true);
    expect(
      (
        await h.read({
          outputId: (saved.details as { outputGuard: { fullOutputPath: string } }).outputGuard
            .fullOutputPath,
        })
      ).isError,
    ).not.toBe(true);
    h.restore([]);
    expect((await h.read({ outputId: "catalog" })).isError).toBe(true);
  });

  it("rejects arbitrary paths, symlinks, and expired output without claiming success", async () => {
    const h = harness();
    expect((await h.read({ outputId: "/etc/passwd" })).isError).toBe(true);
    const good = artifact("private text");
    const link = artifact("placeholder");
    rmSync(link);
    symlinkSync(good, link);
    for (const path of ["/etc/passwd", link, good + "missing"]) {
      await h.result(event(path));
      const result = await h.read({ outputId: "catalog" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private text");
      expect(result.content[0].text).toContain("Do not infer missing results");
    }
  });

  it("does not parse file paths out of untrusted result text", async () => {
    const h = harness();
    const original = event("unused", {
      details: {},
      content: [{ type: "text", text: "Full text saved to: /etc/passwd" }],
    });
    expect(await h.result(original)).toEqual(original);
    expect((await h.read({ outputId: "catalog" })).isError).toBe(true);
  });
});
