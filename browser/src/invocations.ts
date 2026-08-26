/** Background watcher for submitted Galaxy work; the analogue of loom's galaxy-poller. */

export type WatchKind = "job" | "invocation";

export interface Watched {
    kind: WatchKind;
    id: string;
    /** What to call it in the UI — the tool that submitted it. */
    label: string;
    state?: string;
}

/** Galaxy job states that will never change again. */
const JOB_TERMINAL = new Set(["ok", "error", "deleted", "discarded"]);
/** Terminal invocation states; `scheduled` is not one of them. */
const INVOCATION_TERMINAL = new Set(["cancelled", "failed"]);

export function isTerminal(kind: WatchKind, state: string | undefined): boolean {
    if (!state) return false;
    return kind === "job" ? JOB_TERMINAL.has(state) : INVOCATION_TERMINAL.has(state);
}

export function isFailure(kind: WatchKind, state: string | undefined): boolean {
    if (!state) return false;
    return kind === "job" ? state === "error" : state === "failed" || state === "cancelled";
}

/** Ids worth watching in a tool result, or none; an unknown shape yields nothing. */
export function extractWatched(toolName: string, content: string): Watched[] {
    let payload: any;
    try {
        payload = JSON.parse(content);
    } catch {
        return [];
    }
    if (!payload || typeof payload !== "object") return [];

    const out: Watched[] = [];
    if (toolName === "run_tool") {
        // POST /api/tools answers with the jobs it queued.
        for (const job of payload.jobs || []) {
            if (job && typeof job.id === "string") {
                out.push({ kind: "job", id: job.id, label: "run_tool", state: job.state });
            }
        }
    } else if (toolName === "invoke_workflow") {
        if (typeof payload.id === "string") {
            out.push({ kind: "invocation", id: payload.id, label: "invoke_workflow", state: payload.state });
        }
    }
    // Already finished when it came back — nothing to wait for.
    return out.filter((w) => !isTerminal(w.kind, w.state));
}

export interface WatcherOptions {
    /** Reads the current state of one item. Injected so the poll loop is testable. */
    readState: (w: Watched) => Promise<string | undefined>;
    /** Called once per item when it reaches a state it will not leave. */
    onSettled: (w: Watched, state: string) => void;
    /** Called when a watched item changes state without settling. */
    onProgress?: (w: Watched, state: string) => void;
    /** Called once when work is first observed, before anything is known about its fate. */
    onSubmitted?: (w: Watched) => void;
    intervalMs?: number;
}

export class InvocationWatcher {
    private readonly opts: Required<Pick<WatcherOptions, "readState" | "onSettled">> & WatcherOptions;
    private readonly watching = new Map<string, Watched>();
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: WatcherOptions) {
        this.opts = { ...opts };
    }

    /** Register anything worth watching in a finished tool call. */
    ingest(toolName: string, content: string): void {
        for (const w of extractWatched(toolName, content)) {
            const key = `${w.kind}:${w.id}`;
            // Re-submitting the same id must not double-report it.
            if (!this.watching.has(key)) {
                this.watching.set(key, w);
                if (this.opts.onSubmitted) this.opts.onSubmitted(w);
            }
        }
        this.ensureRunning();
    }

    get pending(): number {
        return this.watching.size;
    }

    /** One poll pass. Exposed so a test can step the loop without a timer. */
    async tick(): Promise<void> {
        for (const [key, w] of [...this.watching]) {
            let state: string | undefined;
            try {
                state = await this.opts.readState(w);
            } catch {
                // A transient error must not kill the watcher.
                continue;
            }
            if (!state || state === w.state) continue;
            w.state = state;
            if (isTerminal(w.kind, state)) {
                this.watching.delete(key);
                this.opts.onSettled(w, state);
            } else {
                this.opts.onProgress?.(w, state);
            }
        }
        if (this.watching.size === 0) this.stop();
    }

    private ensureRunning(): void {
        if (this.timer || this.watching.size === 0) return;
        this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 10_000);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

/** Read a state straight from the Galaxy API the page is already talking to. */
export function galaxyStateReader(galaxyRoot: string, credentials: RequestCredentials) {
    return async (w: Watched): Promise<string | undefined> => {
        const path = w.kind === "job" ? `api/jobs/${w.id}` : `api/invocations/${w.id}`;
        const res = await fetch(`${galaxyRoot}${path}`, { credentials });
        if (!res.ok) return undefined;
        const body = await res.json();
        return typeof body?.state === "string" ? body.state : undefined;
    };
}
