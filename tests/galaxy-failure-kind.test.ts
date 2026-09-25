import { describe, expect, it } from "vitest";
import {
  classifyGalaxyFailure,
  galaxyFailureNudge,
  GALAXY_RECONNECT_NUDGE,
  GALAXY_TIMEOUT_NUDGE,
  isGalaxyTransportError,
} from "../extensions/loom/galaxy-transport-error.js";

describe("classifyGalaxyFailure", () => {
  it("calls a timed-out request a timeout, not a dropped connection", () => {
    // The exact text a slow usegalaxy.org call produces.
    expect(
      classifyGalaxyFailure("galaxy_get_dataset_details", "Failed to call tool: Request timed out"),
    ).toBe("timeout");
    expect(classifyGalaxyFailure("galaxy_run_tool", "MCP error -32001")).toBe("timeout");
  });

  it("still calls a closed connection dropped", () => {
    expect(classifyGalaxyFailure("galaxy_get_histories", "Connection closed (-32000)")).toBe(
      "dropped",
    );
    expect(
      classifyGalaxyFailure("galaxy_get_histories", "Failed to call tool: Not connected"),
    ).toBe("dropped");
  });

  it("reads a body mentioning both as a timeout -- the actionable one", () => {
    expect(
      classifyGalaxyFailure("galaxy_run_tool", "Request timed out; client not connected"),
    ).toBe("timeout");
  });

  it("leaves galaxy-mcp's own auth error alone", () => {
    expect(
      classifyGalaxyFailure(
        "galaxy_get_histories",
        "Not connected to Galaxy. Authenticate via OAuth or run connect()...",
      ),
    ).toBeNull();
  });

  it("ignores non-galaxy tools and empty input", () => {
    expect(classifyGalaxyFailure("bash", "Request timed out")).toBeNull();
    expect(classifyGalaxyFailure("galaxy_run_tool", undefined)).toBeNull();
    expect(classifyGalaxyFailure(undefined, "Request timed out")).toBeNull();
  });
});

describe("galaxyFailureNudge", () => {
  it("reports an unknown outcome without delegating recovery to the user", () => {
    expect(galaxyFailureNudge("timeout")).toBe(GALAXY_TIMEOUT_NUDGE);
    expect(GALAXY_TIMEOUT_NUDGE).toContain("result is unknown");
    expect(GALAXY_TIMEOUT_NUDGE).not.toContain("Try asking");
  });

  it("identifies a dropped transport and keeps the manual command as a fallback", () => {
    expect(galaxyFailureNudge("dropped")).toBe(GALAXY_RECONNECT_NUDGE);
    expect(GALAXY_RECONNECT_NUDGE).toContain("agent can reconnect");
    expect(GALAXY_RECONNECT_NUDGE).toContain("if that fails, run /mcp reconnect galaxy");
  });

  it("says nothing when there is nothing useful to say", () => {
    expect(galaxyFailureNudge(null)).toBeNull();
  });
});

describe("isGalaxyTransportError (unchanged arm/disarm behaviour)", () => {
  it("still matches both classes, so the nudge cadence is unaffected", () => {
    expect(isGalaxyTransportError("galaxy_run_tool", "Request timed out")).toBe(true);
    expect(isGalaxyTransportError("galaxy_run_tool", "Connection closed")).toBe(true);
  });

  it("still ignores the auth error", () => {
    expect(
      isGalaxyTransportError(
        "galaxy_get_histories",
        "Not connected to Galaxy. Authenticate via OAuth or run connect()...",
      ),
    ).toBe(false);
  });
});
