/**
 * Model access (brief H9): each user gets their own LiteLLM virtual key, created the first time a
 * worker boots for them through LiteLLM's admin API and limited by tokens and requests per minute
 * (max_budget is in dollars and never trips on a free model). The key is sealed at rest, reaches the
 * worker in its workerData and nowhere else, and LiteLLM's spend log, keyed by user, is the usage
 * ledger.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { seal, unseal } from "../auth/seal";
import { withTransaction } from "../storage/postgres-storage";
import type { WorkerData } from "../worker/protocol";

const PURPOSE = "orbit model key";

export interface LiteLlmOptions {
  readonly pool: Pool;
  readonly tokenKey: Buffer;
  /** LiteLLM's base URL; workers call `${url}/v1`. */
  readonly url: URL;
  /** The master or admin key, used only here, to create virtual keys. */
  readonly adminKey: string;
  readonly model: string;
  readonly tpm: number;
  readonly rpm: number;
  readonly fetch?: typeof fetch;
}

/** A user's model settings, creating their key on first use. */
export function liteLlmModels(options: LiteLlmOptions): (sub: string) => Promise<WorkerData["model"]> {
  const fetchImpl = options.fetch ?? fetch;
  const root = options.url.href.endsWith("/") ? options.url.href : `${options.url.href}/`;
  const baseUrl = new URL("v1", root).href;
  // One key request per user at a time in this process; the row lock below covers other hosts.
  const inFlight = new Map<string, Promise<string>>();

  const generate = async (sub: string): Promise<string> => {
    const response = await fetchImpl(new URL("key/generate", root), {
      method: "POST",
      headers: { authorization: `Bearer ${options.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: sub,
        // Unique per key: LiteLLM refuses a repeated alias, and a key it made that we never stored
        // (a lost response, a failed commit, a rotated ORBIT_TOKEN_KEY) would block the user for good.
        key_alias: `orbit-${sub}-${randomUUID().slice(0, 8)}`,
        models: [options.model],
        tpm_limit: options.tpm,
        rpm_limit: options.rpm,
        metadata: { service: "orbit" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const said = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`LiteLLM refused to create a model key: HTTP ${response.status} ${said}`);
    }
    const body = (await response.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) throw new Error("LiteLLM created a key but didn't return it");
    return body.key;
  };

  const keyFor = (sub: string) =>
    withTransaction(options.pool, async (client) => {
      const { rows } = await client.query<{ model_key: Buffer | null }>(
        "SELECT model_key FROM orbit_users WHERE sub = $1 FOR UPDATE",
        [sub],
      );
      if (rows.length === 0) throw new Error(`No user ${sub}`);
      const sealed = rows[0]!.model_key;
      // A key that won't unseal (ORBIT_TOKEN_KEY rotated) is replaced; the old one stays at LiteLLM,
      // where its user_id still ties it to the user.
      const held = sealed ? unseal(options.tokenKey, sealed, PURPOSE) : undefined;
      if (held) return held;
      const key = await generate(sub);
      await client.query("UPDATE orbit_users SET model_key = $2 WHERE sub = $1", [sub, seal(options.tokenKey, key, PURPOSE)]);
      return key;
    });

  return async (sub) => {
    let key = inFlight.get(sub);
    if (!key) {
      key = keyFor(sub).finally(() => inFlight.delete(sub));
      inFlight.set(sub, key);
    }
    return { baseUrl, id: options.model, apiKey: await key };
  };
}
