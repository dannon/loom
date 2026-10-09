/**
 * The evidence gate's registry path: for a step with a recorded run, the
 * verdict is the registry's `handoff_eligible`, not the block's `status:` text.
 * These are the #475 gaps 1-3 that the registry closes, as expected passes,
 * plus `/override` written into the registry as an exception.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state");
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => ({}) }));

import * as state from "../extensions/loom/state";
import {
  decideTransition,
  findRegistryContradictions,
  registerEvidenceGate,
  registryHolds,
  resetEvidenceOverrides,
} from "../extensions/loom/evidence-gate";
import {
  planOverride,
  registerEvidenceOverrideCommand,
  writeRegistryOverride,
} from "../extensions/loom/evidence-override-command";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import {
  closeSessionRegistry,
  heldRevocations,
  openSessionRegistry,
  sessionView,
} from "../extensions/loom/registry-runtime";
import { canonicalJson, type Attempt, type Registry } from "../extensions/loom/registry-schema";
import { eligibleAttempt, SERVER, T0 } from "./registry-fixtures";
import { ulid } from "../extensions/loom/ulid";

const PLAN = `# Notebook

## Plan A: chrM Variant Calling [hybrid]

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp
- [ ] 2. **Align reads** {#plan-a-step-2} — bwa mem
`;
const STEP2 = "2. **Align reads** {#plan-a-step-2} — bwa mem";

function invocation(over: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "abc0000000000001",
    galaxyServerUrl: SERVER,
    notebookAnchor: "plan-a-step-2",
    label: "Align reads",
    submittedAt: "2026-08-01T00:00:00Z",
    status: "completed",
    ...over,
  };
}

/** A run bound to step 2 that the registry knows about. */
function boundAttempt(over: { eligible?: boolean; anchor?: string; id?: string } = {}): Attempt {
  const a = eligibleAttempt({ id: over.id });
  a.binding.step_anchor = over.anchor ?? "plan-a-step-2";
  if (over.eligible === false) a.evaluation!.execution = "unknown";
  return a;
}

function registryOf(...attempts: Attempt[]): Registry {
  return {
    version: 3,
    revision: 1,
    writer_token: "t",
    session_sig: "s",
    analysis_id: "an",
    server_url: SERVER,
    attempts: Object.fromEntries(attempts.map((a) => [a.attempt_id, a])),
    exceptions: [],
    supervision: { active_at_shutdown: [] },
  };
}

const flip = (content: string, step = STEP2) => content.replace(`- [ ] ${step}`, `- [x] ${step}`);

describe("registryHolds", () => {
  it("holds a step whose only run isn't eligible, and lets an eligible one through", () => {
    expect(
      registryHolds(registryOf(boundAttempt({ eligible: false }))).held.has("plan-a-step-2"),
    ).toBe(true);
    expect(registryHolds(registryOf(boundAttempt())).held.size).toBe(0);
  });

  it("one eligible run is enough, beside a stale one", () => {
    const stale = boundAttempt({ eligible: false, id: ulid(T0) });
    const fresh = boundAttempt({ id: ulid(T0 + 1000) });
    const { held, bound } = registryHolds(registryOf(stale, fresh));
    expect(bound.has("plan-a-step-2")).toBe(true);
    expect(held.size).toBe(0);
  });

  it("an approval nothing was submitted for leaves the step to the legacy path", () => {
    const a = boundAttempt({ eligible: false });
    delete a.submission;
    const { held, bound } = registryHolds(registryOf(a));
    expect(bound.size).toBe(0);
    expect(held.size).toBe(0);
  });

  it("ignores unattributed runs", () => {
    expect(
      registryHolds(registryOf(boundAttempt({ eligible: false, anchor: "unattributed" }))).bound
        .size,
    ).toBe(0);
  });

  it("recomputes eligibility, so a stored flag can't let a step through", () => {
    const a = boundAttempt({ eligible: false });
    a.handoff_eligible = true;
    expect(registryHolds(registryOf(a)).held.size).toBe(1);
  });

  it("a user evidence-gate exception lets the held run through; a restored one doesn't", () => {
    const a = boundAttempt({ eligible: false });
    const reg = registryOf(a);
    const x = {
      id: "o1",
      attempt_id: a.attempt_id,
      spec_revision: a.approval!.spec_revision,
      scope: "evidence_gate" as const,
      by: "restored" as const,
      at: "2026-09-25T12:00:00.000Z",
      reason: "r",
    };
    reg.exceptions = [x];
    expect(registryHolds(reg).held.size).toBe(1);
    reg.exceptions = [{ ...x, by: "user" }];
    expect(registryHolds(reg).held.size).toBe(0);
  });
});

describe("decideTransition on the registry path", () => {
  const held = registryOf(boundAttempt({ eligible: false }));
  const before = PLAN + "\n" + renderInvocationYaml(invocation());

  it("denies a flip the registry contradicts even though the block says completed (gap 1)", () => {
    // The two-edit split: the block's status was already rewritten to
    // `completed`. The registry doesn't read it.
    const d = decideTransition(before, flip(before), "deny", held);
    expect(d.gated).toBe(true);
    expect(d.contradictions).toEqual([
      expect.objectContaining({ source: "registry", kind: "flip" }),
    ]);
    expect(d.reason).toMatch(/registry/);
    expect(d.reason).toMatch(/\/override plan-a-step-2/);
  });

  it("allows the flip once the record says eligible", () => {
    const d = decideTransition(before, flip(before), "deny", registryOf(boundAttempt()));
    expect(d.gated).toBe(false);
    expect(d.contradictions).toEqual([]);
    expect(d.completions.map((s) => s.key)).toEqual(["#plan-a-step-2"]);
  });

  it("doesn't consult the block for a step the registry judges", () => {
    const inFlight = PLAN + "\n" + renderInvocationYaml(invocation({ status: "in_progress" }));
    const d = decideTransition(inFlight, flip(inFlight), "deny", registryOf(boundAttempt()));
    expect(d.contradictions).toEqual([]);
  });

  it("catches an anchor rename plus flip in one edit (gap 2)", () => {
    const after = before.replace(`- [ ] ${STEP2}`, `- [x] 2. **Align reads** {#align} — bwa mem`);
    const d = decideTransition(before, after, "deny", held);
    expect(d.gated).toBe(true);
    expect(d.contradictions).toEqual([
      expect.objectContaining({ source: "registry", kind: "vanished" }),
    ]);
  });

  it("refuses the rename on its own, so the two-edit version fails at the first edit (gap 2)", () => {
    const after = before.replace(`{#plan-a-step-2}`, `{#align}`);
    expect(decideTransition(before, after, "deny", held).gated).toBe(true);
  });

  it("catches a plan-heading rename plus flip (gap 3)", () => {
    const after = flip(before).replace("## Plan A: chrM Variant Calling [hybrid]", "## Done");
    const d = decideTransition(before, after, "deny", held);
    expect(d.gated).toBe(true);
    expect(d.contradictions[0]).toMatchObject({ source: "registry", kind: "flip" });
  });

  it("catches a completed copy of the step pasted beside the pending one", () => {
    const after = before + `\n- [x] ${STEP2}\n`;
    expect(decideTransition(before, after, "deny", held).gated).toBe(true);
  });

  it("catches the step moved into a fence", () => {
    const after = before.replace(`- [ ] ${STEP2}`, "```\n- [x] " + STEP2 + "\n```");
    expect(decideTransition(before, after, "deny", held).gated).toBe(true);
  });

  it("lets a held step be marked failed", () => {
    const after = before.replace(`- [ ] ${STEP2}`, `- [!] ${STEP2}`);
    expect(decideTransition(before, after, "deny", held).contradictions).toEqual([]);
  });

  it("treats a notebook written from nothing as a completion", () => {
    expect(findRegistryContradictions("", flip(PLAN), held)).toHaveLength(1);
  });

  it("warn records without gating", () => {
    const d = decideTransition(before, flip(before), "warn", held);
    expect(d.gated).toBe(false);
    expect(d.contradictions).toHaveLength(1);
  });

  it("other steps are untouched by a hold", () => {
    const after = before.replace("- [ ] 1. **QC FASTQ**", "- [x] 1. **QC FASTQ**");
    expect(decideTransition(before, after, "deny", held).contradictions).toEqual([]);
  });
});

describe("a run bound to a positional address", () => {
  const plan = "# N\n\n## Plan A: Test\n\n- [ ] Original held step\n- [ ] Another step\n";
  const held = registryOf(boundAttempt({ eligible: false, anchor: "plan-a-step-1" }));

  it("can't be moved by inserting a step above it, then completed (Codex, slice 4)", () => {
    const after = plan.replace(
      "- [ ] Original held step",
      "- [ ] Newly inserted step\n- [x] Original held step",
    );
    const d = decideTransition(plan, after, "deny", held);
    expect(d.gated).toBe(true);
    expect(d.contradictions[0]).toMatchObject({ source: "registry", kind: "vanished" });
  });

  it("is still held for a plain flip, and free to be marked failed", () => {
    expect(
      decideTransition(plan, plan.replace("- [ ] Orig", "- [x] Orig"), "deny", held).gated,
    ).toBe(true);
    expect(
      decideTransition(plan, plan.replace("- [ ] Orig", "- [!] Orig"), "deny", held).gated,
    ).toBe(false);
  });
});

describe("/override on the registry path", () => {
  it("plans an exception on each held run", () => {
    const a = boundAttempt({ eligible: false });
    const result = planOverride(PLAN, "plan-a-step-2 checked the BAM by hand", registryOf(a));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        source: "registry",
        anchor: "plan-a-step-2",
        attempts: [a.attempt_id],
        reason: "checked the BAM by hand",
      });
    }
  });

  it("can address a held step the notebook no longer shows", () => {
    const a = boundAttempt({ eligible: false, anchor: "gone-step" });
    const result = planOverride(PLAN, "gone-step dropped on purpose", registryOf(a));
    expect(result.ok).toBe(true);
  });

  it("says so when nothing is held", () => {
    const result = planOverride(PLAN, "plan-a-step-2 x", registryOf(boundAttempt()));
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the real hook, with a real session registry
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let nbPath: string;

function fakePi() {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const listeners = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (a: string | undefined, c: unknown) => Promise<void> }
  >();
  const notices: string[] = [];
  const api = {
    on(name: string, handler: Handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    },
    registerCommand(
      name: string,
      opts: { handler: (a: string | undefined, c: unknown) => Promise<void> },
    ) {
      commands.set(name, opts);
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    notices,
    async write(input: Record<string, unknown>, toolName = "edit") {
      let result: unknown;
      for (const h of listeners.get("tool_call") ?? [])
        result = await h({ toolName, input }, { cwd: dir });
      return result as { block?: boolean; reason?: string } | undefined;
    },
    async runCommand(name: string, args: string) {
      await commands.get(name)!.handler(args, { ui: { notify: (m: string) => notices.push(m) } });
    },
  };
}

function plantForeignRegistry(...attempts: Attempt[]): void {
  const stateDir = path.join(dir, ".loom", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "registry.json"), canonicalJson(registryOf(...attempts)));
}

function rows(kind: string): Record<string, any>[] {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === kind);
}

const flipEdit = {
  path: "notebook.md",
  edits: [{ oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` }],
};

describe("the hook reads the session's registry", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-evidence-registry-"));
    nbPath = path.join(dir, "notebook.md");
    fs.writeFileSync(nbPath, PLAN + "\n" + renderInvocationYaml(invocation()));
    vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
    resetEvidenceOverrides();
    process.env.LOOM_EVIDENCE_GATE = "deny";
  });
  afterEach(() => {
    closeSessionRegistry();
    delete process.env.LOOM_EVIDENCE_GATE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("denies a flip on an imported run until /override writes the user's exception", async () => {
    // An import: whatever it claimed, it is historical until re-verified.
    plantForeignRegistry(boundAttempt());
    const { session } = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);

    const first = await pi.write(flipEdit);
    expect(first?.block).toBe(true);
    expect(rows("evidence.decision").at(-1)?.payload.contradictions[0]).toMatchObject({
      source: "registry",
      kind: "flip",
      step: "#plan-a-step-2",
    });

    await pi.runCommand("override", "plan-a-step-2 verified the outputs in Galaxy myself");
    expect(pi.notices.at(-1)).toMatch(/Override recorded/);
    const exceptions = session.store.snapshot().exceptions;
    expect(exceptions).toEqual([
      expect.objectContaining({
        scope: "evidence_gate",
        by: "user",
        reason: "verified the outputs in Galaxy myself",
      }),
    ]);
    expect(rows("evidence.override").at(-1)?.payload).toMatchObject({ source: "registry" });

    const second = await pi.write(flipEdit);
    expect(second?.block).toBeUndefined();
    // Not one-shot: the user excused these runs, so a reopen-and-complete is fine too.
    expect((await pi.write(flipEdit))?.block).toBeUndefined();
  });

  it("refuses /override when the registry can't take it", async () => {
    plantForeignRegistry(boundAttempt());
    const { session } = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    session.store.close();
    const a = Object.values(session.store.snapshot().attempts)[0];
    expect(writeRegistryOverride(session, [a.attempt_id], "r", "now")).toMatch(/read-only/);
  });

  it("a revocation held in memory counts at once", () => {
    const a = boundAttempt();
    // Eligible by construction while live; the held revocation withdraws it.
    const reg = registryOf(a);
    expect(registryHolds(reg).held.size).toBe(0);
    plantForeignRegistry();
    const { session } = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    session.store.update((d) => {
      d.attempts[a.attempt_id] = a;
    });
    expect(registryHolds(sessionView(session)).held.size).toBe(0);
    heldRevocations(session.store).set(a.attempt_id, {
      attemptId: a.attempt_id,
      proposalId: "prop-1",
      reason: "edited",
    } as never);
    expect(registryHolds(sessionView(session)).held.size).toBe(1);
  });
});
