// @vitest-environment node
/**
 * The Orbit worker's submission ledger over its file: what a worker wrote, a reloaded one reads
 * back, and a file it can't read starts it empty rather than stopping the boot. The OPFS file
 * itself needs a browser; the e2e tiers reach it.
 */
import { describe, expect, it, vi } from "vitest";

import { openFileLedger, type LedgerFile } from "./ledger";

const KEY = "/orbit/c1/notebook.md";
const dispatched = (callId: string) => ({
  callId,
  attemptId: `att-${callId}`,
  toolName: "run_tool",
  recordKey: KEY,
  stepAnchor: "step-1",
  server: "https://galaxy.test",
  dispatchedAt: "2026-10-21T00:00:00.000Z",
});

function memoryFile(initial?: string): LedgerFile & { text?: string } {
  const file: LedgerFile & { text?: string } = {
    text: initial,
    read: async () => file.text,
    write: async (text) => void (file.text = text),
  };
  return file;
}

describe("the Orbit worker's file ledger", () => {
  it("reads back what the last worker wrote", async () => {
    const file = memoryFile();
    const first = await openFileLedger(file);
    await first.dispatched(dispatched("c1"));
    await first.responded("c1", {
      kind: "jobs",
      label: "fastqc",
      historyId: "h1",
      jobs: [{ jobId: "j1" }],
    });
    const reloaded = await openFileLedger(file);
    expect(await reloaded.open(KEY)).toMatchObject([
      { callId: "c1", state: "responded", submission: { jobs: [{ jobId: "j1" }] } },
    ]);
  });

  it("starts empty on a file it can't read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ledger = await openFileLedger(memoryFile('{"entries": [tor'));
    expect(await ledger.open(KEY)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
