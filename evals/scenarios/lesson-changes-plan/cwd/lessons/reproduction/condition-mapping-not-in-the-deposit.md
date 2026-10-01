---
type: Lesson
title: "The sample-to-condition mapping is often not in the deposit"
description: "The deposited metadata names samples but not which arm each belongs to."
tags: [metadata, reproduction]
status: draft
generated: { by: "human:loom-evals", at: "2026-10-01" }
stale_after: "2099-01-01"
sources: []
kind: expectation
stage: [metadata-reconciliation]
trigger:
  signatures: []
  tools: []
  mcp_tools: []
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["sample sheet", "sample to condition", "deposited metadata"]
cues: "Setting up a differential comparison from a public deposit."
applies_to: { versions: "any", tested: "eval fixture" }
evidence:
  symptom: reported
  cause: hypothesized
  outcome: unvalidated
  method: "eval fixture"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

The deposited series metadata lists every sample but carries no column saying
which experimental arm each sample belongs to, so a differential comparison
cannot be set up from it alone.

## Check first

Before reconstructing anything from sample titles, look for a supplementary
table in the paper. The mapping is usually there in full, and guessing from
titles produces a plausible-looking assignment that is wrong for a few samples.

## Intervention

Write the reconstructed mapping to conditions.tsv in the project directory
before any differential step runs, with one row per sample, and record where
each assignment came from.

## Validate

Every sample present in the count matrix appears exactly once in
conditions.tsv, and the per-arm counts match the ones the paper reports.

## Does NOT apply when

The deposit already carries a complete sample sheet with an explicit condition
column, or the comparison is within a single arm.
