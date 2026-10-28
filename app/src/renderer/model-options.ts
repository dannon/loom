/** One entry in the Preferences model dropdown. */
export interface ModelOption {
  id: string;
  label: string;
  selected: boolean;
}

/**
 * Build the model dropdown's options from a list of ids discovered at an
 * OpenAI-compatible endpoint's /models.
 *
 * The saved model is always kept, even when the endpoint no longer lists it:
 * dropping it would leave the <select> defaulting to whichever id came back
 * first, silently reconfiguring the model the user chose.
 */
export function buildDiscoveredModelOptions(
  discovered: readonly string[],
  selected?: string,
): ModelOption[] {
  const wanted = selected?.trim() || "";
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const raw of discovered) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: id, selected: id === wanted });
  }
  if (wanted && !seen.has(wanted)) {
    options.push({ id: wanted, label: `${wanted} (custom)`, selected: true });
  }
  return options;
}

/**
 * Provider-picker entries pi doesn't ship. The picker's list is static HTML,
 * so a provider pi drops (ollama in 1.1.0, #598) stays selectable and
 * crash-loops the brain. `keep` covers entries that never come from pi's
 * registry, like the custom endpoint.
 */
export function unavailableProviders(
  offered: readonly string[],
  available: readonly string[],
  keep: readonly string[],
): string[] {
  const ok = new Set([...available, ...keep]);
  return offered.filter((p) => !ok.has(p));
}

/**
 * The provider to show selected. A saved provider the picker no longer offers
 * would leave the <select> blank, and saving that would write the dead
 * provider straight back -- so show the fallback and let the user choose.
 */
export function pickOfferedProvider(
  saved: string | undefined,
  offered: readonly string[],
  fallback: string,
): string {
  // pi matches provider names case-insensitively, so a hand-edited "OpenAI" is live.
  const match = saved && offered.find((o) => o.toLowerCase() === saved.toLowerCase());
  if (match) return match;
  return offered.includes(fallback) || offered.length === 0 ? fallback : offered[0];
}
