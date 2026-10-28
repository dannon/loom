import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isKeylessCustomProvider,
  NO_AUTH_API_KEY,
  resolveActiveLlmApiKey,
} from "../shared/custom-provider.js";

describe("isKeylessCustomProvider", () => {
  it("is a custom endpoint with no key stored in any form", () => {
    expect(isKeylessCustomProvider({ baseUrl: "http://127.0.0.1:8080/v1" })).toBe(true);
    expect(isKeylessCustomProvider({ baseUrl: "http://h/v1", apiKey: "" })).toBe(true);
  });

  it("is not keyless when a key is stored, even one this process can't read", () => {
    expect(isKeylessCustomProvider({ baseUrl: "http://h/v1", apiKey: "sk-x" })).toBe(false);
    expect(isKeylessCustomProvider({ baseUrl: "http://h/v1", apiKeyEncrypted: "enc" })).toBe(false);
  });

  it("only applies to custom endpoints", () => {
    expect(isKeylessCustomProvider({ model: "claude" })).toBe(false);
    expect(isKeylessCustomProvider(null)).toBe(false);
  });
});

describe("resolveActiveLlmApiKey for a keyless endpoint", () => {
  it("hands pi a placeholder, so the brain counts the provider as usable", () => {
    expect(resolveActiveLlmApiKey({ baseUrl: "http://127.0.0.1:8080/v1" }, {})).toBe(
      NO_AUTH_API_KEY,
    );
  });

  it("still prefers a real key, and never covers for one it can't read", () => {
    const entry = { baseUrl: "http://h/v1" };
    expect(resolveActiveLlmApiKey(entry, { LOOM_ACTIVE_LLM_API_KEY: "sk-env" })).toBe("sk-env");
    expect(resolveActiveLlmApiKey({ ...entry, apiKeyEncrypted: "enc" }, {})).toBeUndefined();
  });
});

/** A llama-server stand-in: no auth, one streamed reply per chat request. */
async function startKeylessServer(reply: string) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "qwen3",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: reply }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { port, requests, close: () => new Promise((r) => server.close(r)) };
}

function runBrain(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [resolve(__dirname, "../bin/loom.js"), ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

describe("a custom endpoint with no API key (#600)", () => {
  it("starts the brain and gets an answer from the endpoint", async () => {
    const server = await startKeylessServer("Hello from the local model.");
    const home = mkdtempSync(join(tmpdir(), "loom-keyless-"));
    try {
      mkdirSync(join(home, ".loom"), { recursive: true });
      writeFileSync(
        join(home, ".loom", "config.json"),
        JSON.stringify({
          llm: {
            active: "openai-compatible",
            providers: {
              "openai-compatible": {
                baseUrl: `http://127.0.0.1:${server.port}/v1`,
                model: "qwen3",
              },
            },
          },
        }),
      );
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      const res = await runBrain(
        ["-p", "Say hello.", "--no-session"],
        {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: agentDir,
        },
        home,
      );
      expect(res.stderr).not.toMatch(/API key|no credential/i);
      expect(res.stdout).toContain("Hello from the local model.");
      expect(res.status).toBe(0);
      // Deliberately a placeholder -- not the env var's name, which is what
      // pi sends when nothing passes --api-key.
      const chat = server.requests.find((r) => r.url.endsWith("/chat/completions"));
      expect(chat?.auth).toBe(`Bearer ${NO_AUTH_API_KEY}`);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
