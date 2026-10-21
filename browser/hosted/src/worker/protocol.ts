/** What the host and a conversation's worker say to each other over the worker's port. */
import type { AskAnswer, AskRequest } from "../../../core/src/agent/pi-host";

export interface WorkerData {
  /** The pi-durable store this conversation lives in, and the lease generation the worker holds. */
  readonly storeId: string;
  readonly leaseGen: number;
  /** The conversation to reopen; absent for a new one. */
  readonly conversationId?: string;
  /** Postgres, as a connection string. A credential: it travels here, never in the environment. */
  readonly database: string;
  readonly galaxyUrl: string;
  /** The Galaxy page holding the conversation's record. */
  readonly pageId: string;
  readonly model: { readonly baseUrl: string; readonly id: string; readonly apiKey: string };
  readonly limits: {
    /** Model turns per run (pi-durable's maxTurns). */
    readonly maxTurns: number;
    /** Tool calls per run; past it, calls are blocked with a reason the model reads. */
    readonly maxToolCalls: number;
    /** Bytes the spilled-output ring may hold. */
    readonly outputBytes: number;
  };
  /** Tests only: report every filesystem and child_process call the worker makes. */
  readonly traceReaches?: boolean;
}

export type ToWorker =
  | { readonly cmd: "submit"; readonly text: string }
  | { readonly cmd: "answer"; readonly id: number; readonly value: AskAnswer }
  /** The user's Stop: abort the run; a pending confirm is withdrawn and its call not run. */
  | { readonly cmd: "stop" }
  | { readonly cmd: "close" };

export type FromWorker =
  | {
      readonly type: "ready";
      readonly conversationId: string;
      readonly tools: readonly string[];
      /** The names in the worker's environment, so the host can check nothing leaked in. */
      readonly env: readonly string[];
    }
  | { readonly type: "ask"; readonly id: number; readonly request: AskRequest }
  | { readonly type: "ask-withdrawn"; readonly id: number }
  | { readonly type: "notify"; readonly text: string; readonly level: "info" | "warning" | "error" }
  /** A run has finished and the conversation is idle until the next input. */
  | { readonly type: "settled"; readonly aborted: boolean }
  | { readonly type: "report"; readonly message: string }
  | { readonly type: "reach"; readonly api: string }
  | { readonly type: "closed"; readonly error?: string };
