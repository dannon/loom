import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpHome: string;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-cfg-"));
  fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.ORBIT_OBSERVATIONS;
  delete process.env.LOOM_OBSERVATIONS;
  vi.resetModules();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  delete process.env.ORBIT_OBSERVATIONS;
  delete process.env.LOOM_OBSERVATIONS;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpHome, ".loom", "config.json");
}

/**
 * Lessons on in the CONFIG unless the case says otherwise (`lessons: {}` for
 * "no switch written"): reporting never follows the env spelling.
 */
function writeConfig(obj: Record<string, unknown>): void {
  const withSwitch = "lessons" in obj ? obj : { lessons: { enabled: true }, ...obj };
  fs.writeFileSync(configPath(), JSON.stringify(withSwitch), "utf-8");
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

async function load() {
  return await import("../extensions/loom/observations-config.js");
}

describe("resolveObservationsMode", () => {
  it("defaults to off with no config", async () => {
    writeConfig({});
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
    expect(m.describeObservationsMode()).toEqual({ mode: "off" });
  });

  it("is off whatever the config says while the lesson switch is off", async () => {
    process.env.LOOM_LESSONS = "off";
    try {
      writeConfig({
        observations: { mode: "auto", autoAcknowledgedAt: "2026-01-01T00:00:00Z" },
        lessons: { enabled: true },
      });
      const m = await load();
      expect(m.describeObservationsMode()).toEqual({ mode: "off", override: "lessons-off" });
    } finally {
      delete process.env.LOOM_LESSONS;
    }
  });

  it("reads the mode only once the config switch is on", async () => {
    writeConfig({ observations: { mode: "ask" }, lessons: {} });
    let m = await load();
    expect(m.describeObservationsMode()).toEqual({ mode: "off", override: "lessons-off" });
    vi.resetModules();
    writeConfig({ observations: { mode: "ask" }, lessons: { enabled: true } });
    m = await load();
    expect(m.describeObservationsMode()).toEqual({ mode: "ask" });
  });

  it("stays off when lessons are on from the env alone, and says why a change is refused", async () => {
    process.env.LOOM_LESSONS = "on";
    try {
      writeConfig({ observations: { mode: "ask" }, lessons: {} });
      const m = await load();
      expect(m.describeObservationsMode()).toEqual({ mode: "off", override: "lessons-env" });
      expect(m.observationsModeChangeBlocker("ask")).toMatch(/environment only.*LOOM_LESSONS=on/);
      expect(m.observationsModeChangeBlocker("auto")).toMatch(/never turns reporting on/);
      expect(m.observationsModeChangeBlocker("off")).toBeNull();
    } finally {
      delete process.env.LOOM_LESSONS;
    }
  });

  it("blocks nothing once the config switch is on", async () => {
    writeConfig({});
    const m = await load();
    for (const mode of ["off", "ask", "auto"] as const) {
      expect(m.observationsModeChangeBlocker(mode)).toBeNull();
    }
  });

  it("reads the configured mode", async () => {
    writeConfig({ observations: { mode: "off" } });
    let m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
    vi.resetModules();
    writeConfig({ observations: { mode: "ask" } });
    m = await load();
    expect(m.resolveObservationsMode()).toBe("ask");
  });

  it("runs a configured auto as auto only with the recorded acknowledgement", async () => {
    writeConfig({ observations: { mode: "auto", autoAcknowledgedAt: "2026-10-07T08:00:00.000Z" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("auto");
    expect(m.describeObservationsMode()).toEqual({ mode: "auto" });
  });

  it("runs a configured auto without the acknowledgement as ask", async () => {
    writeConfig({ observations: { mode: "auto" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("ask");
    expect(m.describeObservationsMode()).toEqual({ mode: "ask", override: "auto-unacknowledged" });
  });

  it("does not count a junk acknowledgement", async () => {
    for (const ack of [true, "", "yes", 1, null, "1", "0", "12", "no 1", "2026-10-07"]) {
      vi.resetModules();
      writeConfig({ observations: { mode: "auto", autoAcknowledgedAt: ack } });
      const m = await load();
      expect(m.resolveObservationsMode(), String(ack)).toBe("ask");
      expect(m.hasAcknowledgedAuto(), String(ack)).toBe(false);
    }
  });

  it("marking the acknowledgement makes a configured auto take effect", async () => {
    writeConfig({ observations: { mode: "auto" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("ask");
    m.markAutoAcknowledged();
    expect(m.resolveObservationsMode()).toBe("auto");
  });

  it("falls back to off on a junk configured mode", async () => {
    writeConfig({ observations: { mode: "yolo" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
  });

  it("hard-disables on either env spelling", async () => {
    writeConfig({ observations: { mode: "auto" } });
    process.env.LOOM_OBSERVATIONS = "off";
    let m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
    expect(m.isObservationsHardDisabled()).toBe(true);

    vi.resetModules();
    delete process.env.LOOM_OBSERVATIONS;
    process.env.ORBIT_OBSERVATIONS = "off";
    m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
  });

  it("honours an off under either spelling even when the other is set to something else", async () => {
    writeConfig({ observations: { mode: "auto" } });
    process.env.ORBIT_OBSERVATIONS = "auto";
    process.env.LOOM_OBSERVATIONS = "off";
    let m = await load();
    expect(m.resolveObservationsMode()).toBe("off");

    vi.resetModules();
    process.env.ORBIT_OBSERVATIONS = "OFF";
    process.env.LOOM_OBSERVATIONS = "auto";
    m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
  });

  it("never lets an env value turn collection on", async () => {
    writeConfig({ observations: { mode: "off" } });
    for (const value of ["auto", "ask", "1", "on", "true"]) {
      vi.resetModules();
      process.env.ORBIT_OBSERVATIONS = value;
      const m = await load();
      expect(m.resolveObservationsMode(), value).toBe("off");
      expect(m.isObservationsHardDisabled(), value).toBe(false);
    }
  });
});

describe("setObservationsMode", () => {
  it("writes only the mode and leaves the rest of the config alone", async () => {
    writeConfig({
      testerId: "orbit-007",
      llm: { active: "anthropic", providers: { anthropic: { apiKey: "sk-secret-value" } } },
    });
    const m = await load();
    m.setObservationsMode("auto");
    const cfg = readConfig();
    expect(cfg.observations.mode).toBe("auto");
    expect(cfg.testerId).toBe("orbit-007");
    expect(cfg.llm.providers.anthropic.apiKey).toBe("sk-secret-value");
  });

  it("refuses to clobber an unparseable config", async () => {
    fs.writeFileSync(configPath(), "{ not json", "utf-8");
    const m = await load();
    expect(() => m.setObservationsMode("auto")).toThrow(/couldn't be read/i);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });

  it("refuses to turn collection on while the lesson switch is off, but allows off", async () => {
    process.env.LOOM_LESSONS = "off";
    try {
      writeConfig({ observations: { mode: "ask" } });
      const m = await load();
      expect(() => m.setObservationsMode("auto")).toThrow(/\/lessons on/);
      expect(() => m.setObservationsMode("ask")).toThrow(/\/lessons on/);
      m.setObservationsMode("off");
      expect(JSON.parse(fs.readFileSync(configPath(), "utf-8")).observations.mode).toBe("off");
    } finally {
      delete process.env.LOOM_LESSONS;
    }
  });

  it("refuses to change the mode while the env hard-disable is set", async () => {
    writeConfig({});
    process.env.ORBIT_OBSERVATIONS = "off";
    const m = await load();
    expect(() => m.setObservationsMode("auto")).toThrow(/hard-disabled/i);
  });
});

describe("getOrCreateInstallToken", () => {
  it("generates 32 lowercase hex once and persists it", async () => {
    writeConfig({});
    const m = await load();
    expect(m.peekInstallToken()).toBeUndefined();
    const first = m.getOrCreateInstallToken();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(readConfig().observations.installToken).toBe(first);

    vi.resetModules();
    const m2 = await load();
    expect(m2.getOrCreateInstallToken()).toBe(first);
  });

  it("replaces a malformed stored token", async () => {
    writeConfig({ observations: { installToken: "NOT-HEX" } });
    const m = await load();
    expect(m.getOrCreateInstallToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("auto-mode acknowledgement", () => {
  it("is false until marked, then persists", async () => {
    writeConfig({});
    const m = await load();
    expect(m.hasAcknowledgedAuto()).toBe(false);
    m.markAutoAcknowledged();
    expect(m.hasAcknowledgedAuto()).toBe(true);
    expect(readConfig().observations.autoAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
