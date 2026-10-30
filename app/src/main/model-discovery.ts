import type { LlmProviderConfig, OrbitConfig } from "../../../shared/orbit-config.js";

export type DiscoverModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

export interface DiscoverModelsDeps {
  /** Stored config, secrets included -- main-process side only. */
  config: OrbitConfig;
  /** Plaintext key for a provider entry, or null when none is stored. */
  resolveKey: (entry: LlmProviderConfig) => string | null;
  /** Ask the endpoint what it serves. Mirrors validateApiKey's custom-endpoint branch. */
  probe: (
    baseUrl: string,
    key: string,
    api?: string,
  ) => Promise<{ valid: boolean; error?: string; models?: string[] }>;
}

/**
 * Re-run model discovery for an already-configured provider, using the
 * credential that main already holds.
 *
 * The endpoint's wire format comes from the stored entry rather than the
 * caller, for the same reason the key does: the renderer passes only a provider
 * name. That also keeps the probe consistent with what the brain will actually
 * speak to, since both read the same `api` field.
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
  // Nothing stored at all is a keyless endpoint (#600), so probe it keyless. A
  // key that is stored but unreadable is not that: safeStorage is off in dev
  // and under LOOM_DISABLE_SAFE_STORAGE, and decryption fails outright once the
  // Keychain ACL stops matching the running binary. Probing keyless there would
  // report "needs an API key" to someone who already saved one.
  const keyless = !key && !entry.apiKey && !entry.apiKeyEncrypted;
  if (!key && !keyless) {
    return {
      ok: false,
      error: "Stored API key could not be read — re-enter it to fetch models.",
    };
  }
  try {
    const res = await deps.probe(baseUrl, key ?? "", entry.api);
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
