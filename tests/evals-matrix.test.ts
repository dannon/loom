import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { requiredEnvVars, writePiModelsConfig } from "../evals/lib/matrix";
import type { ModelEntry } from "../evals/lib/types";

const tmpDirs: string[] = [];

function tmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-matrix-"));
  tmpDirs.push(dir);
  return dir;
}

const baseProviderConfig = {
  type: "openai-compatible" as const,
  baseUrl: "PROXY_URL",
  baseUrlIsEnvVar: true,
  apiKeyEnvVar: "PROXY_API_KEY",
  contextWindow: 128000,
  maxTokens: 8192,
};

function taccModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "tacc:qwen3-32b",
    provider: "tacc-sambanova",
    model: "Qwen3-32B",
    providerConfig: baseProviderConfig,
    ...overrides,
  };
}

// Anyone who actually runs the tier-2 matrix has these exported, and vitest
// reuses a worker across files -- clobbering them would unset a real credential
// for every test that runs after this one.
const ENV_KEYS = ["PROXY_URL", "PROXY_API_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();

describe("evals matrix: writePiModelsConfig", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.PROXY_URL = "https://proxy.example/v1";
    process.env.PROXY_API_KEY = "sk-test-key";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = savedEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("marks a reasoning model with reasoning:true and the configured maxTokens", () => {
    const model = taccModel({
      id: "tacc:gpt-oss-120b",
      model: "gpt-oss-120b",
      reasoningModel: true,
    });
    const dir = tmpAgentDir();
    writePiModelsConfig(model, dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    const entry = cfg.providers["tacc-sambanova"].models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.maxTokens).toBe(8192);
  });

  it("defaults non-reasoning models to reasoning:false", () => {
    const model = taccModel({
      id: "tacc:llama-3.3-70b",
      model: "Meta-Llama-3.3-70B-Instruct",
      providerConfig: { ...baseProviderConfig, maxTokens: 4096 },
    });
    const dir = tmpAgentDir();
    writePiModelsConfig(model, dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    expect(cfg.providers["tacc-sambanova"].models[0].reasoning).toBe(false);
  });

  it("writes a $-prefixed env reference so the key never lands on disk", () => {
    // Regression: a BARE env var name is read by pi as the literal credential and
    // sent as the bearer token -- that 401'd every tier-2 run and surfaced as a
    // content assertion failure. The `$` is what makes pi interpolate instead.
    const dir = tmpAgentDir();
    writePiModelsConfig(taccModel(), dir);
    const raw = fs.readFileSync(path.join(dir, "models.json"), "utf-8");
    const cfg = JSON.parse(raw);
    expect(cfg.providers["tacc-sambanova"].apiKey).toBe("$PROXY_API_KEY");
    expect(raw).not.toContain("sk-test-key");
  });
});

describe("evals matrix: requiredEnvVars", () => {
  it("derives the providerConfig env vars so they can't drift from envRequires", () => {
    // envRequires deliberately omits both -- a model whose credentials are named
    // only in providerConfig must still skip, not crash the matrix mid-run.
    const model = taccModel({ envRequires: ["SOMETHING_ELSE"] });
    expect(requiredEnvVars(model)).toEqual(["SOMETHING_ELSE", "PROXY_URL", "PROXY_API_KEY"]);
  });

  it("leaves a literal baseUrl out of the required set", () => {
    const model = taccModel({
      providerConfig: {
        ...baseProviderConfig,
        baseUrl: "https://litellm.example/v1",
        baseUrlIsEnvVar: false,
      },
    });
    expect(requiredEnvVars(model)).toEqual(["PROXY_API_KEY"]);
  });

  it("returns just envRequires for a first-class provider", () => {
    const model: ModelEntry = {
      id: "anthropic:opus",
      provider: "anthropic",
      model: "claude-opus-4-6",
      envRequires: ["ANTHROPIC_API_KEY"],
    };
    expect(requiredEnvVars(model)).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
