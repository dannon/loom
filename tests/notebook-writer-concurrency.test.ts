import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeNotebook,
  readNotebook,
  withNotebookLock,
  upsertInvocationBlock,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";

describe("writeNotebook + withNotebookLock", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-concurrency-"));
    nbPath = join(dir, "notebook.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeNotebook is atomic (no .tmp left behind on success)", async () => {
    await writeNotebook(nbPath, "hello\n");
    expect(readFileSync(nbPath, "utf-8")).toBe("hello\n");
    // tmp file shouldn't survive; rename should have moved it.
    expect(() => readFileSync(`${nbPath}.tmp`, "utf-8")).toThrow();
  });

  it("two parallel upsert+write cycles serialize via the lock — neither update is lost", async () => {
    await writeNotebook(nbPath, "");

    const invA: InvocationYaml = {
      invocationId: "inv-A",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-1",
      label: "A",
      submittedAt: "2026-04-25T00:00:00Z",
      status: "in_progress",
    };
    const invB: InvocationYaml = {
      invocationId: "inv-B",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-2",
      label: "B",
      submittedAt: "2026-04-25T00:00:01Z",
      status: "in_progress",
    };

    // Race two read-modify-write cycles. Without the lock they would both
    // read the empty file, each writes its own block, the second overwrites
    // the first → only one block survives.
    const work = (inv: InvocationYaml) =>
      withNotebookLock(nbPath, async () => {
        const content = await readNotebook(nbPath);
        await new Promise((r) => setTimeout(r, 5)); // amplify race window
        const updated = upsertInvocationBlock(content, inv);
        await writeNotebook(nbPath, updated);
      });

    await Promise.all([work(invA), work(invB)]);

    const final = readFileSync(nbPath, "utf-8");
    expect(final).toContain("invocation_id: inv-A");
    expect(final).toContain("invocation_id: inv-B");
  });

  it("lock releases even if work() throws", async () => {
    await writeNotebook(nbPath, "init\n");

    let secondRan = false;
    const failing = withNotebookLock(nbPath, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    await withNotebookLock(nbPath, async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });
});
