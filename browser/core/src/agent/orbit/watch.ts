/**
 * The durable watch under Orbit's brain: one pi-durable task per conversation, the worker's only
 * clock. Orbit's poller has no timer in the worker (slice 3, commit 5); this task drives it.
 *
 * Each tick polls through Orbit (`pollGalaxyNow`), which advances the record's blocks by the
 * record's own key and reports the ledger's undelivered transitions. The tick posts each one to
 * the page, writes down the follow-up it is about to hand over, hands the conversation Orbit's
 * follow-up text under that request id, then marks those transitions delivered. Re-running any
 * step after a crash is safe: the poller's writes are compare-and-swap, a replayed follow-up
 * reuses the request id it wrote down, and the page drops a Settled it has shown. The watch ends
 * once nothing is in flight, waiting on enrichment, sent and uncaptured, or undelivered: the
 * ledger is the capture barrier, so a capture that takes several ticks keeps it alive.
 *
 * For a conversation the page isn't showing it polls nothing (Orbit's poller works on the bound
 * record) and waits for the conversation to be shown again, with no timer and no writes.
 */
import { defineDoc, defineTask, type ConversationId, type Tx } from "@earendil-works/pi-durable";

import type { PollOptions, TickResult } from "../../../../../extensions/loom/galaxy-poller";
import type { TerminalEvent } from "../../../../../extensions/loom/submission-ledger";
import { FollowUps, heldBy } from "../documents";
import { pollDelay, type Settled } from "../watch";

/** The task's name, shared with the default brain's watch: the page and drives know it by it. */
export const ORBIT_WATCH = "olit.galaxy-watch";

/**
 * Whether a conversation has a live watch; whether its next tick should first capture what the
 * ledger holds answered and reconcile (the first tick after the conversation is shown); and
 * whether new work arrived, so the next tick starts its backoff over.
 */
export const Watching = defineDoc<{ active: boolean; recover: boolean; fresh?: boolean }>({
  kind: "olit.watching",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ active: false, recover: false }),
});

export interface OrbitWatchOptions {
  /** Whether the page shows this conversation now, so Orbit's poller works on its record. */
  bound(conversationId: ConversationId): boolean;
  /** The record key Orbit's poller pins for this conversation. */
  recordKey(conversationId: ConversationId): string;
  poll(options: PollOptions): Promise<TickResult>;
  delivered(recordKey: string, keys: readonly string[]): Promise<void>;
  /** Tell the page some watched work settled. */
  settled(conversationId: ConversationId, settled: Settled): void;
  /**
   * Resolves when something asked this conversation's watch to look now. A wake asked for while
   * nobody was waiting counts: it resolves the next call at once.
   */
  woken(conversationId: ConversationId): Promise<void>;
  pollMs?: number;
}

type WatchInput = { conversationId: ConversationId };
/** A follow-up written down before it is handed over, so a replay hands over the same one. */
type Pending = { requestId: string; prompt: string; keys: string[]; queue: boolean };
type WatchState = { phase: "tick"; ticks: number; pending?: Pending };

/** A ledger event as the page's Settled: the browser brain's shape, which shell.ts renders. */
export function settledOf(event: TerminalEvent): Settled {
  // "failing" is a mid-flight failure: some jobs failed and the invocation runs on.
  const state = event.outcome === "failing" ? "failing" : event.to;
  return {
    watched: { kind: event.kind, id: event.id, label: event.label, state },
    state,
    outcome: event.outcome === "failing" ? "failed" : (event.outcome as Settled["outcome"]),
  };
}

/**
 * Wakes for each conversation's watch. A wake with nobody waiting (it landed mid-tick, say) is
 * kept, and resolves the next wait at once.
 */
export function wakeups() {
  const waiting = new Map<ConversationId, () => void>();
  const early = new Set<ConversationId>();
  return {
    wake(id: ConversationId) {
      const resolve = waiting.get(id);
      waiting.delete(id);
      if (resolve) resolve();
      else early.add(id);
    },
    woken(id: ConversationId): Promise<void> {
      if (early.delete(id)) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.set(id, resolve));
    },
  };
}

export function orbitWatch(options: OrbitWatchOptions) {
  const pollMs = options.pollMs ?? 10_000;

  /** Until `ms` pass (never, without one), a wake, or the invocation ending. */
  const pause = (id: ConversationId, ms: number | undefined, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      void options.woken(id).then(done);
    });

  const task = defineTask<WatchInput, WatchState, { ticks: number }>({
    name: ORBIT_WATCH,
    version: 3,
    initial: () => ({ phase: "tick", ticks: 0 }),
    phases: {
      tick: async (current, runtime, context) => {
        const id = current.input.conversationId;
        const checkpoint = current.state.checkpoint as WatchState;
        // Until the page shows it: no timer and no writes, just the wake an attach sends.
        while (!options.bound(id)) {
          if (runtime.signal.aborted) return;
          await pause(id, undefined, runtime.signal);
        }
        const handOver = async (pending: Pending) => {
          const conversation = await runtime.conversation(id, context);
          await conversation?.submit(
            {
              type: "input",
              content: pending.prompt,
              requestId: pending.requestId,
              ...(pending.queue ? { whenIdle: "queue" as const } : {}),
            },
            context,
          );
          await options.delivered(options.recordKey(id), pending.keys);
        };
        let ticks = checkpoint.ticks;
        try {
          // A follow-up a tick wrote down and didn't live to finish handing over.
          if (checkpoint.pending) {
            await handOver(checkpoint.pending);
            await runtime.commit(
              () => ({ status: "running", checkpoint: { phase: "tick", ticks } }),
              context,
            );
          }
          const watching = await runtime.snapshot(Watching, id, context);
          const recover = watching?.recover === true;
          if (watching?.fresh) ticks = 0;
          const result = await options.poll({
            awaitEnrichment: true,
            ...(recover ? { reconcile: true, recover: true } : {}),
          });
          // A tick that ran against another record (the page switched mid-tick) says nothing here.
          if (result.recordKey === options.recordKey(id)) {
            for (const event of result.transitions) options.settled(id, settledOf(event));
            const keys = result.transitions.map((t) => t.key);
            if (result.resumePrompt && keys.length) {
              const held = heldBy(await runtime.snapshot(FollowUps, id, context)) !== undefined;
              const pending: Pending = {
                requestId: `watch:${id}:${keys.join(",")}`,
                prompt: result.resumePrompt,
                keys,
                queue: held,
              };
              await runtime.commit(async (tx) => {
                if (!held) (await tx.doc(FollowUps, id)).automatic += 1;
                return { status: "running", checkpoint: { phase: "tick", ticks, pending } };
              }, context);
              await handOver(pending);
            } else if (keys.length) {
              await options.delivered(result.recordKey, keys);
            }
            // Settled work starts the backoff over: what follows tends to be more work.
            if (keys.length) ticks = 0;
            const quiet =
              result.inProgress === 0 &&
              result.pendingEnrichment === 0 &&
              result.openSubmissions === 0;
            if (quiet) {
              await runtime.commit(async (tx) => {
                Object.assign(await tx.doc(Watching, id), {
                  active: false,
                  recover: false,
                  fresh: false,
                });
                return {
                  status: "terminal",
                  outcome: { status: "completed", result: { ticks: ticks + 1 } },
                };
              }, context);
              return;
            }
          }
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(Watching, id);
            if (recover) doc.recover = false;
            doc.fresh = false;
            return { status: "running", checkpoint: { phase: "tick", ticks: ticks + 1 } };
          }, context);
        } catch (error) {
          // A tick that fails (a ledger write refused, Galaxy down) is retried, not given up on:
          // a faulted watch would leave the conversation unwatched for good.
          if (runtime.signal.aborted) return;
          runtime.report(error);
          // From the task as it stands: a follow-up this tick wrote down has to survive.
          await runtime
            .commit(
              (_tx, now) => ({
                status: "running",
                checkpoint: { ...(now.state.checkpoint as WatchState), ticks: ticks + 1 },
              }),
              context,
            )
            .catch(() => {});
        }
        // Every way out commits a new count first: pi-durable runs the phase again once its
        // checkpoint has moved, and the count is the backoff.
        await pause(id, pollDelay(ticks + 1, pollMs), runtime.signal);
      },
    },
    abort: async (current, runtime, context) => {
      await runtime.commit(async (tx) => {
        (await tx.doc(Watching, current.input.conversationId)).active = false;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  /**
   * Make sure the conversation has a watch, in the caller's transaction: a submission's execute,
   * or the worker showing the conversation (with `recover`, so the first tick captures and
   * reconciles). Idempotent through the Watching doc; `stale` says the caller found no live task
   * behind an `active` flag (a watch that faulted anyway), so a new one is made.
   */
  async function ensure(
    tx: Tx,
    conversationId: ConversationId,
    { recover = false, stale = false } = {},
  ) {
    const doc = await tx.doc(Watching, conversationId);
    if (recover) doc.recover = true;
    if (doc.active && !stale) {
      // A live watch: new work starts its backoff over.
      doc.fresh = true;
      return;
    }
    doc.active = true;
    doc.fresh = false;
    await tx.createTask(
      task,
      { conversationId },
      {
        ownership: { kind: "conversation" },
        conversationId,
        // Outlives a Stop or a switch: the work it watches goes on in Galaxy.
        background: true,
      },
    );
  }

  return { task, ensure };
}
