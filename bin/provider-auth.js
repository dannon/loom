/**
 * Deciding whether this process can authenticate a given LLM provider, and
 * which signed-in provider to fall back on when it can't.
 *
 * Split out of bin/loom.js so the decision is testable without spawning the
 * CLI -- #429 was a wrong answer here that silently rewrote user config.
 */

/**
 * Does ~/.pi/agent/auth.json hold a credential pi can use for this provider?
 *
 * Checked for EVERY provider, not just sign-in-only ones: pi reads auth.json
 * natively, so a stored anthropic login is exactly as usable as a codex one.
 * The old code only consulted auth.json for openai-codex, which meant a CLI
 * user signed into Anthropic still got judged unusable and bounced elsewhere.
 */
export function hasStoredCredential(auth, provider) {
  const cred = auth?.[provider];
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return false;
  // Mirrors pi's own idea of a valid credential: OAuthCredential requires
  // access + refresh + expires (a partial entry has nothing to refresh with),
  // and ReadOnlyAuthStorage.load() hard-throws on anything that isn't one of
  // these two shapes. Tolerating a looser shape -- a missing `type`, say --
  // doesn't buy compatibility with older files, it just calls something a login
  // when nothing downstream can authenticate with it.
  if (cred.type === "api_key") {
    const validKey = cred.key === undefined || typeof cred.key === "string";
    const validEnv =
      cred.env === undefined ||
      (typeof cred.env === "object" &&
        cred.env !== null &&
        !Array.isArray(cred.env) &&
        Object.values(cred.env).every((v) => typeof v === "string"));
    return validKey && validEnv;
  }
  return (
    cred.type === "oauth" &&
    typeof cred.access === "string" &&
    typeof cred.refresh === "string" &&
    typeof cred.expires === "number" &&
    Number.isFinite(cred.expires)
  );
}

/**
 * Can this process authenticate `provider`?
 *
 * `oauthOnlyProviders` is the set that authenticates ONLY by sign-in -- for pi
 * 0.84 that is just openai-codex. Providers that offer sign-in *and* accept a
 * key (anthropic, xai, openrouter, ...) are deliberately not in it: they can
 * still be driven by an API key, which is the whole point of #429.
 *
 * `customKeyResolved` is the already-resolved key for an OpenAI-compatible
 * custom provider, or undefined when the entry isn't one.
 */
export function isProviderUsable(provider, entry, auth, opts = {}) {
  const { env = {}, oauthOnlyProviders = new Set(), providerEnvMap = {}, customKeyResolved } = opts;
  if (hasStoredCredential(auth, provider)) return true;
  // Sign-in is the only way in, and there's no stored login -- no key can help.
  if (oauthOnlyProviders.has(provider)) return false;
  if (customKeyResolved !== undefined) return Boolean(customKeyResolved);
  if (entry?.apiKey) return true;
  const envVar = providerEnvMap[provider];
  return Boolean(envVar && env[envVar]);
}

/**
 * Pick a signed-in sign-in-only provider to fall back to. Returns null when
 * nothing is signed in, or when the only candidate is the provider we're
 * already on.
 */
export function pickSignedInFallback(auth, oauthOnlyProviders, current) {
  for (const p of oauthOnlyProviders) {
    if (p !== current && hasStoredCredential(auth, p)) return p;
  }
  return null;
}
