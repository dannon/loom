/**
 * A scripted model, for the Tier-1 evals.
 *
 * The replay seams (`submission-replay.ts`, `lessons/replay.ts`) feed recorded
 * results into one hook each, which is enough when the thing under test is the
 * hook. The evidence gate is different: what it judges is a model's edit to
 * the notebook, and the deny that matters is the one pi's own `tool_call` path
 * honours -- every other tool_call handler running first, the exec-guard
 * floor, the write landing or not. A replay can't show that. This seam puts a
 * model in the loop that says exactly what a script tells it to, using pi's
 * faux provider, so pi's agent loop, its tools and every Loom hook run as they
 * do with a real model.
 *
 * `LOOM_MODEL_SCRIPT` names a JSONL file, one model turn per line, in order:
 *
 * ```json
 * {"text": "Recording the evidence first."}
 * {"tool": "edit", "input": {"path": "notebook.md", "edits": [{"oldText": "...", "newText": "..."}]}}
 * {"tool": "bash", "input": {"command": "ls"}, "text": "optional text before the call"}
 * ```
 *
 * A tool line ends its turn with `toolUse`, so pi runs the call and asks for
 * the next turn; a text line ends it with `stop`. A script that runs out
 * answers every later turn with an empty `stop`, which ends the prompt cleanly
 * rather than with the faux provider's "no more responses" error.
 *
 * Same constraints as the replay seams: off unless the variable is set (and
 * nothing registers otherwise), the file must resolve inside the session
 * directory, and a `model.script` activity row is written before the first
 * turn, so a log produced this way says so. Two more, because this one stands
 * in for the model:
 *
 * - the file is read once per process, at the first session start, through
 *   one descriptor on a regular file, so nothing the scripted session does --
 *   a write to the script, a tool result, a notebook edit, `/new` -- can add
 *   lines to it;
 * - when the variable is set, the scripted model is selected whether or not
 *   the file was usable, moved back to if anything selects another, and any
 *   request that reaches a real provider anyway is aborted and logged.
 *   `team_dispatch`, which calls a model directly, refuses to run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxContentBlock,
  type FauxProviderHandle,
  type ToolCall,
} from "@earendil-works/pi-ai";
import * as fs from "fs";
import * as path from "path";
import { readEnv } from "../../shared/orbit-env.js";
import { appendActivityEvent } from "./activity";
import { getNotebookPath } from "./state";

export const MODEL_SCRIPT_PROVIDER = "loom-script";
export const MODEL_SCRIPT_MODEL_ID = "scripted";

export interface ScriptTurn {
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface ParsedScript {
  turns: ScriptTurn[];
  /** Lines that weren't a turn: bad JSON, or neither a tool nor text. */
  skipped: number;
}

export function isModelScriptEnabled(): boolean {
  return !!readEnv("MODEL_SCRIPT")?.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One turn per non-blank line; anything that isn't one is counted, not guessed at. */
export function parseModelScript(raw: string): ParsedScript {
  const turns: ScriptTurn[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!isPlainObject(parsed)) {
      skipped++;
      continue;
    }
    const text = typeof parsed.text === "string" ? parsed.text : undefined;
    const tool = typeof parsed.tool === "string" && parsed.tool.trim() ? parsed.tool : undefined;
    if (parsed.input !== undefined && !isPlainObject(parsed.input)) {
      skipped++;
      continue;
    }
    if (tool) {
      turns.push({ tool, input: (parsed.input as Record<string, unknown>) ?? {}, text });
    } else if (text !== undefined && parsed.tool === undefined) {
      turns.push({ text });
    } else {
      skipped++;
    }
  }
  return { turns, skipped };
}

/** The assistant message a turn becomes. Exported for the test that pins the shape. */
export function turnToMessage(turn: ScriptTurn | undefined): AssistantMessage {
  if (!turn) return fauxAssistantMessage([], { stopReason: "stop" });
  const content: FauxContentBlock[] = [];
  if (turn.text !== undefined) content.push(fauxText(turn.text));
  if (turn.tool) {
    // Parsed from JSON, so it is JSON.
    const args = structuredClone(turn.input ?? {}) as ToolCall["arguments"];
    content.push(fauxToolCall(turn.tool, args));
    return fauxAssistantMessage(content, { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(content, { stopReason: "stop" });
}

/**
 * What the process has read of the script. Process-wide rather than held by
 * one extension instance: pi rebuilds the runtime and reruns extension
 * factories on `/new`, resume and fork, and a fresh instance that re-read the
 * file would run whatever an earlier scripted turn wrote into it. On
 * `globalThis` for the same reason -- a re-imported module would start over.
 */
interface ScriptState {
  loaded: boolean;
  turns: ScriptTurn[];
}

const STATE_KEY = Symbol.for("loom.modelScript.state");

function processState(): ScriptState {
  const g = globalThis as { [STATE_KEY]?: ScriptState };
  return (g[STATE_KEY] ??= { loaded: false, turns: [] });
}

/** Test reset: forget what this process read. */
export function resetModelScriptState(): void {
  const state = processState();
  state.loaded = false;
  state.turns = [];
}

/**
 * The faux provider plus the queue it reads from. Every model call takes the
 * next turn and queues itself again, so the provider never runs dry.
 */
export function createScriptedModel(state: ScriptState = { loaded: false, turns: [] }): {
  faux: FauxProviderHandle;
  load: (turns: ScriptTurn[]) => void;
  remaining: () => number;
} {
  const faux = fauxProvider({
    provider: MODEL_SCRIPT_PROVIDER,
    api: MODEL_SCRIPT_PROVIDER,
    models: [
      {
        id: MODEL_SCRIPT_MODEL_ID,
        name: "Scripted model (LOOM_MODEL_SCRIPT)",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
    ],
  });
  const step = (): AssistantMessage => {
    faux.appendResponses([step]);
    return turnToMessage(state.turns.shift());
  };
  faux.setResponses([step]);
  return {
    faux,
    load: (turns) => {
      state.turns = turns.map((t) => structuredClone(t));
    },
    remaining: () => state.turns.length,
  };
}

/** Big enough for any scenario, small enough that a mistake can't stall startup. */
const MAX_SCRIPT_BYTES = 1 << 20;

export interface ScriptRead {
  /** Relative to the real session directory; null when refused. */
  file: string | null;
  parsed: ParsedScript;
  rejected?: "missing" | "outside-session-dir" | "not-a-file" | "too-large" | "unreadable";
}

/**
 * Read the script once, through one file descriptor, from a regular file that
 * really is inside the session directory.
 *
 * Resolved before it is opened, then opened with `O_NOFOLLOW`, so swapping the
 * checked file for a symlink between the containment check and the read fails
 * the open instead of reading elsewhere; the content comes from that same
 * descriptor. `O_NONBLOCK` and the `isFile` check refuse a named pipe, which
 * would otherwise let a writer supply lines after startup, or never close and
 * hang it. (On Windows neither flag exists and both are 0; the check on the
 * descriptor still refuses anything that isn't a file.)
 */
export function readModelScript(sessionDir: string, configured: string): ScriptRead {
  const empty: ParsedScript = { turns: [], skipped: 0 };
  const root = fs.realpathSync(sessionDir);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(sessionDir, configured));
  } catch {
    return { file: null, parsed: empty, rejected: "missing" };
  }
  if (!real.startsWith(root + path.sep)) {
    return { file: null, parsed: empty, rejected: "outside-session-dir" };
  }
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(real, flags);
  } catch {
    return { file: null, parsed: empty, rejected: "unreadable" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { file: null, parsed: empty, rejected: "not-a-file" };
    // O_NOFOLLOW covers the last component only. A parent directory swapped
    // for a symlink between the realpath and the open would still be
    // followed, so check that what was opened is the file the containment
    // check approved, and that its path still resolves inside the session.
    let again: string;
    try {
      again = fs.realpathSync(real);
    } catch {
      return { file: null, parsed: empty, rejected: "outside-session-dir" };
    }
    const checked = fs.statSync(again);
    if (
      again !== real ||
      checked.dev !== stat.dev ||
      checked.ino !== stat.ino ||
      !again.startsWith(fs.realpathSync(sessionDir) + path.sep)
    ) {
      return { file: null, parsed: empty, rejected: "outside-session-dir" };
    }
    if (stat.size > MAX_SCRIPT_BYTES) {
      return { file: null, parsed: empty, rejected: "too-large" };
    }
    return {
      file: path.relative(root, real),
      parsed: parseModelScript(fs.readFileSync(fd, "utf-8")),
    };
  } finally {
    fs.closeSync(fd);
  }
}

const SCRIPTED_REF = `${MODEL_SCRIPT_PROVIDER}/${MODEL_SCRIPT_MODEL_ID}`;

function logRow(kind: string, payload: Record<string, unknown>): void {
  const notebookPath = getNotebookPath();
  if (!notebookPath) return;
  appendActivityEvent(path.dirname(notebookPath), {
    timestamp: new Date().toISOString(),
    kind,
    source: "model-script",
    payload,
  });
}

export function registerModelScript(pi: ExtensionAPI): void {
  const state = processState();
  const scripted = createScriptedModel(state);
  pi.registerProvider(scripted.faux.provider);
  const isScripted = (m: { provider?: string; id?: string } | undefined) =>
    m?.provider === MODEL_SCRIPT_PROVIDER && m?.id === MODEL_SCRIPT_MODEL_ID;

  const select = async (): Promise<boolean> => {
    try {
      if (await pi.setModel(scripted.faux.getModel())) return true;
      // A native provider's auth state can lag its registration by a tick.
      await new Promise((resolve) => setImmediate(resolve));
      return await pi.setModel(scripted.faux.getModel());
    } catch {
      return false;
    }
  };

  pi.on("session_start", async () => {
    const configured = readEnv("MODEL_SCRIPT")?.trim();
    if (!configured) return;
    // Selected before anything can go wrong with the file, so a bad script
    // never leaves the session on a real model.
    const selected = await select();
    if (state.loaded) {
      if (!selected) logRow("model.script.unselected", { model: SCRIPTED_REF });
      return;
    }
    state.loaded = true;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const read = readModelScript(path.dirname(notebookPath), configured);
    scripted.load(read.parsed.turns);
    logRow("model.script", {
      // Never the configured spelling of a refused path: it can name
      // somewhere outside the session.
      file: read.file,
      entries: read.parsed.turns.length,
      skipped: read.parsed.skipped,
      ...(read.rejected ? { rejected: read.rejected } : {}),
      model: SCRIPTED_REF,
      selected,
    });
  });

  // Anything that moves the session off the scripted model -- the picker, an
  // RPC, a restore -- is moved back.
  pi.on("model_select", async (event) => {
    if (isScripted(event.model)) return;
    const selected = await select();
    logRow("model.script.reselected", {
      from: `${event.model?.provider}/${event.model?.id}`,
      source: event.source,
      selected,
    });
  });

  // The backstop. The faux provider never calls `onPayload`, so while the
  // seam is on, a provider request reaching this hook is a real one, however
  // it got selected. Abort it before it is sent.
  pi.on("before_provider_request", async (_event, ctx) => {
    ctx.abort();
    logRow("model.script.blocked", {
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    });
  });
}

/** For tools that call a provider directly, outside the session's model. */
export function modelScriptRefusal(tool: string): string | null {
  return readEnv("MODEL_SCRIPT")?.trim()
    ? `${tool} is unavailable while LOOM_MODEL_SCRIPT is set: it calls a model directly, ` +
        `and the scripted session must never reach a real one.`
    : null;
}
