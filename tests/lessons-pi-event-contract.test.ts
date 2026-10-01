import { describe, expect, it } from "vitest";
import {
  appendHintToContent,
  resultTextOf,
  type LessonToolResultContent,
} from "../extensions/loom/lessons/pi-event-contract";

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
  it("appends to the LAST text block and never mutates the original", () => {
    const content: LessonToolResultContent = [text("one"), text("two"), image];
    const out = appendHintToContent(content, "HINT");
    expect(out).toEqual([text("one"), text("two\n\nHINT"), image]);
    expect(content[1]).toEqual(text("two"));
  });

  it("adds a text block when the result has none", () => {
    expect(appendHintToContent([image], "HINT")).toEqual([image, text("HINT")]);
  });
});
