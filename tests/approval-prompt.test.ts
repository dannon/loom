import { describe, it, expect } from "vitest";
import {
  APPROVAL_DETAIL_LIMIT,
  buildApprovalPrompt,
  splitApprovalPrompt,
  truncateApprovalDetail,
} from "../shared/approval-prompt.js";

describe("truncateApprovalDetail", () => {
  it("leaves anything within the limit untouched", () => {
    const cmd = "python train.py --epochs 40";
    expect(truncateApprovalDetail(cmd)).toBe(cmd);
  });

  it("keeps commands far longer than the old 200-char cap intact", () => {
    const cmd = `echo ${"x".repeat(1500)}`;
    expect(truncateApprovalDetail(cmd)).toBe(cmd);
  });

  it("marks a truncated command with how much is hidden", () => {
    const cmd = "y".repeat(APPROVAL_DETAIL_LIMIT + 310);
    const out = truncateApprovalDetail(cmd);
    expect(out.startsWith("y".repeat(APPROVAL_DETAIL_LIMIT))).toBe(true);
    expect(out).toContain("truncated");
    // The user needs the real numbers to judge what they can't see.
    expect(out).toContain("310");
    expect(out).toContain(String(APPROVAL_DETAIL_LIMIT + 310));
  });

  it("honors an explicit limit", () => {
    expect(truncateApprovalDetail("abcdef", 3).startsWith("abc")).toBe(true);
    expect(truncateApprovalDetail("abcdef", 3)).toContain("truncated");
  });

  it("trims surrounding whitespace but preserves interior layout", () => {
    expect(truncateApprovalDetail("\n  ls -la\n\n")).toBe("ls -la");
    expect(truncateApprovalDetail("for f in *; do\n  echo $f\ndone")).toBe(
      "for f in *; do\n  echo $f\ndone",
    );
  });

  it("survives nullish input", () => {
    expect(truncateApprovalDetail(undefined as unknown as string)).toBe("");
    expect(truncateApprovalDetail(null as unknown as string)).toBe("");
  });
});

describe("buildApprovalPrompt", () => {
  it("puts the detail below a blank line so shells can split it back off", () => {
    expect(buildApprovalPrompt("Allow x to run this command?", "ls -la")).toBe(
      "Allow x to run this command?\n\nls -la",
    );
  });

  it("emits the heading alone when there is no detail", () => {
    expect(buildApprovalPrompt("Allow x to run this command?", "")).toBe(
      "Allow x to run this command?",
    );
    expect(buildApprovalPrompt("Allow x to run this command?", "   \n ")).toBe(
      "Allow x to run this command?",
    );
  });

  it("truncates the detail, never the heading", () => {
    const heading = "Allow x to run this command?";
    const out = buildApprovalPrompt(heading, "z".repeat(50), 10);
    expect(out.startsWith(`${heading}\n\n`)).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("splitApprovalPrompt", () => {
  it("round-trips what buildApprovalPrompt produced", () => {
    const heading = "Allow claude-opus-5 to run this command?";
    const detail = "cat <<'EOF' > run.sh\n  set -euo pipefail\n  ./go\nEOF";
    const split = splitApprovalPrompt(buildApprovalPrompt(heading, detail));
    expect(split.heading).toBe(heading);
    expect(split.detail).toBe(detail);
  });

  it("splits on the first blank line only, so the detail keeps its own", () => {
    const split = splitApprovalPrompt("Heading?\n\nfirst\n\nsecond");
    expect(split.heading).toBe("Heading?");
    expect(split.detail).toBe("first\n\nsecond");
  });

  it("treats a title with no blank line as heading-only", () => {
    const split = splitApprovalPrompt("Allow x to write this path?");
    expect(split.heading).toBe("Allow x to write this path?");
    expect(split.detail).toBe("");
  });

  it("tolerates CRLF and whitespace-only separator lines", () => {
    expect(splitApprovalPrompt("Heading?\r\n\r\nls -la")).toEqual({
      heading: "Heading?",
      detail: "ls -la",
    });
    expect(splitApprovalPrompt("Heading?\n   \nls -la")).toEqual({
      heading: "Heading?",
      detail: "ls -la",
    });
  });

  it("survives nullish input", () => {
    expect(splitApprovalPrompt(undefined as unknown as string)).toEqual({
      heading: "",
      detail: "",
    });
  });
});
