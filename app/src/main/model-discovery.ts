import type { LlmProviderConfig, LoomConfig } from "../../../shared/loom-config.js";

export type DiscoverModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

export interface DiscoverModelsDeps {
  /** Stored config, secrets included -- main-process side only. */
  config: LoomConfig;
  /** Plaintext key for a provider entry, or null when none is stored. */
  resolveKey: (entry: LlmProviderConfig) => string | null;
  /** Ask the endpoint what it serves. Mirrors validateApiKey's custom-endpoint branch. */
  probe: (
    baseUrl: string,
    key: string,
  ) => Promise<{ valid: boolean; error?: string; models?: string[] }>;
}

/**
 * Re-run OpenAI-compatible model discovery for an already-configured provider,
 * using the credential that main already holds.
 *
 * The renderer never sees a stored key (config:get is masked), so it cannot
 * make this call itself -- it only passes the provider *name*, which indexes
 * into config. That keeps the credential out of the renderer, but it does not
 * pin the probe to an endpoint the user chose: a renderer can call config:save
 * to repoint baseUrl while the UNCHANGED_SECRET sentinel preserves the key.
 * See the models:discover handler in main/ipc-handlers.ts for why that hole
 * belongs to config:save rather than here.
 */
export async function discoverProviderModels(
  provider: string,
  deps: DiscoverModelsDeps,
): Promise<DiscoverModelsResult> {
  if (typeof provider !== "string" || !provider.trim()) {
    return { ok: false, error: "No provider given" };
  }
  const entry = deps.config.llm?.providers?.[provider];
  if (!entry) {
    return { ok: false, error: "Save this provider first, then fetch its models." };
  }
  const baseUrl = entry.baseUrl?.trim();
  if (!baseUrl) {
    return { ok: false, error: "This provider has no base URL to query." };
  }
  const key = deps.resolveKey(entry);
  if (!key) {
    // "No key stored" and "a key is stored but unreadable" look identical from
    // here, and they are not the same to the user. The renderer's hadKey comes
    // from maskConfig, which counts any apiKeyEncrypted as a key -- but
    // safeStorage is off in dev and under LOOM_DISABLE_SAFE_STORAGE, and
    // decryption fails outright once the Keychain ACL stops matching the
    // running binary. Telling someone with a saved key that they have none
    // sends them to re-enter a key they already have.
    return {
      ok: false,
      error:
        entry.apiKey || entry.apiKeyEncrypted
          ? "Stored API key could not be read — re-enter it to fetch models."
          : "No stored API key — enter one to fetch models.",
    };
  }
  try {
    const res = await deps.probe(baseUrl, key);
    if (!res.valid) return { ok: false, error: res.error || "Endpoint rejected the stored key" };
    const seen = new Set<string>();
    for (const raw of res.models ?? []) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (id) seen.add(id);
    }
    return { ok: true, models: [...seen] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
