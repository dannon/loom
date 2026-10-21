import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { text, toolCall } from "../../../core/src/agent/fake-model";
import { migrate } from "../db/migrate";
import { acquireLease, releaseLease } from "../lease/leases";
import { bumpLeaseGen } from "../storage/postgres-storage";
import { ensureDatabase } from "../test-db";
import { bundleWorker } from "./bundle";
import type { FromWorker, WorkerData } from "./protocol";
import { spawnWorker } from "./spawn";
import { WITHHELD_TOOLS } from "./guards";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATABASE = "orbit_hosted_worker";
const LEASE_LOST = 75;

let pool: pg.Pool;
let bundle: string;
let server: Server;
let origin: string;

/** Everything that reached the stand-in model and Galaxy, in order. */
const seen: Array<{ to: "model" | "galaxy"; method: string; path: string; lastRole?: string; lastText?: string }> = [];

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

/** The model's script: a user message names what it wants, and a tool result gets a plain answer. */
function modelAnswer(messages: Array<{ role: string; content: unknown }>): Response {
  const last = messages.at(-1)!;
  const said = textOf(last.content);
  const firstUser = textOf(messages.filter((m) => m.role === "user").at(-1)?.content);
  if (last.role === "user" && said.includes("READ_H1")) return toolCall("get_history_details", { history_id: "h1" });
  // Calls a tool again after each result, so the cap is what stops it.
  if (last.role === "tool" && firstUser.includes("KEEP_GOING") && !said.includes("tool calls")) {
    return toolCall("get_history_details", { history_id: "h1" }, `call_${messages.length}`);
  }
  if (last.role === "user" && said.includes("KEEP_GOING")) return toolCall("get_history_details", { history_id: "h1" });
  return text("ok");
}

beforeAll(async () => {
  pool = new pg.Pool({ ...(await ensureDatabase(DATABASE)), max: 4 });
  await migrate(pool);
  bundle = await bundleWorker(join(HERE, "boot.ts"), join(HERE, "..", "..", ".scratch", "worker", "boot.mjs"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = new URL(req.url!, "http://x").pathname;
    let answer: Response;
    if (path.startsWith("/v1/")) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ role: string; content: unknown }> };
      const last = body.messages.at(-1)!;
      seen.push({ to: "model", method: req.method!, path, lastRole: last.role, lastText: textOf(last.content) });
      answer = modelAnswer(body.messages);
    } else {
      seen.push({ to: "galaxy", method: req.method!, path });
      answer =
        path === "/api/histories/h1"
          ? Response.json({ id: "h1", name: "one brain" })
          : path === "/api/histories"
            ? Response.json([{ id: "h1", name: "one brain" }])
            : Response.json({});
    }
    const headers: Record<string, string> = {};
    answer.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(answer.status, headers);
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await pool?.end();
  await new Promise((resolve) => server?.close(resolve));
});

interface Running {
  readonly worker: Worker;
  readonly messages: FromWorker[];
  readonly exited: Promise<number>;
  waitFor<T extends FromWorker["type"]>(type: T, count?: number): Promise<Extract<FromWorker, { type: T }>>;
}

function run(data: WorkerData): Running {
  const worker = spawnWorker(bundle, data);
  const messages: FromWorker[] = [];
  const waiters = new Set<() => void>();
  worker.on("message", (message: FromWorker) => {
    messages.push(message);
    for (const wake of waiters) wake();
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  const failed = new Promise<never>((_, reject) => worker.once("error", reject));
  return {
    worker,
    messages,
    exited,
    waitFor: (type, count = 1) => {
      const found = () => messages.filter((m) => m.type === type)[count - 1] as never;
      return Promise.race([
        failed,
        new Promise((resolve) => {
          const check = () => {
            const hit = found();
            if (hit === undefined) return;
            waiters.delete(check);
            resolve(hit);
          };
          waiters.add(check);
          check();
        }),
      ]) as never;
    },
  };
}

// Who holds each store's lease, so a reopen can hand it on the way a restart would.
const holders = new Map<string, string>();

async function workerData(overrides: Partial<WorkerData> = {}): Promise<WorkerData> {
  const storeId = overrides.storeId ?? `worker-${randomUUID()}`;
  const previous = holders.get(storeId);
  if (previous !== undefined) await releaseLease(pool, storeId, previous);
  const holder = `test-${randomUUID()}`;
  holders.set(storeId, holder);
  const leaseGen = (await acquireLease(pool, storeId, holder, 60_000))!;
  return {
    storeId,
    leaseGen,
    // The worker's environment is empty, so the user has to be in the URL.
    database: `postgres://${userInfo().username}@/${DATABASE}?host=${encodeURIComponent(process.env.PGHOST ?? "/tmp")}`,
    galaxyUrl: origin,
    pageId: "p1",
    model: { baseUrl: `${origin}/v1`, id: "m", apiKey: "model-key-0123456789" },
    limits: { maxTurns: 6, maxToolCalls: 20, outputBytes: 4 * 1024 * 1024 },
    ...overrides,
  };
}

async function stopped(running: Running): Promise<void> {
  running.worker.postMessage({ cmd: "close" });
  await running.waitFor("closed");
  await running.worker.terminate();
}

const galaxyCalls = (path: string) => seen.filter((s) => s.to === "galaxy" && s.path === path).length;
const modelCalls = () => seen.filter((s) => s.to === "model").length;

describe("the worker bootstrap", () => {
  it("offers exactly the pinned server surface, without the user-defined tools", async () => {
    const running = run(await workerData());
    const ready = await running.waitFor("ready");
    const tools = [...ready.tools].sort();
    for (const withheld of WITHHELD_TOOLS) expect(tools).not.toContain(withheld);
    expect(tools).toContain("get_history_details");
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot("../../__surface__/server/tools.json");
    await stopped(running);
  });

  it("boots and runs a Galaxy turn with no filesystem reach and nothing in its environment but the shim", async () => {
    const running = run(await workerData({ traceReaches: true }));
    const ready = await running.waitFor("ready");
    expect(ready.env).toEqual(["ORBIT_ACTIVE_LLM_API_KEY"]);
    // A new conversation is greeted, and that run settles first.
    await running.waitFor("settled");
    const before = galaxyCalls("/api/histories/h1");
    running.worker.postMessage({ cmd: "submit", text: "READ_H1 please" });
    await running.waitFor("settled", 2);
    expect(galaxyCalls("/api/histories/h1")).toBe(before + 1);
    expect(running.messages.filter((m) => m.type === "reach")).toEqual([]);
    expect(running.messages.filter((m) => m.type === "report")).toEqual([]);
    await stopped(running);
  });

  it("reopens a conversation without greeting it again", async () => {
    let first: Running | undefined;
    const { storeId } = await workerData().then((data) => {
      first = run(data);
      return data;
    });
    const { conversationId } = await first!.waitFor("ready");
    await first!.waitFor("settled");
    await stopped(first!);

    const before = modelCalls();
    const second = run(await workerData({ storeId, conversationId }));
    const ready = await second.waitFor("ready");
    expect(ready.conversationId).toBe(conversationId);
    expect([...ready.env].sort()).toEqual(["ORBIT_ACTIVE_LLM_API_KEY", "ORBIT_FRESH_SESSION"]);
    // Give a greeting time to go out if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(modelCalls()).toBe(before);
    await stopped(second);
  });

  it("stops calling tools at the per-run cap, and the model is told why", async () => {
    const running = run(await workerData({ limits: { maxTurns: 6, maxToolCalls: 2, outputBytes: 1 << 20 } }));
    await running.waitFor("ready");
    await running.waitFor("settled");
    const before = galaxyCalls("/api/histories/h1");
    running.worker.postMessage({ cmd: "submit", text: "KEEP_GOING" });
    await running.waitFor("settled", 2);
    expect(galaxyCalls("/api/histories/h1")).toBe(before + 2);
    expect(seen.some((s) => s.to === "model" && s.lastText?.includes("has used its 2 tool calls"))).toBe(true);
    await stopped(running);
  });

  it("exits with 75 on a lost lease, before the model is asked anything", async () => {
    const data = await workerData();
    const running = run(data);
    await running.waitFor("ready");
    await running.waitFor("settled");
    const before = modelCalls();
    await bumpLeaseGen(pool, data.storeId);
    running.worker.postMessage({ cmd: "submit", text: "hello again" });
    expect(await running.exited).toBe(LEASE_LOST);
    expect(modelCalls()).toBe(before);
  });
});
