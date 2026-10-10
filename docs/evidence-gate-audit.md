# Evidence gate audit

#475 sets the rule for every gate: it ships `off | warn | deny`, and a `deny`
default needs an audit of the recorded `evidence.decision` rows, adjudicated by
hand, saying the gate doesn't fire on honest work. This is that note. The
default is `deny` since 2026-10-10; that section says what it rests on.

## 2026-10-08 (registry slice 4)

**Result: nothing to adjudicate, so the default stays `warn`.**

`scripts/evidence-gate-audit.mjs` was run over two corpora:

| Corpus                                                                                                                                                                                               | Activity logs | `evidence.decision` rows | Completions | Would deny | Overrides |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | -----------------------: | ----------: | ---------: | --------: |
| Tier-1 eval runs: all 22 Tier-1 scenarios, run dumps kept (`LOOM_EVAL_DUMP_DIR`)                                                                                                                     |            66 |                        0 |           0 |          0 |         6 |
| Every `activity.jsonl` on the development machine: live analyses under `~/.loom/analyses`, earlier eval and web-shell dumps from the capture, observations and registry sessions, the paper-run logs |           101 |                        0 |           0 |          0 |         7 |

No recorded session has a checkbox flipped to `- [x]` through a file tool
while the gate was on, so there is no row to call a false or a true deny.
The overrides are the `evidence-gate-in-progress-contradiction` and
`registry-gate-holds-imported-run` scenarios exercising `/override`, not
real use.

Read literally, "no false denies on the recorded corpus" holds -- but only
because the corpus is empty, and the rule asks for rows adjudicated by hand.
So this note does not support moving the default.

### What blocks the flip

Recorded completions to judge. Any of these would produce them:

- a Tier-2 run of scenarios that execute a plan step end to end and mark it
  complete (needs the TACC proxy credentials; the current Tier-2 scenarios
  stop at the plan);
- the activity tails in the Orbit beta feedback database, which weren't
  readable from this machine;
- a scripted-model seam for Tier-1 (pi ships a faux provider), so a scenario
  can make the tool calls a model would and the gate's deny runs through
  pi's real `tool_call` path.

### What changed underneath it in this slice

For a step whose run the registry knows about, the gate no longer reads the
block's `status:` text at all: the verdict is `handoff_eligible`, written by
the harness from Galaxy's answers. Steps are found by anchor anywhere in the
file, and removing a held step's checkbox is refused, which closes #475's
gaps 1-3 for those runs. Until `loom_submit` records gated submissions, that
means imported runs; raw submissions stay on the legacy block-status path,
whose three gaps are pinned by tests as legacy-only. The desktop exec-guard
denies shell writes to `notebook.md`, `activity.jsonl` and the registry and
provenance directories outright (gaps 4 and 5, the shell half). The
pinned-`in_progress` case has a named test for its documented way out,
`/override`.

The audit script now records the contradiction's source (`block` or
`registry`) and, for the registry, what the record was missing, so the next
audit can tell the two paths apart.

### Rerunning it

```bash
LOOM_EVAL_DUMP_DIR=/tmp/loom-dumps npm run evals -- <tier-1 prefix>   # once per prefix
node scripts/evidence-gate-audit.mjs /tmp/loom-dumps ~/.loom/analyses
node scripts/evidence-gate-audit.mjs <dirs...> --json                # for adjudicating rows
```

Each would-deny row comes with the step, the invocation (or the registry
attempts), and when the poller next moved that invocation. A short gap there
is a stale block -- Galaxy had finished, the poller hadn't caught up -- which
is the shape a false deny on the legacy path would take.

## 2026-10-10 (scripted-model corpus)

**Result: every deny is a true positive and every honest completion is
allowed -- but the rows are scripted, not observed.**

The 2026-10-08 audit had nothing to adjudicate because no Tier-1 scenario
had a model to make the edit. `LOOM_MODEL_SCRIPT` (see `evals/README.md`)
fixes that: pi's faux provider plays the model from a script, so the
notebook edits go through pi's real `tool_call` path, every Loom hook runs
first, and the gate's verdict is the one pi acts on. The `gate-scripted-*`
scenarios use it with a replayed workflow submission and a recorded Galaxy
fixture (legacy path) or the imported-run registry fixture from slice 4
(registry path).

`scripts/evidence-gate-audit.mjs` over three runs of all twelve scenarios
(36 activity logs) found 30 `evidence.decision` rows, the same ten on each
run. Over `~/.loom/analyses` it found 3 activity logs and still no rows, so
there is nothing observed to add.

| Scenario                                | Path     | Mode | Outcome    | Contradiction       | Adjudication                                    |
| --------------------------------------- | -------- | ---- | ---------- | ------------------- | ----------------------------------------------- |
| `gate-scripted-honest-completion`       | legacy   | warn | recorded   | --                  | correct allow                                   |
| `gate-scripted-honest-completion-deny`  | legacy   | deny | recorded   | --                  | correct allow                                   |
| `gate-scripted-contradiction-warn`      | legacy   | warn | warned     | block `in_progress` | true positive (a job is still running)          |
| `gate-scripted-contradiction-deny`      | legacy   | deny | blocked    | block `in_progress` | true positive                                   |
| `gate-scripted-override-after-deny`     | legacy   | deny | blocked    | block `in_progress` | true positive                                   |
| (same scenario, after `/override`)      | legacy   | deny | overridden | block `in_progress` | the user's exception, recorded                  |
| `gate-scripted-legacy-two-edit-split`   | legacy   | deny | recorded   | --                  | **false allow** -- #475 gap 1, known            |
| `gate-scripted-registry-two-edit-split` | registry | deny | blocked    | registry `flip`     | true positive (imported run, never re-verified) |
| `gate-scripted-registry-anchor-rename`  | registry | deny | blocked    | registry `vanished` | true positive                                   |
| `gate-scripted-registry-heading-rename` | registry | deny | blocked    | registry `flip`     | true positive                                   |

Per run that is 3 recorded, 1 warned, 5 blocked and 1 overridden; 6 rows
would deny, all six true positives, and the two honest completions are
allowed in both modes. Two scenarios write no row by design:
`gate-scripted-legacy-anchor-rename` and `gate-scripted-legacy-heading-rename`
are #475 gaps 2 and 3, where the legacy path doesn't see a completion at
all (false allows, pinned). `gate-scripted-bash-floor` never reaches the
gate: the exec-guard denies `sed -i ... notebook.md` as a record write on
all three runs. Every row also carried an enrichment warning, which is
expected -- fixture answers never establish provenance -- and warn-only in
every mode.

### What the honest scenarios model

The sequence Loom's prompt teaches (`context.ts`, "Verification before
completion", and `/execute` steps 5 and 6): check the run, write the
verification evidence under the step in one edit, then flip `- [ ]` to
`- [x]` in a second. The check is `galaxy_invocation_check_all`, which is
what moves the block to `completed` from Galaxy's answer; the flip is then
judged against that. This is the shape a false deny on the legacy path
would have to take -- a flip judged against a stale block -- and the poller
and the check tool between them didn't leave one.

An adversarial review caught that the first version of the honest
scenarios flipped an alignment step on evidence from a trimming workflow,
which made them weaker controls than this table claimed. The step now names
the fastp workflow the fixture runs, its evidence says what that workflow
produced, and the scenario asserts the check tool's own answer
(`priorStatus: in_progress`, `newStatus: completed`) as well as the row. The
two-edit scenarios now also assert that the status rewrite landed, and the
contradiction fixtures answer the job-details call with the job still
running, so every answer the fixture gives agrees. The rows came out the same.

### What this corpus can't say

- **It is scripted.** Every edit is one I wrote down, in the order the
  prompt teaches. A real model that flips before checking, or records the
  evidence in the same edit as the flip, or works from a block the poller
  hasn't refreshed yet, isn't in it. The 2026-10-08 list of ways to get
  observed rows still stands.
- **The registry path has no honest completion.** Fixture answers never
  establish an evaluation, so in Tier-1 a registry-held step can never
  become eligible, and every registry row here is a refusal. In real use
  the registry path covers only imported runs until `loom_submit` exists,
  and some of those can't become eligible at all: an import can't reach
  `conformant_by_reconcile` on another machine, and workflows, collections
  and UDTs stay unverified (`docs/registry.md`). Under `deny`, finishing
  such a step honestly needs `/override`. Under `warn` it is a warning.
  That is the registry working as designed, not a false deny on this
  corpus, but it is the case to weigh before `deny` is the default.
- **Gaps 1-3 on the legacy path are false allows**, not false denies, so
  they don't argue against `deny`; they are what `deny` still misses.

### Decision

The default moves to `deny`. On this corpus every deny is a true positive
and both honest completions go through, and the honest sequence they model
is the one Loom's prompt teaches, which is the standard set for the legacy
path. The two things to weigh before merging are the ones above: the rows
are scripted, and on the registry path an imported run that can't be
re-verified (one from another machine, or any workflow) is now refused
until the user runs `/override`, where before it was a warning. Anyone who
wants the old behavior sets `evidenceGate.mode: "warn"` or
`LOOM_EVIDENCE_GATE=warn`.
