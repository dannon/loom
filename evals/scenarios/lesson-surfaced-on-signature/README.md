# lesson-surfaced-on-signature

Tier 1, no model.

## What it pins

- `trigger.signatures` matching after C1 normalization of the result text (the
  fixture's error string has different capitalization and extra words around
  the signature).
- The C5 activity row: `kind: "lesson.surfaced"`, `source: "lesson-hint"`, and
  a payload of `{lessonId, trigger, surface}`.
- That the user-local tier loads, validates and reaches the hint path.
- That the replay seam writes its provenance row before anything else, so a
  replayed log is distinguishable from a real one.
- That no model ran (`events.mustNotInclude: agent_start`).

The replay file holds the same result twice. Exactly one `lesson.surfaced` row
is the once-per-session arming; the activity assertions here can only say "at
least one", so the count is pinned by `tests/lessons-replay.test.ts` against
this same fixture.

## What it does not pin

Whether the model does anything with the hint -- that needs a model and lives in
`lesson-changes-plan`. And whether hint text reaches the provider after
redaction, which `tests/lesson-hint.test.ts` checks by chaining both handlers.

## Rerunning it

```bash
npm run evals -- lesson-surfaced-on-signature
```
