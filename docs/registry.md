# Approval and attempt registry

Engineer-facing design reference for the registry behind #476. The code lives in
`extensions/loom/registry*.ts` (the trusted core) and `proposal-commands.ts` (the tool and
commands that drive it); where this document and the code disagree, the code is right and
this document is stale. Proposing and approving are wired in; submitting through the
approval is not yet, so parts of what follows describe where it is going. The status table
at the end says which parts are built.

## Why it exists

"Plan, approve, execute" is prompt guidance today. Nothing in the harness sees the model
decide to submit, and the notebook records whatever the model writes. Once wired in, the
registry makes approval a runtime property: the model proposes, the user approves a frozen
specification, and the harness submits exactly that specification itself. What ran will
equal what was approved by construction, rather than by a comparison after the fact.

It records three facts per attempt, which the harness will establish rather than take from
the model:

- the specification the user approved in this session,
- the run Galaxy reports for it, and
- whether the attempt is eligible to hand off, derived from Galaxy's state, this attempt's
  own outputs, and acceptance conditions frozen at approval.

Scientific correctness is not one of them. The assertions are recorded checks the user
chose; they say whether those checks held, not whether the science is right.

## What it does not promise

- **Reconcile establishes execution facts, not consent.** Consent is session-scoped -- a
  session vouches only for approvals it recorded itself, which the session signature below
  already enforces. It will also depend on the registry not being writable by the model in
  the guaranteed profile; that is the `trustedRecord` floor, not built yet.
- **The desktop guarantee will be scoped.** A trusted model in a trusted workspace can run
  shell commands, and a script can write any file. The plan is for the desktop floors to
  protect the registry against the file tools, shell redirects and allowlisted MCP tools,
  with raw galaxy-mcp submissions still reachable and recorded as unchecked, never trusted.
  None of that exists yet (see the status table).
- **One residual no design closes.** A response lost after Galaxy accepted a submission
  cannot be made exactly-once; the attempt becomes `submission_unknown` and only the user
  can attribute it. (A user-defined tool can't change under the harness: Galaxy has no
  route to update one, and every create mints a new UUID, so the UUID pins the definition.
  `loom_submit` will still re-check the frozen `definition_digest` at dispatch, in case that
  ever changes.)

## Files

Everything lives under `<analysis>/.loom/state/`:

- `registry.json` -- one JSON document, written atomically (temp file plus rename).
- `lock` -- `{pid, session_id, writer_token, heartbeat}`.
- `templates/<sha256>.json` -- the tool schema, workflow run form or user-defined tool
  definition frozen at approval. Content-addressed and write-once: the file's bytes are the
  canonical JSON whose sha256 is its name, and a mismatch on read is treated as missing.

## Schema

`extensions/loom/registry-schema.ts` holds the types (`Registry`, `Attempt`, `Spec`,
`Exception`, `Predicate`) and is the reference. In outline:

- A **Registry** has a `version` (3), a monotonic `revision`, the `writer_token` of the lock
  it was written under, a `session_sig`, the `server_url`, `attempts` keyed by attempt id,
  `exceptions`, supervision state, and a `quarantine` map for imported attempts recorded
  against another server.
- An **Attempt** carries its kind, an immutable binding to a notebook step, and optional
  `approval`, `reservation`, `submission`, `provenance` and `evaluation` records, plus the
  derived `handoff_eligible`. Attempt ids are ULIDs, the same ids capture already writes as
  `attempt_id`, so an ungated capture and a registry attempt can share one.
- A **Spec** is what the user approved: the target (workflow, tool or user-defined tool) at a
  resolved version, the server, a concrete history, inputs by dataset id, parameter overrides
  with a rationale each, a reference to the frozen template, a predicate, and the frozen
  definitions of any assertions it names. `spec_revision` is the sha256 of the canonical Spec.

Canonical JSON means keys sorted at every level and undefined members dropped; anything
JSON cannot represent faithfully is refused rather than coerced. Everything the registry
hashes or signs goes through it.

The parser is the only way a document becomes a `Registry`. It rebuilds each object field by
field, so unknown keys never survive to be re-signed as this session's own; it rejects
duplicate JSON keys (which `JSON.parse` would silently collapse), unpinned specs, an
`assertions_pass` predicate with no ids or naming an assertion that isn't frozen, an approval
whose `spec_revision` does not hash its own snapshot, `__proto__` as an assertion id, and a
`revision` above 2^48 (one near `Number.MAX_SAFE_INTEGER` would leave a registry no write
could ever advance). It never reads `handoff_eligible` from input.

## Who writes what

| Field                                     | Written by                        | When                                                                |
| ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| proposal block                            | the model, through `loom_propose` | validated against the template on write                             |
| `approval`                                | harness                           | `/approve` or the Approve button; template frozen, version resolved |
| `approval.status: revoked`                | harness                           | the proposal edited after approval, or `/revoke`                    |
| `reservation`, `submission`               | harness                           | `loom_submit`; auto-registration for ungated runs                   |
| `provenance`                              | harness                           | enrichment                                                          |
| `evaluation`, `handoff_eligible`          | harness                           | terminal transition, reconcile, assertions                          |
| `exceptions`                              | harness                           | `/override`, `/attest`, `/attribute` -- user-originated only        |
| `revision`, `writer_token`, `session_sig` | harness                           | every write                                                         |

Only the first row is the model's, and it is validated before it lands.

## Session signature and the import rule

When a store is constructed it generates a random key and holds it only in memory -- never on
disk, never in a Page, never reachable by a tool. Every write carries
`session_sig = HMAC-SHA256(key, canonical registry without session_sig)`.

On load:

- A document whose signature verifies with this store's key is **this session's own state**,
  and its live approvals survive -- a reload, or a Page pull that re-ingests what this session
  wrote, is a continuation.
- An own document with a lower `revision` than the one already held is a **stale replay** and
  is ignored. A rejected or imported document never resets the revision, so a replay stays
  stale afterwards.
- Anything else is an **import**: a file from an earlier session or a clean clone, a carrier
  another session wrote, a hand-made file. The import rule applies uniformly:
  - every approval becomes `restored` (a `revoked` one stays revoked) and every exception
    `by: restored`, so neither counts;
  - every submission check becomes `unchecked`, and Galaxy's confirmation of the run is
    forgotten until reconcile asks again;
  - provenance and evaluation authority become `historical`;
  - attempts recorded against another server, or whose approved Spec names one, move to
    `quarantine`;
  - `handoff_eligible` is recomputed, and is false.
- Malformed, duplicate-key, oversized (over 4 MiB) or newer-version input is rejected: the
  session starts from an empty registry with a notice, and the rejected file is moved aside
  rather than overwritten.

Two guards keep a foreign document from wiping a session's live state: while a writer holds
its own signed state, a foreign document is ignored rather than imported (how a foreign Page
carrier merges into live state is a later decision), and a damaged file is set aside while
the session keeps what it holds.

A digest that arrives with the content it digests authenticates nothing; only the session
key does.

## Locking and fencing

The first session to open the analysis creates the lock exclusively and becomes the writer; a
second live session opens read-only. A lock whose heartbeat is more than 120 seconds old is
taken over with a fresh token (then re-read, in case two sessions took it over at once).
Every write re-reads the lock first, so a writer whose lock was taken over finds someone
else's token, drops to read-only, reloads the new writer's state -- as an import, since it
isn't signed with this session's key -- and the write fails without touching the file.

A filesystem gives no compare-and-swap, so the check and the rename after it are two steps.
That window is one synchronous rename against a two-minute staleness limit.

## Handoff eligibility

```
handoff_eligible =
     execution == success
  && (conformity == conformant || conformity == excepted)
  && (predicate_result == pass || predicate_result == attested)
  && integrity == ok
  && evaluation.authority == established
  && provenance.authority == established
```

`computeHandoffEligible` implements that formula and then cross-checks it against the facts
the evaluation should have been derived from, so an evaluation claiming more than the attempt
supports fails closed:

- `integrity: ok` needs a submission Galaxy has confirmed;
- `conformant` needs a by-construction submission from a user approval;
- `conformant` also needs the approval to still be `live`: revoking it withdraws
  eligibility, even for a run it already submitted;
- `excepted` conformity needs a user `submission_check` exception;
- an ungated attempt (no approval, so no frozen predicate to check the evaluation against)
  needs its result `attested` with a user `manual_attestation` exception, so excusing how it
  was submitted never excuses what came out;
- a `manual` predicate needs the result `attested` with a user `manual_attestation`
  exception -- an attested result reported as `pass` is refused;
- `attested` satisfies only those two; every other predicate needs `pass`;
- `assertions_pass` needs every named assertion to have passed, or to be `excepted` with a
  user `evidence_gate` exception naming that assertion (`assertion_id`) -- one exception per
  waived assertion. A `fail` or `inconclusive` assertion is never excused.

Every exception has to be the user's (`by: user`, never `restored`), for this attempt, and,
when there is an approval, for its revision. Each check has one scope that can relax it, so
attesting a result doesn't also excuse how it was submitted. None of these can make an
attempt eligible that the formula alone would not.

## Proposing and approving

Each session opens its registry at session start (`registry-runtime.ts`, called from the
session lifecycle) and holds the writer lock on a 30-second heartbeat. A registry that
can't be opened or locked comes up read-only with one notice and never blocks the session;
`/approve` and `/revoke` then refuse.

- **`loom_propose`** is the model's one write. It takes the step, the target (tool id,
  workflow id or user-defined tool uuid, optionally a version) and the exact inputs and
  parameter overrides, each override with a rationale. It fetches the template, names a
  workflow slot by its step index, and validates: every input names a dataset slot the
  template has with a `src` that slot takes, every required slot outside a conditional or
  repeat is filled, every override names a real parameter (Galaxy's flat `a|b` form, repeat
  indices allowed), and a pinned version is the one Galaxy has. Problems come back as a list
  and nothing is written. Otherwise it appends a `loom-proposal` block and records
  `proposal.created`. Assertion ids are refused until assertions exist.
- **`/approve <proposal-id>`** is the consent. It re-fetches the template and re-validates
  (a hand-written block is held to the same rules), shows the table it is about to freeze
  in a confirm dialog when there is a UI, re-reads the block and refuses if it moved, then
  freezes the template under `templates/`, resolves the version, builds and hashes the Spec,
  and records a live user approval on a fresh attempt, logging `proposal.approved`. Pi runs
  slash commands only for typed input -- extension-sent messages don't expand them -- so the
  model has no path to it.
- **Revoke on edit** is "the hash no longer matches", literally: on every notebook change
  and before each command, the Spec is rebuilt from the block as it reads now against what
  was frozen, and a different `spec_revision` revokes the approval (`proposal.revoked`). A
  removed, duplicated or unreadable block revokes too; a label edit doesn't, since the label
  isn't part of what runs. `/revoke` does the same on request.
- **`/pending`** lists proposals without a live approval and why: never approved, revoked,
  restored from an earlier session, or unreadable.

The block may carry a `spec_revision` line the harness echoes after approval. The parser
never returns it; whether a proposal is approved is the registry's call. Until
`loom_submit` exists the model submits with the ordinary tools, and the record tools'
`proposalId` only logs a `proposal.bound` row marked as the agent's claim -- it writes
nothing to the registry or to the block's harness fields.

What `/approve` freezes is Galaxy's own description, through galaxy-ops: a tool's
`io_details` (`getToolDetails`), a workflow's details plus its run-form slots
(`getWorkflowDetails`, `resolveWorkflowSlots`), or a user-defined tool's record found by
uuid (`listUserTools`). galaxy-ops can't yet template an older workflow version, describe a
tool at a version other than the one its id names, or fetch one user-defined tool by uuid;
those requests are refused rather than guessed at.

## Submitting through galaxy-ops

The registry does not talk to Galaxy. It defines a `Submitter` port
(`extensions/loom/registry-submitter.ts`): fetch a target's template at a version, and submit
a Spec, reporting one of three outcomes -- accepted (with the run ids and the version Galaxy
reports actually ran), refused (Galaxy answered and nothing ran, so the reservation is
released), or no answer (the run may exist; the attempt becomes `submission_unknown` and only
the user can attribute it). An adapter never retries a submission on its own.

Inside Loom the adapter will be `@galaxyproject/galaxy-ops` in process -- the same operations
galaxy-mcp exposes -- so the gated path uses the tools Loom recommends rather than a private
copy of the Galaxy API calls. Asking Galaxy for a version is not proof of getting it (the
toolbox hands back the newest installed version when the requested one is missing), which is
why the accepted outcome carries the version that ran.

## No harness coupling

`registry.ts` and everything it imports use Node builtins and each other, and nothing else:
no pi, no extension entry point, no session state. The analysis directory, clock and
filesystem come in through the constructor, so the same code can run in a standalone MCP
process or Galaxy's own operations layer. `tests/registry-no-pi-imports.test.ts` walks the
real import graph to hold that line.

## Status

| Piece                                                                                     | State                                                                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Schema, parser, canonical JSON, migrations hook                                           | built (#548)                                                            |
| Signed atomic store, own/stale/import load, templates store                               | built (#548)                                                            |
| Writer lock with fencing                                                                  | built (#548)                                                            |
| Import rule, server quarantine                                                            | built (#548)                                                            |
| `computeHandoffEligible`                                                                  | built (#548, rules settled in #558)                                     |
| `Submitter` port                                                                          | built (#548); galaxy-ops adapter not yet                                |
| `loom_propose`, `loom-proposal` block, `/approve`, `/revoke`, `/pending`                  | built; Orbit proposal card not yet                                      |
| `loom_submit`, reservation, `submission_unknown`, `/attribute`, ungated auto-registration | next                                                                    |
| `trustedRecord` allowlist, desktop floors, evaluation writer, evidence gate, Page carrier | last                                                                    |
| `conformant_by_reconcile` for imported attempts                                           | waits on capture keeping effective params and input ids, and enrichment |

## Decisions

One principle covers these: when a person (or, later, Galaxy) vouches for something the code
can't check, it can count toward `handoff_eligible`, but always under its own label --
`attested`, `excepted`, and eventually `conformant_by_reconcile` -- never as `pass` or
`conformant_by_construction`, so a record never reads as checked when it was vouched for.

- **Manual predicates count once attested.** A manual predicate is the user's judgment, so
  their `manual_attestation` exception satisfies it, recorded as `predicate_result: attested`
  rather than `pass`. Until the assertions exist nearly every step is manual, so refusing
  them would make the deny mode block almost everything.
- **Imported attempts come back through re-verification, under its own label.** Consent is
  session-scoped, so an imported attempt can't regain `conformant_by_construction`. Once
  capture keeps the effective parameters and input dataset ids and enrichment exists,
  re-checking the run against Galaxy will restore conformity as `conformant_by_reconcile`.
  Until then the only way back is a user `submission_check` exception.
- **An excepted assertion counts with an evidence-gate exception naming it.** Accepting a
  failed check is allowed but has to be on the record as the user's call, one assertion at a
  time. The assertion stays `excepted`, not `pass`, so the notebook shows what was waived.
- **Revoking withdraws eligibility.** A revoked approval no longer makes a run conformant,
  even one it already submitted. Handing that run off takes a fresh user exception.
- **Ungated attempts need an attestation as well.** Without an approval there is no frozen
  predicate to hold the evaluation to, so the user attests the result (`attested`) as well
  as excusing the submission.
