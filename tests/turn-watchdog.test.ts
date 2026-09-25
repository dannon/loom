import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnWatchdog } from "../app/src/main/turn-watchdog.js";

const TIMEOUT = 1000;

describe("TurnWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make() {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({ timeoutMs: TIMEOUT, onTimeout });
    return { watchdog, onTimeout };
  }

  it("fires onTimeout when the brain goes silent after a prompt", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    vi.advanceTimersByTime(TIMEOUT);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fire while a turn is idle (no prompt in flight)", () => {
    const { watchdog, onTimeout } = make();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("ignores events observed before a prompt is sent", () => {
    const { watchdog, onTimeout } = make();

    // A stray lifecycle event with no active turn must not arm the watchdog.
    watchdog.observe("agent_start");
    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("resets the silence window each time the brain emits an event", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    // Events keep arriving just before each deadline -> never fires.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(TIMEOUT - 1);
      watchdog.observe("message_update");
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // ...then the brain goes silent for a full window.
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("disarms on agent_end (normal completion)", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("agent_end");

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("disarms on a surfaced error event", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("error");

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("pauses for the whole tool-execution window so long tools don't false-fire", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("tool_execution_start");

    // Tool runs far longer than the silence window, emitting nothing or only
    // sporadic progress -- must not be mistaken for a stalled provider call.
    vi.advanceTimersByTime(TIMEOUT * 10);
    watchdog.observe("tool_execution_update");
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    // Once the tool finishes we're waiting on the model again -> re-armed.
    watchdog.observe("tool_execution_end");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("pauses while a UI modal is open and resumes when the brain continues", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("extension_ui_request");

    // User takes their time answering the modal; brain is blocked on stdin.
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    // Brain resumes (emits lifecycle activity) -> watchdog re-arms.
    watchdog.observe("message_update");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stop() disarms an in-flight turn", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.stop();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("only fires once per stalled turn", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("excludes system sleep and gives the model a full recovery window after wake", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT - 1);
    watchdog.suspend();
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not rearm for late brain events while the system is suspended", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.suspend();
    watchdog.observe("message_update");
    watchdog.observe("tool_execution_end");
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["tool_execution_start", "extension_ui_request"])(
    "preserves a %s wait across sleep and wake",
    (event) => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe(event);
      watchdog.suspend();
      vi.advanceTimersByTime(TIMEOUT * 10);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT * 10);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.observe("tool_execution_end");
      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["agent_end", "error", "stop"])(
    "does not revive a turn that receives %s during sleep",
    (event) => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.suspend();
      if (event === "stop") watchdog.stop();
      else watchdog.observe(event);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT * 10);
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it("recovers on the next prompt if the OS never delivers resume", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.suspend();
    watchdog.observe("agent_end");
    // No resume() -- the user just types again once the machine is back.
    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not arm when an idle system wakes", () => {
    const { watchdog, onTimeout } = make();
    watchdog.suspend();
    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("handles repeated sleep cycles without duplicate timers or extra resume delays", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    for (let i = 0; i < 3; i++) {
      watchdog.suspend();
      watchdog.suspend();
      vi.advanceTimersByTime(TIMEOUT * 10);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT - 1);
    }
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.resume();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
