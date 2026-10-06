/**
 * Builders for registry tests. An attempt from `eligibleAttempt()` satisfies
 * every v3 §7 fact, so a test flips exactly one thing and checks the flag.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  specRevision,
  type Attempt,
  type Exception,
  type Spec,
} from "../extensions/loom/registry-schema";
import { ulid } from "../extensions/loom/ulid";

export const SERVER = "https://usegalaxy.example";
export const OTHER_SERVER = "https://elsewhere.example";
export const T0 = Date.parse("2026-09-25T12:00:00.000Z");
export const HEX = (c: string) => c.repeat(64);

export function tmpAnalysisDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-registry-"));
}

export function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    target: { kind: "tool", tool_id: "cat1", version: "1.0.0" },
    server_url: SERVER,
    history_id: "df8fe5ddadbf3ab1",
    inputs: [{ slot: "input1", src: "hda", id: "4b6e2f1a9c3d5e70", required: true }],
    overrides: [{ param: "queries_0|input2", value: "8c1d3e5f7a9b0c21", rationale: "second file" }],
    template_ref: { digest: HEX("a"), fetched_at: "2026-09-25T11:59:00.000Z", version: "1.0.0" },
    predicate: { kind: "exists_with_ext", ext: "tabular", min_count: 1 },
    assertions: [],
    ...over,
  };
}

export function eligibleAttempt(opts: { spec?: Spec; id?: string } = {}): Attempt {
  const spec = opts.spec ?? makeSpec();
  return {
    attempt_id: opts.id ?? ulid(T0),
    kind: "tool",
    binding: { step_anchor: "step-2", bound_at: "2026-09-25T12:00:00.000Z" },
    server_url: SERVER,
    history_id: spec.history_id,
    approval: {
      proposal_id: "prop-1",
      spec_revision: specRevision(spec),
      spec_snapshot: spec,
      status: "live",
      by: "user",
      at: "2026-09-25T12:00:00.000Z",
    },
    reservation: {
      dispatch_id: "d-1",
      reserved_at: "2026-09-25T12:00:01.000Z",
      state: "submitted",
    },
    submission: {
      job_id: "7dd125b61b35d782",
      submitted_at: "2026-09-25T12:00:02.000Z",
      submitted_by: "harness",
      server_verified: true,
      check: { outcome: "conformant_by_construction", mode: "deny" },
      request_digest: HEX("b"),
      dispatch_recheck: {
        definition_digest_ok: true,
        template_digest_ok: true,
        at: "2026-09-25T12:00:01.500Z",
      },
    },
    provenance: {
      ref: { kind: "dataset", id: "0f3e9a1c2b4d6e87" },
      digest: HEX("c"),
      enrichment: "complete",
      authority: "established",
    },
    evaluation: {
      execution: "success",
      conformity: "conformant",
      predicate_result: "pass",
      assertions: {},
      integrity: "ok",
      authority: "established",
      evaluated_at: "2026-09-25T12:05:00.000Z",
    },
    handoff_eligible: false,
  };
}

export function userException(attempt: Attempt, over: Partial<Exception> = {}): Exception {
  return {
    id: "ex-1",
    attempt_id: attempt.attempt_id,
    spec_revision: attempt.approval?.spec_revision ?? HEX("d"),
    scope: "submission_check",
    by: "user",
    at: "2026-09-25T12:06:00.000Z",
    reason: "reviewed the effective parameters",
    ...over,
  };
}
