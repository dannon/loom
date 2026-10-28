import { describe, it, expect } from "vitest";
import {
  describeSandboxInitFailure,
  LINUX_SANDBOX_APT_PACKAGES,
} from "../extensions/orbit/sandbox/sandbox-init-message";

// ASRT's SandboxManager.initialize() throws this on Linux when the runtime
// binaries it shells out to (rg/socat/bwrap) aren't on PATH. See issue #305.
const ASRT_DEPS_ERROR =
  "Sandbox dependencies not available: ripgrep (rg) not found, bubblewrap (bwrap) not installed, socat not installed";

describe("describeSandboxInitFailure", () => {
  it("keeps the base shape: names the failure and that bash stays gated", () => {
    const msg = describeSandboxInitFailure("linux", ASRT_DEPS_ERROR);
    expect(msg).toContain("Bash sandbox init failed");
    expect(msg).toContain(ASRT_DEPS_ERROR);
    expect(msg).toContain("bash stays gated per action");
  });

  it("on Linux, names the exact apt packages when ASRT reports missing deps", () => {
    const msg = describeSandboxInitFailure("linux", ASRT_DEPS_ERROR);
    expect(msg).toContain(`sudo apt install ${LINUX_SANDBOX_APT_PACKAGES.join(" ")}`);
    // the three binaries ASRT actually requires on Linux (#305 only named two)
    expect(LINUX_SANDBOX_APT_PACKAGES).toEqual(["ripgrep", "socat", "bubblewrap"]);
  });

  it("does not add an apt hint on non-Linux platforms", () => {
    const msg = describeSandboxInitFailure("darwin", ASRT_DEPS_ERROR);
    expect(msg).not.toContain("apt install");
    expect(msg).toContain("Bash sandbox init failed");
  });

  it("does not add an apt hint for unrelated Linux init failures", () => {
    const other = "network.tlsTerminate and network.mitmProxy are mutually exclusive";
    const msg = describeSandboxInitFailure("linux", other);
    expect(msg).not.toContain("apt install");
    expect(msg).toContain(other);
  });
});
