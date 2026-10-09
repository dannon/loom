#!/usr/bin/env node
/**
 * Tabulate what the evidence gate decided, or would have decided in deny
 * mode, across a set of activity logs (#475's audit rule: a gate's default
 * moves to `deny` only with an audit note behind it).
 *
 *   node scripts/evidence-gate-audit.mjs <file-or-dir>...  [--json]
 *
 * A directory is searched for `activity.jsonl` files. Every `evidence.decision`
 * row is counted; a row with contradictions that weren't overridden is one
 * deny would have fired on (in deny mode it was the deny). Each of those is
 * listed with what is needed to adjudicate it by hand: the step, the source
 * (`block` -- the legacy status check -- or `registry`), the invocation or
 * attempts, and, for a block contradiction, when the poller next moved that
 * invocation, so a stale block (Galaxy already done, poller not caught up)
 * shows as a short gap. Overrides and enrichment warnings are counted too.
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const roots = args.filter((a) => a !== "--json");
if (roots.length === 0) {
  console.error("usage: evidence-gate-audit.mjs <file-or-dir>... [--json]");
  process.exit(2);
}

function* activityFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return;
  }
  if (stat.isFile()) {
    yield root;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* activityFiles(full);
    else if (entry.name === "activity.jsonl") yield full;
  }
}

function rowsOf(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line is not the audit's problem.
    }
  }
  return out;
}

/** The reason one contradiction would deny, as a tabulation key. */
function reasonOf(c) {
  if (c.source === "registry") {
    return `registry:${c.kind ?? "flip"}:${(c.missing ?? ["unknown"]).join("+")}`;
  }
  // Rows from before the source field existed are all block contradictions.
  return `block:${c.status ?? "unknown"}`;
}

const files = [...new Set(roots.flatMap((r) => [...activityFiles(r)]))].sort();
const totals = {
  files: files.length,
  filesWithDecisions: 0,
  decisions: 0,
  completions: 0,
  outcomes: {},
  modes: {},
  wouldDeny: 0,
  byReason: {},
  overrides: 0,
  enrichmentWarnings: 0,
  enrichmentReasons: {},
};
const denies = [];

for (const file of files) {
  const rows = rowsOf(file);
  const decisions = rows.filter((r) => r.kind === "evidence.decision");
  if (decisions.length > 0) totals.filesWithDecisions++;
  const transitions = rows.filter((r) => r.kind === "poll.transition");
  for (const r of rows) {
    if (r.kind === "evidence.override") totals.overrides++;
    if (r.kind === "evidence.enrichment_warning") {
      for (const w of r.payload?.warnings ?? []) {
        totals.enrichmentWarnings++;
        for (const reason of w.reasons ?? []) {
          totals.enrichmentReasons[reason] = (totals.enrichmentReasons[reason] ?? 0) + 1;
        }
      }
    }
  }
  for (const d of decisions) {
    const p = d.payload ?? {};
    totals.decisions++;
    totals.completions += (p.completions ?? []).length;
    totals.outcomes[p.outcome] = (totals.outcomes[p.outcome] ?? 0) + 1;
    totals.modes[p.mode] = (totals.modes[p.mode] ?? 0) + 1;
    const overridden = new Set(p.overridden ?? []);
    const standing = (p.contradictions ?? []).filter((c) => !overridden.has(c.step));
    if (standing.length === 0) continue;
    totals.wouldDeny++;
    for (const c of standing) {
      const reason = reasonOf(c);
      totals.byReason[reason] = (totals.byReason[reason] ?? 0) + 1;
      const at = Date.parse(d.timestamp);
      const next =
        c.invocationId &&
        transitions.find((t) => t.payload?.id === c.invocationId && Date.parse(t.timestamp) >= at);
      denies.push({
        file,
        timestamp: d.timestamp,
        mode: p.mode,
        outcome: p.outcome,
        tool: p.toolName,
        step: c.step,
        reason,
        ...(c.invocationId ? { invocationId: c.invocationId } : {}),
        ...(c.attempts ? { attempts: c.attempts } : {}),
        ...(next
          ? {
              nextTransition: {
                to: next.payload?.to,
                afterSeconds: Math.round((Date.parse(next.timestamp) - at) / 1000),
              },
            }
          : {}),
      });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ totals, denies }, null, 2));
} else {
  const lines = [];
  lines.push(`activity logs read: ${totals.files} (${totals.filesWithDecisions} with decisions)`);
  lines.push(`evidence.decision rows: ${totals.decisions} (${totals.completions} completions)`);
  lines.push(
    `outcomes: ${JSON.stringify(totals.outcomes)}  modes: ${JSON.stringify(totals.modes)}`,
  );
  lines.push(`would deny: ${totals.wouldDeny}`);
  for (const [reason, n] of Object.entries(totals.byReason).sort()) lines.push(`  ${reason}: ${n}`);
  lines.push(`overrides: ${totals.overrides}`);
  lines.push(
    `enrichment warnings: ${totals.enrichmentWarnings} ${JSON.stringify(totals.enrichmentReasons)}`,
  );
  for (const d of denies) {
    const next = d.nextTransition
      ? ` -> ${d.nextTransition.to} after ${d.nextTransition.afterSeconds}s`
      : "";
    lines.push(
      `- ${d.timestamp} ${d.step} ${d.reason} ${d.invocationId ?? (d.attempts ?? []).join(",")}${next}  [${d.file}]`,
    );
  }
  console.log(lines.join("\n"));
}
