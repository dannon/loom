/**
 * The registry's port to Galaxy: how an approved Spec gets submitted and how
 * the template frozen at approval gets fetched.
 *
 * The registry core never talks to Galaxy itself, so it stays free of the
 * harness and of any one client. Inside Loom the adapter is galaxy-ops running
 * in process -- the same operations galaxy-mcp exposes, so the gated path uses
 * the tools we recommend rather than a private copy of how to call Galaxy. A
 * standalone process can supply its own adapter over the same contract.
 *
 * Types only; nothing here runs.
 */

import type { Spec } from "./registry-schema";

/** What the adapter fetched at approval, frozen under `templates/<digest>.json`. */
export interface TemplateSnapshot {
  /** The tool schema, workflow run form, or user-defined tool definition. */
  body: unknown;
  /** The version the server resolved, which becomes `Spec.target.version`. */
  version: string;
}

/**
 * The three things a submission can come back as, and they are not
 * interchangeable. `refused` means Galaxy answered and nothing ran, so the
 * reservation can be released. `unknown` means no answer arrived -- a timeout,
 * a dropped connection -- and the run may exist; the attempt becomes
 * `submission_unknown` and only the user can attribute it.
 */
export type SubmitOutcome =
  | {
      kind: "accepted";
      invocation_id?: string;
      job_ids: string[];
      output_ids: string[];
      /**
       * The version Galaxy reports actually ran, or null if the reply doesn't
       * say. Asking for a version is not proof of getting it: Galaxy's toolbox
       * hands back the newest installed version when the requested one is
       * missing, so the caller compares this against the Spec.
       */
      ran_version: string | null;
      /** sha256 of the canonical request the adapter sent. */
      request_digest: string;
    }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; detail: string };

export interface Submitter {
  /** Fetch the template or definition for a target, at its version when given. */
  fetchTemplate(target: Spec["target"], historyId?: string): Promise<TemplateSnapshot>;
  /**
   * Submit exactly what the Spec says, built against the frozen template. An
   * adapter must not retry a submission on its own: a retry after an
   * `unknown` can run the same thing twice.
   */
  submit(spec: Spec, template: unknown): Promise<SubmitOutcome>;
}
