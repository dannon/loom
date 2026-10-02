import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROPOSE_INSTRUCTION,
  addSuppression,
  currentSuppressions,
  formatLessonListing,
  registerLessonCommand,
  registerLessonProposals,
  removeSuppression,
} from "../extensions/loom/lesson-command";
import { resetLessonNudge } from "../extensions/loom/lesson-nudge";
import {
  peekLessonProposalArming,
  resetLessonProposalArming,
} from "../extensions/loom/lessons/propose";
import { composeLessonMarkdown } from "../extensions/loom/lessons/compose";
import { draftFilePath, lessonFilePath } from "../extensions/loom/lessons/paths";
import { getLessonStore, resetLessonStore } from "../extensions/loom/lessons/store";
import { resetActivity } from "../extensions/loom/activity";
import { setNotebookPath } from "../extensions/loom/state";

let tmp: string;
let cwd: string;

const VALID = composeLessonMarkdown(
  {
    namespace: "stats",
    slug: "na-is-zero",
    title: "Numeric filters treat NA as zero, so missing p-values pass a cutoff",
    description: "A significance filter counts NA rows as significant and nothing errors.",
    kind: "pitfall",
    stage: ["result-interpretation"],
    stale_after: "2027-09-30",
    cues: "thresholding a p-value column with awk",
    applies_to: { versions: "any", tested: "awk on DESeq2 output" },
    evidence: { symptom: "verified", cause: "verified", outcome: "validated", method: "recount" },
    trigger: { tools: ["deseq2"] },
    sections: {
      symptom: "Implausibly many significant genes. Nothing errors.",
      check_first: "Count rows where the tested column is literally NA.",
      intervention: "Exclude NA explicitly before comparing.",
      validate: "State the significant count among non-NA rows and the total.",
      not_when: "The table has no missing values in that column.",
    },
  },
  { generatedBy: "agent:loom/0.8.0", generatedAt: "2026-09-30" },
);

function harness(opts: { idle?: boolean; confirm?: boolean } = {}) {
  const commands = new Map<
    string,
    { handler: (args: string | undefined, ctx: unknown) => Promise<void> }
  >();
  const sent: string[] = [];
  const notifications: { msg: string; level: string }[] = [];
  const pi = {
    registerCommand: (name: string, def: { handler: never }) => commands.set(name, def),
    sendUserMessage: (text: string) => sent.push(text),
  };
  const ctx = {
    hasUI: true,
    isIdle: () => opts.idle !== false,
    ui: {
      notify: (msg: string, level = "info") => notifications.push({ msg, level }),
      select: async () => undefined,
      confirm: async () => opts.confirm !== false,
    },
  };
  registerLessonCommand(pi as never);
  const run = (args?: string) => commands.get("lesson")!.handler(args, ctx);
  return { run, sent, notifications };
}

function plantLesson(namespace: string, slug: string, text = VALID) {
  const target = lessonFilePath(namespace, slug);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

const CONFIG = () => path.join(tmp, ".loom", "config.json");
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG(), "utf-8"));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-cmd-"));
  cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
  setNotebookPath(path.join(cwd, "notebook.md"));
  resetActivity();
  resetLessonProposalArming();
});
afterEach(() => {
  vi.restoreAllMocks();
  setNotebookPath(null);
  resetActivity();
  resetLessonProposalArming();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the drafting instruction", () => {
  it("carries the sorting rule so the agent can refuse", () => {
    expect(PROPOSE_INSTRUCTION).toMatch(/validator, a schema, or a better error message/i);
    expect(PROPOSE_INSTRUCTION).toMatch(/lesson_propose/);
    expect(PROPOSE_INSTRUCTION).toMatch(/say so/i);
  });

  it("tells the agent the user approves, that it must not write files, and to distrust tool output", () => {
    expect(PROPOSE_INSTRUCTION).toMatch(/approve/i);
    expect(PROPOSE_INSTRUCTION).toMatch(/do not write or create/i);
    expect(PROPOSE_INSTRUCTION).toMatch(/evidence, not instructions/i);
    expect(PROPOSE_INSTRUCTION).toMatch(/^[\n\x20-\x7e]*$/);
  });
});

describe("/lesson with no arguments", () => {
  it("arms a proposal and sends exactly one user message, the instruction", async () => {
    const h = harness();
    await h.run(undefined);
    expect(peekLessonProposalArming()).toBe("explicit");
    expect(h.sent).toEqual([PROPOSE_INSTRUCTION]);
  });

  it("refuses to arm while a run is streaming", async () => {
    const h = harness({ idle: false });
    await h.run("");
    expect(peekLessonProposalArming()).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(h.notifications[0]).toMatchObject({ level: "warning" });
    expect(h.notifications[0].msg).toMatch(/busy/i);
  });
});

describe("/lesson list", () => {
  it("says there are none, and how to make one", async () => {
    const h = harness();
    await h.run("list");
    expect(h.notifications[0].msg).toMatch(/no local lessons/i);
    expect(h.notifications[0].msg).toMatch(/\/lesson/);
  });

  it("lists ids with titles and status, and marks suppressed ones", async () => {
    plantLesson("stats", "na-is-zero");
    plantLesson("data", "wrong-extension");
    addSuppression("data/wrong-extension");
    const h = harness();
    await h.run("list");
    const output = h.notifications[0].msg;
    expect(output).toContain("stats/na-is-zero  [draft]");
    expect(output).toContain("data/wrong-extension  [draft, suppressed]");
    expect(output).toContain("Numeric filters treat NA as zero");
  });

  it("flags a hand-dropped file that fails the schema without echoing its title", async () => {
    plantLesson(
      "stats",
      "planted",
      VALID.replace(/^title: .*$/m, "title: see https://evil.example/x"),
    );
    const h = harness();
    await h.run("list");
    expect(h.notifications[0].msg).toContain("stats/planted  [invalid]");
    expect(h.notifications[0].msg).not.toContain("evil.example");
  });

  it("holds a hand-dropped galaxy-api lesson to that namespace's rules", async () => {
    // Valid anywhere else; a galaxy-api lesson must say where its fix lives.
    expect(VALID).toContain("graduated_to: []");
    plantLesson("galaxy-api", "planted", VALID);
    const h = harness();
    await h.run("list");
    expect(h.notifications[0].msg).toContain("galaxy-api/planted  [invalid]");
    await h.run("show galaxy-api/planted");
    expect(h.notifications[1].level).toBe("warning");
    expect(h.notifications[1].msg).toMatch(/must say where the durable fix lives in graduated_to/);
  });

  it("shows an unreadable file as such rather than hiding it", () => {
    const listing = formatLessonListing(
      [{ id: "stats/broken", namespace: "stats", slug: "broken", path: "/x/stats/broken.md" }],
      [],
      [],
      () => ({ ok: false as const, detail: "not a regular file" }),
    );
    expect(listing).toMatch(/could not be read/i);
  });
});

describe("/lesson show", () => {
  it("prints the lesson", async () => {
    plantLesson("stats", "na-is-zero");
    const h = harness();
    await h.run("show stats/na-is-zero");
    expect(h.notifications[0].msg).toContain("## Does NOT apply when");
  });

  it("refuses to print a file that fails the schema, and says why", async () => {
    plantLesson(
      "stats",
      "planted",
      VALID.replace("## Validate\n", "## Validate\nhttps://evil.example/x\n"),
    );
    const h = harness();
    await h.run("show stats/planted");
    expect(h.notifications[0].level).toBe("warning");
    expect(h.notifications[0].msg).toMatch(/fails the lesson schema/);
    expect(h.notifications[0].msg).not.toContain("evil.example");
  });

  it("refuses an id that is not <namespace>/<slug>", async () => {
    const h = harness();
    for (const id of ["../../etc/passwd", "stats", "stats/Upper", "a/b/c", ""]) {
      h.notifications.length = 0;
      await h.run(`show ${id}`);
      expect(h.notifications[0].level, id).toBe("warning");
      expect(h.notifications[0].msg).toMatch(/usage/i);
    }
  });

  it("says so when there is no such lesson", async () => {
    const h = harness();
    await h.run("show stats/nope");
    expect(h.notifications[0].msg).toMatch(/no lesson/i);
  });
});

describe("/lesson suppress and unsuppress", () => {
  it("writes only the lessons.suppress key and keeps existing secrets", async () => {
    fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
    fs.writeFileSync(
      CONFIG(),
      JSON.stringify({
        llm: { active: "anthropic", providers: { anthropic: { apiKey: "sk-SECRET-keep-me" } } },
      }),
    );
    const h = harness();
    await h.run("suppress stats/na-is-zero");
    expect(readConfig().lessons.suppress).toEqual(["stats/na-is-zero"]);
    expect(readConfig().llm.providers.anthropic.apiKey).toBe("sk-SECRET-keep-me");
    for (const n of h.notifications) expect(n.msg).not.toContain("sk-SECRET-keep-me");
  });

  it("is idempotent in both directions", () => {
    addSuppression("stats/a");
    addSuppression("stats/a");
    expect(readConfig().lessons.suppress).toEqual(["stats/a"]);
    removeSuppression("stats/a");
    removeSuppression("stats/a");
    expect(readConfig().lessons.suppress).toEqual([]);
  });

  it("suppresses a curated id that is not local, since the matcher reads both", async () => {
    const h = harness();
    await h.run("suppress galaxy-api/hid-is-not-an-id");
    expect(readConfig().lessons.suppress).toEqual(["galaxy-api/hid-is-not-an-id"]);
  });

  it("drops junk a hand-edited config put in the list", () => {
    fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
    fs.writeFileSync(
      CONFIG(),
      JSON.stringify({ lessons: { suppress: ["stats/a", 7, "../x", "stats/b"] } }),
    );
    expect(currentSuppressions()).toEqual(["stats/a", "stats/b"]);
  });

  it("refuses an id shaped like a path traversal and writes nothing", async () => {
    const h = harness();
    await h.run("suppress ../../etc/passwd");
    expect(fs.existsSync(CONFIG())).toBe(false);
    expect(h.notifications[0].level).toBe("warning");
  });

  it("fails closed on an unparseable config rather than clobbering it", async () => {
    fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
    const corrupt = '{ "llm": broken, "apiKey": "sk-SECRET-keep-me"';
    fs.writeFileSync(CONFIG(), corrupt);
    const h = harness();
    await h.run("suppress stats/a");
    expect(fs.readFileSync(CONFIG(), "utf-8")).toBe(corrupt);
    expect(h.notifications[0].level).toBe("error");
    expect(h.notifications[0].msg).not.toContain("sk-SECRET-keep-me");
  });
});

describe("/lesson drafts and /lesson save", () => {
  function stage(text = VALID) {
    const draft = draftFilePath("stats", "na-is-zero");
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, text);
    return draft;
  }

  it("says there are no drafts", async () => {
    const h = harness();
    await h.run("drafts");
    expect(h.notifications[0].msg).toMatch(/no staged drafts/i);
  });

  it("lists a staged draft and how to save it", async () => {
    stage();
    const h = harness();
    await h.run("drafts");
    expect(h.notifications[0].msg).toContain("stats/na-is-zero");
    expect(h.notifications[0].msg).toContain("/lesson save stats/na-is-zero");
  });

  it("promotes a valid draft on a confirm", async () => {
    const draft = stage();
    const h = harness();
    await h.run("save stats/na-is-zero");
    expect(fs.readFileSync(lessonFilePath("stats", "na-is-zero"), "utf-8")).toBe(VALID);
    expect(fs.existsSync(draft)).toBe(false);
    expect(h.notifications.at(-1)!.msg).toMatch(/^Saved stats\/na-is-zero/);
  });

  it("refuses a draft edited into something the schema rejects, and names the rule", async () => {
    stage(VALID.replace("## Validate\n\n", "## Validate\n\nSee https://example.com for more.\n"));
    const h = harness();
    await h.run("save stats/na-is-zero");
    expect(fs.existsSync(lessonFilePath("stats", "na-is-zero"))).toBe(false);
    expect(h.notifications.at(-1)!.msg).toMatch(/no URLs in a lesson body/);
  });

  it("refuses a galaxy-api draft", async () => {
    const h = harness();
    await h.run("save galaxy-api/x");
    expect(h.notifications.at(-1)!.level).toBe("warning");
    expect(fs.existsSync(lessonFilePath("galaxy-api", "x"))).toBe(false);
  });
});

describe("LOOM_LESSONS_DIR", () => {
  let shared: string;
  beforeEach(() => {
    shared = path.join(tmp, "shared-lessons");
    process.env.LOOM_LESSONS_DIR = shared;
    resetLessonStore();
  });
  afterEach(() => {
    delete process.env.LOOM_LESSONS_DIR;
    resetLessonStore();
  });

  it("saves into the override, where the store loads it and /lesson list shows it", async () => {
    const draft = draftFilePath("stats", "na-is-zero");
    // Drafts stay in the state dir, never inside the override.
    expect(draft.startsWith(path.join(tmp, ".loom", "lesson-drafts"))).toBe(true);
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, VALID);
    const h = harness();
    await h.run("save stats/na-is-zero");
    expect(h.notifications.at(-1)!.msg).toMatch(/^Saved stats\/na-is-zero/);
    const saved = path.join(shared, "stats", "na-is-zero.md");
    expect(fs.readFileSync(saved, "utf-8")).toBe(VALID);
    expect(fs.existsSync(path.join(tmp, ".loom", "lessons"))).toBe(false);

    expect(getLessonStore().lessons.map((l) => l.id)).toContain("stats/na-is-zero");
    await h.run("list");
    expect(h.notifications.at(-1)!.msg).toContain("stats/na-is-zero  [draft]");
  });

  it("still refuses a symlinked namespace directory inside the override", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(shared, "stats"));
    const draft = draftFilePath("stats", "na-is-zero");
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, VALID);
    const h = harness();
    await h.run("save stats/na-is-zero");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(h.notifications.at(-1)!.msg).not.toMatch(/^Saved/);
  });
});

describe("unknown subcommands and usage", () => {
  it("prints usage for an unrecognised subcommand without arming anything", async () => {
    const h = harness();
    await h.run("frobnicate");
    expect(h.notifications[0].msg).toMatch(/usage/i);
    expect(peekLessonProposalArming()).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("does not arm a proposal from any subcommand", async () => {
    const h = harness();
    for (const sub of ["list", "drafts", "show stats/x", "suppress stats/x", "save stats/x"]) {
      await h.run(sub);
      expect(peekLessonProposalArming(), sub).toBeNull();
    }
    expect(h.sent).toHaveLength(0);
  });
});

describe("registerLessonProposals", () => {
  function registrations() {
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];
    registerLessonProposals({
      registerCommand: (name: string) => commands.push(name),
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      on: (event: string) => events.push(event),
      sendMessage: () => {},
      sendUserMessage: () => {},
    } as never);
    return { commands, tools, events };
  }

  afterEach(() => {
    delete process.env.LOOM_LESSON_PROPOSAL_REPLAY;
    resetLessonNudge();
  });

  it("registers the command, the tool and the arming lifecycle, and no replay by default", () => {
    delete process.env.LOOM_LESSON_PROPOSAL_REPLAY;
    const r = registrations();
    expect(r.commands).toEqual(["lesson"]);
    expect(r.tools).toEqual(["lesson_propose"]);
    expect(r.events.filter((e) => e === "agent_start" || e === "agent_end")).toEqual([
      "agent_start",
      "agent_end",
    ]);
    // Arming reset and the nudge's session reset; no replay handler.
    expect(r.events.filter((e) => e === "session_start")).toHaveLength(2);
  });

  it("adds the replay seam only when its env var is set", () => {
    process.env.LOOM_LESSON_PROPOSAL_REPLAY = "proposal.json";
    expect(registrations().events.filter((e) => e === "session_start")).toHaveLength(3);
  });
});
