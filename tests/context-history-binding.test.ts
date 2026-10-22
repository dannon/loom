import { afterEach, describe, expect, it } from "vitest";

import { buildHistoryBindingBlock, setupContextInjection } from "../extensions/loom/context";
import { setGalaxyTransport } from "../extensions/loom/galaxy-api";
import { resetState, setCurrentHistoryId } from "../extensions/loom/state";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Galaxy answering the history's contents with `answer`, and the URLs it was asked. */
function galaxy(answer: () => Response) {
  const asked: string[] = [];
  setGalaxyTransport({
    fetch: (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return answer();
    }) as typeof fetch,
    credentials: () => ({ url: "http://g.test", apiKey: "key-1234567890" }),
  });
  return asked;
}

const DATASETS = [
  { id: "0123456789abcdef", hid: 2, name: "reads.fq", extension: "fastqsanger", state: "ok" },
  { id: "fedcba9876543210", hid: 1, name: "peptide.pdb", extension: "pdb", state: "ok" },
];

afterEach(() => {
  setGalaxyTransport(null);
  resetState();
});

describe("the current history in each turn's context", () => {
  it("binds the turn to the current history and lists its datasets, oldest first, ids verbatim", async () => {
    const asked = galaxy(() => json(DATASETS));
    setCurrentHistoryId("h1");
    const block = await buildHistoryBindingBlock();
    expect(block).toContain('Pass `history_id="h1"`');
    expect(block).toContain("## Datasets in this history");
    expect(block.indexOf("**1**: peptide.pdb")).toBeLessThan(block.indexOf("**2**: reads.fq"));
    expect(block).toContain("id `0123456789abcdef`");
    expect(asked[0]).toMatch(/^http:\/\/g\.test\/api\/histories\/h1\/contents\?/);
  });

  it("says the listing failed rather than showing none", async () => {
    galaxy(() => json({ err_msg: "boom" }, 500));
    setCurrentHistoryId("h1");
    const block = await buildHistoryBindingBlock();
    expect(block).toContain('Pass `history_id="h1"`');
    expect(block).toContain("could not be listed this turn");
  });

  it("binds an empty history without a listing", async () => {
    galaxy(() => json([]));
    setCurrentHistoryId("h1");
    const block = await buildHistoryBindingBlock();
    expect(block).toContain('Pass `history_id="h1"`');
    expect(block).not.toContain("Datasets in this history");
  });

  it("says nothing, and asks Galaxy nothing, with no current history", async () => {
    const asked = galaxy(() => json(DATASETS));
    expect(await buildHistoryBindingBlock()).toBe("");
    expect(asked).toEqual([]);
  });

  it("rides in the turn's notebook context, just before the user's message", async () => {
    galaxy(() => json(DATASETS));
    setCurrentHistoryId("h1");
    type Handler = (event: { messages: unknown[] }) => Promise<{ messages: unknown[] }>;
    const handlers = new Map<string, Handler>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupContextInjection({ on: (e: string, h: Handler) => handlers.set(e, h) } as any);
    const { messages } = await handlers.get("context")!({
      messages: [{ role: "user", content: "what's here?" }],
    });
    const [context, user] = messages as Array<{ role: string; content: string }>;
    expect(context.role).toBe("custom");
    expect(context.content).toContain("Datasets in this history");
    expect(user).toEqual({ role: "user", content: "what's here?" });
  });
});
