import { afterEach, describe, expect, it, vi } from "vitest";
import { configOverrideLocations } from "../shared/state-dir.js";
import {
  isCredentialStore,
  isProtectedWritePath,
  isSensitivePath,
} from "../extensions/loom/exec-guard/sensitive-read";
import { decide } from "../extensions/loom/exec-guard/policy";
import { buildSandboxConfig } from "../extensions/loom/sandbox/sandbox-config";
import type {
  GuardianConfig,
  PathResolver,
  PolicyRequest,
} from "../extensions/loom/exec-guard/types";

// The brain config can be moved with CONFIG_DIR / CONFIG_PATH under either
// prefix. Wherever it lands it holds the same keys, so every gate that knows
// ~/.loom/config.json has to know it there too -- under every spelling.

const HOME = "/home/alice";
const CWD = "/home/alice/project";
const OVERRIDE_VARS = [
  "ORBIT_CONFIG_DIR",
  "LOOM_CONFIG_DIR",
  "ORBIT_CONFIG_PATH",
  "LOOM_CONFIG_PATH",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearOverrides() {
  for (const v of OVERRIDE_VARS) vi.stubEnv(v, "");
}

describe("configOverrideLocations", () => {
  it("collects every spelling, not just the one resolveConfigPath would pick", () => {
    const got = configOverrideLocations({
      home: HOME,
      env: {
        ORBIT_CONFIG_DIR: "/srv/orbit",
        LOOM_CONFIG_DIR: "~/loomcfg",
        ORBIT_CONFIG_PATH: "/etc/o.json",
        LOOM_CONFIG_PATH: "/etc/l.json",
      },
    });
    expect(got.dirs).toEqual(["/srv/orbit", "/home/alice/loomcfg"]);
    expect(got.files).toEqual([
      "/srv/orbit/config.json",
      "/home/alice/loomcfg/config.json",
      "/etc/o.json",
      "/etc/l.json",
    ]);
  });

  it("is empty when nothing is set", () => {
    expect(configOverrideLocations({ home: HOME, env: {} })).toEqual({ dirs: [], files: [] });
  });
});

describe.each([
  ["ORBIT_CONFIG_DIR", "/srv/cfg", "/srv/cfg/config.json"],
  ["LOOM_CONFIG_DIR", "/srv/cfg", "/srv/cfg/config.json"],
  ["ORBIT_CONFIG_PATH", "/srv/brain.json", "/srv/brain.json"],
  ["LOOM_CONFIG_PATH", "~/brain.json", "/home/alice/brain.json"],
])("%s=%s", (name, value, file) => {
  it("makes the overridden config a credential store", () => {
    clearOverrides();
    vi.stubEnv(name, value);
    expect(isCredentialStore(file, HOME)).toBe(true);
    expect(isSensitivePath(file, HOME)).toBe(true);
    expect(isCredentialStore(file.toUpperCase(), HOME)).toBe(true);
  });

  it("protects the overridden config from the write tool", () => {
    clearOverrides();
    vi.stubEnv(name, value);
    expect(isProtectedWritePath(file, HOME)).toBe(true);
  });

  it("is not a credential store once the override is gone", () => {
    clearOverrides();
    expect(isCredentialStore(file, HOME)).toBe(false);
  });
});

describe("override dir write protection", () => {
  it("protects the rest of an overridden dir like ~/.loom", () => {
    clearOverrides();
    vi.stubEnv("LOOM_CONFIG_DIR", "/srv/cfg");
    expect(isProtectedWritePath("/srv/cfg/sessions-index.db", HOME)).toBe(true);
    expect(isProtectedWritePath("/srv/other/file", HOME)).toBe(false);
  });

  it("keeps the analyses carve-out when the override is the old default", () => {
    clearOverrides();
    vi.stubEnv("ORBIT_CONFIG_DIR", "~/.loom");
    expect(isProtectedWritePath("/home/alice/.loom/analyses/rna/out.csv", HOME)).toBe(false);
    expect(isProtectedWritePath("/home/alice/.loom/analyses/rna/.loom/x", HOME)).toBe(true);
    expect(isProtectedWritePath("/home/alice/.loom/config.json", HOME)).toBe(true);
  });
});

describe("policy", () => {
  const cfg: GuardianConfig = {
    enabled: true,
    dangerouslyBypassPermissions: false,
    trustedWorkspaces: [],
    extraWorkspaceRoots: [],
    consentAcknowledged: null,
    sandbox: false,
  };
  const resolver: PathResolver = {
    contains: (p) => ({ resolved: p, inside: p.startsWith(CWD) }),
  };
  const deps = { resolver, home: HOME };
  const req = (toolName: string, toolInput: Record<string, unknown>): PolicyRequest =>
    ({
      toolName,
      toolInput,
      modelTier: "trusted",
      config: cfg,
      interactive: true,
      cwd: CWD,
    }) as PolicyRequest;

  it.each(OVERRIDE_VARS)("denies reading the config moved by %s", (name) => {
    clearOverrides();
    const isPath = name.endsWith("_PATH");
    vi.stubEnv(name, isPath ? "/srv/brain.json" : "/srv/cfg");
    const file = isPath ? "/srv/brain.json" : "/srv/cfg/config.json";
    expect(decide(req("read", { path: file }), deps).category).toBe("read:credential-store");
    expect(decide(req("bash", { command: `cat ${file} | head` }), deps).category).toBe(
      "read:credential-store",
    );
  });

  it.each(OVERRIDE_VARS)("denies a shell write to the config moved by %s", (name) => {
    clearOverrides();
    const isPath = name.endsWith("_PATH");
    vi.stubEnv(name, isPath ? "~/cfg/brain.json" : "~/cfg");
    const file = isPath ? "~/cfg/brain.json" : "~/cfg/config.json";
    for (const command of [
      `echo '{}' > ${file}`,
      `cp /tmp/x "${file.replace("~", "$HOME")}"`,
      `tee ${file.replace("~", HOME)} < /tmp/x`,
    ]) {
      const d = decide(req("bash", { command }), deps);
      expect(d.decision, command).toBe("deny");
    }
  });

  it("gates the write tool on the moved config", () => {
    clearOverrides();
    vi.stubEnv("ORBIT_CONFIG_PATH", "/srv/brain.json");
    expect(decide(req("write", { path: "/srv/brain.json" }), deps).decision).not.toBe("allow");
  });
});

describe("sandbox", () => {
  it("adds override files to both deny lists", () => {
    const c = buildSandboxConfig({
      cwd: CWD,
      tmpDir: "/tmp",
      configOverrideFiles: ["/srv/cfg/config.json"],
    });
    expect(c.filesystem.denyRead).toContain("/srv/cfg/config.json");
    expect(c.filesystem.denyWrite).toContain("/srv/cfg/config.json");
    expect(c.filesystem.denyRead).toContain("~/.orbit/config.json");
  });
});
