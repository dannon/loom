import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const loadConfigMock = vi.fn();

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => loadConfigMock(),
}));

import { isTeamDispatchEnabled } from "../extensions/loom/teams/is-enabled";

describe("isTeamDispatchEnabled", () => {
  const originalEnv = process.env.LOOM_TEAM_DISPATCH;

  beforeEach(() => {
    delete process.env.LOOM_TEAM_DISPATCH;
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOOM_TEAM_DISPATCH;
    else process.env.LOOM_TEAM_DISPATCH = originalEnv;
  });

  it("defaults off when env is unset and config has no experiments block", () => {
    loadConfigMock.mockReturnValue({});
    expect(isTeamDispatchEnabled()).toBe(false);
  });

  it("is on when config opts in and env is unset", () => {
    loadConfigMock.mockReturnValue({ experiments: { teamDispatch: true } });
    expect(isTeamDispatchEnabled()).toBe(true);
  });

  it("env=1 forces on even when config is off", () => {
    process.env.LOOM_TEAM_DISPATCH = "1";
    loadConfigMock.mockReturnValue({ experiments: { teamDispatch: false } });
    expect(isTeamDispatchEnabled()).toBe(true);
  });

  it("env=0 forces off even when config is on", () => {
    process.env.LOOM_TEAM_DISPATCH = "0";
    loadConfigMock.mockReturnValue({ experiments: { teamDispatch: true } });
    expect(isTeamDispatchEnabled()).toBe(false);
  });

  it("ignores garbage env values and falls through to config", () => {
    process.env.LOOM_TEAM_DISPATCH = "yes";
    loadConfigMock.mockReturnValue({ experiments: { teamDispatch: true } });
    expect(isTeamDispatchEnabled()).toBe(true);
  });

  it("treats experiments.teamDispatch=undefined as off", () => {
    loadConfigMock.mockReturnValue({ experiments: {} });
    expect(isTeamDispatchEnabled()).toBe(false);
  });
});
