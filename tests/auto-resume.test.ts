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
    vi.useFakeTimers();
    const send = vi.fn();
    const onPaused = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100, maxConsecutive: 3, onPaused });
    const turn = () => {
      d.userMessageRecorded(send.mock.lastCall![0]);
      d.agentStarted();
      d.agentSettled();
      vi.advanceTimersByTime(100);
    };
    d.deliver("1");
    d.deliver("2"); // held: "1" hasn't started its turn yet
    turn();
    d.deliver("3");
    turn();
    d.deliver("4");
    d.deliver("5");
    turn();
    expect(send.mock.calls.map(([t]) => t)).toEqual(["1", "2", "3"]);
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused.mock.calls[0][0]).toMatch(/paused after 3 automatic turn/);
    d.userInput();
    d.agentStarted();
    d.deliver("6");
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(3);
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenLastCalledWith("4\n\n5\n\n6");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("takes the default cap from config", () => {
    const send = vi.fn();
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResumeMaxTurns: 1 } });
    const d = createFollowUpDelivery(send);
    d.deliver("1");
    d.deliver("2");
    expect(send).toHaveBeenCalledOnce();
  });

  it("retains held follow-ups on Stop and waits for the user's next turn to settle", () => {
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
    d.agentStarted();
    d.deliver("after");
    expect(send).not.toHaveBeenCalled();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledExactlyOnceWith("held\n\nlater\n\nafter");
  });

  it("retains a late batch failure after three successful automatic turns", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100, maxConsecutive: 3 });
    for (let i = 0; i < 3; i++) {
      d.deliver(
        buildResumePrompt([
          { kind: "job", id: `finished-${i}`, label: "cohort", outcome: "completed" },
        ]),
      );
      d.userMessageRecorded(send.mock.lastCall![0]);
      d.agentStarted();
      if (i === 2) {
        d.deliver(
          buildResumePrompt([
            {
              kind: "job",
              id: "last-cohort",
              label: "cohort",
              outcome: "failed",
              detail: "exit 1",
            },
          ]),
        );
      }
      d.agentSettled();
      vi.advanceTimersByTime(100);
    }
    expect(send).toHaveBeenCalledTimes(3);
    d.userInput(); // No new Galaxy transition will occur for this terminal job.
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.lastCall![0]).toContain('"id": "last-cohort"');
    expect(send.mock.lastCall![0]).toContain('"outcome": "failed"');
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("keeps a send Pi never acted on, without retrying in a loop", () => {
    // Pi's extension sendUserMessage returns nothing and swallows a refused
    // prompt, so a turn that never starts is the only sign it was dropped.
    vi.useFakeTimers();
    const send = vi.fn();
    const onPaused = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100, ackMs: 1000, onPaused });
    d.deliver("job-failed");
    vi.advanceTimersByTime(1000);
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused.mock.calls[0][0]).toMatch(/kept for your next message/);
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledOnce();
    d.userInput();
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send.mock.calls).toEqual([["job-failed"], ["job-failed"]]);
    log.mockRestore();
  });

  it("waits out a compaction before deciding a send was dropped", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let idle = false;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100, ackMs: 1000, isIdle: () => idle });
    idle = true;
    d.deliver("result");
    idle = false; // Pi compacts before starting the prompt's turn
    vi.advanceTimersByTime(5000);
    idle = true;
    d.userMessageRecorded("result");
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not send while Pi is compacting outside a turn", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let idle = false;
    const d = createFollowUpDelivery(send, { graceMs: 100, isIdle: () => idle });
    d.deliver("result");
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
    idle = true;
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledExactlyOnceWith("result");
  });

  it("does not wake the agent for a slash command after Stop", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100 });
    d.agentStarted();
    d.deliver("held");
    d.aborted();
    d.agentSettled();
    d.userInput(); // e.g. /tester-id, which starts no turn
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledExactlyOnceWith("held");
  });

  it("drops a stale nudge on Stop but keeps Galaxy results", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const d = createFollowUpDelivery(send, { graceMs: 100 });
    d.agentStarted();
    d.deliver("galaxy result");
    d.deliver("plan nudge", { dropOnStop: true });
    d.aborted();
    d.agentSettled();
    d.userInput();
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledExactlyOnceWith("galaxy result");
  });

  it("doesn't take someone else's turn as delivery", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100, ackMs: 1000 });
    d.deliver("result"); // Pi refuses it silently
    d.userMessageRecorded("what's happening?"); // the user's own turn
    d.agentStarted();
    vi.advanceTimersByTime(1000);
    d.agentSettled();
    vi.advanceTimersByTime(100);
    expect(send.mock.calls).toEqual([["result"], ["result"]]);
    log.mockRestore();
  });

  it("doesn't resend a batch that was only slow to land", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100, ackMs: 1000 });
    d.deliver("result");
    vi.advanceTimersByTime(1000); // long auth refresh: counted as undelivered
    d.userMessageRecorded("result"); // ...then Pi runs it after all
    d.agentStarted();
    d.agentSettled();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("forgets an unacknowledged send when the session ends", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100, ackMs: 1000 });
    d.deliver("old-session");
    d.clear();
    vi.advanceTimersByTime(5000);
    d.deliver("new-session");
    expect(send.mock.calls).toEqual([["old-session"], ["new-session"]]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("retains a synchronous send failure for the next delivery opportunity", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockImplementationOnce(() => {
      throw new Error("not ready");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = createFollowUpDelivery(send, { graceMs: 100 });
    d.deliver("first");
    d.deliver("second");
    expect(send.mock.calls).toEqual([["first"], ["first\n\nsecond"]]);
    log.mockRestore();
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
