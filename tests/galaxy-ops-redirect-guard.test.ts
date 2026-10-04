import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { galaxyGetInvocation } from "../extensions/loom/galaxy-api";

// galaxy-ops makes its own requests. Every other Galaxy call in the brain goes
// through fetchSameOriginOnly so the API key can't follow a redirect to another
// host; these pin that the galaxy-ops path does too.
describe("galaxy-ops requests keep the redirect guard", () => {
  const seen: Array<{ url: string; key: string | null }> = [];

  beforeEach(() => {
    seen.length = 0;
    process.env.GALAXY_URL = "https://galaxy.example";
    process.env.GALAXY_API_KEY = "secret-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  // Behaves like Node's fetch: a 3xx is followed, custom headers and all,
  // unless the request asked for redirect: "manual".
  function answer(reply: (url: string) => Response) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : undefined;
      const headers = new Headers(req ? req.headers : init?.headers);
      const mode = init?.redirect ?? req?.redirect ?? "follow";
      let url = String(req ? req.url : input);
      for (;;) {
        seen.push({ url, key: headers.get("x-api-key") });
        const res = reply(url);
        const location = res.headers.get("location");
        if (mode === "manual" || ![301, 302, 303, 307, 308].includes(res.status) || !location) {
          return res;
        }
        url = new URL(location, url).href;
      }
    });
  }

  const invocation = () =>
    new Response(JSON.stringify({ id: "inv-1", state: "scheduled", steps: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("refuses a redirect to another host without sending the key there", async () => {
    // The other host answers like a real server would, so an unguarded client
    // gets a plausible invocation back and the only evidence is where the key went.
    answer((url) =>
      url.startsWith("https://elsewhere.example")
        ? invocation()
        : new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example/steal" },
          }),
    );

    await expect(galaxyGetInvocation("inv-1")).rejects.toThrow(/elsewhere\.example|refused/);
    expect(seen.map((s) => s.url)).toEqual([
      expect.stringMatching(/^https:\/\/galaxy\.example\/api\/invocations\/inv-1/),
    ]);
    expect(seen.some((s) => s.url.startsWith("https://elsewhere.example"))).toBe(false);
  });

  it("follows a same-origin redirect and keeps the key on it", async () => {
    answer((url) =>
      url.includes("/moved/")
        ? invocation()
        : new Response(null, {
            status: 307,
            headers: { location: "https://galaxy.example/moved/api/invocations/inv-1" },
          }),
    );

    const inv = await galaxyGetInvocation("inv-1");
    expect(inv.id).toBe("inv-1");
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.key === "secret-key")).toBe(true);
  });
});
