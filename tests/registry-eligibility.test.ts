import { describe, expect, it } from "vitest";
import { computeHandoffEligible } from "../extensions/loom/registry-eligibility";
import { specRevision, type Attempt } from "../extensions/loom/registry-schema";
import { eligibleAttempt, HEX, makeSpec, userException } from "./registry-fixtures";

describe("computeHandoffEligible (v3 §7)", () => {
  it("is true when every fact holds", () => {
    expect(computeHandoffEligible(eligibleAttempt())).toBe(true);
  });

  const flips: Array<[string, (a: Attempt) => void]> = [
    ["execution failed", (a) => (a.evaluation!.execution = "failed")],
    ["execution unknown", (a) => (a.evaluation!.execution = "unknown")],
    ["conformity nonconformant", (a) => (a.evaluation!.conformity = "nonconformant")],
    ["conformity unverified", (a) => (a.evaluation!.conformity = "unverified")],
    ["predicate fail", (a) => (a.evaluation!.predicate_result = "fail")],
    ["predicate unevaluable", (a) => (a.evaluation!.predicate_result = "unevaluable")],
    ["integrity unverified_identity", (a) => (a.evaluation!.integrity = "unverified_identity")],
    ["integrity render_contradiction", (a) => (a.evaluation!.integrity = "render_contradiction")],
    [
      "integrity effective_contradiction",
      (a) => (a.evaluation!.integrity = "effective_contradiction"),
    ],
    ["evaluation historical", (a) => (a.evaluation!.authority = "historical")],
    ["provenance historical", (a) => (a.provenance!.authority = "historical")],
    ["no evaluation", (a) => delete a.evaluation],
    ["no provenance", (a) => delete a.provenance],
  ];
  for (const [name, flip] of flips) {
    it(`is false with ${name}`, () => {
      const a = eligibleAttempt();
      flip(a);
      expect(computeHandoffEligible(a)).toBe(false);
    });
  }

  describe("cross-checks that fail closed", () => {
    it("rejects integrity ok on a run Galaxy never confirmed", () => {
      const a = eligibleAttempt();
      a.submission!.server_verified = false;
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("rejects conformant without a by-construction submission", () => {
      const a = eligibleAttempt();
      a.submission!.check.outcome = "unchecked";
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("rejects conformant on a restored approval", () => {
      const a = eligibleAttempt();
      a.approval!.by = "restored";
      a.approval!.status = "restored";
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("rejects excepted with no exception behind it", () => {
      const a = eligibleAttempt();
      a.evaluation!.conformity = "excepted";
      expect(computeHandoffEligible(a, [])).toBe(false);
    });

    it("accepts excepted with a user exception for this revision", () => {
      const a = eligibleAttempt();
      a.evaluation!.conformity = "excepted";
      expect(computeHandoffEligible(a, [userException(a)])).toBe(true);
    });

    it("rejects a restored exception, one for another revision, and other scopes", () => {
      const a = eligibleAttempt();
      a.evaluation!.conformity = "excepted";
      expect(computeHandoffEligible(a, [userException(a, { by: "restored" })])).toBe(false);
      expect(computeHandoffEligible(a, [userException(a, { spec_revision: HEX("e") })])).toBe(
        false,
      );
      expect(computeHandoffEligible(a, [userException(a, { scope: "evidence_gate" })])).toBe(false);
      // Attesting a result doesn't excuse how it was submitted.
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        false,
      );
    });

    it("lets a user exception make an ungated attempt eligible, and nothing else", () => {
      const a = eligibleAttempt();
      delete a.approval;
      a.submission!.submitted_by = "agent";
      a.submission!.check.outcome = "unchecked";
      a.evaluation!.conformity = "unverified";
      expect(computeHandoffEligible(a)).toBe(false);
      a.evaluation!.conformity = "excepted";
      expect(computeHandoffEligible(a)).toBe(false);
      expect(computeHandoffEligible(a, [userException(a)])).toBe(true);
    });
  });

  describe("a Spec with a manual predicate", () => {
    const spec = makeSpec({ predicate: { kind: "manual" } });

    it("is not eligible on an evaluation's word that the predicate passed", () => {
      const a = eligibleAttempt({ spec });
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("is eligible once the user attests the result", () => {
      const a = eligibleAttempt({ spec });
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        true,
      );
    });

    it("rejects a restored attestation, one for another revision, and other scopes", () => {
      const a = eligibleAttempt({ spec });
      const attest = (o: Parameters<typeof userException>[1]) =>
        computeHandoffEligible(a, [userException(a, { scope: "manual_attestation", ...o })]);
      expect(attest({ by: "restored" })).toBe(false);
      expect(attest({ spec_revision: HEX("e") })).toBe(false);
      expect(attest({ scope: "submission_check" })).toBe(false);
      expect(attest({ scope: "evidence_gate" })).toBe(false);
    });

    it("still needs the predicate to have been marked passed", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.predicate_result = "unevaluable";
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        false,
      );
    });
  });

  describe("a Spec with an assertions_pass predicate", () => {
    const spec = makeSpec({
      predicate: { kind: "assertions_pass", ids: ["build", "population"] },
      assertions: [
        { id: "build", definition_digest: HEX("1"), definition: { dbkey: "hg38" } },
        { id: "population", definition_digest: HEX("2"), definition: { min_rows: 7000 } },
      ],
    });

    it("is eligible only when every named assertion passed", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "pass", population: "pass" };
      expect(computeHandoffEligible(a)).toBe(true);
    });

    for (const outcome of ["fail", "inconclusive", "excepted"] as const) {
      it(`is false when one assertion is ${outcome}`, () => {
        const a = eligibleAttempt({ spec });
        a.evaluation!.assertions = { build: "pass", population: outcome };
        expect(computeHandoffEligible(a)).toBe(false);
      });
    }

    it("counts an excepted assertion only with the user's evidence-gate exception", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "pass", population: "excepted" };
      const gate = (o: Parameters<typeof userException>[1]) =>
        computeHandoffEligible(a, [userException(a, { scope: "evidence_gate", ...o })]);
      expect(gate({})).toBe(true);
      expect(gate({ by: "restored" })).toBe(false);
      expect(gate({ spec_revision: HEX("e") })).toBe(false);
      expect(gate({ scope: "submission_check" })).toBe(false);
      expect(gate({ scope: "manual_attestation" })).toBe(false);
    });

    it("never lets an exception excuse a failed or inconclusive assertion", () => {
      for (const outcome of ["fail", "inconclusive"] as const) {
        const a = eligibleAttempt({ spec });
        a.evaluation!.assertions = { build: "pass", population: outcome };
        expect(computeHandoffEligible(a, [userException(a, { scope: "evidence_gate" })])).toBe(
          false,
        );
      }
    });

    it("is false when an assertion never ran", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "pass" };
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("hashes the frozen assertions into the revision", () => {
      const other = makeSpec({ ...spec, assertions: [spec.assertions[0]] });
      expect(specRevision(other)).not.toBe(specRevision(spec));
    });
  });
});
