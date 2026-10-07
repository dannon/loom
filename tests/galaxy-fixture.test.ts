import { describe, expect, it } from "vitest";
import { fixtureFetch, parseGalaxyFixture } from "../extensions/loom/galaxy-fixture";

describe("Galaxy fixture seam", () => {
  const routes = parseGalaxyFixture(
    JSON.stringify({
      routes: [
        {
          path: "/api/jobs/aa11",
          query: { full: "true" },
          responses: [
            { status: 502, body: "bad gateway" },
            { status: 200, body: { id: "aa11" } },
          ],
        },
        { path: "/api/jobs/aa11", responses: [{ status: 200, body: { id: "aa11", plain: true } }] },
        { path: "/api/broken" },
        "nope",
      ],
    }),
  );

  it("drops routes without responses", () => {
    expect(routes).toHaveLength(2);
  });

  it("serves responses in order, repeats the last, and matches on the query keys it names", async () => {
    const f = fixtureFetch(routes);
    const get = (url: string) => f(url, { method: "GET" });
    expect((await get("https://g.org/api/jobs/aa11?full=true")).status).toBe(502);
    expect(await (await get("https://g.org/api/jobs/aa11?full=true&x=1")).json()).toEqual({
      id: "aa11",
    });
    expect((await get("https://g.org/api/jobs/aa11?full=true")).status).toBe(200);
    expect(await (await get("https://g.org/api/jobs/aa11")).json()).toEqual({
      id: "aa11",
      plain: true,
    });
  });

  it("answers anything unmatched with a 404", async () => {
    const f = fixtureFetch(routes);
    expect((await f("https://g.org/api/histories", { method: "GET" })).status).toBe(404);
    expect((await f("https://g.org/api/jobs/aa11", { method: "POST" })).status).toBe(404);
  });
});
