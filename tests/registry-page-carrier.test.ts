/**
 * The registry's Page carrier (v3 §9-§10): codec, the continuation-vs-import
 * rule through the real store, and the pull path end to end with Galaxy's
 * Pages API stubbed.
 */

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { gzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pagesApi from "../extensions/loom/galaxy-pages-api";
import * as galaxyApi from "../extensions/loom/galaxy-api";
import * as reconcile from "../extensions/loom/galaxy-reconcile";
import * as state from "../extensions/loom/state";
import {
  MAX_CARRIER_CHARS,
  CarrierTooLargeError,
  encodeRegistryCarrier,
  extractRegistryCarrier,
} from "../extensions/loom/registry-carrier";
import {
  pullNotebookFromGalaxy,
  pushNotebookToGalaxy,
  resumeGalaxyPage,
} from "../extensions/loom/galaxy-pages-sync";
import { RegistryStore } from "../extensions/loom/registry";
import { closeSessionRegistry, openSessionRegistry } from "../extensions/loom/registry-runtime";
import { resetRegistryPageCarrier } from "../extensions/loom/registry-page-carrier";
import { canonicalJson, type Attempt } from "../extensions/loom/registry-schema";
import { renderGalaxyPageBlock } from "../extensions/loom/galaxy-page-binding";
import { eligibleAttempt, SERVER, tmpAnalysisDir } from "./registry-fixtures";

vi.mock("../extensions/loom/galaxy-pages-api");
vi.mock("../extensions/loom/galaxy-api", async (importOriginal) => {
  const actual = await importOriginal<typeof galaxyApi>();
  return { ...actual, getGalaxyConfig: vi.fn() };
});
vi.mock("../extensions/loom/galaxy-reconcile", () => ({ followThrough: vi.fn(async () => ({})) }));
vi.mock("../extensions/loom/state");
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => ({}) }));

const gzipBomb = () => {
  // 8 MiB of zeros compresses to a few KB.
  const b64 = gzipSync(Buffer.alloc(8 * 1024 * 1024)).toString("base64");
  return `[loom-registry:v3]: #loom "${b64}"`;
};

describe("carrier codec", () => {
  it("round-trips, and the carrier never stays in the body", () => {
    const text = canonicalJson({ hello: "registry", n: 1 });
    const page = `# Notebook\n\nSome prose.\n\n${encodeRegistryCarrier(text)}\n`;
    const got = extractRegistryCarrier(page);
    expect(got).toEqual({ kind: "found", body: "# Notebook\n\nSome prose.\n", registryText: text });
  });

  it("leaves content without a carrier exactly as it was", () => {
    const page = "# Notebook\n\nNo carrier [loom-registry:v3] mentioned inline.\n\n";
    expect(extractRegistryCarrier(page)).toEqual({ kind: "none", body: page });
  });

  it("rejects two carriers, a malformed one, and one that doesn't decode -- and strips them all", () => {
    const one = encodeRegistryCarrier("{}");
    for (const page of [
      `a\n${one}\n${one}\n`,
      `a\n[loom-registry:v3]: #loom "not base64!"\n`,
      `a\n[loom-registry:v3]: #loom "AAAA"\n`,
      `a\n[loom-registry:v9]: #loom "AAAA"\n`,
    ]) {
      const got = extractRegistryCarrier(page);
      expect(got.kind, page).toBe("rejected");
      expect(got.body).not.toMatch(/registry:v/);
    }
  });

  it("refuses a decompression bomb", () => {
    const got = extractRegistryCarrier(`a\n${gzipBomb()}\n`);
    expect(got.kind).toBe("rejected");
  });

  it("encodes right up to the cap and refuses past it", () => {
    // Random text barely compresses, so the encoded size tracks the input;
    // walk it down until it fits, which leaves it within a few percent of the cap.
    let size = MAX_CARRIER_CHARS;
    let line: string;
    for (;;) {
      try {
        line = encodeRegistryCarrier(randomBytes(size).toString("base64").slice(0, size));
        break;
      } catch {
        size = Math.floor(size * 0.98);
      }
    }
    expect(line.length).toBeLessThanOrEqual(MAX_CARRIER_CHARS);
    expect(line.length).toBeGreaterThan(MAX_CARRIER_CHARS * 0.95);
    const back = extractRegistryCarrier(`x\n\n${line}\n`);
    expect(back.kind).toBe("found");
    expect(() => encodeRegistryCarrier(randomBytes(MAX_CARRIER_CHARS).toString("base64"))).toThrow(
      CarrierTooLargeError,
    );
    expect(
      extractRegistryCarrier(`x\n[loom-registry:v3]: #loom "${"A".repeat(MAX_CARRIER_CHARS)}"\n`)
        .kind,
    ).toBe("rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let nbPath: string;

function liveAttempt(): Attempt {
  const a = eligibleAttempt();
  a.binding.step_anchor = "plan-a-step-2";
  return a;
}

function openSession() {
  return openSessionRegistry({
    analysisDir: dir,
    sessionId: "s",
    serverUrl: SERVER,
    heartbeatMs: null,
  }).session;
}

/** A registry another session signed, as a carrier line. */
function foreignCarrier(...attempts: Attempt[]): string {
  const other = tmpAnalysisDir();
  const store = new RegistryStore({
    analysisDir: other,
    serverUrl: SERVER,
    sessionId: "o",
    fs,
    clock: Date.now,
  });
  store.open();
  store.update((d) => {
    for (const a of attempts) d.attempts[a.attempt_id] = a;
  });
  const line = encodeRegistryCarrier(fs.readFileSync(store.registryPath, "utf-8"));
  store.close();
  fs.rmSync(other, { recursive: true, force: true });
  return line;
}

const PLAN = `# Notebook

## Plan A: Calling [galaxy]

- [ ] 1. **QC** {#plan-a-step-1}
- [ ] 2. **Align** {#plan-a-step-2}
`;

function binding(): string {
  return renderGalaxyPageBlock({
    pageId: "p1",
    pageSlug: null,
    galaxyServerUrl: SERVER,
    historyId: "h1",
    lastSyncedRevision: "r0",
    boundAt: "2026-10-01T00:00:00Z",
  });
}

function pageWith(content: string) {
  vi.mocked(pagesApi.getPage).mockResolvedValue({
    id: "p1",
    slug: null,
    latest_revision_id: "r1",
    revision_ids: ["r1"],
    title: "t",
    content,
    history_id: "h1",
  } as never);
}

describe("the carrier through the store and the Page", () => {
  beforeEach(() => {
    dir = tmpAnalysisDir();
    nbPath = path.join(dir, "notebook.md");
    fs.writeFileSync(nbPath, `${PLAN}\n${binding()}\n`);
    vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
    vi.mocked(galaxyApi.getGalaxyConfig).mockReturnValue({ url: SERVER, apiKey: "k" } as never);
    vi.mocked(reconcile.followThrough).mockClear();
    resetRegistryPageCarrier();
    process.env.LOOM_EVIDENCE_GATE = "deny";
  });
  afterEach(() => {
    closeSessionRegistry();
    delete process.env.LOOM_EVIDENCE_GATE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a push carries this session's registry, and pulling it back is a continuation", async () => {
    const session = openSession();
    const a = liveAttempt();
    session.store.update((d) => {
      d.attempts[a.attempt_id] = a;
    });
    vi.mocked(pagesApi.updatePage).mockResolvedValue({
      id: "p1",
      slug: null,
      latest_revision_id: "r1",
    } as never);
    await pushNotebookToGalaxy();
    const pushed = vi.mocked(pagesApi.updatePage).mock.calls[0][1].content as string;
    expect(pushed).toMatch(/^\[loom-registry:v3\]: #loom "/m);

    pageWith(pushed);
    const result = await pullNotebookFromGalaxy();
    expect(result.registry).toBeUndefined();
    expect(fs.readFileSync(nbPath, "utf-8")).not.toMatch(/registry:v3/);
    const got = session.store.snapshot().attempts[a.attempt_id];
    expect(got.approval?.status).toBe("live");
    expect(got.handoff_eligible).toBe(true);
    expect(reconcile.followThrough).toHaveBeenCalledWith("page_pull");
  });

  it("a carrier another session wrote is an import: nothing it claims survives", async () => {
    const session = openSession();
    pageWith(`${PLAN}\n\n${foreignCarrier(liveAttempt())}\n`);
    const result = await resumeGalaxyPage("p1");
    expect(result.registry).toMatch(/another session/);
    const [got] = Object.values(session.store.snapshot().attempts);
    expect(got.approval?.status).toBe("restored");
    expect(got.submission?.check.outcome).toBe("unchecked");
    expect(got.handoff_eligible).toBe(false);
    expect(reconcile.followThrough).toHaveBeenCalledWith("page_resume");
  });

  it("a foreign carrier can't replace state the session holds", async () => {
    const session = openSession();
    const mine = liveAttempt();
    session.store.update((d) => {
      d.attempts[mine.attempt_id] = mine;
    });
    pageWith(`${PLAN}\n\n${foreignCarrier()}\n`);
    await pullNotebookFromGalaxy();
    expect(session.store.snapshot().attempts[mine.attempt_id].approval?.status).toBe("live");
  });

  it("a malformed carrier is rejected with one notice and kept out of the notebook", async () => {
    openSession();
    pageWith(`${PLAN}\n\n[loom-registry:v3]: #loom "AAAA"\n`);
    const result = await pullNotebookFromGalaxy();
    expect(result.registry).toMatch(/rejected/);
    expect(fs.readFileSync(nbPath, "utf-8")).not.toMatch(/registry:v3/);
  });

  it("refuses a pull whose notebook completes a step the record holds", async () => {
    // A run for step 2 the registry knows about and hasn't re-verified.
    pageWith(`${PLAN}\n\n${foreignCarrier(liveAttempt())}\n`);
    const session = openSession();
    await resumeGalaxyPage("p1");
    expect(Object.values(session.store.snapshot().attempts)[0].handoff_eligible).toBe(false);

    const before = fs.readFileSync(nbPath, "utf-8");
    pageWith(PLAN.replace("- [ ] 2. **Align**", "- [x] 2. **Align**"));
    await expect(pullNotebookFromGalaxy()).rejects.toThrow(/evidence gate is holding/);
    expect(fs.readFileSync(nbPath, "utf-8")).toBe(before);
  });

  it("resuming onto a fresh notebook isn't refused for steps the Page already had complete", async () => {
    // A new container's notebook has no plan yet; the Page brings the steps in
    // whatever state they were left, and reconcile re-checks them afterwards.
    fs.writeFileSync(nbPath, "# Notebook\n");
    openSession();
    pageWith(
      `${PLAN.replace("- [ ] 2. **Align**", "- [x] 2. **Align**")}\n\n${foreignCarrier(liveAttempt())}\n`,
    );
    await expect(resumeGalaxyPage("p1")).resolves.toMatchObject({ action: "linked" });
    expect(fs.readFileSync(nbPath, "utf-8")).toContain("- [x] 2. **Align**");
  });

  it("a carrier typed into the notebook never goes out beside the harness's own", async () => {
    const session = openSession();
    session.store.update((d) => {
      const a = liveAttempt();
      d.attempts[a.attempt_id] = a;
    });
    fs.appendFileSync(nbPath, `\n${foreignCarrier()}\n`);
    vi.mocked(pagesApi.updatePage).mockResolvedValue({
      id: "p1",
      slug: null,
      latest_revision_id: "r1",
    } as never);
    await pushNotebookToGalaxy();
    const pushed = vi.mocked(pagesApi.updatePage).mock.calls.at(-1)![1].content as string;
    expect(pushed.match(/^\[loom-registry:v3\]/gm)).toHaveLength(1);
    pageWith(pushed);
    await pullNotebookFromGalaxy();
    expect(Object.values(session.store.snapshot().attempts)[0].approval?.status).toBe("live");
  });
});
