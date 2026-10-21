/**
 * Sign-in over HTTP (brief H6): the backend-for-frontend pattern BRC Analytics uses. The host runs the
 * authorization code flow with PKCE against Keycloak and keeps the tokens; the browser only ever holds
 * an HttpOnly session cookie.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

import type { TokenCache } from "../tokens/token-cache";
import type { Oidc } from "./oidc";
import { seal, unseal } from "./seal";
import { createSession, endSession, findSession, type Session } from "./sessions";

export const SESSION_COOKIE = "orbit_session";
const SIGNIN_COOKIE = "orbit_signin";
const SIGNIN_PURPOSE = "orbit sign-in";
const SIGNIN_TTL_S = 600;

export interface AuthContext {
  readonly pool: Pool;
  readonly oidc: Oidc;
  readonly tokens: TokenCache;
  readonly tokenKey: Buffer;
  readonly publicUrl: URL;
  readonly galaxyUrl: URL;
  /** Where an unlinked user signs in to Galaxy once, so Galaxy learns their Keycloak identity. */
  readonly galaxyLinkUrl: URL;
  /** Tests stand in for Galaxy's account check. */
  readonly fetch?: typeof fetch;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function cookie(context: AuthContext, name: string, value: string, attrs: { path: string; maxAge?: number }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${attrs.path}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(context.publicUrl.protocol === "https:" ? ["Secure"] : []),
    ...(attrs.maxAge === undefined ? [] : [`Max-Age=${attrs.maxAge}`]),
  ].join("; ");
}

/** The signed-in user behind a request's session cookie, if any. */
export async function sessionOf(context: AuthContext, req: IncomingMessage): Promise<Session | undefined> {
  const id = readCookie(req, SESSION_COOKIE);
  return id ? findSession(context.pool, id) : undefined;
}

function redirect(res: ServerResponse, location: string, status = 302, cookies: string[] = []): void {
  res.writeHead(status, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end();
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/** Only a path on this host, so a crafted return can't bounce a fresh session somewhere else. */
const safeReturn = (raw: string | null) => (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/");

/** Handle the /auth routes; false for anything else. */
export async function handleAuth(context: AuthContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", context.publicUrl);
  const redirectUri = new URL("/auth/callback", context.publicUrl).href;

  if (req.method === "GET" && url.pathname === "/auth/login") {
    let begun;
    try {
      begun = await context.oidc.begin(redirectUri);
    } catch {
      plain(res, 503, "The sign-in service couldn't be reached. Try again in a minute.");
      return true;
    }
    const pending = JSON.stringify({ state: begun.state, verifier: begun.verifier, back: safeReturn(url.searchParams.get("return")) });
    const box = seal(context.tokenKey, pending, SIGNIN_PURPOSE).toString("base64url");
    redirect(res, begun.url.href, 302, [cookie(context, SIGNIN_COOKIE, box, { path: "/auth", maxAge: SIGNIN_TTL_S })]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const clear = cookie(context, SIGNIN_COOKIE, "", { path: "/auth", maxAge: 0 });
    const box = readCookie(req, SIGNIN_COOKIE);
    const opened = box ? unseal(context.tokenKey, Buffer.from(box, "base64url"), SIGNIN_PURPOSE) : undefined;
    if (!opened) {
      plain(res, 400, "That sign-in link has expired. Start again from Orbit.");
      return true;
    }
    const pending = JSON.parse(opened) as { state: string; verifier: string; back: string };
    let tokens;
    try {
      // Built on the public URL, never the Host header, so the redirect_uri matches what Keycloak has.
      tokens = await context.oidc.finish(new URL(url.pathname + url.search, context.publicUrl), pending);
    } catch {
      res.setHeader("set-cookie", [clear]);
      plain(res, 400, "Sign-in didn't complete. Start again from Orbit.");
      return true;
    }
    const sessionId = await createSession(context.pool, context.tokenKey, tokens);
    const back = (await linkedToGalaxy(context, tokens.sub, tokens.accessToken)) ? pending.back : "/auth/link";
    redirect(res, back, 302, [
      clear,
      cookie(context, SESSION_COOKIE, sessionId, { path: "/" }),
    ]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/link") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(linkPage(context));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    // A cross-site form can't sign the user out.
    if (req.headers.origin !== context.publicUrl.origin) {
      plain(res, 403, "Sign out from Orbit itself.");
      return true;
    }
    const id = readCookie(req, SESSION_COOKIE);
    const ended = id ? await endSession(context.pool, context.tokenKey, context.oidc, id) : undefined;
    if (ended) context.tokens.forget(ended.sub);
    redirect(res, context.oidc.endSessionUrl(new URL("/", context.publicUrl).href).href, 303, [
      cookie(context, SESSION_COOKIE, "", { path: "/", maxAge: 0 }),
    ]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    const session = await sessionOf(context, req);
    if (!session) {
      plain(res, 401, "Not signed in.");
      return true;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ sub: session.sub }));
    return true;
  }

  return false;
}

/**
 * Whether Galaxy knows this Keycloak identity yet. Galaxy maps `sub` to an account through its own
 * OIDC login and refuses a token it can't map, so a user who has never signed in to Galaxy through
 * Keycloak is sent there once. A Galaxy that can't be reached isn't a reason to stop the sign-in:
 * the first Galaxy call reports it.
 */
async function linkedToGalaxy(context: AuthContext, sub: string, accessToken: string): Promise<boolean> {
  const fetchImpl = context.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/users/current", context.galaxyUrl), {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
  } catch {
    return true;
  }
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) return true;
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id === "string") {
    await context.pool.query("UPDATE orbit_users SET galaxy_user_id = $2 WHERE sub = $1", [sub, body.id]);
    return true;
  }
  // Galaxy answers an anonymous caller with an empty user rather than a 401.
  return false;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function linkPage(context: AuthContext): string {
  const galaxy = escape(context.galaxyUrl.host);
  return `<!doctype html><meta charset="utf-8"><title>Link your Galaxy account</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>One more step</h1>
<p>${galaxy} doesn't know your account yet. Sign in to Galaxy once with the same login, then come back to Orbit.</p>
<p><a href="${escape(context.galaxyLinkUrl.href)}">Sign in to ${galaxy}</a></p>
<p><a href="/auth/login">I've done that, back to Orbit</a></p>
</body>`;
}
