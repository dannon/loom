# Approval and attempt registry

Engineer-facing design reference for the registry behind #476. The code lives in
`extensions/loom/registry*.ts`; where this document and the code disagree, the code is
right and this document is stale.

## Why it exists

"Plan, approve, execute" is prompt guidance today. Nothing in the harness sees the model
decide to submit, and the notebook records whatever the model writes. The registry turns
approval into a runtime property: the model proposes, the user approves a frozen
specification, and the harness submits exactly that specification itself. What ran equals
what was approved by construction, rather than by a comparison after the fact.

It records three facts per attempt, each established by the harness rather than asserted by
the model:

- the specification the user approved in this session,
- the run Galaxy reports for it, and
- whether the attempt is eligible to hand off, derived from Galaxy's state, this attempt's
  own outputs, and acceptance conditions frozen at approval.

Scientific correctness is not one of them. That is what the assertions are for.

## What it does not promise

- **Reconcile establishes execution facts, not consent.** Consent is trustworthy because the
  registry is not writable by the model in the guaranteed profile and because consent is
  session-scoped: a session vouches only for approvals it recorded itself.
- **The desktop guarantee is scoped.** A trusted model in a trusted workspace can run shell
  commands, and a script can write any file. On the desktop the registry is protected
  against the file tools, shell redirects and allowlisted MCP tools; raw galaxy-mcp
  submissions stay reachable there and are recorded as unchecked, never trusted.
- **Two residuals no design closes.** A user-defined tool's definition can change on the
  server between the harness's last check and Galaxy's own fetch at submission; and a
  response lost after Galaxy accepted a submission cannot be made exactly-once. Both are
  surfaced as explicit uncertainty, never as silent conformity.

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
  && predicate_result == pass
  && integrity == ok
  && evaluation.authority == established
  && provenance.authority == established
```

`computeHandoffEligible` implements that formula and then cross-checks it against the facts
the evaluation should have been derived from, so an evaluation claiming more than the attempt
supports fails closed:

- `integrity: ok` needs a submission Galaxy has confirmed;
- `conformant` needs a by-construction submission from a user approval;
- `excepted` needs a user-recorded exception for this attempt and, when there is an
  approval, its revision;
- a `manual` predicate never passes;
- `assertions_pass` needs every named assertion to have passed.

None of these can make an attempt eligible that the formula alone would not.

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

| Piece                                                                                     | State                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Schema, parser, canonical JSON, migrations hook                                           | built (#548)                             |
| Signed atomic store, own/stale/import load, templates store                               | built (#548)                             |
| Writer lock with fencing                                                                  | built (#548)                             |
| Import rule, server quarantine                                                            | built (#548)                             |
| `computeHandoffEligible`                                                                  | built (#548)                             |
| `Submitter` port                                                                          | built (#548); galaxy-ops adapter not yet |
| `loom_propose`, `loom-proposal` block, `/approve`, `/revoke`, `/pending`, proposal card   | next                                     |
| `loom_submit`, reservation, `submission_unknown`, `/attribute`, ungated auto-registration | after that                               |
| `trustedRecord` allowlist, desktop floors, evaluation writer, evidence gate, Page carrier | last                                     |

## Open questions

- Under the formula, a Spec with a `manual` predicate can never be eligible: attestation makes
  conformity `excepted` but never makes the predicate pass. Intended, with manual steps
  handing off through an evidence-gate exception instead -- or should attestation satisfy it?
- The import rule sets checks to `unchecked`, and only a by-construction check can be
  `conformant`, so an attempt from an earlier session can become eligible again only through
  a user exception, not through reconcile alone. Intended?
- In an `assertions_pass` predicate, does an `excepted` assertion count as passed? Today it
  does not.
