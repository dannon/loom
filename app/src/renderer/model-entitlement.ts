// Some openai-codex models in pi's registry aren't served to ChatGPT-account
// sign-ins (which accounts, and why, OpenAI doesn't say). The only signal is
// the refusal itself: pi's registry carries no entitlement data, and probing
// every model would spend the user's plan quota on requests they never asked
// for. So Orbit learns from the refusal -- it explains it in chat, and marks
// the model in the pickers so the user isn't offered it again as if it worked
// (#609).

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

interface TurnMessage {
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

/**
 * What one finished assistant message says about a model's availability. The
 * message's own provider/model win over the renderer's tracked ones, which
 * aren't set on every path (first-run setup, for one).
 */
export function availabilityUpdate(
  msg: TurnMessage,
  fallback: { provider: string | null; model: string | null },
): { action: "mark" | "clear"; provider: string; model: string } | null {
  const provider = msg.provider || fallback.provider;
  const model = msg.model || fallback.model;
  // Only openai-codex is a ChatGPT sign-in; any other endpoint echoing that
  // text says nothing about this account.
  if (provider !== "openai-codex" || !model) return null;
  if (msg.stopReason === "error") {
    const rejected = chatGptPlanRejection(msg.errorMessage);
    // Mark the model we asked for, not whatever id the error text names.
    if (!rejected || (rejected.model && rejected.model !== model)) return null;
    return { action: "mark", provider, model };
  }
  // An aborted turn proves nothing either way.
  if (msg.stopReason === "aborted") return null;
  // A model that answers is available after all (plan change, or an account
  // switch Orbit didn't see), so drop any stale mark.
  return { action: "clear", provider, model };
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
      const out: Record<string, string[]> = Object.create(null);
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
