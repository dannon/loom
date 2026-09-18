// A fetch wrapper for requests that carry a credential header.
//
// Node's fetch defaults to `redirect: "follow"`, and undici strips only
// `authorization`, `proxy-authorization` and `cookie` when a redirect crosses
// origins. A custom credential header -- Galaxy's `x-api-key` -- is forwarded
// intact, so a server that answers 3xx pointing at another host receives the
// caller's key while the caller sees an ordinary result. This takes redirects
// manually instead: only an exact same-origin hop is followed, everything else
// throws.
//
// A scheme change counts as an origin change, so http://host -> https://host is
// refused rather than followed. The key already went out in cleartext on the
// first hop; quietly following the upgrade would hide that for good, and what
// the user needs is to change the configured URL -- which the error says.
//
// Errors name the status and the target's ORIGIN. Never the full URL: a
// redirect target's path or query can carry a token, and that would end up in
// logs, notebooks and bug reports.

/** Statuses that carry a Location and mean "go here instead". */
export const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

const REDIRECT_STATUS_SET = new Set(REDIRECT_STATUSES);

/** Request-body headers, dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set([
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
]);

const DEFAULT_MAX_HOPS = 3;

/**
 * A redirect we would not follow, or could not follow safely.
 *
 * `kind` is what went wrong: `cross-origin` (the common one), `unparsable`
 * (a Location we cannot resolve, so we cannot prove where it points) and
 * `too-many-hops` (same-origin redirects that never settle).
 */
export class RedirectRefusedError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: "cross-origin" | "unparsable" | "too-many-hops", status: number,
   *           fromOrigin: string, toOrigin?: string | null }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = "RedirectRefusedError";
    this.kind = detail.kind;
    this.status = detail.status;
    this.fromOrigin = detail.fromOrigin;
    this.toOrigin = detail.toOrigin ?? null;
  }
}

/** Scheme + host + port, or null when the URL will not parse. */
export function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/**
 * True when two URLs share a scheme, host and port. A scheme change is an
 * origin change, so http and https on the same host are NOT the same origin.
 */
export function isSameOrigin(a, b) {
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}

/** Headers minus the request-body ones, in whatever shape they arrived. */
function withoutBodyHeaders(headers) {
  if (!headers) return headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const next = new Headers(headers);
    for (const name of BODY_HEADERS) next.delete(name);
    return next;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => !BODY_HEADERS.has(String(name).toLowerCase()));
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())),
  );
}

/**
 * The init for the next hop, applying the method rewrite fetch itself would:
 * 301/302 turn a POST into a GET, 303 turns anything but GET/HEAD into a GET,
 * and 307/308 preserve both method and body.
 */
function initForNextHop(init, status) {
  const method = String(init.method ?? "GET").toUpperCase();
  const rewrite =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  if (!rewrite) return init;
  const next = { ...init, method: "GET", headers: withoutBodyHeaders(init.headers) };
  delete next.body;
  return next;
}

function locationOf(response) {
  if (!REDIRECT_STATUS_SET.has(response?.status)) return null;
  const get = response.headers?.get;
  if (typeof get !== "function") return null;
  const location = response.headers.get("location");
  return location ? location : null;
}

/**
 * Fetch `url`, following redirects only while they stay on the same origin.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ fetchImpl?: typeof fetch, maxHops?: number, serverLabel?: string,
 *           urlSettingLabel?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchSameOriginOnly(url, init = {}, options = {}) {
  // Resolved per call, not per module load, so a test (or a caller that
  // injects one) can swap the implementation.
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const serverLabel = options.serverLabel ?? "The server";
  const urlSettingLabel = options.urlSettingLabel ?? "the configured URL";
  const startOrigin = originOf(url) ?? String(url);

  let currentUrl = String(url);
  let currentInit = { ...init, redirect: "manual" };

  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(currentUrl, currentInit);
    const location = locationOf(response);
    // Not a redirect, or a 3xx with nothing to follow: the caller's normal
    // status handling owns it from here.
    if (!location) return response;

    const status = response.status;
    let target;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new RedirectRefusedError(
        `${serverLabel} answered HTTP ${status} with a redirect target that could not be read, so the request was refused and no credentials were sent to it.`,
        { kind: "unparsable", status, fromOrigin: startOrigin },
      );
    }

    if (target.origin !== startOrigin) {
      throw new RedirectRefusedError(
        crossOriginMessage(serverLabel, urlSettingLabel, status, startOrigin, target.origin),
        {
          kind: "cross-origin",
          status,
          fromOrigin: startOrigin,
          toOrigin: target.origin,
        },
      );
    }

    if (hop >= maxHops) {
      throw new RedirectRefusedError(
        `${serverLabel} redirected the request more than ${maxHops} times within ${startOrigin} without answering, so the request was given up on.`,
        { kind: "too-many-hops", status, fromOrigin: startOrigin, toOrigin: target.origin },
      );
    }

    currentInit = initForNextHop(currentInit, status);
    currentUrl = target.toString();
  }
}

/**
 * Two different sentences, because the two cases need opposite fixes: a bare
 * scheme change is the user's own URL one edit away from correct, while a
 * different host usually means the URL points at a proxy or a sign-in page.
 */
function crossOriginMessage(serverLabel, urlSettingLabel, status, fromOrigin, toOrigin) {
  const prefix =
    `${serverLabel} redirected the request (HTTP ${status}) to ${toOrigin}, which is a different ` +
    `origin than the configured ${fromOrigin}. The request was refused and no credentials were ` +
    `sent to it.`;
  const sameHost = hostAndPort(fromOrigin) === hostAndPort(toOrigin);
  return sameHost
    ? `${prefix} Set ${urlSettingLabel} to ${toOrigin}.`
    : `${prefix} Check that ${urlSettingLabel} points at the server itself rather than a proxy or a sign-in page.`;
}

function hostAndPort(origin) {
  try {
    const parsed = new URL(origin);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return origin;
  }
}
