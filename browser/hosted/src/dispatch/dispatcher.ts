/**
 * Dispatch and leases (brief H7). A message lands in the conversation's inbox and a `turn` job is sent
 * for it; pg-boss's `stately` policy keeps at most one turn queued behind one running per
 * conversation, and the queued one drains the whole inbox, so messages that arrive while it waits
 * are coalesced into it.
 *
 * The handler claims the user's live loop and the conversation's lease in one transaction without
 * waiting on either (decision 6): if another of the user's conversations is live, or another host
 * holds the lease, it sends the turn again a little later and returns. Otherwise it hands the turn to
 * the conversation's sticky worker, booting one if there is none, and waits for the run to settle.
 * The lease is held for the worker's life and renewed on a timer; the generation moves only when a
 * new worker takes over (decision 9).
 */
import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import type { AskAnswer, AskRequest } from "../../../core/src/agent/pi-host";
import { acquireLeaseInTransaction, releaseLease, renewLease } from "../lease/leases";
import { LEASE_LOST_EXIT_CODE } from "../lease/lease-fence";
import { withTransaction } from "../storage/postgres-storage";
import { answerTokenRequest } from "../tokens/serve";
import type { TokenCache } from "../tokens/token-cache";
import type { FromWorker, WorkerData } from "../worker/protocol";
import { spawnWorker } from "../worker/spawn";
import { getConversation, interruptedConversations, type ConversationRow } from "./conversations";

export const TURN_QUEUE = "turn";

/** What the dispatcher tells the conversation's browser, besides what its worker says. */
export type DispatchEvent =
  /** The turn waits: another of the user's conversations is running or asking them something. */
  | { readonly type: "waiting" }
  | { readonly type: "worker-exit"; readonly code: number };

export interface DispatcherOptions {
  readonly pool: Pool;
  readonly boss: PgBoss;
  /** The bundled worker (worker/bundle.ts). */
  readonly bundle: string;
  /** This host process; leases and live loops name it, so a restarted host is a new holder. */
  readonly hostId: string;
  /** Handed to workers. */
  readonly databaseUrl: string;
  readonly galaxyUrl: string;
  readonly lease: { readonly ttlMs: number; readonly renewMs: number; readonly maxTurnMs: number };
  readonly limits: WorkerData["limits"];
  /** Handed to workers for V8's compile cache. */
  readonly compileCache?: string;
  readonly tokens: TokenCache;
  /** The model a user's worker talks to, with their key (H9). */
  readonly modelFor: (sub: string) => Promise<WorkerData["model"]>;
  /** The conversation's Galaxy page, created on first use. */
  readonly pageFor: (conversation: ConversationRow) => Promise<string>;
  readonly onEvent: (conversationId: string, event: FromWorker | DispatchEvent) => void;
  /** Turns run at once in this host. Each holds a worker, not a database connection. */
  readonly concurrency?: number;
  /** How long a turn that found the user's loop busy waits before trying again. */
  readonly retryAfterMs?: () => number;
  readonly spawn?: (bundle: string, data: WorkerData) => Worker;
  readonly log?: (message: string) => void;
}

interface Waiter {
  readonly type: FromWorker["type"];
  readonly resolve: (message: FromWorker) => void;
  readonly reject: (error: Error) => void;
}

interface Live {
  readonly conversationId: string;
  readonly sub: string;
  readonly storeId: string;
  readonly holder: string;
  readonly leaseGen: number;
  readonly worker: Worker;
  /** Asks waiting on the user, so a page that (re)connects can show them. */
  readonly asks: Map<number, AskRequest>;
  readonly waiters: Set<Waiter>;
  renew?: NodeJS.Timeout;
  /** A turn is between submit and settled. */
  inTurn: boolean;
  exited: boolean;
}

class Busy extends Error {}

export class Dispatcher {
  readonly #o: DispatcherOptions;
  readonly #live = new Map<string, Live>();
  #working = false;
  #stopping = false;

  constructor(options: DispatcherOptions) {
    this.#o = options;
  }

  /** Create the queue if needed, start taking turns, and pick up conversations a restart cut off. */
  async start(): Promise<void> {
    const { boss } = this.#o;
    if (!(await boss.getQueue(TURN_QUEUE))) {
      await boss.createQueue(TURN_QUEUE, {
        policy: "stately",
        // A turn runs up to the cap, plus a boot.
        expireInSeconds: Math.ceil(this.#o.lease.maxTurnMs / 1000) + 300,
        retryLimit: 0,
      });
    }
    await boss.work(
      TURN_QUEUE,
      { localConcurrency: this.#o.concurrency ?? 32, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        await this.#runTurn((job!.data as { conversationId: string }).conversationId);
      },
    );
    this.#working = true;
    // The sweeper: a turn cut off by a crash or a restart resumes without waiting for a new message.
    for (const id of await interruptedConversations(this.#o.pool)) await this.#send(id);
  }

  /** Queue a message for the conversation's next turn. */
  async submit(conversationId: string, text: string): Promise<void> {
    await this.#o.pool.query(
      "WITH c AS (UPDATE orbit_conversations SET last_active_at = now() WHERE id = $1) INSERT INTO orbit_inbox (conversation_id, text) VALUES ($1, $2)",
      [conversationId, text],
    );
    await this.#send(conversationId);
  }

  /** The user's Stop: the run aborts, and a pending confirm is withdrawn with its call not run. */
  stop(conversationId: string): void {
    this.#live.get(conversationId)?.worker.postMessage({ cmd: "stop" });
  }

  /** The user's answer to an ask; ignored for an ask the worker already withdrew. */
  answer(conversationId: string, id: number, value: AskAnswer): void {
    const live = this.#live.get(conversationId);
    if (!live?.asks.delete(id)) return;
    live.worker.postMessage({ cmd: "answer", id, value });
  }

  /** Whether the conversation has a worker on this host now. */
  isLive(conversationId: string): boolean {
    return this.#live.has(conversationId);
  }

  /** Ask the conversation's worker for a fresh snapshot; false when no worker is running it. */
  snapshot(conversationId: string): boolean {
    const live = this.#live.get(conversationId);
    if (!live) return false;
    live.worker.postMessage({ cmd: "snapshot" });
    return true;
  }

  /** What the conversation is waiting on the user for. */
  pendingAsks(conversationId: string): Array<{ id: number; request: AskRequest }> {
    return [...(this.#live.get(conversationId)?.asks ?? [])].map(([id, request]) => ({ id, request }));
  }

  /**
   * Restart: stop taking turns, then close every worker. Closing withdraws a pending confirm by
   * rejecting it in the worker, so it's asked again when the conversation resumes; a turn cut off
   * here marks its conversation for the sweeper.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    // Workers close first, so each turn's handler finishes and pg-boss records its job; a job left
    // active would hold the conversation's one active slot until it expired, and the next host
    // couldn't resume it. Turns that start meanwhile are turned away (see #runTurn).
    this.#stopping = true;
    await Promise.all(
      [...this.#live.values()].map(async (live) => {
        const closed = this.#next(live, "closed").catch(() => undefined);
        live.worker.postMessage({ cmd: "close" });
        const timer = setTimeout(() => void live.worker.terminate(), timeoutMs);
        await Promise.race([closed, new Promise((resolve) => live.worker.once("exit", resolve))]);
        clearTimeout(timer);
        await live.worker.terminate();
      }),
    );
    if (this.#working) await this.#o.boss.offWork(TURN_QUEUE, { wait: true });
    this.#working = false;
  }

  #send(conversationId: string, startAfterMs?: number): Promise<string | null> {
    // null when a turn is already queued for the conversation: it will drain this message too.
    return this.#o.boss.send(
      TURN_QUEUE,
      { conversationId },
      { singletonKey: conversationId, ...(startAfterMs ? { startAfter: Math.ceil(startAfterMs / 1000) } : {}) },
    );
  }

  async #runTurn(conversationId: string): Promise<void> {
    if (this.#stopping) {
      // Mid-restart: leave the inbox for the next host's sweeper.
      await this.#o.pool.query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [conversationId]);
      return;
    }
    const conversation = await getConversation(this.#o.pool, conversationId);
    if (!conversation) return;
    const sticky = this.#live.get(conversationId);
    const holder = sticky?.holder ?? `${this.#o.hostId}/${randomUUID()}`;

    let leaseGen: number;
    try {
      leaseGen = await withTransaction(this.#o.pool, async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO orbit_live_loops (user_sub, conversation_id, holder, expires_at)
            VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
            ON CONFLICT (user_sub) DO UPDATE
              SET conversation_id = EXCLUDED.conversation_id, holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
              WHERE orbit_live_loops.expires_at <= now() OR orbit_live_loops.conversation_id = EXCLUDED.conversation_id`,
          [conversation.ownerSub, conversationId, this.#o.hostId, this.#o.lease.maxTurnMs],
        );
        if (rowCount === 0) throw new Busy("the user's loop");
        const gen = await acquireLeaseInTransaction(client, conversation.storeId, holder, this.#o.lease.ttlMs);
        if (gen === undefined) throw new Busy("the lease");
        return gen;
      });
    } catch (error) {
      if (!(error instanceof Busy)) throw error;
      // Never wait on the other conversation here: the job slot would be held for its whole turn.
      this.#o.onEvent(conversationId, { type: "waiting" });
      await this.#send(conversationId, this.#o.retryAfterMs?.() ?? 1000 + Math.random() * 2000);
      return;
    }

    try {
      let live = sticky;
      // Someone else held the store since this worker opened it; its storage is fenced out anyway.
      if (live && live.leaseGen !== leaseGen) {
        await live.worker.terminate();
        live = undefined;
      }
      live ??= await this.#boot(conversation, holder, leaseGen);
      await this.#drain(live);
      await this.#o.pool.query("UPDATE orbit_conversations SET interrupted = false WHERE id = $1", [conversationId]);
    } finally {
      await this.#o.pool.query(
        "DELETE FROM orbit_live_loops WHERE user_sub = $1 AND conversation_id = $2 AND holder = $3",
        [conversation.ownerSub, conversationId, this.#o.hostId],
      );
    }
  }

  async #boot(conversation: ConversationRow, holder: string, leaseGen: number): Promise<Live> {
    const { pool } = this.#o;
    const pageId = conversation.pageId ?? (await this.#o.pageFor(conversation));
    if (conversation.pageId === null) {
      await pool.query("UPDATE orbit_conversations SET page_id = $2 WHERE id = $1", [conversation.id, pageId]);
    }
    const data: WorkerData = {
      storeId: conversation.storeId,
      leaseGen,
      ...(conversation.durableConversationId ? { conversationId: conversation.durableConversationId } : {}),
      database: this.#o.databaseUrl,
      galaxyUrl: this.#o.galaxyUrl,
      pageId,
      model: await this.#o.modelFor(conversation.ownerSub),
      limits: this.#o.limits,
      ...(this.#o.compileCache ? { compileCache: this.#o.compileCache } : {}),
    };
    const worker = (this.#o.spawn ?? spawnWorker)(this.#o.bundle, data);
    const live: Live = {
      conversationId: conversation.id,
      sub: conversation.ownerSub,
      storeId: conversation.storeId,
      holder,
      leaseGen,
      worker,
      asks: new Map(),
      waiters: new Set(),
      inTurn: false,
      exited: false,
    };
    this.#live.set(conversation.id, live);
    worker.on("message", (message: FromWorker) => this.#onMessage(live, message));
    worker.on("error", (error) => this.#o.log?.(`worker for ${conversation.id} failed: ${error.message}`));
    worker.once("exit", (code) => void this.#onExit(live, code));

    const ready = (await this.#next(live, "ready")) as Extract<FromWorker, { type: "ready" }>;
    if (conversation.durableConversationId === null) {
      await pool.query("UPDATE orbit_conversations SET durable_conversation_id = $2 WHERE id = $1", [
        conversation.id,
        ready.conversationId,
      ]);
    }
    live.renew = setInterval(() => {
      renewLease(pool, live.storeId, holder, this.#o.lease.ttlMs).then(
        (held) => {
          if (!held) void worker.terminate();
        },
        (error: Error) => this.#o.log?.(`lease renewal for ${conversation.id} failed: ${error.message}`),
      );
    }, this.#o.lease.renewMs);
    // An interrupted run picked up again counts as this turn's work before any new message.
    if (ready.resuming) await this.#bounded(live, () => this.#next(live, "settled"));
    return live;
  }

  /** Hand the inbox to the worker as one input, then wait for the run to settle. */
  async #drain(live: Live): Promise<void> {
    const { rows } = await this.#o.pool.query<{ id: string; text: string }>(
      "SELECT id, text FROM orbit_inbox WHERE conversation_id = $1 ORDER BY id",
      [live.conversationId],
    );
    if (rows.length === 0) return;
    const text = rows.map((r) => r.text).join("\n\n");
    await this.#bounded(live, async () => {
      // Busy with a run Orbit started (a greeting, an auto-resume follow-up): let it finish, then retry.
      for (let attempt = 0; ; attempt++) {
        live.worker.postMessage({ cmd: "submit", text });
        const ack = (await this.#next(live, "submitted")) as Extract<FromWorker, { type: "submitted" }>;
        // Registered right after the ack and before the port delivers anything else, so the settled it
        // waits for is the run this submit started (or, refused, the run that was in the way), never
        // one that finished before the submit landed.
        const settled = this.#next(live, "settled");
        if (ack.admitted) {
          // Taken into the conversation's durable inbox, so the messages are no longer ours to keep.
          await this.#o.pool.query("DELETE FROM orbit_inbox WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
          await settled;
          return;
        }
        if (attempt >= 20) throw new Error(`Conversation ${live.conversationId} stayed busy`);
        // The run in the way may have settled just before the refusal came back, so don't wait on
        // its settled alone.
        settled.catch(() => undefined);
        await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 500))]);
      }
    });
  }

  /** Run a turn's wait under the turn cap; past it, the worker is stopped and the turn is interrupted. */
  async #bounded(live: Live, wait: () => Promise<unknown>): Promise<void> {
    live.inTurn = true;
    const cap = setTimeout(() => void live.worker.terminate(), this.#o.lease.maxTurnMs);
    try {
      await wait();
    } finally {
      clearTimeout(cap);
      live.inTurn = false;
    }
  }

  #onMessage(live: Live, message: FromWorker): void {
    switch (message.type) {
      case "token":
        void answerTokenRequest({
          sub: live.sub,
          storeId: live.storeId,
          leaseGen: live.leaseGen,
          db: this.#o.pool,
          tokens: this.#o.tokens,
        }).then((answer) => live.worker.postMessage({ cmd: "token", id: message.id, ...answer }));
        return;
      case "ask":
        live.asks.set(message.id, message.request);
        break;
      case "ask-withdrawn":
        live.asks.delete(message.id);
        break;
      case "report":
        this.#o.log?.(`conversation ${live.conversationId}: ${message.message}`);
        return;
      case "reach":
        return;
    }
    for (const waiter of [...live.waiters]) {
      if (waiter.type !== message.type) continue;
      live.waiters.delete(waiter);
      waiter.resolve(message);
    }
    if (message.type !== "submitted" && message.type !== "closed") this.#o.onEvent(live.conversationId, message);
  }

  async #onExit(live: Live, code: number): Promise<void> {
    live.exited = true;
    clearInterval(live.renew);
    if (this.#live.get(live.conversationId) === live) this.#live.delete(live.conversationId);
    for (const waiter of live.waiters) waiter.reject(new Error(`The worker exited with ${code}`));
    live.waiters.clear();
    const { pool } = this.#o;
    // Cut off mid-turn (a crash, the turn cap, a restart) or holding an ask: resume it later. A lost
    // lease means another host has the conversation, and it's theirs to resume.
    if ((live.inTurn || live.asks.size > 0) && code !== LEASE_LOST_EXIT_CODE) {
      await pool.query("UPDATE orbit_conversations SET interrupted = true WHERE id = $1", [live.conversationId]).catch(() => undefined);
    }
    // Let the next worker take the lease without waiting out the TTL; its acquire still bumps.
    await releaseLease(pool, live.storeId, live.holder).catch(() => undefined);
    this.#o.onEvent(live.conversationId, { type: "worker-exit", code });
  }

  #next(live: Live, type: FromWorker["type"]): Promise<FromWorker> {
    if (live.exited) return Promise.reject(new Error("The worker has exited"));
    return new Promise((resolve, reject) => live.waiters.add({ type, resolve, reject }));
  }
}
