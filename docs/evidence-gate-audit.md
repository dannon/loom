# Evidence gate audit

#475 sets the rule for every gate: it ships `off | warn | deny`, and a `deny`
default needs an audit of the recorded `evidence.decision` rows, adjudicated by
hand, saying the gate doesn't fire on honest work. This is that note. The
default stays `warn` until it can say so.

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
