import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildResumePrompt,
  createFollowUpDelivery,
  isAutoResumeEnabled,
  isResumableOutcome,
} from "../extensions/loom/auto-resume.js";
import { loadConfig } from "../extensions/loom/config";

vi.mock("../extensions/loom/config", () => ({ loadConfig: vi.fn(() => ({})) }));

beforeEach(() => {
  vi.stubEnv("LOOM_AUTO_RESUME", undefined);
  vi.mocked(loadConfig).mockReturnValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("isAutoResumeEnabled", () => {
  it("follows up automatically without an experimental opt-in", () => {
    expect(isAutoResumeEnabled()).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("allows the env to enable follow-up over a config opt-out", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    vi.stubEnv("LOOM_AUTO_RESUME", "1");
    expect(isAutoResumeEnabled()).toBe(true);
  });

  it("allows the env to disable follow-up over a config opt-in", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: true } });
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("ignores invalid env values and keeps the configured preference", () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "yes");
    expect(isAutoResumeEnabled()).toBe(true);
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    expect(isAutoResumeEnabled()).toBe(false);
  });
});

describe("buildResumePrompt", () => {
  it("identifies every run and directs verification and diagnosis without a user relay", () => {
    const p = buildResumePrompt([
      { kind: "job", id: "job-1", label: 'same "label"\ntext', outcome: "completed" },
      {
        kind: "invocation",
        id: "inv-1",
        label: 'same "label"\ntext',
        outcome: "failing",
        detail: "1 failed, 2 running",
      },
    ]);
    expect(p).toContain('"id": "job-1"');
    expect(p).toContain('"id": "inv-1"');
    expect(p).toContain(JSON.stringify('same "label"\ntext'));
    expect(p).toContain("1 failed, 2 running");
    expect(p).toContain("verify the output datasets now");
    expect(p).toContain("investigate now");
    expect(p).toContain("stderr");
    expect(p).toContain("invocation messages");
    expect(p).toContain("never ask them to ask you");
  });

  it("continues authorized work while preserving evidence, scope and stop boundaries", () => {
    const p = buildResumePrompt([{ kind: "job", id: "j", label: "x", outcome: "completed" }]);
    expect(p).toContain("Record the evidence in the notebook before marking");
    expect(p).toContain("Continue already-authorized work when its prerequisites are verified");
    expect(p).toContain("Respect any request to pause or stop");
    expect(p).toContain("do not blindly retry");
    expect(p).toContain("does not authorize a new analysis");
    expect(p).not.toContain("Report what you found and STOP");
  });
});

describe("isResumableOutcome", () => {
  it("wakes for success and failure, but not cancellation, skips or active jobs", () => {
    expect(isResumableOutcome("completed")).toBe(true);
    expect(isResumableOutcome("failed")).toBe(true);
    for (const status of ["cancelled", "skipped", "in_progress"]) {
      expect(isResumableOutcome(status)).toBe(false);
    }
  });
});

describe("createFollowUpDelivery", () => {
  afterEach(() => vi.useRealTimers());

  it("sends straight away when the agent is idle", () => {
    const send = vi.fn();
    createFollowUpDelivery(send, { graceMs: 100 }).deliver("a");
    expect(send).toHaveBeenCalledWith("a");
  });

  it("holds a follow-up until after a message the user queued mid-turn has started", () => {
    // Orbit sends the user's queued message only once the turn ends; the
    // automatic follow-up must not jump ahead of it.
    vi.useFakeTimers();
    const send = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100 });
    d.agentStarted();
    d.deliver("auto");
    d.agentSettled();
    expect(send).not.toHaveBeenCalled();
    d.agentStarted(); // the user's queued message
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledExactlyOnceWith("auto");
  });

  it("pauses after the cap, tells the user once, and resumes on user input", () => {
    const send = vi.fn();
    const onPaused = vi.fn();
    const d = createFollowUpDelivery(send, { maxConsecutive: 3, onPaused });
    for (const t of ["1", "2", "3", "4", "5"]) d.deliver(t);
    expect(send.mock.calls.map(([t]) => t)).toEqual(["1", "2", "3"]);
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused.mock.calls[0][0]).toMatch(/paused after 3 automatic turn/);
    d.userInput();
    d.deliver("6");
    expect(send).toHaveBeenLastCalledWith("6");
  });

  it("takes the default cap from config", () => {
    const send = vi.fn();
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResumeMaxTurns: 1 } });
    const d = createFollowUpDelivery(send);
    d.deliver("1");
    d.deliver("2");
    expect(send).toHaveBeenCalledOnce();
  });

  it("drops held follow-ups on Stop and stays quiet until the user speaks", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const onPaused = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100, onPaused });
    d.agentStarted();
    d.deliver("held");
    d.aborted();
    d.agentSettled();
    vi.advanceTimersByTime(500);
    d.deliver("later");
    expect(send).not.toHaveBeenCalled();
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused.mock.calls[0][0]).toMatch(/stopped/);
    d.userInput();
    d.deliver("after");
    expect(send).toHaveBeenCalledExactlyOnceWith("after");
  });

  it("drops held follow-ups when the session shuts down", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100 });
    d.agentStarted();
    d.deliver("auto");
    d.agentSettled();
    d.clear();
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
  });
});
