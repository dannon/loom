/**
 * The durable watch under Orbit's brain: one pi-durable task per conversation, the worker's only
 * clock. Orbit's poller has no timer in the worker (slice 3, commit 5); this task drives it.
 *
 * Each tick polls through Orbit (`pollGalaxyNow`), which advances the record's blocks by the
 * record's own key and reports the ledger's undelivered transitions. The tick posts each one to
 * the page, hands the conversation Orbit's follow-up text with a stable request id, then marks
 * them delivered; re-running any step after a crash is safe, since the poller's writes are
 * compare-and-swap and the follow-up and the page's Settled are keyed. It ends once nothing is in
 * flight, waiting on enrichment, sent and uncaptured, or undelivered: the ledger is the capture
 * barrier, so a capture that takes several ticks keeps it alive.
 *
 * A tick for a conversation the page isn't showing polls nothing: Orbit's poller works on the
 * bound record. It waits until that conversation is shown again.
 */
import { defineDoc, defineTask, type ConversationId, type Tx } from "@earendil-works/pi-durable";

import type { PollOptions, TickResult } from "../../../../../extensions/loom/galaxy-poller";
import type { TerminalEvent } from "../../../../../extensions/loom/submission-ledger";
import { FollowUps, heldBy } from "../documents";
import { pollDelay, type Settled } from "../watch";

/** The task's name, shared with the default brain's watch: the page and drives know it by it. */
export const ORBIT_WATCH = "olit.galaxy-watch";

/**
 * Whether a conversation has a live watch, and whether its next tick should first capture what
 * the ledger holds answered and reconcile (the first tick after the conversation is shown).
 */
export const Watching = defineDoc<{ active: boolean; recover: boolean }>({
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
  /** Resolves when something asks this conversation's watch to look now. */
  woken(conversationId: ConversationId): Promise<void>;
  pollMs?: number;
}

type WatchInput = { conversationId: ConversationId };
type WatchState = { phase: "tick"; ticks: number; deferred?: boolean };

/** A ledger event as the page's Settled: the browser brain's shape, which shell.ts renders. */
export function settledOf(event: TerminalEvent): Settled {
  const outcome = event.outcome === "failing" ? "failed" : (event.outcome as Settled["outcome"]);
  return {
    watched: { kind: event.kind, id: event.id, label: event.label, state: event.to },
    state: event.outcome === "failing" ? "failing" : event.to,
    outcome,
  };
}

export function orbitWatch(options: OrbitWatchOptions) {
  const pollMs = options.pollMs ?? 10_000;
  const task = defineTask<WatchInput, WatchState, { ticks: number }>({
    name: ORBIT_WATCH,
    version: 3,
    initial: () => ({ phase: "tick", ticks: 0 }),
    phases: {
      tick: async (current, runtime, context) => {
        const id = current.input.conversationId;
        const { ticks } = current.state.checkpoint as WatchState;
        const wait = async (polls: number) => {
          // A wake (a reconcile that saw a run end, the conversation shown again) ends the wait
          // early; returning runs this phase again.
          await Promise.race([
            runtime.sleep(runtime.now() + pollDelay(polls, pollMs), context).catch(() => {}),
            options.woken(id),
          ]);
        };
        // Every way out of a tick commits a new count before it waits: pi-durable runs a phase
        // again once its checkpoint has moved, and the count is the backoff too.
        if (!options.bound(id)) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "tick", ticks: ticks + 1, deferred: true },
            }),
            context,
          );
          await wait(ticks + 1);
          return;
        }
        const watching = await runtime.snapshot(Watching, id, context);
        const recover = watching?.recover === true;
        const result = await options.poll({
          awaitEnrichment: true,
          ...(recover ? { reconcile: true, recover: true } : {}),
        });
        // A tick that ran against another record (the page switched mid-tick) says nothing here.
        if (result.recordKey !== options.recordKey(id)) {
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "tick", ticks: ticks + 1 } }),
            context,
          );
          await wait(ticks + 1);
          return;
        }
        for (const event of result.transitions) options.settled(id, settledOf(event));
        const keys = result.transitions.map((t) => t.key);
        const policy = await runtime.snapshot(FollowUps, id, context);
        const held = heldBy(policy) !== undefined;
        if (result.resumePrompt) {
          const conversation = await runtime.conversation(id, context);
          await conversation?.submit(
            {
              type: "input",
              content: result.resumePrompt,
              requestId: `watch:${id}:${keys.join(",")}`,
              ...(held ? { whenIdle: "queue" as const } : {}),
            },
            context,
          );
        }
        if (keys.length) await options.delivered(result.recordKey, keys);
        const quiet =
          result.inProgress === 0 && result.pendingEnrichment === 0 && result.openSubmissions === 0;
        await runtime.commit(async (tx) => {
          if (result.resumePrompt && !held) (await tx.doc(FollowUps, id)).automatic += 1;
          const doc = await tx.doc(Watching, id);
          if (recover) doc.recover = false;
          if (quiet) {
            doc.active = false;
            return {
              status: "terminal",
              outcome: { status: "completed", result: { ticks: ticks + 1 } },
            };
          }
          return { status: "running", checkpoint: { phase: "tick", ticks: ticks + 1 } };
        }, context);
        if (!quiet) await wait(ticks + 1);
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
   * reconciles). Idempotent through the Watching doc.
   */
  async function ensure(tx: Tx, conversationId: ConversationId, { recover = false } = {}) {
    const doc = await tx.doc(Watching, conversationId);
    if (recover) doc.recover = true;
    if (doc.active) return;
    doc.active = true;
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
