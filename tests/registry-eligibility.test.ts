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

    it("accepts conformant_by_reconcile on a restored approval", () => {
      const a = eligibleAttempt();
      a.approval!.by = "restored";
      a.approval!.status = "restored";
      a.submission!.check.outcome = "conformant_by_reconcile";
      expect(computeHandoffEligible(a)).toBe(true);
    });

    it("rejects conformant_by_reconcile on a revoked approval", () => {
      const a = eligibleAttempt();
      a.approval!.status = "revoked";
      a.submission!.check.outcome = "conformant_by_reconcile";
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("rejects conformant_by_reconcile with no approval to check against", () => {
      const a = eligibleAttempt();
      delete a.approval;
      a.submission!.check.outcome = "conformant_by_reconcile";
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("rejects conformant on an unchecked or mismatched submission", () => {
      for (const outcome of ["unchecked", "mismatch", "unverified"] as const) {
        const a = eligibleAttempt();
        a.submission!.check.outcome = outcome;
        expect(computeHandoffEligible(a)).toBe(false);
      }
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

    it("rejects conformant on a revoked approval, even after it submitted", () => {
      const a = eligibleAttempt();
      a.approval!.status = "revoked";
      expect(a.approval!.by).toBe("user");
      expect(computeHandoffEligible(a)).toBe(false);
    });
  });

  describe("an ungated attempt", () => {
    function ungated() {
      const a = eligibleAttempt();
      delete a.approval;
      a.submission!.submitted_by = "agent";
      a.submission!.check.outcome = "unchecked";
      a.evaluation!.conformity = "excepted";
      a.evaluation!.predicate_result = "attested";
      return a;
    }

    it("needs the user to excuse the submission and attest the result", () => {
      const a = ungated();
      const check = userException(a);
      const attest = userException(a, { id: "ex-2", scope: "manual_attestation" });
      expect(computeHandoffEligible(a, [check, attest])).toBe(true);
    });

    it("isn't eligible on a submission exception alone, whatever the evaluation claims", () => {
      const a = ungated();
      expect(computeHandoffEligible(a, [userException(a)])).toBe(false);
      a.evaluation!.predicate_result = "pass";
      expect(computeHandoffEligible(a, [userException(a)])).toBe(false);
    });

    it("doesn't take an attested result reported as pass", () => {
      const a = ungated();
      a.evaluation!.predicate_result = "pass";
      const check = userException(a);
      const attest = userException(a, { id: "ex-2", scope: "manual_attestation" });
      expect(computeHandoffEligible(a, [check, attest])).toBe(false);
    });

    it("isn't eligible on an attestation alone", () => {
      const a = ungated();
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        false,
      );
    });

    it("isn't eligible with no exceptions", () => {
      const a = ungated();
      a.evaluation!.conformity = "unverified";
      expect(computeHandoffEligible(a)).toBe(false);
    });
  });

  describe("a Spec with a manual predicate", () => {
    const spec = makeSpec({ predicate: { kind: "manual" } });

    it("is not eligible on an evaluation's word that the predicate passed", () => {
      const a = eligibleAttempt({ spec });
      expect(computeHandoffEligible(a)).toBe(false);
    });

    it("is eligible once the user attests the result, recorded as attested", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.predicate_result = "attested";
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        true,
      );
    });

    it("doesn't take an attested result reported as pass", () => {
      const a = eligibleAttempt({ spec });
      expect(a.evaluation!.predicate_result).toBe("pass");
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        false,
      );
    });

    it("rejects a restored attestation, one for another revision, and other scopes", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.predicate_result = "attested";
      const attest = (o: Parameters<typeof userException>[1]) =>
        computeHandoffEligible(a, [userException(a, { scope: "manual_attestation", ...o })]);
      expect(attest({ by: "restored" })).toBe(false);
      expect(attest({ spec_revision: HEX("e") })).toBe(false);
      expect(attest({ scope: "submission_check" })).toBe(false);
      expect(attest({ scope: "evidence_gate" })).toBe(false);
    });

    it("still needs the result to have been marked attested", () => {
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

    it("isn't satisfied by an attestation", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "pass", population: "pass" };
      a.evaluation!.predicate_result = "attested";
      expect(computeHandoffEligible(a, [userException(a, { scope: "manual_attestation" })])).toBe(
        false,
      );
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

    it("counts an excepted assertion only with an evidence-gate exception naming it", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "pass", population: "excepted" };
      const gate = (o: Parameters<typeof userException>[1]) =>
        computeHandoffEligible(a, [
          userException(a, { scope: "evidence_gate", assertion_id: "population", ...o }),
        ]);
      expect(gate({})).toBe(true);
      expect(gate({ assertion_id: undefined })).toBe(false);
      expect(gate({ assertion_id: "build" })).toBe(false);
      expect(gate({ by: "restored" })).toBe(false);
      expect(gate({ spec_revision: HEX("e") })).toBe(false);
      expect(gate({ scope: "submission_check" })).toBe(false);
      expect(gate({ scope: "manual_attestation" })).toBe(false);
    });

    it("needs one exception per excepted assertion", () => {
      const a = eligibleAttempt({ spec });
      a.evaluation!.assertions = { build: "excepted", population: "excepted" };
      const waive = (id: string) =>
        userException(a, { id: `ex-${id}`, scope: "evidence_gate", assertion_id: id });
      expect(computeHandoffEligible(a, [waive("population")])).toBe(false);
      expect(computeHandoffEligible(a, [waive("population"), waive("build")])).toBe(true);
    });

    it("never lets an exception excuse a failed or inconclusive assertion", () => {
      for (const outcome of ["fail", "inconclusive"] as const) {
        const a = eligibleAttempt({ spec });
        a.evaluation!.assertions = { build: "pass", population: outcome };
        const waiver = userException(a, { scope: "evidence_gate", assertion_id: "population" });
        expect(computeHandoffEligible(a, [waiver])).toBe(false);
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
