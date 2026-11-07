import fs from "node:fs";
import path from "node:path";
import { readEnv } from "./orbit-env.js";

/**
 * A provider entry is "custom" (a user-supplied endpoint) when it carries a
 * non-empty baseUrl. That single field is the discriminator everywhere.
 */
export function isCustomProvider(entry) {
  return Boolean(entry && entry.baseUrl);
}

/**
 * Wire formats a custom endpoint can speak. Both are pi APIs that need nothing
 * beyond a base URL and an API key, which is the whole contract a custom
 * provider entry can express -- pi knows others (bedrock, vertex, azure) but
 * those need credentials and deployment identifiers this shape has nowhere to
 * put, so offering them would promise something that cannot work.
 *
 * The two disagree about what a base URL includes, because their SDKs do:
 * the OpenAI client appends `/chat/completions` to whatever it is given, so the
 * version segment belongs in the URL (`https://host/v1`), while the Anthropic
 * client appends `/v1/messages`, so it must not (`https://host`). Getting this
 * backwards is a 404 against a URL that looks right.
 */
export const ENDPOINT_APIS = ["openai-completions", "anthropic-messages"];

/** What an entry with no explicit `api` means -- the only shape Loom used to speak. */
export const DEFAULT_ENDPOINT_API = "openai-completions";

/**
 * Resolve an entry's wire format, rejecting anything we can't actually drive.
 *
 * Throwing beats defaulting here. pi's ModelRegistry drops a provider whose
 * `api` names no registered handler, so a typo would surface as
 * "--provider/--model failed to resolve" with nothing pointing at the cause;
 * and silently falling back to openai-completions would send OpenAI JSON at an
 * Anthropic endpoint, which fails later and less legibly than failing here.
 */
export function normalizeEndpointApi(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_ENDPOINT_API;
  const api = String(value).trim().toLowerCase();
  if (!ENDPOINT_APIS.includes(api)) {
    throw new Error(
      `unsupported endpoint api "${value}" -- expected one of: ${ENDPOINT_APIS.join(", ")}`,
    );
  }
  return api;
}

/**
 * Build a permissive model def from just a model id. Cost is zeroed (custom
 * endpoints are typically free, self-hosted, or billed somewhere Orbit cannot
 * see) and the model is registered for selection; the key is supplied
 * separately at runtime.
 *
 * `entry.contextWindow` is what the server actually holds, when we know it --
 * set by hand, or filled in from the endpoint (see resolveServerContextWindow).
 * It is declared minus a margin; see declaredContextWindow.
 *
 * Without one the window is a guess. 128K mirrors the defaults used for the
 * existing local litellm setup; an Anthropic-shaped endpoint gets 200K because
 * every Claude model in service carries at least that, and under-declaring
 * makes pi compact a conversation that had room left. Both clear the 50K
 * picker floor and the 16K assertion floor, so neither hides the model (#418)
 * or trips the "window too small" message (#419). The guess is wrong for any
 * local server started with a smaller window, and there it wedges the
 * session: pi never compacts, and once the history passes the real window
 * every prompt fails, compaction included (#603).
 */
export function synthesizeModelDef(entry) {
  if (!entry.model) {
    throw new Error("custom provider entry requires a model id to synthesize a model def");
  }
  const api = normalizeEndpointApi(entry.api);
  const serverWindow = positiveInt(entry.contextWindow);
  return {
    id: entry.model,
    name: entry.model,
    reasoning: false,
    input: ["text"],
    contextWindow: serverWindow
      ? declaredContextWindow(serverWindow)
      : api === "anthropic-messages"
        ? 200000
        : 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/**
 * Share of a server's real window that we declare to pi.
 *
 * pi compacts once its count passes the declared window minus its reserve,
 * but between provider usage reports that count is a chars/4 estimate, which
 * runs low against local tokenizers on code and JSON, and the compaction
 * request needs room of its own. Declaring the full window let a 64K
 * llama.cpp server overflow before compaction could fit; about 52K declared
 * compacted cleanly, which is what 80% gives (#603).
 */
export const CONTEXT_WINDOW_DECLARED_SHARE = 0.8;

export function declaredContextWindow(serverWindow) {
  // pi drops a provider whose model declares a zero window.
  return Math.max(1, Math.floor(serverWindow * CONTEXT_WINDOW_DECLARED_SHARE));
}

/**
 * Pull the served context window for `modelId` out of an OpenAI-style
 * `/models` body, or undefined when the server doesn't say.
 *
 * Only fields that mean "the window this server will accept" count:
 *   - llama.cpp's `meta.n_ctx` is the per-slot window it was started with.
 *     Its `meta.n_ctx_train`, and the `context_length` its router mode lists,
 *     are the model's training length, which is exactly the over-declaration
 *     this exists to stop.
 *   - vLLM's `max_model_len` is the engine's configured limit.
 * Ollama and LM Studio list only ids on their OpenAI-compatible `/models`
 * (LM Studio's native API reports the model's maximum, not the loaded
 * window), so they get the fallback, or `contextWindow` on the entry.
 */
export function parseReportedContextWindow(body, modelId) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const card = data.find((m) => m && m.id === modelId) ?? (data.length === 1 ? data[0] : undefined);
  if (!card) return undefined;
  return positiveInt(card.meta?.n_ctx) ?? positiveInt(card.max_model_len);
}

/** Long enough for a LAN box, short enough not to stall a launch on a dead one. */
export const CONTEXT_WINDOW_PROBE_TIMEOUT_MS = 3000;

/**
 * Ask an OpenAI-compatible endpoint how large a window it serves. Best-effort
 * and never throws: any failure means "unknown" and the caller falls back.
 *
 * Anthropic-shaped gateways aren't asked; their model list has no window
 * field we could check against a real server.
 */
export async function probeEndpointContextWindow(
  entry,
  apiKey,
  { fetchImpl = globalThis.fetch, timeoutMs = CONTEXT_WINDOW_PROBE_TIMEOUT_MS } = {},
) {
  try {
    if (!entry?.baseUrl || !entry.model) return undefined;
    if (normalizeEndpointApi(entry.api) !== "openai-completions") return undefined;
    const url = `${String(entry.baseUrl).replace(/\/+$/, "")}/models`;
    const res = await fetchImpl(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      // Never carry the key across a redirect we didn't ask for.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return parseReportedContextWindow(await res.json(), entry.model);
  } catch {
    return undefined;
  }
}

/**
 * The window a custom endpoint serves, and where that came from. A hand-set
 * `contextWindow` wins, since it's how Ollama and LM Studio (which don't
 * report one) get theirs; anything else asks the endpoint. Empty when neither
 * knows, and the entry then gets the default.
 */
export async function resolveServerContextWindow(entry, apiKey, opts) {
  const configured = positiveInt(entry?.contextWindow);
  if (configured) return { contextWindow: configured, source: "config" };
  const reported = await probeEndpointContextWindow(entry, apiKey, opts);
  return reported ? { contextWindow: reported, source: "endpoint" } : {};
}

/**
 * Name of the env var Orbit injects with the decrypted active-LLM key. We write
 * this *name* (not the secret) into the synthesized models.json apiKey field.
 */
export const ACTIVE_LLM_API_KEY_ENV = "LOOM_ACTIVE_LLM_API_KEY";

/**
 * Return a NEW models.json config with the custom provider upserted. Other
 * providers are preserved untouched.
 *
 * The apiKey field is set to the *name* of the env var Orbit injects, never the
 * secret itself. pi's ModelRegistry rejects any custom (non-built-in) provider
 * that defines models without an apiKey and drops the whole provider, so
 * omitting it makes `--provider/--model` fail to resolve and the brain won't
 * launch. The real key never lands on disk: bin/orbit.js hands it to pi with
 * --api-key, which takes precedence. (pi 1.x reads a bare apiKey string as a
 * literal, not an env-var name, so without --api-key this name itself is what
 * gets sent.)
 */
export function mergeCustomProviderIntoModelsConfig(modelsConfig, providerName, entry) {
  const providers = { ...((modelsConfig && modelsConfig.providers) || {}) };
  providers[providerName] = {
    name: providerName,
    baseUrl: entry.baseUrl,
    api: normalizeEndpointApi(entry.api),
    apiKey: ACTIVE_LLM_API_KEY_ENV,
    models: [synthesizeModelDef(entry)],
  };
  return { ...modelsConfig, providers };
}

/**
 * Read models.json (if present), upsert the custom provider, write it back with
 * mode 0600. Best-effort: a malformed existing file is treated as empty rather
 * than throwing, matching how bin/orbit.js already tolerates models.json.
 */
export function syncCustomProviderModelsFile(modelsJsonPath, providerName, entry) {
  let current = {};
  try {
    if (fs.existsSync(modelsJsonPath)) {
      current = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) || {};
    }
  } catch {
    current = {};
  }
  const merged = mergeCustomProviderIntoModelsConfig(current, providerName, entry);
  fs.mkdirSync(path.dirname(modelsJsonPath), { recursive: true });
  // Plain write + chmod (not tmp+rename): this file is regenerated on every
  // launch, so a torn write is self-healing. chmod runs after the write because
  // writeFileSync's mode option only applies when the file is first created.
  fs.writeFileSync(modelsJsonPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(modelsJsonPath, 0o600);
  } catch {
    /* best-effort */
  }
  return merged;
}

/**
 * What a keyless endpoint gets sent as its key. pi refuses to run a request
 * with no key at all, and a server that doesn't check (llama-server, a local
 * vLLM) ignores whatever arrives.
 */
export const NO_AUTH_API_KEY = "no-key";

/**
 * A custom endpoint with no key stored in any form -- the user left the field
 * blank because the server needs none (#600). An encrypted key counts as
 * stored even where it can't be decrypted: that's a key we failed to read, and
 * sending a placeholder in its place would hide the failure.
 */
export function isKeylessCustomProvider(entry) {
  return isCustomProvider(entry) && !entry.apiKey && !entry.apiKeyEncrypted;
}

/**
 * Resolve the API key for a custom provider at runtime. Orbit injects the
 * decrypted key via LOOM_ACTIVE_LLM_API_KEY (or ORBIT_ACTIVE_LLM_API_KEY); the standalone CLI uses the
 * plaintext apiKey on the entry; a keyless endpoint gets NO_AUTH_API_KEY.
 * Returns undefined when none of those applies.
 */
export function resolveActiveLlmApiKey(entry, env) {
  return (
    (env && readEnv("ACTIVE_LLM_API_KEY", env)) ||
    (entry && entry.apiKey) ||
    (isKeylessCustomProvider(entry) ? NO_AUTH_API_KEY : undefined)
  );
}
