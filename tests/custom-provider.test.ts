import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ACTIVE_LLM_API_KEY_ENV,
  DEFAULT_ENDPOINT_API,
  ENDPOINT_APIS,
  normalizeEndpointApi,
  isCustomProvider,
  synthesizeModelDef,
  mergeCustomProviderIntoModelsConfig,
  syncCustomProviderModelsFile,
  resolveActiveLlmApiKey,
} from "../shared/custom-provider.js";

describe("isCustomProvider", () => {
  it("is true only when baseUrl is set", () => {
    expect(isCustomProvider({ baseUrl: "https://x/api" })).toBe(true);
    expect(isCustomProvider({ apiKey: "k" })).toBe(false);
    expect(isCustomProvider(undefined)).toBe(false);
    expect(isCustomProvider({ baseUrl: "" })).toBe(false);
  });
});

describe("synthesizeModelDef", () => {
  it("builds an openai-completions model def from the model id with zero cost", () => {
    const def = synthesizeModelDef({ baseUrl: "https://x/api", model: "gpt-oss-120b" });
    expect(def.id).toBe("gpt-oss-120b");
    expect(def.name).toBe("gpt-oss-120b");
    expect(def.input).toEqual(["text"]);
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBeGreaterThan(0);
    expect(def.maxTokens).toBeGreaterThan(0);
  });

  it("throws when the entry has no model id", () => {
    expect(() => synthesizeModelDef({ baseUrl: "https://x/api" })).toThrow(/model id/);
  });
});

describe("mergeCustomProviderIntoModelsConfig", () => {
  it("adds a keyless openai-completions provider entry and preserves others", () => {
    const existing = {
      providers: {
        litellm: {
          baseUrl: "http://localhost:4000/v1",
          api: "openai-completions",
          apiKey: "x",
          models: [{ id: "a" }],
        },
      },
    };
    const merged = mergeCustomProviderIntoModelsConfig(existing, "openai-compatible", {
      baseUrl: "https://llm.jetstream-cloud.org/api",
      model: "gpt-oss-120b",
    });
    // other providers preserved untouched
    expect(merged.providers.litellm).toEqual(existing.providers.litellm);
    // new provider carries the env-var NAME as apiKey (so pi accepts it), never
    // a secret -- the real key is resolved from the env var at request time.
    const p = merged.providers["openai-compatible"];
    expect(p.apiKey).toBe(ACTIVE_LLM_API_KEY_ENV);
    expect(p.baseUrl).toBe("https://llm.jetstream-cloud.org/api");
    expect(p.api).toBe("openai-completions");
    expect(p.models[0].id).toBe("gpt-oss-120b");
  });

  it("does not mutate the input config", () => {
    const existing = { providers: { litellm: { baseUrl: "x", models: [] } } };
    const snapshot = JSON.stringify(existing);
    mergeCustomProviderIntoModelsConfig(existing, "openai-compatible", {
      baseUrl: "y",
      model: "m",
    });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe("syncCustomProviderModelsFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cp-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates models.json with mode 0600 when absent", () => {
    const file = path.join(dir, "models.json");
    syncCustomProviderModelsFile(file, "openai-compatible", {
      baseUrl: "https://x/api",
      model: "m",
    });
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(parsed.providers["openai-compatible"].baseUrl).toBe("https://x/api");
    expect(parsed.providers["openai-compatible"].apiKey).toBe(ACTIVE_LLM_API_KEY_ENV);
    // 0600 on POSIX
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves an existing hand-managed provider", () => {
    const file = path.join(dir, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: {
          litellm: { baseUrl: "http://localhost:4000/v1", apiKey: "x", models: [{ id: "a" }] },
        },
      }),
    );
    syncCustomProviderModelsFile(file, "openai-compatible", {
      baseUrl: "https://x/api",
      model: "m",
    });
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(parsed.providers.litellm.apiKey).toBe("x");
    expect(parsed.providers["openai-compatible"].baseUrl).toBe("https://x/api");
  });
});

/** Minimal pi CredentialStore that holds nothing -- enough for ModelRegistry.create. */
function emptyCredentialStore() {
  return {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  };
}

describe("synthesized models.json loads through pi's ModelRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cp-reg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Regression for the keyless entry: pi's ModelRegistry rejects a custom
  // provider that defines models without an apiKey and drops it, so the brain
  // couldn't resolve --provider/--model and never launched. The synthesized
  // entry must register cleanly while keeping the real key off disk.
  it("registers the custom model without writing the secret to disk", async () => {
    const file = path.join(dir, "models.json");
    syncCustomProviderModelsFile(file, "openai-compatible", {
      baseUrl: "https://llm.jetstream-cloud.org/api",
      model: "gpt-oss-120b",
      apiKey: "super-secret-should-never-be-written",
    });

    // the real key never lands on disk
    expect(fs.readFileSync(file, "utf-8")).not.toContain("super-secret");

    // pi accepts the config (no load error) and the model resolves.
    // pi 0.83 dropped AuthStorage from the package root and moved registry
    // construction behind ModelRuntime.create(), so stand up a throwaway
    // CredentialStore -- the store is incidental scaffolding here, and a local
    // stub keeps this test off pi's private module paths.
    const runtime = await ModelRuntime.create({
      modelsPath: file,
      credentials: emptyCredentialStore(),
    });
    const reg = new ModelRegistry(runtime);
    expect(reg.getError()).toBeUndefined();
    expect(reg.find("openai-compatible", "gpt-oss-120b")).toBeDefined();
  });
});

describe("resolveActiveLlmApiKey", () => {
  it("prefers the injected env var, then plaintext config", () => {
    expect(resolveActiveLlmApiKey({ apiKey: "cfg" }, { LOOM_ACTIVE_LLM_API_KEY: "env" })).toBe(
      "env",
    );
    expect(resolveActiveLlmApiKey({ apiKey: "cfg" }, {})).toBe("cfg");
    expect(resolveActiveLlmApiKey({}, {})).toBeUndefined();
  });
});

describe("normalizeEndpointApi", () => {
  it("treats absent, null and empty as the default shape", () => {
    expect(normalizeEndpointApi(undefined)).toBe(DEFAULT_ENDPOINT_API);
    expect(normalizeEndpointApi(null)).toBe(DEFAULT_ENDPOINT_API);
    expect(normalizeEndpointApi("")).toBe(DEFAULT_ENDPOINT_API);
    // The default has to stay openai-completions: every entry written before
    // this field existed carries no api and must keep working unchanged.
    expect(DEFAULT_ENDPOINT_API).toBe("openai-completions");
  });

  it("accepts every advertised shape, case- and whitespace-insensitively", () => {
    for (const api of ENDPOINT_APIS) {
      expect(normalizeEndpointApi(api)).toBe(api);
      expect(normalizeEndpointApi(`  ${api.toUpperCase()}  `)).toBe(api);
    }
    expect(ENDPOINT_APIS).toContain("anthropic-messages");
  });

  it("rejects anything else, and names the valid values", () => {
    // Silently defaulting would send OpenAI JSON at an Anthropic endpoint;
    // passing it through would have pi drop the provider with no explanation.
    expect(() => normalizeEndpointApi("anthropic")).toThrow(/unsupported endpoint api "anthropic"/);
    expect(() => normalizeEndpointApi("bedrock-converse-stream")).toThrow(
      /openai-completions, anthropic-messages/,
    );
  });
});

describe("wire format reaches the synthesized provider entry", () => {
  it("defaults to openai-completions when the entry says nothing", () => {
    const merged = mergeCustomProviderIntoModelsConfig({}, "openai-compatible", {
      baseUrl: "https://llm.jetstream-cloud.org/api",
      model: "gpt-oss-120b",
    });
    expect(merged.providers?.["openai-compatible"]?.api).toBe("openai-completions");
  });

  it("carries anthropic-messages through to models.json", () => {
    const merged = mergeCustomProviderIntoModelsConfig({}, "argo", {
      baseUrl: "https://gateway.example/argoapi",
      model: "claudeopus5",
      api: "anthropic-messages",
    });
    expect(merged.providers?.argo).toMatchObject({
      baseUrl: "https://gateway.example/argoapi",
      api: "anthropic-messages",
      apiKey: ACTIVE_LLM_API_KEY_ENV,
    });
  });

  it("throws rather than writing a provider pi would drop", () => {
    expect(() =>
      mergeCustomProviderIntoModelsConfig({}, "argo", {
        baseUrl: "https://gateway.example",
        model: "claudeopus5",
        api: "anthropic",
      }),
    ).toThrow(/unsupported endpoint api/);
  });

  it("declares a context window that clears both model-picker floors", () => {
    const openai = synthesizeModelDef({ baseUrl: "https://x/v1", model: "gpt-oss-120b" });
    const anthropic = synthesizeModelDef({
      baseUrl: "https://x",
      model: "claudeopus5",
      api: "anthropic-messages",
    });
    expect(openai.contextWindow).toBe(128000);
    // Under-declaring makes pi compact a conversation that had room left.
    expect(anthropic.contextWindow).toBe(200000);
    // 50K hides the model from the picker (#418), 16K trips "window too small"
    // (#419). Neither shape may fall under either.
    for (const def of [openai, anthropic]) expect(def.contextWindow).toBeGreaterThan(50000);
  });
});

describe("an anthropic-messages endpoint loads through pi's ModelRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cp-anthropic-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The whole point of the `api` field: pi has to accept the provider and hand
  // back a model bound to the Anthropic wire format at the URL we gave it. If
  // pi ever stopped registering this shape from models.json, an Argo-style
  // gateway would fail at the first request with nothing pointing here.
  it("registers the model against the gateway URL, not api.anthropic.com", async () => {
    const file = path.join(dir, "models.json");
    syncCustomProviderModelsFile(file, "argo", {
      baseUrl: "https://gateway.example/argoapi",
      model: "claudeopus5",
      api: "anthropic-messages",
      apiKey: "ac.super-secret-should-never-be-written",
    });

    expect(fs.readFileSync(file, "utf-8")).not.toContain("super-secret");

    const runtime = await ModelRuntime.create({
      modelsPath: file,
      credentials: emptyCredentialStore(),
    });
    const reg = new ModelRegistry(runtime);
    expect(reg.getError()).toBeUndefined();
    const model = reg.find("argo", "claudeopus5");
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://gateway.example/argoapi",
    });
  });
});
