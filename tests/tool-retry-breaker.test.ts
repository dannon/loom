import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  errorFirstLine,
  formatRetryNote,
  RETRY_BREAKER_MARKER,
  registerToolRetryBreaker,
} from "../extensions/orbit/tool-retry-breaker";
import { appendHintToContent } from "../extensions/orbit/lessons/pi-event-contract";
import { LESSON_HINT_MARKER } from "../shared/lesson-hint-marker.js";

type Content = { type: "text"; text: string }[];

interface ResultOpts {
  text?: string;
  content?: Content;
  isError?: boolean;
  details?: unknown;
  structuredContent?: unknown;
  signal?: AbortSignal;
  parentToolCallId?: string;
}

function breaker() {
  const on = vi.fn();
  registerToolRetryBreaker({ on } as unknown as ExtensionAPI);
  const fire = (name: string, event: unknown, ctx?: unknown) =>
    on.mock.calls.find(([key]) => key === name)![1](event, ctx);
  let n = 0;
  const turn = () => fire("turn_start", { type: "turn_start" });
  // One result, as pi delivers it inside the current turn.
  const result = (toolName: string, input: Record<string, unknown>, opts: ResultOpts = {}) =>
    fire(
      "tool_result",
      {
        toolName,
        toolCallId: `c${++n}`,
        parentToolCallId: opts.parentToolCallId,
        input,
        content: opts.content ?? [{ type: "text", text: opts.text ?? "boom" }],
        isError: opts.isError ?? true,
        details: opts.details,
        structuredContent: opts.structuredContent,
      },
      { signal: opts.signal },
    ) as { content: Content; structuredContent?: unknown } | undefined;
  // One model turn that made a single call.
  const attempt = (toolName: string, input: Record<string, unknown>, opts: ResultOpts = {}) => {
    turn();
    return result(toolName, input, opts);
  };
  return { fire, turn, result, attempt };
}

const noted = (r: { content: Content } | undefined) =>
  r?.content.some((b) => b.text.startsWith(RETRY_BREAKER_MARKER)) ?? false;

const COLLECTION_ERROR =
  'Not proposed -- fix these and call loom_propose again:\n- input slot "reads" takes a dataset (src hda or ldda), not a collection';

describe("registerToolRetryBreaker", () => {
  it("notes the third identical failure, as a rejection loom_propose returns in details", () => {
    const b = breaker();
    const input = { target: { kind: "tool", id: "x" }, inputs: [{ slot: "reads", src: "hdca" }] };
    const reject = () =>
      b.attempt("loom_propose", input, {
        text: COLLECTION_ERROR,
        isError: false,
        details: { error: true, problems: ["..."] },
      });
    expect(reject()).toBeUndefined();
    expect(reject()).toBeUndefined();
    expect(reject()?.content).toEqual([
      { type: "text", text: COLLECTION_ERROR },
      { type: "text", text: formatRetryNote("loom_propose", 3) },
    ]);
  });

  it("counts a details.error that carries the message instead of true", () => {
    const b = breaker();
    const fail = () =>
      b.attempt("team_dispatch", { a: 1 }, { isError: false, details: { error: "no model" } });
    fail();
    fail();
    expect(noted(fail())).toBe(true);
  });

  it("keeps noting while the streak goes on", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.attempt("create_user_tool", { a: 1 });
    expect(b.attempt("create_user_tool", { a: 1 })?.content.at(-1)).toEqual({
      type: "text",
      text: formatRetryNote("create_user_tool", 4),
    });
  });

  it("keys on the arguments' content, not their key order", () => {
    const b = breaker();
    b.attempt("t", { a: 1, b: { c: 2, d: 3 } });
    b.attempt("t", { b: { d: 3, c: 2 }, a: 1 });
    expect(noted(b.attempt("t", { a: 1, b: { c: 2, d: 3 } }))).toBe(true);
  });

  it("does not count a different error", () => {
    const b = breaker();
    b.attempt("t", { a: 1 }, { text: "outputs[0].data.multiple: extra_forbidden" });
    b.attempt("t", { a: 1 }, { text: "outputs[0].data.multiple: extra_forbidden" });
    expect(noted(b.attempt("t", { a: 1 }, { text: "inputs[0].name: field required" }))).toBe(false);
  });

  it("does not count different arguments or a different tool", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    expect(noted(b.attempt("t", { a: 2 }))).toBe(false);
    b.attempt("t", { a: 2 });
    expect(noted(b.attempt("u", { a: 2 }))).toBe(false);
  });

  it("starts over after a turn that did something else", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    b.attempt("read", { path: "x" }, { isError: false });
    b.attempt("t", { a: 1 });
    expect(noted(b.attempt("t", { a: 1 }))).toBe(false);
    expect(noted(b.attempt("t", { a: 1 }))).toBe(true);
  });

  it("starts over after a turn with no tool call at all, such as asking the user", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    b.turn(); // the model asks; the user answers "try once more"
    expect(noted(b.attempt("t", { a: 1 }))).toBe(false);
  });

  it("starts over when the same call succeeds", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 }, { isError: false });
    expect(noted(b.attempt("t", { a: 1 }))).toBe(false);
  });

  it("is not reset by another call that finishes in the same batch", () => {
    const b = breaker();
    let last;
    for (let i = 0; i < 3; i++) {
      b.turn();
      b.result("read", { path: "x" }, { isError: false });
      last = b.result("t", { a: 1 });
    }
    expect(noted(last)).toBe(true);
  });

  it("counts copies of one call in a single batch as one try", () => {
    const b = breaker();
    b.turn();
    expect(noted(b.result("t", { a: 1 }))).toBe(false);
    expect(noted(b.result("t", { a: 1 }))).toBe(false);
    expect(noted(b.result("t", { a: 1 }))).toBe(false);
  });

  it("does not count the same first line when only the arguments differ", () => {
    const b = breaker();
    b.attempt("t", { a: 1 }, { text: "boom" });
    b.attempt("t", { a: 2 }, { text: "boom" });
    expect(noted(b.attempt("t", { a: 3 }, { text: "boom" }))).toBe(false);
  });

  // Only the first line is compared, so a rejection listing different problems
  // under the same heading counts as the same; with identical args it nearly
  // always is, and comparing less keeps the rule free of masking heuristics.
  it("treats errors that share a first line but differ below it as the same", () => {
    const b = breaker();
    b.attempt("t", { a: 1 }, { text: "Not proposed -- fix these:\n- slot reads" });
    b.attempt("t", { a: 1 }, { text: "Not proposed -- fix these:\n- slot mode|reads" });
    expect(
      noted(b.attempt("t", { a: 1 }, { text: "  Not proposed -- fix these:  \n- slot other" })),
    ).toBe(true);
  });

  it("compares the first line exactly, with nothing masked", () => {
    const b = breaker();
    b.attempt("t", { a: 1 }, { text: "Job 4521 failed: tool exited with code 1" });
    b.attempt("t", { a: 1 }, { text: "Job 4537 failed: tool exited with code 1" });
    expect(
      noted(b.attempt("t", { a: 1 }, { text: "Job 4590 failed: tool exited with code 1" })),
    ).toBe(false);
  });

  it("tells apart first lines that differ only far into a huge line", () => {
    const b = breaker();
    const head = "x".repeat(20 * 1024);
    b.attempt("t", { a: 1 }, { text: `${head} 1` });
    b.attempt("t", { a: 1 }, { text: `${head} 2` });
    expect(noted(b.attempt("t", { a: 1 }, { text: `${head} 3` }))).toBe(false);
  });

  it("stays cheap on huge arguments and errors", () => {
    const b = breaker();
    const input = {
      data: "a".repeat(5_000_000),
      rows: Array.from({ length: 50_000 }, (_, i) => i),
    };
    const text = "e".repeat(2_000_000) + "\n" + "f".repeat(5_000_000);
    const start = performance.now();
    b.attempt("t", input, { text });
    b.attempt("t", input, { text });
    const last = b.attempt("t", input, { text });
    expect(performance.now() - start).toBeLessThan(3000);
    expect(noted(last)).toBe(true);
  });

  it("does not count successes", () => {
    const b = breaker();
    for (let i = 0; i < 4; i++) {
      expect(
        b.attempt("t", { a: 1 }, { isError: false, details: { error: false } }),
      ).toBeUndefined();
    }
  });

  it("does not count a call the user stopped", () => {
    const b = breaker();
    const stopped = new AbortController();
    stopped.abort();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    // Same error text as the real failures, so only the abort skip keeps it
    // from being the third strike.
    expect(b.attempt("t", { a: 1 }, { signal: stopped.signal })).toBeUndefined();
  });

  it("ignores calls another tool made", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) {
      expect(b.attempt("t", { a: 1 }, { parentToolCallId: "p" })).toBeUndefined();
    }
  });

  // Empty tool text is the case that matters: with any text of its own, the
  // hint block lands below the first line and never reaches the comparison.
  it("compares errors without a lesson hint Orbit appended to one of them", () => {
    const b = breaker();
    const base: Content = [{ type: "text", text: "" }];
    b.attempt(
      "t",
      { a: 1 },
      { content: appendHintToContent(base, `${LESSON_HINT_MARKER} x`) as Content },
    );
    b.attempt("t", { a: 1 }, { content: base });
    expect(noted(b.attempt("t", { a: 1 }, { content: base }))).toBe(true);
  });

  it("hands structured content back with the note", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    expect(b.attempt("t", { a: 1 }, { structuredContent: { ok: false } })).toMatchObject({
      structuredContent: { ok: false },
    });
  });

  it("starts over with a new session", () => {
    const b = breaker();
    b.attempt("t", { a: 1 });
    b.attempt("t", { a: 1 });
    b.fire("session_start", {});
    expect(noted(b.attempt("t", { a: 1 }))).toBe(false);
  });
});

describe("errorFirstLine", () => {
  it("takes the first non-blank line, trimmed", () => {
    expect(errorFirstLine("\n  outputs[0].data.multiple: extra_forbidden  \n  more")).toBe(
      "outputs[0].data.multiple: extra_forbidden",
    );
    expect(errorFirstLine("one line\r\nnext")).toBe("one line");
  });
});
