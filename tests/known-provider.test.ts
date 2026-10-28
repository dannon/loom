import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isKnownProvider,
  modelsJsonProviders,
  unknownProviderMessage,
  userExtensionsMayRegisterProviders,
} from "../shared/known-provider.js";

describe("isKnownProvider", () => {
  it("matches pi's built-ins case-insensitively", () => {
    expect(isKnownProvider("anthropic", ["anthropic", "openai"])).toBe(true);
    expect(isKnownProvider("OpenAI", ["anthropic", "openai"])).toBe(true);
  });

  it("rejects a provider pi dropped (#598)", () => {
    expect(isKnownProvider("ollama", ["anthropic", "openai"])).toBe(false);
  });

  it("accepts a provider declared only in models.json", () => {
    expect(isKnownProvider("my-litellm", ["anthropic"], ["my-litellm"])).toBe(true);
  });
});

describe("modelsJsonProviders", () => {
  it("reads provider names, and treats a missing or broken file as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-known-provider-"));
    try {
      const path = join(dir, "models.json");
      expect(modelsJsonProviders(path)).toEqual([]);
      writeFileSync(path, "{not json");
      expect(modelsJsonProviders(path)).toEqual([]);
      writeFileSync(path, JSON.stringify({ providers: { a: {}, b: {} } }));
      expect(modelsJsonProviders(path)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("userExtensionsMayRegisterProviders", () => {
  // Any of these can call registerProvider after pi starts, so the brain must
  // not call a name it can't see unknown.
  it("sees extension dirs and settings that load code, global or project", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-ext-providers-"));
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      // Empty dir, settings without code: nothing to load.
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      expect(userExtensionsMayRegisterProviders(agentDir, cwd)).toBe(false);

      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:x"] }));
      expect(userExtensionsMayRegisterProviders(agentDir, cwd)).toBe(true);
      rmSync(join(cwd, ".pi", "settings.json"));

      writeFileSync(join(agentDir, "extensions", ".DS_Store"), "");
      expect(userExtensionsMayRegisterProviders(agentDir, cwd)).toBe(false);
      writeFileSync(join(agentDir, "extensions", "mine.ts"), "export default () => {}");
      expect(userExtensionsMayRegisterProviders(agentDir, cwd)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The real thing: an old config with ollama active must stop with EX_CONFIG,
// not pi's exit 1 that Orbit spends its restart budget on.
describe("brain startup with a provider pi doesn't ship", () => {
  it("exits EX_CONFIG with an explanation", () => {
    const home = mkdtempSync(join(tmpdir(), "loom-unknown-provider-"));
    try {
      mkdirSync(join(home, ".loom"), { recursive: true });
      writeFileSync(
        join(home, ".loom", "config.json"),
        JSON.stringify({
          llm: { active: "ollama", providers: { ollama: { apiKey: "dummy", model: "qwen3:8b" } } },
        }),
      );
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      const res = spawnSync(
        process.execPath,
        [resolve(__dirname, "../bin/loom.js"), "--mode", "rpc", "--no-session"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            USERPROFILE: home,
            PI_CODING_AGENT_DIR: agentDir,
          },
          // A .pi/ in whatever directory runs the tests must not leak in.
          cwd: home,
          input: "",
          encoding: "utf-8",
          timeout: 30_000,
        },
      );
      expect(res.stderr).toContain(unknownProviderMessage("ollama").split("\n")[0]);
      expect(res.status).toBe(78);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});
