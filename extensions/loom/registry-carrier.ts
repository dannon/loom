/**
 * The registry's Page carrier (registry design v3 §9): the signed registry
 * document, gzipped and base64'd into one CommonMark link-reference
 * definition, `[loom-registry:v3]: #loom "<base64 gzip>"`. Same trick the
 * typed-block carriers use (`galaxy-markdown-adapter.ts`): it renders to
 * nothing on the Page and survives storage byte for byte.
 *
 * The carrier is unauthenticated on the wire. What it decodes to goes through
 * `RegistryStore.ingestText`, where the session signature decides whether it
 * is this session's own state (a continuation) or an import. Nothing here
 * trusts it.
 *
 * Pi-free, like the rest of the trusted core.
 */

import { gunzipSync, gzipSync } from "zlib";

/**
 * Past this many characters an encoded carrier is neither emitted nor read.
 * Galaxy puts no length limit on page content (`TEXT` column, no
 * `max_length` on the payload), and the proxy in front of a public server
 * allows request bodies far larger, so the bound is ours: every push stores a
 * full page revision, and a registry that big belongs in a history dataset,
 * not in every revision of a Page. Measured on synthetic registries (one full
 * tool approval with submission and evaluation per attempt, about 2 KB of JSON
 * each; the facts themselves stay in `templates/`): 200 attempts encode to
 * 13 KB and 1,000 to 56 KB. Real attempts vary more and compress less, but
 * typical JSON still gzips several-fold, so a few hundred attempts sit well
 * under the cap. Not measured against usegalaxy.eu itself; the round trip at
 * the cap is a unit test.
 */
export const MAX_CARRIER_CHARS = 512 * 1024;

/** The decoded registry may not be larger than the store accepts anyway. */
export const MAX_CARRIER_DECODED_BYTES = 4 * 1024 * 1024;

const PREFIXES = ["loom", "orbit"];
const WRITE_PREFIX = "loom";
const ALT = PREFIXES.join("|");
// Whole line, so carrier-shaped text inside prose is never read as one.
const LINE = new RegExp(`^\\[(?:${ALT})-registry:v3\\]: #(?:${ALT}) "([A-Za-z0-9+/=]*)"[ \\t]*$`);
// Anything that looks like it means to be a registry carrier, valid or not.
const LOOKS_LIKE = new RegExp(`^\\s*\\[(?:${ALT})-registry:v\\d+\\]:`, "i");

export class CarrierTooLargeError extends Error {
  constructor(chars: number) {
    super(`the registry carrier would be ${chars} characters, over the ${MAX_CARRIER_CHARS} cap`);
    this.name = "CarrierTooLargeError";
  }
}

/** Encode a serialised registry as a carrier line. Throws past the cap. */
export function encodeRegistryCarrier(registryText: string): string {
  const b64 = gzipSync(Buffer.from(registryText, "utf-8")).toString("base64");
  const line = `[${WRITE_PREFIX}-registry:v3]: #${WRITE_PREFIX} "${b64}"`;
  if (line.length > MAX_CARRIER_CHARS) throw new CarrierTooLargeError(line.length);
  return line;
}

export type CarrierExtraction =
  | { kind: "none"; body: string }
  | { kind: "found"; body: string; registryText: string }
  | { kind: "rejected"; body: string; reason: string };

/**
 * Take the registry carrier out of pulled Page content. The body always comes
 * back without any carrier-shaped line, so a carrier never lands in the
 * notebook whatever happens to it. More than one carrier, an oversized one, or
 * one that doesn't decode is rejected as a whole.
 */
export function extractRegistryCarrier(content: string): CarrierExtraction {
  const kept: string[] = [];
  const found: string[] = [];
  let malformed = false;
  for (const line of content.split("\n")) {
    if (!LOOKS_LIKE.test(line)) {
      kept.push(line);
      continue;
    }
    const m = line.match(LINE);
    if (!m) malformed = true;
    else found.push(m[1]);
    if (line.length > MAX_CARRIER_CHARS) malformed = true;
  }
  // Push puts the carrier after a blank line at the end; take that with it.
  const removed = kept.length !== content.split("\n").length;
  const body = removed ? kept.join("\n").replace(/\s+$/, "") + "\n" : content;
  if (malformed) return { kind: "rejected", body, reason: "malformed or oversized carrier" };
  if (found.length === 0) return { kind: "none", body };
  if (found.length > 1) return { kind: "rejected", body, reason: `${found.length} carriers` };
  if (found[0].length > MAX_CARRIER_CHARS) {
    return { kind: "rejected", body, reason: "oversized carrier" };
  }
  let registryText: string;
  try {
    const raw = gunzipSync(Buffer.from(found[0], "base64"), {
      maxOutputLength: MAX_CARRIER_DECODED_BYTES,
    });
    registryText = raw.toString("utf-8");
  } catch (err) {
    return { kind: "rejected", body, reason: `carrier doesn't decode: ${(err as Error).message}` };
  }
  return { kind: "found", body, registryText };
}
