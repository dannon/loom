/**
 * The two tool_call guards the worker registers ahead of Orbit's own: a default-deny gate that only
 * lets through the pinned server surface, and a per-run cap on tool calls.
 */
import surface from "../../__surface__/server/tools.json";

/** User-defined tools, which run arbitrary code on Galaxy under the user's account: not offered hosted. */
export const WITHHELD_TOOLS: ReadonlySet<string> = new Set(["create_user_tool", "run_user_tool"]);

/** The tools a hosted worker may run, from the pinned surface snapshot. */
export const SERVER_TOOLS: ReadonlySet<string> = new Set(surface as string[]);

type Blocked = { block: true; reason: string } | undefined;
type On = (event: string, handler: (event: { toolName: string }) => Blocked | void) => void;

/**
 * Block any tool outside the surface. A tool Orbit gains later is refused here until the snapshot
 * that pins it is updated and reviewed, so the server's surface never grows by accident.
 */
export function registerSurfaceGate(on: On, allowed: ReadonlySet<string> = SERVER_TOOLS): void {
  on("tool_call", (event) =>
    allowed.has(event.toolName)
      ? undefined
      : { block: true, reason: `${event.toolName} is not available in hosted Orbit.` },
  );
}

/** Block tool calls past `max` in one run; a run starts at agent_start. */
export function registerToolCallCap(on: On, max: number): void {
  let calls = 0;
  on("agent_start", () => {
    calls = 0;
  });
  on("tool_call", () => {
    calls += 1;
    if (calls <= max) return undefined;
    return {
      block: true,
      reason: `This turn has used its ${max} tool calls. Stop calling tools; tell the user what you found and what is left to do.`,
    };
  });
}
