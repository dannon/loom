/**
 * The host's settings, all from the environment, checked once at boot. A bad or missing setting
 * stops the host with every problem listed, rather than failing on first use mid-session.
 */

export interface HostConfig {
  /** Where browsers reach the host; sign-in redirects and cookies are built from it. */
  readonly publicUrl: URL;
  readonly port: number;
  readonly databaseUrl: string;
  readonly galaxyUrl: URL;
  readonly oidc: {
    /** The Keycloak realm's issuer URL. */
    readonly issuer: URL;
    readonly clientId: string;
    /** Absent only for a public dev client on a loopback host. */
    readonly clientSecret: string | undefined;
  };
  /** Encrypts refresh tokens at rest (brief decision 8). */
  readonly tokenKey: Buffer;
  readonly lease: {
    readonly ttlMs: number;
    readonly renewMs: number;
    readonly maxTurnMs: number;
  };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Orbit can't start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLoopback = (url: URL) => LOOPBACK.has(url.hostname);

/** Read and check every setting, throwing a ConfigError that lists all the problems at once. */
export function loadConfig(env: Record<string, string | undefined> = process.env): HostConfig {
  const problems: string[] = [];
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw ? raw : undefined;
  };
  const required = (name: string): string | undefined => {
    const raw = value(name);
    if (raw === undefined) problems.push(`${name} is not set`);
    return raw;
  };
  const url = (name: string, raw: string | undefined): URL | undefined => {
    if (raw === undefined) return undefined;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
    } catch {
      // Reported below.
    }
    problems.push(`${name} is not an http(s) URL`);
    return undefined;
  };
  const seconds = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback * 1000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      problems.push(`${name} must be a positive number of seconds`);
      return fallback * 1000;
    }
    return n * 1000;
  };

  const publicUrl = url("ORBIT_PUBLIC_URL", required("ORBIT_PUBLIC_URL"));
  // The session cookie is Secure and the sign-in redirect carries a code, so anything but a
  // developer's own machine needs TLS.
  if (publicUrl && publicUrl.protocol !== "https:" && !isLoopback(publicUrl)) {
    problems.push("ORBIT_PUBLIC_URL must be https unless it is localhost");
  }

  const portRaw = value("ORBIT_PORT");
  const port = portRaw === undefined ? 7878 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("ORBIT_PORT must be a port number");

  const databaseUrl = required("ORBIT_DATABASE_URL");
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("ORBIT_DATABASE_URL must be a postgres:// URL");
  }

  const galaxyUrl = url("ORBIT_GALAXY_URL", required("ORBIT_GALAXY_URL"));
  const issuer = url("ORBIT_OIDC_ISSUER", required("ORBIT_OIDC_ISSUER"));
  const clientId = required("ORBIT_OIDC_CLIENT_ID");
  const clientSecret = value("ORBIT_OIDC_CLIENT_SECRET");
  // A public client is the dev setup (orbit-dev); a deployed host signs in as the confidential client.
  if (clientSecret === undefined && publicUrl && !isLoopback(publicUrl)) {
    problems.push("ORBIT_OIDC_CLIENT_SECRET is not set; only a localhost host may use a public client");
  }

  const tokenKeyRaw = required("ORBIT_TOKEN_KEY");
  const tokenKey = tokenKeyRaw === undefined ? Buffer.alloc(0) : Buffer.from(tokenKeyRaw, "base64");
  if (tokenKeyRaw !== undefined && tokenKey.length !== 32) {
    problems.push("ORBIT_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }

  const ttlMs = seconds("ORBIT_LEASE_TTL_SECONDS", 60);
  const renewMs = seconds("ORBIT_LEASE_RENEW_SECONDS", 15);
  const maxTurnMs = seconds("ORBIT_MAX_TURN_SECONDS", 30 * 60);
  // Renewing at most every half TTL leaves one missed renewal before the lease can be taken.
  if (renewMs * 2 > ttlMs) problems.push("ORBIT_LEASE_RENEW_SECONDS must be at most half of ORBIT_LEASE_TTL_SECONDS");

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    publicUrl: publicUrl!,
    port,
    databaseUrl: databaseUrl!,
    galaxyUrl: galaxyUrl!,
    oidc: { issuer: issuer!, clientId: clientId!, clientSecret },
    tokenKey,
    lease: { ttlMs, renewMs, maxTurnMs },
  };
}

/** The settings for the boot log. Secrets are named as set or not, never shown. */
export function describeConfig(config: HostConfig): string {
  const db = new URL(config.databaseUrl);
  const where = `${db.hostname || db.searchParams.get("host") || "local socket"}${db.port ? `:${db.port}` : ""}${db.pathname}`;
  const secs = (ms: number) => `${ms / 1000} s`;
  const lines = [
    ["public URL", `${config.publicUrl.origin} (listening on ${config.port})`],
    ["database", `${where} (password ${db.password ? "set" : "not set"})`],
    ["Galaxy", config.galaxyUrl.origin],
    [
      "sign-in",
      `${config.oidc.issuer.href} as ${config.oidc.clientId} (client secret ${config.oidc.clientSecret ? "set" : "not set, public client"})`,
    ],
    ["token key", "set"],
    [
      "leases",
      `${secs(config.lease.ttlMs)} TTL, renewed every ${secs(config.lease.renewMs)}, turns end after ${secs(config.lease.maxTurnMs)}`,
    ],
  ];
  return ["Orbit host configuration:", ...lines.map(([k, v]) => `  ${k!.padEnd(11)} ${v}`)].join("\n");
}
