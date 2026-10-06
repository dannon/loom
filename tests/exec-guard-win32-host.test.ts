// The exec-guard runs on Windows hosts too (Orbit on Windows drives bash
// through WSL or Git Bash), where Node's `path` is path.win32 and the process
// cwd carries a drive letter. The commands, home and cwd it judges are still
// shell strings. Rerun the policy and classifier suites against a simulated
// win32 host so a POSIX-only assumption shows up here, not only on the Windows
// CI leg.
import { vi } from "vitest";

vi.hoisted(() => {
  // GitHub's Windows runners check out on D:, so a path resolved against the
  // cwd and one joined from a drive-less home land on different drives.
  process.cwd = () => "D:\\a\\loom\\loom";
});
vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return { ...actual.win32, default: actual.win32 };
});
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

await import("./exec-guard-policy.test");
await import("./exec-guard-bash-risk.test");

const { describe, it, expect } = await import("vitest");
const { decide } = await import("../extensions/loom/exec-guard/policy");
const fs = await import("node:fs");

// A Windows Node host reports home and cwd with a drive and backslashes, while
// the command still says `~/.loom`.
describe("decide -- a native Windows home and cwd", () => {
  const HOME = "C:\\Users\\alice";
  const CWD = "C:\\Users\\alice\\proj";
  const fold = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const run = (command: string, cwd = CWD) =>
    decide(
      {
        toolName: "bash",
        toolInput: { command },
        modelTier: "trusted",
        config: {
          enabled: true,
          dangerouslyBypassPermissions: false,
          trustedWorkspaces: [cwd],
          extraWorkspaceRoots: [],
          consentAcknowledged: null,
          sandbox: false,
        },
        interactive: true,
        cwd,
      },
      {
        resolver: { contains: (p) => ({ resolved: p, inside: fold(p).startsWith(fold(cwd)) }) },
        home: HOME,
      },
    );

  it.each([
    "cd ~/.loom/lessons && echo x > a.md",
    "cd ~/.loom/lessons && cp /tmp/x.md galaxy-api/a.md",
    "cd ../.loom && echo x > a",
  ])("denies a write: %j", (command) => {
    const r = run(command);
    expect(r.decision).toBe("deny");
    expect(r.category).toBe("bash:catastrophic");
  });
  it("denies a credential-store read and logs it home-relative", () => {
    const r = run("cd ~/.loom && cat config.json");
    expect(r.decision).toBe("deny");
    expect(r.category).toBe("read:credential-store");
    expect(r.reason).toContain("~/.loom/config.json");
  });
  it.each([
    ["cd ~/work/x && echo > y", CWD],
    ["cd data && cp ../raw.csv .", "C:\\Users\\alice\\.loom\\analyses\\proj"],
  ])("leaves ordinary work alone: %j", (command, cwd) => {
    expect(run(command, cwd).decision).toBe("allow");
  });
});

// The tracker models bash, so it must not reach for the host's path module.
describe("bash-risk -- the cd tracker uses posix paths only", () => {
  it("has no bare path.resolve/join/normalize/isAbsolute/relative in the tracker", () => {
    const src = fs.readFileSync(
      new URL("../extensions/loom/exec-guard/bash-risk.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("const P = path.posix;");
    const end = src.indexOf("function isFilesystemRoot");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const tracker = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(tracker).not.toMatch(/(?<![\w.])path\.(resolve|join|normalize|isAbsolute|relative)\(/);
  });
});
