/**
 * Model access (brief H9): every worker calls LiteLLM on Orbit's one service key, which reaches the
 * worker in its workerData and nowhere else. Users never see a key; each request names its user in
 * the OpenAI `user` field, so LiteLLM's spend log, keyed by user, is still the usage ledger. Limits on
 * the service key itself (tpm, rpm, budget) are set in LiteLLM when the key is made.
 */
import type { WorkerData } from "../worker/protocol";

export interface LiteLlmOptions {
  /** LiteLLM's base URL; workers call `${url}/v1`. */
  readonly url: URL;
  readonly key: string;
  readonly model: string;
}

/** A user's model settings: the service's key and model, tagged with the user. */
export function liteLlmModels(options: LiteLlmOptions): (sub: string) => WorkerData["model"] {
  const root = options.url.href.endsWith("/") ? options.url.href : `${options.url.href}/`;
  const baseUrl = new URL("v1", root).href;
  return (sub) => ({ baseUrl, id: options.model, apiKey: options.key, user: sub });
}
