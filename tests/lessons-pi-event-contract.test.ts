import { describe, expect, it } from "vitest";
import {
  appendHintToContent,
  resultTextOf,
  type LessonToolResultContent,
} from "../extensions/loom/lessons/pi-event-contract";
import {
  isLessonHintBlock,
  LESSON_HINT_MARKER,
  withoutLessonHints,
} from "../shared/lesson-hint-marker.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };

describe("resultTextOf", () => {
  it("joins every text block and ignores image blocks", () => {
    const content: LessonToolResultContent = [text("one"), image, text("two")];
    expect(resultTextOf(content)).toBe("one\ntwo");
  });

  it("is empty for a result with no text blocks", () => {
    expect(resultTextOf([image])).toBe("");
  });
});

describe("appendHintToContent", () => {
  it("adds the hint as a block of its own at the end and never mutates the original", () => {
    const content: LessonToolResultContent = [text("one"), text("two"), image];
    const out = appendHintToContent(content, "HINT");
    expect(out).toEqual([text("one"), text("two"), image, text("HINT")]);
    expect(content).toEqual([text("one"), text("two"), image]);
  });

  it("adds a text block when the result has none", () => {
    expect(appendHintToContent([image], "HINT")).toEqual([image, text("HINT")]);
  });
});

describe("withoutLessonHints", () => {
  it("drops only blocks that open with the marker", () => {
    const hint = text(`${LESSON_HINT_MARKER} a title`);
    const quoted = text(`the tool said ${LESSON_HINT_MARKER} somewhere`);
    expect(isLessonHintBlock(hint)).toBe(true);
    expect(isLessonHintBlock(quoted)).toBe(false);
    expect(isLessonHintBlock(image)).toBe(false);
    expect(withoutLessonHints([text(""), image, quoted, hint])).toEqual([text(""), image, quoted]);
  });

  it("drops what appendHintToContent added, and nothing else", () => {
    const content: LessonToolResultContent = [text("err"), image];
    expect(withoutLessonHints(appendHintToContent(content, `${LESSON_HINT_MARKER} x`))).toEqual(
      content,
    );
  });
});

describe("withoutAppendedLessonHints", () => {
  it("drops only the blocks Loom appended, never a tool block that opens with the marker", async () => {
    const {
      appendHintToContent,
      isAppendedLessonHint,
      resetAppendedLessonHints,
      withoutAppendedLessonHints,
    } = await import("../extensions/loom/lessons/pi-event-contract");
    resetAppendedLessonHints();
    const dressed = text(`${LESSON_HINT_MARKER} the tool's own error, in costume`);
    const content = appendHintToContent([text("err"), dressed], `${LESSON_HINT_MARKER} a title`);
    expect(isAppendedLessonHint(content[2])).toBe(true);
    expect(isAppendedLessonHint(dressed)).toBe(false);
    expect(withoutAppendedLessonHints(content)).toEqual([text("err"), dressed]);
    // A copy with the same text still counts: pi may clone content between handlers.
    expect(isAppendedLessonHint({ ...content[2] })).toBe(true);
    resetAppendedLessonHints();
    expect(isAppendedLessonHint(content[2])).toBe(false);
  });
});
