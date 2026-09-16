/**
 * `verifyGalaxyRun` -- the round trip the record tools make before writing an
 * id into the notebook, and the line it draws between "Galaxy says this id is
 * not a thing" and "Galaxy didn't answer".
 *
 * Only `fetch` is faked, so the status-to-outcome mapping is exercised through
 * the real `galaxyGet`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalaxyApiError, sameGalaxyServer, verifyGalaxyRun } from "../extensions/loom/galaxy-api";

/** Galaxy's encoded ids are hex; the verifier refuses anything else outright. */
const INV_ID = "f2db41e1fa331b3e";
const JOB_ID = "bbd44e69cb8906b5";

function response(status: number, body: unknown = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/** A Galaxy answer that echoes back the id it was asked about. */
function echoes(id: string): Response {
  return response(200, { id, state: "ok" });
}

describe("verifyGalaxyRun", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("asks the invocation endpoint for an invocation id", async () => {
    const fetchMock = vi.fn(async () => echoes(INV_ID));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyGalaxyRun("invocation", INV_ID)).toEqual({ outcome: "found" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://usegalaxy.org/api/invocations/${INV_ID}`);
  });

  it("asks the jobs endpoint for a job id", async () => {
    const fetchMock = vi.fn(async () => echoes(JOB_ID));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyGalaxyRun("job", JOB_ID)).toEqual({ outcome: "found" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://usegalaxy.org/api/jobs/${JOB_ID}`);
  });

  it("refuses a path-shaped id without calling out at all", async () => {
    // `encodeURIComponent(".")` is "."; the URL then normalizes /api/jobs/. to
    // the jobs *collection*, which answers 200 with a list. A 200 is not proof.
    const fetchMock = vi.fn(async () => response(200, [{ id: JOB_ID }]));
    vi.stubGlobal("fetch", fetchMock);

    for (const id of [".", "..", "../histories", "not-hex"]) {
      const result = await verifyGalaxyRun("job", id);
      expect(result.outcome).toBe("absent");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a 200 that answers for something else", async () => {
    // Belt and braces behind the id-shape check: whatever comes back has to be
    // the resource we asked about.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => echoes("0123456789abcdef")),
    );
    expect((await verifyGalaxyRun("job", JOB_ID)).outcome).toBe("absent");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, [{ id: JOB_ID }])),
    );
    expect((await verifyGalaxyRun("job", JOB_ID)).outcome).toBe("absent");
  });

  it("reports a 404 as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(404, "No invocation found")),
    );
    const result = await verifyGalaxyRun("invocation", INV_ID);
    expect(result.outcome).toBe("absent");
    expect(result).toHaveProperty("detail", expect.stringContaining("404"));
  });

  it("reports a 400 as absent, because that is what a malformed id returns", async () => {
    // Galaxy decodes ids before it looks anything up, and decode_id raises
    // MalformedId -- a 400 -- for a value that isn't an encoded id at all.
    // A hallucinated id arrives in exactly that shape.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(400, "Malformed id")),
    );
    expect((await verifyGalaxyRun("job", JOB_ID)).outcome).toBe("absent");
  });

  it("reports a server error as unreachable, not absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(502, "bad gateway")),
    );
    const result = await verifyGalaxyRun("invocation", INV_ID);
    expect(result.outcome).toBe("unreachable");
    expect(result).toHaveProperty("detail", expect.stringContaining("502"));
  });

  it("reports an auth failure as unreachable -- a 403 is about us, not the id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(403, "Forbidden")),
    );
    expect((await verifyGalaxyRun("job", JOB_ID)).outcome).toBe("unreachable");
  });

  it("reports a dead network as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await verifyGalaxyRun("invocation", INV_ID);
    expect(result.outcome).toBe("unreachable");
    expect(result).toHaveProperty("detail", expect.stringContaining("fetch failed"));
  });

  it("reports missing credentials as unreachable without calling out", async () => {
    delete process.env.GALAXY_API_KEY;
    const fetchMock = vi.fn(async () => echoes(INV_ID));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyGalaxyRun("invocation", INV_ID);
    expect(result.outcome).toBe("unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GalaxyApiError", () => {
  it("keeps the message shape callers already match on", () => {
    expect(new GalaxyApiError(404, "not found", "Not Found").message).toBe(
      "Galaxy API 404: not found",
    );
    expect(new GalaxyApiError(500, "", "Server Error").message).toBe(
      "Galaxy API 500: Server Error",
    );
  });
});

describe("sameGalaxyServer", () => {
  it("ignores trailing slashes and case", () => {
    expect(sameGalaxyServer("https://GALAXY.test/", "https://galaxy.test")).toBe(true);
  });

  it("is false for a different server", () => {
    expect(sameGalaxyServer("https://other.test", "https://galaxy.test")).toBe(false);
  });

  it("treats a block with no recorded server as making no claim", () => {
    expect(sameGalaxyServer("", "https://galaxy.test")).toBe(true);
    expect(sameGalaxyServer(undefined, "https://galaxy.test")).toBe(true);
  });

  it("is false when there is no current server to compare against", () => {
    expect(sameGalaxyServer("https://galaxy.test", undefined)).toBe(false);
  });
});
