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
 * stalled provider call. System sleep is excluded too; waking starts a fresh
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
   * Invoked when a turn or compaction stalls, saying which limit ran out. The
   * watchdog is already disarmed when this runs.
   */
  onTimeout: (stalled: "turn" | "compaction") => void;
}

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
  // A user prompt is in flight (turn started, not yet terminal).
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

  constructor(private readonly config: TurnWatchdogConfig) {}

  /** A user prompt was dispatched to the brain; begin watching for a stall. */
  promptSent(): void {
    // A fresh user prompt means the machine is awake. Clearing here keeps a
    // dropped powerMonitor `resume` from disabling the watchdog for good.
    if (this.suspended) this.restartCompactionClock();
    this.suspended = false;
    this.active = true;
    this.paused = false;
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
    this.restartCompactionClock();
    this.arm();
  }

  /**
   * Observe a brain -> shell event by its `type`. Resets the silence window on
   * normal activity, pauses across tool/modal waits, and disarms on terminal
   * events. Only compaction state is tracked when no turn is in flight.
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
    if (!this.active) return;
    // A status line or toast neither blocks the brain nor shows the model is
    // still streaming; letting it pause would switch off a running
    // compaction's limit until compaction_end.
    if (eventType === "extension_ui_request" && FIRE_AND_FORGET_UI_METHODS.has(uiMethod ?? "")) {
      return;
    }
    switch (eventType) {
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
        // Normal turn lifecycle / streaming (agent_start, message_*, turn_*,
        // text_*). Any such event also implicitly resumes after a modal.
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
    if (!this.compacting || !this.paused) return;
    this.paused = false;
    this.restartCompactionClock();
    this.arm();
  }

  /** The turn is over (or never started); stop watching it. A running compaction stays timed. */
  stop(): void {
    this.active = false;
    this.paused = false;
    this.arm();
  }

  /**
   * The brain died and may be silently restarted. Its compaction died with it,
   * but a turn the renderer is still waiting on keeps its own limit.
   */
  brainExited(): void {
    if (!this.compacting) return;
    this.compacting = false;
    this.arm();
  }

  /** The brain process is gone, so nothing it was doing is still running. */
  reset(): void {
    this.compacting = false;
    this.stop();
  }

  // Sleep is excluded from the compaction ceiling as it is from the silence window.
  private restartCompactionClock(): void {
    if (this.compacting) this.compactionStartedAt = Date.now();
  }

  private arm(): void {
    this.clearTimer();
    if (!(this.active || this.compacting) || this.paused || this.suspended) return;
    const stalled = this.compacting ? "compaction" : "turn";
    const limitMs = this.compacting ? this.config.compactionTimeoutMs : this.config.timeoutMs;
    if (limitMs === undefined) return;
    // The compaction ceiling counts from compaction_start; anything that re-arms
    // meanwhile (a handled command, a queued prompt) gets only what's left.
    const timeoutMs = this.compacting
      ? Math.max(0, limitMs - (Date.now() - this.compactionStartedAt))
      : limitMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = false;
      this.paused = false;
      this.compacting = false;
      this.config.onTimeout(stalled);
    }, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
