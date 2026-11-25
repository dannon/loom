/**
 * Watchdog that breaks the "stuck on thinking" hang (#185).
 *
 * Orbit clears its "...thinking" indicator only when the brain emits a terminal
 * event (`agent_end` / `error` / `message_end` with an error stop reason). When a
 * cloud provider call fails or stalls *after* prompt preflight, pi can emit no
 * terminal event at all -- the RPC layer swallows a post-preflight throw, and a
 * truly stalled socket never resolves -- so the UI spins forever with no error,
 * no timeout, no recovery.
 *
 * This watchdog is the shell-side backstop: while a prompt is in flight it arms a
 * silence timer, resets it on every byte of brain activity, and fires if the
 * brain goes completely silent for `timeoutMs`. It deliberately pauses for the
 * whole tool-execution window, while a UI modal is open, and across a context
 * compaction, since those are legitimate long/indefinite waits rather than a
 * stalled provider call. A slash command is one too: pi runs its handler before
 * it answers the prompt, and a handler can spend minutes on Galaxy before it
 * shows anything (#674). System sleep is excluded too; waking starts a fresh
 * silence window for recovery.
 */
export interface TurnWatchdogConfig {
  /** How long the brain may stay silent mid-turn before we treat it as stalled. */
  timeoutMs: number;
  /**
   * Silence allowed while pi compacts. It emits nothing between
   * compaction_start and compaction_end, so this has to cover the whole
   * summary request; it still exists because that request can hang too.
   * Omit to wait out a compaction indefinitely.
   */
  compactionTimeoutMs?: number;
  /**
   * How long a slash command may run with no turn going. pi's abort can't
   * reach a command handler, so this only stops the shell waiting on one
   * whose request hung. Omit to wait indefinitely.
   */
  commandTimeoutMs?: number;
  /**
   * Invoked when a turn, compaction or command stalls, saying which limit ran
   * out; for a command, `label` is the one that ran longest. The watchdog is
   * already disarmed when this runs.
   */
  onTimeout: (stalled: StallKind, label?: string) => void;
}

export type StallKind = "turn" | "compaction" | "command";

// pi's RPC UI calls that expect no reply. Only the dialogs (select, confirm,
// input, editor) leave the brain waiting on the user.
const FIRE_AND_FORGET_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

export class TurnWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // A user prompt, or a run a command queued, is in flight (not yet terminal).
  private active = false;
  // The brain is legitimately blocked (running a tool, or awaiting a modal),
  // so silence is expected and must not be mistaken for a stall.
  private paused = false;
  // pi is summarizing the conversation. It streams nothing until
  // compaction_end, and a local model can take minutes (#603). Tracked, and
  // timed, even with no turn in flight: pi runs its post-turn threshold
  // compaction after agent_end, and a manual /compact has no turn either.
  private compacting = false;
  // A fixed ceiling, so prompts typed at a wedged compaction can't postpone it.
  private compactionStartedAt = 0;
  // Power state is independent of tool/modal waits and survives stop(). Brain
  // events can still arrive after the OS announces suspend; none may rearm us.
  private suspended = false;
  // agent_start seen and no agent_end yet. A running turn keeps the silence
  // window even with a command in flight: the command doesn't block the model.
  private turnRunning = false;
  // A plain prompt hasn't reached agent_start yet. It keeps the turn limit even
  // with a command in flight, since pi can wedge before the run starts.
  private promptAwaitingTurn = false;
  // Slash-command prompts pi hasn't answered yet, by RPC id. Outlives stop()
  // and a stalled turn: a command typed mid-turn can still be running after
  // that turn ends or is aborted.
  private commands = new Map<string, { label: string; startedAt: number }>();
  // A command settled with no turn running. Its handler may have queued a run
  // (/approve, /execute) that reaches agent_start only after pi's "handled"
  // reply has stood the prompt down, and the user is still waiting on it.
  private commandMayStartTurn = false;

  constructor(private readonly config: TurnWatchdogConfig) {}

  /**
   * A user prompt was dispatched to the brain; begin watching for a stall.
   * Pass `command` for a slash command: its silence is then the handler's, and
   * it is timed against the command limit until commandSettled(id).
   */
  promptSent(command?: { id: string; label: string }): void {
    // A fresh user prompt means the machine is awake. Clearing here keeps a
    // dropped powerMonitor `resume` from disabling the watchdog for good.
    if (this.suspended) this.restartClocks();
    this.suspended = false;
    this.active = true;
    this.paused = false;
    this.commandMayStartTurn = false;
    if (command) this.commands.set(command.id, { label: command.label, startedAt: Date.now() });
    else this.promptAwaitingTurn = true;
    this.arm();
  }

  /**
   * pi answered a prompt, which for a slash command means its handler has
   * returned. Unknown ids (plain prompts, other requests) change nothing.
   */
  commandSettled(id: string): void {
    if (!this.commands.delete(id)) return;
    if (!this.turnRunning) this.commandMayStartTurn = true;
    this.arm();
  }

  /** Exclude system sleep without losing the current turn or tool/modal wait. */
  suspend(): void {
    this.suspended = true;
    this.clearTimer();
  }

  /** Give an active model request a full silence window to recover after wake. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.restartClocks();
    this.arm();
  }

  /**
   * Observe a brain -> shell event by its `type`. Resets the silence window on
   * normal activity, pauses across tool/modal waits, and disarms on terminal
   * events. With no turn, command or command-queued run in flight, only
   * compaction state is tracked.
   * `uiMethod` is an extension_ui_request's method.
   */
  observe(eventType: string, uiMethod?: string): void {
    if (eventType === "compaction_start" || eventType === "compaction_end") {
      this.compacting = eventType === "compaction_start";
      if (this.compacting) this.compactionStartedAt = Date.now();
      if (eventType === "compaction_end") this.paused = false;
      this.arm();
      return;
    }
    if (!this.active && this.commands.size === 0 && !this.commandMayStartTurn) return;
    // A prompt's own response settles through commandSettled(); a reply to
    // get_state or set_model says nothing about the turn and must not lift a
    // tool or dialog pause.
    if (eventType === "response") return;
    // A status line or toast neither blocks the brain nor shows the model is
    // still streaming; letting it pause would switch off a running
    // compaction's limit until compaction_end.
    if (eventType === "extension_ui_request" && FIRE_AND_FORGET_UI_METHODS.has(uiMethod ?? "")) {
      return;
    }
    switch (eventType) {
      case "agent_start":
        // Whoever started it, the renderer now shows a running turn.
        this.active = true;
        this.commandMayStartTurn = false;
        this.promptAwaitingTurn = false;
        this.turnRunning = true;
        this.paused = false;
        this.arm();
        return;
      case "agent_end":
      case "error":
        // Turn resolved (success or surfaced error) -- nothing to guard.
        this.stop();
        return;
      case "tool_execution_start":
      case "extension_ui_request":
        // Tool may run long; a modal may wait on the user indefinitely. Pause
        // until the brain produces output again.
        this.paused = true;
        this.clearTimer();
        return;
      case "tool_execution_update":
        // Liveness mid-tool, but the tool can still go silent afterward. Stay
        // paused for the whole tool window rather than re-arming here.
        return;
      case "tool_execution_end":
        // Back to waiting on the model.
        this.paused = false;
        this.arm();
        return;
      default:
        // Normal turn lifecycle / streaming (message_*, turn_*, text_*). Any
        // such event also implicitly resumes after a modal.
        this.paused = false;
        this.arm();
        return;
    }
  }

  /**
   * The user answered a dialog. Mid-compaction the brain emits nothing until
   * compaction_end, so this is the only signal that lifts the dialog's pause;
   * the ceiling starts over, as after sleep. Mid-tool the tool keeps running,
   * so the pause holds until tool_execution_end.
   */
  dialogAnswered(): void {
    if (!this.paused) return;
    // The dialog belonged to a command if no turn is running; the handler
    // carries on with no events until it returns, so it starts its clock over.
    const commandOnly = !this.turnRunning && this.commands.size > 0;
    if (!this.compacting && !commandOnly) return;
    this.paused = false;
    this.restartClocks();
    this.arm();
  }

  /** The turn is over (or never started); stop watching it. A running compaction stays timed. */
  stop(): void {
    this.active = false;
    this.turnRunning = false;
    this.promptAwaitingTurn = false;
    this.paused = false;
    this.arm();
  }

  /**
   * The brain died and may be silently restarted. Its compaction died with it,
   * but a turn the renderer is still waiting on keeps its own limit.
   */
  brainExited(): void {
    if (!this.compacting && this.commands.size === 0 && !this.commandMayStartTurn) return;
    this.compacting = false;
    this.commands.clear();
    this.commandMayStartTurn = false;
    this.arm();
  }

  /** The brain process is gone, so nothing it was doing is still running. */
  reset(): void {
    this.compacting = false;
    this.commands.clear();
    this.commandMayStartTurn = false;
    this.stop();
  }

  // Sleep is excluded from the fixed ceilings as it is from the silence window.
  private restartClocks(): void {
    const now = Date.now();
    if (this.compacting) this.compactionStartedAt = now;
    for (const command of this.commands.values()) command.startedAt = now;
  }

  // The command that has run longest, which is the one the ceiling is timing.
  private oldestCommand(): { id: string; label: string; startedAt: number } | undefined {
    let oldest: { id: string; label: string; startedAt: number } | undefined;
    for (const [id, command] of this.commands) {
      if (!oldest || command.startedAt < oldest.startedAt) oldest = { id, ...command };
    }
    return oldest;
  }

  private arm(): void {
    this.clearTimer();
    if (this.paused || this.suspended) return;
    // A compaction outranks everything: prompts typed at it can't postpone it.
    // Then a watched turn, unless all that's in flight is a command's handler.
    const command = this.oldestCommand();
    let stalled: StallKind;
    if (this.compacting) stalled = "compaction";
    else if (this.active && (this.turnRunning || this.promptAwaitingTurn || !command)) {
      stalled = "turn";
    } else if (command) stalled = "command";
    else return;
    const limitMs = {
      turn: this.config.timeoutMs,
      compaction: this.config.compactionTimeoutMs,
      command: this.config.commandTimeoutMs,
    }[stalled];
    if (limitMs === undefined) return;
    // The ceilings count from compaction_start or the command's dispatch;
    // anything that re-arms meanwhile gets only what's left.
    const startedAt =
      stalled === "compaction" ? this.compactionStartedAt : (command?.startedAt ?? 0);
    const timeoutMs =
      stalled === "turn" ? limitMs : Math.max(0, limitMs - (Date.now() - startedAt));
    const label = stalled === "command" ? command?.label : undefined;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Drop only what ran out. pi's abort doesn't reach a command handler, so
      // other commands are still running and keep their own ceilings.
      if (stalled === "command" && command) this.commands.delete(command.id);
      else this.compacting = false;
      this.active = false;
      this.turnRunning = false;
      this.promptAwaitingTurn = false;
      this.paused = false;
      this.commandMayStartTurn = false;
      if (label === undefined) this.config.onTimeout(stalled);
      else this.config.onTimeout(stalled, label);
      this.arm();
    }, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
