/**
 * C1's observation contract. Only `normalizeSignature` lives here for now: the
 * lesson matcher has to normalize a tool result with the exact function the
 * lesson corpus was normalized with, or a stored signature can never match.
 * The observation collector brings the rest of the module (the types,
 * PUBLIC_GALAXY_SERVERS, validateObservation) and this function is expected to
 * arrive byte-identical.
 *
 * Copied verbatim from `lessons/validate.mjs`, which cannot import from here
 * because it runs with nothing from the brain. Change both together.
 */

/** C1 caps a signature at 200 characters. */
export const SIGNATURE_MAX = 200;

/** What a signature normalizes to when nothing usable is left. */
export const UNKNOWN_SIGNATURE = "unknown";

/**
 * The signature normalizer, in the locked order: url, email, path, id, n, then
 * truncate, then the empty fallback.
 *
 * URL before path matters: the other way round, the path rule eats a URL's
 * `//host/a/b` and leaves an `https:` stub behind.
 */
const NORMALIZERS = Object.freeze([
  [/https?:\/\/\S+/g, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // Two separators required, so ordinary prose ("and/or") is not read as a
  // path. A single-segment absolute path like /etc is not identifying.
  [/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g, "<path>"],
  [/[0-9a-fA-F]{16,}/g, "<id>"],
  [/\d{5,}/g, "<n>"],
]);

/**
 * One error or outcome -> one stable, identifier-free signature.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeSignature(text) {
  let s = String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, repl] of NORMALIZERS) s = s.replace(re, repl);
  s = s.slice(0, SIGNATURE_MAX).trim();
  return s || UNKNOWN_SIGNATURE;
}
