// Mid-session, the MCP client SDK can lose its stdio transport to the
// galaxy-mcp subprocess. After that every galaxy_* call comes back as
// "Failed to call tool: <transport error>", and the adapter never self-heals
// because it still thinks the connection is up. The fix on the user's side is
// to reconnect the MCP server (/mcp reconnect galaxy), not to re-authenticate
// Galaxy -- so we detect that specific failure and surface an actionable hint.
//
// Crucially this must NOT match galaxy-mcp's own "Not connected to Galaxy.
// Authenticate via OAuth or run connect()..." error, which is an auth problem
// that /mcp reconnect won't fix.

// A dropped transport: the server is gone and a new connection fixes it.
const DROPPED_ERROR_PATTERNS: RegExp[] = [
  /not connected(?!\s+to\s+galaxy)/i, // bare SDK "Not connected"; exclude the verbose auth error
  /connection closed/i, // -32000
  /-32000/,
];

// A timeout: the server is alive and answering, just not within the request
// budget. Reconnecting is useless here -- the new connection inherits the same
// budget, so the next slow call times out identically. Splitting these out is
// the whole point of this file's second half.
const TIMEOUT_ERROR_PATTERNS: RegExp[] = [
  /request timed out/i, // -32001
  /-32001/,
];

const TRANSPORT_ERROR_PATTERNS: RegExp[] = [...DROPPED_ERROR_PATTERNS, ...TIMEOUT_ERROR_PATTERNS];

export const GALAXY_RECONNECT_NUDGE =
  "Galaxy MCP connection dropped mid-session. Run /mcp reconnect galaxy to restore it (no restart needed).";

// Deliberately does not claim the server is healthy: a timeout only proves that
// no response arrived before the timer, so a wedged server looks identical to a
// slow one. It also doesn't send the user to mcp.json -- loom rewrites that
// file's galaxy entry on every launch, the path moves with PI_CODING_AGENT_DIR,
// and /mcp reconnect reuses the already-loaded config rather than re-reading it.
// Lead with the action that always helps, and keep reconnect as the fallback for
// the wedge case this cannot rule out.
export const GALAXY_TIMEOUT_NUDGE =
  "Galaxy MCP call timed out -- no response within the request budget. Try asking for less in " +
  "one call (narrower query, fewer datasets). If it keeps timing out the server may be wedged " +
  "rather than slow, and /mcp reconnect galaxy will restart it.";

/** Which kind of failure this is, so callers can give advice that can work. */
export type GalaxyFailureKind = "dropped" | "timeout" | null;

export function classifyGalaxyFailure(
  toolName: string | undefined,
  text: string | undefined,
): GalaxyFailureKind {
  if (!toolName || !toolName.startsWith("galaxy_") || !text) return null;
  // Timeout first: a -32001 body can also mention "not connected" downstream,
  // and the timeout reading is the actionable one.
  if (TIMEOUT_ERROR_PATTERNS.some((p) => p.test(text))) return "timeout";
  if (DROPPED_ERROR_PATTERNS.some((p) => p.test(text))) return "dropped";
  return null;
}

/** The nudge matching a classification, or null when there is nothing useful to say. */
export function galaxyFailureNudge(kind: GalaxyFailureKind): string | null {
  if (kind === "dropped") return GALAXY_RECONNECT_NUDGE;
  if (kind === "timeout") return GALAXY_TIMEOUT_NUDGE;
  return null;
}

export function isGalaxyTransportError(
  toolName: string | undefined,
  text: string | undefined,
): boolean {
  if (!toolName || !toolName.startsWith("galaxy_")) return false;
  if (!text) return false;
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Which failure kinds may still nudge. Tracked per kind rather than as one bit,
 * because a timeout and a drop need opposite advice: letting a timeout disarm
 * the reconnect hint would swallow the more actionable message when a slow
 * server later dies outright.
 */
export interface TransportNudgeArmed {
  timeout: boolean;
  dropped: boolean;
}

export const ALL_NUDGES_ARMED: TransportNudgeArmed = { timeout: true, dropped: true };

export interface TransportNudgeDecision {
  /** What to show for this result, or null when there's nothing useful to say. */
  nudge: string | null;
  armed: TransportNudgeArmed;
}

// Decide what to surface for one galaxy tool result. Fire once per outage per
// kind, then disarm that kind so a retry loop doesn't spam it; re-arm after any
// healthy galaxy result so a later outage nudges again. Classifying in here
// rather than again at the call site keeps one source of truth for which
// failure is which.
export function transportNudgeDecision(
  armed: TransportNudgeArmed,
  toolName: string | undefined,
  text: string | undefined,
): TransportNudgeDecision {
  const kind = classifyGalaxyFailure(toolName, text);
  if (kind) {
    return {
      nudge: armed[kind] ? galaxyFailureNudge(kind) : null,
      armed: { ...armed, [kind]: false },
    };
  }
  if (toolName?.startsWith("galaxy_")) {
    // A galaxy result that isn't a transport error means the pipe is alive.
    return { nudge: null, armed: { ...ALL_NUDGES_ARMED } };
  }
  return { nudge: null, armed };
}
