/**
 * The one switch for the lesson loop: `lessons.enabled` in the Loom config.
 *
 * Off by default. Off means nothing recorded reaches the model on any
 * surface (inline hint, /execute note, reproduction index, lessons_search),
 * /lesson and lesson_propose refuse, and the observation collector is off
 * whatever its own mode says. On means lessons are surfaced and searchable,
 * /lesson works, and collection follows `observations.mode` again.
 *
 * Kept apart from the store so observations-config can read it without
 * pulling the corpus loader in. Two env spellings on top of the config:
 * `LOOM_LESSONS=off` is a hard disable that wins over everything, for a
 * managed deployment; `LOOM_LESSONS=on` turns the switch on where nobody can
 * write the config (the eval runner's throwaway HOME, CI). The on spelling
 * only ever enables READING lessons: observations still need their own mode,
 * which no env value can set.
 */

import fs from "node:fs";
import { getConfigPath, loadConfig, saveConfig } from "../config.js";
import { envNames } from "../../../shared/orbit-env.js";

export interface LessonsSwitch {
  enabled: boolean;
  /** Where the answer came from, for the status line. */
  source: "env" | "config" | "default";
  /** The env var that decided it, when `source` is "env" -- for messages. */
  via?: string;
}

function envValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function envNameWith(value: string, env: NodeJS.ProcessEnv): string | undefined {
  return envNames("LESSONS").find((n) => envValue(n, env) === value);
}

export function describeLessonsSwitch(env: NodeJS.ProcessEnv = process.env): LessonsSwitch {
  // Every spelling is checked for "off" first, so an ambient ORBIT_LESSONS=on
  // can't mask a LOOM_LESSONS=off a deployment put there on purpose.
  const off = envNameWith("off", env);
  if (off) return { enabled: false, source: "env", via: off };
  const cfg = loadConfig() as { lessons?: { enabled?: unknown } };
  const configured = cfg.lessons?.enabled;
  if (configured === true || configured === false) {
    return { enabled: configured, source: "config" };
  }
  const on = envNameWith("on", env);
  if (on) return { enabled: true, source: "env", via: on };
  return { enabled: false, source: "default" };
}

/** Master switch. Off means no lesson reaches the model on any surface. */
export function isLessonsEnabled(): boolean {
  return describeLessonsSwitch().enabled;
}

/** True when the env has the last word, so the config can't change anything. */
export function isLessonsHardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envNameWith("off", env) !== undefined;
}

/** The one line every refusing surface points at. */
export const LESSONS_OFF_POINTER = "Lessons are off on this install. /lessons on turns them on.";

/**
 * Write `lessons.enabled`. Fail-closed like the other config writers:
 * loadConfig() returns {} for a file it can't parse (or one that isn't an
 * object), and saving that back would wipe the user's API keys.
 *
 * Turning the loop on also sets `observations.mode` back to `off` when the
 * file holds anything else: a mode left behind from before the switch went
 * off, or hand-edited in, must not start reporting the moment lessons come
 * back. The user picks a mode again; the one-time auto acknowledgement is
 * kept, since it only records that the sample payload was seen.
 */
export function setLessonsEnabled(enabled: boolean): void {
  const off = envNameWith("off", process.env);
  if (off) {
    throw new Error(
      `Lessons are hard-disabled for this install (${off}=off), so the switch can't be changed here.`,
    );
  }
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      throw new Error(
        "The Loom config couldn't be read, so it wasn't changed -- fix or remove the file and try again.",
        { cause: err },
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "The Loom config isn't a JSON object, so it wasn't changed -- fix or remove the file and try again.",
      );
    }
  }
  const cfg = loadConfig();
  cfg.lessons = { ...(cfg.lessons ?? {}), enabled };
  if (enabled && cfg.observations?.mode !== undefined && cfg.observations.mode !== "off") {
    cfg.observations = { ...cfg.observations, mode: "off" };
  }
  try {
    saveConfig(cfg);
  } catch (err) {
    throw new Error(
      "Couldn't write the Loom config -- check file permissions and free space, then try again.",
      { cause: err },
    );
  }
}
