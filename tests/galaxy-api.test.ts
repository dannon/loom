import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  galaxyGetJobDetails,
  galaxyListHistoryJobs,
  getGalaxyConfig,
  isGalaxyEncodedId,
  setGalaxyFetchOverride,
} from "../extensions/loom/galaxy-api";

describe("getGalaxyConfig", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  afterEach(() => {
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("returns null when env vars missing", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns null when only URL is set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org";
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns config when env vars set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org/";
    process.env.GALAXY_API_KEY = "test-key-123";

    const config = getGalaxyConfig();
    expect(config).not.toBeNull();
    expect(config!.url).toBe("https://usegalaxy.org");
    expect(config!.apiKey).toBe("test-key-123");
  });

  it("strips trailing slashes from URL", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org///";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://usegalaxy.org");
  });

  it("prepends https:// when the URL is scheme-less", () => {
    // Config profiles / env often store the host without a scheme
    // ("test.galaxyproject.org/"), which fetch() cannot parse.
    process.env.GALAXY_URL = "test.galaxyproject.org/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://test.galaxyproject.org");
  });

  it("preserves an explicit http:// scheme", () => {
    process.env.GALAXY_URL = "http://localhost:8080/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("http://localhost:8080");
  });
});

describe("job details and listing requests", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;
  const seen: string[] = [];

  beforeEach(() => {
    process.env.GALAXY_URL = "https://galaxy.example";
    process.env.GALAXY_API_KEY = "k";
    seen.length = 0;
    setGalaxyFetchOverride(async (url) => {
      seen.push(url);
      const body = url.includes("/jobs?") ? [{ id: "aa" }, { nope: 1 }, "x"] : { id: "aa" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });

  afterEach(() => {
    setGalaxyFetchOverride(null);
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("asks for full details only when told to", async () => {
    await galaxyGetJobDetails("aa");
    await galaxyGetJobDetails("aa", undefined, { full: true });
    expect(seen).toEqual([
      "https://galaxy.example/api/jobs/aa",
      "https://galaxy.example/api/jobs/aa?full=true",
    ]);
  });

  it("lists a history's jobs by day and drops rows without an id", async () => {
    const rows = await galaxyListHistoryJobs({
      historyId: "0a248a1f62a0cc04",
      sinceDay: "2026-10-01",
      limit: 50,
      offset: 100,
    });
    expect(rows).toEqual([{ id: "aa" }]);
    const url = new URL(seen[0]);
    expect(url.pathname).toBe("/api/jobs");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      history_id: "0a248a1f62a0cc04",
      date_range_min: "2026-10-01",
      limit: "50",
      offset: "100",
      order_by: "create_time",
    });
  });

  it("knows a Galaxy id from a path segment", () => {
    expect(isGalaxyEncodedId("0a248a1f62a0cc04")).toBe(true);
    for (const bad of [".", "..", "a/b", "", "0a24 8a", 7]) {
      expect(isGalaxyEncodedId(bad)).toBe(false);
    }
  });
});
