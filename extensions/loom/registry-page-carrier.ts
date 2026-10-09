/**
 * The registry riding in the Galaxy Page (registry design v3 §9-§10): emitted
 * on every push, taken out of the body and re-ingested on every pull and
 * resume, and followed by a reconcile.
 *
 * What a pulled carrier is worth is the store's call, not this module's. One
 * whose `session_sig` verifies with this session's key is a continuation, and
 * live approvals survive; anything else is an import -- approvals restored,
 * checks unchecked, evaluations historical, `handoff_eligible` false until
 * reconcile re-verifies -- or, while the session holds its own signed state,
 * ignored. A carrier that can't be read is rejected with one notice.
 */

import * as fs from "fs";
import { appendActivityEvent } from "./activity";
import {
  CarrierTooLargeError,
  encodeRegistryCarrier,
  extractRegistryCarrier,
} from "./registry-carrier";
import { getSessionRegistry } from "./registry-runtime";

export type CarrierSource = "page_pull" | "page_resume";

let skippedOversized = false;

function record(dir: string, kind: string, payload: Record<string, unknown>): void {
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: "harness",
    payload,
  });
}

/**
 * The carrier line to append to a push, or null when there is no registry to
 * carry. The registry file is what the store last signed, byte for byte, so
 * this session's own carrier verifies when it comes back.
 */
export function registryCarrierForPush(): string | null {
  const session = getSessionRegistry();
  if (!session || session.unavailable) return null;
  let text: string;
  try {
    if (!fs.existsSync(session.store.registryPath)) return null;
    text = fs.readFileSync(session.store.registryPath, "utf-8");
  } catch {
    return null;
  }
  try {
    return encodeRegistryCarrier(text);
  } catch (err) {
    if (!(err instanceof CarrierTooLargeError)) throw err;
    if (!skippedOversized) {
      skippedOversized = true;
      record(session.analysisDir, "registry.carrier_skipped", { reason: err.message });
    }
    return null;
  }
}

export interface PulledCarrier {
  /** The Page content without any carrier line. */
  body: string;
  /** What to tell the user, when there's something to say. */
  notice?: string;
}

/** Take the carrier out of pulled Page content and hand it to the store. */
export function ingestPulledCarrier(content: string, source: CarrierSource): PulledCarrier {
  const extracted = extractRegistryCarrier(content);
  const session = getSessionRegistry();
  if (extracted.kind === "none") return { body: extracted.body };
  const dir = session?.analysisDir;
  if (extracted.kind === "rejected") {
    if (dir) record(dir, "registry.carrier_rejected", { source, reason: extracted.reason });
    return {
      body: extracted.body,
      notice: `The approval registry carried in the Page was rejected (${extracted.reason}); this session keeps what it has.`,
    };
  }
  if (!session || session.unavailable) return { body: extracted.body };
  const outcome = session.store.ingestText(extracted.registryText);
  record(session.analysisDir, "registry.carrier_ingested", {
    source,
    outcome: outcome.kind,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
    ...(outcome.kind === "imported" ? { quarantined: outcome.quarantined } : {}),
  });
  const notice =
    outcome.kind === "imported"
      ? "The Page carried an approval registry another session wrote. Its approvals are restored, not live, and its runs count only once reconcile re-checks them against Galaxy."
      : outcome.kind === "rejected"
        ? `The approval registry carried in the Page was rejected (${outcome.reason}).`
        : undefined;
  return { body: extracted.body, ...(notice ? { notice } : {}) };
}

/** Test reset. */
export function resetRegistryPageCarrier(): void {
  skippedOversized = false;
}
