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
 * whole tool-execution window and while a UI modal is open, since those are
 * legitimate long/indefinite waits rather than a stalled provider call. System
 * sleep is excluded too; waking starts a fresh silence window for recovery.
 */
export interface TurnWatchdogConfig {
  /** How long the brain may stay silent mid-turn before we treat it as stalled. */
  timeoutMs: number;
  /** Invoked when a turn stalls. The watchdog is already disarmed when this runs. */
  onTimeout: () => void;
}

export class TurnWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // A user prompt is in flight (turn started, not yet terminal).
  private active = false;
  // The brain is legitimately blocked (running a tool, or awaiting a modal),
  // so silence is expected and must not be mistaken for a stall.
  private paused = false;
  // Power state is independent of tool/modal waits and survives stop(). Brain
  // events can still arrive after the OS announces suspend; none may rearm us.
  private suspended = false;

  constructor(private readonly config: TurnWatchdogConfig) {}

  /** A user prompt was dispatched to the brain; begin watching for a stall. */
  promptSent(): void {
    // A fresh user prompt means the machine is awake. Clearing here keeps a
    // dropped powerMonitor `resume` from disabling the watchdog for good.
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
    this.arm();
  }

  /**
   * Observe a brain -> shell event by its `type`. Resets the silence window on
   * normal activity, pauses across tool/modal waits, and disarms on terminal
   * events. No-ops when no turn is in flight.
   */
  observe(eventType: string): void {
    if (!this.active) return;
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

  /** Disarm entirely (process stop/restart, or after firing). */
  stop(): void {
    this.clearTimer();
    this.active = false;
    this.paused = false;
  }

  private arm(): void {
    this.clearTimer();
    if (!this.active || this.paused || this.suspended) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = false;
      this.paused = false;
      this.config.onTimeout();
    }, this.config.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
