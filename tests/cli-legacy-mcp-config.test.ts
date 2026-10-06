import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SUFFIX,
  migrateLegacyMcpConfig,
  stripLegacyMcpEntries,
} from "../bin/legacy-mcp-config.js";

describe("stripLegacyMcpEntries", () => {
  it("drops Loom's servers and the adapter's scriptMode, keeping the user's own", () => {
    const config = {
      mcpServers: {
        galaxy: { command: "uvx", env: { GALAXY_API_KEY: "plaintext" } },
        "brc-analytics": { url: "https://dev.brc-analytics.org/api/v1/mcp/" },
        mine: { command: "my-server" },
      },
      settings: { scriptMode: false },
    };
    expect(stripLegacyMcpEntries(config)).toEqual({
      changed: true,
      empty: false,
      removedGalaxy: true,
      notices: [],
      shadowing: [],
    });
    expect(config).toEqual({ mcpServers: { mine: { command: "my-server" } } });
  });

  it("reports empty when only Loom's entries were there", () => {
    const config = { mcpServers: { galaxy: { command: "uvx" } }, settings: { scriptMode: false } };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: true, empty: true });
  });

  it("leaves a file with nothing of ours alone", () => {
    const config = { mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: false, empty: false });
    expect(config).toEqual({ mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false });
  });

  it("tolerates a file without mcpServers", () => {
    expect(stripLegacyMcpEntries({})).toMatchObject({ changed: false, empty: true });
  });

  it("keeps a galaxy or brc-analytics override written for pi's built-in MCP", () => {
    const config = {
      mcpServers: {
        galaxy: { command: "uvx", args: ["galaxy-mcp==2.0.0"], exposure: "direct" },
        "brc-analytics": { url: "https://staging.example/mcp", enabled: false },
      },
    };
    const before = structuredClone(config);
    expect(stripLegacyMcpEntries(config)).toMatchObject({
      changed: false,
      removedGalaxy: false,
      // The disabled brc-analytics override pins nothing, so only galaxy is reported.
      shadowing: ["galaxy"],
    });
    expect(config).toEqual(before);
  });

  it("keeps other adapter settings", () => {
    const config = { mcpServers: {}, settings: { scriptMode: false, idleTimeout: 10 } };
    stripLegacyMcpEntries(config);
    expect(config.settings).toEqual({ idleTimeout: 10 });
  });

  it("carries tool filtering over to pi's exposure fields", () => {
    const config = {
      mcpServers: {
        fs: { command: "fs-server", excludeTools: ["delete_file"], directTools: true },
        docs: { url: "https://docs.example/mcp", includeTools: ["search", "read"] },
        picks: { command: "p", directTools: ["a"], requestTimeoutMs: 90_500 },
      },
    };
    expect(stripLegacyMcpEntries(config)).toMatchObject({ changed: true, notices: [] });
    expect(config.mcpServers).toEqual({
      fs: { command: "fs-server", exposure: "direct", toolExposure: { delete_file: "hidden" } },
      docs: {
        url: "https://docs.example/mcp",
        exposure: "hidden",
        toolExposure: { search: "codemode", read: "codemode" },
      },
      picks: { command: "p", toolExposure: { a: "direct" }, timeout: 91 },
    });
  });

  it("moves bearer tokens into an Authorization header", () => {
    const config = {
      mcpServers: {
        a: { url: "https://a.example/mcp", bearerTokenEnv: "A_TOKEN" },
        b: { url: "https://b.example/mcp", bearerToken: "literal" },
        c: { url: "https://c.example/mcp", bearerTokenEnv: "C", headers: { authorization: "x" } },
      },
    };
    stripLegacyMcpEntries(config);
    expect(config.mcpServers.a).toEqual({
      url: "https://a.example/mcp",
      headers: { Authorization: "Bearer ${A_TOKEN}" },
    });
    expect(config.mcpServers.b.headers).toEqual({ Authorization: "Bearer literal" });
    expect(config.mcpServers.c.headers).toEqual({ authorization: "x" });
  });

  it("disables a server that relied on adapter-only safeguards", () => {
    const config = {
      mcpServers: {
        risky: { command: "r", approveTools: true },
        ok: { command: "o", approveTools: false },
      },
    };
    const { notices } = stripLegacyMcpEntries(config);
    expect(config.mcpServers.risky).toEqual({ command: "r", enabled: false });
    expect(config.mcpServers.ok).toEqual({ command: "o" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/"risky".*approveTools/);
  });
});

describe("migrateLegacyMcpConfig", () => {
  const dirs: string[] = [];
  const setup = (contents: string) => {
    const dir = mkdtempSync(join(tmpdir(), "loom-mcp-migrate-"));
    dirs.push(dir);
    const file = join(dir, "mcp.json");
    writeFileSync(file, contents);
    return { dir, file, backup: `${file}${BACKUP_SUFFIX}` };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves the old bytes beside the file before rewriting it", () => {
    const original = JSON.stringify(
      {
        mcpServers: {
          galaxy: { command: "uvx", env: { GALAXY_API_KEY: "plaintext" } },
          mine: { command: "my-server", excludeTools: ["rm"] },
        },
      },
      null,
      2,
    );
    const { file, backup } = setup(original);
    const { notices } = migrateLegacyMcpConfig(file);
    expect(readFileSync(backup, "utf-8")).toBe(original);
    if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      mcpServers: { mine: { command: "my-server", toolExposure: { rm: "hidden" } } },
    });
    expect(notices).toEqual([expect.stringContaining(backup)]);
  });

  it("removes a file that held only Loom's entries, keeping the backup", () => {
    const { file, backup } = setup(JSON.stringify({ mcpServers: { galaxy: { command: "uvx" } } }));
    migrateLegacyMcpConfig(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(backup)).toBe(true);
  });

  it("touches nothing when there is nothing of ours in the file", () => {
    const original = JSON.stringify({ mcpServers: { mine: { command: "x" } } });
    const { file, backup } = setup(original);
    expect(migrateLegacyMcpConfig(file)).toEqual({ notices: [] });
    expect(readFileSync(file, "utf-8")).toBe(original);
    expect(existsSync(backup)).toBe(false);
  });

  it("reports a galaxy override that will shadow the brain's registration", () => {
    const { file } = setup(
      JSON.stringify({ mcpServers: { galaxy: { command: "uvx", exposure: "direct" } } }),
    );
    const { notices } = migrateLegacyMcpConfig(file);
    expect(notices).toEqual([
      expect.stringMatching(/"galaxy" entry.*wins over.*Remove the entry/s),
    ]);
  });

  it("warns instead of failing when the file cannot be replaced", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const original = JSON.stringify({
      mcpServers: { galaxy: { command: "uvx" }, mine: { command: "x" } },
    });
    const { dir, file, backup } = setup(original);
    chmodSync(dir, 0o500);
    const { notices } = migrateLegacyMcpConfig(file);
    expect(notices).toEqual([
      expect.stringMatching(/Could not update.*Galaxy account saved there/s),
    ]);
    expect(readFileSync(file, "utf-8")).toBe(original);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("ignores a missing or unparseable file", () => {
    const { dir, file } = setup("{ not json");
    expect(migrateLegacyMcpConfig(file)).toEqual({ notices: [] });
    expect(migrateLegacyMcpConfig(join(dir, "absent.json"))).toEqual({ notices: [] });
  });
});
