/**
 * What a provider's auth surface looks like, and the one predicate every layer
 * has to agree on: does this provider authenticate ONLY by sign-in?
 *
 * pi models `auth.apiKey` and `auth.oauth` independently. `openai-codex` carries
 * oauth alone; anthropic, xai, openrouter, kimi-coding, github-copilot and radius
 * carry both. Reading "can sign in" as "has no API key" is what broke #429 --
 * Orbit stopped showing, storing, reporting and injecting the Anthropic key the
 * moment pi taught Anthropic to sign in. That rule now lives here once, instead
 * of in the main process, the renderer and the CLI separately.
 */

/**
 * Classify one provider's auth surface from pi's registry entry. Returns null
 * when the provider offers no sign-in at all. Pure, so the predicate #429 got
 * wrong is testable without an Electron or pi runtime.
 */
export function classifyProviderAuth(provider) {
  const oauth = provider && provider.auth && provider.auth.oauth;
  if (!oauth || !oauth.login) return null;
  return {
    // Two distinct things, deliberately not collapsed: pi's loginLabel is a
    // finished button ("Sign in with OpenRouter"), while name is the account
    // behind it ("Anthropic (Claude Pro/Max)"). Folding them into one field
    // renders "Sign in with Sign in with OpenRouter".
    signInLabel: oauth.loginLabel || "",
    providerLabel: oauth.name || "",
    acceptsApiKey: Boolean(provider.auth.apiKey),
  };
}

/**
 * Sign-in is the only way in, so there is no API key to ask for. Gates every
 * "there is no key here" behavior: hiding the key field, masking `hasApiKey`,
 * and skipping key injection into the brain. Dual-auth providers answer false.
 *
 * An unknown provider (no caps) answers false too -- offering a key field for a
 * provider we haven't classified yet is the safe direction.
 */
export function isOAuthOnly(caps) {
  return Boolean(caps && !caps.acceptsApiKey);
}

/**
 * Known-good caps for the provider that ships sign-in enabled, used before the
 * registry read lands (main, renderer) and as the CLI's static answer, which has
 * no registry to read at all. Everything absent from it reads as "takes an API
 * key" -- the safe default, since it offers a key field rather than hiding one.
 */
export const SEED_PROVIDER_AUTH_CAPS = {
  "openai-codex": { signInLabel: "", providerLabel: "", acceptsApiKey: false },
};

/** The seed's sign-in-only ids. Deliberately NOT "everything that can sign in". */
export const SEED_OAUTH_ONLY_PROVIDERS = Object.keys(SEED_PROVIDER_AUTH_CAPS).filter((id) =>
  isOAuthOnly(SEED_PROVIDER_AUTH_CAPS[id]),
);
