/**
 * /lessons -- the user's switch for the whole lesson loop.
 *
 * Deterministic, no model turn. `/lessons` and `/lessons status` say whether
 * the loop is on and what that covers; `/lessons on` asks once, in plain
 * words, what the user gets and what they contribute, and writes
 * `lessons.enabled` only on a yes; `/lessons off` writes it straight away.
 * The finer controls (/observations mode, /lesson suppress) stay where they
 * are and only mean something once this is on.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  describeLessonsSwitch,
  isLessonsHardDisabled,
  setLessonsEnabled,
} from "./lessons/enabled.js";
import { resetLessonStore } from "./lessons/store.js";
import { describeObservationsMode } from "./observations-config.js";

export const LESSONS_USAGE = "Usage: /lessons [status | on | off]";

export const LESSONS_CONFIRM_TITLE = "Turn lessons on?";

export const LESSONS_CONFIRM_MESSAGE = [
  "You get: recorded lessons -- short notes on situations that go wrong -- surfaced in chat when a tool result or plan step matches one, and searchable by the agent. Retrieval is local; no query leaves this machine.",
  "",
  "You contribute: local lessons you approve yourself with /lesson, which stay on this machine; and Galaxy failure reports, only as far as /observations mode allows (it starts off, so nothing is sent until you choose ask or auto).",
].join("\n");

/** The two-line status, plus a third line when the env has the last word. */
export function formatLessonsStatus(info: {
  enabled: boolean;
  source: "env" | "config" | "default";
  via?: string;
  observationsMode: "off" | "ask" | "auto";
}): string {
  const lines = info.enabled
    ? [
        `Lessons: on. Recorded lessons are surfaced in chat and searchable; local lessons you approve with /lesson stay here, and failure reports follow /observations mode (${info.observationsMode}).`,
        "/lessons off turns the whole loop off.",
      ]
    : [
        "Lessons: off. Nothing recorded is surfaced or searchable, /lesson is off, and no failure report is collected or sent.",
        "/lessons on turns the loop on, after one confirm.",
      ];
  if (info.source === "env") {
    const name = info.via ?? "LOOM_LESSONS";
    lines.push(
      info.enabled
        ? `(Set by ${name}=on in the environment, which reads lessons only; reporting stays off until /lessons on writes the config.)`
        : `(Set by ${name}=off in the environment, so it can't be changed from here.)`,
    );
  }
  return lines.join("\n");
}

function showStatus(ctx: ExtensionCommandContext): void {
  const sw = describeLessonsSwitch();
  ctx.ui.notify(
    formatLessonsStatus({
      enabled: sw.enabled,
      source: sw.source,
      via: sw.via,
      observationsMode: describeObservationsMode().mode,
    }),
    "info",
  );
}

async function turnOn(ctx: ExtensionCommandContext): Promise<void> {
  const sw = describeLessonsSwitch();
  if (isLessonsHardDisabled()) {
    ctx.ui.notify(
      `Lessons are hard-disabled for this install (${sw.via}=off), so they can't be turned on here.`,
      "warning",
    );
    return;
  }
  // On from the config already. On from the env alone still goes through the
  // confirm and the write: that is what lets reporting be chosen afterwards.
  if (sw.enabled && sw.source === "config") {
    ctx.ui.notify("Lessons are already on.", "info");
    return;
  }
  // The one confirm. A shell with no dialog can't show it, and enabling
  // without it would skip the only place the trade is stated.
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Turning lessons on needs interactive mode -- it asks you to confirm once. Re-run it in Orbit or an interactive CLI session.",
      "warning",
    );
    return;
  }
  const yes = await ctx.ui
    .confirm(LESSONS_CONFIRM_TITLE, LESSONS_CONFIRM_MESSAGE)
    .catch(() => false);
  if (!yes) {
    ctx.ui.notify("Left off. Nothing was changed.", "info");
    return;
  }
  if (!write(ctx, true)) return;
  // The corpus is cached per session; drop it so the next tool result can
  // load lessons without a restart.
  resetLessonStore();
  ctx.ui.notify(
    "Lessons are on. Failure reports are off until you pick /observations mode ask or auto.",
    "info",
  );
}

function turnOff(ctx: ExtensionCommandContext): void {
  if (!describeLessonsSwitch().enabled) {
    ctx.ui.notify("Lessons are already off.", "info");
    return;
  }
  if (!write(ctx, false)) return;
  resetLessonStore();
  ctx.ui.notify("Lessons are off. Nothing recorded is surfaced, and nothing is reported.", "info");
}

/** False when the config could not be written; the user has been told why. */
function write(ctx: ExtensionCommandContext, enabled: boolean): boolean {
  try {
    setLessonsEnabled(enabled);
    return true;
  } catch (err) {
    // setLessonsEnabled only throws messages it authored, including the case
    // where the config isn't writable (a read-only or remote install).
    ctx.ui.notify(err instanceof Error ? err.message : "Couldn't write the Loom config.", "error");
    return false;
  }
}

export function registerLessonsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("lessons", {
    description:
      "Turn the lesson loop on or off, or show whether it is on. Subcommands: status | on | off.",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "" || sub === "status") return showStatus(ctx);
      if (sub === "on") return await turnOn(ctx);
      if (sub === "off") return turnOff(ctx);
      ctx.ui.notify(`Unknown subcommand "${sub}".\n${LESSONS_USAGE}`, "warning");
    },
  });
}
