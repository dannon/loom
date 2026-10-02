/**
 * The one answer to "where do the user's own lessons live", for every reader
 * and writer: the store that loads them, and the /lesson command that saves
 * and lists them. Two answers is how a saved lesson ends up never loading.
 *
 * `<state dir>/lessons/<namespace>/<slug>.md` by default. `LOOM_LESSONS_DIR`
 * REPLACES it rather than adding to it, resolved against the process cwd --
 * it exists so a test, an eval, or a shared directory can supply the whole
 * tier. Content read from it is validated and wrapped exactly like
 * `~/.loom/lessons`. Pointed inside a workspace, the agent's write tool can
 * reach it, so it is for setups that already trust that directory.
 *
 * Kept free of the store's imports so the writer can depend on it alone.
 */

import path from "node:path";
import { readEnv } from "../../../shared/orbit-env.js";
import { resolveStateDir } from "../../../shared/state-dir.js";

export function userLessonsDir(): string {
  const override = readEnv("LESSONS_DIR")?.trim();
  if (override) return path.resolve(process.cwd(), override);
  return path.join(resolveStateDir(), "lessons");
}
