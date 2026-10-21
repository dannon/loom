/**
 * The Keycloak client (brief H6), over openid-client: authorization code with PKCE, refresh with
 * rotation, revocation and the end-session redirect. Failures come out in two kinds the host acts on:
 * `auth` (the session is over; sign in again) and `outage` (Keycloak can't be reached or misbehaved;
 * wait).
 */
import * as client from "openid-client";

import { TokenUnavailable } from "../worker/galaxy-fetch";

export interface OidcSettings {
  readonly issuer: URL;
  readonly clientId: string;
  /** Absent for a public client (the localhost dev client). */
  readonly clientSecret: string | undefined;
  /** Tests run a plain-http stand-in for Keycloak. */
  readonly allowHttp?: boolean;
}

export interface TokenSet {
  readonly sub: string;
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
  /** Epoch milliseconds; when Keycloak will stop accepting the refresh token. */
  readonly refreshExpiresAt: number;
  readonly idToken: string | undefined;
}

export interface Oidc {
  /** Where to send the browser, and what to keep until it comes back. */
  begin(redirectUri: string): Promise<{ url: URL; state: string; verifier: string }>;
  /** Trade the code the browser came back with for tokens. Throws on a mismatched state. */
  finish(callbackUrl: URL, expected: { state: string; verifier: string }): Promise<TokenSet>;
  /** Throws TokenUnavailable: `auth` when Keycloak refuses the refresh token, `outage` otherwise. */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Best effort: the session row is deleted either way. */
  revoke(refreshToken: string): Promise<void>;
  endSessionUrl(postLogoutRedirect: string, idToken?: string): URL;
}

// Keycloak's default SSO session idle time, for a response that doesn't say.
const DEFAULT_REFRESH_LIFETIME_S = 30 * 60;

export async function connectOidc(settings: OidcSettings): Promise<Oidc> {
  const options = settings.allowHttp ? { execute: [client.allowInsecureRequests] } : undefined;
  const config = settings.clientSecret
    ? await client.discovery(settings.issuer, settings.clientId, settings.clientSecret, undefined, options)
    : await client.discovery(settings.issuer, settings.clientId, undefined, client.None(), options);

  const tokenSet = (tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers, sub?: string): TokenSet => {
    const now = Date.now();
    const claims = tokens.claims();
    const subject = claims?.sub ?? sub;
    if (!subject) throw new Error("Keycloak answered without saying who signed in");
    if (!tokens.refresh_token) throw new Error("Keycloak answered without a refresh token");
    const refreshLifetime = Number((tokens as Record<string, unknown>).refresh_expires_in);
    return {
      sub: subject,
      accessToken: tokens.access_token,
      accessExpiresAt: now + (tokens.expires_in ?? 300) * 1000,
      refreshToken: tokens.refresh_token,
      // 0 means an offline token with no idle limit; treat it as a day so sessions still end.
      refreshExpiresAt:
        now + (refreshLifetime > 0 ? refreshLifetime : refreshLifetime === 0 ? 86_400 : DEFAULT_REFRESH_LIFETIME_S) * 1000,
      idToken: tokens.id_token,
    };
  };

  return {
    async begin(redirectUri) {
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: "openid",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
      });
      return { url, state, verifier };
    },
    async finish(callbackUrl, expected) {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: expected.verifier,
        expectedState: expected.state,
      });
      return tokenSet(tokens);
    },
    async refresh(refreshToken) {
      let tokens;
      try {
        tokens = await client.refreshTokenGrant(config, refreshToken);
      } catch (error) {
        // invalid_grant is Keycloak saying the session is gone: revoked, expired, or the token reused.
        if (error instanceof client.ResponseBodyError && error.error === "invalid_grant") {
          throw new TokenUnavailable({ kind: "auth", message: "Your sign-in has ended. Sign in again to continue." });
        }
        throw new TokenUnavailable({ kind: "outage", message: "The sign-in service couldn't be reached." });
      }
      // A refresh response carries no ID token on Keycloak's default settings; the subject is unchanged.
      return tokenSet(tokens, subjectOf(tokens.access_token));
    },
    async revoke(refreshToken) {
      await client.tokenRevocation(config, refreshToken, { token_type_hint: "refresh_token" }).catch(() => undefined);
    },
    endSessionUrl(postLogoutRedirect, idToken) {
      return client.buildEndSessionUrl(config, {
        post_logout_redirect_uri: postLogoutRedirect,
        ...(idToken ? { id_token_hint: idToken } : { client_id: settings.clientId }),
      });
    },
  };
}

/** The `sub` claim of a JWT access token, read without verifying: it only labels a token we just got. */
function subjectOf(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}
