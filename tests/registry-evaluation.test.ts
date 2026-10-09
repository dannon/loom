import { describe, expect, it } from "vitest";
import { computeHandoffEligible } from "../extensions/loom/registry-eligibility";
import {
  checkConformity,
  effectiveParam,
  evaluateAttempt,
  evaluatePredicate,
  NO_APPROVAL_REVISION,
  sameValue,
  type RunFacts,
} from "../extensions/loom/registry-evaluation";
import type { Attempt } from "../extensions/loom/registry-schema";
import { eligibleAttempt, makeSpec, userException } from "./registry-fixtures";

const JOB = "7dd125b61b35d782";

function facts(over: Partial<RunFacts> = {}): RunFacts {
  return {
    kind: "job",
    run_id: JOB,
    verified: true,
    state: "success",
    history_id: "df8fe5ddadbf3ab1",
    jobs: [
      {
        job_id: JOB,
        tool_id: "cat1",
        tool_version: "1.0.0",
        state: "ok",
        params: {
          queries: JSON.stringify([
            { input2: { values: [{ src: "hda", id: "8c1d3e5f7a9b0c21" }] } },
          ]),
        },
        inputs: [{ name: "input1", id: "4b6e2f1a9c3d5e70", src: "hda" }],
        outputs: [{ name: "out_file1", id: "0f3e9a1c2b4d6e87", ext: "tabular", state: "ok" }],
      },
    ],
    fetched_at: "2026-09-25T12:05:00.000Z",
    source: "galaxy",
    ...over,
  };
}

/** An attempt imported from elsewhere: approval restored, check forgotten. */
function importedAttempt(): Attempt {
  const a = eligibleAttempt();
  a.approval!.status = "restored";
  a.approval!.by = "restored";
  a.submission!.check = { outcome: "unchecked", mode: "deny" };
  a.submission!.server_verified = false;
  a.provenance!.authority = "historical";
  a.evaluation!.authority = "historical";
  return a;
}

const opts = { now: "2026-09-25T12:06:00.000Z", factsRef: ".loom/state/templates/x.json" };

function apply(a: Attempt, f: RunFacts, exceptions = [] as Parameters<typeof evaluateAttempt>[2]) {
  const r = evaluateAttempt(a, f, exceptions, opts);
  const out: Attempt = structuredClone(a);
  out.evaluation = r.evaluation;
  out.provenance = r.provenance;
  out.submission!.check = r.check;
  out.submission!.server_verified = r.server_verified;
  return { result: r, attempt: out, eligible: computeHandoffEligible(out, exceptions) };
}

describe("effectiveParam", () => {
  it("walks a flat repeat path through JSON-encoded values", () => {
    const params = { queries: JSON.stringify([{ input2: "x" }]), plain: '"7"' };
    expect(effectiveParam(params, "queries_0|input2")).toBe("x");
    expect(effectiveParam(params, "plain")).toBe("7");
    expect(effectiveParam(params, "queries_3|input2")).toBeUndefined();
    expect(effectiveParam(params, "nope")).toBeUndefined();
  });
});

describe("sameValue", () => {
  it("reads Galaxy's stringified scalars and dataset parameters", () => {
    expect(sameValue(7, "7")).toBe(true);
    expect(sameValue(true, "true")).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue("abc", { values: [{ src: "hda", id: "abc" }] })).toBe(true);
    expect(sameValue("abc", { src: "hda", id: "abd" })).toBe(false);
    expect(sameValue("abc", undefined)).toBeUndefined();
  });
});

describe("checkConformity", () => {
  it("matches a run that did exactly what was approved", () => {
    expect(checkConformity(makeSpec(), facts())).toEqual({ outcome: "match" });
  });

  it("names every definite difference", () => {
    const f = facts();
    f.jobs[0].tool_version = "1.0.1";
    f.jobs[0].inputs = [{ name: "input1", id: "ffffffffffffffff" }];
    const c = checkConformity(makeSpec(), f);
    expect(c.outcome).toBe("mismatch");
    if (c.outcome === "mismatch") {
      expect(c.diff.map((d) => d.path)).toEqual([
        `jobs.${JOB}.tool_version`,
        `jobs.${JOB}.inputs.input1`,
      ]);
    }
  });

  it("never calls a run it couldn't read a match", () => {
    const cases: Array<(f: RunFacts) => void> = [
      (f) => (f.verified = false),
      (f) => delete f.jobs[0].tool_version,
      (f) => delete f.jobs[0].params,
      (f) => delete f.jobs[0].inputs,
      (f) => (f.jobs[0].unavailable = "404"),
      (f) => (f.jobs = []),
    ];
    for (const breakIt of cases) {
      const f = facts();
      breakIt(f);
      expect(checkConformity(makeSpec(), f).outcome).toBe("unverifiable");
    }
  });

  it("leaves workflows and collection inputs unverifiable", () => {
    const wf = makeSpec({ target: { kind: "workflow", workflow_id: "abc", version: "3" } });
    expect(checkConformity(wf, facts({ kind: "invocation" })).outcome).toBe("unverifiable");
    const hdca = makeSpec({
      inputs: [{ slot: "input1", src: "hdca", id: "4b6e2f1a9c3d5e70", required: true }],
    });
    expect(checkConformity(hdca, facts()).outcome).toBe("unverifiable");
  });

  it("checks every job of a mapped-over run", () => {
    const f = facts();
    f.jobs.push({ ...structuredClone(f.jobs[0]), job_id: "aaaaaaaaaaaaaaaa", tool_id: "cat2" });
    const c = checkConformity(makeSpec(), f);
    expect(c.outcome).toBe("mismatch");
  });
});

describe("evaluatePredicate", () => {
  it("counts only this attempt's ok outputs of the named type", () => {
    expect(evaluatePredicate({ kind: "exists_with_ext", ext: "tabular" }, facts())).toBe("pass");
    expect(evaluatePredicate({ kind: "exists_with_ext", ext: "bam" }, facts())).toBe("fail");
    expect(evaluatePredicate({ kind: "count_eq", ext: "tabular", count: 2 }, facts())).toBe("fail");
    const f = facts();
    f.jobs[0].outputs![0].state = "error";
    expect(evaluatePredicate({ kind: "exists_with_ext", ext: "tabular" }, f)).toBe("fail");
  });

  it("can't evaluate a run that didn't succeed, or outputs it couldn't read", () => {
    expect(
      evaluatePredicate({ kind: "exists_with_ext", ext: "tabular" }, facts({ state: "running" })),
    ).toBe("unevaluable");
    const f = facts();
    delete f.jobs[0].outputs;
    expect(evaluatePredicate({ kind: "exists_with_ext", ext: "tabular" }, f)).toBe("unevaluable");
    expect(evaluatePredicate({ kind: "manual" }, facts())).toBe("unevaluable");
  });
});

describe("evaluateAttempt", () => {
  it("brings an imported attempt back as conformant_by_reconcile, eligible", () => {
    const { result, eligible } = apply(importedAttempt(), facts());
    expect(result.check.outcome).toBe("conformant_by_reconcile");
    expect(result.evaluation).toMatchObject({
      execution: "success",
      conformity: "conformant",
      predicate_result: "pass",
      integrity: "ok",
      authority: "established",
    });
    expect(eligible).toBe(true);
  });

  it("records a mismatch as nonconformant, never eligible", () => {
    const f = facts();
    f.jobs[0].tool_version = "9";
    const { result, eligible } = apply(importedAttempt(), f);
    expect(result.check.outcome).toBe("mismatch");
    expect(result.evaluation.conformity).toBe("nonconformant");
    expect(eligible).toBe(false);
  });

  it("is not eligible on a run that hasn't finished, or failed", () => {
    expect(apply(importedAttempt(), facts({ state: "running" })).eligible).toBe(false);
    const failed = apply(importedAttempt(), facts({ state: "failed" }));
    expect(failed.result.evaluation.execution).toBe("failed");
    expect(failed.eligible).toBe(false);
  });

  it("never establishes anything from fixture answers", () => {
    const { result, eligible } = apply(importedAttempt(), facts({ source: "fixture" }));
    expect(result.evaluation.authority).toBe("historical");
    expect(result.provenance.authority).toBe("historical");
    expect(eligible).toBe(false);
  });

  it("an unverified run stays unverified_identity", () => {
    const { result, eligible } = apply(importedAttempt(), facts({ verified: false }));
    expect(result.evaluation.integrity).toBe("unverified_identity");
    expect(result.server_verified).toBe(false);
    expect(eligible).toBe(false);
  });

  it("keeps a by-construction check and flags an effective contradiction", () => {
    const ok = apply(eligibleAttempt(), facts());
    expect(ok.result.check.outcome).toBe("conformant_by_construction");
    expect(ok.eligible).toBe(true);
    const f = facts();
    f.jobs[0].tool_version = "2.0.0";
    const bad = apply(eligibleAttempt(), f);
    expect(bad.result.evaluation.integrity).toBe("effective_contradiction");
    expect(bad.result.evaluation.conformity).toBe("nonconformant");
    expect(bad.eligible).toBe(false);
  });

  it("a manual predicate counts only once the user attests it", () => {
    const spec = makeSpec({ predicate: { kind: "manual" } });
    const a = eligibleAttempt({ spec });
    expect(apply(a, facts()).result.evaluation.predicate_result).toBe("unevaluable");
    const attest = [userException(a, { scope: "manual_attestation" })];
    const r = apply(a, facts(), attest);
    expect(r.result.evaluation.predicate_result).toBe("attested");
    expect(r.eligible).toBe(true);
  });

  it("an ungated attempt needs both user exceptions", () => {
    const a = eligibleAttempt();
    delete a.approval;
    a.submission!.check = { outcome: "unchecked", mode: "warn" };
    const exceptions = [
      userException(a, {
        id: "x1",
        scope: "submission_check",
        spec_revision: NO_APPROVAL_REVISION,
      }),
      userException(a, {
        id: "x2",
        scope: "manual_attestation",
        spec_revision: NO_APPROVAL_REVISION,
      }),
    ];
    expect(apply(a, facts()).eligible).toBe(false);
    const r = apply(a, facts(), exceptions);
    expect(r.result.evaluation).toMatchObject({
      conformity: "excepted",
      predicate_result: "attested",
    });
    expect(r.eligible).toBe(true);
  });

  it("a restored exception is not the user's", () => {
    const spec = makeSpec({ predicate: { kind: "manual" } });
    const a = eligibleAttempt({ spec });
    const restored = [userException(a, { scope: "manual_attestation", by: "restored" })];
    expect(apply(a, facts(), restored).result.evaluation.predicate_result).toBe("unevaluable");
  });
});
