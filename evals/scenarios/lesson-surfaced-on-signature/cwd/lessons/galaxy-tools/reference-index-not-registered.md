---
type: Lesson
title: A tool reports no reference index for a build the server does list
description: The build is offered in the dropdown but no index of that kind is registered.
tags: [reference, index]
status: draft
generated: { by: "human:loom-evals", at: "2026-10-01" }
stale_after: "2099-01-01"
sources: []
kind: pitfall
stage: [tool-parameterization]
trigger:
  signatures: ["no reference index registered for build"]
  tools: []
  mcp_tools: []
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["reference index", "built-in index"]
cues: "A tool that reads a built-in index refuses a build the genome dropdown offers."
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

The tool fails immediately saying no reference index is registered for the
build that was selected, even though that build is offered in the genome
dropdown.

## Cause

The dropdown lists builds the server knows about. Index tables are per tool
family, so a build can be listed and still have no index of the kind this
particular tool needs.

## Check first

List the index entries the tool itself reads, not the genome list. If the build
is absent from that table, no parameter change on this tool will fix it.

## Intervention

Switch the input to a history reference and supply the FASTA yourself, or pick
a build that the tool's own index table lists.

## Validate

Confirm the run used the reference you intended by reading the parameters
recorded on the finished job, not only that the job turned green. A wrong
reference also runs to completion.

## Does NOT apply when

The message names a missing input dataset rather than a missing index, or the
build was never offered in the dropdown at all.
