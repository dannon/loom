/**
 * What the browser shell adds on top of Orbit's brain, as tool_call handlers registered after
 * Orbit's own, so Orbit's guards decide first and these only see a call they let through:
 *
 * - `{{artifact}}` tokens in a Galaxy or shell tool's text arguments become the fenced block of
 *   the artifact they name, from what this conversation's results carried; a token inside a fence,
 *   or one naming nothing, refuses the call with the browser brain's own sentence.
 * - A page write that still holds an embed the model made up (an image link to a chart, say) is
 *   refused: Galaxy would render it as text.
 * - A Galaxy call aimed at one of the shell's own tools (run_tool with tool_id "lineage_report",
 *   a catalog search for it) is sent back to that tool. Orbit has no rule for this: Galaxy just
 *   answers "not found", and the model goes looking for a Galaxy tool that was never there.
 *
 * Every other browser guard either has an Orbit equivalent or was dropped; the slice 3 notes list
 * each one's disposition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registeredGalaxyTools } from "../../../../../extensions/loom/galaxy-tool-source";
import { inventedEmbed, resolveArtifacts } from "../artifacts";
import type { Artifact } from "../tool";

export interface LayerHost {
  /** The product name a misroute names the tool's owner by, e.g. "Olit". */
  brandName: string;
  /** The shell's own tools, by name. */
  shellTools: () => ReadonlySet<string>;
  /** The artifacts the bound conversation's results carried, newest last. */
  artifacts: () => Promise<Artifact[]>;
}

const PAGE_WRITES = new Set(["create_page", "update_page"]);
/** Where a token may start: the browser's pattern allows space after the braces. */
const MAYBE_TOKEN = /\{\{\s*artifact/;
const PAGE_TEXT = ["content", "section_content"];

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** The browser brain's refusal for a Galaxy call aimed at one of the shell's tools, or undefined. */
export function misrouted(
  input: Record<string, unknown>,
  own: ReadonlySet<string>,
  name: string,
): string | undefined {
  const wanted = [input.tool_id, input.query].find(
    (v): v is string => typeof v === "string" && own.has(v.trim()),
  );
  if (!wanted) return undefined;
  if (wanted === input.tool_id) {
    return `'${wanted}' is ${article(name)} ${name} tool, not a Galaxy tool. Call ${wanted} directly.`;
  }
  return (
    `'${wanted}' is ${article(name)} ${name} tool rather than a Galaxy tool, so the tool catalog does not ` +
    "hold it. It is already in your tool list if you need it."
  );
}

export function registerBrowserLayers(api: ExtensionAPI, host: LayerHost): void {
  api.on("tool_call", async (event) => {
    const galaxy = new Set(registeredGalaxyTools().map((t) => t.name));
    const own = host.shellTools();
    if (!galaxy.has(event.toolName) && !own.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;

    if (galaxy.has(event.toolName)) {
      const sentBack = misrouted(input, own, host.brandName);
      if (sentBack) return { block: true, reason: sentBack };
    }

    // Read only when a token is there to place: most calls carry none.
    const tokened = Object.entries(input).filter(
      ([, value]) => typeof value === "string" && MAYBE_TOKEN.test(value),
    );
    if (tokened.length) {
      const known = await host.artifacts();
      for (const [key, value] of tokened) {
        const { text, refusal } = resolveArtifacts(value, known);
        if (refusal) return { block: true, reason: `Refused: ${refusal}` };
        input[key] = text;
      }
    }

    if (PAGE_WRITES.has(event.toolName)) {
      for (const key of PAGE_TEXT) {
        const value = input[key];
        const invented = typeof value === "string" ? inventedEmbed(value) : null;
        if (invented) return { block: true, reason: `Refused: ${invented}` };
      }
    }
    return undefined;
  });
}
