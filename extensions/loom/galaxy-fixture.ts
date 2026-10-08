/**
 * Answering Galaxy calls from a recorded fixture, for the Tier-1 evals.
 *
 * Reconcile and enrichment are driven by what Galaxy says after the submit --
 * listings, job details, a 502 followed by a 200 -- and the Tier-1 scenarios
 * are model-free and network-free by design. `LOOM_GALAXY_FIXTURE` names a
 * JSON file in the session directory; while it is set, every Galaxy call made
 * through galaxy-api.ts (galaxy-ops' included) is answered from it.
 *
 * Same constraints as the submission replay seam: off unless the variable is
 * set, the file must resolve inside the session directory, and a
 * `galaxy.fixture` activity row is written first, so a notebook whose runs
 * were reconciled or enriched from a fixture says so in its own log.
 *
 * File shape:
 *
 * ```json
 * { "routes": [
 *   { "method": "GET", "path": "/api/jobs/aa11", "query": { "full": "true" },
 *     "responses": [ { "status": 502, "body": "bad gateway" },
 *                    { "status": 200, "body": { "id": "aa11", "state": "ok" } } ] }
 * ] }
 * ```
 *
 * A route matches on method, exact path, and every query key it names (keys it
 * does not name are ignored). Routes are tried in order. Each request takes
 * the route's next response; the last one repeats. Anything unmatched is a 404.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { readEnv } from "../../shared/orbit-env.js";
import { appendActivityEvent } from "./activity";
import { setGalaxyFetchOverride } from "./galaxy-api";
import { resolveReplayPath } from "./submission-replay";

interface FixtureResponse {
  status: number;
  body?: unknown;
}

interface FixtureRoute {
  method?: string;
  path: string;
  query?: Record<string, string>;
  responses: FixtureResponse[];
}

export function isGalaxyFixtureEnabled(): boolean {
  return !!readEnv("GALAXY_FIXTURE")?.trim();
}

export function parseGalaxyFixture(raw: string): FixtureRoute[] {
  const parsed = JSON.parse(raw) as { routes?: unknown };
  if (!Array.isArray(parsed.routes)) return [];
  return parsed.routes.filter(
    (r): r is FixtureRoute =>
      !!r &&
      typeof r === "object" &&
      typeof (r as FixtureRoute).path === "string" &&
      Array.isArray((r as FixtureRoute).responses) &&
      (r as FixtureRoute).responses.length > 0,
  );
}

/** A fetch that answers from `routes`. Exported for the seam's own test. */
export function fixtureFetch(
  routes: FixtureRoute[],
): (url: string, init: RequestInit) => Promise<Response> {
  const served = new Map<FixtureRoute, number>();
  return async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const route = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        r.path === u.pathname &&
        Object.entries(r.query ?? {}).every(([k, v]) => u.searchParams.get(k) === v),
    );
    if (!route) {
      return new Response(JSON.stringify({ err_msg: `no fixture for ${method} ${u.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const index = served.get(route) ?? 0;
    served.set(route, index + 1);
    const response = route.responses[Math.min(index, route.responses.length - 1)];
    const body =
      typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? null);
    return new Response(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Install the fixture now, at registration, rather than on session start: the
 * poller's first tick fires inside session start and must not reach a real
 * server first.
 */
export function registerGalaxyFixture(pi: ExtensionAPI): void {
  const configured = readEnv("GALAXY_FIXTURE")?.trim();
  if (!configured) return;
  const sessionDir = process.cwd();
  const file = resolveReplayPath(sessionDir, configured);
  if (!file || !fs.existsSync(file)) return;
  let routes: FixtureRoute[];
  try {
    routes = parseGalaxyFixture(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error("[galaxy-fixture] unreadable fixture:", err);
    return;
  }
  setGalaxyFetchOverride(fixtureFetch(routes));
  pi.on("session_start", async () => {
    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "galaxy.fixture",
      source: "galaxy-fixture",
      payload: { file: path.relative(sessionDir, file), routes: routes.length },
    });
  });
}
