/**
 * Token usage for a run, summed over every model call it made.
 *
 * pi emits one `turn_end` per model call, and the usage rides on the assistant
 * message it carries (`turn_end.message.usage`), not on the event itself. A
 * scenario with tool calls makes several model calls, so reading only the first
 * `turn_end` would undercount; every one is summed here.
 */

import type { AnyEvent, ScenarioRun } from "./types.js";

export interface RunUsage {
  /** Model calls that reported usage, failed ones included. */
  calls: number;
  /** Of those, calls that ended in an error or abort (a 429, say); usually zero tokens. */
  errors: number;
  /** Uncached input tokens, as pi reports them (excludes cacheRead/cacheWrite). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** USD from pi's per-model prices; 0 for models priced at 0 (the TACC matrix). */
  cost: number;
}

/** pi's `Usage` fields this module reads; anything missing counts as 0. */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export function emptyUsage(): RunUsage {
  return {
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    calls: a.calls + b.calls,
    errors: a.errors + b.errors,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function callUsage(event: AnyEvent): { usage: PiUsage; failed: boolean } | null {
  if (event.type !== "turn_end") return null;
  const message = event.message as
    { role?: unknown; usage?: unknown; stopReason?: unknown } | undefined;
  if (message?.role !== "assistant") return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  return { usage: usage as PiUsage, failed };
}

/** Summed usage across a run's model calls, or null when no call reported any. */
export function sumUsage(events: AnyEvent[]): RunUsage | null {
  let total: RunUsage | null = null;
  for (const event of events) {
    const call = callUsage(event);
    if (!call) continue;
    const u = call.usage;
    total = addUsage(total ?? emptyUsage(), {
      calls: 1,
      errors: call.failed ? 1 : 0,
      input: num(u.input),
      output: num(u.output),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      totalTokens: num(u.totalTokens),
      cost: num(u.cost?.total),
    });
  }
  return total;
}

export function runUsage(run: ScenarioRun): RunUsage | null {
  return sumUsage(run.events);
}

/** 1234 -> "1.2K", 1234567 -> "1.2M"; plain integers below 1000. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** One-line summary for the per-run report line. */
export function formatUsageShort(u: RunUsage): string {
  const parts = [
    `${u.calls} call${u.calls === 1 ? "" : "s"}${u.errors > 0 ? ` (${u.errors} failed)` : ""}`,
    `${formatTokens(u.input)} in`,
    `${formatTokens(u.output)} out`,
    `${formatTokens(u.cacheRead)} cache read`,
    `${formatTokens(u.cacheWrite)} cache write`,
  ];
  if (u.cost > 0) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.join(", ");
}

/**
 * Markdown table: one row per model, usage summed over all its runs plus the
 * per-run average total, so prompt or tool changes can be compared on cost as
 * well as pass rate. Runs that reported no usage (Tier 1, no model) are skipped.
 */
export function renderUsageTable(runs: ScenarioRun[]): string | null {
  const byModel = new Map<string, { runs: number; usage: RunUsage }>();
  for (const r of runs) {
    const u = runUsage(r);
    if (!u) continue;
    const id = r.model?.id ?? "(none)";
    const acc = byModel.get(id) ?? { runs: 0, usage: emptyUsage() };
    acc.runs += 1;
    acc.usage = addUsage(acc.usage, u);
    byModel.set(id, acc);
  }
  if (byModel.size === 0) return null;

  const header =
    "| model | runs | calls | failed | input | output | cache read | cache write | total | avg total / run | cost |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { runs: n, usage: u }]) =>
      [
        id,
        String(n),
        String(u.calls),
        String(u.errors),
        formatTokens(u.input),
        formatTokens(u.output),
        formatTokens(u.cacheRead),
        formatTokens(u.cacheWrite),
        formatTokens(u.totalTokens),
        formatTokens(Math.round(u.totalTokens / n)),
        `$${u.cost.toFixed(4)}`,
      ].join(" | "),
    )
    .map((row) => `| ${row} |`);

  return ["## Token usage (summed over all model calls)", "", header, sep, ...rows].join("\n");
}
