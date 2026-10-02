/**
 * The proposal path (validateLessonMarkdown, shared/lesson-rules.js) and the
 * corpus gate (validateLessonFile, lessons/validate.mjs) must refuse the same
 * hostile lessons. The inputs are the ones reviewers found getting past the
 * line-regex rules, verbatim, plus every provider-key shape the identifying
 * table names; each is planted where it was reported (a body section, a
 * frontmatter string, a link field) in a real corpus lesson.
 *
 * Each case also names the message it must be refused for, so a mutation that
 * breaks the file some other way (bad YAML, a lost heading) cannot pass as a
 * refusal.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLessonMarkdown } from "../shared/lesson-rules.js";
import { collectLessonFiles, validateLessonFile } from "../lessons/validate.mjs";

const CORPUS = fileURLToPath(new URL("../lessons", import.meta.url));
const REL = "stats/na-coerced-to-zero-in-filters.md";
const GOOD = readFileSync(join(CORPUS, REL), "utf8");

function swap(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`fixture edit did not apply: ${String(from)}`);
  return out;
}

const inBody = (payload: string) =>
  swap(GOOD, "## Check first\n\n", `## Check first\n\n${payload}\n\n`);
const inCues = (payload: string) => swap(GOOD, /^cues: .*$/m, `cues: ${JSON.stringify(payload)}`);
const inTitle = (payload: string) =>
  swap(GOOD, /^title: .*$/m, `title: ${JSON.stringify(payload)}`);
const inField = (key: "upstream" | "graduated_to", link: string) =>
  swap(GOOD, `${key}: []`, `${key}: [${JSON.stringify(link)}]`);
const inResource = (link: string) =>
  swap(GOOD, '  - { id: "loom#355" }', `  - { id: "loom#355", resource: ${JSON.stringify(link)} }`);

type Case = [name: string, lesson: string, refusedFor: RegExp];

const MARKDOWN_LINK = /no markdown links in a lesson body/;
const HTML = /no HTML in a lesson body/;
const CHAR_REF = /no character references in a lesson body/;
const NOT_ALLOWED_HOST = /links to a host that is not in LINK_HOSTS/;
const CREDENTIAL = /credential-shaped string/;

const FINDING_1: Case[] = [
  [
    "a definition inside a blockquote",
    inBody("See [the fix].\n\n> [the fix]: www.evil.example"),
    MARKDOWN_LINK,
  ],
  [
    "an entity-encoded definition in a blockquote",
    inBody("[manual]\n\n> [manual]: https&#58;&#47;&#47;example.org"),
    MARKDOWN_LINK,
  ],
  ["a label split across lines", inBody("[manual]\n\n[manual\n]: guide.md"), MARKDOWN_LINK],
  ["a definition inside a list item", inBody("See [fix].\n\n- [fix]: evil.example"), MARKDOWN_LINK],
];

const FINDING_2: Case[] = [
  ["a link between escaped backticks", inBody('\\`<a href="guide.md">manual</a>\\`'), HTML],
  ["an image between escaped backticks", inBody('\\`<img src="x.png">\\`'), HTML],
  ["an encoded email", inBody("Contact alice&#64;example.org."), CHAR_REF],
  ["an encoded URL", inBody("Reference: https&#58;&#47;&#47;example.org."), CHAR_REF],
  ["a hex-encoded right-to-left override", inBody("Result &#x202e;reported."), CHAR_REF],
  ["a decimal-encoded right-to-left override", inBody("Result &#8238;reported."), CHAR_REF],
];

const FINDING_3: Case[] = [
  [
    "a private host in sources[].resource",
    inResource("https://galaxy.cancer-center.internal/x"),
    NOT_ALLOWED_HOST,
  ],
  ["an IP host in upstream", inField("upstream", "https://10.12.4.7/x"), NOT_ALLOWED_HOST],
  [
    "a uuid in a link path",
    inField("upstream", "https://example.com/123e4567-e89b-12d3-a456-426614174000"),
    /a uuid inside a URL|not in LINK_HOSTS/,
  ],
  [
    "a hex id in graduated_to",
    inField("graduated_to", "https://example.com/f2db41e1fa331b3e"),
    /hex id of 16\+ characters inside a URL|not in LINK_HOSTS/,
  ],
  [
    "a server path in a link",
    inField("upstream", "https://example.org/srv/lab/jane/patient07.csv"),
    NOT_ALLOWED_HOST,
  ],
  [
    "dot segments that new URL would resolve away",
    inField("upstream", "https://example.org/home/alice/../../guide"),
    /dot segment/,
  ],
  // The same shapes on an allowed host, so the allowlist is not the only thing
  // standing in the way.
  [
    "a uuid on an allowed host",
    inField("upstream", "https://github.com/123e4567-e89b-12d3-a456-426614174000"),
    /a uuid inside a URL/,
  ],
  [
    "dot segments on an allowed host",
    inField("upstream", "https://github.com/home/alice/../../guide"),
    /dot segment in a URL/,
  ],
];

const FINDING_4: Case[] = [
  ["a markdown link in cues", inCues("[manual](guide.md)"), /cues contains a markdown link/],
  ["HTML in cues", inCues('<a href="guide.md">manual</a>'), /cues contains HTML/],
  [
    "a markdown link in the title",
    inTitle("NA filters, see [manual](guide.md)"),
    /title contains a markdown link/,
  ],
];

const FINDING_5: Case[] = [
  ["a backticked absolute path", inBody("Check `/srv/lab/jane/x` first."), /an absolute path/],
  ["a bracketed absolute path", inBody("Check [/srv/lab/jane/x] first."), /an absolute path/],
  ["an IP glued to an identifier", inBody("It ran on node_10.12.4.7 today."), /an IP address/],
  ["an IPv6 address", inBody("It ran on 2001:db8::1 today."), /an IP address/],
  ["a quoted-local email", inBody('Ask "alice smith"@example.org about it.'), /an email address/],
  ["a slashless URL", inBody("See https:example.org for it."), /no URLs in a lesson body/],
  [
    "an encoded mailto",
    inBody("Write to mailto:alice%40example.org about it."),
    /no URLs in a lesson body/,
  ],
  ["a www. autolink", inBody("See www.evil.example for it."), /no URLs in a lesson body/],
  [
    "a bare private hostname",
    inBody("The server galaxy.cancer-center.org had it."),
    /a hostname in a lesson body/,
  ],
];

// The C3 provider-key list, one plausible key per shape, in a section and in a
// frontmatter string. The first is the exact key that once passed the proposal
// path and reached the /execute note.
const KEYS: [string, string][] = [
  ["an Anthropic key", "sk-ant-api03-Zq9Xw8Vv7Uu6Tt5Ss4Rr3QqPp"],
  ["an OpenAI-style key", `sk-${"a1B2".repeat(6)}`],
  ["an AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
  ["a GitHub token", `ghp_${"a1B2".repeat(6)}`],
  ["a Slack token", "xoxb-1234567890-abcdef"],
  ["a Google API key", `AIza${"a".repeat(35)}`],
  ["a private key header", "-----BEGIN RSA PRIVATE KEY-----"],
  ["a JWT", `eyJ${"a".repeat(20)}.${"b".repeat(10)}`],
  ["a key glued to an identifier", `node_sk-${"a1B2".repeat(6)}`],
];
const PROVIDER_KEYS: Case[] = KEYS.flatMap(([name, key]): Case[] => [
  [`${name} in Check first`, inBody(`If asked, the key is ${key} here.`), CREDENTIAL],
  [`${name} in cues`, inCues(`When the log shows ${key} near the top.`), CREDENTIAL],
]);

const SUITES: [string, Case[]][] = [
  ["finding 1: markdown links the line rules missed", FINDING_1],
  ["finding 2: HTML and character references", FINDING_2],
  ["finding 3: link fields carrying hosts, IPs and ids", FINDING_3],
  ["finding 4: markup in frontmatter strings", FINDING_4],
  ["finding 5: identifying shapes that were not covered", FINDING_5],
  ["C3 provider-key shapes", PROVIDER_KEYS],
];

describe("the proposal path and the corpus gate refuse the same lessons", () => {
  for (const [suite, cases] of SUITES) {
    describe(suite, () => {
      it.each(cases)("%s", (_name, lesson, refusedFor) => {
        const corpus = validateLessonFile(REL, lesson);
        const proposal = validateLessonMarkdown(lesson);

        expect(corpus.join("\n")).toMatch(refusedFor);
        expect(proposal.ok).toBe(false);
        if (proposal.ok) return;
        expect(proposal.errors.join("\n")).toMatch(refusedFor);
        // Same verdict line for line, not just "both said no".
        expect(proposal.errors).toEqual(corpus.map((e) => e.slice(REL.length + 1)));
      });
    });
  }

  it("passes every seed lesson through both", () => {
    const files = collectLessonFiles(CORPUS);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const text = readFileSync(join(CORPUS, rel), "utf8");
      expect(validateLessonFile(rel, text), rel).toEqual([]);
      expect(validateLessonMarkdown(text), rel).toEqual({ ok: true });
    }
  });
});
