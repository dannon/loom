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
  it("stays quiet across a compaction that streams nothing for minutes (#603)", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("compaction_start");

    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    // Back to waiting on the model -- a full silence window applies again.
    watchdog.observe("compaction_end");
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps the compaction limit when other events arrive mid-compaction", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("compaction_start");
    // pi can append entries or surface a modal from a session_before_compact hook.
    watchdog.observe("entry_appended");
    watchdog.observe("extension_ui_request");
    watchdog.observe("message_update");

    vi.advanceTimersByTime(TIMEOUT * 10);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("still catches a compaction that hangs past its own limit", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("compaction_start");

    vi.advanceTimersByTime(TIMEOUT * 20 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps a compaction that started between turns off the turn limit", () => {
    // A manual /compact runs with no prompt in flight; a prompt sent while it
    // is still going must not start a 120s countdown against it.
    const { watchdog, onTimeout } = make();
    watchdog.observe("compaction_start");
    watchdog.promptSent();

    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.observe("compaction_end");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("watches an automatic compaction that pi runs after agent_end", () => {
    // pi emits agent_end and only then runs its post-turn threshold check, so
    // the compaction it starts has no turn in flight.
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("agent_end");
    watchdog.observe("compaction_start");

    vi.advanceTimersByTime(TIMEOUT * 20);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stands down when a compaction between turns ends", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.observe("compaction_start");
    watchdog.observe("compaction_end");

    vi.advanceTimersByTime(TIMEOUT * 40);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("counts the compaction limit from compaction_start, not from the last event", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.observe("compaction_start");
    vi.advanceTimersByTime(TIMEOUT * 15);
    // A user poking at a wedged compaction must not keep postponing the cancel.
    watchdog.promptSent();
    watchdog.observe("response");
    watchdog.stop();

    vi.advanceTimersByTime(TIMEOUT * 5 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledWith("compaction");
  });

  it("doesn't count system sleep against the compaction limit", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.observe("compaction_start");
    vi.advanceTimersByTime(TIMEOUT * 15);
    watchdog.suspend();
    vi.advanceTimersByTime(TIMEOUT * 100);
    watchdog.resume();

    vi.advanceTimersByTime(TIMEOUT * 20 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("times a compaction again once the dialog that paused it is answered", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("compaction_start");
    watchdog.observe("extension_ui_request", "confirm");
    vi.advanceTimersByTime(TIMEOUT * 60);
    expect(onTimeout).not.toHaveBeenCalled();

    // The brain says nothing until compaction_end, so only the answer can lift the pause.
    watchdog.dialogAnswered();
    vi.advanceTimersByTime(TIMEOUT * 20 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledWith("compaction");
  });

  it("stays paused when a dialog is answered while a tool is still running", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("tool_execution_start");
    watchdog.observe("extension_ui_request", "confirm");
    watchdog.dialogAnswered();

    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("keeps a compaction armed when a prompt sent during it starts no turn", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.observe("compaction_start");
    watchdog.promptSent();
    // A handled slash command: AgentManager stands the turn down.
    watchdog.stop();

    vi.advanceTimersByTime(TIMEOUT * 20);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("isn't paused by a status update that lands during a compaction", () => {
    // Orbit clears its Galaxy tool label 3s after the tool ends, which can be
    // inside the summary that follows. Nothing answers a setStatus.
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("compaction_start");
    watchdog.observe("extension_ui_request", "setStatus");

    vi.advanceTimersByTime(TIMEOUT * 20);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("still pauses for a dialog, and a status update doesn't end a tool's pause", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("extension_ui_request", "confirm");
    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.observe("message_update");
    watchdog.observe("tool_execution_start");
    watchdog.observe("extension_ui_request", "setStatus");
    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("gives the next prompt the normal window after a compaction stall with no compaction_end", () => {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: TIMEOUT * 20,
      onTimeout,
    });
    watchdog.promptSent();
    watchdog.observe("compaction_start");
    vi.advanceTimersByTime(TIMEOUT * 20);
    expect(onTimeout).toHaveBeenCalledWith("compaction");

    // The abort never landed, so the user retries against the same wedged brain.
    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenLastCalledWith("turn");
  });

  it("forgets a compaction when the brain process goes away", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("compaction_start");
    watchdog.reset();

    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  describe("slash commands (#674)", () => {
    const COMMAND = TIMEOUT * 10;
    function makeWithCommands(compactionTimeoutMs?: number) {
      const onTimeout = vi.fn();
      const watchdog = new TurnWatchdog({
        timeoutMs: TIMEOUT,
        commandTimeoutMs: COMMAND,
        compactionTimeoutMs,
        onTimeout,
      });
      return { watchdog, onTimeout };
    }
    const approve = { id: "cmd_9", label: "/approve" };

    it("keeps the turn limit off a command's handler until pi answers", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      // Handled: AgentManager stands the turn down after settling it.
      watchdog.commandSettled("cmd_9");
      watchdog.stop();
      vi.advanceTimersByTime(COMMAND * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("gives a command sent after a finished turn the command limit", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent();
      watchdog.observe("agent_start");
      watchdog.observe("agent_end");
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(TIMEOUT * 5);

      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("puts a slash prompt that starts a turn back on the turn limit", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent({ id: "cmd_1", label: "/data/reads.fq" });
      vi.advanceTimersByTime(TIMEOUT * 2);
      watchdog.commandSettled("cmd_1");
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("turn");
    });

    it("gives up on a command at its own limit, counted from dispatch, naming it", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND / 2);
      // Fire-and-forget UI and stray events don't push the ceiling back.
      watchdog.observe("extension_ui_request", "setStatus");
      watchdog.observe("message_end");
      vi.advanceTimersByTime(COMMAND / 2 - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(onTimeout).toHaveBeenCalledWith("command", "/approve");
      // Disarmed for good: the late answer changes nothing.
      watchdog.commandSettled("cmd_9");
      vi.advanceTimersByTime(COMMAND * 2);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("waits on a command's dialog, then starts the command's clock over", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND - 2);
      watchdog.observe("extension_ui_request", "confirm");
      vi.advanceTimersByTime(COMMAND * 5);
      expect(onTimeout).not.toHaveBeenCalled();

      // /approve writes the notebook after the answer, with no events.
      watchdog.dialogAnswered();
      vi.advanceTimersByTime(COMMAND - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("command", "/approve");
    });

    it("doesn't count system sleep against a command", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND - 1);
      watchdog.suspend();
      vi.advanceTimersByTime(COMMAND * 5);
      watchdog.resume();
      vi.advanceTimersByTime(COMMAND - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("doesn't let a reply to another request lift a tool's pause", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("tool_execution_start");
      watchdog.observe("response");
      vi.advanceTimersByTime(TIMEOUT * 5);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("keeps timing a running turn while a command typed into it runs", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent();
      watchdog.observe("agent_start");
      watchdog.promptSent({ id: "cmd_2", label: "/reconcile" });
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledWith("turn");
    });

    it("times a command that outlives the turn it was typed into", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent();
      watchdog.observe("agent_start");
      watchdog.promptSent({ id: "cmd_2", label: "/sync" });
      watchdog.observe("agent_end");
      vi.advanceTimersByTime(TIMEOUT * 5);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(COMMAND);
      expect(onTimeout).toHaveBeenCalledWith("command", "/sync");
    });

    it("watches the turn a command starts once pi has answered it", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      watchdog.observe("extension_ui_request", "confirm");
      watchdog.dialogAnswered();
      // /approve queues the approved run and returns; pi answers "handled"
      // before that run reaches agent_start.
      watchdog.commandSettled("cmd_9");
      watchdog.stop();
      watchdog.observe("agent_start");
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("turn");
    });

    it("watches only the first run after a command, not every unprompted one", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      watchdog.commandSettled("cmd_9");
      watchdog.stop();
      watchdog.observe("agent_start");
      watchdog.observe("agent_end");
      // A later run nobody prompted, like a poller's auto-resume.
      watchdog.observe("agent_start");
      vi.advanceTimersByTime(TIMEOUT * 5);

      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("times a run that starts behind a command outliving its turn as a turn", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent();
      watchdog.observe("agent_start");
      watchdog.promptSent({ id: "cmd_2", label: "/sync" });
      watchdog.observe("agent_end");
      // pi retries the failed attempt with a fresh run.
      watchdog.observe("agent_start");
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledWith("turn");
    });

    it("waits on the dialog of a command that outlived its turn", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent();
      watchdog.observe("agent_start");
      watchdog.promptSent({ id: "cmd_2", label: "/sync" });
      watchdog.observe("agent_end");
      vi.advanceTimersByTime(COMMAND - 2);
      watchdog.observe("extension_ui_request", "confirm");
      vi.advanceTimersByTime(COMMAND * 5);

      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("names the command that has run longest when two overlap", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND / 2);
      watchdog.promptSent({ id: "cmd_10", label: "/sync" });
      vi.advanceTimersByTime(COMMAND / 2);

      expect(onTimeout).toHaveBeenCalledWith("command", "/approve");
    });

    it("times the later of two commands from its own dispatch once the first settles", () => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(COMMAND / 2);
      watchdog.promptSent({ id: "cmd_10", label: "/sync" });
      watchdog.commandSettled("cmd_9");
      vi.advanceTimersByTime(COMMAND - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(onTimeout).toHaveBeenCalledWith("command", "/sync");
    });

    it("doesn't let a command postpone a compaction's ceiling", () => {
      const { watchdog, onTimeout } = makeWithCommands(TIMEOUT * 20);
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT * 19);
      watchdog.promptSent(approve);
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it.each(["brainExited", "reset"] as const)("forgets in-flight commands on %s", (method) => {
      const { watchdog, onTimeout } = makeWithCommands();
      watchdog.promptSent(approve);
      watchdog[method]();
      watchdog.promptSent();
      vi.advanceTimersByTime(TIMEOUT);

      expect(onTimeout).toHaveBeenCalledWith("turn");
    });
  });
});
