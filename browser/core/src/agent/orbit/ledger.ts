/**
 * The Orbit brain's submission ledger, kept in the browser's private files (OPFS) beside the
 * conversation store, not in it: pi-durable refuses a run's commits once its abort mark is on,
 * and the ledger has to take a Galaxy call's answer exactly then, when a switch or a Stop is
 * cutting the run short. A reloaded worker reads it back, and its first watch tick captures
 * what was answered but never written into the record.
 */
import {
  createMemoryLedger,
  type LedgerState,
  type SubmissionLedger,
} from "../../../../../extensions/loom/submission-ledger";

/** Where a ledger's state is kept: one text file. */
export interface LedgerFile {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

const EMPTY: LedgerState = { entries: [], events: {}, histories: {} };

function parsed(text: string | undefined): LedgerState {
  if (!text) return EMPTY;
  try {
    const state = JSON.parse(text) as Partial<LedgerState>;
    return {
      entries: Array.isArray(state.entries) ? state.entries : [],
      events: state.events && typeof state.events === "object" ? state.events : {},
      histories: state.histories && typeof state.histories === "object" ? state.histories : {},
    };
  } catch (error) {
    // A torn write leaves nothing to recover from; the next attach's reconcile still finds the
    // runs Galaxy has, so starting empty loses the attribution, not the work.
    console.warn("[orbit] the submission ledger could not be read; starting it empty", error);
    return EMPTY;
  }
}

/** The ledger kept in `file`: read once, and written down before each change returns. */
export async function openFileLedger(file: LedgerFile): Promise<SubmissionLedger> {
  return createMemoryLedger({
    state: parsed(await file.read()),
    persist: (state) => file.write(JSON.stringify(state)),
  });
}

/** A file in the origin's private file system. */
export function opfsFile(name: string): LedgerFile {
  const handle = navigator.storage
    .getDirectory()
    .then((root) => root.getFileHandle(name, { create: true }));
  return {
    async read() {
      const text = await (await (await handle).getFile()).text();
      return text || undefined;
    },
    async write(text) {
      const file = await handle;
      const bytes = new TextEncoder().encode(text);
      // A worker's synchronous handle is what every browser with OPFS has; createWritable came
      // later to some.
      const sync = (
        file as FileSystemFileHandle & {
          createSyncAccessHandle?: () => Promise<{
            truncate(size: number): void;
            write(data: Uint8Array, options: { at: number }): number;
            flush(): void;
            close(): void;
          }>;
        }
      ).createSyncAccessHandle;
      if (sync) {
        const access = await sync.call(file);
        try {
          access.truncate(0);
          access.write(bytes, { at: 0 });
          access.flush();
        } finally {
          access.close();
        }
        return;
      }
      const writable = await file.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
  };
}
