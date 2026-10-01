# lesson-changes-plan

Tier 2, every model in the matrix.

## What it grades

The ambient-to-pull loop end to end:

1. the prompt says "reproducing", so the per-turn context carries the
   `reproduction/*` index;
2. the index carries ids and titles only, so the model must call
   `lessons_search` to learn anything actionable (`toolCalls.mustInclude`);
3. the drafted plan carries the lesson's content (`plan.mentionsAllOf`).

A model that drafts a competent RNA-seq plan without reading the lesson fails
step 3, because `conditions.tsv` is a filename this lesson invents and nothing
else would produce it.

## Why these assertions

`mentionsAllOf` rather than `mentionsOneOf`: with one string a model could pass
by accident. No `mentionsNoneOf`: it scans the whole plan text, so a compliant
plan that writes "don't guess from sample titles" would fail for quoting the
advice it is following -- the same trap documented in
`standing-instructions-tool-preference`.

## Known weakness

Step 2 can pass for the wrong reason if a model calls `lessons_search`
speculatively on every turn. Step 3 is the one that carries the grade. The
model-free half -- that this prompt fires the index and that searching the id
returns a body with both strings in it -- is pinned by
`tests/lessons-tier2-fixtures.test.ts`.
