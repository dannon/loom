/**
 * Replaying recorded tool results through the lesson hint, for the Tier-1
 * evals and for checking the hint by hand without a model.
 *
 * Same reasoning as `submission-replay.ts`: the hint fires on `tool_result`,
 * which needs a real tool call, which needs a model turn, and the Tier-1
 * scenarios exist to pin deterministic harness behaviour with no API key and
 * no model in the loop. The file format and the containment check are reused
 * from that module rather than re-derived -- one JSONL line per event,
 * `{tool, args?, result, isError?}`, resolved inside the session directory
 * only, both sides realpath'd so a symlink cannot point the replay elsewhere.
 * Off unless LOOM_LESSON_REPLAY is set, and nothing registers it otherwise.
 *
 * Every replay writes a `lesson.replay` row first, so an activity log produced
 * this way is never mistaken for one produced by real tool results. The hint
 * each replayed result would have carried goes to stderr -- the only place a
 * model-free run can show it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readEnv } from "../../../shared/orbit-env.js";
import { appendActivityEvent } from "../activity";
import { decideHintForEvent, formatLessonHint, recordSurfacing } from "../lesson-hint";
import { getNotebookPath } from "../state";
import { parseReplayFile, resolveReplayPath, type ReplayEntry } from "../submission-replay";
import type { LessonToolResultContent } from "./pi-event-contract";

export function isLessonReplayEnabled(): boolean {
  return !!readEnv("LESSON_REPLAY")?.trim();
}

/** A recorded pi tool result -> the content array the hint sees. Text only. */
export function replayContent(entry: ReplayEntry): LessonToolResultContent {
  const result = entry.result as { content?: unknown } | undefined;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const out: LessonToolResultContent = [];
  for (const raw of blocks) {
    const block = raw as { type?: unknown; text?: unknown } | null;
    if (block?.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    }
  }
  return out;
}

export function registerLessonReplay(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const configured = readEnv("LESSON_REPLAY")?.trim();
    if (!configured) return;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const sessionDir = path.dirname(notebookPath);

    const file = resolveReplayPath(sessionDir, configured);
    if (!file || !fs.existsSync(file)) return;

    const entries = parseReplayFile(fs.readFileSync(file, "utf-8"));
    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "lesson.replay",
      source: "lesson-replay",
      // Relative to the REAL session dir: `file` is realpath'd, and against an
      // unresolved root (macOS temp dirs sit behind /var -> /private/var) the
      // relative path climbs out to the root and logs the full location.
      payload: { file: path.relative(fs.realpathSync(sessionDir), file), entries: entries.length },
    });

    // Same once-per-lesson arming as the live hook, so a replayed retry loop
    // behaves the way the real one does.
    const armed = new Set<string>();
    for (const entry of entries) {
      const decision = decideHintForEvent(
        { toolName: entry.tool, input: entry.args ?? {}, content: replayContent(entry) },
        armed,
      );
      if (!decision) continue;
      armed.add(decision.match.lesson.id);
      recordSurfacing(decision.match, "tool_result");
      // Not the entry's tool name: the replay file is arbitrary text.
      console.error(`[loom lesson replay]\n${formatLessonHint(decision.match.lesson)}`);
    }
  });
}
