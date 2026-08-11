/**
 * Per-provider credential state for the screens that let you pick an LLM
 * provider (Preferences and the first-run welcome overlay).
 *
 * Both screens show one set of inputs for whichever provider the dropdown has
 * selected, so the fields have to be swapped out when the selection changes.
 * Preferences has always done this; the welcome screen did not, and left the
 * key you typed for provider A sitting in the field under provider B -- which
 * Save then persisted as B's credential (issue #401). These helpers are the
 * DOM-free half of that capture/restore, so the contract can be tested without
 * standing up the renderer.
 */

/** A provider's in-memory field state while the screen is open. */
export interface ProviderState {
  /** A key for this provider is already on disk (masked -- never sent here). */
  hadKey: boolean;
  /** What the user typed into the API key input, verbatim. */
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** The visible inputs, read off the form at capture time. */
export interface ProviderFields {
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** A provider entry as `config:save` expects it (see main/ipc-handlers.ts). */
export interface ProviderConfigEntry {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function emptyProviderState(): ProviderState {
  return { hadKey: false, typedKey: "", model: "", baseUrl: "" };
}

/**
 * The state to restore into the visible fields for `provider`. Unvisited
 * providers get blank fields -- that's what clears the previous provider's key
 * out of the input. Returns a copy so the caller can't write through it.
 */
export function providerStateFor(
  states: Readonly<Record<string, ProviderState>>,
  provider: string,
): ProviderState {
  const state = states[provider];
  return state ? { ...state } : emptyProviderState();
}

/**
 * Snapshot the visible fields into `provider`'s slot, keeping its stored-key
 * flag (which comes from config, not from the form). Returns a new map.
 */
export function captureProviderState(
  states: Readonly<Record<string, ProviderState>>,
  provider: string,
  fields: ProviderFields,
): Record<string, ProviderState> {
  return {
    ...states,
    [provider]: {
      hadKey: states[provider]?.hadKey ?? false,
      typedKey: fields.typedKey,
      model: fields.model,
      baseUrl: fields.baseUrl.trim(),
    },
  };
}

/**
 * Build the `llm.providers` payload for a first-run save: every provider the
 * user actually typed a key for, plus the active one (so `llm.active` always
 * names a provider that's present in the map).
 *
 * Two things it deliberately never emits:
 *   - a plaintext `apiKey` for an OAuth provider -- that credential lives in
 *     ~/.pi/agent/auth.json, and a config.json key would shadow it;
 *   - an empty `apiKey`, which main reads as "clear the stored key". Onboarding
 *     has no business deleting a credential that's already on disk.
 */
export function buildOnboardingProviders(
  states: Readonly<Record<string, ProviderState>>,
  activeProvider: string,
  isOAuthProvider: (provider: string) => boolean,
): Record<string, ProviderConfigEntry> {
  const providers: Record<string, ProviderConfigEntry> = {};
  const names = new Set([...Object.keys(states), activeProvider]);
  for (const name of names) {
    const state = states[name] ?? emptyProviderState();
    const key = isOAuthProvider(name) ? "" : state.typedKey.trim();
    if (!key && name !== activeProvider) continue;
    const entry: ProviderConfigEntry = {};
    if (key) entry.apiKey = key;
    if (state.model) entry.model = state.model;
    if (state.baseUrl) entry.baseUrl = state.baseUrl;
    providers[name] = entry;
  }
  return providers;
}
