import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NUDGE_CUSTOM_TYPE,
  NUDGE_TEXT,
  isCorrectionObservation,
  registerLessonNudge,
  resetLessonNudge,
} from "../extensions/loom/lesson-nudge";
import { appendActivityEvent, loadActivityLog, resetActivity } from "../extensions/loom/activity";
import {
  peekLessonProposalArming,
  resetLessonProposalArming,
} from "../extensions/loom/lessons/propose";

// The lesson switch is off by default; these suites are about what happens
// once it is on. LOOM_LESSONS=on stands in for a config nobody wrote.
const prevLessonsSwitch = process.env.LOOM_LESSONS;
beforeAll(() => {
  process.env.LOOM_LESSONS = "on";
});
afterAll(() => {
  if (prevLessonsSwitch === undefined) delete process.env.LOOM_LESSONS;
  else process.env.LOOM_LESSONS = prevLessonsSwitch;
});

let tmp: string;

interface SentMessage {
  message: { customType: string; content: string; display: boolean };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

function harness({ hasUI = true }: { hasUI?: boolean } = {}) {
  const sentMessages: SentMessage[] = [];
  const sentUser: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) =>
      sentMessages.push({ message, options }),
    sendUserMessage: (text: string) => sentUser.push(text),
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
      handlers.set(event, handler),
  };
  registerLessonNudge(pi as never);
  const sessionStart = (ctx: { hasUI: boolean } = { hasUI }) =>
    handlers.get("session_start")!({}, ctx);
  // pi fires session_start before anything a user can do; the handler sets
  // its state synchronously, so nothing needs awaiting here.
  void sessionStart();
  return { sentMessages, sentUser, sessionStart };
}

/** What the observation collector records when the user files a correction with /observe. */
function emit(payload: Record<string, unknown>, kind = "observation.built", timestamp?: string) {
  appendActivityEvent(tmp, {
    timestamp: timestamp ?? new Date().toISOString(),
    kind,
    source: "observation-triggers",
    payload,
  });
}

const CORRECTION = { kind: "user-correction", trigger: "explicit", stage: "result-interpretation" };

/** The nudge is deferred with queueMicrotask; let it run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-nudge-"));
  resetActivity();
  resetLessonNudge();
  resetLessonProposalArming();
});
afterEach(() => {
  resetActivity();
  resetLessonNudge();
  resetLessonProposalArming();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isCorrectionObservation", () => {
  it("matches a user-correction observation under either row name", () => {
    for (const kind of ["observation.built", "observation.captured"]) {
      expect(
        isCorrectionObservation({ timestamp: "t", kind, source: "s", payload: CORRECTION }),
      ).toBe(true);
    }
  });

  it("keys off the payload kind, not the trigger", () => {
    // /observe sends trigger "explicit"; a user_correction trigger alone is not a correction.
    const rows = [
      { kind: "observation.built", payload: { trigger: "user_correction" } },
      { kind: "observation.built", payload: { kind: "silent-wrong-result", trigger: "explicit" } },
      { kind: "observation.built", payload: { kind: "tool-error" } },
      { kind: "observation.built", payload: {} },
      { kind: "observation.sent", payload: { kind: "user-correction" } },
      { kind: "observation.declined", payload: { kind: "user-correction" } },
      { kind: "tool.end", payload: { kind: "user-correction" } },
    ];
    for (const row of rows) {
      expect(
        isCorrectionObservation({ timestamp: "t", source: "s", ...row }),
        JSON.stringify(row),
      ).toBe(false);
    }
    expect(isCorrectionObservation(undefined as never)).toBe(false);
  });
});

describe("with no collector emitting anything", () => {
  it("does nothing at all -- /lesson is still the whole path", async () => {
    const h = harness();
    emit({}, "tool.end");
    emit({ kind: "tool-error", trigger: "tool_error" });
    await settle();
    expect(h.sentMessages).toHaveLength(0);
    expect(h.sentUser).toHaveLength(0);
    expect(peekLessonProposalArming()).toBeNull();
  });
});

describe("with a correction recorded", () => {
  it("arms a proposal for the correction and queues a next-turn message", async () => {
    const h = harness();
    emit(CORRECTION);
    await settle();
    expect(peekLessonProposalArming()).toBe("user_correction");
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0].message).toMatchObject({
      customType: NUDGE_CUSTOM_TYPE,
      content: NUDGE_TEXT,
    });
  });

  it("queues rather than triggering a turn, so nothing happens in the background", async () => {
    const h = harness();
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages[0].options?.deliverAs).toBe("nextTurn");
    expect(h.sentMessages[0].options?.triggerTurn).not.toBe(true);
    expect(h.sentUser).toHaveLength(0);
  });

  it("nudges at most once per session, however many corrections arrive", async () => {
    const h = harness();
    emit(CORRECTION);
    emit(CORRECTION);
    await settle();
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages).toHaveLength(1);
  });

  it("stays quiet without a UI, where lesson_propose could never be approved", async () => {
    const h = harness({ hasUI: false });
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages).toHaveLength(0);
    expect(peekLessonProposalArming()).toBeNull();
  });

  it("stays quiet before any session has said whether there is a UI", async () => {
    resetLessonNudge();
    const sentMessages: unknown[] = [];
    registerLessonNudge({
      sendMessage: (m: unknown) => sentMessages.push(m),
      sendUserMessage: () => {},
      on: () => {},
    } as never);
    emit(CORRECTION);
    await settle();
    expect(sentMessages).toHaveLength(0);
  });

  it("nudges again in a new session", async () => {
    const h = harness();
    emit(CORRECTION);
    await settle();
    await h.sessionStart();
    resetActivity();
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages).toHaveLength(2);
  });

  it("does not fire on rows that were already there when it subscribed", async () => {
    emit(CORRECTION);
    const h = harness();
    emit({ kind: "tool-error" });
    await settle();
    expect(h.sentMessages).toHaveLength(0);
  });

  it("never fires on rows a resumed session hydrates from disk, even ones dated in the future", async () => {
    // activity.jsonl sits in the workspace, so a planted row is as easy as an old one.
    const h = harness();
    const rows = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        kind: "observation.built",
        source: "s",
        payload: CORRECTION,
      },
      {
        timestamp: "2099-01-01T00:00:00.000Z",
        kind: "observation.built",
        source: "s",
        payload: CORRECTION,
      },
    ];
    fs.writeFileSync(
      path.join(tmp, "activity.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await h.sessionStart();
    loadActivityLog(tmp);
    await settle();
    expect(h.sentMessages).toHaveLength(0);
    expect(peekLessonProposalArming()).toBeNull();
    // A real correction afterwards still counts.
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages).toHaveLength(1);
  });

  it("survives a session swap that shrinks the array without skipping new rows", async () => {
    const h = harness();
    emit({ kind: "tool-error" });
    emit({ kind: "tool-error" });
    emit({ kind: "tool-error" });
    await settle();
    resetActivity();
    emit(CORRECTION);
    await settle();
    expect(h.sentMessages).toHaveLength(1);
  });

  it("does not re-enter pi from inside the activity write", () => {
    let insideAppend = false;
    const pi = {
      sendMessage: () => {
        if (insideAppend) throw new Error("sendMessage ran synchronously inside the append");
      },
      sendUserMessage: () => {},
      on: () => {},
    };
    registerLessonNudge(pi as never);
    insideAppend = true;
    expect(() => emit(CORRECTION)).not.toThrow();
    insideAppend = false;
  });
});

describe("the nudge text", () => {
  it("names lesson_propose, leaves the decision with the user, and carries the sorting rule", () => {
    expect(NUDGE_TEXT).toMatch(/lesson_propose/);
    expect(NUDGE_TEXT).toMatch(/correction/i);
    expect(NUDGE_TEXT).toMatch(/offer once/i);
    expect(NUDGE_TEXT).toMatch(/validator, a schema, or a better error message/i);
    expect(NUDGE_TEXT).not.toMatch(/you must/i);
    expect(NUDGE_TEXT).toMatch(/^[\n\x20-\x7e]*$/);
  });
});
