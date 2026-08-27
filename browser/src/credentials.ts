/** Provider/model/key selection, held on the client and never sent to Galaxy. */

import PROVIDERS from "./providers.generated.json";

export interface ProviderInfo {
    id: string;
    name: string;
    needs_key: boolean;
    base_url: string | null;
    models: Array<{ id: string; context_window: number | null }>;
    free_model: boolean;
}

export interface Credentials {
    provider: string;
    model?: string;
    apiKey?: string;
}

// sessionStorage, so the key survives a reload but dies with the tab. It is
// never written to the plugin specs, which Galaxy persists server-side.
const STORE_KEY = "olite.credentials";

export const providers: ProviderInfo[] = PROVIDERS as ProviderInfo[];

export function providerById(id: string): ProviderInfo | undefined {
    return providers.find((p) => p.id === id);
}

export function loadCredentials(): Credentials | null {
    try {
        const raw = sessionStorage.getItem(STORE_KEY);
        return raw ? (JSON.parse(raw) as Credentials) : null;
    } catch {
        return null;
    }
}

export function saveCredentials(creds: Credentials): void {
    try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(creds));
    } catch {
        // A blocked store is not fatal: the key still works for this page.
    }
}

export function clearCredentials(): void {
    try {
        sessionStorage.removeItem(STORE_KEY);
    } catch {
        /* nothing to clear */
    }
}

/**
 * Is this selection usable? A provider whose endpoint takes no user key (the
 * Galaxy proxy, a local server) is usable without one; every other provider
 * needs a non-empty key. Returning a reason rather than a bool lets the caller
 * keep the overlay up and say what is missing, instead of starting a brain that
 * fails on its first request.
 */
export function credentialProblem(creds: Credentials | null): string | null {
    if (!creds) return "Choose a provider to continue.";
    const p = providerById(creds.provider);
    if (!p) return `Unknown provider "${creds.provider}".`;
    if (p.needs_key && !creds.apiKey?.trim()) return `${p.name} requires an API key.`;
    if (!p.free_model && p.models.length > 0 && !creds.model?.trim()) {
        return `Choose a model for ${p.name}.`;
    }
    return null;
}
