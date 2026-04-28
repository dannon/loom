/**
 * Types for the Loom session state.
 *
 * Plans, steps, decisions, etc. are no longer typed structures — the notebook
 * (markdown) is the durable record. State here covers connection, notebook
 * path, and the few cross-module DTOs that still earn their keep.
 */

/**
 * Module-level session state. Just enough to wire the file watcher,
 * track Galaxy connection, and route notebook changes to UI listeners.
 */
export interface AnalystState {
  galaxyConnected: boolean;
  currentHistoryId: string | null;
  notebookPath: string | null;
  notebookLoaded: boolean;
}

/** Reference to a Galaxy dataset (used by invocation outputs and similar). */
export interface DatasetReference {
  datasetId: string;
  name: string;
  datatype: string;
  size?: number;
}

/** Lightweight summary of a notebook on disk (for listings). */
export interface NotebookSummary {
  path: string;
  size: number;
  lastUpdated: string;
}
