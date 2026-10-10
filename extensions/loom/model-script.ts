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
 * - the file is read once, at the first session start, so nothing the
 *   scripted session does -- a write to the script, a tool result, a notebook
 *   edit -- can add lines to it;
 * - when the variable is set, the scripted model is selected whether or not
 *   the file was usable. A rejected file gives a model that says nothing; it
 *   never falls through to the configured real one.
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
import { resolveReplayPath } from "./submission-replay";

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
 * The faux provider plus the queue it reads from. Every model call takes the
 * next turn and queues itself again, so the provider never runs dry.
 */
export function createScriptedModel(): {
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
  let queue: ScriptTurn[] = [];
  const step = (): AssistantMessage => {
    faux.appendResponses([step]);
    return turnToMessage(queue.shift());
  };
  faux.setResponses([step]);
  return {
    faux,
    load: (turns) => {
      queue = turns.map((t) => structuredClone(t));
    },
    remaining: () => queue.length,
  };
}

export function registerModelScript(pi: ExtensionAPI): void {
  const scripted = createScriptedModel();
  pi.registerProvider(scripted.faux.provider);
  let loaded = false;

  pi.on("session_start", async () => {
    const configured = readEnv("MODEL_SCRIPT")?.trim();
    if (!configured) return;
    // Selected before anything can go wrong with the file, so a bad script
    // never leaves the session on a real model.
    await pi.setModel(scripted.faux.getModel());
    if (loaded) return;
    loaded = true;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const sessionDir = path.dirname(notebookPath);
    const realRoot = fs.realpathSync(sessionDir);

    // Missing before outside: a file that isn't there can't be realpath'd, so
    // the containment check would call it outside and hide the plainer answer.
    const exists = fs.existsSync(path.resolve(sessionDir, configured));
    const file = exists ? resolveReplayPath(sessionDir, configured) : null;
    let parsed: ParsedScript = { turns: [], skipped: 0 };
    let rejected: string | undefined;
    if (!exists) rejected = "missing";
    else if (!file) rejected = "outside-session-dir";
    else parsed = parseModelScript(fs.readFileSync(file, "utf-8"));
    scripted.load(parsed.turns);

    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "model.script",
      source: "model-script",
      payload: {
        // Never the configured spelling of a rejected path: it can name
        // somewhere outside the session.
        file: file ? path.relative(realRoot, file) : null,
        entries: parsed.turns.length,
        skipped: parsed.skipped,
        ...(rejected ? { rejected } : {}),
        model: `${MODEL_SCRIPT_PROVIDER}/${MODEL_SCRIPT_MODEL_ID}`,
      },
    });
  });
}
