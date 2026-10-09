import { describe, expect, it } from "vitest";
import { applyImportRule } from "../extensions/loom/registry-import";
import type { Registry } from "../extensions/loom/registry-schema";
import { ulid } from "../extensions/loom/ulid";
import { eligibleAttempt, OTHER_SERVER, SERVER, T0, userException } from "./registry-fixtures";

function registryOf(...attempts: ReturnType<typeof eligibleAttempt>[]): Registry {
  return {
    version: 3,
    revision: 9,
    writer_token: "theirs",
    session_sig: "whatever",
    analysis_id: "an-1",
    server_url: SERVER,
    attempts: Object.fromEntries(attempts.map((a) => [a.attempt_id, a])),
    exceptions: attempts.map((a, i) => userException(a, { id: `ex-${i}` })),
    supervision: { active_at_shutdown: [] },
  };
}

describe("applyImportRule (v3 §10)", () => {
  it("downgrades approvals, exceptions, checks, identity, provenance and evaluations", () => {
    const a = eligibleAttempt();
    a.handoff_eligible = true;
    const { registry } = applyImportRule(registryOf(a), SERVER);
    const got = registry.attempts[a.attempt_id];
    expect(got.approval).toMatchObject({ status: "restored", by: "restored" });
    expect(got.submission?.check).toEqual({ outcome: "unchecked", mode: "deny" });
    expect(got.submission?.server_verified).toBe(false);
    expect(got.provenance?.authority).toBe("historical");
    expect(got.evaluation?.authority).toBe("historical");
    expect(got.handoff_eligible).toBe(false);
    expect(registry.exceptions.every((x) => x.by === "restored")).toBe(true);
  });

  it("drops a recorded diff along with the check it belonged to", () => {
    const a = eligibleAttempt();
    a.submission!.check = {
      outcome: "mismatch",
      mode: "warn",
      diff: [{ path: "x", approved: 1, observed: 2 }],
    };
    const got = applyImportRule(registryOf(a), SERVER).registry.attempts[a.attempt_id];
    expect(got.submission?.check).toEqual({ outcome: "unchecked", mode: "warn" });
  });

  it("forgets a reconcile check: it has to be made again in the importing session", () => {
    const a = eligibleAttempt();
    a.approval!.status = "restored";
    a.approval!.by = "restored";
    a.submission!.check = { outcome: "conformant_by_reconcile", mode: "deny" };
    const got = applyImportRule(registryOf(a), SERVER).registry.attempts[a.attempt_id];
    expect(got.submission?.check).toEqual({ outcome: "unchecked", mode: "deny" });
    expect(got.handoff_eligible).toBe(false);
  });

  it("keeps a revoked approval revoked", () => {
    const a = eligibleAttempt();
    a.approval!.status = "revoked";
    const got = applyImportRule(registryOf(a), SERVER).registry.attempts[a.attempt_id];
    expect(got.approval).toMatchObject({ status: "revoked", by: "restored" });
  });

  it("quarantines attempts recorded against another server", () => {
    const here = eligibleAttempt({ id: ulid(T0) });
    const there = { ...eligibleAttempt({ id: ulid(T0 + 1) }), server_url: OTHER_SERVER };
    const { registry, quarantined } = applyImportRule(registryOf(here, there), SERVER);
    expect(Object.keys(registry.attempts)).toEqual([here.attempt_id]);
    expect(quarantined).toEqual([there.attempt_id]);
    expect(registry.quarantine?.[there.attempt_id].approval?.status).toBe("restored");
  });

  it("quarantines an attempt whose approved Spec names another server", () => {
    const a = eligibleAttempt();
    a.approval!.spec_snapshot.server_url = OTHER_SERVER;
    const { quarantined } = applyImportRule(registryOf(a), SERVER);
    expect(quarantined).toEqual([a.attempt_id]);
  });

  it("matches servers after normalisation", () => {
    const a = eligibleAttempt();
    const { quarantined } = applyImportRule(registryOf(a), "USEGALAXY.example/");
    expect(quarantined).toEqual([]);
  });

  it("leaves the input untouched", () => {
    const a = eligibleAttempt();
    const input = registryOf(a);
    const before = JSON.stringify(input);
    applyImportRule(input, SERVER);
    expect(JSON.stringify(input)).toBe(before);
  });
});
