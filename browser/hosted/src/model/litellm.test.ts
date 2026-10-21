import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { freshDatabase } from "../test-db";
import { liteLlmModels } from "./litellm";

const KEY = Buffer.alloc(32, 3);

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await freshDatabase("orbit_hosted_litellm")), max: 4 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

async function user(): Promise<string> {
  const sub = `user-${randomUUID()}`;
  await pool.query("INSERT INTO orbit_users (sub) VALUES ($1)", [sub]);
  return sub;
}

function stubLiteLlm(options: { status?: number } = {}) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  let n = 0;
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    // Slow enough that concurrent first uses overlap.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (options.status) return new Response("no", { status: options.status });
    return Response.json({ key: `sk-user-${++n}` });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const settings = (fetch: typeof globalThis.fetch) => ({
  pool,
  tokenKey: KEY,
  url: new URL("https://litellm.test"),
  adminKey: "sk-admin",
  model: "minimax",
  tpm: 50_000,
  rpm: 20,
  fetch,
});

describe("per-user model keys", () => {
  it("creates one rate-limited key per user on first use, and reuses it after", async () => {
    const stub = stubLiteLlm();
    const modelFor = liteLlmModels(settings(stub.fetch));
    const sub = await user();
    const [a, b] = await Promise.all([modelFor(sub), modelFor(sub)]);
    expect(a).toEqual({ baseUrl: "https://litellm.test/v1", id: "minimax", apiKey: "sk-user-1" });
    expect(b).toEqual(a);
    // A fresh process with an empty cache still finds the stored key.
    expect(await liteLlmModels(settings(stub.fetch))(sub)).toEqual(a);
    expect(stub.calls).toEqual([
      {
        url: "https://litellm.test/key/generate",
        auth: "Bearer sk-admin",
        body: {
          user_id: sub,
          key_alias: expect.stringMatching(new RegExp(`^orbit-${sub}-[0-9a-f]{8}$`)),
          models: ["minimax"],
          tpm_limit: 50_000,
          rpm_limit: 20,
          metadata: { service: "orbit" },
        },
      },
    ]);
  });

  it("keeps the key sealed at rest", async () => {
    const stub = stubLiteLlm();
    const sub = await user();
    await liteLlmModels(settings(stub.fetch))(sub);
    const { rows } = await pool.query<{ model_key: Buffer }>("SELECT model_key FROM orbit_users WHERE sub = $1", [sub]);
    expect(rows[0]!.model_key.toString("latin1")).not.toContain("sk-user");
  });

  it("gives each user their own key", async () => {
    const stub = stubLiteLlm();
    const modelFor = liteLlmModels(settings(stub.fetch));
    const keys = await Promise.all([await user(), await user()].map(async (sub) => (await modelFor(sub)).apiKey));
    expect(new Set(keys).size).toBe(2);
  });

  it("makes a new key, under a new alias, when the stored one can't be unsealed", async () => {
    const stub = stubLiteLlm();
    const sub = await user();
    await liteLlmModels(settings(stub.fetch))(sub);
    // The token key rotated: the sealed key is unreadable now.
    const rotated = { ...settings(stub.fetch), tokenKey: Buffer.alloc(32, 4) };
    expect((await liteLlmModels(rotated)(sub)).apiKey).toBe("sk-user-2");
    const aliases = stub.calls.map((c) => c.body.key_alias);
    expect(new Set(aliases).size).toBe(2);
    expect((await liteLlmModels(rotated)(sub)).apiKey).toBe("sk-user-2");
  });

  it("stores nothing when LiteLLM refuses", async () => {
    const sub = await user();
    await expect(liteLlmModels(settings(stubLiteLlm({ status: 500 }).fetch))(sub)).rejects.toThrow(/HTTP 500 no/);
    const { rows } = await pool.query("SELECT model_key FROM orbit_users WHERE sub = $1", [sub]);
    expect(rows[0]).toEqual({ model_key: null });
  });
});
