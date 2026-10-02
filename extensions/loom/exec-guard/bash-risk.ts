import * as path from "path";
import { WORKSPACE_STATE_DIR_NAMES } from "../workspace-state-dir";
import { isCredentialStore, isLoomStatePath } from "./sensitive-read";

export interface BashClass {
  kind: "safe" | "catastrophic" | "unknown";
  reason: string;
  /** Path-like args to read-style commands, for the policy layer to run through
   *  sensitive-read + jail. Best-effort; empty when not confidently parseable. */
  readPaths: string[];
  /** Content-read targets surfaced from EVERY shell segment, so the sensitive-read
   *  floor still fires when a pipe/compound forces kind="unknown" (closes the
   *  `cat secret | tool` evasion in #183). Unlike readPaths, this is computed even
   *  for compound commands; the policy layer applies only the sensitive floor to
   *  it (never the workspace-jail floor, so compound jail semantics are unchanged). */
  sensitiveReadPaths: string[];
  /** `.loom/`/`.orbit/` write targets this classifier judged to be ordinary work
   *  product in an Orbit analysis workspace. It only sees the command string, so the policy
   *  layer realpaths each one and re-applies isLoomStatePath -- a symlink under
   *  the analyses tree pointing at Loom's own state is still Loom's own state.
   *  Empty unless a write verb aimed at a state dir was carved out. */
  loomWriteTargets: string[];
  /** A command runs after a `cd`/`pushd` into Loom's own state or a credential
   *  store. The classifier cannot tell what an unrecognized command does there,
   *  so the policy layer must not auto-allow it. */
  guardedCwd: boolean;
}

// Never-legitimate, irreversible-system-damage patterns. Order matters; first match wins.
// `sudo` allows an absolute/relative path prefix (/usr/bin/sudo), and the
// pipe-to-interpreter rule covers path-prefixed and env-wrapped interpreters
// beyond bare POSIX shells (python/perl/node/...).
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/(^|[\s;&|])(\S*\/)?sudo\b/, "privilege escalation (sudo)"],
  [/:\s*\(\s*\)\s*\{.*:\|:.*\}/, "fork bomb"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "dd to a device"],
  [/\bmkfs(\.[a-z0-9]+)?\b/, "filesystem format"],
  [
    /(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(env\s+)?(\S*\/)?(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node|php)\b/,
    "pipe remote content to an interpreter",
  ],
  [/\bchmod\s+-R\s+777\s+\//, "world-writable recursive chmod on /"],
  [/>\s*\/dev\/(sd|nvme|disk)/, "redirect to a raw device"],
  // Self-disabling: editing the gate's own config is how an agent would try to
  // flip bypass on. The bypass key with an assignment is one signal; a write verb
  // aimed at Loom's own state is the other, and it needs a per-target decision, so
  // it lives in isCatastrophicLoomWrite below rather than in this table. Reads of
  // the config stay an `ask` via the sensitive-read floor (not caught here).
  [/dangerouslyBypassPermissions['"\]\s]*[:=]/, "attempt to enable the permissions bypass"],
];

// Every state-dir spelling, whichever one the workspace uses, as a regex
// alternation (`loom|orbit`).
const STATE_DIR_ALT = WORKSPACE_STATE_DIR_NAMES.map((n) => n.slice(1)).join("|");

// A write verb aimed at something under a `.loom/` or `.orbit/` directory. Only
// the trigger: whether it is really Loom state is decided per target below,
// because Orbit's own workspaces live under $HOME/.loom/analyses/<name>/.
const LOOM_WRITE = new RegExp(
  String.raw`(?:>>?|\btee\b|\bsed\b[^\n]*-i|\bcp\b|\bmv\b|\bdd\b)[^\n]*\.(?:${STATE_DIR_ALT})\/`,
  "i",
);

// Command wrappers that delegate to a real command. We strip them so a
// catastrophic command can't hide behind `env`, `conda run`, `nice`, etc.
const WRAPPER_CMDS = new Set([
  "nohup",
  "setsid",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "timeout",
  "caffeinate",
  "command",
  "exec",
  "builtin",
]);

function stripQuotes(s: string): string {
  return s.replace(/^['"]+|['"]+$/g, "");
}

// Peel leading wrapper commands (env VAR=val, conda run -p PATH, nice -n N, ...)
// off a token list so the real verb is exposed to the catastrophic check.
function unwrap(tokens: string[]): string[] {
  let t = tokens;
  for (;;) {
    if (t.length === 0) return t;
    const head = t[0];
    if (head === "env") {
      t = t.slice(1);
      while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1);
      continue;
    }
    if (head === "conda" && t[1] === "run") {
      t = t.slice(2);
      while (t.length && t[0].startsWith("-")) {
        const takesArg = ["-p", "--prefix", "-n", "--name"].includes(t[0]);
        t = t.slice(takesArg ? 2 : 1);
      }
      continue;
    }
    if (WRAPPER_CMDS.has(head)) {
      t = t.slice(1);
      while (t.length && t[0].startsWith("-")) t = t.slice(1);
      if (t.length && /^\d+[a-z]?$/i.test(t[0])) t = t.slice(1); // `timeout 5`, `nice 10`
      continue;
    }
    return t;
  }
}

// Unquoted characters that end a shell word. Quotes deliberately do NOT: bash
// concatenates adjacent quoted and unquoted fragments into one word, so reading
// only as far as a quote would hand back `$HOME/.loom/analyses/` for
// `"$HOME/.loom/analyses/"../config.json` -- the carved-out prefix of a target
// that walks straight back out of the tree. `=` is not a boundary either; it is
// an ordinary character in a pathname. Only space, tab and newline split a word:
// JS `\s` also matches U+00A0 and a carriage return, both of which bash keeps
// inside the word.
const WORD_BREAK = /[ \t\n;&|<>()]/;

/** A run of characters that shared one quoting context, in word order. Quoting
 *  has to survive parsing: bash decides each expansion from how the fragment
 *  that carries it was quoted, so `"$"HOME/x` is a literal `$HOME/x` and
 *  `~"/x"` keeps its tilde. Reading the concatenated text back would invent
 *  expansions the shell never performs. An empty fragment is kept -- `''~/x` is
 *  a word that does not begin with a tilde, so bash leaves the tilde alone. */
interface WordFragment {
  text: string;
  quote: "'" | '"' | null;
}

// Backslash escapes bash honours inside double quotes; elsewhere it escapes
// whatever follows.
const DQ_ESCAPABLE = '$`"\\\n';

/** A shell word, or a run of unquoted operator characters (`&&`, `>>`, `2>&`
 *  arrives as a word `2` then `>&`). Parentheses and newlines are always an
 *  operator of their own. */
type ShellToken = { word: WordFragment[] } | { op: string } | { heredoc: string };

// Index of the `)` closing the `$(` whose `(` sits at `open`, skipping quoted
// spans and escapes; the end of the string when it never closes.
function substitutionEnd(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") {
      const k = s.indexOf("'", j + 1);
      j = k === -1 ? s.length : k;
    } else if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return s.length - 1;
}

function backtickEnd(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "`") return j;
  }
  return s.length - 1;
}

// Split a command into shell words and operators, tracking the quoting of each
// fragment. Models bash's word splitting, escaping and comments, not its
// expansions -- anything that would need expanding is rejected by the resolvers
// below.
//
// `structure` is for the cd tracker, which needs to know what actually runs:
// an unquoted `$(...)` or backtick span stays inside its word instead of being
// split on its parentheses, and a heredoc body comes back as one `heredoc`
// token rather than as lines of commands. The path scan keeps the flat view,
// where a heredoc body's words are still examined.
function shellTokens(command: string, structure = false): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word: WordFragment[] = [];
  let opEnd = -2;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let delimStrip: boolean | null = null;
  let text = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  const endFragment = (keepEmpty: boolean) => {
    if (text || keepEmpty) word.push({ text, quote });
    text = "";
  };
  const endWord = () => {
    endFragment(false);
    if (word.length) {
      if (delimStrip !== null) heredocs.push({ delim: wordText(word), strip: delimStrip });
      delimStrip = null;
      tokens.push({ word });
    }
    word = [];
    started = false;
  };
  // An escaped character is literal, exactly like a single-quoted one -- and it
  // has to be recorded that way, or `\~/x` and `\$HOME/x` would be read back as
  // expansions the shell already refused to perform.
  const pushEscaped = (chr: string) => {
    endFragment(false);
    word.push({ text: chr, quote: "'" });
    started = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") {
        endFragment(true);
        quote = null;
      } else {
        text += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        endFragment(true);
        quote = null;
      } else if (ch === "\\" && i + 1 < command.length && DQ_ESCAPABLE.includes(command[i + 1])) {
        i++;
        if (command[i] !== "\n") pushEscaped(command[i]);
      } else if (structure && ((ch === "$" && command[i + 1] === "(") || ch === "`")) {
        // Quotes inside a substitution start afresh; the next `"` does not
        // close the string around it.
        const end = ch === "`" ? backtickEnd(command, i) : substitutionEnd(command, i + 1);
        text += command.slice(i, end + 1);
        i = end;
      } else {
        text += ch;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) {
        text += ch;
        started = true;
        continue;
      }
      i++;
      // A line continuation contributes nothing -- not even the fact that a word
      // began, or the `#` on the joined line would stop being a comment.
      if (command[i] !== "\n") pushEscaped(command[i]);
      continue;
    }
    if (structure && ((ch === "$" && command[i + 1] === "(") || ch === "`")) {
      const end = ch === "`" ? backtickEnd(command, i) : substitutionEnd(command, i + 1);
      text += command.slice(i, end + 1);
      started = true;
      i = end;
      continue;
    }
    // Arithmetic -- `$[...]` and a `((...))` command -- is one opaque word, so
    // the shift in `1<<2` is not taken for a heredoc.
    if (structure && ch === "$" && command[i + 1] === "[") {
      const close = command.indexOf("]", i);
      const end = close === -1 ? command.length - 1 : close;
      text += command.slice(i, end + 1);
      started = true;
      i = end;
      continue;
    }
    if (structure && ch === "(" && command[i + 1] === "(" && !started) {
      endWord();
      const end = substitutionEnd(command, i);
      tokens.push({ word: [{ text: command.slice(i, end + 1), quote: "'" }] });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      endFragment(false);
      quote = ch;
      started = true;
      continue;
    }
    // `#` starts a comment only where a word has not started; inside one it is
    // an ordinary character, and treating it as a comment there would discard
    // the rest of the line -- including whatever runs after the next `;`.
    if (ch === "#" && !started) {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      // Stop short of the newline: it still separates the next command.
      i = nl - 1;
      continue;
    }
    if (WORD_BREAK.test(ch)) {
      endWord();
      if (ch !== " " && ch !== "\t") {
        const prev = tokens[tokens.length - 1];
        const joinable = /[;&|<>]/.test(ch) && opEnd === i - 1;
        let op: string;
        if (joinable && prev && "op" in prev && /^[;&|<>]+$/.test(prev.op)) op = prev.op += ch;
        else tokens.push({ op: (op = ch) });
        opEnd = i;
        if (structure && op === "<<") {
          delimStrip = command[i + 1] === "-";
          if (delimStrip) i++;
        } else if (structure && op === "<<<") {
          delimStrip = null;
        }
        if (structure && ch === "\n" && heredocs.length) i = readHeredocs(i + 1) - 1;
      }
      continue;
    }
    started = true;
    text += ch;
  }
  endWord();
  return tokens;

  // Consume the bodies queued on the line that just ended; returns the index
  // of the newline that ends the last delimiter line.
  function readHeredocs(pos: number): number {
    for (const h of heredocs) {
      let body = "";
      while (pos < command.length) {
        const nl = command.indexOf("\n", pos) === -1 ? command.length : command.indexOf("\n", pos);
        const line = command.slice(pos, nl);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
          pos = nl;
          break;
        }
        body += line + "\n";
        pos = nl + 1;
      }
      tokens.push({ heredoc: body });
      if (pos < command.length && command[pos] === "\n" && h !== heredocs[heredocs.length - 1])
        pos++;
    }
    heredocs.length = 0;
    return pos;
  }
}

function shellWords(command: string): WordFragment[][] {
  const words: WordFragment[][] = [];
  for (const t of shellTokens(command)) if ("word" in t) words.push(t.word);
  return words;
}

function wordText(fragments: WordFragment[]): string {
  return fragments.map((f) => f.text).join("");
}

// `.loom`/`.orbit` is matched case-insensitively because the carve-out below folds case
// too (macOS resolves ~/.LOOM and ~/.loom to the same directory), and against a
// backslash-stripped copy so a quoted `.\loom/` -- where the backslash survives
// as a literal -- is still examined rather than skipped.
const LOOM_SEGMENT = new RegExp(String.raw`\.(?:${STATE_DIR_ALT})\/`, "i");
function mentionsLoom(word: WordFragment[]): boolean {
  return LOOM_SEGMENT.test(wordText(word).replace(/\\/g, ""));
}

// Resolve a `.loom/` word to the absolute path the shell would act on, or null
// when we cannot say -- and null keeps the line denied. Conservative by
// construction: a leading `~/` expands only when the word begins with it
// unquoted, and `$HOME`/`${HOME}` only when the fragment carrying the variable
// is not single-quoted. Anything unresolvable afterwards -- a relative path
// (classifyBash has no cwd), another user's home, an unexpanded variable, a glob
// or bracket expression, a brace expansion, a surviving backslash, a command
// substitution, or any `..` segment (the resolver collapses those lexically
// before it realpaths, so a `..` after a symlink would never be inspected) --
// comes back null. What survives is an absolute path the caller can compare
// against the analyses tree the write tool already allows (isProtectedWritePath).
function resolveLoomWord(word: WordFragment[], home: string): string | null {
  if (!home) return null;
  const fragments = word.filter((f) => f.text.length > 0);
  if (fragments.length === 0) return null;
  let text = wordText(fragments);
  const head = fragments[0];
  if (word[0].quote === null && word[0].text.startsWith("~/")) {
    text = home + text.slice(1);
  } else if (head.quote !== "'") {
    for (const v of ["$HOME", "${HOME}"]) {
      // The variable has to sit whole in the leading fragment; `$HO"ME"` and
      // `"$"HOME` are two fragments and bash expands neither. The slash may
      // arrive in the next one, as in `"$HOME"/x`.
      if (head.text === v || head.text.startsWith(v + "/")) {
        const rest = text.slice(v.length);
        if (rest.startsWith("/")) {
          text = home + rest;
          break;
        }
      }
    }
  }
  if (text.startsWith("~") || /[*?$`\\{}[\]]/.test(text)) return null;
  if (!path.isAbsolute(text)) return null;
  if (text.split("/").includes("..")) return null;
  return path.normalize(text);
}

// Editing Loom's own state from the shell is how an agent would disable the gate
// (the write TOOL into .loom is gated by isProtectedWritePath). The rule used to
// be a single regex, which also caught every ordinary write into an Orbit
// analysis workspace -- Orbit's DEFAULT_CWD is ~/.loom/analyses -- and denied it
// outright while the same write through the file tool was allowed. Now a matched
// line is catastrophic only if some `.loom/` target on it is really Loom state;
// the rest are handed to the policy layer, which can realpath them.
function scanLoomWrite(
  command: string,
  home: string,
): { catastrophic: boolean; targets: string[] } {
  // Backslashes are stripped for the trigger too: bash drops them, so
  // `.lo\om/` names the same directory and must not skip the per-word check.
  if (!LOOM_WRITE.test(command) && !LOOM_WRITE.test(command.replace(/\\/g, ""))) {
    return { catastrophic: false, targets: [] };
  }
  const words = shellWords(command).filter(mentionsLoom);
  if (words.length === 0) return { catastrophic: true, targets: [] };
  const targets: string[] = [];
  for (const w of words) {
    const resolved = resolveLoomWord(w, home);
    if (resolved === null || isLoomStatePath(resolved, home)) {
      return { catastrophic: true, targets: [] };
    }
    targets.push(resolved);
  }
  return { catastrophic: false, targets };
}

// The checks above judge each path as written, so `cd ~/.loom && echo x > a`
// carried no `.loom/` after the write verb and sailed through. What follows
// tracks the working directory across one command line -- `cd`, `pushd`,
// `popd`, `cd -`, subshells, command substitutions, heredocs fed to a shell,
// `sh -c` wherever it appears in the argv, and `eval` -- and resolves relative
// operands against it, so a hop into Loom's own state or a credential store gets
// the verdict the direct path would.
//
// It is a model of the shell, not the shell. Loops, functions, aliases,
// variables it cannot expand and `env -C`/`git -C` are out of reach. Where that
// matters it errs toward asking: a cd target it cannot resolve keeps the
// protection of the directory it left, a cd may always have failed, and any
// `cd`/`pushd` whose target visibly names Loom state (even inside a python -c
// string) is never auto-allowed.

interface CwdState {
  /** Absolute directory, or null once a `cd` target could not be resolved. */
  dir: string | null;
  /** Writes here land in Loom's own state. */
  state: boolean;
  /** Under a state-dir segment at all, the analyses carve-out included: a target
   *  we cannot resolve from here may well land in real state. */
  nearState: boolean;
  /** Loom state or a credential store: no unrecognized command runs here
   *  silently. */
  guarded: boolean;
}

/** Every directory the shell might be standing in. More than one when a cd
 *  could have failed and the next command runs anyway. */
type Where = CwdState[];

interface CdScan {
  catastrophic: boolean;
  readPaths: string[];
  writeTargets: string[];
  guarded: boolean;
}

const STATE_DIR_SET = new Set<string>(WORKSPACE_STATE_DIR_NAMES);
function hasStateSegment(p: string): boolean {
  return p.split("/").some((s) => STATE_DIR_SET.has(s.toLowerCase()));
}

// An unexpandable `cd` target that still visibly points at Loom state: a
// state-dir name, a LOOM_/ORBIT_ variable, a glob or brace inside a dot-dir
// segment (`~/.l*`), or $OLDPWD from a shell we never saw.
const SUSPECT_CD = new RegExp(
  String.raw`\.(?:${STATE_DIR_ALT})(?![\w.-])|\$\{?(?:LOOM|ORBIT)_|\$\{?OLDPWD\b|(?:^|\/)\.[^/]*[*?[{]`,
  "i",
);

// A cd inside text the walker hands to something it cannot model (python -c,
// awk, a heredoc fed to perl), for the backstop in runSimple.
const RAW_CD = /(?:^|[^\w-])(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|()`'"]+)/g;

// Verbs whose arguments are data, not code: a cd quoted in a commit message or
// a grep pattern runs nowhere.
const INERT_VERBS = new Set([
  "echo",
  "printf",
  "git",
  "grep",
  "rg",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "wc",
  "tee",
  "touch",
  "mkdir",
]);

// Somewhere on the line a protected directory is named outright. A cd target
// we cannot expand (`D=~/.loom; cd $D`, `cd "$1"` under find -exec) is then
// presumed to be it. Orbit's analyses tree is work product, so it is cut out
// before the test.
const NAMES_STATE = new RegExp(String.raw`\.(?:${STATE_DIR_ALT})(?![\w.-])`, "i");
const NAMES_CREDENTIALS =
  /\.(?:ssh|aws|gnupg|kube|docker|netrc|pgpass|npmrc)(?![\w.-])|\.config\/gcloud|Library\/Keychains/i;
const ANALYSES_TREE = new RegExp(
  String.raw`\.(?:${STATE_DIR_ALT})\/+analyses(?:\/+[^/\s'"]+)?`,
  "gi",
);

// More candidate directories than this and the tracker stops telling them
// apart; the cost of judging each one grows with every cd that might fail.
const MAX_CANDIDATES = 8;

// Words that open or close a compound command and sit in front of the real verb.
const LEADING_KEYWORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DECLARE_VERBS = new Set(["export", "declare", "typeset", "local", "readonly"]);
// Variables that change where a later `cd` lands without changing its text.
const CD_STEERING = /^(?:HOME|CDPATH)=/;
const UNKNOWN: CwdState = { dir: null, state: false, nearState: false, guarded: false };
const LOST: CwdState = { dir: null, state: true, nearState: true, guarded: true };

// Resolve a word to the absolute path the shell would use, or null. Same
// expansion rules as resolveLoomWord, plus a relative path against `base` and
// `..`, collapsed lexically -- which is what bash's default logical cd does. A
// write through a symlinked `..` is caught by the caller handing the prefix to
// the policy layer to realpath.
function resolveWordFrom(word: WordFragment[], home: string, base: string | null): string | null {
  const fragments = word.filter((f) => f.text.length > 0);
  if (fragments.length === 0) return null;
  let text = wordText(fragments);
  const head = fragments[0];
  if (home && word[0].quote === null && (word[0].text === "~" || word[0].text.startsWith("~/"))) {
    text = home + text.slice(1);
  } else if (home && head.quote !== "'") {
    for (const v of ["$HOME", "${HOME}"]) {
      if (head.text === v || head.text.startsWith(v + "/")) {
        const rest = text.slice(v.length);
        if (rest === "" || rest.startsWith("/")) {
          text = home + rest;
          break;
        }
      }
    }
  }
  if (text.startsWith("~") || /[*?$`\\{}[\]]/.test(text)) return null;
  if (path.isAbsolute(text)) return path.resolve(text);
  return base ? path.resolve(base, text) : null;
}

// The `$(...)` and backtick bodies inside a word, wherever bash would run them.
function substitutions(word: WordFragment[]): string[] {
  const out: string[] = [];
  for (const f of word) {
    if (f.quote === "'") continue;
    const t = f.text;
    for (let j = 0; j < t.length; j++) {
      if (t[j] === "$" && t[j + 1] === "(") {
        const end = substitutionEnd(t, j + 1);
        out.push(t.slice(j + 2, end));
        j = end;
      } else if (t[j] === "`") {
        const end = backtickEnd(t, j);
        out.push(t.slice(j + 1, end));
        j = end;
      }
    }
  }
  return out;
}

function sameState(a: CwdState, b: CwdState): boolean {
  return (
    a.dir === b.dir && a.state === b.state && a.nearState === b.nearState && a.guarded === b.guarded
  );
}
function union(...wheres: Where[]): Where {
  const out: Where = [];
  for (const w of wheres) for (const s of w) if (!out.some((o) => sameState(o, s))) out.push(s);
  return out.length > MAX_CANDIDATES ? [worst(out)] : out;
}
function worst(where: Where): CwdState {
  return {
    dir: null,
    state: where.some((d) => d.state),
    nearState: where.some((d) => d.nearState),
    guarded: where.some((d) => d.guarded),
  };
}

interface Shell {
  cur: Where;
  oldpwd: Where | null;
  stack: Where[];
  /** A cd has happened, so relative operands no longer mean the request's cwd. */
  moved: boolean;
  /** HOME or CDPATH was reassigned, so a bare or relative cd lands who knows where. */
  steered: boolean;
}

interface Segment {
  words: WordFragment[][];
  outs: WordFragment[][];
  ins: WordFragment[][];
  hereStrings: WordFragment[][];
  heredocs: number;
}

function scanCdContext(command: string, home: string, cwd: string): CdScan {
  const out: CdScan = { catastrophic: false, readPaths: [], writeTargets: [], guarded: false };
  // isCredentialStore realpaths a handful of files; a script that cds back
  // and forth asks about the same few directories over and over.
  const seen = new Map<string, CwdState>();
  const stateFor = (dir: string): CwdState => {
    const hit = seen.get(dir);
    if (hit) return hit;
    const state = isLoomStatePath(dir, home);
    const v = {
      dir,
      state,
      nearState: hasStateSegment(dir),
      guarded: state || (!!home && isCredentialStore(dir, home)),
    };
    seen.set(dir, v);
    return v;
  };
  const named = command.replace(/\\/g, "").replace(ANALYSES_TREE, "");
  const presumeState = NAMES_STATE.test(named);
  const presumeGuarded = presumeState || NAMES_CREDENTIALS.test(named);
  const backstop = (text: string) => {
    for (const m of text.replace(/\\/g, "").matchAll(RAW_CD)) {
      const raw = m[1].replace(/^["']|["']$/g, "");
      const abs = resolveWordFrom([{ text: raw, quote: null }], home, null);
      if (abs ? stateFor(abs).guarded : SUSPECT_CD.test(raw)) out.guarded = true;
    }
  };
  const start: CwdState = cwd && path.isAbsolute(cwd) ? { ...UNKNOWN, dir: cwd } : UNKNOWN;
  walk(command, { cur: [start], oldpwd: null, stack: [], moved: false, steered: false }, 0);

  return out;

  function walk(script: string, sh: Shell, depth: number): Shell {
    if (depth > 4) {
      // Nested deeper than any honest command: refuse to judge it as harmless.
      out.guarded = true;
      if (sh.cur.some((d) => d.nearState)) out.catastrophic = true;
      return sh;
    }
    const hasOr = script.includes("||");
    const saved: Shell[] = [];
    // Heredoc bodies arrive after the line that asked for them; each waits here
    // with the state its command started in.
    const hosts: { shell: boolean; inert: boolean; sh: Shell }[] = [];
    let seg: Segment = { words: [], outs: [], ins: [], hereStrings: [], heredocs: 0 };
    let pending: "out" | "in" | "dup" | "skip" | "here" | null = null;
    const flush = (sep: string) => {
      if (seg.words.length || seg.outs.length || seg.ins.length) {
        const before = sh;
        const r = runSimple(seg, sh, depth);
        sh = r.sh;
        for (let k = 0; k < seg.heredocs; k++) {
          hosts.push({ shell: r.shell, inert: r.inert, sh: before });
        }
        // The cd may have failed. `&&` would skip what follows; anything else
        // runs it in the old directory.
        if (r.cd && (sep !== "&&" || hasOr)) sh = { ...sh, cur: union(sh.cur, before.cur) };
      }
      seg = { words: [], outs: [], ins: [], hereStrings: [], heredocs: 0 };
      pending = null;
    };
    for (const t of shellTokens(script, true)) {
      if ("heredoc" in t) {
        const host = hosts.shift();
        if (host?.shell) walk(t.heredoc, copy(host.sh), depth + 1);
        else if (host && !host.inert) backstop(t.heredoc);
        continue;
      }
      if ("word" in t) {
        const txt = wordText(t.word);
        if (pending === "out" || (pending === "dup" && !/^(\d+|-)$/.test(txt)))
          seg.outs.push(t.word);
        else if (pending === "in") seg.ins.push(t.word);
        else if (pending === "here") seg.hereStrings.push(t.word);
        else if (pending === null) seg.words.push(t.word);
        pending = null;
        continue;
      }
      const op = t.op;
      if (op === "<<") {
        seg.heredocs++;
        pending = "skip";
      } else if (op === "<<<") pending = "here";
      else if (op === "<&") pending = "skip";
      else if (op === "<") pending = "in";
      else if (op.includes(">")) pending = op.endsWith("&") ? "dup" : "out";
      else {
        flush(op);
        if (op === "(") {
          saved.push(copy(sh));
        } else if (op === ")") {
          // A subshell's cd does not outlive it.
          const back = saved.pop();
          if (back) sh = back;
        }
      }
    }
    flush("");
    return sh;
  }

  function copy(sh: Shell): Shell {
    return { ...sh, stack: [...sh.stack] };
  }

  function runSimple(
    seg: Segment,
    sh: Shell,
    depth: number,
  ): { sh: Shell; cd: boolean; shell: boolean; inert: boolean } {
    const all = [...seg.words, ...seg.outs, ...seg.ins, ...seg.hereStrings];
    // Command substitutions run in a subshell that starts where this command stands.
    for (const w of all) for (const inner of substitutions(w)) walk(inner, copy(sh), depth + 1);

    let i = 0;
    while (i < seg.words.length) {
      const t = wordText(seg.words[i]);
      if (LEADING_KEYWORDS.has(t)) i++;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        if (CD_STEERING.test(t)) sh = { ...sh, steered: true };
        i++;
      } else break;
    }
    const rest = seg.words.slice(i);
    const texts = rest.map(wordText);
    const offset = texts.length - unwrap(texts).length;
    const argv = rest.slice(offset);
    const args = argv.slice(1);
    const argTexts = args.map(wordText);
    const verb = argv.length ? wordText(argv[0]).split("/").pop() : undefined;

    if (verb && DECLARE_VERBS.has(verb) && argTexts.some((a) => CD_STEERING.test(a))) {
      sh = { ...sh, steered: true };
    }
    if (verb === "cd" || verb === "pushd" || verb === "popd" || verb === "chdir") {
      return { sh: changeDir(verb, args, sh), cd: true, shell: false, inert: false };
    }
    if (sh.cur.some((d) => d.guarded) && (argv.length || seg.outs.length)) out.guarded = true;

    if (sh.moved) for (const where of sh.cur) judgeOperands(where, verb, args, argTexts, seg);

    // An inner shell starts where this one stands, wherever it sits in the argv
    // (`find -exec sh -c`, `xargs bash -c`, `nice sh -c`); `eval` runs in this one.
    const texts2 = argv.map(wordText);
    const inert = verb !== undefined && INERT_VERBS.has(verb);
    if (!inert) backstop(texts2.slice(1).join(" "));
    const shellAt = texts2.findIndex((t) => SHELLS.has(t.split("/").pop() ?? ""));
    let shell = false;
    if (shellAt !== -1) {
      shell = true;
      const c = texts2.findIndex((t, k) => k > shellAt && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
      if (c !== -1) {
        // bash takes the first operand after its options as the script; `--` ends them.
        const script = texts2.slice(c + 1).find((t) => !/^[-+]/.test(t));
        if (script !== undefined) walk(script, copy(sh), depth + 1);
      }
      for (const w of seg.hereStrings) walk(wordText(w), copy(sh), depth + 1);
    } else if (verb === "eval") {
      return { sh: walk(argTexts.join(" "), sh, depth + 1), cd: false, shell, inert };
    }
    return { sh, cd: false, shell, inert };
  }

  function judgeOperands(
    where: CwdState,
    verb: string | undefined,
    args: WordFragment[][],
    argTexts: string[],
    seg: Segment,
  ) {
    const base = where.dir;
    const reads: WordFragment[][] = [...seg.ins];
    if (verb && READ_LIKE.has(verb)) {
      args.forEach((w, k) => {
        if (!argTexts[k].startsWith("-")) reads.push(w);
      });
    }
    for (const w of reads) {
      const abs = resolveWordFrom(w, home, base);
      if (abs) {
        out.readPaths.push(abs);
      } else if (base === null && where.state && home) {
        // Somewhere in Loom state we could not pin down: judge a relative read
        // as if it were in either config dir, so `config.json` still denies.
        const rel = wordText(w);
        if (!path.isAbsolute(rel) && !rel.split("/").includes("..")) {
          for (const name of WORKSPACE_STATE_DIR_NAMES)
            out.readPaths.push(path.join(home, name, rel));
        }
      }
    }
    const writes = [...seg.outs];
    const inPlaceSed =
      verb === "sed" && argTexts.some((a) => a === "--in-place" || /^-[a-zA-Z]*i/.test(a));
    if (verb === "tee" || verb === "cp" || verb === "mv" || inPlaceSed) {
      args.forEach((w, k) => {
        if (!argTexts[k].startsWith("-")) writes.push(w);
      });
    } else if (verb === "dd") {
      for (const w of args) {
        if (w[0]?.quote === null && w[0].text.startsWith("of=")) {
          writes.push([{ ...w[0], text: w[0].text.slice(3) }, ...w.slice(1)]);
        }
      }
    }
    for (const w of writes) {
      const text = wordText(w);
      const abs = resolveWordFrom(w, home, base);
      if (abs !== null) {
        if (isLoomStatePath(abs, home)) out.catastrophic = true;
        else if (hasStateSegment(abs)) out.writeTargets.push(abs);
        // `..` is collapsed lexically, but the kernel walks it physically: hand
        // the directory it climbs out of to the policy layer to realpath.
        const segs = text.split("/");
        const up = segs.indexOf("..");
        if (up !== -1) {
          const prefix = resolveWordFrom(
            [{ text: segs.slice(0, up).join("/") || ".", quote: null }],
            home,
            base,
          );
          if (prefix && hasStateSegment(prefix)) out.writeTargets.push(prefix);
          if (base && hasStateSegment(base)) out.writeTargets.push(base);
        }
      } else if (where.state) {
        out.catastrophic = true;
      } else if (where.nearState || where.guarded) {
        // Near state but not in it -- an Orbit analysis. A target we cannot
        // place gets the verdict it would get without the cd (none), unless it
        // climbs with `..`, names a state dir, or we have lost track entirely.
        const plain =
          base &&
          !/[$`~\\]/.test(text) &&
          !path.isAbsolute(text) &&
          !text.split("/").some((p) => p === ".." || /^\.[^/]*[*?[{]/.test(p));
        if (plain && isLoomStatePath(path.resolve(base, text), home)) {
          out.catastrophic = true;
        } else if (
          !plain &&
          (base === null || text.split("/").includes("..") || SUSPECT_CD.test(text))
        ) {
          out.guarded = true;
        }
      }
    }
  }

  function changeDir(verb: string, args: WordFragment[][], sh: Shell): Shell {
    let k = 0;
    while (k < args.length) {
      const t = wordText(args[k]);
      if (t === "--") {
        k++;
        break;
      }
      if (t.startsWith("-") && t !== "-" && !/^-\d+$/.test(t)) k++;
      else break;
    }
    const target = args[k];
    const stack = [...sh.stack];
    let next: Where;
    if (verb === "popd") {
      next = stack.pop() ?? sh.cur;
    } else if (verb === "pushd" && !target) {
      const top = stack.pop();
      if (!top) return sh;
      stack.push(sh.cur);
      next = top;
    } else if (!target) {
      next = [sh.steered ? LOST : home ? stateFor(home) : UNKNOWN];
    } else {
      const text = wordText(target);
      if (text === "-" && verb !== "pushd") {
        // A fresh shell has no OLDPWD, and a failed cd leaves the cwd alone.
        if (!sh.oldpwd) return sh;
        next = sh.oldpwd;
      } else if (/^[+-]\d+$/.test(text)) {
        // A pushd/popd stack rotation we do not model: assume the worst entry.
        next = [worst(union(sh.cur, ...stack))];
      } else if (sh.steered && !path.isAbsolute(text) && !text.startsWith("$")) {
        next = [LOST];
      } else {
        next = union(
          sh.cur.map((where) => {
            const abs = resolveWordFrom(target, home, where.dir);
            if (abs) return stateFor(abs);
            // Unresolvable: it might be right here (`cd "$PWD"`), so keep this
            // directory's protection, plus whatever the text itself gives away.
            const suspect =
              presumeState ||
              SUSPECT_CD.test(text.replace(/\\/g, "")) ||
              substitutions(target).some((body) =>
                shellWords(body).some((w) => SUSPECT_CD.test(wordText(w))),
              );
            return {
              dir: null,
              state: suspect || where.state,
              nearState: suspect || where.nearState,
              guarded: suspect || presumeGuarded || where.guarded,
            };
          }),
        );
      }
      if (verb === "pushd") stack.push(sh.cur);
    }
    return { ...sh, cur: next, oldpwd: sh.cur, stack, moved: true };
  }
}

// Roots whose recursive force-deletion is catastrophic. Quotes are stripped
// first, so `"$HOME"` and `'/'` are caught; the home dir is passed in so an
// explicit absolute home path (`rm -rf /Users/me`) is caught too.
const SYSTEM_ROOTS = new Set([
  "/",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/var",
  "/boot",
  "/dev",
  "/opt",
  "/sys",
  "/proc",
  "/root",
  "/System",
  "/Library",
  "/Applications",
]);

function isFilesystemRoot(arg: string, home: string): boolean {
  const t = stripQuotes(arg);
  if (["/", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "$HOME/*", "${HOME}/*"].includes(t)) {
    return true;
  }
  if (/^\/+$/.test(t)) return true;
  const noGlob = t.replace(/\/\*+$/, "");
  if (SYSTEM_ROOTS.has(noGlob)) return true;
  if (home && (noGlob === home || t === home + "/" || t === home)) return true;
  return false;
}

// `rm` with BOTH a recursive and a force flag pointed at a filesystem root.
// Token-based so it handles short/bundled/long flags in any order
// (`-rf`, `-r -f`, `--recursive --force`), quoted targets, and wrapper prefixes
// (`env rm`, `conda run rm`, `nice -n 10 rm`). A routine `rm -rf build` is NOT
// caught (target isn't a root); it stays "unknown" and still prompts. Each shell
// segment -- split on `;`, `&`, `|`, and NEWLINES -- is checked so it fires
// inside a compound or multi-line command too.
function isCatastrophicRm(command: string, home: string): boolean {
  for (const segment of command.split(/[;&|\n\r]+/)) {
    const tokens = unwrap(segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes));
    if (tokens.length === 0) continue;
    const verb = tokens[0].split("/").pop(); // basename: /bin/rm -> rm
    if (verb !== "rm") continue;
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const recursive = flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f));
    const force = flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
    if (recursive && force && targets.some((t) => isFilesystemRoot(t, home))) return true;
  }
  return false;
}

// Single read-only/analysis commands we auto-allow when the line is "simple".
// Deliberately excludes command wrappers (`env`, `conda run`, `bash -c`, ...):
// those execute an arbitrary inner command, so they are never auto-safe -- they
// fall through to `unknown` and prompt.
const SAFE_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "grep",
  "rg",
  "fd",
  "find",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "date",
  "whoami",
  "uname",
]);
// Multi-token safe prefixes (exact leading tokens).
const SAFE_PREFIXES = [
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["git", "show"],
];

// Any of these mean "we can't reason about this as a single safe command."
// Bare newlines count: the shell runs them as separate commands, so a line that
// starts with a safe verb but continues onto another line is NOT safe.
const SHELL_META = /[;&|`\n\r]|\$\(|\$\{|<\(|>>?|<|\\\n/;

const READ_LIKE = new Set(["cat", "head", "tail", "less", "more", "grep", "rg"]);

// Safe commands whose path operands the policy layer runs through the workspace
// jail. Superset of READ_LIKE: the content readers above plus the enumeration /
// metadata commands, which reveal the structure, filenames, sizes, or contents
// of their target. A bare `ls`/`find` on the safe allowlist was previously
// auto-allowed regardless of where it pointed, so `ls ~/Desktop` silently
// inspected outside the workspace while the equivalent `ls` *tool* prompted
// (#224). `df <path>` is here too: it reveals existence + the mount/capacity of
// its argument. The remaining safe commands (echo/pwd/which/date/whoami/uname)
// take no file-path operand, so they are deliberately excluded -- collecting
// their args would manufacture spurious out-of-workspace prompts. Unlike
// READ_LIKE, this set does NOT feed the sensitive-read pipe floor
// (extractReadTargets): `ls ~/.ssh` lists names, it does not dump key contents,
// so the jail's escape-ask is the right response, not the credential-store deny.
const PATH_READING = new Set([...READ_LIKE, "ls", "find", "fd", "file", "stat", "du", "df", "wc"]);

// Content-read targets across EVERY shell segment (split on the same separators
// as the catastrophic-rm scan). For any segment whose verb is a content reader,
// collect its non-flag args. This is what closes the pipe evasion: `cat secret |
// tool` is "unknown" as a whole, but its first segment still reads `secret`. A
// path that is only an auth arg to a non-reading command (`ssh -i key`) is NOT
// collected -- only verbs that dump file contents to stdout.
function extractReadTargets(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/[;&|\n\r]+/)) {
    const tokens = unwrap(segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes));
    if (tokens.length === 0) continue;
    const verb = tokens[0].split("/").pop(); // basename: /bin/cat -> cat
    if (!verb || !READ_LIKE.has(verb)) continue;
    for (const t of tokens.slice(1)) if (!t.startsWith("-")) out.push(t);
  }
  return out;
}

export function classifyBash(commandRaw: string, home = "", cwd = ""): BashClass {
  const command = commandRaw.trim();
  const cd = scanCdContext(command, home, cwd);
  // Computed for every kind (incl. compound/unknown) so the policy layer's
  // sensitive-read floor fires through a pipe; see BashClass.sensitiveReadPaths.
  const sensitiveReadPaths = [...extractReadTargets(command), ...cd.readPaths];
  const loom = scanLoomWrite(command, home);
  const base = {
    sensitiveReadPaths,
    loomWriteTargets: [...loom.targets, ...cd.writeTargets],
    guardedCwd: cd.guarded,
  };
  for (const [re, why] of CATASTROPHIC) {
    if (re.test(command)) return { kind: "catastrophic", reason: why, readPaths: [], ...base };
  }
  if (loom.catastrophic || cd.catastrophic) {
    return {
      kind: "catastrophic",
      reason: "write to the Loom config directory",
      readPaths: [],
      ...base,
    };
  }
  if (isCatastrophicRm(command, home)) {
    return {
      kind: "catastrophic",
      reason: "recursive force-delete of / or home",
      readPaths: [],
      ...base,
    };
  }
  if (cd.guarded) {
    return {
      kind: "unknown",
      reason: "command runs inside Loom's state or a credential store",
      readPaths: [],
      ...base,
    };
  }
  if (SHELL_META.test(command)) {
    return {
      kind: "unknown",
      reason: "compound or redirected command",
      readPaths: [],
      ...base,
    };
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0)
    return { kind: "unknown", reason: "empty command", readPaths: [], ...base };
  const cmd = tokens[0];

  const prefixHit = SAFE_PREFIXES.some((p) => p.every((t, i) => tokens[i] === t));
  const isSafeCmd = SAFE_COMMANDS.has(cmd) || prefixHit;
  if (!isSafeCmd) {
    return {
      kind: "unknown",
      reason: `'${cmd}' is not on the safe allowlist`,
      readPaths: [],
      ...base,
    };
  }

  // Collect path-like args for read/enumerate commands so the policy layer can
  // apply the workspace jail (a "safe" cat/ls/find must still not reach outside
  // the workspace silently). See PATH_READING for why the set is broader than
  // READ_LIKE and which safe commands are deliberately left out. Quotes are
  // stripped first (mirroring extractReadTargets): without it `ls "/external"`
  // keeps its quotes, resolves as a cwd-relative path, and silently auto-allows.
  const readPaths = PATH_READING.has(cmd)
    ? tokens
        .slice(1)
        .map(stripQuotes)
        .filter((t) => t.length > 0 && !t.startsWith("-"))
    : [];
  return {
    kind: "safe",
    reason: `read-only/analysis command '${cmd}'`,
    readPaths,
    ...base,
  };
}
