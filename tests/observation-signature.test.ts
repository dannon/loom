import { describe, expect, it } from "vitest";
import {
  SIGNATURE_MAX,
  UNKNOWN_SIGNATURE,
  normalizeSignature,
} from "../shared/observation-contract.js";
import { normalizeSignature as corpusNormalize } from "../lessons/validate.mjs";

describe("normalizeSignature", () => {
  const table: [string, string, string][] = [
    ["first line only", "ValueError: boom\n  at frame one\n  at frame two", "ValueError: boom"],
    ["collapses whitespace", "a   b\t\tc ", "a b c"],
    ["url", "fetch https://usegalaxy.org/api/histories/abc?x=1 failed", "fetch <url> failed"],
    ["email", "owned by ada@example.org now", "owned by <email> now"],
    ["posix path", "read /home/ada/data/x.gtf failed", "read <path> failed"],
    ["tilde path", "read ~/data/x.gtf failed", "read <path> failed"],
    ["windows path", "read C:\\Users\\ada\\x.gtf failed", "read <path> failed"],
    ["16+ hex becomes an id", "history f2db41e1fa331b3e missing", "history <id> missing"],
    ["shorter hex is left alone", "build mm39 rev f2db41", "build mm39 rev f2db41"],
    ["5+ digits become n", "dataset 123456 of 4321", "dataset <n> of 4321"],
    ["a 16-digit run is an id, not a number", "job 1234567890123456 died", "job <id> died"],
    ["url wins over the path inside it", "GET https://x.org/a/b", "GET <url>"],
    ["prose with one slash is not a path", "use and/or skip /etc", "use and/or skip /etc"],
    ["case is preserved", "No Reference Index", "No Reference Index"],
  ];
  for (const [name, input, expected] of table) {
    it(name, () => expect(normalizeSignature(input)).toBe(expected));
  }

  it("truncates to 200", () => {
    expect(normalizeSignature("x".repeat(400))).toHaveLength(SIGNATURE_MAX);
  });

  it('returns "unknown" for nothing usable', () => {
    for (const input of ["", "   ", "\n\n", null, undefined]) {
      expect(normalizeSignature(input)).toBe(UNKNOWN_SIGNATURE);
    }
  });

  it("is idempotent, so an already-normalized signature survives", () => {
    const once = normalizeSignature("read /home/ada/x.gtf for history f2db41e1fa331b3e");
    expect(normalizeSignature(once)).toBe(once);
  });

  // The corpus was normalized by lessons/validate.mjs. If the two drift, a
  // lesson signature stops matching the tool result it was written from.
  it("agrees with the corpus validator's copy on random input", () => {
    const alphabet = "aZ09 /\\~:@._-<>|\"'`\n\tfF://https.org" + "0123456789abcdef";
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let n = 0; n < 2000; n++) {
      let s = "";
      const len = Math.floor(rand() * 120);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      expect(normalizeSignature(s), JSON.stringify(s)).toBe(corpusNormalize(s));
    }
  });
});
