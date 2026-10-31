/**
 * The one spelling of a user-supplied Galaxy server URL.
 *
 * Every Galaxy client Orbit uses (galaxy-ops, the brain's own requests, the
 * desktop's current-user check) appends `/api/...` to the server root, so a
 * URL that already ends in `/api` -- what the Galaxy API docs show, and what
 * people paste -- turned every call into a `/api/api/...` 404 with nothing
 * pointing at the setting. Users also type a bare host (#264, #297).
 *
 * So: trim, default a scheme-less URL to https://, drop trailing slashes and
 * one trailing `/api` path segment. A subpath deployment
 * (`https://example.org/galaxy/api`) keeps its prefix. Explicit schemes,
 * including http:// for loopback, are kept as typed; whether they are safe to
 * send a key to is the validators' call, not this one's.
 */

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
// Only a path segment: `https://api` is a host called "api", not an API root.
const API_ROOT = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(?:\/.*)?)\/api$/;

/**
 * @param {string} url
 * @returns {string}
 */
export function normalizeGalaxyUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  const bare = withScheme.replace(/\/+$/, "");
  const apiRoot = API_ROOT.exec(bare);
  return apiRoot ? apiRoot[1].replace(/\/+$/, "") : bare;
}
