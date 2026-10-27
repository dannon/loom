// Some openai-codex models are only open to certain ChatGPT plans (or to API
// access), and the only signal is the rejection itself: pi's registry carries
// no entitlement data, and probing every model would spend the user's plan
// quota on requests they never asked for. So Orbit learns from the rejection --
// it explains it in chat, and marks the model in the pickers so the user isn't
// offered it again as if it worked (#609).

const CHATGPT_PLAN_REJECTION = /not supported when using codex with a chatgpt account/i;
const REJECTED_MODEL_ID = /'([^'\s]+)'\s+model\b/i;

/**
 * Whether a turn error is OpenAI refusing the model for a ChatGPT sign-in, and
 * which model it named. The text arrives either bare ("Codex error: The 'x'
 * model is not supported...") or as an HTTP body, so match the whole string.
 */
export function chatGptPlanRejection(raw: string | null | undefined): { model?: string } | null {
  if (!raw || !CHATGPT_PLAN_REJECTION.test(raw)) return null;
  const model = REJECTED_MODEL_ID.exec(raw)?.[1];
  return model ? { model } : {};
}

export function unavailableModelLabel(label: string): string {
  return `${label} — not available on your ChatGPT account`;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "orbit.unavailableModels";

/**
 * Models a provider has refused for this account. Kept in renderer storage
 * because it's a hint, not config: if storage is unavailable the picker just
 * goes unmarked, and the rejection still explains itself in chat.
 */
export class UnavailableModels {
  constructor(private readonly store: KeyValueStore | undefined) {}

  has(provider: string, id: string): boolean {
    return this.read()[provider]?.includes(id) ?? false;
  }

  mark(provider: string, id: string): void {
    const all = this.read();
    const list = all[provider] ?? [];
    if (list.includes(id)) return;
    all[provider] = [...list, id];
    this.write(all);
  }

  /** Forget one model (it worked after all) or a whole provider (new account). */
  clear(provider: string, id?: string): void {
    const all = this.read();
    const list = all[provider];
    if (!list) return;
    const kept = id === undefined ? [] : list.filter((m) => m !== id);
    if (kept.length === list.length) return;
    if (kept.length) all[provider] = kept;
    else delete all[provider];
    this.write(all);
  }

  private read(): Record<string, string[]> {
    try {
      const parsed: unknown = JSON.parse(this.store?.getItem(STORAGE_KEY) ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [provider, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) out[provider] = ids.filter((m) => typeof m === "string");
      }
      return out;
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string[]>): void {
    try {
      this.store?.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* hint only -- see the class comment */
    }
  }
}
